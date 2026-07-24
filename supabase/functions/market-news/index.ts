import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { classifyNews, type NewsClassification } from './classifier.ts';

const VERSION = 'market-news-v2.0.0';
const HORIZONS = [15, 60, 240, 720, 1440, 4320] as const;
const RSS = [
  ['coindesk-rss', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['cointelegraph-rss', 'https://cointelegraph.com/rss'],
  ['decrypt-rss', 'https://decrypt.co/feed'],
] as const;

type Article = {
  provider: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: string;
  domain: string | null;
  country: string | null;
  language: string | null;
  raw: Record<string, unknown>;
};

type ProviderResult = {
  provider: string;
  status: 'ok' | 'rate_limited' | 'failed';
  received: number;
  error: string | null;
  articles: Article[];
};

type ActiveHypothesis = {
  id: string;
  categoria: string | null;
  direcao_esperada: 'positiva' | 'negativa';
  horizonte_minutos: number;
  confianca_min_pct: number;
  exige_ativo_explicito: boolean;
  relevancia_exigida: 'relevante' | 'ambigua';
  inicio_amostra_em: string;
};

type Candle = { closeTime: number; open: number; close: number; volume: number };
type DbClient = ReturnType<typeof createClient>;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    return [error.name, error.message, cause?.code, cause?.message].filter(Boolean).join(': ');
  }
  return String(error);
}

function normalize(value: string) {
  return (` ${value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9$]+/g, ' ')} `)
    .replace(/\s+/g, ' ');
}

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function sourceDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .trim();
}

function cleanText(value: string) {
  return decodeXml(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(block: string, names: string[]) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
    if (match) return decodeXml(match[1]);
  }
  return null;
}

async function fetchResponse(
  url: string | URL,
  timeout = 20_000,
  accept = 'application/json, application/rss+xml, application/xml, text/xml',
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: accept,
        'User-Agent': `VigIA-Market-News/${VERSION} (+https://vigia.bigcorps.com.br)`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function gdeltDate(date: Date) {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}`;
}

function parseGdeltDate(value: unknown) {
  if (typeof value !== 'string') return null;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  return match
    ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])).toISOString()
    : null;
}

async function fetchGdelt(from: Date, to: Date): Promise<ProviderResult> {
  const provider = 'gdelt-doc-2';
  const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
  url.searchParams.set('query', '(bitcoin OR cryptocurrency OR ethereum OR blockchain OR stablecoin OR binance OR coinbase OR solana OR ripple OR "crypto ETF")');
  url.searchParams.set('mode', 'ArtList');
  url.searchParams.set('format', 'json');
  url.searchParams.set('maxrecords', '100');
  url.searchParams.set('sort', 'DateDesc');
  url.searchParams.set('startdatetime', gdeltDate(from));
  url.searchParams.set('enddatetime', gdeltDate(to));

  let lastError = 'falha desconhecida';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(lastError.includes('429') ? 6_500 : 1_500);
    try {
      const response = await fetchResponse(url, 25_000, 'application/json');
      if (!response.ok) {
        lastError = `GDELT HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
        if (response.status !== 429 && response.status < 500) break;
        continue;
      }
      const data = await response.json() as { articles?: Record<string, unknown>[] };
      const articles = (data.articles ?? []).flatMap((raw) => {
        const articleUrl = typeof raw.url === 'string' ? raw.url : '';
        const title = typeof raw.title === 'string' ? cleanText(raw.title) : '';
        const summary = typeof raw.excerpt === 'string'
          ? cleanText(raw.excerpt)
          : typeof raw.description === 'string'
            ? cleanText(raw.description)
            : '';
        const publishedAt = parseGdeltDate(raw.seendate);
        if (!articleUrl || !title || !publishedAt) return [];
        return [{
          provider,
          url: articleUrl,
          title,
          summary,
          publishedAt,
          domain: typeof raw.domain === 'string' ? raw.domain : sourceDomain(articleUrl),
          country: typeof raw.sourcecountry === 'string' ? raw.sourcecountry : null,
          language: typeof raw.language === 'string' ? raw.language : null,
          raw,
        } satisfies Article];
      });
      return { provider, status: 'ok', received: articles.length, error: null, articles };
    } catch (error) {
      lastError = errorMessage(error);
    }
  }

  return {
    provider,
    status: lastError.includes('429') ? 'rate_limited' : 'failed',
    received: 0,
    error: lastError,
    articles: [],
  };
}

async function fetchRss(provider: string, url: string, from: Date, to: Date): Promise<ProviderResult> {
  try {
    const response = await fetchResponse(url, 18_000, 'application/rss+xml, application/xml, text/xml');
    if (!response.ok) {
      return {
        provider,
        status: response.status === 429 ? 'rate_limited' : 'failed',
        received: 0,
        error: `RSS HTTP ${response.status}`,
        articles: [],
      };
    }

    const body = await response.text();
    const lower = from.getTime() - 15 * 60_000;
    const upper = to.getTime() + 5 * 60_000;
    const articles = [...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
      .slice(0, 100)
      .flatMap((match) => {
        const block = match[1];
        const title = cleanText(xmlTag(block, ['title']) ?? '');
        const link = xmlTag(block, ['link']) ?? xmlTag(block, ['guid']) ?? '';
        const dateString = xmlTag(block, ['pubDate', 'dc:date', 'published', 'updated']);
        const summary = cleanText(xmlTag(block, ['description', 'content:encoded', 'summary']) ?? '');
        const timestamp = dateString ? Date.parse(dateString) : Number.NaN;
        if (!title || !link || !Number.isFinite(timestamp) || timestamp < lower || timestamp > upper) return [];
        return [{
          provider,
          url: link,
          title,
          summary,
          publishedAt: new Date(timestamp).toISOString(),
          domain: sourceDomain(link),
          country: null,
          language: 'English',
          raw: { feed: url, title, link, published: dateString, summary },
        } satisfies Article];
      });

    return { provider, status: 'ok', received: articles.length, error: null, articles };
  } catch (error) {
    return { provider, status: 'failed', received: 0, error: errorMessage(error), articles: [] };
  }
}

function studyAssets(classification: NewsClassification) {
  if (!classification.eligibleForReaction) return [];
  if (classification.assets.length > 0) return [...new Set(classification.assets.slice(0, 4))];
  return classification.generalMarket ? ['BTCUSDT'] : [];
}

function matchesHypothesis(
  classification: NewsClassification,
  publishedAt: string,
  hypothesis: ActiveHypothesis | null,
) {
  if (!hypothesis) return false;
  if (new Date(publishedAt).getTime() < new Date(hypothesis.inicio_amostra_em).getTime()) return false;
  if (classification.relevance !== hypothesis.relevancia_exigida) return false;
  if (classification.direction !== hypothesis.direcao_esperada) return false;
  if (classification.confidencePct < Number(hypothesis.confianca_min_pct)) return false;
  if (hypothesis.categoria && classification.category !== hypothesis.categoria) return false;
  if (hypothesis.exige_ativo_explicito && !classification.primaryAsset) return false;
  return true;
}

async function activeHypothesis(db: DbClient): Promise<ActiveHypothesis | null> {
  const result = await db
    .from('market_news_hypotheses')
    .select('id,categoria,direcao_esperada,horizonte_minutos,confianca_min_pct,exige_ativo_explicito,relevancia_exigida,inicio_amostra_em')
    .eq('status', 'ativa')
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return (result.data as ActiveHypothesis | null) ?? null;
}

async function createStudyRows(
  db: DbClient,
  eventId: string,
  publishedAt: string,
  classification: NewsClassification,
  hypothesis: ActiveHypothesis | null,
  hypothesisEligible: boolean,
) {
  const assets = studyAssets(classification);
  if (assets.length === 0) return { assets: 0, reactions: 0 };

  const links = assets.map((symbol) => ({
    event_id: eventId,
    simbolo: symbol,
    relevancia_pct: classification.assets.includes(symbol) ? 90 : 65,
    tipo_relacao: classification.assets.includes(symbol) ? 'mencionado' : 'mercado_geral',
    motivo: classification.relevanceReason,
  }));
  const linkResult = await db.from('market_news_asset_links').upsert(links, {
    onConflict: 'event_id,simbolo',
  });
  if (linkResult.error) throw new Error(linkResult.error.message);

  const reactions = assets.flatMap((symbol) => HORIZONS.map((horizon) => {
    const confirmatory = Boolean(
      hypothesis
      && hypothesisEligible
      && classification.primaryAsset === symbol
      && hypothesis.horizonte_minutos === horizon,
    );
    return {
      event_id: eventId,
      simbolo: symbol,
      horizonte_minutos: horizon,
      devido_em: new Date(new Date(publishedAt).getTime() + horizon * 60_000).toISOString(),
      status: 'pendente',
      papel_analise: confirmatory ? 'confirmatoria' : 'exploratoria',
      hipotese_id: confirmatory ? hypothesis!.id : null,
      observacao_independente: confirmatory,
    };
  }));

  const reactionResult = await db.from('market_news_reactions').upsert(reactions, {
    onConflict: 'event_id,simbolo,horizonte_minutos',
    ignoreDuplicates: true,
  });
  if (reactionResult.error) throw new Error(reactionResult.error.message);
  return { assets: links.length, reactions: reactions.length };
}

async function ingestArticle(
  db: DbClient,
  article: Article,
  clusters: Map<string, string>,
  hypothesis: ActiveHypothesis | null,
) {
  const providerKey = await sha256(article.url);
  const clusterKey = await sha256(normalize(article.title));
  const exact = await db
    .from('market_news_events')
    .select('id')
    .eq('provider', article.provider)
    .eq('provider_key', providerKey)
    .maybeSingle();
  if (exact.error) throw new Error(exact.error.message);
  if (exact.data || clusters.has(clusterKey)) return { repeated: true, relevance: null, reactions: 0 };

  const classification = classifyNews(article.title, article.summary, article.domain);
  const hypothesisEligible = matchesHypothesis(classification, article.publishedAt, hypothesis);
  const inserted = await db.from('market_news_events').insert({
    provider: article.provider,
    provider_key: providerKey,
    cluster_key: clusterKey,
    titulo: article.title,
    resumo: article.summary || null,
    url: article.url,
    dominio_fonte: article.domain,
    pais_fonte: article.country,
    idioma: article.language,
    publicado_em: article.publishedAt,
    categoria: classification.category,
    direcao_esperada: classification.direction,
    confianca_pct: classification.confidencePct,
    novidade: 'nova',
    escopo: classification.scope,
    motivo_classificacao: classification.reason,
    palavras_chave: classification.keywords,
    raw_payload: article.raw,
    relevancia: classification.relevance,
    relevancia_pct: classification.relevancePct,
    motivo_relevancia: classification.relevanceReason,
    classificador_versao: VERSION,
    ativo_principal: classification.primaryAsset,
    elegivel_reacao: classification.eligibleForReaction,
    hipotese_principal_id: hypothesisEligible ? hypothesis?.id : null,
    hipotese_principal_elegivel: hypothesisEligible,
  }).select('id').maybeSingle();
  if (inserted.error || !inserted.data) throw new Error(inserted.error?.message ?? 'evento não criado');

  clusters.set(clusterKey, inserted.data.id);
  const study = await createStudyRows(
    db,
    inserted.data.id,
    article.publishedAt,
    classification,
    hypothesis,
    hypothesisEligible,
  );
  return {
    repeated: false,
    relevance: classification.relevance,
    reactions: study.reactions,
  };
}

async function reclassifyExisting(db: DbClient) {
  const hypothesis = await activeHypothesis(db);
  const result = await db
    .from('market_news_events')
    .select('id,titulo,resumo,dominio_fonte,publicado_em,raw_payload')
    .order('publicado_em', { ascending: false })
    .limit(500);
  if (result.error) throw new Error(result.error.message);

  const totals = { processed: 0, relevant: 0, ambiguous: 0, irrelevant: 0, discarded: 0, reactionsCreated: 0 };
  for (const event of result.data ?? []) {
    const raw = event.raw_payload && typeof event.raw_payload === 'object' ? event.raw_payload as Record<string, unknown> : {};
    const rawSummary = typeof raw.summary === 'string'
      ? raw.summary
      : typeof raw.description === 'string'
        ? raw.description
        : '';
    const summary = event.resumo ?? rawSummary;
    const classification = classifyNews(event.titulo, summary, event.dominio_fonte);
    const hypothesisEligible = matchesHypothesis(classification, event.publicado_em, hypothesis);

    const update = await db.from('market_news_events').update({
      resumo: summary || null,
      categoria: classification.category,
      direcao_esperada: classification.direction,
      confianca_pct: classification.confidencePct,
      escopo: classification.scope,
      motivo_classificacao: classification.reason,
      palavras_chave: classification.keywords,
      relevancia: classification.relevance,
      relevancia_pct: classification.relevancePct,
      motivo_relevancia: classification.relevanceReason,
      classificador_versao: VERSION,
      ativo_principal: classification.primaryAsset,
      elegivel_reacao: classification.eligibleForReaction,
      hipotese_principal_id: hypothesisEligible ? hypothesis?.id : null,
      hipotese_principal_elegivel: hypothesisEligible,
    }).eq('id', event.id);
    if (update.error) throw new Error(update.error.message);

    await db.from('market_news_asset_links').delete().eq('event_id', event.id);
    const existing = await db
      .from('market_news_reactions')
      .select('simbolo,horizonte_minutos,status')
      .eq('event_id', event.id);
    if (existing.error) throw new Error(existing.error.message);

    const allowedAssets = studyAssets(classification);
    for (const row of existing.data ?? []) {
      const allowed = allowedAssets.includes(row.simbolo);
      const patch: Record<string, unknown> = {
        papel_analise: 'exploratoria',
        hipotese_id: null,
        observacao_independente: false,
      };
      if (!allowed && ['pendente', 'falhou'].includes(row.status)) {
        patch.status = 'descartado';
        patch.erro = 'Descartada pela reclassificação de relevância v2.';
        totals.discarded += 1;
      }
      const updatedReaction = await db.from('market_news_reactions').update(patch)
        .eq('event_id', event.id)
        .eq('simbolo', row.simbolo)
        .eq('horizonte_minutos', row.horizonte_minutos);
      if (updatedReaction.error) throw new Error(updatedReaction.error.message);
    }

    if (classification.eligibleForReaction) {
      const study = await createStudyRows(db, event.id, event.publicado_em, classification, hypothesis, hypothesisEligible);
      totals.reactionsCreated += study.reactions;
    }

    totals.processed += 1;
    if (classification.relevance === 'relevante') totals.relevant += 1;
    if (classification.relevance === 'ambigua') totals.ambiguous += 1;
    if (classification.relevance === 'irrelevante') totals.irrelevant += 1;
  }
  return totals;
}

async function candles(symbol: string, interval: string, start: number, end: number): Promise<Candle[]> {
  const url = new URL('/api/v3/klines', 'https://data-api.binance.vision');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('startTime', String(start));
  url.searchParams.set('endTime', String(end));
  url.searchParams.set('limit', '1000');
  const response = await fetchResponse(url, 20_000, 'application/json');
  if (!response.ok) throw new Error(`Binance HTTP ${response.status} para ${symbol}`);
  const rows = await response.json() as unknown[][];
  return rows.flatMap((row) => Array.isArray(row) && row.length >= 7
    ? [{ open: Number(row[1]), close: Number(row[4]), volume: Number(row[5]), closeTime: Number(row[6]) }]
    : []);
}

function stdev(values: number[]) {
  if (values.length < 2) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

async function reaction(symbol: string, benchmark: string, published: number, horizon: number) {
  const setup = horizon <= 60
    ? ['1m', 60_000] as const
    : horizon <= 720
      ? ['5m', 300_000] as const
      : ['15m', 900_000] as const;
  const due = published + horizon * 60_000;
  const span = horizon * 60_000;
  const start = published - span - setup[1] * 2;
  const end = due + setup[1] * 2;
  const [activeRows, benchmarkRows] = await Promise.all([
    candles(symbol, setup[0], start, end),
    candles(benchmark, setup[0], start, end),
  ]);

  const calculate = (rows: Candle[]) => {
    const after = rows.filter((item) => item.closeTime >= published && item.closeTime <= due);
    const before = rows.filter((item) => item.closeTime < published && item.closeTime >= published - span);
    if (after.length < 2) throw new Error(`candles insuficientes para ${symbol}/${horizon}`);
    const first = after[0].open;
    const last = after.at(-1)!.close;
    const averageBefore = before.length ? before.reduce((sum, item) => sum + item.volume, 0) / before.length : null;
    const averageAfter = after.reduce((sum, item) => sum + item.volume, 0) / after.length;
    const returns = (items: Candle[]) => items.slice(1).map((item, index) => Math.log(item.close / items[index].close));
    const volatilityBefore = stdev(returns(before));
    const volatilityAfter = stdev(returns(after));
    return {
      first,
      last,
      returnPct: first > 0 ? (last / first - 1) * 100 : null,
      volumeRatio: averageBefore && averageBefore > 0 ? averageAfter / averageBefore : null,
      volatilityRatio: volatilityBefore > 0 ? volatilityAfter / volatilityBefore : null,
    };
  };

  const active = calculate(activeRows);
  const base = calculate(benchmarkRows);
  return {
    active,
    base,
    excess: active.returnPct !== null && base.returnPct !== null ? active.returnPct - base.returnPct : null,
  };
}

async function processDueReactions(db: DbClient, now: Date) {
  const dueResult = await db
    .from('market_news_reactions')
    .select('event_id,simbolo,horizonte_minutos,devido_em,tentativas')
    .in('status', ['pendente', 'falhou'])
    .lte('devido_em', now.toISOString())
    .lt('tentativas', 5)
    .order('devido_em', { ascending: true })
    .limit(60);
  if (dueResult.error) throw new Error(dueResult.error.message);

  const due = dueResult.data ?? [];
  const eventIds = [...new Set(due.map((item) => item.event_id))];
  const eventResult = eventIds.length > 0
    ? await db.from('market_news_events').select('id,publicado_em,direcao_esperada,relevancia,elegivel_reacao').in('id', eventIds)
    : { data: [], error: null };
  if (eventResult.error) throw new Error(eventResult.error.message);
  const events = new Map((eventResult.data ?? []).map((event) => [event.id, event]));

  let processed = 0;
  let failures = 0;
  let discarded = 0;
  const errors: string[] = [];

  for (const item of due) {
    const event = events.get(item.event_id);
    if (!event || !event.elegivel_reacao || event.relevancia !== 'relevante') {
      await db.from('market_news_reactions').update({
        status: 'descartado',
        erro: 'Evento não elegível após filtro de relevância.',
      }).eq('event_id', item.event_id)
        .eq('simbolo', item.simbolo)
        .eq('horizonte_minutos', item.horizonte_minutos);
      discarded += 1;
      continue;
    }

    try {
      const benchmark = item.simbolo === 'BTCUSDT' ? 'ETHUSDT' : 'BTCUSDT';
      const measurement = await reaction(
        item.simbolo,
        benchmark,
        new Date(event.publicado_em).getTime(),
        Number(item.horizonte_minutos),
      );
      const absolute = Math.abs(measurement.excess ?? 0);
      const impact = absolute < 0.25 ? 'irrelevante' : absolute < 0.75 ? 'baixo' : absolute < 2 ? 'medio' : 'alto';
      const confirmed = event.direcao_esperada === 'positiva'
        ? measurement.excess !== null && measurement.excess > 0.25
        : event.direcao_esperada === 'negativa'
          ? measurement.excess !== null && measurement.excess < -0.25
          : null;

      const updated = await db.from('market_news_reactions').update({
        status: 'concluido',
        processado_em: new Date().toISOString(),
        preco_inicio: measurement.active.first,
        preco_fim: measurement.active.last,
        retorno_ativo_pct: measurement.active.returnPct,
        benchmark_simbolo: benchmark,
        benchmark_preco_inicio: measurement.base.first,
        benchmark_preco_fim: measurement.base.last,
        retorno_benchmark_pct: measurement.base.returnPct,
        retorno_excesso_pct: measurement.excess,
        volume_ratio: measurement.active.volumeRatio,
        volatilidade_ratio: measurement.active.volatilityRatio,
        direcao_confirmada: confirmed,
        impacto: impact,
        erro: null,
        tentativas: Number(item.tentativas) + 1,
      }).eq('event_id', item.event_id)
        .eq('simbolo', item.simbolo)
        .eq('horizonte_minutos', item.horizonte_minutos);
      if (updated.error) throw new Error(updated.error.message);
      processed += 1;
    } catch (error) {
      failures += 1;
      const message = errorMessage(error);
      errors.push(`${item.simbolo}/${item.horizonte_minutos}: ${message}`);
      await db.from('market_news_reactions').update({
        status: 'falhou',
        erro: message.slice(0, 500),
        tentativas: Number(item.tentativas) + 1,
      }).eq('event_id', item.event_id)
        .eq('simbolo', item.simbolo)
        .eq('horizonte_minutos', item.horizonte_minutos);
    }
  }

  return { due: due.length, processed, failures, discarded, errors: errors.slice(0, 20) };
}

Deno.serve(async (request) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || request.headers.get('x-cron-secret') !== secret) {
    return reply({ ok: false, error: 'não autorizado' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return reply({ ok: false, error: 'Supabase não configurado' }, 500);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await db.rpc('abandon_stale_validation_news_runs');

  let action = 'collect';
  try {
    const body = await request.json() as { action?: string };
    action = body.action ?? 'collect';
  } catch {
    action = 'collect';
  }

  const runType = action === 'reclassify' ? 'reclassificacao_v2' : 'coleta_e_reacoes';
  const started = await db.from('market_news_runs').insert({ tipo: runType, status: 'executando' }).select('id').maybeSingle();
  if (started.error || !started.data) {
    return reply({ ok: false, error: started.error?.message ?? 'run concorrente' }, 409);
  }

  const runId = started.data.id;
  let received = 0;
  let created = 0;
  let repeated = 0;
  let articleFailures = 0;

  try {
    if (action === 'reclassify') {
      const totals = await reclassifyExisting(db);
      await db.from('market_news_runs').update({
        status: 'concluido',
        finalizado_em: new Date().toISOString(),
        artigos_recebidos: totals.processed,
        eventos_novos: 0,
        eventos_repetidos: 0,
        reacoes_processadas: 0,
        falhas: 0,
        detalhes: { version: VERSION, action, ...totals },
        erro: null,
      }).eq('id', runId);
      return reply({ ok: true, run_id: runId, status: 'concluido', version: VERSION, ...totals });
    }

    const now = new Date();
    const from = new Date(now.getTime() - 3 * 60 * 60_000);
    const hypothesis = await activeHypothesis(db);
    const providers = await Promise.all([
      fetchGdelt(from, now),
      ...RSS.map(([provider, url]) => fetchRss(provider, url, from, now)),
    ]);
    received = providers.reduce((sum, provider) => sum + provider.received, 0);
    const providersOk = providers.filter((provider) => provider.status === 'ok').length;

    const old = await db.from('market_news_events')
      .select('id,cluster_key')
      .gte('publicado_em', new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString());
    if (old.error) throw new Error(old.error.message);
    const clusters = new Map((old.data ?? []).map((event) => [event.cluster_key, event.id]));

    const articleMap = new Map<string, Article>();
    for (const provider of providers) {
      for (const article of provider.articles) articleMap.set(`${article.provider}|${article.url}`, article);
    }
    const articles = [...articleMap.values()]
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, 160);

    const relevanceCounts = { relevante: 0, ambigua: 0, irrelevante: 0 };
    let reactionsCreated = 0;
    for (const article of articles) {
      try {
        const result = await ingestArticle(db, article, clusters, hypothesis);
        if (result.repeated) {
          repeated += 1;
          continue;
        }
        created += 1;
        reactionsCreated += result.reactions;
        if (result.relevance) relevanceCounts[result.relevance] += 1;
      } catch (error) {
        articleFailures += 1;
        console.error('evento', errorMessage(error));
      }
    }

    const reactionResult = await processDueReactions(db, now);
    const failures = (providers.length - providersOk) + articleFailures + reactionResult.failures;
    const noSuccess = providersOk === 0 && reactionResult.processed === 0 && reactionResult.due === 0;
    const status = noSuccess ? 'falhou' : failures > 0 ? 'concluido_com_falhas' : 'concluido';
    const details = {
      version: VERSION,
      action,
      windowHours: 3,
      providers: Object.fromEntries(providers.map((provider) => [provider.provider, {
        status: provider.status,
        received: provider.received,
        error: provider.error,
      }])),
      providersOk,
      providersTotal: providers.length,
      uniqueArticles: articles.length,
      articleFailures,
      relevanceCounts,
      reactionsCreated,
      dueReactions: reactionResult.due,
      discardedReactions: reactionResult.discarded,
      reactionErrors: reactionResult.errors,
      hypothesisVersion: hypothesis?.id ?? null,
    };

    await db.from('market_news_runs').update({
      status,
      finalizado_em: new Date().toISOString(),
      artigos_recebidos: received,
      eventos_novos: created,
      eventos_repetidos: repeated,
      reacoes_processadas: reactionResult.processed,
      falhas: failures,
      detalhes: details,
      erro: noSuccess ? 'Nenhum provedor respondeu e não havia reações pendentes.' : null,
    }).eq('id', runId);

    return reply({
      ok: !noSuccess,
      run_id: runId,
      status,
      version: VERSION,
      received,
      created,
      repeated,
      processed: reactionResult.processed,
      failures,
      relevance: relevanceCounts,
      reactionsCreated,
      providers: details.providers,
    }, noSuccess ? 502 : 200);
  } catch (error) {
    const message = errorMessage(error);
    await db.from('market_news_runs').update({
      status: 'falhou',
      finalizado_em: new Date().toISOString(),
      artigos_recebidos: received,
      eventos_novos: created,
      eventos_repetidos: repeated,
      reacoes_processadas: 0,
      falhas: articleFailures + 1,
      erro: message.slice(0, 1_000),
      detalhes: { version: VERSION, action, articleFailures },
    }).eq('id', runId);
    return reply({ ok: false, run_id: runId, error: message }, 500);
  }
});
