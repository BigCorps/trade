/**
 * Teste prospectivo multiconfiguração do VigIA.
 * Nenhuma ordem é executada.
 */
import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
} from '@/lib/daytrade/indicators';
import {
  evaluateAllDayTradeStrategies,
  type DayTradeStrategyOptionsMap,
  type ForwardTestStrategyId,
} from '@/lib/daytrade/strategies/evaluateAll';
import {
  evaluationWindow,
  resolveForwardSignal,
  selectRecoveryCandles,
  type ForwardDirection,
} from '@/lib/forward-test/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BINANCE_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
] as const;
const TIMEFRAME_MS: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '4h': 4 * 60 * 60 * 1_000,
  '12h': 12 * 60 * 60 * 1_000,
  '1d': 24 * 60 * 60 * 1_000,
};
const CANDLES_NECESSARIOS = 400;
const MAX_CANDLES_RECUPERADOS = 24;
const CONCORRENCIA = 6;
const BINANCE_TIMEOUT_MS = 15_000;

interface ConfigRow {
  id: string;
  nome: string;
  versao: string;
  grupo_experimento?: string | null;
  coletar?: boolean;
  timeframes: string[];
  estrategias: string[];
  simbolos: string[];
  fee_rate_pct: number;
  slippage_pct: number;
  max_next_open_distance_atr: number;
  strategy_options?: Record<string, unknown> | null;
}

interface SignalRow {
  id: string;
  simbolo: string;
  estrategia: string;
  timeframe: string;
  direcao?: ForwardDirection | null;
  candle_open_time: string;
  entrada_referencia: number;
  stop_referencia: number;
  alvo_referencia: number;
  atr: number | null;
  status: string;
  entrada_preco: number | null;
  entrada_em: string | null;
}

type StrategyEvaluation = {
  status?: string;
  allConditionsMet?: boolean;
  strategyVersion?: string;
  scorePct?: number;
  passedConditions?: number;
  totalConditions?: number;
  candleOpenTime?: number;
  candleCloseTime?: number;
  direction?: ForwardDirection;
  diagnostics?: unknown;
  plan?: {
    direction?: ForwardDirection;
    entryReference: number;
    stopReference: number;
    targetReference: number;
    riskPerUnit: number;
    stopDistanceAtr: number;
  } | null;
};

type ConfigSummary = {
  config_id: string;
  config: string;
  grupo_experimento?: string | null;
  coletar?: boolean;
  pares_processados: number;
  falhas: string[];
  resolvidos: number;
  fechados: number;
  cancelados: number;
  novos: number;
  por_timeframe: Record<string, number>;
  candles_avaliados: number;
  candles_recuperados: number;
  pares_bloqueados: number;
  backlog_pares: number;
  backlog_candles_estimados: number;
  duracao_ms: number;
  execucao_id: string | null;
};

function respostaJson(corpo: unknown, status = 200): NextResponse {
  return NextResponse.json(corpo, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function emLotes<T>(
  itens: readonly T[],
  tamanho: number,
  tarefa: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < itens.length; i += tamanho) {
    await Promise.all(itens.slice(i, i + tamanho).map(tarefa));
  }
}

async function buscarCandles(
  simbolo: string,
  timeframe: DayTradeIndicatorTimeframe,
): Promise<DayTradeCandle[]> {
  const agora = Date.now();
  let ultimoErro: unknown = null;
  for (const base of BINANCE_BASE_URLS) {
    try {
      const url = new URL('/api/v3/klines', base);
      url.searchParams.set('symbol', simbolo);
      url.searchParams.set('interval', timeframe);
      url.searchParams.set('limit', '1000');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BINANCE_TIMEOUT_MS);
      const resposta = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      }).finally(() => clearTimeout(timer));
      if (!resposta.ok) {
        ultimoErro = new Error(`HTTP ${resposta.status}`);
        continue;
      }
      const dados = (await resposta.json()) as unknown;
      if (!Array.isArray(dados)) {
        ultimoErro = new Error('resposta inesperada');
        continue;
      }
      return dados.flatMap((linha): DayTradeCandle[] => {
        if (!Array.isArray(linha) || linha.length < 8) return [];
        const candle: DayTradeCandle = {
          openTime: Number(linha[0]),
          open: Number(linha[1]),
          high: Number(linha[2]),
          low: Number(linha[3]),
          close: Number(linha[4]),
          volume: Number(linha[5]),
          closeTime: Number(linha[6]),
          quoteVolume: Number(linha[7]),
          isClosed: Number(linha[6]) <= agora,
        };
        return [
          candle.openTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.closeTime,
        ].every(Number.isFinite)
          ? [candle]
          : [];
      });
    } catch (error) {
      ultimoErro = error;
    }
  }
  throw ultimoErro instanceof Error
    ? ultimoErro
    : new Error(`Falha ao buscar candles de ${simbolo}.`);
}

function cachedCandles(
  cache: Map<string, Promise<DayTradeCandle[]>>,
  symbol: string,
  timeframe: DayTradeIndicatorTimeframe,
): Promise<DayTradeCandle[]> {
  const key = `${symbol}|${timeframe}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const created = buscarCandles(symbol, timeframe);
  cache.set(key, created);
  return created;
}

async function processConfig(
  supabase: SupabaseClient,
  config: ConfigRow,
  cache: Map<string, Promise<DayTradeCandle[]>>,
): Promise<ConfigSummary> {
  const started = Date.now();
  const timeframes = config.timeframes as DayTradeIndicatorTimeframe[];
  const invalid = timeframes.filter((tf) => !(tf in TIMEFRAME_MS));
  if (timeframes.length === 0 || invalid.length > 0) {
    throw new Error(`timeframe inválido: ${invalid.join(', ')}`);
  }

  const { data: runData, error: runError } = await supabase
    .from('forward_test_runs')
    .insert({
      config_id: config.id,
      pares_esperados: config.simbolos.length * timeframes.length,
      status: 'executando',
    })
    .select('id')
    .maybeSingle();
  if (runError) throw new Error(`não foi possível abrir auditoria: ${runError.message}`);
  const runId = (runData as { id: string } | null)?.id ?? null;

  const summary: ConfigSummary = {
    config_id: config.id,
    config: `${config.nome} v${config.versao}`,
    grupo_experimento: config.grupo_experimento,
    pares_processados: 0,
    falhas: [],
    resolvidos: 0,
    fechados: 0,
    cancelados: 0,
    novos: 0,
    por_timeframe: {},
    candles_avaliados: 0,
    candles_recuperados: 0,
    pares_bloqueados: 0,
    backlog_pares: 0,
    backlog_candles_estimados: 0,
    duracao_ms: 0,
    execucao_id: runId,
  };

  const combinations = config.simbolos.flatMap((simbolo) =>
    timeframes.map((timeframe) => ({ simbolo, timeframe })),
  );

  await emLotes(combinations, CONCORRENCIA, async ({ simbolo, timeframe }) => {
    let lockToken: string | null = null;
    try {
      const { data: claimData, error: claimError } = await supabase.rpc(
        'claim_forward_test_checkpoint',
        {
          p_config_id: config.id,
          p_simbolo: simbolo,
          p_timeframe: timeframe,
          p_run_id: runId,
          p_lock_seconds: 240,
        },
      );
      if (claimError) throw new Error(`checkpoint: ${claimError.message}`);
      const claim = (claimData ?? {}) as Record<string, unknown>;
      if (claim.claimed !== true) {
        if (claim.code === 'FORWARD_TEST_PAIR_LOCKED') {
          summary.pares_bloqueados += 1;
          return;
        }
        throw new Error(String(claim.code ?? 'checkpoint não reservado'));
      }
      lockToken =
        typeof claim.lock_token === 'string' ? claim.lock_token : null;
      if (!lockToken) throw new Error('checkpoint sem lock_token');

      const candles = await cachedCandles(cache, simbolo, timeframe);
      const closed = candles
        .filter((candle) => candle.isClosed)
        .sort((a, b) => a.openTime - b.openTime);
      if (closed.length < 250) {
        throw new Error(`histórico curto (${closed.length})`);
      }

      const { data: pendingData, error: pendingError } = await supabase
        .from('forward_test_signals')
.select('*')
        .eq('config_id', config.id)
        .eq('simbolo', simbolo)
        .eq('timeframe', timeframe)
        .in('status', ['aguardando_entrada', 'aberto']);
      if (pendingError) {
        throw new Error(`sinais pendentes: ${pendingError.message}`);
      }
      const active = new Map<string, SignalRow>();
      for (const signal of (pendingData ?? []) as SignalRow[]) {
        active.set(signal.estrategia, signal);
      }

      const selection = selectRecoveryCandles(
        closed,
        typeof claim.last_evaluated_open_time === 'string'
          ? claim.last_evaluated_open_time
          : null,
        MAX_CANDLES_RECUPERADOS,
      );
      let lastEvaluated: DayTradeCandle | null = null;

      for (const candleIndex of selection.indexes) {
        const untilNow = closed.slice(0, candleIndex + 1);
        const current = closed[candleIndex];
        lastEvaluated = current;

        for (const [strategy, signal] of [...active.entries()]) {
          const resolution = resolveForwardSignal(signal, untilNow, config);
          if (
            resolution.status !== signal.status ||
            ['aberto', 'fechado', 'cancelado'].includes(resolution.status)
          ) {
            const { error } = await supabase
              .from('forward_test_signals')
              .update({ ...resolution, atualizado_em: new Date().toISOString() })
              .eq('id', signal.id);
            if (error) throw new Error(`atualização ${signal.id}: ${error.message}`);
            summary.resolvidos += 1;
          }
          if (resolution.status === 'fechado') {
            summary.fechados += 1;
            active.delete(strategy);
          } else if (resolution.status === 'cancelado') {
            summary.cancelados += 1;
            active.delete(strategy);
          } else {
            active.set(strategy, {
              ...signal,
              ...resolution,
              entrada_preco:
                resolution.entrada_preco ?? signal.entrada_preco,
              entrada_em: resolution.entrada_em ?? signal.entrada_em,
            });
          }
        }

        const window = evaluationWindow(
          closed,
          candleIndex,
          CANDLES_NECESSARIOS,
        );
        if (window.length < 250) {
          throw new Error(`aquecimento insuficiente em ${current.openTime}`);
        }
        const evaluation = evaluateAllDayTradeStrategies({
          candles: window,
          indicatorOptions:
            DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
          enabledStrategies: config.estrategias as ForwardTestStrategyId[],
          strategyOptions:
            (config.strategy_options ?? {}) as DayTradeStrategyOptionsMap,
        });

        for (const strategy of config.estrategias) {
          if (active.has(strategy)) continue;
          const result = (
            evaluation.evaluations as Record<string, StrategyEvaluation>
          )[strategy];
          if (
            !result ||
            result.status !== 'condicoes_atendidas' ||
            !result.allConditionsMet ||
            !result.plan
          ) {
            continue;
          }
          const plan = result.plan;
          const row = {
            config_id: config.id,
            simbolo,
            timeframe,
            estrategia: strategy,
            estrategia_versao: result.strategyVersion ?? null,
            candle_open_time: new Date(
              result.candleOpenTime ?? current.openTime,
            ).toISOString(),
            candle_close_time: new Date(
              result.candleCloseTime ?? current.closeTime,
            ).toISOString(),
            entrada_referencia: plan.entryReference,
            stop_referencia: plan.stopReference,
            alvo_referencia: plan.targetReference,
            atr:
              plan.stopDistanceAtr > 0
                ? plan.riskPerUnit / plan.stopDistanceAtr
                : null,
            score_pct: result.scorePct ?? null,
            condicoes_atendidas: result.passedConditions ?? null,
            condicoes_totais: result.totalConditions ?? null,
            tamanho_fixo: 1,
            tamanho_anti: 1,
            resultado_anterior: 'nenhum',
            ...(
              Object.prototype.hasOwnProperty.call(config, 'grupo_experimento')
                ? {
                    direcao: result.direction ?? plan.direction ?? 'long',
                    metadata: {
                      protocol: 'vigia-strategy-v2.0.0',
                      experimentGroup: config.grupo_experimento ?? null,
                      diagnostics: result.diagnostics ?? null,
                      fixedSizingOnly: true,
                    },
                  }
                : {}
            ),
          };
          const { data: inserted, error: insertError } = await supabase
            .from('forward_test_signals')
            .insert(row)
.select('*')
            .maybeSingle();
          if (insertError && insertError.code !== '23505') {
            throw new Error(`novo sinal ${strategy}: ${insertError.message}`);
          }
          let signal = inserted as SignalRow | null;
          if (!signal && insertError?.code === '23505') {
            const { data: existing } = await supabase
              .from('forward_test_signals')
.select('*')
              .eq('config_id', config.id)
              .eq('simbolo', simbolo)
              .eq('timeframe', timeframe)
              .eq('estrategia', strategy)
              .eq('candle_open_time', row.candle_open_time)
              .maybeSingle();
            signal = existing as SignalRow | null;
          }
          if (
            signal &&
            ['aguardando_entrada', 'aberto'].includes(signal.status)
          ) {
            active.set(strategy, signal);
          }
          if (!insertError) {
            summary.novos += 1;
            summary.por_timeframe[timeframe] =
              (summary.por_timeframe[timeframe] ?? 0) + 1;
          }
        }
      }

      const { data: completionData, error: completionError } =
        await supabase.rpc('complete_forward_test_checkpoint', {
          p_config_id: config.id,
          p_simbolo: simbolo,
          p_timeframe: timeframe,
          p_lock_token: lockToken,
          p_run_id: runId,
          p_last_evaluated_open_time: lastEvaluated
            ? new Date(lastEvaluated.openTime).toISOString()
            : null,
          p_last_evaluated_close_time: lastEvaluated
            ? new Date(lastEvaluated.closeTime).toISOString()
            : null,
          p_candles_evaluated: selection.indexes.length,
          p_recovery_candles: selection.recoveredCount,
          p_backlog_estimated: selection.backlog,
        });
      if (completionError) {
        throw new Error(`conclusão: ${completionError.message}`);
      }
      if (
        ((completionData ?? {}) as Record<string, unknown>).updated !== true
      ) {
        throw new Error('checkpoint não concluído');
      }

      summary.pares_processados += 1;
      summary.candles_avaliados += selection.indexes.length;
      summary.candles_recuperados += selection.recoveredCount;
      summary.backlog_candles_estimados += selection.backlog;
      if (selection.backlog > 0) summary.backlog_pares += 1;
    } catch (error) {
      const message = `${simbolo} ${timeframe}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      summary.falhas.push(message);
      if (lockToken) {
        await supabase.rpc('fail_forward_test_checkpoint', {
          p_config_id: config.id,
          p_simbolo: simbolo,
          p_timeframe: timeframe,
          p_lock_token: lockToken,
          p_run_id: runId,
          p_error: message,
        });
      }
    }
  });

  summary.duracao_ms = Date.now() - started;
  if (runId) {
    await supabase
      .from('forward_test_runs')
      .update({
        finalizado_em: new Date().toISOString(),
        pares_processados: summary.pares_processados,
        sinais_criados: summary.novos,
        sinais_resolvidos: summary.resolvidos,
        falhas: summary.falhas,
        duracao_ms: summary.duracao_ms,
        candles_avaliados: summary.candles_avaliados,
        candles_recuperados: summary.candles_recuperados,
        pares_bloqueados: summary.pares_bloqueados,
        backlog_pares: summary.backlog_pares,
        backlog_candles_estimados: summary.backlog_candles_estimados,
        status:
          summary.pares_processados === 0 &&
          summary.pares_bloqueados === 0
            ? 'falhou'
            : summary.falhas.length > 0
              ? 'concluido_com_falhas'
              : 'concluido',
      })
      .eq('id', runId);
  }
  return summary;
}

export async function POST(req: Request): Promise<NextResponse> {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return respostaJson({ ok: false, erro: 'não autorizado' }, 401);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) {
    return respostaJson(
      { ok: false, erro: 'Supabase não configurado no servidor.' },
      500,
    );
  }
  const supabase: SupabaseClient = createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await supabase.rpc('abandon_stale_validation_news_runs');

  // `coletar` é a fonte autoritativa de quais protocolos estão em coleta.
  //
  // A versão anterior consultava `ativo=true` primeiro e só então checava a
  // existência da coluna `coletar` com `.some()` sobre o resultado. Se nenhuma
  // linha tivesse `ativo=true`, o array vinha vazio, `.some()` devolvia false,
  // o bloco de `coletar` nunca executava e a rota respondia 500 — mesmo com
  // protocolos legitimamente em coleta. A coleta passava a depender de um flag
  // de interface que não tem relação com o experimento.
  let configs: ConfigRow[] = [];

  const collectingResult = await supabase
    .from('forward_test_config')
    .select('*')
    .eq('coletar', true)
    .order('congelado_em', { ascending: true });

  if (collectingResult.error) {
    // Deploy anterior à migração da coluna `coletar`: cai para o critério antigo.
    const fallbackResult = await supabase
      .from('forward_test_config')
      .select('*')
      .eq('ativo', true)
      .order('congelado_em', { ascending: true });
    if (fallbackResult.error) {
      return respostaJson({ ok: false, erro: fallbackResult.error.message }, 500);
    }
    configs = (fallbackResult.data ?? []) as ConfigRow[];
  } else {
    configs = (collectingResult.data ?? []) as ConfigRow[];
  }

  // Nenhum protocolo em coleta é um estado legítimo (todas as hipóteses
  // encerradas), não uma falha. Responder 500 aqui transformaria o encerramento
  // de uma linha de pesquisa em ruído de erro horário, escondendo falhas reais.
  if (configs.length === 0) {
    return respostaJson({
      ok: true,
      noop: true,
      motivo: 'nenhum protocolo com coletar=true; nada a processar',
      configs: [],
    });
  }

  const started = Date.now();
  const cache = new Map<string, Promise<DayTradeCandle[]>>();
  const results: ConfigSummary[] = [];
  for (const config of configs) {
    try {
      results.push(await processConfig(supabase, config, cache));
    } catch (error) {
      results.push({
        config_id: config.id,
        config: `${config.nome} v${config.versao}`,
        grupo_experimento: config.grupo_experimento,
        pares_processados: 0,
        falhas: [error instanceof Error ? error.message : String(error)],
        resolvidos: 0,
        fechados: 0,
        cancelados: 0,
        novos: 0,
        por_timeframe: {},
        candles_avaliados: 0,
        candles_recuperados: 0,
        pares_bloqueados: 0,
        backlog_pares: 0,
        backlog_candles_estimados: 0,
        duracao_ms: 0,
        execucao_id: null,
      });
    }
  }

  return respostaJson({
    ok: results.some((result) => result.pares_processados > 0),
    protocol: 'vigia-strategy-v2.0.0',
    executedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    configs: results,
  });
}
