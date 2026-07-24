import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { classifyNews, normalizeNewsText } from '@/lib/market-news/classifier';
import { fetchGdeltArticles, type GdeltArticle } from '@/lib/market-news/gdelt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const HORIZONS = [15, 60, 240, 720, 1440, 4320] as const;
const MAX_REACTIONS_PER_RUN = 60;
const GENERAL_MARKET_ASSETS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

type EventRow = { id: string; provider_key: string; cluster_key: string; publicado_em: string; direcao_esperada: string };
type ReactionRow = { event_id: string; simbolo: string; horizonte_minutos: number; devido_em: string; tentativas: number };
type PriceCandle = { openTime: number; closeTime: number; open: number; close: number; volume: number };

function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } }); }
async function hash(value: string) { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join(''); }

async function fetchPriceCandles(symbol: string, interval: string, start: number, end: number): Promise<PriceCandle[]> {
  const endpoint = new URL('/api/v3/klines', 'https://data-api.binance.vision');
  endpoint.searchParams.set('symbol', symbol); endpoint.searchParams.set('interval', interval);
  endpoint.searchParams.set('startTime', String(start)); endpoint.searchParams.set('endTime', String(end)); endpoint.searchParams.set('limit', '1000');
  const response = await fetch(endpoint, { cache: 'no-store' });
  if (!response.ok) throw new Error('Binance respondeu HTTP ' + response.status + ' para ' + symbol);
  const rows = await response.json() as unknown[][];
  return rows.flatMap((row) => Array.isArray(row) && row.length >= 7 ? [{ openTime: Number(row[0]), open: Number(row[1]), close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]) }] : []);
}

function intervalFor(horizon: number) { return horizon <= 60 ? { interval: '1m', milliseconds: 60000 } : horizon <= 720 ? { interval: '5m', milliseconds: 300000 } : { interval: '15m', milliseconds: 900000 }; }
function standardDeviation(values: readonly number[]) { if (values.length < 2) return 0; const average = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1)); }
function returns(candles: readonly PriceCandle[]) { const output: number[] = []; for (let index = 1; index < candles.length; index += 1) if (candles[index - 1].close > 0 && candles[index].close > 0) output.push(Math.log(candles[index].close / candles[index - 1].close)); return output; }

async function priceReaction(symbol: string, benchmark: string, publishedAt: number, horizon: number) {
  const setup = intervalFor(horizon); const dueAt = publishedAt + horizon * 60000; const span = horizon * 60000;
  const start = publishedAt - span - setup.milliseconds * 2; const end = dueAt + setup.milliseconds * 2;
  const [asset, base] = await Promise.all([fetchPriceCandles(symbol, setup.interval, start, end), fetchPriceCandles(benchmark, setup.interval, start, end)]);
  const calculate = (candles: PriceCandle[]) => {
    const after = candles.filter((candle) => candle.closeTime >= publishedAt && candle.closeTime <= dueAt);
    const before = candles.filter((candle) => candle.closeTime < publishedAt && candle.closeTime >= publishedAt - span);
    if (after.length < 2) throw new Error('candles insuficientes para ' + symbol + ' em ' + String(horizon) + ' min');
    const first = after[0].open; const last = after[after.length - 1].close;
    const averageBeforeVolume = before.length > 0 ? before.reduce((total, candle) => total + candle.volume, 0) / before.length : null;
    const averageAfterVolume = after.reduce((total, candle) => total + candle.volume, 0) / after.length;
    const beforeVolatility = standardDeviation(returns(before)); const afterVolatility = standardDeviation(returns(after));
    return { first, last, returnPct: first > 0 ? (last / first - 1) * 100 : null, volumeRatio: averageBeforeVolume && averageBeforeVolume > 0 ? averageAfterVolume / averageBeforeVolume : null, volatilityRatio: beforeVolatility > 0 ? afterVolatility / beforeVolatility : null };
  };
  const active = calculate(asset); const reference = calculate(base);
  const excess = active.returnPct !== null && reference.returnPct !== null ? active.returnPct - reference.returnPct : null;
  return { active, reference, excess };
}

async function createEvent(supabase: SupabaseClient, article: GdeltArticle, recentClusters: Map<string, EventRow>) {
  const providerKey = await hash(article.url); const clusterKey = await hash(normalizeNewsText(article.title));
  const existingResult = await supabase.from('market_news_events').select('id').eq('provider', 'gdelt-doc-2').eq('provider_key', providerKey).maybeSingle();
  if (existingResult.error) throw new Error(existingResult.error.message);
  if (existingResult.data) return { created: false, eventId: (existingResult.data as { id: string }).id };
  const classification = classifyNews(article.title);
  const duplicate = recentClusters.get(clusterKey) ?? null;
  const insert = await supabase.from('market_news_events').insert({ provider: 'gdelt-doc-2', provider_key: providerKey, cluster_key: clusterKey, titulo: article.title, url: article.url, dominio_fonte: article.domain, pais_fonte: article.sourceCountry, idioma: article.language, publicado_em: article.seenAt, categoria: classification.category, direcao_esperada: classification.direction, confianca_pct: classification.confidencePct, novidade: duplicate ? 'repeticao' : 'nova', escopo: classification.scope, motivo_classificacao: classification.reason, palavras_chave: classification.keywords, raw_payload: article.raw, duplicado_de: duplicate?.id ?? null }).select('id, provider_key, cluster_key, publicado_em, direcao_esperada').maybeSingle();
  if (insert.error || !insert.data) throw new Error(insert.error?.message ?? 'evento não criado');
  const event = insert.data as EventRow; recentClusters.set(clusterKey, event);
  const assets = [...new Set(classification.assets.length > 0 ? classification.assets.slice(0, 8) : GENERAL_MARKET_ASSETS)];
  const links = assets.map((symbol) => ({ event_id: event.id, simbolo: symbol, relevancia_pct: classification.assets.includes(symbol) ? 80 : 50, tipo_relacao: classification.assets.includes(symbol) ? 'mencionado' : 'mercado_geral', motivo: classification.reason }));
  const linkResult = await supabase.from('market_news_asset_links').insert(links); if (linkResult.error) throw new Error(linkResult.error.message);
  const reactions = assets.flatMap((symbol) => HORIZONS.map((horizon) => ({ event_id: event.id, simbolo: symbol, horizonte_minutos: horizon, devido_em: new Date(new Date(article.seenAt).getTime() + horizon * 60000).toISOString(), status: 'pendente' })));
  const reactionResult = await supabase.from('market_news_reactions').insert(reactions); if (reactionResult.error) throw new Error(reactionResult.error.message);
  return { created: true, eventId: event.id };
}

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get('x-cron-secret') !== process.env.CRON_SECRET) return json({ ok: false, error: 'não autorizado' }, 401);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return json({ ok: false, error: 'Supabase não configurado' }, 500);
  const supabase: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  await supabase.rpc('abandon_stale_validation_news_runs');
  const runResult = await supabase.from('market_news_runs').insert({ tipo: 'coleta_e_reacoes', status: 'executando' }).select('id').maybeSingle();
  if (runResult.error || !runResult.data) return json({ ok: false, error: runResult.error?.message ?? 'run concorrente' }, 409);
  const runId = (runResult.data as { id: string }).id;
  let received = 0; let created = 0; let repeated = 0; let processed = 0; let failures = 0;
  try {
    const now = new Date(); const from = new Date(now.getTime() - 3 * 3600000);
    const articles = await fetchGdeltArticles(from, now); received = articles.length;
    const clustersResult = await supabase.from('market_news_events').select('id, provider_key, cluster_key, publicado_em, direcao_esperada').gte('publicado_em', new Date(now.getTime() - 72 * 3600000).toISOString());
    if (clustersResult.error) throw new Error(clustersResult.error.message);
    const clusters = new Map(((clustersResult.data ?? []) as EventRow[]).map((event) => [event.cluster_key, event]));
    for (const article of articles) {
      try { const result = await createEvent(supabase, article, clusters); if (result.created) created += 1; else repeated += 1; }
      catch { failures += 1; }
    }
    const dueResult = await supabase.from('market_news_reactions').select('event_id, simbolo, horizonte_minutos, devido_em, tentativas').in('status', ['pendente', 'falhou']).lte('devido_em', now.toISOString()).lt('tentativas', 5).order('devido_em', { ascending: true }).limit(MAX_REACTIONS_PER_RUN);
    if (dueResult.error) throw new Error(dueResult.error.message);
    const due = (dueResult.data ?? []) as ReactionRow[];
    const eventIds = [...new Set(due.map((reaction) => reaction.event_id))];
    const eventsResult = eventIds.length > 0 ? await supabase.from('market_news_events').select('id, publicado_em, direcao_esperada').in('id', eventIds) : { data: [], error: null };
    if (eventsResult.error) throw new Error(eventsResult.error.message);
    const events = new Map(((eventsResult.data ?? []) as Array<{ id: string; publicado_em: string; direcao_esperada: string }>).map((event) => [event.id, event]));
    for (const reaction of due) {
      const event = events.get(reaction.event_id); if (!event) { failures += 1; continue; }
      try {
        const benchmark = reaction.simbolo === 'BTCUSDT' ? 'ETHUSDT' : 'BTCUSDT';
        const metrics = await priceReaction(reaction.simbolo, benchmark, new Date(event.publicado_em).getTime(), Number(reaction.horizonte_minutos));
        const excess = metrics.excess; const absolute = Math.abs(excess ?? 0);
        const impact = absolute < 0.25 ? 'irrelevante' : absolute < 0.75 ? 'baixo' : absolute < 2 ? 'medio' : 'alto';
        const confirmed = event.direcao_esperada === 'positiva' ? excess !== null && excess > 0.25 : event.direcao_esperada === 'negativa' ? excess !== null && excess < -0.25 : null;
        const update = await supabase.from('market_news_reactions').update({ status: 'concluido', processado_em: new Date().toISOString(), preco_inicio: metrics.active.first, preco_fim: metrics.active.last, retorno_ativo_pct: metrics.active.returnPct, benchmark_simbolo: benchmark, benchmark_preco_inicio: metrics.reference.first, benchmark_preco_fim: metrics.reference.last, retorno_benchmark_pct: metrics.reference.returnPct, retorno_excesso_pct: excess, volume_ratio: metrics.active.volumeRatio, volatilidade_ratio: metrics.active.volatilityRatio, direcao_confirmada: confirmed, impacto: impact, erro: null, tentativas: Number(reaction.tentativas) + 1 }).eq('event_id', reaction.event_id).eq('simbolo', reaction.simbolo).eq('horizonte_minutos', reaction.horizonte_minutos);
        if (update.error) throw new Error(update.error.message); processed += 1;
      } catch (error) {
        failures += 1; const message = error instanceof Error ? error.message : String(error);
        await supabase.from('market_news_reactions').update({ status: 'falhou', erro: message, tentativas: Number(reaction.tentativas) + 1 }).eq('event_id', reaction.event_id).eq('simbolo', reaction.simbolo).eq('horizonte_minutos', reaction.horizonte_minutos);
      }
    }
    const status = failures > 0 ? 'concluido_com_falhas' : 'concluido';
    await supabase.from('market_news_runs').update({ status, finalizado_em: new Date().toISOString(), artigos_recebidos: received, eventos_novos: created, eventos_repetidos: repeated, reacoes_processadas: processed, falhas: failures, detalhes: { provider: 'gdelt-doc-2', windowHours: 3, dueReactions: due.length } }).eq('id', runId);
    return json({ ok: true, run_id: runId, status, received, created, repeated, processed, failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from('market_news_runs').update({ status: 'falhou', finalizado_em: new Date().toISOString(), artigos_recebidos: received, eventos_novos: created, eventos_repetidos: repeated, reacoes_processadas: processed, falhas: failures + 1, erro: message }).eq('id', runId);
    return json({ ok: false, run_id: runId, error: message }, 500);
  }
}
