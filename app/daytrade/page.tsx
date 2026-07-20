'use client';

/**
 * app/daytrade/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Painel intradiário independente da análise principal.
 *
 * Recursos:
 * - Timeframes de 5m, 15m, 30m e 1h.
 * - Períodos curtos adequados a day trade.
 * - Aquecimento da janela de volatilidade sem criar trecho vazio no gráfico.
 * - Métricas calculadas somente com candles encerrados.
 * - Preço e candle em formação acompanhados por WebSocket da Binance.
 * - Performance, volatilidade anualizada e volume financeiro.
 * - Retorno, drawdown, amplitude, correlação e extremos intradiários.
 * - Relatório explicativo com IA, fallback local e sem recomendação.
 * - Histórico separado no localStorage, sem misturar com análises de longo prazo.
 * - Playbook educacional de tendência com rompimento, checklist e semáforo.
 * - Plano de entrada, invalidação, alvo e calculadora de tamanho da posição.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getSupabase } from '../../lib/supabaseClient';
import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  getRequiredCandleCount,
  type DayTradeIndicators,
} from '../../lib/daytrade/indicators';
import {
  analyzeTrendBreakout,
  TREND_BREAKOUT_STATUS_LABELS,
  type TrendBreakoutEvaluation,
  type TrendBreakoutStatus,
} from '../../lib/daytrade/strategies/trendBreakout';
import {
  calculatePositionSizeFromPlan,
  calculateRiskReward,
  type PositionSizingResult,
} from '../../lib/daytrade/risk';
import type {
  TrendBreakoutBacktestResult,
  TrendBreakoutBacktestTrade,
} from '../../lib/daytrade/backtest';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

interface PeriodOption {
  label: string;
  durationMs: number;
}

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const TIMEFRAMES = {
  '5m': {
    label: '5 minutos',
    shortLabel: '5m',
    intervalMs: 5 * 60 * 1_000,
    periodsPerYear: 12 * 24 * 365,
    volWindow: 288,
    volWindowLabel: 'janela móvel de 24h',
    periods: [
      { label: '6 horas', durationMs: 6 * HOUR },
      { label: '12 horas', durationMs: 12 * HOUR },
      { label: '24 horas', durationMs: DAY },
      { label: '3 dias', durationMs: 3 * DAY },
    ] as PeriodOption[],
  },
  '15m': {
    label: '15 minutos',
    shortLabel: '15m',
    intervalMs: 15 * 60 * 1_000,
    periodsPerYear: 4 * 24 * 365,
    volWindow: 96,
    volWindowLabel: 'janela móvel de 24h',
    periods: [
      { label: '12 horas', durationMs: 12 * HOUR },
      { label: '24 horas', durationMs: DAY },
      { label: '3 dias', durationMs: 3 * DAY },
      { label: '7 dias', durationMs: 7 * DAY },
    ] as PeriodOption[],
  },
  '30m': {
    label: '30 minutos',
    shortLabel: '30m',
    intervalMs: 30 * 60 * 1_000,
    periodsPerYear: 2 * 24 * 365,
    volWindow: 48,
    volWindowLabel: 'janela móvel de 24h',
    periods: [
      { label: '24 horas', durationMs: DAY },
      { label: '3 dias', durationMs: 3 * DAY },
      { label: '7 dias', durationMs: 7 * DAY },
      { label: '14 dias', durationMs: 14 * DAY },
    ] as PeriodOption[],
  },
  '1h': {
    label: '1 hora',
    shortLabel: '1h',
    intervalMs: HOUR,
    periodsPerYear: 24 * 365,
    volWindow: 24,
    volWindowLabel: 'janela móvel de 24h',
    periods: [
      { label: '3 dias', durationMs: 3 * DAY },
      { label: '7 dias', durationMs: 7 * DAY },
      { label: '14 dias', durationMs: 14 * DAY },
      { label: '30 dias', durationMs: 30 * DAY },
    ] as PeriodOption[],
  },
} as const;

type Timeframe = keyof typeof TIMEFRAMES;
type Regime = 'calmo' | 'normal' | 'volátil' | 'extremo';
type LoadStatus = 'idle' | 'loading' | 'done' | 'error';
type WebSocketStatus = 'desconectado' | 'conectando' | 'ao vivo' | 'reconectando';

const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'nenhum',
];

const MIN_VISIBLE_CANDLES = 20;
const HISTORY_KEY = 'vigia_daytrade_history_v1';
const HISTORY_LIMIT = 20;

const JOURNAL_LIMIT = 30;
const BACKTEST_DEFAULT_CANDLES = 750;

type RemoteActionStatus = 'idle' | 'loading' | 'success' | 'error' | 'fallback';
type DayTradeAlertableStatus =
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

interface LiveCandle extends Candle {
  symbol: string;
  isClosed: boolean;
}

interface IntradayStats {
  symbol: string;
  candleCount: number;
  lastPrice: number;
  returnPct: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  timeInDrawdownPct: number;
  annualVolPct: number;
  currentVolPct: number;
  sharpe: number;
  pctPositive: number;
  regime: Regime;
  bestCandlePct: number;
  worstCandlePct: number;
  periodHigh: number;
  periodLow: number;
  amplitudePct: number;
  averageQuoteVolume: number;
  lastQuoteVolume: number;
}

interface HistoryRecord {
  id: string;
  createdAt: string;
  symbolA: string;
  symbolB: string;
  timeframe: Timeframe;
  periodLabel: string;
  returnA: number;
  returnB: number | null;
  correlation: number | null;
  report?: string;
}

interface RunOverride {
  symbolA: string;
  symbolB: string;
  timeframe: Timeframe;
  periodLabel: string;
}


interface RemoteActionState {
  status: RemoteActionStatus;
  message: string;
}

interface ServerSetupRecord {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  strategy: string;
  status: TrendBreakoutStatus;
  score: number;
  total_conditions: number;
  candle_open_time: string;
  candle_close_time: string;
  criado_em?: string;
  atualizado_em?: string;
}

interface TestnetSizingPreview {
  quoteAmountUsdt?: number;
  estimatedQuantity?: number;
  estimatedTotalRiskUsdt?: number;
  estimatedTotalRiskPct?: number;
  grossRiskRewardRatio?: number;
  stopDistancePct?: number;
  targetDistancePct?: number;
  warnings?: string[];
  [key: string]: unknown;
}

interface TestnetPreviewPayload {
  setup: {
    id: string;
    symbol: string;
    timeframe: Timeframe;
    strategy: string;
    status: string;
    candle_close_time: string;
    expires_at: string;
    age_ms: number;
  };
  plan: {
    entry_reference: number;
    stop_reference: number;
    target_reference: number;
    saved_risk_reward_ratio: number;
    stop_pct: number;
    target_pct: number;
    gross_risk_reward_ratio: number;
    atr: number;
    breakout_level: number;
    latest_acceptable_entry: number;
  };
  market: {
    public_price: number;
    public_source: string;
    testnet_price: number;
  };
  account: {
    environment: 'testnet';
    total_usdt: number;
    free_usdt: number;
    locked_usdt: number;
    max_order_usdt: number;
  };
  sizing: TestnetSizingPreview;
  execution: {
    mode: 'testnet';
    request_id: string;
    quote_amount: number;
    stop_pct: number;
    target_pct: number;
    requires_confirmation: boolean;
  };
}

interface TestnetPreviewResponse {
  ok: boolean;
  action: 'preview';
  executable: boolean;
  preview: TestnetPreviewPayload;
}

interface DayTradeJournalRecord {
  id: string;
  setup_id: string | null;
  order_id: string | null;
  mode: 'observacao' | 'testnet' | 'real';
  status: string;
  symbol: string;
  timeframe: Timeframe;
  strategy: string;
  entry_reference: number | string;
  stop_reference: number | string;
  target_reference: number | string;
  risk_reward_ratio: number | string;
  planned_quantity: number | string | null;
  planned_notional: number | string | null;
  risk_usdt: number | string | null;
  risk_percent: number | string | null;
  entry_price: number | string | null;
  exit_price: number | string | null;
  quantity: number | string | null;
  fees_usdt: number | string;
  pnl_usdt: number | string | null;
  result_r: number | string | null;
  notes: string | null;
  aberto_em: string | null;
  fechado_em: string | null;
  criado_em: string;
  atualizado_em: string;
}

interface DayTradeAlertRuleRecord {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  strategy: string;
  notify_statuses: DayTradeAlertableStatus[];
  canal: 'email';
  ativo: boolean;
  cooldown_minutes: number;
  last_status: TrendBreakoutStatus | null;
  last_candle_open_time: string | null;
  last_triggered_at: string | null;
  criado_em: string;
  atualizado_em: string;
}

interface BacktestApiResponse {
  ok: boolean;
  symbol: string;
  timeframe: Timeframe;
  requested_candles: number;
  execution_ms: number;
  generated_at: string;
  result: TrendBreakoutBacktestResult;
}

// ---------------------------------------------------------------------------
// Visual
// ---------------------------------------------------------------------------

const S = {
  bg: '#101418',
  panel: '#181f26',
  panelSoft: '#141a20',
  border: '#2a343f',
  text: '#d7dee6',
  dim: '#7d8a97',
  a: '#e8a13c',
  b: '#4f8fd0',
  green: '#3fb26f',
  red: '#d05555',
  yellow: '#d6b35b',
  regime: {
    calmo: '#4f8fd0',
    normal: '#3fb26f',
    'volátil': '#e8a13c',
    extremo: '#d05555',
  } as Record<Regime, string>,
};

const SETUP_STATUS_COLORS: Record<TrendBreakoutStatus, string> = {
  dados_insuficientes: S.dim,
  aguardar: S.yellow,
  observar: S.b,
  condicoes_atendidas: S.green,
  entrada_atrasada: S.a,
  invalidado: S.red,
};

const SETUP_STATUS_ICONS: Record<TrendBreakoutStatus, string> = {
  dados_insuficientes: '○',
  aguardar: '●',
  observar: '◉',
  condicoes_atendidas: '✓',
  entrada_atrasada: '!',
  invalidado: '×',
};

const fmt = (value: number, digits = 2) =>
  value.toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const fmtPct = (value: number, digits = 2) =>
  `${value >= 0 ? '+' : ''}${fmt(value, digits)}%`;

const fmtPrice = (value: number) => {
  if (value >= 1_000) return fmt(value, 2);
  if (value >= 1) return fmt(value, 4);
  return fmt(value, 6);
};

const fmtCompactUsdt = (value: number) =>
  new Intl.NumberFormat('pt-BR', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const parseUserNumber = (value: string): number =>
  Number(value.trim().replace(',', '.'));

const formatConditionValue = (value: number | string | null): string => {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  return fmt(value, Math.abs(value) >= 100 ? 2 : 3);
};

function Card({
  children,
  style,
  title,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <section
      title={title}
      style={{
        background: S.panel,
        border: `1px solid ${S.border}`,
        borderRadius: 10,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function RegimeBadge({ regime }: { regime: Regime }) {
  return (
    <span
      style={{
        background: `${S.regime[regime]}22`,
        color: S.regime[regime],
        border: `1px solid ${S.regime[regime]}55`,
        borderRadius: 20,
        padding: '2px 10px',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        whiteSpace: 'nowrap',
      }}
    >
      {regime}
    </span>
  );
}

function SetupStatusBadge({ status }: { status: TrendBreakoutStatus }) {
  const color = SETUP_STATUS_COLORS[status];
  const item = TREND_BREAKOUT_STATUS_LABELS[status];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        background: `${color}1f`,
        color,
        border: `1px solid ${color}66`,
        borderRadius: 999,
        padding: '7px 14px',
        fontSize: 13,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
      }}
    >
      <span aria-hidden="true">{SETUP_STATUS_ICONS[status]}</span>
      {item.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Binance e cálculos
// ---------------------------------------------------------------------------

async function fetchKlines(
  symbol: string,
  timeframe: Timeframe,
  visibleDurationMs: number,
  onProgress: (message: string) => void,
): Promise<Candle[]> {
  const config = TIMEFRAMES[timeframe];
  const requestedEnd = Date.now();
  const visibleStart = requestedEnd - visibleDurationMs;

  // A janela anterior serve exclusivamente para calcular a volatilidade desde
  // o primeiro ponto visível. Esses candles não entram nas demais métricas.
  const indicatorOptions = DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe];
  const requiredIndicatorCandles = getRequiredCandleCount(indicatorOptions);
  const warmupCandles = Math.max(
    config.volWindow + 4,
    requiredIndicatorCandles + 4,
  );
  const warmupMs = warmupCandles * config.intervalMs;
  const requestedStart = visibleStart - warmupMs;
  const candlesByTime = new Map<number, Candle>();

  let cursor = requestedStart;
  let pages = 0;

  while (cursor < requestedEnd && pages < 20) {
    const params = new URLSearchParams({
      symbol,
      interval: timeframe,
      startTime: String(cursor),
      endTime: String(requestedEnd),
      limit: '1000',
    });

    const response = await fetch(
      `https://api.binance.com/api/v3/klines?${params.toString()}`,
      { cache: 'no-store' },
    );

    if (!response.ok) {
      throw new Error(`Binance respondeu ${response.status} para ${symbol}.`);
    }

    const batch: (string | number)[][] = await response.json();
    if (!batch.length) break;

    for (const item of batch) {
      const openTime = Number(item[0]);
      const closeTime = Number(item[6]);

      // Somente candles encerrados entram nas métricas oficiais.
      if (closeTime > requestedEnd) continue;

      candlesByTime.set(openTime, {
        openTime,
        closeTime,
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        volume: Number(item[5]),
        quoteVolume: Number(item[7]),
      });
    }

    pages += 1;
    onProgress(`${symbol}: ${candlesByTime.size} candles encerrados...`);

    const lastOpenTime = Number(batch[batch.length - 1][0]);
    const nextCursor = lastOpenTime + 1;
    if (nextCursor <= cursor || batch.length < 1000) break;
    cursor = nextCursor;
  }

  return [...candlesByTime.values()]
    .filter((candle) => candle.openTime >= requestedStart)
    .sort((left, right) => left.openTime - right.openTime);
}

function logReturns(candles: Candle[]): number[] {
  const output: number[] = [];

  for (let index = 1; index < candles.length; index++) {
    const previous = candles[index - 1].close;
    const current = candles[index].close;

    if (previous > 0 && current > 0) {
      output.push(Math.log(current / previous));
    }
  }

  return output;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  ) / (values.length - 1);

  return Math.sqrt(Math.max(0, variance));
}

function rollingVol(
  returns: number[],
  window: number,
  periodsPerYear: number,
): (number | null)[] {
  const output: (number | null)[] = new Array(returns.length + 1).fill(null);
  const annualize = Math.sqrt(periodsPerYear);
  let sum = 0;
  let sumSq = 0;

  for (let index = 0; index < returns.length; index++) {
    sum += returns[index];
    sumSq += returns[index] ** 2;

    if (index >= window) {
      sum -= returns[index - window];
      sumSq -= returns[index - window] ** 2;
    }

    if (index >= window - 1) {
      const average = sum / window;
      const variance = Math.max(0, sumSq / window - average ** 2);
      output[index + 1] = Math.sqrt(variance) * annualize * 100;
    }
  }

  return output;
}

function classifyRegime(values: number[], current: number | null): Regime {
  if (current === null || values.length < 4) return 'normal';
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];

  if (current <= quantile(0.25)) return 'calmo';
  if (current <= quantile(0.75)) return 'normal';
  if (current <= quantile(0.95)) return 'volátil';
  return 'extremo';
}

function correlation(a: Candle[], b: Candle[]): number | null {
  const mapB = new Map(b.map((candle) => [candle.openTime, candle]));
  const pairs = a.flatMap((candleA) => {
    const candleB = mapB.get(candleA.openTime);
    return candleB ? [{ a: candleA, b: candleB }] : [];
  });

  if (pairs.length < MIN_VISIBLE_CANDLES + 1) return null;

  const returnsA: number[] = [];
  const returnsB: number[] = [];

  for (let index = 1; index < pairs.length; index++) {
    const previous = pairs[index - 1];
    const current = pairs[index];

    if (
      previous.a.close > 0 &&
      previous.b.close > 0 &&
      current.a.close > 0 &&
      current.b.close > 0
    ) {
      returnsA.push(Math.log(current.a.close / previous.a.close));
      returnsB.push(Math.log(current.b.close / previous.b.close));
    }
  }

  if (returnsA.length < MIN_VISIBLE_CANDLES) return null;

  const averageA = mean(returnsA);
  const averageB = mean(returnsB);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;

  for (let index = 0; index < returnsA.length; index++) {
    const deltaA = returnsA[index] - averageA;
    const deltaB = returnsB[index] - averageB;
    covariance += deltaA * deltaB;
    varianceA += deltaA ** 2;
    varianceB += deltaB ** 2;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? covariance / denominator : null;
}

function computeStats(
  symbol: string,
  visibleCandles: Candle[],
  rawCandles: Candle[],
  volatility: (number | null)[],
  timeframe: Timeframe,
): IntradayStats {
  const config = TIMEFRAMES[timeframe];
  const first = visibleCandles[0];
  const last = visibleCandles[visibleCandles.length - 1];
  const visibleTimes = new Set(visibleCandles.map((candle) => candle.openTime));
  const volatilityByTime = new Map(
    rawCandles.map((candle, index) => [candle.openTime, volatility[index]]),
  );

  const visibleVolatility = rawCandles
    .filter((candle) => visibleTimes.has(candle.openTime))
    .map((candle) => volatilityByTime.get(candle.openTime) ?? null)
    .filter((value): value is number => value !== null);

  let peak = -Infinity;
  let maxDrawdown = 0;
  let belowPeak = 0;

  for (const candle of visibleCandles) {
    peak = Math.max(peak, candle.close);
    const drawdown = (candle.close - peak) / peak;
    maxDrawdown = Math.min(maxDrawdown, drawdown);
    if (drawdown < 0) belowPeak += 1;
  }

  const returns = logReturns(visibleCandles);
  const simpleReturns = visibleCandles.slice(1).map((candle, index) =>
    (candle.close / visibleCandles[index].close - 1) * 100,
  );
  const positiveCount = returns.filter((value) => value > 0).length;
  const periodMean = mean(returns);
  const periodStd = sampleStandardDeviation(returns);
  const currentVolatility = visibleVolatility[visibleVolatility.length - 1] ?? 0;

  const periodHigh = Math.max(...visibleCandles.map((candle) => candle.high));
  const periodLow = Math.min(...visibleCandles.map((candle) => candle.low));
  const averageQuoteVolume = mean(
    visibleCandles.map((candle) => candle.quoteVolume),
  );

  return {
    symbol,
    candleCount: visibleCandles.length,
    lastPrice: last.close,
    returnPct: (last.close / first.close - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    currentDrawdownPct: ((last.close - peak) / peak) * 100,
    timeInDrawdownPct: (belowPeak / visibleCandles.length) * 100,
    annualVolPct: mean(visibleVolatility),
    currentVolPct: currentVolatility,
    sharpe: periodStd > 0
      ? (periodMean / periodStd) * Math.sqrt(config.periodsPerYear)
      : 0,
    pctPositive: returns.length ? (positiveCount / returns.length) * 100 : 0,
    regime: classifyRegime(visibleVolatility, currentVolatility),
    bestCandlePct: simpleReturns.length ? Math.max(...simpleReturns) : 0,
    worstCandlePct: simpleReturns.length ? Math.min(...simpleReturns) : 0,
    periodHigh,
    periodLow,
    amplitudePct: periodLow > 0 ? (periodHigh / periodLow - 1) * 100 : 0,
    averageQuoteVolume,
    lastQuoteVolume: last.quoteVolume,
  };
}

function upsertClosedCandle(
  current: Candle[],
  candle: Candle,
  minimumOpenTime: number,
): Candle[] {
  const byTime = new Map(current.map((item) => [item.openTime, item]));
  byTime.set(candle.openTime, candle);

  return [...byTime.values()]
    .filter((item) => item.openTime >= minimumOpenTime)
    .sort((left, right) => left.openTime - right.openTime);
}

function chartLabel(timestamp: number, durationMs: number): string {
  const date = new Date(timestamp);

  if (durationMs <= DAY) {
    return date.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  if (durationMs <= 7 * DAY) {
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
  });
}

function correlationText(value: number | null): string {
  if (value === null) return 'amostra insuficiente';
  const absolute = Math.abs(value);
  if (absolute >= 0.7) return value >= 0 ? 'alta positiva' : 'alta inversa';
  if (absolute >= 0.4) return value >= 0 ? 'moderada positiva' : 'moderada inversa';
  return 'baixa';
}

function buildReport(
  statsA: IntradayStats,
  statsB: IntradayStats | null,
  correlationValue: number | null,
  periodLabel: string,
  timeframe: Timeframe,
): string {
  const config = TIMEFRAMES[timeframe];
  const intro =
    `No período intradiário de ${periodLabel}, usando candles de ${config.label}, ` +
    `${statsA.symbol} apresentou retorno de ${fmtPct(statsA.returnPct)}, ` +
    `volatilidade atual anualizada de ${fmt(statsA.currentVolPct, 1)}% e regime ` +
    `${statsA.regime}, classificação que compara a volatilidade atual com a ` +
    `distribuição histórica do próprio ativo dentro da amostra.`;

  const riskA =
    `Em ${statsA.symbol}, o drawdown máximo foi de ${fmtPct(statsA.maxDrawdownPct)}, ` +
    `o drawdown atual foi de ${fmtPct(statsA.currentDrawdownPct)} e o preço permaneceu ` +
    `abaixo de um topo anterior em ${fmt(statsA.timeInDrawdownPct, 0)}% dos candles. ` +
    `A máxima do período foi ${fmtPrice(statsA.periodHigh)} USDT, a mínima foi ` +
    `${fmtPrice(statsA.periodLow)} USDT e a amplitude entre elas foi de ` +
    `${fmt(statsA.amplitudePct, 2)}%.`;

  if (!statsB) {
    return [
      intro,
      riskA,
      `Em palavras simples: os números descrevem como ${statsA.symbol} oscilou no ` +
        `intervalo selecionado. A volatilidade mede a intensidade das oscilações, ` +
        `enquanto o drawdown mede quanto o preço ficou abaixo de um topo anterior. ` +
        `Essas métricas descrevem o passado recente e não indicam a direção do próximo candle.`,
      'Este relatório é descritivo e não constitui recomendação de investimento.',
    ].join('\n\n');
  }

  const comparison =
    `${statsB.symbol} apresentou retorno de ${fmtPct(statsB.returnPct)}, volatilidade ` +
    `atual anualizada de ${fmt(statsB.currentVolPct, 1)}%, drawdown máximo de ` +
    `${fmtPct(statsB.maxDrawdownPct)} e drawdown atual de ` +
    `${fmtPct(statsB.currentDrawdownPct)}. O Sharpe anualizado da amostra foi ` +
    `${fmt(statsA.sharpe)} para ${statsA.symbol} e ${fmt(statsB.sharpe)} para ` +
    `${statsB.symbol}; essa métrica compara retorno médio com volatilidade e não ` +
    `representa sozinha todo o risco de um ativo. Em janelas intradiárias curtas, a anualização pode produzir valores extremos e deve ser interpretada com cautela.`;

  const correlationParagraph = correlationValue === null
    ? 'A correlação não foi calculada porque não havia retornos alinhados suficientes.'
    : `A correlação entre os retornos foi de ${fmt(correlationValue)}, classificada ` +
      `como ${correlationText(correlationValue)}. Isso descreve o quanto os dois ` +
      `ativos se moveram juntos dentro do período, sem indicar comportamento futuro.`;

  const plain =
    `Em palavras simples: ${statsA.symbol} e ${statsB.symbol} foram comparados apenas ` +
    `pelos candles encerrados do intervalo selecionado. Volatilidade é o tamanho das ` +
    `oscilações; drawdown é quanto o preço ficou abaixo de um topo anterior; e ` +
    `correlação é o quanto os dois ativos se moveram de forma parecida. Os resultados ` +
    `podem mudar rapidamente em períodos intradiários e não antecipam o próximo movimento.`;

  return [
    intro,
    riskA,
    comparison,
    correlationParagraph,
    plain,
    'Este relatório é descritivo e não constitui recomendação de investimento.',
  ].join('\n\n');
}


function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR');
}

function journalStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planejada: 'Planejada',
    aguardando_entrada: 'Aguardando entrada',
    ordem_enviada: 'Ordem enviada',
    aberta: 'Aberta e protegida',
    alvo_executado: 'Alvo executado',
    stop_executado: 'Stop executado',
    encerrada_manual: 'Encerrada manualmente',
    cancelada: 'Cancelada',
    erro: 'Erro',
  };

  return labels[status] ?? status.replaceAll('_', ' ');
}

function journalStatusColor(status: string): string {
  if (status === 'alvo_executado') return S.green;
  if (status === 'stop_executado' || status === 'erro') return S.red;
  if (status === 'aberta') return S.b;
  if (status === 'cancelada') return S.dim;
  return S.yellow;
}

function backtestExitLabel(reason: TrendBreakoutBacktestTrade['exitReason']): string {
  const labels: Record<TrendBreakoutBacktestTrade['exitReason'], string> = {
    stop: 'Stop',
    target: 'Alvo',
    maximum_holding: 'Tempo máximo',
    end_of_data: 'Fim dos dados',
  };

  return labels[reason];
}

async function functionErrorMessage(error: unknown): Promise<string> {
  const fallback =
    error instanceof Error ? error.message : 'A função retornou um erro.';
  const context = (error as { context?: { json?: () => Promise<unknown>; text?: () => Promise<string> } } | null)?.context;

  if (context?.json) {
    try {
      const body = await context.json() as {
        error?: string;
        message?: string;
        code?: string;
        details?: { message?: string };
      };
      const message = body?.error ?? body?.message ?? body?.details?.message;
      if (message) return body?.code ? `${message} (${body.code})` : message;
    } catch {
      // O corpo pode já ter sido consumido pelo cliente.
    }
  }

  if (context?.text) {
    try {
      const body = await context.text();
      if (body) return body.slice(0, 500);
    } catch {
      // Mantém a mensagem original.
    }
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function DayTradePage() {
  const supabase = getSupabase();
  const [session, setSession] = useState<Session | null>(null);

  const [symbolA, setSymbolA] = useState('BTCUSDT');
  const [symbolB, setSymbolB] = useState('ETHUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [periodIndex, setPeriodIndex] = useState(1);

  const [usedSymbolA, setUsedSymbolA] = useState('BTCUSDT');
  const [usedSymbolB, setUsedSymbolB] = useState('ETHUSDT');
  const [usedTimeframe, setUsedTimeframe] = useState<Timeframe>('15m');
  const [usedPeriod, setUsedPeriod] = useState<PeriodOption>(
    TIMEFRAMES['15m'].periods[1],
  );

  const [rawA, setRawA] = useState<Candle[]>([]);
  const [rawB, setRawB] = useState<Candle[]>([]);
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState('');
  const [reportAction, setReportAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });
  const [copyAction, setCopyAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });
  const [history, setHistory] = useState<HistoryRecord[]>([]);

  // Valores educacionais informados manualmente. Nenhum saldo é movimentado.
  const [accountBalance, setAccountBalance] = useState('1000');
  const [availableBalance, setAvailableBalance] = useState('1000');
  const [riskPercent, setRiskPercent] = useState('1');


  // Persistência e execução controlada.
  const [serverSetup, setServerSetup] = useState<ServerSetupRecord | null>(null);
  const [serverAction, setServerAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });
  const [testnetPreview, setTestnetPreview] = useState<TestnetPreviewPayload | null>(null);
  const [testnetAction, setTestnetAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });
  const [confirmTestnet, setConfirmTestnet] = useState(false);

  // Diário sincronizado pelo monitorar-ordens.
  const [journal, setJournal] = useState<DayTradeJournalRecord[]>([]);
  const [journalAction, setJournalAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });

  // Regras automáticas de alerta do playbook.
  const [alertRule, setAlertRule] = useState<DayTradeAlertRuleRecord | null>(null);
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [alertCooldownMinutes, setAlertCooldownMinutes] = useState('30');
  const [alertNotifyStatuses, setAlertNotifyStatuses] = useState<DayTradeAlertableStatus[]>([
    'condicoes_atendidas',
  ]);
  const [alertAction, setAlertAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });

  // Backtest server-side com o mesmo playbook.
  const [backtestCandleCount, setBacktestCandleCount] = useState(
    String(BACKTEST_DEFAULT_CANDLES),
  );
  const [backtestInitialCapital, setBacktestInitialCapital] = useState('1000');
  const [backtestRiskPercent, setBacktestRiskPercent] = useState('1');
  const [backtestFeeRate, setBacktestFeeRate] = useState('0.1');
  const [backtestSlippage, setBacktestSlippage] = useState('0.05');
  const [backtestPriority, setBacktestPriority] = useState<'stop_first' | 'target_first'>('stop_first');
  const [backtestMaximumHolding, setBacktestMaximumHolding] = useState('0');
  const [backtestResponse, setBacktestResponse] = useState<BacktestApiResponse | null>(null);
  const [backtestAction, setBacktestAction] = useState<RemoteActionState>({
    status: 'idle',
    message: '',
  });

  const [liveA, setLiveA] = useState<LiveCandle | null>(null);
  const [liveB, setLiveB] = useState<LiveCandle | null>(null);
  const [webSocketStatus, setWebSocketStatus] = useState<WebSocketStatus>('desconectado');
  const [lastWebSocketUpdate, setLastWebSocketUpdate] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(Date.now());

  const latestHistoryIdRef = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(
      ({ data }: { data: { session: Session | null } }) => setSession(data.session),
    );
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event: string, nextSession: Session | null) => setSession(nextSession),
    );

    return () => subscription.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(HISTORY_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) setHistory(parsed.slice(0, HISTORY_LIMIT));
    } catch {
      window.localStorage.removeItem(HISTORY_KEY);
    }
  }, []);

  useEffect(() => {
    if (status !== 'done') return;
    const timer = window.setInterval(() => setClockTick(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const saveHistory = useCallback((record: HistoryRecord) => {
    latestHistoryIdRef.current = record.id;
    setHistory((current) => {
      const next = [record, ...current.filter((item) => item.id !== record.id)]
        .slice(0, HISTORY_LIMIT);
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateLatestHistoryReport = useCallback((text: string) => {
    const id = latestHistoryIdRef.current;
    if (!id) return;

    setHistory((current) => {
      const next = current.map((item) => item.id === id
        ? { ...item, report: text }
        : item,
      );
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const run = useCallback(async (override?: RunOverride) => {
    const selectedTimeframe = override?.timeframe ?? timeframe;
    const config = TIMEFRAMES[selectedTimeframe];
    const selectedPeriod = override
      ? config.periods.find((period) => period.label === override.periodLabel)
        ?? config.periods[0]
      : config.periods[Math.min(periodIndex, config.periods.length - 1)];
    const selectedA = override?.symbolA ?? symbolA;
    const requestedB = override?.symbolB ?? symbolB;
    const selectedB = requestedB !== 'nenhum' && requestedB !== selectedA
      ? requestedB
      : 'nenhum';

    if (override) {
      setSymbolA(selectedA);
      setSymbolB(requestedB);
      setTimeframe(selectedTimeframe);
      setPeriodIndex(Math.max(
        0,
        config.periods.findIndex((period) => period.label === selectedPeriod.label),
      ));
    }

    setStatus('loading');
    setProgress('');
    setError('');
    setReport('');
    setReportAction({ status: 'idle', message: '' });
    setCopyAction({ status: 'idle', message: '' });
    setLiveA(null);
    setLiveB(null);
    setServerSetup(null);
    setServerAction({ status: 'idle', message: '' });
    setTestnetPreview(null);
    setTestnetAction({ status: 'idle', message: '' });
    setConfirmTestnet(false);
    setBacktestResponse(null);
    setBacktestAction({ status: 'idle', message: '' });

    try {
      const [candlesA, candlesB] = await Promise.all([
        fetchKlines(
          selectedA,
          selectedTimeframe,
          selectedPeriod.durationMs,
          setProgress,
        ),
        selectedB !== 'nenhum'
          ? fetchKlines(
              selectedB,
              selectedTimeframe,
              selectedPeriod.durationMs,
              setProgress,
            )
          : Promise.resolve([]),
      ]);

      const now = Date.now();
      const visibleStart = now - selectedPeriod.durationMs;
      const visibleA = candlesA.filter((candle) => candle.closeTime >= visibleStart);
      const visibleB = candlesB.filter((candle) => candle.closeTime >= visibleStart);

      if (visibleA.length < MIN_VISIBLE_CANDLES) {
        throw new Error(
          `${selectedA}: somente ${visibleA.length} candles encerrados no período.`,
        );
      }

      if (selectedB !== 'nenhum' && visibleB.length < MIN_VISIBLE_CANDLES) {
        throw new Error(
          `${selectedB}: somente ${visibleB.length} candles encerrados no período.`,
        );
      }

      const volA = rollingVol(
        logReturns(candlesA),
        config.volWindow,
        config.periodsPerYear,
      );
      const statsA = computeStats(
        selectedA,
        visibleA,
        candlesA,
        volA,
        selectedTimeframe,
      );

      let statsB: IntradayStats | null = null;
      let correlationValue: number | null = null;

      if (visibleB.length) {
        const volB = rollingVol(
          logReturns(candlesB),
          config.volWindow,
          config.periodsPerYear,
        );
        statsB = computeStats(
          selectedB,
          visibleB,
          candlesB,
          volB,
          selectedTimeframe,
        );
        correlationValue = correlation(visibleA, visibleB);
      }

      setRawA(candlesA);
      setRawB(candlesB);
      setUsedSymbolA(selectedA);
      setUsedSymbolB(selectedB);
      setUsedTimeframe(selectedTimeframe);
      setUsedPeriod(selectedPeriod);
      setClockTick(now);
      setStatus('done');
      setProgress('');

      saveHistory({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        symbolA: selectedA,
        symbolB: selectedB,
        timeframe: selectedTimeframe,
        periodLabel: selectedPeriod.label,
        returnA: statsA.returnPct,
        returnB: statsB?.returnPct ?? null,
        correlation: correlationValue,
      });
    } catch (runError) {
      setError(
        runError instanceof Error
          ? runError.message
          : 'Não foi possível carregar os candles.',
      );
      setStatus('error');
      setProgress('');
    }
  }, [
    timeframe,
    periodIndex,
    symbolA,
    symbolB,
    saveHistory,
  ]);

  // WebSocket somente para a análise já executada. Trocar os seletores não muda
  // o stream até que o usuário clique novamente em Analisar.
  useEffect(() => {
    if (status !== 'done' || !rawA.length) {
      setWebSocketStatus('desconectado');
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let attempts = 0;

    const streams = [usedSymbolA, usedSymbolB]
      .filter((symbol) => symbol !== 'nenhum')
      .map((symbol) => `${symbol.toLowerCase()}@kline_${usedTimeframe}`)
      .join('/');

    const connect = () => {
      if (disposed) return;
      setWebSocketStatus(attempts === 0 ? 'conectando' : 'reconectando');

      socket = new WebSocket(
        `wss://stream.binance.com:9443/stream?streams=${streams}`,
      );

      socket.onopen = () => {
        attempts = 0;
        setWebSocketStatus('ao vivo');
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          const data = payload.data ?? payload;
          const kline = data.k;
          const symbol = String(data.s ?? '').toUpperCase();
          if (!kline || !symbol) return;

          const live: LiveCandle = {
            symbol,
            openTime: Number(kline.t),
            closeTime: Number(kline.T),
            open: Number(kline.o),
            high: Number(kline.h),
            low: Number(kline.l),
            close: Number(kline.c),
            volume: Number(kline.v),
            quoteVolume: Number(kline.q),
            isClosed: Boolean(kline.x),
          };

          setLastWebSocketUpdate(Date.now());

          if (symbol === usedSymbolA) setLiveA(live);
          if (symbol === usedSymbolB) setLiveB(live);

          if (live.isClosed) {
            setClockTick(Date.now());
            const config = TIMEFRAMES[usedTimeframe];
            const requiredIndicatorCandles = getRequiredCandleCount(
              DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[usedTimeframe],
            );
            const retainedWarmupCandles = Math.max(
              config.volWindow + 6,
              requiredIndicatorCandles + 6,
            );
            const minimumOpenTime = Date.now()
              - usedPeriod.durationMs
              - retainedWarmupCandles * config.intervalMs;
            const closed: Candle = {
              openTime: live.openTime,
              closeTime: live.closeTime,
              open: live.open,
              high: live.high,
              low: live.low,
              close: live.close,
              volume: live.volume,
              quoteVolume: live.quoteVolume,
            };

            if (symbol === usedSymbolA) {
              setRawA((current) =>
                upsertClosedCandle(current, closed, minimumOpenTime),
              );
            }

            if (symbol === usedSymbolB) {
              setRawB((current) =>
                upsertClosedCandle(current, closed, minimumOpenTime),
              );
            }
          }
        } catch {
          // Uma mensagem inválida não deve interromper o stream.
        }
      };

      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        attempts += 1;
        setWebSocketStatus('reconectando');
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(attempts, 4));
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [
    status,
    usedSymbolA,
    usedSymbolB,
    usedTimeframe,
    usedPeriod.durationMs,
  ]);

  const derived = useMemo(() => {
    if (!rawA.length) {
      return {
        visibleA: [] as Candle[],
        visibleB: [] as Candle[],
        volA: [] as (number | null)[],
        volB: [] as (number | null)[],
        statsA: null as IntradayStats | null,
        statsB: null as IntradayStats | null,
        correlation: null as number | null,
      };
    }

    const config = TIMEFRAMES[usedTimeframe];
    const visibleStart = clockTick - usedPeriod.durationMs;
    const visibleA = rawA.filter((candle) => candle.closeTime >= visibleStart);
    const visibleB = rawB.filter((candle) => candle.closeTime >= visibleStart);
    const volA = rollingVol(
      logReturns(rawA),
      config.volWindow,
      config.periodsPerYear,
    );
    const volB = rawB.length
      ? rollingVol(logReturns(rawB), config.volWindow, config.periodsPerYear)
      : [];

    return {
      visibleA,
      visibleB,
      volA,
      volB,
      statsA: visibleA.length >= 2
        ? computeStats(usedSymbolA, visibleA, rawA, volA, usedTimeframe)
        : null,
      statsB: visibleB.length >= 2
        ? computeStats(usedSymbolB, visibleB, rawB, volB, usedTimeframe)
        : null,
      correlation: visibleB.length ? correlation(visibleA, visibleB) : null,
    };
  }, [
    rawA,
    rawB,
    usedSymbolA,
    usedSymbolB,
    usedTimeframe,
    usedPeriod.durationMs,
    clockTick,
  ]);

  const setupAnalysis = useMemo<{
    indicators: DayTradeIndicators | null;
    evaluation: TrendBreakoutEvaluation | null;
    error: string;
  }>(() => {
    if (rawA.length < 2) {
      return { indicators: null, evaluation: null, error: '' };
    }

    try {
      const result = analyzeTrendBreakout({
        candles: rawA,
        indicatorOptions:
          DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[usedTimeframe],
        livePrice: liveA?.close ?? null,
      });

      return {
        indicators: result.indicators,
        evaluation: result.evaluation,
        error: '',
      };
    } catch (setupError) {
      return {
        indicators: null,
        evaluation: null,
        error:
          setupError instanceof Error
            ? setupError.message
            : 'Não foi possível avaliar o playbook.',
      };
    }
  }, [rawA, usedTimeframe, liveA?.close]);


  const loadJournal = useCallback(async () => {
    if (!session) {
      setJournal([]);
      setJournalAction({ status: 'idle', message: '' });
      return;
    }

    setJournalAction({ status: 'loading', message: 'Atualizando diário...' });

    const { data, error: journalError } = await supabase
      .from('daytrade_journal')
      .select(
        'id,setup_id,order_id,mode,status,symbol,timeframe,strategy,entry_reference,stop_reference,target_reference,risk_reward_ratio,planned_quantity,planned_notional,risk_usdt,risk_percent,entry_price,exit_price,quantity,fees_usdt,pnl_usdt,result_r,notes,aberto_em,fechado_em,criado_em,atualizado_em',
      )
      .order('criado_em', { ascending: false })
      .limit(JOURNAL_LIMIT);

    if (journalError) {
      setJournalAction({
        status: 'error',
        message: `Não foi possível carregar o diário: ${journalError.message}`,
      });
      return;
    }

    setJournal((data ?? []) as DayTradeJournalRecord[]);
    setJournalAction({
      status: 'success',
      message: `${(data ?? []).length} registro(s) carregado(s).`,
    });
  }, [session, supabase]);

  const loadAlertRule = useCallback(async () => {
    if (!session) {
      setAlertRule(null);
      setAlertAction({ status: 'idle', message: '' });
      return;
    }

    const activeSymbol = status === 'done' ? usedSymbolA : symbolA;
    const activeTimeframe = status === 'done' ? usedTimeframe : timeframe;

    setAlertAction({ status: 'loading', message: 'Consultando regra de alerta...' });

    const { data, error: alertError } = await supabase
      .from('daytrade_alert_rules')
      .select(
        'id,symbol,timeframe,strategy,notify_statuses,canal,ativo,cooldown_minutes,last_status,last_candle_open_time,last_triggered_at,criado_em,atualizado_em',
      )
      .eq('symbol', activeSymbol)
      .eq('timeframe', activeTimeframe)
      .eq('strategy', 'trend_breakout')
      .maybeSingle();

    if (alertError) {
      setAlertRule(null);
      setAlertAction({
        status: 'error',
        message: `Não foi possível consultar alertas: ${alertError.message}`,
      });
      return;
    }

    const rule = (data ?? null) as DayTradeAlertRuleRecord | null;
    setAlertRule(rule);
    setAlertEnabled(rule?.ativo ?? true);
    setAlertCooldownMinutes(String(rule?.cooldown_minutes ?? 30));
    setAlertNotifyStatuses(
      rule?.notify_statuses?.length
        ? rule.notify_statuses
        : ['condicoes_atendidas'],
    );
    setAlertAction({
      status: 'success',
      message: rule ? 'Regra existente carregada.' : 'Nenhuma regra criada para este mercado.',
    });
  }, [
    session,
    status,
    usedSymbolA,
    usedTimeframe,
    symbolA,
    timeframe,
    supabase,
  ]);

  useEffect(() => {
    void loadJournal();
  }, [loadJournal]);

  useEffect(() => {
    void loadAlertRule();
  }, [loadAlertRule]);

  const persistCurrentSetup = useCallback(async (
    announce = true,
  ): Promise<ServerSetupRecord> => {
    if (!session) throw new Error('Entre na sua conta para salvar o setup.');
    if (status !== 'done' || rawA.length < 2) {
      throw new Error('Execute primeiro a análise do ativo e timeframe selecionados.');
    }

    if (announce) {
      setServerAction({ status: 'loading', message: 'Reavaliando e salvando o setup...' });
    }

    const { data, error: invokeError } = await supabase.functions.invoke(
      'avaliar-daytrade',
      {
        body: {
          symbol: usedSymbolA,
          timeframe: usedTimeframe,
          persist: true,
          live_price: liveA?.close ?? undefined,
        },
      },
    );

    if (invokeError) throw new Error(await functionErrorMessage(invokeError));
    if (!data?.ok || !data?.setup?.id) {
      throw new Error(data?.error ?? 'A função não retornou o setup persistido.');
    }

    const saved = data.setup as ServerSetupRecord;
    setServerSetup(saved);

    if (announce) {
      setServerAction({
        status: 'success',
        message: `Setup salvo como “${TREND_BREAKOUT_STATUS_LABELS[saved.status]?.label ?? saved.status}”.`,
      });
    }

    return saved;
  }, [
    session,
    status,
    rawA.length,
    supabase,
    usedSymbolA,
    usedTimeframe,
    liveA?.close,
  ]);

  const handlePersistSetup = useCallback(async () => {
    try {
      await persistCurrentSetup(true);
    } catch (persistError) {
      setServerAction({
        status: 'error',
        message: persistError instanceof Error ? persistError.message : 'Falha ao salvar o setup.',
      });
    }
  }, [persistCurrentSetup]);

  const handlePreviewTestnet = useCallback(async () => {
    setTestnetAction({ status: 'loading', message: 'Validando conta, mercado e risco na Testnet...' });
    setTestnetPreview(null);
    setConfirmTestnet(false);

    try {
      const setup = await persistCurrentSetup(false);
      setServerAction({
        status: 'success',
        message: `Setup ${setup.symbol}/${setup.timeframe} atualizado antes da prévia.`,
      });

      const { data, error: invokeError } = await supabase.functions.invoke(
        'executar-daytrade-testnet',
        {
          body: {
            action: 'preview',
            setup_id: setup.id,
            risk_percent: parseUserNumber(riskPercent),
          },
        },
      );

      if (invokeError) throw new Error(await functionErrorMessage(invokeError));
      if (!data?.ok || !data?.preview) {
        throw new Error(data?.error ?? 'A Testnet não retornou uma prévia executável.');
      }

      const response = data as TestnetPreviewResponse;
      setTestnetPreview(response.preview);
      setTestnetAction({
        status: 'success',
        message: 'Prévia aprovada. Revise os valores antes de confirmar a ordem simulada.',
      });
    } catch (previewError) {
      setTestnetAction({
        status: 'error',
        message: previewError instanceof Error ? previewError.message : 'Falha na prévia Testnet.',
      });
    }
  }, [persistCurrentSetup, riskPercent, supabase]);

  const handleExecuteTestnet = useCallback(async () => {
    if (!testnetPreview) {
      setTestnetAction({ status: 'error', message: 'Gere uma prévia válida antes da execução.' });
      return;
    }
    if (!confirmTestnet) {
      setTestnetAction({ status: 'error', message: 'Marque a confirmação explícita da Testnet.' });
      return;
    }

    setTestnetAction({ status: 'loading', message: 'Enviando compra e proteção OCO para a Binance Spot Testnet...' });

    try {
      const { data, error: invokeError } = await supabase.functions.invoke(
        'executar-daytrade-testnet',
        {
          body: {
            action: 'execute',
            setup_id: testnetPreview.setup.id,
            risk_percent: parseUserNumber(riskPercent),
            confirm_testnet: true,
          },
        },
      );

      if (invokeError) throw new Error(await functionErrorMessage(invokeError));
      if (!data?.ok) {
        throw new Error(data?.error ?? 'A ordem Testnet não foi confirmada.');
      }

      const duplicate = Boolean(data?.duplicate);
      setTestnetAction({
        status: 'success',
        message: duplicate
          ? 'Este setup já havia sido processado; nenhuma compra duplicada foi criada.'
          : 'Ordem enviada à Testnet. O monitor acompanhará a OCO e atualizará o diário.',
      });
      setConfirmTestnet(false);
      await loadJournal();
    } catch (executeError) {
      setTestnetAction({
        status: 'error',
        message: executeError instanceof Error ? executeError.message : 'Falha na execução Testnet.',
      });
      await loadJournal();
    }
  }, [
    testnetPreview,
    confirmTestnet,
    supabase,
    riskPercent,
    loadJournal,
  ]);

  const toggleAlertStatus = useCallback((value: DayTradeAlertableStatus) => {
    setAlertNotifyStatuses((current) => {
      if (current.includes(value)) {
        return current.length === 1
          ? current
          : current.filter((statusValue) => statusValue !== value);
      }
      return [...current, value];
    });
  }, []);

  const handleSaveAlertRule = useCallback(async () => {
    if (!session) {
      setAlertAction({ status: 'error', message: 'Entre na sua conta para criar alertas.' });
      return;
    }

    const cooldown = Number(alertCooldownMinutes);
    if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 1440) {
      setAlertAction({ status: 'error', message: 'O cooldown deve ser um inteiro entre 0 e 1440 minutos.' });
      return;
    }

    const activeSymbol = status === 'done' ? usedSymbolA : symbolA;
    const activeTimeframe = status === 'done' ? usedTimeframe : timeframe;
    setAlertAction({ status: 'loading', message: 'Salvando regra de alerta...' });

    const payload = {
      user_id: session.user.id,
      symbol: activeSymbol,
      timeframe: activeTimeframe,
      strategy: 'trend_breakout',
      notify_statuses: alertNotifyStatuses,
      canal: 'email',
      ativo: alertEnabled,
      cooldown_minutes: cooldown,
    };

    const { data, error: saveError } = await supabase
      .from('daytrade_alert_rules')
      .upsert(payload, {
        onConflict: 'user_id,symbol,timeframe,strategy',
      })
      .select(
        'id,symbol,timeframe,strategy,notify_statuses,canal,ativo,cooldown_minutes,last_status,last_candle_open_time,last_triggered_at,criado_em,atualizado_em',
      )
      .single();

    if (saveError) {
      setAlertAction({ status: 'error', message: saveError.message });
      return;
    }

    setAlertRule(data as DayTradeAlertRuleRecord);
    setAlertAction({
      status: 'success',
      message: alertEnabled
        ? 'Regra ativa. O cron avaliará o mercado a cada cinco minutos.'
        : 'Regra salva, porém pausada.',
    });
  }, [
    session,
    alertCooldownMinutes,
    status,
    usedSymbolA,
    usedTimeframe,
    symbolA,
    timeframe,
    alertNotifyStatuses,
    alertEnabled,
    supabase,
  ]);

  const handleDeleteAlertRule = useCallback(async () => {
    if (!alertRule) return;
    setAlertAction({ status: 'loading', message: 'Removendo regra...' });

    const { error: deleteError } = await supabase
      .from('daytrade_alert_rules')
      .delete()
      .eq('id', alertRule.id);

    if (deleteError) {
      setAlertAction({ status: 'error', message: deleteError.message });
      return;
    }

    setAlertRule(null);
    setAlertEnabled(true);
    setAlertNotifyStatuses(['condicoes_atendidas']);
    setAlertCooldownMinutes('30');
    setAlertAction({ status: 'success', message: 'Regra removida.' });
  }, [alertRule, supabase]);

  const handleRunBacktest = useCallback(async () => {
    if (!session) {
      setBacktestAction({ status: 'error', message: 'Entre na sua conta para executar o backtest.' });
      return;
    }

    const candleCount = Number(backtestCandleCount);
    const initialCapital = parseUserNumber(backtestInitialCapital);
    const testRiskPercent = parseUserNumber(backtestRiskPercent);
    const feeRate = parseUserNumber(backtestFeeRate);
    const slippage = parseUserNumber(backtestSlippage);
    const maximumHolding = Number(backtestMaximumHolding);

    if (!Number.isInteger(candleCount) || candleCount < 350 || candleCount > 3000) {
      setBacktestAction({ status: 'error', message: 'Use entre 350 e 3000 candles.' });
      return;
    }
    if (!(initialCapital > 0)) {
      setBacktestAction({ status: 'error', message: 'O patrimônio inicial deve ser maior que zero.' });
      return;
    }
    if (!(testRiskPercent > 0) || testRiskPercent > 2) {
      setBacktestAction({ status: 'error', message: 'O risco do backtest deve estar entre 0 e 2%.' });
      return;
    }
    if (!(feeRate >= 0) || !(slippage >= 0)) {
      setBacktestAction({ status: 'error', message: 'Taxa e slippage não podem ser negativos.' });
      return;
    }
    if (!Number.isInteger(maximumHolding) || maximumHolding < 0) {
      setBacktestAction({ status: 'error', message: 'O limite de candles deve ser um inteiro não negativo.' });
      return;
    }

    setBacktestAction({ status: 'loading', message: 'Baixando histórico e simulando o playbook...' });
    setBacktestResponse(null);

    const { data, error: invokeError } = await supabase.functions.invoke(
      'backtest-daytrade',
      {
        body: {
          symbol: status === 'done' ? usedSymbolA : symbolA,
          timeframe: status === 'done' ? usedTimeframe : timeframe,
          candle_count: candleCount,
          backtest_options: {
            initialCapitalUsdt: initialCapital,
            riskPercent: testRiskPercent,
            feeRatePct: feeRate,
            slippagePct: slippage,
            intrabarPriority: backtestPriority,
            maximumHoldingCandles: maximumHolding,
          },
        },
      },
    );

    if (invokeError) {
      setBacktestAction({ status: 'error', message: await functionErrorMessage(invokeError) });
      return;
    }
    if (!data?.ok || !data?.result) {
      setBacktestAction({ status: 'error', message: data?.error ?? 'Backtest sem resultado.' });
      return;
    }

    const response = data as BacktestApiResponse;
    setBacktestResponse(response);
    setBacktestAction({
      status: 'success',
      message: `Simulação concluída em ${response.execution_ms} ms com ${response.result.metrics.totalTrades} operação(ões).`,
    });
  }, [
    session,
    backtestCandleCount,
    backtestInitialCapital,
    backtestRiskPercent,
    backtestFeeRate,
    backtestSlippage,
    backtestMaximumHolding,
    supabase,
    status,
    usedSymbolA,
    symbolA,
    usedTimeframe,
    timeframe,
    backtestPriority,
  ]);

  const setupQuestions = useMemo(() => {
    const evaluation = setupAnalysis.evaluation;
    if (!evaluation) return [];

    const byId = new Map(
      evaluation.conditions.map((condition) => [condition.id, condition]),
    );
    const trendOk =
      Boolean(byId.get('preco_acima_ema_lenta')?.passed) &&
      Boolean(byId.get('emas_alinhadas')?.passed);
    const volatilityRegime = evaluation.diagnostics.volatilityRegime;

    return [
      {
        question: 'A tendência está favorável?',
        answer: trendOk ? 'Sim' : 'Ainda não',
        positive: trendOk,
        detail: trendOk
          ? 'Preço acima da EMA 200 e médias de curto prazo alinhadas.'
          : 'Uma ou mais condições de tendência ainda não foram confirmadas.',
      },
      {
        question: 'Existe rompimento confirmado?',
        answer: byId.get('rompimento_confirmado')?.passed ? 'Sim' : 'Não',
        positive: Boolean(byId.get('rompimento_confirmado')?.passed),
        detail:
          byId.get('rompimento_confirmado')?.explanation ??
          'Aguardando dados.',
      },
      {
        question: 'O volume confirmou?',
        answer: byId.get('volume_confirmado')?.passed ? 'Sim' : 'Não',
        positive: Boolean(byId.get('volume_confirmado')?.passed),
        detail:
          byId.get('volume_confirmado')?.explanation ??
          'Aguardando dados.',
      },
      {
        question: 'A volatilidade está elevada?',
        answer:
          volatilityRegime === 'extremo'
            ? 'Extrema'
            : volatilityRegime === 'volátil'
              ? 'Elevada'
              : volatilityRegime === 'indisponível'
                ? 'Indisponível'
                : 'Não',
        positive:
          volatilityRegime !== 'extremo' &&
          volatilityRegime !== 'indisponível',
        detail: `Regime atual: ${volatilityRegime}.`,
      },
      {
        question: 'Existe uma entrada válida agora?',
        answer:
          evaluation.status === 'condicoes_atendidas'
            ? 'Condições atendidas'
            : evaluation.status === 'entrada_atrasada'
              ? 'Preço atrasado'
              : evaluation.status === 'invalidado'
                ? 'Setup invalidado'
                : 'Não',
        positive: evaluation.status === 'condicoes_atendidas',
        detail: TREND_BREAKOUT_STATUS_LABELS[evaluation.status].shortDescription,
      },
    ];
  }, [setupAnalysis.evaluation]);

  const actionablePlan = useMemo(() => {
    const evaluation = setupAnalysis.evaluation;
    if (!evaluation?.plan) return null;

    if (
      evaluation.status === 'condicoes_atendidas' ||
      evaluation.status === 'entrada_atrasada' ||
      evaluation.status === 'invalidado'
    ) {
      return evaluation.plan;
    }

    return null;
  }, [setupAnalysis.evaluation]);

  const positionSizing = useMemo<PositionSizingResult | null>(() => {
    if (!actionablePlan) return null;

    return calculatePositionSizeFromPlan({
      accountBalance: parseUserNumber(accountBalance),
      availableBalance: parseUserNumber(availableBalance),
      riskPercent: parseUserNumber(riskPercent),
      plan: actionablePlan,
      allowLeverage: false,
      policy: {
        recommendedRiskPercent: 1,
        maximumRiskPercent: 2,
      },
    });
  }, [actionablePlan, accountBalance, availableBalance, riskPercent]);


  const journalSummary = useMemo(() => {
    const closed = journal.filter((row) => row.fechado_em !== null);
    const netPnl = closed.reduce(
      (sum, row) => sum + (nullableNumber(row.pnl_usdt) ?? 0),
      0,
    );
    const averageRValues = closed
      .map((row) => nullableNumber(row.result_r))
      .filter((value): value is number => value !== null);
    const averageR = averageRValues.length
      ? averageRValues.reduce((sum, value) => sum + value, 0) / averageRValues.length
      : null;
    const open = journal.filter((row) => row.status === 'aberta').length;

    return { closed: closed.length, open, netPnl, averageR };
  }, [journal]);

  const backtestEquityData = useMemo(() => {
    const curve = backtestResponse?.result.equityCurve ?? [];
    if (!curve.length) return [];
    const step = Math.max(1, Math.floor(curve.length / 500));
    const sampled = curve.filter((_, index) => index % step === 0);
    if (sampled[sampled.length - 1] !== curve[curve.length - 1]) {
      sampled.push(curve[curve.length - 1]);
    }

    return sampled.map((point) => ({
      label: new Date(point.time).toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
      }),
      Patrimônio: Number(point.equityUsdt.toFixed(2)),
      Drawdown: Number(point.drawdownPct.toFixed(2)),
    }));
  }, [backtestResponse]);

  const charts = useMemo(() => {
    const { visibleA, visibleB, volA, volB } = derived;
    if (!visibleA.length) {
      return { performance: [], volatility: [], volume: [], technical: [] };
    }

    const volAByTime = new Map(
      rawA.map((candle, index) => [candle.openTime, volA[index]]),
    );
    const volBByTime = new Map(
      rawB.map((candle, index) => [candle.openTime, volB[index]]),
    );
    const bByTime = new Map(visibleB.map((candle) => [candle.openTime, candle]));
    const firstMatchedB = visibleA
      .map((candle) => bByTime.get(candle.openTime))
      .find((candle): candle is Candle => Boolean(candle));

    const baseA = visibleA[0].close;
    const baseB = firstMatchedB?.close ?? 1;
    const step = Math.max(1, Math.floor(visibleA.length / 500));
    const indexes: number[] = [];

    for (let index = 0; index < visibleA.length; index += step) {
      indexes.push(index);
    }

    if (indexes[indexes.length - 1] !== visibleA.length - 1) {
      indexes.push(visibleA.length - 1);
    }

    const performance: Record<string, number | string>[] = [];
    const volatility: Record<string, number | string>[] = [];
    const volume: Record<string, number | string>[] = [];

    for (const index of indexes) {
      const candleA = visibleA[index];
      const label = chartLabel(candleA.openTime, usedPeriod.durationMs);
      const matchedB = bByTime.get(candleA.openTime);
      const performancePoint: Record<string, number | string> = {
        label,
        [usedSymbolA]: Number(((candleA.close / baseA) * 100).toFixed(2)),
      };
      const volatilityPoint: Record<string, number | string> = { label };
      const volumePoint: Record<string, number | string> = {
        label,
        [usedSymbolA]: Number((candleA.quoteVolume / 1_000_000).toFixed(3)),
      };

      const currentVolA = volAByTime.get(candleA.openTime);
      if (currentVolA !== null && currentVolA !== undefined) {
        volatilityPoint[usedSymbolA] = Number(currentVolA.toFixed(1));
      }

      if (matchedB && usedSymbolB !== 'nenhum') {
        performancePoint[usedSymbolB] = Number(
          ((matchedB.close / baseB) * 100).toFixed(2),
        );
        volumePoint[usedSymbolB] = Number(
          (matchedB.quoteVolume / 1_000_000).toFixed(3),
        );
        const currentVolB = volBByTime.get(matchedB.openTime);
        if (currentVolB !== null && currentVolB !== undefined) {
          volatilityPoint[usedSymbolB] = Number(currentVolB.toFixed(1));
        }
      }

      performance.push(performancePoint);
      volatility.push(volatilityPoint);
      volume.push(volumePoint);
    }

    const indicatorPointByTime = new Map(
      (setupAnalysis.indicators?.series ?? []).map((point) => [
        point.openTime,
        point,
      ]),
    );

    const technical = indexes.map((index) => {
      const candle = visibleA[index];
      const point = indicatorPointByTime.get(candle.openTime);

      return {
        label: chartLabel(candle.openTime, usedPeriod.durationMs),
        Preço: Number(candle.close.toFixed(8)),
        'EMA 20': point?.emaFast ?? undefined,
        'EMA 50': point?.emaMedium ?? undefined,
        'EMA 200': point?.emaSlow ?? undefined,
        Rompimento: point?.priorHighestHigh ?? undefined,
      };
    });

    return { performance, volatility, volume, technical };
  }, [
    derived,
    rawA,
    rawB,
    usedSymbolA,
    usedSymbolB,
    usedPeriod.durationMs,
    setupAnalysis.indicators,
  ]);

  const generateReport = useCallback(async () => {
    if (!derived.statsA || reportAction.status === 'loading') return;

    const fallbackText = buildReport(
      derived.statsA,
      derived.statsB,
      derived.correlation,
      usedPeriod.label,
      usedTimeframe,
    );

    const evaluation = setupAnalysis.evaluation;
    const indicators = setupAnalysis.indicators;

    setReportAction({
      status: 'loading',
      message: 'A IA está interpretando as métricas e o checklist deste cenário...',
    });

    try {
      const response = await fetch('/api/relatorio-daytrade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify({
          periodoLabel: usedPeriod.label,
          timeframe: usedTimeframe,
          correlacao: derived.correlation,
          ativos: [
            derived.statsA,
            ...(derived.statsB ? [derived.statsB] : []),
          ],
          setup: evaluation
            ? {
                strategy: evaluation.strategy,
                strategyVersion: evaluation.strategyVersion,
                status: evaluation.status,
                candleOpenTime: evaluation.candleOpenTime,
                candleCloseTime: evaluation.candleCloseTime,
                evaluatedPrice: evaluation.evaluatedPrice,
                livePrice: evaluation.livePrice,
                passedConditions: evaluation.passedConditions,
                totalConditions: evaluation.totalConditions,
                scorePct: evaluation.scorePct,
                allConditionsMet: evaluation.allConditionsMet,
                nextTrigger: evaluation.nextTrigger,
                summary: evaluation.summary,
                warnings: evaluation.warnings,
                diagnostics: evaluation.diagnostics,
                conditions: evaluation.conditions.map((condition) => ({
                  id: condition.id,
                  label: condition.label,
                  passed: condition.passed,
                  available: condition.available,
                  currentValue: condition.currentValue,
                  requiredValue: condition.requiredValue,
                  explanation: condition.explanation,
                })),
                plan: evaluation.plan,
              }
            : null,
          indicadores: indicators
            ? {
                ready: indicators.ready,
                candleCount: indicators.candleCount,
                requiredCandles: indicators.requiredCandles,
                currentPrice: indicators.currentPrice,
                previousClose: indicators.previousClose,
                lastCandleReturnPct: indicators.lastCandleReturnPct,
                currentCandleRangePct: indicators.currentCandleRangePct,
                emaFast: indicators.emaFast,
                emaMedium: indicators.emaMedium,
                emaSlow: indicators.emaSlow,
                atr: indicators.atr,
                atrPct: indicators.atrPct,
                breakoutLevel: indicators.breakoutLevel,
                supportLevel: indicators.supportLevel,
                distanceToBreakoutPct: indicators.distanceToBreakoutPct,
                distanceFromSupportPct: indicators.distanceFromSupportPct,
                distanceFromSlowEmaPct: indicators.distanceFromSlowEmaPct,
                currentVolume: indicators.currentVolume,
                averageVolume: indicators.averageVolume,
                relativeVolume: indicators.relativeVolume,
                annualizedVolatilityPct: indicators.annualizedVolatilityPct,
                volatilityRegime: indicators.volatilityRegime,
                volatilityPercentile: indicators.volatilityPercentile,
                periodHigh: indicators.periodHigh,
                periodLow: indicators.periodLow,
                amplitudePct: indicators.amplitudePct,
                maxDrawdownPct: indicators.maxDrawdownPct,
                currentDrawdownPct: indicators.currentDrawdownPct,
                timeInDrawdownPct: indicators.timeInDrawdownPct,
              }
            : null,
        }),
      });

      const payload = await response.json().catch(() => null) as {
        relatorio?: string;
        error?: string;
        requestId?: string;
      } | null;

      if (!response.ok || !payload?.relatorio?.trim()) {
        throw new Error(
          payload?.error ??
            `O serviço de relatório respondeu ${response.status}.`,
        );
      }

      const text = payload.relatorio.trim();
      setReport(text);
      updateLatestHistoryReport(text);
      setReportAction({
        status: 'success',
        message:
          'Análise explicada por IA com base somente nas métricas e regras calculadas pelo VigIA.',
      });
    } catch (reportError) {
      setReport(fallbackText);
      updateLatestHistoryReport(fallbackText);
      setReportAction({
        status: 'fallback',
        message:
          `A IA não respondeu; o VigIA exibiu o resumo local de contingência. ${
            reportError instanceof Error ? reportError.message : ''
          }`.trim(),
      });
    }
  }, [
    derived.statsA,
    derived.statsB,
    derived.correlation,
    usedPeriod.label,
    usedTimeframe,
    setupAnalysis.evaluation,
    setupAnalysis.indicators,
    reportAction.status,
    updateLatestHistoryReport,
  ]);

  const copyAnalysisMarkdown = useCallback(async () => {
    if (!derived.statsA) {
      setCopyAction({
        status: 'error',
        message: 'Execute uma análise antes de copiar o Markdown.',
      });
      return;
    }

    const statsA = derived.statsA;
    const statsB = derived.statsB;
    const evaluation = setupAnalysis.evaluation;
    const indicators = setupAnalysis.indicators;
    const plan = evaluation?.plan ?? null;
    const metrics = backtestResponse?.result.metrics ?? null;
    const backtestTrades =
      backtestResponse?.result.trades.slice(-15).reverse() ?? [];
    const generatedAt = new Date();
    const officialCloseTime =
      evaluation?.candleCloseTime ??
      rawA[rawA.length - 1]?.closeTime ??
      null;
    const intervalMs = TIMEFRAMES[usedTimeframe].intervalMs;
    const nextExpectedCloseTime =
      officialCloseTime === null ? null : officialCloseTime + intervalMs;
    const visibleReturnCount = Math.max(0, statsA.candleCount - 1);
    const indicatorCandleCount =
      indicators?.candleCount ?? rawA.length;
    const warmupCandleCount = Math.max(
      0,
      indicatorCandleCount - statsA.candleCount,
    );
    const executableStatuses: TrendBreakoutStatus[] = [
      'condicoes_atendidas',
      'entrada_atrasada',
      'invalidado',
    ];
    const planWasConfirmed =
      evaluation !== null &&
      executableStatuses.includes(evaluation.status);
    const planIsCurrentlyExecutable =
      evaluation?.status === 'condicoes_atendidas';
    const pendingConditions =
      evaluation?.conditions.filter(
        (condition) => condition.available && !condition.passed,
      ) ?? [];

    const assumedFeeRatePct = 0.1;
    const assumedSlippagePct = 0.05;
    const costEstimate = plan
      ? calculateRiskReward({
          direction: plan.direction,
          entryPrice: plan.entryReference,
          stopPrice: plan.stopReference,
          targetPrice: plan.targetReference,
          feeRatePct: assumedFeeRatePct,
          slippagePct: assumedSlippagePct,
        })
      : null;

    const mdNumber = (
      value: number | null | undefined,
      digits = 2,
    ): string =>
      value === null || value === undefined || !Number.isFinite(value)
        ? '—'
        : fmt(value, digits);

    const mdPrice = (
      value: number | null | undefined,
    ): string =>
      value === null || value === undefined || !Number.isFinite(value)
        ? '—'
        : fmtPrice(value);

    const mdPct = (
      value: number | null | undefined,
      digits = 2,
    ): string =>
      value === null || value === undefined || !Number.isFinite(value)
        ? '—'
        : fmtPct(value, digits);

    const mdDate = (
      value: string | number | null | undefined,
    ): string => {
      if (value === null || value === undefined || value === '') return '—';
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? '—'
        : parsed.toLocaleString('pt-BR');
    };

    const cleanCell = (
      value: string | number | null | undefined,
    ): string =>
      String(value ?? '—')
        .replaceAll('|', '\\|')
        .replace(/\r?\n/g, ' ')
        .trim();

    const countMissingCandles = (candles: Candle[]): number => {
      let missing = 0;

      for (let index = 1; index < candles.length; index += 1) {
        const distance =
          candles[index].openTime - candles[index - 1].openTime;
        const steps = Math.round(distance / intervalMs);
        if (steps > 1) missing += steps - 1;
      }

      return missing;
    };

    const alignedPairCount = (() => {
      if (!derived.visibleB.length) return 0;
      const timesB = new Set(
        derived.visibleB.map((candle) => candle.openTime),
      );
      return derived.visibleA.filter(
        (candle) => timesB.has(candle.openTime),
      ).length;
    })();

    const statusLabel = evaluation
      ? TREND_BREAKOUT_STATUS_LABELS[evaluation.status]?.label ??
        evaluation.status
      : 'Não calculado';

    const shortSampleWarning =
      usedPeriod.durationMs < 7 * DAY || visibleReturnCount < 500
        ? 'A amostra é curta para inferência estatística. O Sharpe foi anualizado matematicamente e pode ficar muito elevado ou muito negativo por pequenas variações intradiárias.'
        : 'O Sharpe continua sendo uma descrição histórica da amostra e não uma previsão.';

    const planHeading =
      evaluation?.status === 'condicoes_atendidas'
        ? '## Plano técnico confirmado pelo playbook'
        : evaluation?.status === 'entrada_atrasada'
          ? '## Plano técnico confirmado, mas com entrada atrasada'
          : evaluation?.status === 'invalidado'
            ? '## Plano técnico invalidado'
            : '## Simulação matemática prévia — não executável';

    const planExplanation =
      evaluation?.status === 'condicoes_atendidas'
        ? 'Todas as condições foram atendidas no candle encerrado. Os valores abaixo continuam sendo referências educacionais, não uma ordem.'
        : evaluation?.status === 'entrada_atrasada'
          ? 'O setup foi confirmado anteriormente, mas o preço ao vivo ultrapassou o limite previsto. Uma nova entrada está bloqueada.'
          : evaluation?.status === 'invalidado'
            ? 'O setup foi confirmado anteriormente, mas atingiu o nível de invalidação. Uma nova entrada está bloqueada.'
            : 'As condições ainda não foram todas atendidas. Entrada, stop e alvo abaixo são apenas uma projeção usando o candle atual e serão recalculados após eventual confirmação.';

    const lines: string[] = [
      '# VigIA Trade — Snapshot completo da análise Day Trade',
      '',
      '> Revise este snapshot como uma segunda opinião técnica independente. Verifique a consistência entre métricas, indicadores, checklist, plano matemático, custos, dimensionamento e backtest. Não invente dados externos, não altere números sem demonstrar a fórmula e não trate o status como recomendação de investimento.',
      '',
      '## Contexto da análise',
      '',
      `- **Gerado em:** ${generatedAt.toLocaleString('pt-BR')}`,
      `- **Ativo principal:** ${usedSymbolA}`,
      `- **Ativo de comparação:** ${
        usedSymbolB === 'nenhum' ? 'não utilizado' : usedSymbolB
      }`,
      `- **Timeframe:** ${TIMEFRAMES[usedTimeframe].label} (${usedTimeframe})`,
      `- **Período visível analisado:** ${usedPeriod.label}`,
      '- **Candles oficiais:** somente candles encerrados',
      `- **Candles visíveis do ativo principal:** ${statsA.candleCount}`,
      `- **Retornos visíveis calculados:** ${visibleReturnCount}`,
      `- **Candles totais usados pelos indicadores:** ${indicatorCandleCount}`,
      `- **Candles anteriores usados para aquecimento:** ${warmupCandleCount}`,
      `- **Candles ausentes dentro da janela visível:** ${countMissingCandles(
        derived.visibleA,
      )}`,
      `- **Fechamento oficial mais recente:** ${mdDate(officialCloseTime)}`,
      `- **Próximo encerramento esperado:** ${mdDate(nextExpectedCloseTime)}`,
      '- **Candle atual em formação:** não participa das métricas nem confirma rompimento',
      `- **Preço do candle encerrado:** ${mdPrice(statsA.lastPrice)} USDT`,
      `- **Preço ao vivo do candle em formação:** ${
        liveA ? `${mdPrice(liveA.close)} USDT` : 'indisponível'
      }`,
      `- **Status oficial do playbook:** ${statusLabel}`,
      '',
      '## Metodologia e limitações',
      '',
      '- Retorno, drawdown e Sharpe usam fechamentos de candles encerrados.',
      '- Drawdown máximo e atual são calculados contra o maior fechamento anterior, não contra a máxima intraperíodo.',
      '- Volatilidade usa retornos logarítmicos, desvio-padrão populacional na janela móvel e anualização pela raiz quadrada da quantidade de candles por ano.',
      '- Sharpe usa média dos retornos logarítmicos, desvio-padrão amostral, taxa livre de risco igual a zero e anualização. Em amostras intradiárias curtas, o valor é estatisticamente instável.',
      '- O volume financeiro médio usa todos os candles do período visível. O volume médio do indicador de rompimento usa a janela anterior configurada pelo playbook.',
      '- A relação risco-retorno do plano é bruta. Taxas e slippage podem reduzir materialmente o resultado líquido.',
      `- **Aviso sobre o Sharpe:** ${shortSampleWarning}`,
      '',
      '## Métricas do ativo principal',
      '',
      '| Métrica | Valor |',
      '|---|---:|',
      `| Último fechamento | ${mdPrice(statsA.lastPrice)} USDT |`,
      `| Retorno no período | ${mdPct(statsA.returnPct)} |`,
      `| Drawdown máximo por fechamento | ${mdPct(
        statsA.maxDrawdownPct,
      )} |`,
      `| Drawdown atual por fechamento | ${mdPct(
        statsA.currentDrawdownPct,
      )} |`,
      `| Tempo abaixo de um topo anterior | ${mdNumber(
        statsA.timeInDrawdownPct,
        0,
      )}% |`,
      `| Volatilidade média anualizada | ${mdNumber(
        statsA.annualVolPct,
        1,
      )}% |`,
      `| Volatilidade atual anualizada | ${mdNumber(
        statsA.currentVolPct,
        1,
      )}% |`,
      `| Regime | ${statsA.regime} |`,
      `| Sharpe anualizado da amostra | ${mdNumber(
        statsA.sharpe,
      )} |`,
      `| Retornos positivos | ${mdNumber(statsA.pctPositive, 0)}% |`,
      `| Melhor candle | ${mdPct(statsA.bestCandlePct)} |`,
      `| Pior candle | ${mdPct(statsA.worstCandlePct)} |`,
      `| Máxima intraperíodo | ${mdPrice(statsA.periodHigh)} USDT |`,
      `| Mínima intraperíodo | ${mdPrice(statsA.periodLow)} USDT |`,
      `| Amplitude máxima/mínima | ${mdNumber(
        statsA.amplitudePct,
      )}% |`,
      `| Volume financeiro médio no período visível | ${mdNumber(
        statsA.averageQuoteVolume,
        2,
      )} USDT |`,
      `| Volume financeiro do último candle | ${mdNumber(
        statsA.lastQuoteVolume,
        2,
      )} USDT |`,
    ];

    if (statsB) {
      lines.push(
        '',
        `## Comparação com ${statsB.symbol}`,
        '',
        `- **Candles visíveis:** ${statsB.candleCount}`,
        `- **Retornos alinhados usados na correlação:** ${Math.max(
          0,
          alignedPairCount - 1,
        )}`,
        `- **Candles ausentes dentro da janela visível:** ${countMissingCandles(
          derived.visibleB,
        )}`,
        '',
        '| Métrica | Valor |',
        '|---|---:|',
        `| Último fechamento | ${mdPrice(statsB.lastPrice)} USDT |`,
        `| Retorno no período | ${mdPct(statsB.returnPct)} |`,
        `| Drawdown máximo por fechamento | ${mdPct(
          statsB.maxDrawdownPct,
        )} |`,
        `| Drawdown atual por fechamento | ${mdPct(
          statsB.currentDrawdownPct,
        )} |`,
        `| Tempo abaixo de um topo anterior | ${mdNumber(
          statsB.timeInDrawdownPct,
          0,
        )}% |`,
        `| Volatilidade atual anualizada | ${mdNumber(
          statsB.currentVolPct,
          1,
        )}% |`,
        `| Regime | ${statsB.regime} |`,
        `| Sharpe anualizado da amostra | ${mdNumber(
          statsB.sharpe,
        )} |`,
        `| Correlação dos retornos | ${
          derived.correlation === null
            ? 'indisponível'
            : `${mdNumber(derived.correlation, 4)} (${correlationText(
                derived.correlation,
              )})`
        } |`,
      );
    }

    lines.push('', '## Indicadores determinísticos', '');

    if (indicators) {
      lines.push(
        '| Indicador | Valor |',
        '|---|---:|',
        `| Candles totais / mínimo necessário | ${indicators.candleCount} / ${indicators.requiredCandles} |`,
        `| EMA ${indicators.options.emaFastPeriod} | ${mdPrice(
          indicators.emaFast,
        )} USDT |`,
        `| EMA ${indicators.options.emaMediumPeriod} | ${mdPrice(
          indicators.emaMedium,
        )} USDT |`,
        `| EMA ${indicators.options.emaSlowPeriod} | ${mdPrice(
          indicators.emaSlow,
        )} USDT |`,
        `| ATR ${indicators.options.atrPeriod} | ${mdPrice(
          indicators.atr,
        )} USDT |`,
        `| ATR sobre o preço | ${mdNumber(indicators.atrPct, 4)}% |`,
        `| Nível de rompimento | ${mdPrice(
          indicators.breakoutLevel,
        )} USDT |`,
        `| Suporte de referência | ${mdPrice(
          indicators.supportLevel,
        )} USDT |`,
        `| Distância até o rompimento | ${mdPct(
          indicators.distanceToBreakoutPct,
          4,
        )} |`,
        `| Distância da EMA lenta | ${mdPct(
          indicators.distanceFromSlowEmaPct,
          4,
        )} |`,
        `| Volume base do candle atual | ${mdNumber(
          indicators.currentVolume,
          4,
        )} |`,
        `| Volume base médio da janela anterior | ${mdNumber(
          indicators.averageVolume,
          4,
        )} |`,
        `| Volume relativo | ${mdNumber(
          indicators.relativeVolume,
          4,
        )}x |`,
        `| Volatilidade anualizada do indicador | ${mdNumber(
          indicators.annualizedVolatilityPct,
          2,
        )}% |`,
        `| Regime de volatilidade | ${indicators.volatilityRegime} |`,
        `| Percentil de volatilidade | ${mdNumber(
          indicators.volatilityPercentile,
          2,
        )}% |`,
        `| Distância até o rompimento em ATR | ${mdNumber(
          evaluation?.diagnostics.distanceToBreakoutAtr,
          4,
        )} ATR |`,
      );
    } else {
      lines.push('Indicadores indisponíveis para este snapshot.');
    }

    lines.push('', '## Checklist oficial do playbook', '');

    if (evaluation) {
      lines.push(
        `- **Estratégia:** ${evaluation.strategy}`,
        `- **Versão:** ${evaluation.strategyVersion}`,
        `- **Status:** ${statusLabel} (\`${evaluation.status}\`)`,
        `- **Condições atendidas:** ${evaluation.passedConditions} de ${evaluation.totalConditions}`,
        `- **Pontuação do checklist:** ${mdNumber(
          evaluation.scorePct,
          2,
        )}%`,
        `- **Resumo determinístico:** ${evaluation.summary}`,
        `- **Próximo gatilho completo:** ${evaluation.nextTrigger}`,
        `- **Condições ainda pendentes:** ${
          pendingConditions.length
            ? pendingConditions
                .map(
                  (condition) =>
                    `${condition.label} — ${condition.requiredValue}`,
                )
                .join('; ')
            : 'nenhuma'
        }`,
        '',
        '| Resultado | Condição | Valor atual | Exigência | Explicação |',
        '|:---:|---|---:|---|---|',
      );

      for (const condition of evaluation.conditions) {
        lines.push(
          `| ${
            condition.available
              ? condition.passed
                ? '✅'
                : '❌'
              : '⚪'
          } | ${cleanCell(condition.label)} | ${cleanCell(
            formatConditionValue(condition.currentValue),
          )} | ${cleanCell(condition.requiredValue)} | ${cleanCell(
            condition.explanation,
          )} |`,
        );
      }

      if (evaluation.warnings.length) {
        lines.push('', '**Avisos do motor determinístico:**');
        for (const warning of evaluation.warnings) {
          lines.push(`- ${warning}`);
        }
      }
    } else {
      lines.push('O checklist ainda não foi calculado.');
    }

    lines.push('', planHeading, '', planExplanation, '');

    if (plan) {
      lines.push(
        '| Parâmetro | Valor |',
        '|---|---:|',
        `| Natureza do plano | ${
          planIsCurrentlyExecutable
            ? 'confirmado no candle encerrado'
            : planWasConfirmed
              ? 'confirmado anteriormente, mas não executável no status atual'
              : 'simulação prévia não confirmada'
        } |`,
        `| Direção modelada | ${plan.direction} |`,
        `| Entrada de referência | ${mdPrice(
          plan.entryReference,
        )} USDT |`,
        `| Invalidação / stop de referência | ${mdPrice(
          plan.stopReference,
        )} USDT |`,
        `| Alvo matemático | ${mdPrice(
          plan.targetReference,
        )} USDT |`,
        `| Risco por unidade | ${mdPrice(plan.riskPerUnit)} USDT |`,
        `| Retorno bruto por unidade | ${mdPrice(
          plan.rewardPerUnit,
        )} USDT |`,
        `| Relação risco-retorno bruta | ${mdNumber(
          plan.riskRewardRatio,
          2,
        )}R |`,
        `| Distância do stop | ${mdNumber(
          plan.stopDistancePct,
          4,
        )}% |`,
        `| Distância do alvo | ${mdNumber(
          plan.targetDistancePct,
          4,
        )}% |`,
        `| Stop em múltiplos de ATR | ${mdNumber(
          plan.stopDistanceAtr,
          4,
        )} ATR |`,
      );

      if (planWasConfirmed) {
        lines.push(
          `| Limite de entrada calculado para o setup confirmado | ${mdPrice(
            plan.latestAcceptableEntry,
          )} USDT |`,
        );
      }

      lines.push(
        '',
        '### Estimativa de custos sobre o plano',
        '',
        `- **Taxa hipotética por execução:** ${mdNumber(
          assumedFeeRatePct,
          4,
        )}%`,
        `- **Slippage adversa hipotética por execução:** ${mdNumber(
          assumedSlippagePct,
          4,
        )}%`,
        '- **Aplicação:** entrada e saída',
      );

      if (costEstimate?.valid) {
        lines.push(
          `- **Relação risco-retorno bruta:** ${mdNumber(
            costEstimate.grossRiskRewardRatio,
            4,
          )}R`,
          `- **Relação risco-retorno líquida estimada:** ${mdNumber(
            costEstimate.estimatedNetRiskRewardRatio,
            4,
          )}R`,
          `- **Risco estimado por unidade com custos:** ${mdPrice(
            costEstimate.estimatedRiskPerUnit,
          )} USDT`,
          `- **Retorno líquido estimado por unidade:** ${mdPrice(
            costEstimate.estimatedNetRewardPerUnit,
          )} USDT`,
        );
      } else {
        lines.push(
          '- Não foi possível estimar o risco-retorno líquido com as premissas de custo.',
        );
      }
    } else {
      lines.push(
        'Não foi possível construir nem mesmo uma simulação matemática com os dados atuais.',
      );
    }

    lines.push('', '## Dimensionamento educacional', '');

    if (!planIsCurrentlyExecutable && evaluation) {
      lines.push(
        `O dimensionamento foi bloqueado porque o status atual é **${statusLabel}**. Ele só é liberado quando o candle encerrado está em \`condicoes_atendidas\`.`,
      );
    } else if (positionSizing?.ok) {
      lines.push(
        '| Parâmetro | Valor |',
        '|---|---:|',
        `| Saldo informado | ${mdNumber(
          positionSizing.accountBalance,
        )} USDT |`,
        `| Saldo disponível informado | ${mdNumber(
          positionSizing.availableBalance,
        )} USDT |`,
        `| Risco configurado | ${mdNumber(
          positionSizing.riskPercent,
          2,
        )}% |`,
        `| Quantidade máxima estimada | ${mdNumber(
          positionSizing.quantity,
          8,
        )} |`,
        `| Valor da posição | ${mdNumber(
          positionSizing.notional,
        )} USDT |`,
        `| Perda total estimada no stop | ${mdNumber(
          positionSizing.estimatedTotalRiskUsdt,
        )} USDT |`,
        `| Risco efetivo | ${mdNumber(
          positionSizing.estimatedTotalRiskPct,
          4,
        )}% |`,
        `| Retorno líquido estimado | ${mdNumber(
          positionSizing.estimatedNetRewardUsdt,
        )} USDT |`,
        `| Relação risco-retorno líquida | ${mdNumber(
          positionSizing.estimatedNetRiskRewardRatio,
          4,
        )}R |`,
        `| Taxa por execução usada | ${mdNumber(
          positionSizing.feeRatePct,
          4,
        )}% |`,
        `| Slippage por execução usado | ${mdNumber(
          positionSizing.slippagePct,
          4,
        )}% |`,
      );

      if (positionSizing.warnings.length) {
        lines.push(
          '',
          `- **Avisos:** ${positionSizing.warnings.join(' ')}`,
        );
      }
    } else if (positionSizing) {
      lines.push(
        `O dimensionamento não ficou disponível: ${positionSizing.errors.join(
          ' ',
        )}`,
      );
    } else {
      lines.push(
        'O dimensionamento está indisponível porque não existe um setup confirmado e executável.',
      );
    }

    lines.push('', '## Persistência e alerta', '');

    lines.push(
      `- **Setup salvo no servidor:** ${serverSetup ? 'sim' : 'não'}`,
      `- **Status salvo:** ${
        serverSetup
          ? TREND_BREAKOUT_STATUS_LABELS[serverSetup.status]?.label ??
            serverSetup.status
          : '—'
      }`,
      `- **Regra de alerta:** ${
        alertRule
          ? alertRule.ativo
            ? 'ativa'
            : 'pausada'
          : 'não configurada'
      }`,
      `- **Status monitorados:** ${
        alertRule ? alertRule.notify_statuses.join(', ') : '—'
      }`,
      `- **Cooldown:** ${
        alertRule ? `${alertRule.cooldown_minutes} minutos` : '—'
      }`,
      `- **Último status observado pelo alerta:** ${
        alertRule?.last_status ?? '—'
      }`,
      `- **Último disparo:** ${mdDate(
        alertRule?.last_triggered_at,
      )}`,
    );

    lines.push('', '## Backtest exibido na página', '');

    if (metrics && backtestResponse) {
      lines.push(
        `- **Símbolo:** ${backtestResponse.symbol}`,
        `- **Timeframe:** ${backtestResponse.timeframe}`,
        `- **Candles solicitados:** ${backtestResponse.requested_candles}`,
        `- **Tempo de execução:** ${backtestResponse.execution_ms} ms`,
        `- **Taxa configurada por execução:** ${mdNumber(
          parseUserNumber(backtestFeeRate),
          4,
        )}%`,
        `- **Slippage configurada por execução:** ${mdNumber(
          parseUserNumber(backtestSlippage),
          4,
        )}%`,
        '',
        '| Métrica | Valor |',
        '|---|---:|',
        `| Capital inicial | ${mdNumber(
          metrics.initialCapitalUsdt,
        )} USDT |`,
        `| Capital final | ${mdNumber(
          metrics.finalCapitalUsdt,
        )} USDT |`,
        `| PnL líquido | ${mdNumber(metrics.netPnlUsdt)} USDT |`,
        `| Retorno líquido | ${mdPct(metrics.netReturnPct)} |`,
        `| Sinais encontrados | ${metrics.signals} |`,
        `| Operações realizadas | ${metrics.totalTrades} |`,
        `| Sinais ignorados | ${metrics.skippedSignals} |`,
        `| Vitórias / derrotas / empates | ${metrics.wins} / ${metrics.losses} / ${metrics.breakeven} |`,
        `| Taxa de acerto | ${mdNumber(metrics.winRatePct)}% |`,
        `| Fator de lucro | ${mdNumber(
          metrics.profitFactor,
          4,
        )} |`,
        `| Média por operação | ${mdNumber(
          metrics.averagePnlUsdt,
        )} USDT |`,
        `| Média em R | ${mdNumber(metrics.averageR, 4)}R |`,
        `| Melhor / pior resultado | ${mdNumber(
          metrics.bestR,
          4,
        )}R / ${mdNumber(metrics.worstR, 4)}R |`,
        `| Drawdown máximo | ${mdPct(
          metrics.maximumDrawdownPct,
        )} |`,
        `| Maior sequência de perdas | ${metrics.maximumConsecutiveLosses} |`,
        `| Exposição | ${mdNumber(metrics.exposurePct)}% |`,
      );

      if (backtestTrades.length) {
        lines.push(
          '',
          '### Últimas operações mostradas no backtest',
          '',
          '| Entrada | Saída | Resultado | Motivo | PnL líquido | R |',
          '|---|---|---|---|---:|---:|',
        );

        for (const trade of backtestTrades) {
          lines.push(
            `| ${mdDate(trade.entryTime)} | ${mdDate(
              trade.exitTime,
            )} | ${trade.result} | ${backtestExitLabel(
              trade.exitReason,
            )} | ${mdNumber(trade.netPnlUsdt)} USDT | ${mdNumber(
              trade.resultR,
              4,
            )}R |`,
          );
        }
      }

      if (backtestResponse.result.warnings.length) {
        lines.push('', '**Avisos do backtest:**');
        for (const warning of backtestResponse.result.warnings) {
          lines.push(`- ${warning}`);
        }
      }
    } else {
      lines.push(
        'Nenhum backtest foi executado nesta sessão. Sem backtest, não há evidência histórica da frequência, dos custos, da taxa de acerto ou do drawdown da estratégia.',
      );
    }

    lines.push('', '## Diário carregado na página', '');

    if (journal.length) {
      lines.push(
        '| Data | Ativo | Modo | Status | Entrada | Saída | PnL | R |',
        '|---|---|---|---|---:|---:|---:|---:|',
      );

      for (const item of journal) {
        lines.push(
          `| ${mdDate(item.criado_em)} | ${item.symbol}/${
            item.timeframe
          } | ${item.mode} | ${cleanCell(
            journalStatusLabel(item.status),
          )} | ${mdPrice(
            nullableNumber(item.entry_price),
          )} | ${mdPrice(
            nullableNumber(item.exit_price),
          )} | ${mdNumber(
            nullableNumber(item.pnl_usdt),
          )} USDT | ${mdNumber(
            nullableNumber(item.result_r),
            4,
          )}R |`,
        );
      }
    } else {
      lines.push('Nenhum registro de diário foi carregado.');
    }

    lines.push(
      '',
      '## Relatório explicativo do VigIA',
      '',
      report
        ? report
        : 'O relatório interno com IA não foi gerado. Use as métricas, as condições pendentes e as limitações acima para fazer uma revisão independente.',
      '',
      '## Perguntas sugeridas para a IA revisora',
      '',
      '1. O status oficial é coerente com todas as condições aprovadas e reprovadas?',
      '2. O próximo gatilho inclui rompimento, volume e manutenção das demais condições?',
      '3. O plano está corretamente classificado como confirmado, atrasado, invalidado ou apenas simulado?',
      '4. Entrada, stop, alvo, ATR e relação risco-retorno bruta são matematicamente consistentes?',
      '5. As taxas e a slippage tornam a relação risco-retorno líquida aceitável apenas para continuar em teste?',
      '6. O Sharpe foi interpretado como uma anualização instável de amostra curta, e não como qualidade comprovada?',
      '7. O backtest possui amostra, custos e drawdown suficientes para continuar sendo avaliado?',
      '',
      '> Os números deste snapshot descrevem dados históricos e regras do sistema. Eles não antecipam o próximo movimento e não constituem recomendação de investimento.',
    );

    const markdown = lines.join('\n');

    setCopyAction({
      status: 'loading',
      message: 'Preparando o Markdown...',
    });

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = markdown;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();

        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (!copied) {
          throw new Error(
            'O navegador recusou o acesso à área de transferência.',
          );
        }
      }

      setCopyAction({
        status: 'success',
        message:
          `Markdown completo copiado (${markdown.length.toLocaleString(
            'pt-BR',
          )} caracteres). Cole na IA de sua preferência.`,
      });
    } catch (copyError) {
      setCopyAction({
        status: 'error',
        message:
          copyError instanceof Error
            ? `Não foi possível copiar: ${copyError.message}`
            : 'Não foi possível copiar o Markdown.',
      });
    }
  }, [
    derived.statsA,
    derived.statsB,
    derived.visibleA,
    derived.visibleB,
    derived.correlation,
    setupAnalysis.evaluation,
    setupAnalysis.indicators,
    backtestResponse,
    rawA,
    usedSymbolA,
    usedSymbolB,
    usedTimeframe,
    usedPeriod.label,
    usedPeriod.durationMs,
    liveA,
    positionSizing,
    serverSetup,
    alertRule,
    journal,
    report,
    backtestFeeRate,
    backtestSlippage,
  ]);

  const clearHistory = () => {
    setHistory([]);
    latestHistoryIdRef.current = null;
    window.localStorage.removeItem(HISTORY_KEY);
  };

  const onTimeframeChange = (value: string) => {
    const next = value as Timeframe;
    setTimeframe(next);
    setPeriodIndex(Math.min(1, TIMEFRAMES[next].periods.length - 1));
  };

  const select = (
    value: string,
    onChange: (value: string) => void,
    options: { value: string; label: string }[],
  ) => (
    <select
      value={value}
      onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
        onChange(event.target.value)
      }
      style={{
        background: S.bg,
        border: `1px solid ${S.border}`,
        borderRadius: 6,
        color: S.text,
        padding: '8px 10px',
        fontSize: 14,
        textAlign: 'center',
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  const currentPeriods = TIMEFRAMES[timeframe].periods;
  const statsA = derived.statsA;
  const statsB = derived.statsB;
  const correlationValue = derived.correlation;

  const metricRows: {
    label: string;
    tip: string;
    get: (stats: IntradayStats) => string;
    color?: (stats: IntradayStats) => string;
  }[] = [
    {
      label: 'Último fechamento (USDT)',
      tip: 'Fechamento do candle encerrado mais recente.',
      get: (stats) => fmtPrice(stats.lastPrice),
    },
    {
      label: 'Retorno no período',
      tip: 'Variação entre o primeiro e o último fechamento visível.',
      get: (stats) => fmtPct(stats.returnPct),
      color: (stats) => stats.returnPct >= 0 ? S.green : S.red,
    },
    {
      label: 'Drawdown máximo',
      tip: 'Maior queda de um topo até um fechamento posterior dentro do período.',
      get: (stats) => fmtPct(stats.maxDrawdownPct),
      color: () => S.red,
    },
    {
      label: 'Drawdown atual',
      tip: 'Distância do último fechamento para o maior topo anterior.',
      get: (stats) => fmtPct(stats.currentDrawdownPct),
      color: (stats) => stats.currentDrawdownPct < -0.5 ? S.red : S.dim,
    },
    {
      label: 'Tempo abaixo de um topo',
      tip: 'Percentual dos candles em drawdown, não significa queda contínua.',
      get: (stats) => `${fmt(stats.timeInDrawdownPct, 0)}%`,
    },
    {
      label: 'Volatilidade média anualizada',
      tip: `Média histórica da ${TIMEFRAMES[usedTimeframe].volWindowLabel}.`,
      get: (stats) => `${fmt(stats.annualVolPct, 0)}%`,
    },
    {
      label: 'Volatilidade atual anualizada',
      tip: `Última ${TIMEFRAMES[usedTimeframe].volWindowLabel} encerrada.`,
      get: (stats) => `${fmt(stats.currentVolPct, 0)}%`,
    },
    {
      label: 'Sharpe anualizado da amostra (rf = 0)',
      tip: 'Retorno médio por unidade de volatilidade, anualizado. Em amostras intradiárias curtas é estatisticamente instável e não mede todo o risco.',
      get: (stats) => fmt(stats.sharpe),
      color: (stats) => stats.sharpe >= 0 ? S.green : S.red,
    },
    {
      label: 'Candles positivos',
      tip: 'Percentual de retornos entre fechamentos consecutivos acima de zero.',
      get: (stats) => `${fmt(stats.pctPositive, 0)}%`,
    },
    {
      label: 'Melhor candle',
      tip: 'Maior retorno entre dois fechamentos consecutivos.',
      get: (stats) => fmtPct(stats.bestCandlePct),
      color: () => S.green,
    },
    {
      label: 'Pior candle',
      tip: 'Menor retorno entre dois fechamentos consecutivos.',
      get: (stats) => fmtPct(stats.worstCandlePct),
      color: () => S.red,
    },
    {
      label: 'Máxima do período',
      tip: 'Maior máxima registrada nos candles visíveis.',
      get: (stats) => `${fmtPrice(stats.periodHigh)} USDT`,
    },
    {
      label: 'Mínima do período',
      tip: 'Menor mínima registrada nos candles visíveis.',
      get: (stats) => `${fmtPrice(stats.periodLow)} USDT`,
    },
    {
      label: 'Amplitude máxima × mínima',
      tip: 'Distância percentual entre a mínima e a máxima do período.',
      get: (stats) => `${fmt(stats.amplitudePct)}%`,
    },
    {
      label: 'Volume médio por candle',
      tip: 'Volume financeiro médio cotado em USDT.',
      get: (stats) => `${fmtCompactUsdt(stats.averageQuoteVolume)} USDT`,
    },
  ];

  const tooltipStyle = {
    background: S.panel,
    border: `1px solid ${S.border}`,
    borderRadius: 8,
    color: S.text,
    fontSize: 12,
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        background: S.bg,
        color: S.text,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <header
        style={{
          borderBottom: `1px solid ${S.border}`,
          background: S.panel,
          padding: '12px 20px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="VigIA Trade"
            style={{ height: 32, width: 'auto', display: 'block' }}
          />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>
              Day Trade
            </div>
            <div style={{ fontSize: 11, color: S.dim }}>
              candles encerrados · atualização ao vivo · decisão sua
            </div>
          </div>
        </div>

        <nav
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 20,
            marginTop: 8,
            fontSize: 13,
            flexWrap: 'wrap',
          }}
        >
          <a href="/" style={{ color: S.dim, textDecoration: 'none' }}>
            Análise
          </a>
          <span style={{ color: S.b, fontWeight: 700 }}>Day Trade</span>
          <a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>
            Alertas
          </a>
          <a href="/conta" style={{ color: S.dim, textDecoration: 'none' }}>
            Conta Binance
          </a>
          {!session ? (
            <a href="/alertas" style={{ color: S.green, textDecoration: 'none' }}>
              Entrar
            </a>
          ) : (
            <button
              onClick={() => supabase.auth.signOut()}
              style={{
                background: 'transparent',
                border: 'none',
                color: S.red,
                fontSize: 13,
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
              }}
            >
              Sair
            </button>
          )}
        </nav>
      </header>

      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
            gap: 12,
          }}
        >
          <Card style={{ textAlign: 'center', padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase' }}>
              Conexão de mercado
            </div>
            <div
              style={{
                marginTop: 5,
                fontSize: 15,
                fontWeight: 700,
                color: webSocketStatus === 'ao vivo' ? S.green : S.yellow,
              }}
            >
              {webSocketStatus === 'ao vivo' ? '● AO VIVO' : webSocketStatus}
            </div>
            {lastWebSocketUpdate && (
              <div style={{ color: S.dim, fontSize: 10, marginTop: 3 }}>
                última atualização{' '}
                {new Date(lastWebSocketUpdate).toLocaleTimeString('pt-BR')}
              </div>
            )}
          </Card>

          <Card style={{ textAlign: 'center', padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase' }}>
              {usedSymbolA} agora
            </div>
            <div style={{ marginTop: 5, fontSize: 18, fontWeight: 700, color: S.a }}>
              {liveA ? `${fmtPrice(liveA.close)} USDT` : statsA ? `${fmtPrice(statsA.lastPrice)} USDT` : '—'}
            </div>
            <div style={{ color: S.dim, fontSize: 10, marginTop: 3 }}>
              {liveA ? 'candle em formação' : 'último candle encerrado'}
            </div>
          </Card>

          {usedSymbolB !== 'nenhum' && (
            <Card style={{ textAlign: 'center', padding: '12px 16px' }}>
              <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase' }}>
                {usedSymbolB} agora
              </div>
              <div style={{ marginTop: 5, fontSize: 18, fontWeight: 700, color: S.b }}>
                {liveB ? `${fmtPrice(liveB.close)} USDT` : statsB ? `${fmtPrice(statsB.lastPrice)} USDT` : '—'}
              </div>
              <div style={{ color: S.dim, fontSize: 10, marginTop: 3 }}>
                {liveB ? 'candle em formação' : 'último candle encerrado'}
              </div>
            </Card>
          )}

          <Card style={{ textAlign: 'center', padding: '12px 16px' }}>
            <div style={{ fontSize: 11, color: S.dim, textTransform: 'uppercase' }}>
              Histórico separado
            </div>
            <div style={{ marginTop: 5, fontSize: 18, fontWeight: 700 }}>
              {history.length}
            </div>
            <div style={{ color: S.dim, fontSize: 10, marginTop: 3 }}>
              salvo neste navegador
            </div>
          </Card>
        </div>

        <p
          style={{
            color: S.dim,
            fontSize: 13,
            margin: '0 auto',
            maxWidth: 850,
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          As métricas usam somente candles encerrados. O WebSocket mostra o preço
          do candle em formação, mas ele só entra oficialmente nos cálculos após o
          fechamento. A volatilidade usa uma janela de 24 horas e é anualizada para
          facilitar comparações; ela mede amplitude, não direção.
        </p>

        <Card
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Ativo A
            {select(
              symbolA,
              setSymbolA,
              SYMBOLS
                .filter((symbol) => symbol !== 'nenhum')
                .map((symbol) => ({ value: symbol, label: symbol })),
            )}
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Ativo B (comparação)
            {select(
              symbolB,
              setSymbolB,
              SYMBOLS.map((symbol) => ({ value: symbol, label: symbol })),
            )}
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Timeframe
            {select(
              timeframe,
              onTimeframeChange,
              (Object.keys(TIMEFRAMES) as Timeframe[]).map((key) => ({
                value: key,
                label: TIMEFRAMES[key].label,
              })),
            )}
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
            Período
            {select(
              String(Math.min(periodIndex, currentPeriods.length - 1)),
              (value) => setPeriodIndex(Number(value)),
              currentPeriods.map((period, index) => ({
                value: String(index),
                label: period.label,
              })),
            )}
          </label>

          <button
            onClick={() => run()}
            disabled={status === 'loading'}
            style={{
              background: S.b,
              color: '#07111d',
              border: 'none',
              borderRadius: 8,
              padding: '10px 22px',
              fontSize: 14,
              fontWeight: 700,
              cursor: status === 'loading' ? 'wait' : 'pointer',
              opacity: status === 'loading' ? 0.65 : 1,
            }}
          >
            {status === 'loading' ? progress || 'Carregando...' : 'Analisar Day Trade'}
          </button>

          {status === 'error' && (
            <span style={{ color: S.red, fontSize: 13, flexBasis: '100%', textAlign: 'center' }}>
              {error}
            </span>
          )}
        </Card>

        {status === 'done' && setupAnalysis.evaluation && (
          <>
            <Card
              style={{
                borderColor: `${SETUP_STATUS_COLORS[setupAnalysis.evaluation.status]}88`,
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 16,
                  alignItems: 'center',
                }}
              >
                <div style={{ textAlign: 'center' }}>
                  <div
                    style={{
                      color: S.dim,
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.7,
                      marginBottom: 8,
                    }}
                  >
                    Playbook: tendência com rompimento
                  </div>
                  <SetupStatusBadge status={setupAnalysis.evaluation.status} />
                  <div
                    style={{
                      color: S.text,
                      fontSize: 14,
                      lineHeight: 1.5,
                      marginTop: 10,
                    }}
                  >
                    {setupAnalysis.evaluation.summary}
                  </div>
                </div>

                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: S.dim, fontSize: 11, textTransform: 'uppercase' }}>
                    Condições atendidas
                  </div>
                  <div
                    style={{
                      fontSize: 30,
                      fontWeight: 800,
                      marginTop: 4,
                      color: SETUP_STATUS_COLORS[setupAnalysis.evaluation.status],
                    }}
                  >
                    {setupAnalysis.evaluation.passedConditions}/{setupAnalysis.evaluation.totalConditions}
                  </div>
                  <div
                    style={{
                      height: 8,
                      maxWidth: 220,
                      margin: '9px auto 0',
                      borderRadius: 999,
                      overflow: 'hidden',
                      background: S.bg,
                      border: `1px solid ${S.border}`,
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.max(0, Math.min(100, setupAnalysis.evaluation.scorePct))}%`,
                        background: SETUP_STATUS_COLORS[setupAnalysis.evaluation.status],
                      }}
                    />
                  </div>
                  <div style={{ color: S.dim, fontSize: 11, marginTop: 5 }}>
                    {fmt(setupAnalysis.evaluation.scorePct, 0)}% do checklist
                  </div>
                </div>

                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: S.dim, fontSize: 11, textTransform: 'uppercase' }}>
                    Próxima condição
                  </div>
                  <div
                    style={{
                      color: S.text,
                      fontSize: 13,
                      lineHeight: 1.5,
                      marginTop: 7,
                    }}
                  >
                    {setupAnalysis.evaluation.nextTrigger}
                  </div>
                  <div style={{ color: S.dim, fontSize: 10, marginTop: 8 }}>
                    Candle avaliado:{' '}
                    {new Date(setupAnalysis.evaluation.candleCloseTime).toLocaleString('pt-BR')}
                  </div>
                </div>
              </div>

              {setupAnalysis.evaluation.warnings.length > 0 && (
                <div
                  style={{
                    marginTop: 14,
                    padding: '10px 12px',
                    background: `${S.yellow}12`,
                    border: `1px solid ${S.yellow}44`,
                    borderRadius: 8,
                    color: S.yellow,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {setupAnalysis.evaluation.warnings.map((warning) => (
                    <div key={warning}>• {warning}</div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: 'center',
                  marginBottom: 12,
                }}
              >
                Respostas diretas para quem está começando
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  gap: 10,
                }}
              >
                {setupQuestions.map((item) => (
                  <div
                    key={item.question}
                    style={{
                      background: S.panelSoft,
                      border: `1px solid ${S.border}`,
                      borderRadius: 8,
                      padding: 12,
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ color: S.dim, fontSize: 11 }}>
                      {item.question}
                    </div>
                    <div
                      style={{
                        color: item.positive ? S.green : S.yellow,
                        fontSize: 16,
                        fontWeight: 800,
                        marginTop: 5,
                      }}
                    >
                      {item.answer}
                    </div>
                    <div
                      style={{
                        color: S.dim,
                        fontSize: 10,
                        lineHeight: 1.4,
                        marginTop: 5,
                      }}
                    >
                      {item.detail}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card style={{ overflowX: 'auto' }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  textAlign: 'center',
                  marginBottom: 10,
                }}
              >
                Checklist objetivo do playbook
              </div>
              <table
                style={{
                  width: '100%',
                  minWidth: 760,
                  borderCollapse: 'collapse',
                  fontSize: 12,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ padding: 9, color: S.dim, borderBottom: `1px solid ${S.border}` }}>Status</th>
                    <th style={{ padding: 9, color: S.dim, borderBottom: `1px solid ${S.border}` }}>Condição</th>
                    <th style={{ padding: 9, color: S.dim, borderBottom: `1px solid ${S.border}` }}>Valor atual</th>
                    <th style={{ padding: 9, color: S.dim, borderBottom: `1px solid ${S.border}` }}>Necessário</th>
                    <th style={{ padding: 9, color: S.dim, borderBottom: `1px solid ${S.border}` }}>Explicação</th>
                  </tr>
                </thead>
                <tbody>
                  {setupAnalysis.evaluation.conditions.map((condition) => (
                    <tr key={condition.id}>
                      <td
                        style={{
                          padding: 9,
                          textAlign: 'center',
                          borderBottom: `1px solid ${S.border}`,
                          color: !condition.available
                            ? S.dim
                            : condition.passed
                              ? S.green
                              : S.red,
                          fontWeight: 800,
                        }}
                      >
                        {!condition.available ? '○' : condition.passed ? '✓' : '×'}
                      </td>
                      <td style={{ padding: 9, borderBottom: `1px solid ${S.border}`, color: S.text }}>
                        {condition.label}
                      </td>
                      <td style={{ padding: 9, textAlign: 'center', borderBottom: `1px solid ${S.border}`, color: S.text }}>
                        {formatConditionValue(condition.currentValue)}
                      </td>
                      <td style={{ padding: 9, textAlign: 'center', borderBottom: `1px solid ${S.border}`, color: S.dim }}>
                        {condition.requiredValue}
                      </td>
                      <td style={{ padding: 9, borderBottom: `1px solid ${S.border}`, color: S.dim, lineHeight: 1.4 }}>
                        {condition.explanation}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            {actionablePlan ? (
              <Card
                style={{
                  borderColor:
                    setupAnalysis.evaluation.status === 'condicoes_atendidas'
                      ? `${S.green}77`
                      : `${SETUP_STATUS_COLORS[setupAnalysis.evaluation.status]}66`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>
                      Plano técnico de referência
                    </div>
                    <div style={{ color: S.dim, fontSize: 11, marginTop: 3 }}>
                      Calculado pelo último candle encerrado. Não é uma ordem automática.
                    </div>
                  </div>
                  <SetupStatusBadge status={setupAnalysis.evaluation.status} />
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))',
                    gap: 10,
                  }}
                >
                  {[
                    ['Entrada de referência', `${fmtPrice(actionablePlan.entryReference)} USDT`, S.a],
                    ['Invalidação / stop', `${fmtPrice(actionablePlan.stopReference)} USDT`, S.red],
                    ['Alvo matemático', `${fmtPrice(actionablePlan.targetReference)} USDT`, S.green],
                    ['Relação alvo/risco', `${fmt(actionablePlan.riskRewardRatio)}R`, S.text],
                    ['Risco por unidade', `${fmtPrice(actionablePlan.riskPerUnit)} USDT`, S.text],
                    ['Entrada aceitável até', `${fmtPrice(actionablePlan.latestAcceptableEntry)} USDT`, S.yellow],
                  ].map(([label, value, color]) => (
                    <div
                      key={String(label)}
                      style={{
                        background: S.panelSoft,
                        border: `1px solid ${S.border}`,
                        borderRadius: 8,
                        padding: 12,
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ color: S.dim, fontSize: 10, textTransform: 'uppercase' }}>
                        {label}
                      </div>
                      <div style={{ color, fontSize: 15, fontWeight: 800, marginTop: 5 }}>
                        {value}
                      </div>
                    </div>
                  ))}
                </div>

                {setupAnalysis.evaluation.status !== 'condicoes_atendidas' && (
                  <div
                    style={{
                      marginTop: 12,
                      color: SETUP_STATUS_COLORS[setupAnalysis.evaluation.status],
                      background: `${SETUP_STATUS_COLORS[setupAnalysis.evaluation.status]}12`,
                      border: `1px solid ${SETUP_STATUS_COLORS[setupAnalysis.evaluation.status]}44`,
                      borderRadius: 8,
                      padding: 11,
                      textAlign: 'center',
                      fontSize: 12,
                    }}
                  >
                    O plano está visível para explicar a formação, mas uma nova entrada está bloqueada no status atual.
                  </div>
                )}

                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: `1px solid ${S.border}`,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, textAlign: 'center', marginBottom: 12 }}>
                    Calculadora educacional de tamanho da posição
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'flex-end',
                      justifyContent: 'center',
                      gap: 12,
                    }}
                  >
                    {[
                      {
                        label: 'Saldo total (USDT)',
                        value: accountBalance,
                        setter: setAccountBalance,
                        step: '0.01',
                      },
                      {
                        label: 'Saldo disponível (USDT)',
                        value: availableBalance,
                        setter: setAvailableBalance,
                        step: '0.01',
                      },
                      {
                        label: 'Risco máximo (%)',
                        value: riskPercent,
                        setter: setRiskPercent,
                        step: '0.1',
                      },
                    ].map((input) => (
                      <label
                        key={input.label}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 5,
                          color: S.dim,
                          fontSize: 11,
                          textAlign: 'center',
                        }}
                      >
                        {input.label}
                        <input
                          type="number"
                          min="0"
                          step={input.step}
                          value={input.value}
                          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                            input.setter(event.target.value)
                          }
                          style={{
                            width: 170,
                            maxWidth: '100%',
                            background: S.bg,
                            color: S.text,
                            border: `1px solid ${S.border}`,
                            borderRadius: 7,
                            padding: '9px 10px',
                            fontSize: 14,
                            textAlign: 'center',
                          }}
                        />
                      </label>
                    ))}
                  </div>

                  {positionSizing && (
                    <div style={{ marginTop: 14 }}>
                      {positionSizing.ok ? (
                        <>
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                              gap: 10,
                            }}
                          >
                            {[
                              ['Quantidade máxima', fmt(positionSizing.quantity, 8)],
                              ['Valor da posição', `${fmt(positionSizing.notional)} USDT`],
                              ['Perda máxima estimada', `${fmt(positionSizing.estimatedTotalRiskUsdt)} USDT`],
                              ['Risco efetivo', `${fmt(positionSizing.estimatedTotalRiskPct, 2)}%`],
                              ['Alvo líquido estimado', positionSizing.estimatedNetRewardUsdt === null ? '—' : `${fmt(positionSizing.estimatedNetRewardUsdt)} USDT`],
                              ['Risco/retorno líquido', positionSizing.estimatedNetRiskRewardRatio === null ? '—' : `${fmt(positionSizing.estimatedNetRiskRewardRatio)}R`],
                            ].map(([label, value]) => (
                              <div
                                key={label}
                                style={{
                                  background: S.panelSoft,
                                  border: `1px solid ${S.border}`,
                                  borderRadius: 8,
                                  padding: 10,
                                  textAlign: 'center',
                                }}
                              >
                                <div style={{ color: S.dim, fontSize: 10 }}>{label}</div>
                                <div style={{ color: S.text, fontSize: 14, fontWeight: 800, marginTop: 4 }}>
                                  {value}
                                </div>
                              </div>
                            ))}
                          </div>
                          {positionSizing.warnings.length > 0 && (
                            <div style={{ color: S.yellow, fontSize: 11, lineHeight: 1.5, marginTop: 10, textAlign: 'center' }}>
                              {positionSizing.warnings.join(' ')}
                            </div>
                          )}
                        </>
                      ) : (
                        <div
                          style={{
                            color: S.red,
                            background: `${S.red}12`,
                            border: `1px solid ${S.red}44`,
                            borderRadius: 8,
                            padding: 11,
                            fontSize: 12,
                            lineHeight: 1.5,
                            textAlign: 'center',
                          }}
                        >
                          {positionSizing.errors.join(' ')}
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ color: S.dim, fontSize: 10, textAlign: 'center', marginTop: 10, lineHeight: 1.4 }}>
                    Estimativa sem alavancagem. Taxas e slippage são considerados pelo motor de risco, mas os filtros exatos do ativo serão confirmados apenas na futura integração com a Testnet.
                  </div>
                </div>
              </Card>
            ) : (
              <Card style={{ textAlign: 'center' }}>
                <div style={{ color: S.dim, fontSize: 11, textTransform: 'uppercase' }}>
                  Plano de operação
                </div>
                <div style={{ color: S.text, fontSize: 14, marginTop: 7 }}>
                  Ainda não existe um plano válido de entrada, invalidação e alvo.
                </div>
                <div style={{ color: S.dim, fontSize: 11, marginTop: 5 }}>
                  {setupAnalysis.evaluation.nextTrigger}
                </div>
              </Card>
            )}
          </>
        )}

        {status === 'done' && setupAnalysis.error && (
          <Card style={{ borderColor: `${S.red}66`, color: S.red, textAlign: 'center' }}>
            Erro no playbook: {setupAnalysis.error}
          </Card>
        )}


        <Card>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 14,
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                Setup persistido e Binance Testnet
              </div>
              <div style={{ color: S.dim, fontSize: 11, marginTop: 3 }}>
                O servidor reavalia o candle encerrado antes de liberar qualquer prévia.
              </div>
            </div>
            {!session && (
              <a href="/alertas" style={{ color: S.green, fontSize: 12 }}>
                Entre para usar os recursos conectados
              </a>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: 12,
            }}
          >
            <div
              style={{
                background: S.panelSoft,
                border: `1px solid ${S.border}`,
                borderRadius: 9,
                padding: 14,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>1. Setup no servidor</div>
              <div style={{ color: S.dim, fontSize: 11, lineHeight: 1.5, marginTop: 5 }}>
                Salva uma fotografia auditável do checklist, indicadores, entrada, stop e alvo.
              </div>
              <button
                onClick={handlePersistSetup}
                disabled={!session || status !== 'done' || serverAction.status === 'loading'}
                style={{
                  width: '100%',
                  marginTop: 12,
                  background: S.b,
                  color: '#08131e',
                  border: 'none',
                  borderRadius: 7,
                  padding: '10px 12px',
                  fontWeight: 800,
                  cursor: !session || status !== 'done' ? 'not-allowed' : 'pointer',
                  opacity: !session || status !== 'done' ? 0.5 : 1,
                }}
              >
                {serverAction.status === 'loading' ? 'Salvando...' : 'Salvar ou atualizar setup'}
              </button>

              {serverSetup && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 8,
                    marginTop: 12,
                  }}
                >
                  {[
                    ['Mercado', `${serverSetup.symbol} · ${serverSetup.timeframe}`],
                    ['Status', TREND_BREAKOUT_STATUS_LABELS[serverSetup.status]?.label ?? serverSetup.status],
                    ['Checklist', `${serverSetup.score}/${serverSetup.total_conditions}`],
                    ['Candle', formatDateTime(serverSetup.candle_close_time)],
                  ].map(([label, value]) => (
                    <div key={label} style={{ textAlign: 'center' }}>
                      <div style={{ color: S.dim, fontSize: 10 }}>{label}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, marginTop: 3 }}>{value}</div>
                    </div>
                  ))}
                </div>
              )}

              {serverAction.message && (
                <div
                  style={{
                    marginTop: 10,
                    color: serverAction.status === 'error' ? S.red : serverAction.status === 'success' ? S.green : S.dim,
                    fontSize: 11,
                    lineHeight: 1.45,
                    textAlign: 'center',
                  }}
                >
                  {serverAction.message}
                </div>
              )}
            </div>

            <div
              style={{
                background: S.panelSoft,
                border: `1px solid ${S.border}`,
                borderRadius: 9,
                padding: 14,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>2. Ordem simulada na Testnet</div>
              <div style={{ color: S.dim, fontSize: 11, lineHeight: 1.5, marginTop: 5 }}>
                A prévia valida saldo, limite por ordem, filtros do ativo, atraso da entrada e risco máximo.
              </div>

              <button
                onClick={handlePreviewTestnet}
                disabled={!session || status !== 'done' || testnetAction.status === 'loading'}
                style={{
                  width: '100%',
                  marginTop: 12,
                  background: S.a,
                  color: '#1a1206',
                  border: 'none',
                  borderRadius: 7,
                  padding: '10px 12px',
                  fontWeight: 800,
                  cursor: !session || status !== 'done' ? 'not-allowed' : 'pointer',
                  opacity: !session || status !== 'done' ? 0.5 : 1,
                }}
              >
                {testnetAction.status === 'loading' ? 'Validando...' : 'Gerar prévia Testnet'}
              </button>

              {testnetPreview && (
                <>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: 8,
                      marginTop: 12,
                    }}
                  >
                    {[
                      ['Preço Testnet', `${fmtPrice(testnetPreview.market.testnet_price)} USDT`],
                      ['Valor da ordem', `${fmt(testnetPreview.execution.quote_amount)} USDT`],
                      ['Stop', `${fmtPrice(testnetPreview.plan.stop_reference)} USDT`],
                      ['Alvo', `${fmtPrice(testnetPreview.plan.target_reference)} USDT`],
                      ['Risco estimado', `${fmt(nullableNumber(testnetPreview.sizing.estimatedTotalRiskUsdt) ?? 0)} USDT`],
                      ['Expira em', formatDateTime(testnetPreview.setup.expires_at)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{
                          border: `1px solid ${S.border}`,
                          borderRadius: 7,
                          padding: 8,
                          textAlign: 'center',
                        }}
                      >
                        <div style={{ color: S.dim, fontSize: 9 }}>{label}</div>
                        <div style={{ fontSize: 12, fontWeight: 750, marginTop: 3 }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      marginTop: 12,
                      color: S.text,
                      fontSize: 11,
                      lineHeight: 1.45,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={confirmTestnet}
                      onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                        setConfirmTestnet(event.target.checked)
                      }
                      style={{ marginTop: 2 }}
                    />
                    Confirmo que esta ordem será enviada exclusivamente à Binance Spot Testnet e poderá gerar saldo e resultados simulados.
                  </label>

                  <button
                    onClick={handleExecuteTestnet}
                    disabled={!confirmTestnet || testnetAction.status === 'loading'}
                    style={{
                      width: '100%',
                      marginTop: 10,
                      background: confirmTestnet ? S.green : S.border,
                      color: confirmTestnet ? '#07140c' : S.dim,
                      border: 'none',
                      borderRadius: 7,
                      padding: '10px 12px',
                      fontWeight: 800,
                      cursor: confirmTestnet ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Confirmar ordem na Testnet
                  </button>
                </>
              )}

              {testnetAction.message && (
                <div
                  style={{
                    marginTop: 10,
                    color: testnetAction.status === 'error' ? S.red : testnetAction.status === 'success' ? S.green : S.dim,
                    fontSize: 11,
                    lineHeight: 1.45,
                    textAlign: 'center',
                  }}
                >
                  {testnetAction.message}
                </div>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Alertas automáticos do playbook</div>
              <div style={{ color: S.dim, fontSize: 11, marginTop: 3 }}>
                Mercado atual: {status === 'done' ? usedSymbolA : symbolA} · {status === 'done' ? usedTimeframe : timeframe}
              </div>
            </div>
            {alertRule && (
              <div style={{ color: alertRule.ativo ? S.green : S.dim, fontSize: 11, fontWeight: 700 }}>
                {alertRule.ativo ? '● REGRA ATIVA' : '○ REGRA PAUSADA'}
              </div>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              alignItems: 'start',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: S.text,
                fontSize: 12,
                paddingTop: 8,
              }}
            >
              <input
                type="checkbox"
                checked={alertEnabled}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setAlertEnabled(event.target.checked)
                }
              />
              Monitoramento ativo
            </label>

            <label style={{ color: S.dim, fontSize: 11, textAlign: 'center' }}>
              Cooldown em minutos
              <input
                type="number"
                min="0"
                max="1440"
                step="1"
                value={alertCooldownMinutes}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setAlertCooldownMinutes(event.target.value)
                }
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  marginTop: 5,
                  background: S.bg,
                  color: S.text,
                  border: `1px solid ${S.border}`,
                  borderRadius: 7,
                  padding: '8px 10px',
                  textAlign: 'center',
                }}
              />
            </label>

            <div style={{ gridColumn: '1 / -1' }}>
              <div style={{ color: S.dim, fontSize: 11, textAlign: 'center', marginBottom: 7 }}>
                Avisar quando o setup entrar em:
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 10 }}>
                {([
                  ['observar', 'Observar'],
                  ['condicoes_atendidas', 'Condições atendidas'],
                  ['entrada_atrasada', 'Entrada atrasada'],
                  ['invalidado', 'Invalidado'],
                ] as Array<[DayTradeAlertableStatus, string]>).map(([value, label]) => (
                  <label
                    key={value}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      border: `1px solid ${S.border}`,
                      borderRadius: 7,
                      padding: '7px 9px',
                      color: S.text,
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={alertNotifyStatuses.includes(value)}
                      onChange={() => toggleAlertStatus(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, flexWrap: 'wrap', marginTop: 13 }}>
            <button
              onClick={handleSaveAlertRule}
              disabled={!session || alertAction.status === 'loading'}
              style={{
                background: S.green,
                color: '#07140c',
                border: 'none',
                borderRadius: 7,
                padding: '9px 15px',
                fontWeight: 800,
                cursor: session ? 'pointer' : 'not-allowed',
                opacity: session ? 1 : 0.5,
              }}
            >
              {alertRule ? 'Atualizar alerta' : 'Criar alerta'}
            </button>
            {alertRule && (
              <button
                onClick={handleDeleteAlertRule}
                disabled={alertAction.status === 'loading'}
                style={{
                  background: 'transparent',
                  color: S.red,
                  border: `1px solid ${S.red}66`,
                  borderRadius: 7,
                  padding: '9px 15px',
                  cursor: 'pointer',
                }}
              >
                Remover regra
              </button>
            )}
          </div>

          {alertRule?.last_status && (
            <div style={{ color: S.dim, fontSize: 10, textAlign: 'center', marginTop: 9 }}>
              Último status: {TREND_BREAKOUT_STATUS_LABELS[alertRule.last_status]?.label ?? alertRule.last_status}
              {' · '}último disparo: {formatDateTime(alertRule.last_triggered_at)}
            </div>
          )}

          {alertAction.message && (
            <div
              style={{
                color: alertAction.status === 'error' ? S.red : alertAction.status === 'success' ? S.green : S.dim,
                fontSize: 11,
                textAlign: 'center',
                marginTop: 10,
              }}
            >
              {alertAction.message}
            </div>
          )}
        </Card>

        <Card>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 15, fontWeight: 800 }}>Diário de operações</div>
              <div style={{ color: S.dim, fontSize: 11, marginTop: 3 }}>
                Atualizado pelo monitor de ordens após entrada, alvo, stop ou erro de proteção.
              </div>
            </div>
            <button
              onClick={() => void loadJournal()}
              disabled={!session || journalAction.status === 'loading'}
              style={{
                background: 'transparent',
                color: S.b,
                border: `1px solid ${S.border}`,
                borderRadius: 7,
                padding: '7px 11px',
                cursor: session ? 'pointer' : 'not-allowed',
              }}
            >
              Atualizar diário
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 9,
              marginBottom: 12,
            }}
          >
            {[
              ['Registros', String(journal.length)],
              ['Abertas', String(journalSummary.open)],
              ['Encerradas', String(journalSummary.closed)],
              ['PnL líquido', `${fmt(journalSummary.netPnl)} USDT`],
              ['Média em R', journalSummary.averageR === null ? '—' : `${fmt(journalSummary.averageR)}R`],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  background: S.panelSoft,
                  border: `1px solid ${S.border}`,
                  borderRadius: 8,
                  padding: 10,
                  textAlign: 'center',
                }}
              >
                <div style={{ color: S.dim, fontSize: 10 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 800, marginTop: 3 }}>{value}</div>
              </div>
            ))}
          </div>

          {journal.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 880 }}>
                <thead>
                  <tr>
                    {['Data', 'Mercado', 'Modo', 'Status', 'Entrada', 'Saída', 'PnL', 'Resultado'].map((label) => (
                      <th
                        key={label}
                        style={{
                          color: S.dim,
                          borderBottom: `1px solid ${S.border}`,
                          padding: '8px 7px',
                          textAlign: 'center',
                        }}
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {journal.map((row) => {
                    const pnl = nullableNumber(row.pnl_usdt);
                    const resultR = nullableNumber(row.result_r);
                    return (
                      <tr key={row.id}>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}` }}>
                          {formatDateTime(row.criado_em)}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}`, fontWeight: 700 }}>
                          {row.symbol} · {row.timeframe}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}` }}>
                          {row.mode}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}`, color: journalStatusColor(row.status), fontWeight: 700 }}>
                          {journalStatusLabel(row.status)}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}` }}>
                          {fmtPrice(nullableNumber(row.entry_price) ?? nullableNumber(row.entry_reference) ?? 0)}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}` }}>
                          {row.exit_price === null ? '—' : fmtPrice(nullableNumber(row.exit_price) ?? 0)}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}`, color: pnl === null ? S.dim : pnl >= 0 ? S.green : S.red }}>
                          {pnl === null ? '—' : `${fmt(pnl)} USDT`}
                        </td>
                        <td style={{ padding: '8px 7px', textAlign: 'center', borderBottom: `1px solid ${S.border}`, color: resultR === null ? S.dim : resultR >= 0 ? S.green : S.red }}>
                          {resultR === null ? '—' : `${fmt(resultR)}R`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ color: S.dim, fontSize: 11, textAlign: 'center', padding: 10 }}>
              {session ? 'Nenhuma operação registrada.' : 'Entre para consultar o diário.'}
            </div>
          )}

          {journalAction.status === 'error' && (
            <div style={{ color: S.red, fontSize: 11, textAlign: 'center', marginTop: 9 }}>
              {journalAction.message}
            </div>
          )}
        </Card>

        <Card>
          <div style={{ textAlign: 'center', marginBottom: 13 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Backtest do playbook</div>
            <div style={{ color: S.dim, fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
              Sinal no fechamento, entrada na abertura seguinte, uma posição por vez e custos incluídos.
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 10,
              alignItems: 'end',
            }}
          >
            {([
              ['Candles', backtestCandleCount, setBacktestCandleCount, '1'],
              ['Capital inicial', backtestInitialCapital, setBacktestInitialCapital, '0.01'],
              ['Risco (%)', backtestRiskPercent, setBacktestRiskPercent, '0.1'],
              ['Taxa por execução (%)', backtestFeeRate, setBacktestFeeRate, '0.01'],
              ['Slippage (%)', backtestSlippage, setBacktestSlippage, '0.01'],
              ['Máx. candles na posição', backtestMaximumHolding, setBacktestMaximumHolding, '1'],
            ] as Array<[string, string, (next: string) => void, string]>).map(
              ([label, value, setter, step]) => (
              <label key={label} style={{ color: S.dim, fontSize: 10, textAlign: 'center' }}>
                {label}
                <input
                  type="number"
                  min="0"
                  step={step}
                  value={value}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setter(event.target.value)
                  }
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    marginTop: 5,
                    background: S.bg,
                    color: S.text,
                    border: `1px solid ${S.border}`,
                    borderRadius: 7,
                    padding: '8px 9px',
                    textAlign: 'center',
                  }}
                />
              </label>
            ))}

            <label style={{ color: S.dim, fontSize: 10, textAlign: 'center' }}>
              Mesmo candle toca stop e alvo
              <select
                value={backtestPriority}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
                  setBacktestPriority(event.target.value as 'stop_first' | 'target_first')
                }
                style={{
                  width: '100%',
                  marginTop: 5,
                  background: S.bg,
                  color: S.text,
                  border: `1px solid ${S.border}`,
                  borderRadius: 7,
                  padding: '8px 9px',
                  textAlign: 'center',
                }}
              >
                <option value="stop_first">Stop primeiro — conservador</option>
                <option value="target_first">Alvo primeiro</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 13 }}>
            <button
              onClick={handleRunBacktest}
              disabled={!session || backtestAction.status === 'loading'}
              style={{
                background: S.b,
                color: '#08131e',
                border: 'none',
                borderRadius: 7,
                padding: '10px 22px',
                fontWeight: 800,
                cursor: session ? 'pointer' : 'not-allowed',
                opacity: session ? 1 : 0.5,
              }}
            >
              {backtestAction.status === 'loading' ? 'Simulando...' : `Executar backtest de ${status === 'done' ? usedSymbolA : symbolA}`}
            </button>
          </div>

          {backtestAction.message && (
            <div
              style={{
                color: backtestAction.status === 'error' ? S.red : backtestAction.status === 'success' ? S.green : S.dim,
                fontSize: 11,
                textAlign: 'center',
                marginTop: 10,
              }}
            >
              {backtestAction.message}
            </div>
          )}

          {backtestResponse && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
                  gap: 9,
                  marginTop: 15,
                }}
              >
                {[
                  ['Capital final', `${fmt(backtestResponse.result.metrics.finalCapitalUsdt)} USDT`],
                  ['Retorno líquido', `${fmt(backtestResponse.result.metrics.netReturnPct)}%`],
                  ['Operações', String(backtestResponse.result.metrics.totalTrades)],
                  ['Taxa de acerto', `${fmt(backtestResponse.result.metrics.winRatePct)}%`],
                  ['Fator de lucro', backtestResponse.result.metrics.profitFactor === null ? '—' : fmt(backtestResponse.result.metrics.profitFactor)],
                  ['Média', `${fmt(backtestResponse.result.metrics.averageR)}R`],
                  ['Drawdown máximo', `${fmt(backtestResponse.result.metrics.maximumDrawdownPct)}%`],
                  ['Sequência de perdas', String(backtestResponse.result.metrics.maximumConsecutiveLosses)],
                  ['Exposição', `${fmt(backtestResponse.result.metrics.exposurePct)}%`],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    style={{
                      background: S.panelSoft,
                      border: `1px solid ${S.border}`,
                      borderRadius: 8,
                      padding: 10,
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ color: S.dim, fontSize: 9 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, marginTop: 3 }}>{value}</div>
                  </div>
                ))}
              </div>

              {backtestEquityData.length > 0 && (
                <div style={{ height: 330, marginTop: 16 }}>
                  <div style={{ color: S.dim, fontSize: 11, textAlign: 'center', marginBottom: 6 }}>
                    Curva de patrimônio — {backtestResponse.symbol} · {backtestResponse.timeframe}
                  </div>
                  <ResponsiveContainer width="100%" height="92%">
                    <LineChart data={backtestEquityData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                      <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                      <XAxis dataKey="label" stroke={S.dim} tick={{ fontSize: 10 }} minTickGap={28} />
                      <YAxis stroke={S.dim} tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend />
                      <Line type="monotone" dataKey="Patrimônio" stroke={S.green} strokeWidth={2.2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {backtestResponse.result.trades.length > 0 && (
                <div style={{ overflowX: 'auto', marginTop: 12 }}>
                  <div style={{ color: S.dim, fontSize: 11, textAlign: 'center', marginBottom: 5 }}>
                    Últimas operações simuladas
                  </div>
                  <table style={{ width: '100%', minWidth: 850, borderCollapse: 'collapse', fontSize: 10 }}>
                    <thead>
                      <tr>
                        {['Entrada', 'Saída', 'Motivo', 'Qtd.', 'PnL líquido', 'R', 'Patrimônio'].map((label) => (
                          <th key={label} style={{ color: S.dim, borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center' }}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {backtestResponse.result.trades.slice(-15).reverse().map((trade) => (
                        <tr key={trade.id}>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center' }}>
                            {formatDateTime(trade.entryTime)}<br />{fmtPrice(trade.entryPrice)}
                          </td>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center' }}>
                            {formatDateTime(trade.exitTime)}<br />{fmtPrice(trade.exitPrice)}
                          </td>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center' }}>
                            {backtestExitLabel(trade.exitReason)}
                          </td>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center' }}>
                            {fmt(trade.quantity, 8)}
                          </td>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center', color: trade.netPnlUsdt >= 0 ? S.green : S.red }}>
                            {fmt(trade.netPnlUsdt)} USDT
                          </td>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center', color: trade.resultR >= 0 ? S.green : S.red }}>
                            {fmt(trade.resultR)}R
                          </td>
                          <td style={{ borderBottom: `1px solid ${S.border}`, padding: 7, textAlign: 'center' }}>
                            {fmt(trade.equityAfter)} USDT
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {backtestResponse.result.warnings.length > 0 && (
                <div style={{ color: S.yellow, fontSize: 10, lineHeight: 1.5, textAlign: 'center', marginTop: 10 }}>
                  {backtestResponse.result.warnings.join(' ')}
                </div>
              )}
            </>
          )}
        </Card>

        {history.length > 0 && (
          <Card>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                marginBottom: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                Últimas análises de Day Trade
              </div>
              <button
                onClick={clearHistory}
                style={{
                  background: 'transparent',
                  border: `1px solid ${S.border}`,
                  borderRadius: 6,
                  color: S.dim,
                  padding: '5px 9px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Limpar histórico
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.slice(0, 8).map((item) => (
                <button
                  key={item.id}
                  onClick={() => run({
                    symbolA: item.symbolA,
                    symbolB: item.symbolB,
                    timeframe: item.timeframe,
                    periodLabel: item.periodLabel,
                  })}
                  style={{
                    background: 'transparent',
                    border: `1px solid ${S.border}`,
                    borderRadius: 8,
                    padding: '8px 12px',
                    color: S.text,
                    fontSize: 12,
                    cursor: 'pointer',
                    textAlign: 'center',
                  }}
                >
                  {item.symbolA}
                  {item.symbolB !== 'nenhum' ? ` × ${item.symbolB}` : ''}
                  {' '}· {TIMEFRAMES[item.timeframe].label}
                  {' '}· {item.periodLabel}
                  <span style={{ color: item.returnA >= 0 ? S.green : S.red }}>
                    {' '}· {fmtPct(item.returnA)}
                  </span>
                  {item.correlation !== null && (
                    <span style={{ color: S.dim }}>
                      {' '}· corr {fmt(item.correlation)}
                    </span>
                  )}
                  <span style={{ color: S.dim }}>
                    {' '}· {fmtDateTime(item.createdAt)}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        )}

        {status === 'done' && statsA && (
          <>
            <Card style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  minWidth: statsB ? 680 : 500,
                  fontSize: 14,
                }}
              >
                <thead>
                  <tr>
                    <th style={{ padding: '10px 12px', color: S.dim, borderBottom: `1px solid ${S.border}`, textAlign: 'center' }}>
                      Métrica ({usedPeriod.label} · {TIMEFRAMES[usedTimeframe].shortLabel})
                    </th>
                    <th style={{ padding: '10px 12px', color: S.a, borderBottom: `1px solid ${S.border}`, textAlign: 'center' }}>
                      {usedSymbolA}
                    </th>
                    {statsB && (
                      <th style={{ padding: '10px 12px', color: S.b, borderBottom: `1px solid ${S.border}`, textAlign: 'center' }}>
                        {usedSymbolB}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {metricRows.map((row) => (
                    <tr key={row.label} title={row.tip}>
                      <td style={{ padding: '9px 12px', color: S.dim, borderBottom: `1px solid ${S.border}`, textAlign: 'center' }}>
                        {row.label}
                      </td>
                      <td style={{ padding: '9px 12px', borderBottom: `1px solid ${S.border}`, textAlign: 'center', color: row.color?.(statsA) ?? S.text }}>
                        {row.get(statsA)}
                      </td>
                      {statsB && (
                        <td style={{ padding: '9px 12px', borderBottom: `1px solid ${S.border}`, textAlign: 'center', color: row.color?.(statsB) ?? S.text }}>
                          {row.get(statsB)}
                        </td>
                      )}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ padding: '10px 12px', color: S.dim, textAlign: 'center' }}>
                      Regime atual
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <RegimeBadge regime={statsA.regime} />
                    </td>
                    {statsB && (
                      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                        <RegimeBadge regime={statsB.regime} />
                      </td>
                    )}
                  </tr>
                </tbody>
              </table>
            </Card>

            {statsB && (
              <Card style={{ textAlign: 'center' }}>
                <div style={{ color: S.dim, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  Correlação dos retornos intradiários
                </div>
                <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: correlationValue === null ? S.dim : S.text }}>
                  {correlationValue === null ? '—' : fmt(correlationValue)}
                </div>
                <div style={{ color: S.dim, fontSize: 12, marginTop: 3 }}>
                  {correlationText(correlationValue)} · apenas o histórico do período selecionado
                </div>
              </Card>
            )}

            <Card style={{ height: 410 }}>
              <div style={{ textAlign: 'center', color: S.dim, fontSize: 13, marginBottom: 8 }}>
                Preço, médias e nível de rompimento — {usedSymbolA}
              </div>
              <ResponsiveContainer width="100%" height="92%">
                <LineChart data={charts.technical} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={S.dim} tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis stroke={S.dim} tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Line type="monotone" dataKey="Preço" stroke={S.text} strokeWidth={2.2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="EMA 20" stroke={S.green} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="EMA 50" stroke={S.a} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
                  <Line type="monotone" dataKey="EMA 200" stroke={S.b} strokeWidth={1.7} dot={false} connectNulls isAnimationActive={false} />
                  <Line type="stepAfter" dataKey="Rompimento" stroke={S.yellow} strokeWidth={1.4} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <Card style={{ height: 390 }}>
              <div style={{ textAlign: 'center', color: S.dim, fontSize: 13, marginBottom: 8 }}>
                Performance (base 100 no primeiro candle alinhado) — {TIMEFRAMES[usedTimeframe].label} · {usedPeriod.label}
              </div>
              <ResponsiveContainer width="100%" height="92%">
                <LineChart data={charts.performance} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={S.dim} tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis stroke={S.dim} tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <ReferenceLine y={100} stroke={S.dim} strokeDasharray="5 5" />
                  <Line type="monotone" dataKey={usedSymbolA} stroke={S.a} strokeWidth={2.2} dot={false} isAnimationActive={false} />
                  {statsB && (
                    <Line type="monotone" dataKey={usedSymbolB} stroke={S.b} strokeWidth={2.2} dot={false} isAnimationActive={false} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <Card style={{ height: 390 }}>
              <div style={{ textAlign: 'center', color: S.dim, fontSize: 13, marginBottom: 8 }}>
                Volatilidade realizada anualizada (%) — {TIMEFRAMES[usedTimeframe].volWindowLabel}
              </div>
              <ResponsiveContainer width="100%" height="92%">
                <LineChart data={charts.volatility} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={S.dim} tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis stroke={S.dim} tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Line type="monotone" dataKey={usedSymbolA} stroke={S.a} strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />
                  {statsB && (
                    <Line type="monotone" dataKey={usedSymbolB} stroke={S.b} strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <Card style={{ height: 390 }}>
              <div style={{ textAlign: 'center', color: S.dim, fontSize: 13, marginBottom: 8 }}>
                Volume financeiro por candle — milhões de USDT
              </div>
              <ResponsiveContainer width="100%" height="92%">
                <BarChart data={charts.volume} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke={S.dim} tick={{ fontSize: 11 }} minTickGap={30} />
                  <YAxis stroke={S.dim} tick={{ fontSize: 11 }} domain={[0, 'auto']} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Bar dataKey={usedSymbolA} fill={S.a} isAnimationActive={false} />
                  {statsB && (
                    <Bar dataKey={usedSymbolB} fill={S.b} isAnimationActive={false} />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                    gap: 10,
                  }}
                >
                  <button
                    onClick={generateReport}
                    disabled={reportAction.status === 'loading'}
                    style={{
                      background:
                        reportAction.status === 'loading' ? S.border : S.a,
                      color:
                        reportAction.status === 'loading' ? S.dim : '#1a1206',
                      border: 'none',
                      borderRadius: 8,
                      padding: '10px 20px',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor:
                        reportAction.status === 'loading'
                          ? 'not-allowed'
                          : 'pointer',
                      opacity: reportAction.status === 'loading' ? 0.75 : 1,
                    }}
                  >
                    {reportAction.status === 'loading'
                      ? 'Analisando com IA...'
                      : report
                        ? 'Gerar nova análise com IA'
                        : 'Gerar análise intradiária com IA'}
                  </button>

                  <button
                    onClick={copyAnalysisMarkdown}
                    disabled={copyAction.status === 'loading'}
                    style={{
                      background:
                        copyAction.status === 'success'
                          ? `${S.green}22`
                          : S.panelSoft,
                      color:
                        copyAction.status === 'success' ? S.green : S.text,
                      border: `1px solid ${
                        copyAction.status === 'success' ? `${S.green}88` : S.border
                      }`,
                      borderRadius: 8,
                      padding: '10px 20px',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor:
                        copyAction.status === 'loading'
                          ? 'not-allowed'
                          : 'pointer',
                      opacity: copyAction.status === 'loading' ? 0.75 : 1,
                    }}
                  >
                    {copyAction.status === 'loading'
                      ? 'Copiando...'
                      : copyAction.status === 'success'
                        ? '✓ Markdown copiado'
                        : 'Copiar Markdown'}
                  </button>
                </div>

                {reportAction.message && (
                  <div
                    style={{
                      color:
                        reportAction.status === 'success'
                          ? S.green
                          : reportAction.status === 'fallback'
                            ? S.yellow
                            : reportAction.status === 'error'
                              ? S.red
                              : S.dim,
                      fontSize: 11,
                      lineHeight: 1.45,
                      textAlign: 'center',
                      maxWidth: 760,
                    }}
                  >
                    {reportAction.message}
                  </div>
                )}

                {copyAction.message && (
                  <div
                    style={{
                      color:
                        copyAction.status === 'success'
                          ? S.green
                          : copyAction.status === 'error'
                            ? S.red
                            : S.dim,
                      fontSize: 11,
                      lineHeight: 1.45,
                      textAlign: 'center',
                      maxWidth: 760,
                    }}
                  >
                    {copyAction.message}
                  </div>
                )}
              </div>

              {report ? (
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.65,
                    fontSize: 14,
                    color: S.text,
                    background: S.panelSoft,
                    border: `1px solid ${
                      reportAction.status === 'success'
                        ? `${S.green}66`
                        : reportAction.status === 'fallback'
                          ? `${S.yellow}66`
                          : S.border
                    }`,
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  {report}
                </div>
              ) : (
                <div style={{ textAlign: 'center', color: S.dim, fontSize: 12, lineHeight: 1.55 }}>
                  Gere a explicação pelo VigIA ou copie o snapshot completo em Markdown para revisar na IA de sua preferência. O Markdown funciona mesmo sem gerar o relatório interno e não inclui chaves, tokens ou segredos.
                </div>
              )}
            </Card>
          </>
        )}

        <div style={{ color: S.dim, fontSize: 11, textAlign: 'center', lineHeight: 1.5, paddingBottom: 8 }}>
          Dados públicos de mercado da Binance. O preço ao vivo pode mudar até o fechamento do candle.
          O playbook, os alertas, a Testnet e o backtest são ferramentas educacionais e de simulação; não constituem recomendação de investimento nem promessa de resultado.
        </div>
      </div>
    </main>
  );
}'use client';

