import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  DayTradeCandle,
  DayTradeIndicatorTimeframe,
} from '@/lib/daytrade/indicators';
import {
  buildValidationReport,
  type ValidationTrade,
} from '@/lib/forward-test/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BINANCE_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
] as const;
const TIMEFRAME_MS: Record<string, number> = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};
const CONCURRENCY = 6;
const ITERATIONS = 5_000;
const SEED = 20260805;

type Direction = 'long' | 'short';
type ConfigRow = {
  id: string;
  nome: string;
  versao: string;
  coletar?: boolean;
  fee_rate_pct: number;
  slippage_pct: number;
  max_next_open_distance_atr: number;
};
type SignalRow = {
  id: string;
  config_id: string;
  simbolo: string;
  timeframe: string;
  estrategia: string;
  direcao?: Direction | null;
  candle_open_time: string;
  candle_close_time: string;
  status: string;
  entrada_referencia: number;
  stop_referencia: number;
  alvo_referencia: number;
  atr: number | null;
  entrada_preco: number | null;
  resultado_r: number | null;
};
type ContextRow = {
  signal_id: string;
  replay_r_1x: number | null;
  replay_r_1_5x: number | null;
  replay_r_2x: number | null;
  replay_r_3x: number | null;
  replay_r_atraso_1: number | null;
  replay_r_atraso_2: number | null;
  tendencia_ativo: string | null;
  volatilidade_ativo: string | null;
  tendencia_btc: string | null;
  volatilidade_btc: string | null;
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
function value(input: unknown): number | null {
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}
async function inBatches<T>(
  items: readonly T[],
  size: number,
  task: (item: T) => Promise<void>,
) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(task));
  }
}

async function fetchCandles(
  symbol: string,
  timeframe: string,
): Promise<DayTradeCandle[]> {
  let lastError: unknown = null;
  for (const base of BINANCE_BASE_URLS) {
    try {
      const endpoint = new URL('/api/v3/klines', base);
      endpoint.searchParams.set('symbol', symbol);
      endpoint.searchParams.set('interval', timeframe);
      endpoint.searchParams.set('limit', '1000');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(endpoint, {
        signal: controller.signal,
        cache: 'no-store',
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const rows = (await response.json()) as unknown[][];
      const now = Date.now();
      return rows.flatMap((row) => {
        if (!Array.isArray(row) || row.length < 8) return [];
        const candle: DayTradeCandle = {
          openTime: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          closeTime: Number(row[6]),
          quoteVolume: Number(row[7]),
          isClosed: Number(row[6]) <= now,
        };
        return [
          candle.openTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.closeTime,
        ].every(Number.isFinite)
          ? [candle]
          : [];
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Falha ao buscar candles de ${symbol}`);
}

function ema(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current =
    values.slice(0, period).reduce((total, item) => total + item, 0) /
    period;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
  }
  return current;
}
function trueRanges(candles: readonly DayTradeCandle[]): number[] {
  return candles.map((candle, index) =>
    index === 0
      ? candle.high - candle.low
      : Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - candles[index - 1].close),
          Math.abs(candle.low - candles[index - 1].close),
        ),
  );
}
function atr(candles: readonly DayTradeCandle[], period = 14): number | null {
  const ranges = trueRanges(candles);
  if (ranges.length < period) return null;
  return (
    ranges.slice(-period).reduce((total, item) => total + item, 0) /
    period
  );
}
function percentileRank(values: readonly number[], current: number) {
  if (values.length === 0) return null;
  return (100 * values.filter((item) => item <= current).length) / values.length;
}
function context(
  candles: readonly DayTradeCandle[],
  signalTime: number,
  timeframe: string,
) {
  const index = candles.findIndex((candle) => candle.openTime === signalTime);
  if (index < 0) return null;
  const history = candles.slice(0, index + 1);
  const closes = history.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const close = closes[closes.length - 1];
  const trend =
    ema20 === null || ema50 === null || ema200 === null
      ? 'indefinida'
      : close > ema20 && ema20 > ema50 && ema50 > ema200
        ? 'alta'
        : close < ema20 && ema20 < ema50 && ema50 < ema200
          ? 'baixa'
          : 'lateral';
  const currentAtr = atr(history);
  const atrSeries: number[] = [];
  for (
    let cursor = Math.max(14, history.length - 200);
    cursor <= history.length;
    cursor += 1
  ) {
    const item = atr(history.slice(0, cursor));
    if (item !== null) atrSeries.push(item);
  }
  const rank =
    currentAtr === null ? null : percentileRank(atrSeries, currentAtr);
  const volatility =
    rank === null
      ? 'indefinida'
      : rank <= 25
        ? 'baixa'
        : rank <= 75
          ? 'normal'
          : rank <= 90
            ? 'alta'
            : 'extrema';
  const steps24h = Math.max(
    1,
    Math.round(86_400_000 / (TIMEFRAME_MS[timeframe] ?? 86_400_000)),
  );
  const prior = history[history.length - 1 - steps24h];
  return {
    trend,
    volatility,
    ema20,
    ema50,
    ema200,
    atrPct:
      currentAtr !== null && close > 0 ? (currentAtr / close) * 100 : null,
    atrPercentile: rank,
    return24h:
      prior && prior.close > 0
        ? (close / prior.close - 1) * 100
        : null,
  };
}

function replay(
  signal: SignalRow,
  candles: readonly DayTradeCandle[],
  config: ConfigRow,
  costMultiplier: number,
  delayCandles: number,
): number | null {
  const signalTime = new Date(signal.candle_open_time).getTime();
  const signalIndex = candles.findIndex(
    (candle) => candle.openTime === signalTime,
  );
  const entryIndex = signalIndex + 1 + delayCandles;
  const entryCandle = candles[entryIndex];
  if (signalIndex < 0 || !entryCandle || !entryCandle.isClosed) return null;

  const direction = signal.direcao === 'short' ? 'short' : 'long';
  const plannedRisk =
    direction === 'short'
      ? Number(signal.stop_referencia) - Number(signal.entrada_referencia)
      : Number(signal.entrada_referencia) - Number(signal.stop_referencia);
  if (!(plannedRisk > 0)) return null;

  const atrValue = value(signal.atr);
  if (
    atrValue !== null &&
    ((direction === 'long' &&
      entryCandle.open >
        Number(signal.entrada_referencia) +
          atrValue * Number(config.max_next_open_distance_atr)) ||
      (direction === 'short' &&
        entryCandle.open <
          Number(signal.entrada_referencia) -
            atrValue * Number(config.max_next_open_distance_atr)))
  ) {
    return null;
  }

  const slippage =
    (Number(config.slippage_pct) * costMultiplier) / 100;
  const fee = (Number(config.fee_rate_pct) * costMultiplier) / 100;
  const entry =
    direction === 'short'
      ? entryCandle.open * (1 - slippage)
      : entryCandle.open * (1 + slippage);
  const stop = Number(signal.stop_referencia);
  const risk = direction === 'short' ? stop - entry : entry - stop;
  if (!(risk > 0)) return null;
  const ratio =
    direction === 'short'
      ? (Number(signal.entrada_referencia) -
          Number(signal.alvo_referencia)) /
        plannedRisk
      : (Number(signal.alvo_referencia) -
          Number(signal.entrada_referencia)) /
        plannedRisk;
  const target =
    direction === 'short' ? entry - risk * ratio : entry + risk * ratio;

  for (let index = entryIndex; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle.isClosed) break;
    let rawExit: number | null = null;
    if (direction === 'long') {
      if (candle.open <= stop) rawExit = candle.open;
      else if (candle.open >= target) rawExit = target;
      else if (candle.low <= stop) rawExit = stop;
      else if (candle.high >= target) rawExit = target;
      if (rawExit !== null) {
        const exit = rawExit * (1 - slippage);
        return (exit - entry - entry * fee - exit * fee) / risk;
      }
    } else {
      if (candle.open >= stop) rawExit = candle.open;
      else if (candle.open <= target) rawExit = target;
      else if (candle.high >= stop) rawExit = stop;
      else if (candle.low <= target) rawExit = target;
      if (rawExit !== null) {
        const exit = rawExit * (1 + slippage);
        return (entry - exit - entry * fee - exit * fee) / risk;
      }
    }
  }
  return null;
}

async function validateConfig(
  supabase: SupabaseClient,
  config: ConfigRow,
  candleCache: Map<string, Promise<DayTradeCandle[]>>,
) {
  const runResult = await supabase
    .from('forward_test_validation_runs')
    .insert({
      config_id: config.id,
      status: 'executando',
      iteracoes_monte_carlo: ITERATIONS,
      seed: SEED,
      parametros: {
        version: 'validation-v2.0.0',
        iterations: ITERATIONS,
      },
    })
    .select('id')
    .maybeSingle();
  if (runResult.error || !runResult.data) {
    return {
      ok: false,
      config_id: config.id,
      error:
        runResult.error?.message ?? 'não foi possível abrir o run',
    };
  }
  const runId = (runResult.data as { id: string }).id;
  let failures = 0;
  try {
    const signalsResult = await supabase
      .from('forward_test_signals')
.select('*')
      .eq('config_id', config.id)
      .eq('status', 'fechado')
      .not('resultado_r', 'is', null)
      .order('candle_open_time', { ascending: true })
      .limit(2_000);
    if (signalsResult.error) throw new Error(signalsResult.error.message);
    const signals = (signalsResult.data ?? []) as SignalRow[];

    const keys = [
      ...new Set(
        signals.flatMap((signal) => [
          `${signal.simbolo}|${signal.timeframe}`,
          `BTCUSDT|${signal.timeframe}`,
        ]),
      ),
    ];
    await inBatches(keys, CONCURRENCY, async (pair) => {
      if (candleCache.has(pair)) return;
      const [symbol, timeframe] = pair.split('|');
      candleCache.set(
        pair,
        fetchCandles(
          symbol,
          timeframe as DayTradeIndicatorTimeframe,
        ),
      );
      try {
        await candleCache.get(pair);
      } catch {
        failures += 1;
      }
    });

    const contexts: Array<Record<string, unknown>> = [];
    for (const signal of signals) {
      const assetCandles =
        (await candleCache.get(`${signal.simbolo}|${signal.timeframe}`)?.catch(
          () => [],
        )) ?? [];
      const btcCandles =
        (await candleCache.get(`BTCUSDT|${signal.timeframe}`)?.catch(
          () => [],
        )) ?? [];
      const time = new Date(signal.candle_open_time).getTime();
      const assetContext = context(assetCandles, time, signal.timeframe);
      const btcContext = context(btcCandles, time, signal.timeframe);
      contexts.push({
        signal_id: signal.id,
        config_id: signal.config_id,
        simbolo: signal.simbolo,
        timeframe: signal.timeframe,
        estrategia: signal.estrategia,
        candle_open_time: signal.candle_open_time,
        signal_status: signal.status,
        resultado_r_base: signal.resultado_r,
        replay_r_1x: replay(signal, assetCandles, config, 1, 0),
        replay_r_1_5x: replay(signal, assetCandles, config, 1.5, 0),
        replay_r_2x: replay(signal, assetCandles, config, 2, 0),
        replay_r_3x: replay(signal, assetCandles, config, 3, 0),
        replay_r_atraso_1: replay(signal, assetCandles, config, 1, 1),
        replay_r_atraso_2: replay(signal, assetCandles, config, 1, 2),
        replay_status: {
          direction: signal.direcao ?? 'long',
          has_asset_history: assetCandles.length > 0,
          has_btc_history: btcCandles.length > 0,
        },
        tendencia_ativo: assetContext?.trend ?? 'indefinida',
        volatilidade_ativo:
          assetContext?.volatility ?? 'indefinida',
        tendencia_btc: btcContext?.trend ?? 'indefinida',
        volatilidade_btc:
          btcContext?.volatility ?? 'indefinida',
        atr_pct: assetContext?.atrPct ?? null,
        atr_percentil: assetContext?.atrPercentile ?? null,
        ema20: assetContext?.ema20 ?? null,
        ema50: assetContext?.ema50 ?? null,
        ema200: assetContext?.ema200 ?? null,
        btc_retorno_24h_pct: btcContext?.return24h ?? null,
        versao_enriquecimento: 'validation-v2.0.0',
        enriquecido_em: new Date().toISOString(),
      });
    }
    for (let index = 0; index < contexts.length; index += 100) {
      const upsert = await supabase
        .from('forward_test_signal_context')
        .upsert(contexts.slice(index, index + 100), {
          onConflict: 'signal_id',
        });
      if (upsert.error) throw new Error(upsert.error.message);
    }

    const contextResult = await supabase
      .from('forward_test_signal_context')
      .select(
        'signal_id,replay_r_1x,replay_r_1_5x,replay_r_2x,replay_r_3x,replay_r_atraso_1,replay_r_atraso_2,tendencia_ativo,volatilidade_ativo,tendencia_btc,volatilidade_btc',
      )
      .eq('config_id', config.id);
    if (contextResult.error) throw new Error(contextResult.error.message);
    const byId = new Map(
      ((contextResult.data ?? []) as ContextRow[]).map((row) => [
        row.signal_id,
        row,
      ]),
    );
    const trades: ValidationTrade[] = signals.map((signal) => {
      const row = byId.get(signal.id);
      return {
        id: signal.id,
        symbol: signal.simbolo,
        timeframe: signal.timeframe,
        strategy: signal.estrategia,
        openedAt: signal.candle_open_time,
        resultR: Number(signal.resultado_r),
        replayR1x: value(row?.replay_r_1x),
        replayR15x: value(row?.replay_r_1_5x),
        replayR2x: value(row?.replay_r_2x),
        replayR3x: value(row?.replay_r_3x),
        replayDelay1: value(row?.replay_r_atraso_1),
        replayDelay2: value(row?.replay_r_atraso_2),
        assetTrend: row?.tendencia_ativo,
        assetVolatility: row?.volatilidade_ativo,
        btcTrend: row?.tendencia_btc,
        btcVolatility: row?.volatilidade_btc,
      };
    });
    const report = buildValidationReport(trades, ITERATIONS, SEED);
    const integrityResult = await supabase
      .from('forward_test_integrity_summary')
      .select('*')
      .eq('config_id', config.id)
      .maybeSingle();
    if (integrityResult.error) failures += 1;
    const output = {
      ...report,
      version: 'validation-v2.0.0',
      config: {
        id: config.id,
        name: config.nome,
        version: config.versao,
      },
      integrity: integrityResult.data ?? null,
      coverage: {
        closedSignals: signals.length,
        enrichedSignals: contexts.length,
        candleFetchFailures: failures,
      },
    };
    const status =
      failures > 0 ? 'concluido_com_falhas' : 'concluido';
    const finish = await supabase
      .from('forward_test_validation_runs')
      .update({
        status,
        finalizado_em: new Date().toISOString(),
        operacoes_fechadas: signals.length,
        sinais_enriquecidos: contexts.length,
        resultado: output,
        erro:
          failures > 0 ? `${failures} falha(s) parcial(is)` : null,
      })
      .eq('id', runId);
    if (finish.error) throw new Error(finish.error.message);
    return { ok: true, config_id: config.id, run_id: runId, status, report: output };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    await supabase
      .from('forward_test_validation_runs')
      .update({
        status: 'falhou',
        finalizado_em: new Date().toISOString(),
        erro: message,
      })
      .eq('id', runId);
    return { ok: false, config_id: config.id, run_id: runId, error: message };
  }
}

export async function POST(request: Request) {
  if (
    !process.env.CRON_SECRET ||
    request.headers.get('x-cron-secret') !== process.env.CRON_SECRET
  ) {
    return json({ ok: false, error: 'não autorizado' }, 401);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return json({ ok: false, error: 'Supabase não configurado' }, 500);
  }
  const supabase: SupabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await supabase.rpc('abandon_stale_validation_news_runs');

  // Ver comentário equivalente em app/api/forward-test/route.ts: `coletar` é a
  // fonte autoritativa e a checagem anterior via `.some()` sobre o resultado de
  // `ativo=true` falhava silenciosamente quando nenhuma linha tinha `ativo=true`.
  let configs: ConfigRow[] = [];

  const collectingResult = await supabase
    .from('forward_test_config')
    .select('*')
    .eq('coletar', true)
    .order('congelado_em', { ascending: true });

  if (collectingResult.error) {
    const fallbackResult = await supabase
      .from('forward_test_config')
      .select('*')
      .eq('ativo', true)
      .order('congelado_em', { ascending: true });
    if (fallbackResult.error) {
      return json({ ok: false, error: fallbackResult.error.message }, 500);
    }
    configs = (fallbackResult.data ?? []) as ConfigRow[];
  } else {
    configs = (collectingResult.data ?? []) as ConfigRow[];
  }

  if (configs.length === 0) {
    return json({
      ok: true,
      noop: true,
      reason: 'nenhum protocolo com coletar=true; nada a validar',
      version: 'validation-v2.0.0',
      generatedAt: new Date().toISOString(),
      reports: [],
    });
  }
  const cache = new Map<string, Promise<DayTradeCandle[]>>();
  const reports = [];
  for (const config of configs) {
    reports.push(await validateConfig(supabase, config, cache));
  }
  return json({
    ok: reports.some((item) => item.ok),
    version: 'validation-v2.0.0',
    generatedAt: new Date().toISOString(),
    reports,
  });
}
