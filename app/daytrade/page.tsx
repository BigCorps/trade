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
 * - Resumo descritivo local, sem custo de IA e sem recomendação.
 * - Histórico separado no localStorage, sem misturar com análises de longo prazo.
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
  const warmupMs = (config.volWindow + 4) * config.intervalMs;
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
    `${fmtPct(statsB.currentDrawdownPct)}. O Sharpe intradiário foi ` +
    `${fmt(statsA.sharpe)} para ${statsA.symbol} e ${fmt(statsB.sharpe)} para ` +
    `${statsB.symbol}; essa métrica compara retorno médio com volatilidade e não ` +
    `representa sozinha todo o risco de um ativo.`;

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
  const [history, setHistory] = useState<HistoryRecord[]>([]);

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
    setLiveA(null);
    setLiveB(null);

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
            const minimumOpenTime = Date.now()
              - usedPeriod.durationMs
              - (config.volWindow + 6) * config.intervalMs;
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

  const charts = useMemo(() => {
    const { visibleA, visibleB, volA, volB } = derived;
    if (!visibleA.length) return { performance: [], volatility: [], volume: [] };

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

    return { performance, volatility, volume };
  }, [
    derived,
    rawA,
    rawB,
    usedSymbolA,
    usedSymbolB,
    usedPeriod.durationMs,
  ]);

  const generateReport = useCallback(() => {
    if (!derived.statsA) return;
    const text = buildReport(
      derived.statsA,
      derived.statsB,
      derived.correlation,
      usedPeriod.label,
      usedTimeframe,
    );
    setReport(text);
    updateLatestHistoryReport(text);
  }, [
    derived.statsA,
    derived.statsB,
    derived.correlation,
    usedPeriod.label,
    usedTimeframe,
    updateLatestHistoryReport,
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
      label: 'Sharpe intradiário (rf = 0)',
      tip: 'Retorno médio por unidade de volatilidade, anualizado. Não mede todo o risco.',
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
              candles encerrados · atualização ao vivo
            </div>
          </div>
        </div>

<nav
  style={{
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 20,
    marginTop: 8,
    fontSize: 13,
  }}
>
<a href="/" style={{ color: S.dim, textDecoration: 'none' }}>
  Análise
</a>

<span style={{ color: S.b, fontWeight: 600 }}>
  Day Trade
</span>

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
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                <button
                  onClick={generateReport}
                  style={{
                    background: S.a,
                    color: '#1a1206',
                    border: 'none',
                    borderRadius: 8,
                    padding: '10px 20px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Gerar resumo intradiário
                </button>
              </div>

              {report ? (
                <div
                  style={{
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.65,
                    fontSize: 14,
                    color: S.text,
                    background: S.panelSoft,
                    border: `1px solid ${S.border}`,
                    borderRadius: 8,
                    padding: 16,
                  }}
                >
                  {report}
                </div>
              ) : (
                <div style={{ textAlign: 'center', color: S.dim, fontSize: 12 }}>
                  O resumo é produzido localmente a partir das métricas exibidas.
                </div>
              )}
            </Card>
          </>
        )}

        <div style={{ color: S.dim, fontSize: 11, textAlign: 'center', lineHeight: 1.5, paddingBottom: 8 }}>
          Dados públicos de mercado da Binance. O preço ao vivo pode mudar até o fechamento do candle.
          Esta ferramenta é descritiva e não constitui recomendação de investimento.
        </div>
      </div>
    </main>
  );
}
