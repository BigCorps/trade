// ============================================================================
// VigIA Trade — Edge Function: avaliar-daytrade
// supabase/functions/avaliar-daytrade/index.ts
// ============================================================================
// Avalia o playbook educacional "Tendência com Rompimento" usando somente
// candles encerrados da Binance e, opcionalmente, salva/atualiza o setup em
// public.daytrade_setups.
//
// Segurança:
// - publique esta função com verify_jwt = true;
// - o usuário é obtido do JWT recebido;
// - a gravação usa o cliente autenticado e respeita as políticas RLS;
// - nenhuma chave Binance é necessária, pois os dados de mercado são públicos;
// - esta função NÃO cria nem executa ordens.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  getRequiredCandleCount,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
  type DayTradeIndicators,
} from './indicators.ts';

import {
  analyzeTrendBreakout,
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_BREAKOUT_STRATEGY_VERSION,
  type TrendBreakoutOptions,
} from './strategies/trendBreakout.ts';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface EvaluateRequestBody {
  symbol?: unknown;
  timeframe?: unknown;
  live_price?: unknown;
  persist?: unknown;
  strategy_options?: unknown;
}

interface BinanceKline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

interface MarketDataResult {
  closedCandles: DayTradeCandle[];
  livePrice: number;
  baseUrl: string;
}

interface ErrorPayload {
  error: string;
  code?: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ALLOWED_TIMEFRAMES = new Set<DayTradeIndicatorTimeframe>([
  '5m',
  '15m',
  '30m',
  '1h',
]);

const BINANCE_PUBLIC_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const MAX_BODY_BYTES = 16_384;
const FETCH_TIMEOUT_MS = 9_000;
const EXTRA_CANDLES = 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// Respostas HTTP
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(
  status: number,
  error: string,
  code?: string,
  details?: unknown,
): Response {
  const payload: ErrorPayload = { error };
  if (code) payload.code = code;
  if (details !== undefined) payload.details = details;
  return jsonResponse(payload, status);
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

function parseSymbol(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('symbol deve ser uma string.');
  }

  const symbol = value.trim().toUpperCase();

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    throw new Error('symbol possui formato inválido.');
  }

  if (!symbol.endsWith('USDT')) {
    throw new Error('Nesta etapa, o Day Trade aceita somente pares em USDT.');
  }

  return symbol;
}

function parseTimeframe(value: unknown): DayTradeIndicatorTimeframe {
  if (typeof value !== 'string' || !ALLOWED_TIMEFRAMES.has(
    value as DayTradeIndicatorTimeframe,
  )) {
    throw new Error('timeframe deve ser 5m, 15m, 30m ou 1h.');
  }

  return value as DayTradeIndicatorTimeframe;
}

function parseOptionalPositiveNumber(
  value: unknown,
  name: string,
): number | null {
  if (value === undefined || value === null || value === '') return null;

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} deve ser um número maior que zero.`);
  }

  return parsed;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error('persist deve ser verdadeiro ou falso.');
  }
  return value;
}

function parseBoundedPositiveOption(
  source: Record<string, unknown>,
  key: keyof TrendBreakoutOptions,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = source[key as string];
  if (raw === undefined) return undefined;

  const value = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `strategy_options.${String(key)} deve estar entre ${minimum} e ${maximum}.`,
    );
  }

  return value;
}

function parseStrategyOptions(value: unknown): TrendBreakoutOptions | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('strategy_options deve ser um objeto.');
  }

  const source = value as Record<string, unknown>;
  const allowed = new Set([
    'minimumRelativeVolume',
    'atrStopMultiple',
    'minimumRiskRewardRatio',
    'observationDistanceAtr',
    'maximumLateEntryDistanceAtr',
    'minimumStopDistanceAtr',
    'maximumStopDistanceAtr',
  ]);

  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new Error(`strategy_options.${key} não é suportado.`);
    }
  }

  const parsed: TrendBreakoutOptions = {
    minimumRelativeVolume: parseBoundedPositiveOption(
      source,
      'minimumRelativeVolume',
      0.5,
      10,
    ),
    atrStopMultiple: parseBoundedPositiveOption(
      source,
      'atrStopMultiple',
      0.25,
      10,
    ),
    minimumRiskRewardRatio: parseBoundedPositiveOption(
      source,
      'minimumRiskRewardRatio',
      1,
      10,
    ),
    observationDistanceAtr: parseBoundedPositiveOption(
      source,
      'observationDistanceAtr',
      0,
      10,
    ),
    maximumLateEntryDistanceAtr: parseBoundedPositiveOption(
      source,
      'maximumLateEntryDistanceAtr',
      0,
      10,
    ),
    minimumStopDistanceAtr: parseBoundedPositiveOption(
      source,
      'minimumStopDistanceAtr',
      0.1,
      10,
    ),
    maximumStopDistanceAtr: parseBoundedPositiveOption(
      source,
      'maximumStopDistanceAtr',
      0.2,
      20,
    ),
  };

  return Object.fromEntries(
    Object.entries(parsed).filter(([, option]) => option !== undefined),
  ) as TrendBreakoutOptions;
}

async function readJsonBody(req: Request): Promise<EvaluateRequestBody> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);

  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error('Corpo da requisição excede o limite permitido.');
  }

  const raw = await req.text();

  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error('Corpo da requisição excede o limite permitido.');
  }

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw) as EvaluateRequestBody;
  } catch {
    throw new Error('JSON inválido.');
  }
}

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------

function parseKline(row: unknown): BinanceKline {
  if (!Array.isArray(row) || row.length < 8) {
    throw new Error('A Binance retornou um candle em formato inesperado.');
  }

  const candle: BinanceKline = {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
  };

  const values = Object.values(candle);
  if (values.some((item) => !Number.isFinite(item))) {
    throw new Error('A Binance retornou valores numéricos inválidos.');
  }

  return candle;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMarketData(
  symbol: string,
  timeframe: DayTradeIndicatorTimeframe,
  limit: number,
): Promise<MarketDataResult> {
  const failures: string[] = [];

  for (const baseUrl of BINANCE_PUBLIC_BASE_URLS) {
    const url = new URL('/api/v3/klines', baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', timeframe);
    url.searchParams.set('limit', String(limit));

    try {
      const response = await fetchWithTimeout(url.toString());

      if (!response.ok) {
        const body = (await response.text()).slice(0, 300);
        failures.push(`${baseUrl}: HTTP ${response.status} ${body}`);

        if (response.status === 429 || response.status === 418) {
          const retryAfter = Number(response.headers.get('retry-after') ?? 1);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2_000, Math.max(250, retryAfter * 1_000)))
          );
        }

        continue;
      }

      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        failures.push(`${baseUrl}: resposta vazia`);
        continue;
      }

      const parsed = rows.map(parseKline);
      const now = Date.now();
      const closedCandles: DayTradeCandle[] = parsed
        .filter((candle) => candle.closeTime < now)
        .map((candle) => ({
          ...candle,
          isClosed: true,
        }));

      if (closedCandles.length < 2) {
        failures.push(`${baseUrl}: candles encerrados insuficientes`);
        continue;
      }

      const latestMarketCandle = parsed[parsed.length - 1];
      const livePrice = latestMarketCandle.close;

      return { closedCandles, livePrice, baseUrl };
    } catch (error) {
      failures.push(
        `${baseUrl}: ${
          error instanceof Error ? error.message : 'falha desconhecida'
        }`,
      );
    }
  }

  throw new Error(
    `Não foi possível consultar os candles da Binance. ${failures.join(' | ')}`,
  );
}

// ---------------------------------------------------------------------------
// Serialização segura para o banco
// ---------------------------------------------------------------------------

function indicatorSnapshot(indicators: DayTradeIndicators) {
  return {
    strategy_version: TREND_BREAKOUT_STRATEGY_VERSION,
    candle_count: indicators.candleCount,
    required_candles: indicators.requiredCandles,
    ready: indicators.ready,
    missing_candles: indicators.missingCandles,
    current_price: indicators.currentPrice,
    previous_close: indicators.previousClose,
    last_candle_return_pct: indicators.lastCandleReturnPct,
    current_candle_range_pct: indicators.currentCandleRangePct,
    ema_fast: indicators.emaFast,
    ema_medium: indicators.emaMedium,
    ema_slow: indicators.emaSlow,
    atr: indicators.atr,
    atr_pct: indicators.atrPct,
    breakout_level: indicators.breakoutLevel,
    support_level: indicators.supportLevel,
    distance_to_breakout_pct: indicators.distanceToBreakoutPct,
    distance_from_support_pct: indicators.distanceFromSupportPct,
    distance_from_slow_ema_pct: indicators.distanceFromSlowEmaPct,
    current_volume: indicators.currentVolume,
    current_quote_volume: indicators.currentQuoteVolume,
    average_volume: indicators.averageVolume,
    average_quote_volume: indicators.averageQuoteVolume,
    relative_volume: indicators.relativeVolume,
    annualized_volatility_pct: indicators.annualizedVolatilityPct,
    volatility_regime: indicators.volatilityRegime,
    volatility_percentile: indicators.volatilityPercentile,
    period_high: indicators.periodHigh,
    period_low: indicators.periodLow,
    amplitude_pct: indicators.amplitudePct,
    max_drawdown_pct: indicators.maxDrawdownPct,
    current_drawdown_pct: indicators.currentDrawdownPct,
    time_in_drawdown_pct: indicators.timeInDrawdownPct,
    comparisons: indicators.comparisons,
    options: indicators.options,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return errorResponse(405, 'Método não permitido.', 'METHOD_NOT_ALLOWED', {
      allowed: ['POST', 'OPTIONS'],
    });
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return errorResponse(401, 'Usuário não autenticado.', 'UNAUTHORIZED');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('SUPABASE_URL ou SUPABASE_ANON_KEY ausente.');
    return errorResponse(
      500,
      'Configuração interna indisponível.',
      'SERVER_CONFIG_ERROR',
    );
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: authorization },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return errorResponse(401, 'Sessão inválida ou expirada.', 'INVALID_SESSION');
  }

  try {
    const body = await readJsonBody(req);
    const symbol = parseSymbol(body.symbol);
    const timeframe = parseTimeframe(body.timeframe);
    const suppliedLivePrice = parseOptionalPositiveNumber(
      body.live_price,
      'live_price',
    );
    const persist = parseBoolean(body.persist, true);
    const strategyOptions = parseStrategyOptions(body.strategy_options);

    const indicatorOptions =
      DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe];
    const requiredCandles = getRequiredCandleCount(indicatorOptions);
    const requestedLimit = Math.min(1_000, requiredCandles + EXTRA_CANDLES + 1);

    const market = await fetchMarketData(
      symbol,
      timeframe,
      requestedLimit,
    );

    if (market.closedCandles.length < requiredCandles) {
      return errorResponse(
        422,
        'A Binance não retornou candles encerrados suficientes para calcular todos os indicadores.',
        'INSUFFICIENT_CANDLES',
        {
          received: market.closedCandles.length,
          required: requiredCandles,
        },
      );
    }

    const livePrice = suppliedLivePrice ?? market.livePrice;

    const { indicators, evaluation } = analyzeTrendBreakout({
      candles: market.closedCandles,
      indicatorOptions,
      livePrice,
      strategyOptions,
    });

    const snapshot = indicatorSnapshot(indicators);
    let savedSetup: Record<string, unknown> | null = null;

    if (persist) {
      const plan = evaluation.plan;
      const row = {
        user_id: user.id,
        symbol,
        timeframe,
        strategy: TREND_BREAKOUT_STRATEGY_ID,
        status: evaluation.status,
        score: evaluation.passedConditions,
        total_conditions: evaluation.totalConditions,
        conditions: evaluation.conditions,
        indicators: snapshot,
        warnings: evaluation.warnings,
        next_trigger: evaluation.nextTrigger,
        entry_reference: plan?.entryReference ?? null,
        stop_reference: plan?.stopReference ?? null,
        target_reference: plan?.targetReference ?? null,
        risk_reward_ratio: plan?.riskRewardRatio ?? null,
        last_closed_price: evaluation.evaluatedPrice,
        last_live_price: evaluation.livePrice,
        candle_open_time: new Date(
          evaluation.candleOpenTime,
        ).toISOString(),
        candle_close_time: new Date(
          evaluation.candleCloseTime,
        ).toISOString(),
      };

      const { data, error } = await supabase
        .from('daytrade_setups')
        .upsert(row, {
          onConflict:
            'user_id,symbol,timeframe,strategy,candle_open_time',
        })
        .select(
          'id,symbol,timeframe,strategy,status,score,total_conditions,candle_open_time,candle_close_time,criado_em,atualizado_em',
        )
        .single();

      if (error) {
        console.error('Falha ao salvar daytrade_setup:', error);
        return errorResponse(
          500,
          'A análise foi calculada, mas não pôde ser salva.',
          'SETUP_PERSIST_ERROR',
          { message: error.message },
        );
      }

      savedSetup = data as Record<string, unknown>;
    }

    return jsonResponse({
      ok: true,
      persisted: persist,
      setup: savedSetup,
      request: {
        symbol,
        timeframe,
        supplied_live_price: suppliedLivePrice,
      },
      market: {
        source: market.baseUrl,
        closed_candles: market.closedCandles.length,
        required_candles: requiredCandles,
        last_closed_candle_at: new Date(
          evaluation.candleCloseTime,
        ).toISOString(),
        live_price: livePrice,
      },
      indicators: snapshot,
      evaluation,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido.';
    console.error('avaliar-daytrade:', error);

    const isInputError = [
      'symbol',
      'timeframe',
      'live_price',
      'persist',
      'strategy_options',
      'JSON',
      'Corpo',
      'Day Trade aceita',
    ].some((prefix) => message.includes(prefix));

    return errorResponse(
      isInputError ? 400 : 502,
      message,
      isInputError ? 'INVALID_INPUT' : 'MARKET_DATA_ERROR',
    );
  }
});
