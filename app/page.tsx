'use client';

/**
 * Dashboard de Análise de Mercado — VigIA Trade v5
 * ---------------------------------------------------------------------------
 * Correções desta versão:
 * - Usa somente candles já encerrados.
 * - Mantém os símbolos da análise separados dos controles atuais.
 * - Alinha comparação e correlação pelo horário real dos candles.
 * - Permite o período semanal de 12 meses com amostra suficiente.
 * - Calcula Sharpe histórico com retornos logarítmicos e desvio-padrão amostral.
 * - Valida amostra dos dois ativos antes de exibir ou persistir a análise.
 * - Evita que falhas de persistência derrubem a análise já concluída.
 * - Busca candles extras para aquecer a volatilidade sem ampliar o período exibido.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import { getSupabase } from '../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Timeframes e períodos
// ---------------------------------------------------------------------------

interface PeriodOption {
  label: string;
  days: number;
}

const TIMEFRAMES = {
  '1h': {
    api: '1h',
    label: '1 hora',
    windowLabel: 'janela de 72h',
    unitLabel: 'janela de 24h',
    periodsPerYear: 24 * 365,
    volWindow: 72,
    candlesPorDia: 24,
    periods: [
      { label: '7 dias', days: 7 },
      { label: '14 dias', days: 14 },
      { label: '30 dias', days: 30 },
      { label: '60 dias', days: 60 },
      { label: '90 dias', days: 90 },
    ] as PeriodOption[],
  },
  '4h': {
    api: '4h',
    label: '4 horas',
    windowLabel: 'janela de 7 dias',
    unitLabel: 'janela de 24h',
    periodsPerYear: 6 * 365,
    volWindow: 42,
    candlesPorDia: 6,
    periods: [
      { label: '14 dias', days: 14 },
      { label: '30 dias', days: 30 },
      { label: '90 dias', days: 90 },
      { label: '180 dias', days: 180 },
      { label: '12 meses', days: 365 },
    ] as PeriodOption[],
  },
  '1d': {
    api: '1d',
    label: 'diário',
    windowLabel: 'janela de 30 dias',
    unitLabel: 'dia',
    periodsPerYear: 365,
    volWindow: 30,
    candlesPorDia: 1,
    periods: [
      { label: '3 meses', days: 90 },
      { label: '6 meses', days: 180 },
      { label: '12 meses', days: 365 },
      { label: '24 meses', days: 730 },
      { label: '36 meses', days: 1095 },
    ] as PeriodOption[],
  },
  '1w': {
    api: '1w',
    label: 'semanal',
    windowLabel: 'janela de 12 semanas',
    unitLabel: 'semana',
    periodsPerYear: 52,
    volWindow: 12,
    candlesPorDia: 0,
    periods: [
      { label: '12 meses', days: 365 },
      { label: '24 meses', days: 730 },
      { label: '36 meses', days: 1095 },
      { label: '60 meses', days: 1825 },
    ] as PeriodOption[],
  },
} as const;

type Timeframe = keyof typeof TIMEFRAMES;

const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'nenhum',
];

const MIN_ALIGNED_RETURNS = 30;

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
}

type Regime = 'calmo' | 'normal' | 'volátil' | 'extremo';

interface AssetStats {
  symbol: string;
  returnPct: number;
  annualReturnPct: number;
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  timeInDrawdownPct: number;
  annualVolPct: number;
  currentVolPct: number;
  sharpe: number;
  pctPositive: number;
  regime: Regime;
  bestUnitPct: number;
  worstUnitPct: number;
  lastPrice: number;
}

interface AnalysisRow {
  id: string;
  symbol_a: string;
  symbol_b: string | null;
  timeframe: Timeframe;
  period_label: string;
  retorno_a: number | null;
  retorno_b: number | null;
  correlacao: number | null;
  criado_em: string;
}

interface OrderRow {
  id: string;
  symbol: string;
  status: string;
  is_testnet: boolean;
  entry_price: number | null;
  exit_price: number | null;
  pnl_usdt: number | null;
  criado_em: string;
}

interface KeyInfo {
  is_testnet: boolean;
}

// ---------------------------------------------------------------------------
// Estilo
// ---------------------------------------------------------------------------

const S = {
  bg: '#101418',
  panel: '#181f26',
  border: '#2a343f',
  text: '#d7dee6',
  dim: '#7d8a97',
  a: '#e8a13c',
  b: '#4f8fd0',
  green: '#3fb26f',
  red: '#d05555',
  regime: {
    calmo: '#4f8fd0',
    normal: '#3fb26f',
    'volátil': '#e8a13c',
    extremo: '#d05555',
  } as Record<Regime, string>,
};

const fmt = (n: number, d = 2) =>
  n.toLocaleString('pt-BR', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${fmt(n)}%`;

const fmtData = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pendente: { label: 'pendente', color: '#7d8a97' },
  entrada_enviada: { label: 'enviando entrada', color: '#e8a13c' },
  entrada_executada: { label: 'entrada feita', color: '#e8a13c' },
  protecao_pendente: { label: 'criando proteção', color: '#e8a13c' },
  entrada_sem_protecao: { label: 'sem proteção ⚠️', color: '#d05555' },
  oco_ativa: { label: 'OCO ativa', color: '#4f8fd0' },
  alvo_executado: { label: 'alvo ✅', color: '#3fb26f' },
  stop_executado: { label: 'stop 🛑', color: '#d05555' },
  cancelada: { label: 'cancelada', color: '#7d8a97' },
  erro_pre_entrada: { label: 'erro antes da entrada', color: '#d05555' },
  erro: { label: 'erro', color: '#d05555' },
};

// ---------------------------------------------------------------------------
// Dados e cálculos
// ---------------------------------------------------------------------------

async function fetchKlines(
  symbol: string,
  interval: string,
  requestedStart: number,
  requestedEnd: number,
  onProgress: (message: string) => void,
): Promise<Candle[]> {
  let cursor = requestedStart;

  const candlesByTime = new Map<number, Candle>();

  while (cursor < requestedEnd) {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: String(cursor),
      endTime: String(requestedEnd),
      limit: '1000',
    });

    const res = await fetch(
      `https://api.binance.com/api/v3/klines?${params.toString()}`,
      { cache: 'no-store' },
    );

    if (!res.ok) {
      throw new Error(`Binance respondeu ${res.status} para ${symbol}`);
    }

    const batch: (string | number)[][] = await res.json();
    if (!batch.length) break;

    for (const k of batch) {
      const openTime = Number(k[0]);
      const closeTime = Number(k[6]);

      // A Binance inclui o candle ainda em formação. Ele não pode participar
      // de métricas históricas porque seu fechamento ainda pode mudar.
      if (closeTime > requestedEnd) continue;

      candlesByTime.set(openTime, {
        openTime,
        closeTime,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      });
    }

    const lastOpenTime = Number(batch[batch.length - 1][0]);
    const nextCursor = lastOpenTime + 1;

    if (nextCursor <= cursor) break;
    cursor = nextCursor;

    onProgress(`${symbol}: ${candlesByTime.size} candles fechados...`);

    if (batch.length < 1000) break;
  }

  return [...candlesByTime.values()]
    .filter((candle) => candle.openTime >= requestedStart)
    .sort((a, b) => a.openTime - b.openTime);
}

function logReturns(candles: Candle[]): number[] {
  const returns: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const previous = candles[i - 1].close;
    const current = candles[i].close;

    if (previous > 0 && current > 0) {
      returns.push(Math.log(current / previous));
    }
  }

  return returns;
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
  const annualize = Math.sqrt(periodsPerYear);
  const output: (number | null)[] = new Array(returns.length + 1).fill(null);

  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < returns.length; i++) {
    sum += returns[i];
    sumSq += returns[i] ** 2;

    if (i >= window) {
      sum -= returns[i - window];
      sumSq -= returns[i - window] ** 2;
    }

    if (i >= window - 1) {
      const average = sum / window;
      const variance = Math.max(0, sumSq / window - average ** 2);
      output[i + 1] = Math.sqrt(variance) * annualize * 100;
    }
  }

  return output;
}

function classifyRegime(volSeries: (number | null)[]): Regime {
  const values = volSeries
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const current = volSeries[volSeries.length - 1];

  if (current === null || current === undefined || values.length < 4) {
    return 'normal';
  }

  // Mantido igual ao cálculo server-side usado pelos alertas para que o mesmo
  // conjunto de candles não receba regimes diferentes no painel e no cron.
  const quantile = (p: number) =>
    values[Math.floor(p * (values.length - 1))];

  if (current <= quantile(0.25)) return 'calmo';
  if (current <= quantile(0.75)) return 'normal';
  if (current <= quantile(0.95)) return 'volátil';
  return 'extremo';
}

function alignedCandlePairs(
  a: Candle[],
  b: Candle[],
): { a: Candle; b: Candle }[] {
  const mapB = new Map(b.map((candle) => [candle.openTime, candle]));

  return a.flatMap((candleA) => {
    const candleB = mapB.get(candleA.openTime);
    return candleB ? [{ a: candleA, b: candleB }] : [];
  });
}

function correlation(a: Candle[], b: Candle[]): number | null {
  const pairs = alignedCandlePairs(a, b);
  if (pairs.length < MIN_ALIGNED_RETURNS + 1) return null;

  const xs: number[] = [];
  const ys: number[] = [];

  for (let i = 1; i < pairs.length; i++) {
    const previous = pairs[i - 1];
    const current = pairs[i];

    if (
      previous.a.close <= 0 ||
      previous.b.close <= 0 ||
      current.a.close <= 0 ||
      current.b.close <= 0
    ) {
      continue;
    }

    xs.push(Math.log(current.a.close / previous.a.close));
    ys.push(Math.log(current.b.close / previous.b.close));
  }

  const n = xs.length;
  if (n < MIN_ALIGNED_RETURNS) return null;

  const meanX = mean(xs);
  const meanY = mean(ys);

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;

    covariance += dx * dy;
    varianceX += dx ** 2;
    varianceY += dy ** 2;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 0 ? covariance / denominator : null;
}

function correlationLabel(r: number): string {
  const absolute = Math.abs(r);

  if (absolute >= 0.7) return r > 0 ? 'alta' : 'alta inversa';
  if (absolute >= 0.4) return r > 0 ? 'moderada' : 'moderada inversa';
  return 'baixa';
}

function computeStats(
  symbol: string,
  candles: Candle[],
  vol: (number | null)[],
  tf: (typeof TIMEFRAMES)[Timeframe],
): AssetStats {
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  const n = candles.length;

  let peak = -Infinity;
  let maxDrawdown = 0;
  let belowPeak = 0;

  for (const candle of candles) {
    peak = Math.max(peak, candle.close);
    const drawdown = (candle.close - peak) / peak;
    maxDrawdown = Math.min(maxDrawdown, drawdown);

    if (drawdown < 0) belowPeak++;
  }

  const currentDrawdown = (last - peak) / peak;
  const span = tf.candlesPorDia > 0 ? tf.candlesPorDia : 1;

  let best = 0;
  let worst = 0;
  let hasUnitReturn = false;

  for (let i = span; i < n; i++) {
    const unitReturn = (candles[i].close / candles[i - span].close - 1) * 100;

    if (!hasUnitReturn) {
      best = unitReturn;
      worst = unitReturn;
      hasUnitReturn = true;
    } else {
      best = Math.max(best, unitReturn);
      worst = Math.min(worst, unitReturn);
    }
  }

  const returns = logReturns(candles);
  const positives = returns.filter((value) => value > 0).length;
  const volValues = vol.filter((value): value is number => value !== null);
  const averageRollingVol = mean(volValues);

  const elapsedPeriods = Math.max(1, returns.length);
  const annualizedLogReturn = Math.log(last / first) * (
    tf.periodsPerYear / elapsedPeriods
  );
  const annualReturn = (Math.exp(annualizedLogReturn) - 1) * 100;

  const periodMean = mean(returns);
  const periodStd = sampleStandardDeviation(returns);
  const sharpe = periodStd > 0
    ? (periodMean / periodStd) * Math.sqrt(tf.periodsPerYear)
    : 0;

  return {
    symbol,
    returnPct: (last / first - 1) * 100,
    annualReturnPct: annualReturn,
    maxDrawdownPct: maxDrawdown * 100,
    currentDrawdownPct: currentDrawdown * 100,
    timeInDrawdownPct: (belowPeak / n) * 100,
    annualVolPct: averageRollingVol,
    currentVolPct: volValues[volValues.length - 1] ?? 0,
    sharpe,
    pctPositive: returns.length ? (positives / returns.length) * 100 : 0,
    regime: classifyRegime(vol),
    bestUnitPct: best,
    worstUnitPct: worst,
    lastPrice: last,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function minimumCandlesFor(timeframe: Timeframe): number {
  const config = TIMEFRAMES[timeframe];
  return Math.max(MIN_ALIGNED_RETURNS, config.volWindow + 10);
}

function volatilityWarmupDays(timeframe: Timeframe): number {
  const config = TIMEFRAMES[timeframe];
  const candlesNeeded = config.volWindow + 2;

  // O semanal não possui uma quantidade inteira de candles por dia.
  // Acrescentamos duas semanas de margem para feriados, alinhamento do candle
  // e para garantir que a primeira janela visível já esteja completa.
  if (timeframe === '1w') return candlesNeeded * 7;

  return Math.ceil(candlesNeeded / config.candlesPorDia);
}

function alignVolatilityToVisibleCandles(
  fullCandles: Candle[],
  fullVolatility: (number | null)[],
  visibleCandles: Candle[],
): (number | null)[] {
  const volatilityByTime = new Map<number, number | null>(
    fullCandles.map((candle, index) => [
      candle.openTime,
      fullVolatility[index] ?? null,
    ]),
  );

  return visibleCandles.map(
    (candle) => volatilityByTime.get(candle.openTime) ?? null,
  );
}

// ---------------------------------------------------------------------------
// UI auxiliares
// ---------------------------------------------------------------------------

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
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
      }}
    >
      {regime}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function AnalisePage() {
  const supabase = getSupabase();

  const [session, setSession] = useState<Session | null>(null);

  const [symbolA, setSymbolA] = useState('BTCUSDT');
  const [symbolB, setSymbolB] = useState('ETHUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const [periodIdx, setPeriodIdx] = useState(1);

  const [status, setStatus] = useState<
    'idle' | 'loading' | 'done' | 'error'
  >('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const [usedSymbolA, setUsedSymbolA] = useState('BTCUSDT');
  const [usedSymbolB, setUsedSymbolB] = useState('ETHUSDT');
  const [usedTf, setUsedTf] = useState<Timeframe>('1d');
  const [usedPeriodLabel, setUsedPeriodLabel] = useState('6 meses');

  const [dataA, setDataA] = useState<Candle[]>([]);
  const [dataB, setDataB] = useState<Candle[]>([]);
  const [volA, setVolA] = useState<(number | null)[]>([]);
  const [volB, setVolB] = useState<(number | null)[]>([]);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  // Status e histórico do usuário autenticado.
  const [alertCount, setAlertCount] = useState<number | null>(null);
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null | undefined>(undefined);
  const [lastOrders, setLastOrders] = useState<OrderRow[]>([]);
  const [lastAnalyses, setLastAnalyses] = useState<AnalysisRow[]>([]);
  const [currentAnalysisId, setCurrentAnalysisId] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }: { data: { session: Session | null } }) => setSession(data.session));

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event: string, nextSession: Session | null) => setSession(nextSession),
    );

    return () => subscription.subscription.unsubscribe();
  }, [supabase]);

  const loadStatus = useCallback(async () => {
    const [alerts, keys, orders, analyses] = await Promise.all([
      supabase
        .from('alert_rules')
        .select('id', { count: 'exact', head: true })
        .eq('ativo', true),
      supabase
        .from('exchange_keys')
        .select('is_testnet')
        .maybeSingle(),
      supabase
        .from('orders')
        .select(
          'id, symbol, status, is_testnet, entry_price, exit_price, pnl_usdt, criado_em',
        )
        .order('criado_em', { ascending: false })
        .limit(3),
      supabase
        .from('analyses')
        .select(
          'id, symbol_a, symbol_b, timeframe, period_label, retorno_a, retorno_b, correlacao, criado_em',
        )
        .order('criado_em', { ascending: false })
        .limit(5),
    ]);

    setAlertCount(alerts.error ? 0 : alerts.count ?? 0);
    setKeyInfo(keys.error ? null : (keys.data as KeyInfo | null) ?? null);
    setLastOrders(orders.error ? [] : (orders.data as OrderRow[]) ?? []);
    setLastAnalyses(
      analyses.error ? [] : (analyses.data as AnalysisRow[]) ?? [],
    );
  }, [supabase]);

  useEffect(() => {
    if (session) {
      setKeyInfo(undefined);
      void loadStatus();
      return;
    }

    setAlertCount(null);
    setKeyInfo(undefined);
    setLastOrders([]);
    setLastAnalyses([]);
    setCurrentAnalysisId(null);
  }, [session, loadStatus]);

  const onTimeframeChange = (value: string) => {
    const next = value as Timeframe;
    setTimeframe(next);
    setPeriodIdx(Math.min(1, TIMEFRAMES[next].periods.length - 1));
  };

  const run = useCallback(async (
    override?: {
      symbolA: string;
      symbolB: string;
      timeframe: Timeframe;
      periodLabel: string;
    },
  ) => {
    const selectedTf = override?.timeframe ?? timeframe;
    const config = TIMEFRAMES[selectedTf];

    const selectedPeriod = override
      ? config.periods.find((period) => period.label === override.periodLabel)
        ?? config.periods[Math.min(1, config.periods.length - 1)]
      : config.periods[Math.min(periodIdx, config.periods.length - 1)];

    const selectedA = override?.symbolA ?? symbolA;
    const requestedB = override?.symbolB ?? symbolB;
    const selectedB = requestedB !== 'nenhum' && requestedB !== selectedA
      ? requestedB
      : 'nenhum';

    if (override) {
      setSymbolA(selectedA);
      setSymbolB(requestedB);
      setTimeframe(selectedTf);
      setPeriodIdx(
        Math.max(
          0,
          config.periods.findIndex(
            (period) => period.label === selectedPeriod.label,
          ),
        ),
      );
    }

    setStatus('loading');
    setProgress('');
    setError('');
    setReport('');
    setCurrentAnalysisId(null);

    try {
      const analysisEnd = Date.now();
      const analysisStart = analysisEnd - selectedPeriod.days * DAY_MS;
      const warmupStart = analysisStart - volatilityWarmupDays(selectedTf) * DAY_MS;

      const fullCandlesA = await fetchKlines(
        selectedA,
        config.api,
        warmupStart,
        analysisEnd,
        setProgress,
      );

      const fullCandlesB = selectedB !== 'nenhum'
        ? await fetchKlines(
          selectedB,
          config.api,
          warmupStart,
          analysisEnd,
          setProgress,
        )
        : [];

      // Os candles anteriores ao período escolhido existem apenas para formar
      // a primeira janela de volatilidade. Retorno, drawdown, correlação,
      // performance e eixo do gráfico continuam restritos ao período solicitado.
      const candlesA = fullCandlesA.filter(
        (candle) => candle.openTime >= analysisStart,
      );
      const candlesB = fullCandlesB.filter(
        (candle) => candle.openTime >= analysisStart,
      );

      const fullVolA = rollingVol(
        logReturns(fullCandlesA),
        config.volWindow,
        config.periodsPerYear,
      );
      const fullVolB = fullCandlesB.length
        ? rollingVol(
          logReturns(fullCandlesB),
          config.volWindow,
          config.periodsPerYear,
        )
        : [];

      const visibleVolA = alignVolatilityToVisibleCandles(
        fullCandlesA,
        fullVolA,
        candlesA,
      );
      const visibleVolB = alignVolatilityToVisibleCandles(
        fullCandlesB,
        fullVolB,
        candlesB,
      );

      const minimum = minimumCandlesFor(selectedTf);

      if (candlesA.length < minimum) {
        throw new Error(
          `${selectedA}: amostra insuficiente (${candlesA.length} candles fechados; mínimo ${minimum}). Aumente o período.`,
        );
      }

      if (selectedB !== 'nenhum' && candlesB.length < minimum) {
        throw new Error(
          `${selectedB}: amostra insuficiente (${candlesB.length} candles fechados; mínimo ${minimum}). Aumente o período.`,
        );
      }

      if (candlesB.length) {
        const aligned = alignedCandlePairs(candlesA, candlesB);

        if (aligned.length < MIN_ALIGNED_RETURNS + 1) {
          throw new Error(
            `Os ativos possuem somente ${Math.max(0, aligned.length - 1)} retornos alinhados; mínimo ${MIN_ALIGNED_RETURNS}.`,
          );
        }
      }

      setDataA(candlesA);
      setDataB(candlesB);
      setVolA(visibleVolA);
      setVolB(visibleVolB);
      setUsedSymbolA(selectedA);
      setUsedSymbolB(selectedB);
      setUsedTf(selectedTf);
      setUsedPeriodLabel(selectedPeriod.label);
      setStatus('done');
      setProgress('');

      // A persistência é secundária: uma falha no banco não invalida os dados
      // de mercado que já foram calculados e exibidos corretamente.
      if (session) {
        try {
          const statsForA = computeStats(
            selectedA,
            candlesA,
            visibleVolA,
            config,
          );

          let statsForB: AssetStats | null = null;
          let correlationValue: number | null = null;

          if (candlesB.length) {
            statsForB = computeStats(
              selectedB,
              candlesB,
              visibleVolB,
              config,
            );
            correlationValue = correlation(candlesA, candlesB);
          }

          const { data: row, error: insertError } = await supabase
            .from('analyses')
            .insert({
              symbol_a: selectedA,
              symbol_b: candlesB.length ? selectedB : null,
              timeframe: selectedTf,
              period_label: selectedPeriod.label,
              retorno_a: statsForA.returnPct,
              retorno_b: statsForB?.returnPct ?? null,
              correlacao: correlationValue,
              stats: { a: statsForA, b: statsForB },
              user_id: session.user.id,
            })
            .select('id')
            .single();

          if (!insertError && row) {
            setCurrentAnalysisId(row.id as string);
          }

          await loadStatus();
        } catch (persistenceError) {
          console.error('Falha ao persistir análise:', persistenceError);
        }
      }
    } catch (runError) {
      setError(
        runError instanceof Error
          ? runError.message
          : 'Erro ao buscar dados.',
      );
      setStatus('error');
      setProgress('');
    }
  }, [
    timeframe,
    periodIdx,
    symbolA,
    symbolB,
    session,
    supabase,
    loadStatus,
  ]);

  // Derivados da última análise concluída, nunca dos controles que ainda não
  // foram executados.
  const tf = TIMEFRAMES[usedTf];

  const statsA = useMemo(
    () => dataA.length
      ? computeStats(usedSymbolA, dataA, volA, tf)
      : null,
    [dataA, volA, usedSymbolA, tf],
  );

  const statsB = useMemo(
    () => dataB.length
      ? computeStats(usedSymbolB, dataB, volB, tf)
      : null,
    [dataB, volB, usedSymbolB, tf],
  );

  const corr = useMemo(
    () => dataA.length && dataB.length
      ? correlation(dataA, dataB)
      : null,
    [dataA, dataB],
  );

  const charts = useMemo(() => {
    if (!dataA.length) return { perf: [], vol: [] };

    const step = Math.max(1, Math.floor(dataA.length / 500));
    const sampledIndexes: number[] = [];

    for (let index = 0; index < dataA.length; index += step) {
      sampledIndexes.push(index);
    }

    if (sampledIndexes[sampledIndexes.length - 1] !== dataA.length - 1) {
      sampledIndexes.push(dataA.length - 1);
    }

    const baseA = dataA[0].close;
    const bByTime = new Map(
      dataB.map((candle, index) => [
        candle.openTime,
        { candle, volatility: volB[index] },
      ]),
    );

    const firstMatchedB = dataA
      .map((candle) => bByTime.get(candle.openTime)?.candle)
      .find((candle): candle is Candle => Boolean(candle));

    const baseB = firstMatchedB?.close ?? 1;
    const performance: Record<string, number | string>[] = [];
    const volatility: Record<string, number | string>[] = [];
    const longRange = usedTf === '1d' || usedTf === '1w';

    for (const index of sampledIndexes) {
      const candleA = dataA[index];
      const date = new Date(candleA.openTime);
      const label = longRange
        ? `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getFullYear()).slice(2)}`
        : `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;

      const performancePoint: Record<string, number | string> = {
        label,
        [usedSymbolA]: Number(((candleA.close / baseA) * 100).toFixed(2)),
      };
      const volatilityPoint: Record<string, number | string> = { label };

      if (volA[index] !== null && volA[index] !== undefined) {
        volatilityPoint[usedSymbolA] = Number(
          (volA[index] as number).toFixed(1),
        );
      }

      const matchedB = bByTime.get(candleA.openTime);

      if (matchedB && usedSymbolB !== 'nenhum') {
        performancePoint[usedSymbolB] = Number(
          ((matchedB.candle.close / baseB) * 100).toFixed(2),
        );

        if (
          matchedB.volatility !== null &&
          matchedB.volatility !== undefined
        ) {
          volatilityPoint[usedSymbolB] = Number(
            matchedB.volatility.toFixed(1),
          );
        }
      }

      performance.push(performancePoint);
      volatility.push(volatilityPoint);
    }

    return { perf: performance, vol: volatility };
  }, [
    dataA,
    dataB,
    volA,
    volB,
    usedSymbolA,
    usedSymbolB,
    usedTf,
  ]);

  const generateReport = useCallback(async () => {
    if (!statsA) return;

    setReportLoading(true);
    setReport('');

    try {
      const res = await fetch('/api/relatorio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodoLabel: usedPeriodLabel,
          timeframeLabel: tf.label,
          unidadeExtremos: tf.unitLabel,
          correlacao: corr,
          ativos: [statsA, statsB].filter(Boolean),
        }),
      });

      if (!res.ok) throw new Error(`API respondeu ${res.status}`);

      const json = await res.json();
      const text = json.relatorio ?? 'Resposta vazia da API.';
      setReport(text);

      if (session && currentAnalysisId) {
        const { error: updateError } = await supabase
          .from('analyses')
          .update({ report: text })
          .eq('id', currentAnalysisId);

        if (updateError) {
          console.error('Falha ao anexar relatório à análise:', updateError);
        }
      }
    } catch (reportError) {
      setReport(
        `Erro ao gerar relatório: ${
          reportError instanceof Error ? reportError.message : 'desconhecido'
        }.`,
      );
    } finally {
      setReportLoading(false);
    }
  }, [
    statsA,
    statsB,
    usedPeriodLabel,
    tf,
    corr,
    session,
    currentAnalysisId,
    supabase,
  ]);

  const select = (
    value: string,
    onChange: (value: string) => void,
    options: { value: string; label: string }[],
  ) => (
    <select
      value={value}
      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
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

  const statRows: {
    label: string;
    tip: string;
    get: (stats: AssetStats) => string;
    color?: (stats: AssetStats) => string;
  }[] = [
    {
      label: 'Último preço (USDT)',
      tip: 'Preço de fechamento do candle encerrado mais recente.',
      get: (stats) => fmt(stats.lastPrice),
    },
    {
      label: 'Retorno no período',
      tip: 'Variação do preço do início ao fim do período analisado.',
      get: (stats) => fmtPct(stats.returnPct),
      color: (stats) => stats.returnPct >= 0 ? S.green : S.red,
    },
    {
      label: 'Drawdown máximo',
      tip: 'Maior queda registrada de um topo até o fundo seguinte dentro do período.',
      get: (stats) => fmtPct(stats.maxDrawdownPct),
      color: () => S.red,
    },
    {
      label: 'Drawdown atual',
      tip: 'Quanto o último fechamento está abaixo do maior topo do período.',
      get: (stats) => fmtPct(stats.currentDrawdownPct),
      color: (stats) => stats.currentDrawdownPct < -0.5 ? S.red : S.dim,
    },
    {
      label: 'Tempo em drawdown',
      tip: 'Fração dos candles em que o preço esteve abaixo do topo anterior.',
      get: (stats) => `${fmt(stats.timeInDrawdownPct, 0)}%`,
    },
    {
      label: 'Volatilidade média (anualizada)',
      tip: 'Média da volatilidade realizada das janelas históricas, projetada em escala anual. Mede risco, não direção.',
      get: (stats) => `${fmt(stats.annualVolPct, 0)}%`,
    },
    {
      label: 'Volatilidade atual (anualizada)',
      tip: 'Volatilidade realizada da janela encerrada mais recente, projetada em escala anual.',
      get: (stats) => `${fmt(stats.currentVolPct, 0)}%`,
    },
    {
      label: 'Sharpe histórico (rf = 0)',
      tip: 'Média dos retornos logarítmicos dividida pelo desvio-padrão amostral, anualizada e sem descontar taxa livre de risco. É descritivo e não prevê retorno futuro.',
      get: (stats) => fmt(stats.sharpe),
      color: (stats) => stats.sharpe >= 0 ? S.green : S.red,
    },
    {
      label: 'Candles positivos (histórico)',
      tip: 'Percentual histórico de candles que fecharam acima do candle anterior. Não representa probabilidade futura.',
      get: (stats) => `${fmt(stats.pctPositive, 0)}%`,
    },
    {
      label: `Melhor ${tf.unitLabel}`,
      tip: 'Maior alta histórica registrada nessa unidade dentro do período.',
      get: (stats) => fmtPct(stats.bestUnitPct),
      color: () => S.green,
    },
    {
      label: `Pior ${tf.unitLabel}`,
      tip: 'Maior queda histórica registrada nessa unidade dentro do período.',
      get: (stats) => fmtPct(stats.worstUnitPct),
      color: () => S.red,
    },
  ];

  return (
    <main
      style={{
        minHeight: '100vh',
        background: S.bg,
        color: S.text,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      {/* Header + navegação */}
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
              Análise de mercado
            </div>
            <div style={{ fontSize: 11, color: S.dim }}>
              monitoramento · risco definido · decisão sua
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
<span style={{ color: S.a, fontWeight: 600 }}>Análise</span>

<a href="/daytrade" style={{ color: S.dim, textDecoration: 'none' }}>
  Day Trade
</a>

<a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>
  Alertas
</a>

<a href="/conta" style={{ color: S.dim, textDecoration: 'none' }}>
  Conta Binance
</a>
          {!session ? (
            <a
              href="/alertas"
              style={{ color: S.green, textDecoration: 'none' }}
            >
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
          maxWidth: 1080,
          margin: '0 auto',
          padding: '24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Cards de status (logado) */}
        {session && (
          <div
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}
          >
            <a href="/alertas" style={{ textDecoration: 'none', color: S.text }}>
              <Card
                style={{
                  padding: '10px 16px',
                  textAlign: 'center',
                  minWidth: 140,
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: S.dim,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                  }}
                >
                  Alertas ativos
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: S.a }}>
                  {alertCount ?? '—'}
                </div>
              </Card>
            </a>

            <a href="/conta" style={{ textDecoration: 'none', color: S.text }}>
              <Card
                style={{
                  padding: '10px 16px',
                  textAlign: 'center',
                  minWidth: 140,
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: S.dim,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                  }}
                >
                  Binance
                </div>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    marginTop: 4,
                    color: keyInfo === null
                      ? S.dim
                      : keyInfo?.is_testnet
                        ? S.green
                        : S.red,
                  }}
                >
                  {keyInfo === undefined
                    ? '—'
                    : keyInfo === null
                      ? 'não conectada'
                      : keyInfo.is_testnet
                        ? 'TESTNET'
                        : 'CONTA REAL'}
                </div>
              </Card>
            </a>

            <a href="/conta" style={{ textDecoration: 'none', color: S.text }}>
              <Card
                style={{
                  padding: '10px 16px',
                  textAlign: 'center',
                  minWidth: 200,
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: S.dim,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                  }}
                >
                  Últimas ordens
                </div>

                {lastOrders.length === 0 ? (
                  <div style={{ fontSize: 13, color: S.dim, marginTop: 4 }}>
                    nenhuma
                  </div>
                ) : (
                  lastOrders.map((order) => (
                    <div key={order.id} style={{ fontSize: 12, marginTop: 4 }}>
                      {order.symbol} ·{' '}
                      <span
                        style={{
                          color: STATUS_LABEL[order.status]?.color ?? S.dim,
                        }}
                      >
                        {STATUS_LABEL[order.status]?.label ?? order.status}
                      </span>
                      {order.pnl_usdt !== null && (
                        <span
                          style={{
                            color: order.pnl_usdt >= 0 ? S.green : S.red,
                          }}
                        >
                          {' '}· {order.pnl_usdt >= 0 ? '+' : ''}
                          {fmt(order.pnl_usdt)} USDT
                        </span>
                      )}
                    </div>
                  ))
                )}
              </Card>
            </a>

            <a
              href="/daytrade"
              style={{ textDecoration: 'none', color: S.text }}
            >
              <Card
                style={{
                  padding: '10px 16px',
                  textAlign: 'center',
                  minWidth: 140,
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: S.dim,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                  }}
                >
                  Análise rápida
                </div>

                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 500,
                    marginTop: 3,
                    color: S.b,
                  }}
                >
                  Day Trade
                </div>

              </Card>
            </a>
          </div>
        )}

        <p
          style={{
            color: S.dim,
            fontSize: 13,
            margin: '0 auto',
            maxWidth: 780,
            textAlign: 'center',
          }}
        >
          Dados da Binance usando somente candles encerrados. Volatilidade
          realizada em {tf.windowLabel}, anualizada; regime classificado contra
          os quartis do próprio histórico. Ferramenta de análise — volatilidade
          mede amplitude de risco, não direção futura de preço.
        </p>

        {/* Controles */}
        <Card
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            alignItems: 'flex-end',
            justifyContent: 'center',
          }}
        >
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 12,
              color: S.dim,
              textAlign: 'center',
            }}
          >
            Ativo A
            {select(
              symbolA,
              setSymbolA,
              SYMBOLS
                .filter((symbol) => symbol !== 'nenhum')
                .map((symbol) => ({ value: symbol, label: symbol })),
            )}
          </label>

          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 12,
              color: S.dim,
              textAlign: 'center',
            }}
          >
            Ativo B (comparação)
            {select(
              symbolB,
              setSymbolB,
              SYMBOLS.map((symbol) => ({ value: symbol, label: symbol })),
            )}
          </label>

          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 12,
              color: S.dim,
              textAlign: 'center',
            }}
          >
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

          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontSize: 12,
              color: S.dim,
              textAlign: 'center',
            }}
          >
            Período
            {select(
              String(Math.min(periodIdx, currentPeriods.length - 1)),
              (value) => setPeriodIdx(Number(value)),
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
              background: S.a,
              color: '#1a1206',
              border: 'none',
              borderRadius: 8,
              padding: '10px 22px',
              fontSize: 14,
              fontWeight: 700,
              cursor: status === 'loading' ? 'wait' : 'pointer',
              opacity: status === 'loading' ? 0.6 : 1,
            }}
          >
            {status === 'loading' ? progress || 'Carregando...' : 'Analisar'}
          </button>

          {status === 'error' && (
            <span
              style={{
                color: S.red,
                fontSize: 13,
                flexBasis: '100%',
                textAlign: 'center',
              }}
            >
              {error}
            </span>
          )}
        </Card>

        {/* Histórico de análises (logado) */}
        {session && lastAnalyses.length > 0 && (
          <Card>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                textAlign: 'center',
                marginBottom: 8,
              }}
            >
              Últimas análises
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {lastAnalyses.map((analysis) => (
                <button
                  key={analysis.id}
                  onClick={() => run({
                    symbolA: analysis.symbol_a,
                    symbolB: analysis.symbol_b ?? 'nenhum',
                    timeframe: analysis.timeframe,
                    periodLabel: analysis.period_label,
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
                  {analysis.symbol_a}
                  {analysis.symbol_b ? ` × ${analysis.symbol_b}` : ''}
                  {' '}· {TIMEFRAMES[analysis.timeframe]?.label ?? analysis.timeframe}
                  {' '}· {analysis.period_label}
                  {analysis.retorno_a !== null && (
                    <span
                      style={{
                        color: analysis.retorno_a >= 0 ? S.green : S.red,
                      }}
                    >
                      {' '}· {fmtPct(analysis.retorno_a)}
                    </span>
                  )}
                  {analysis.correlacao !== null && (
                    <span style={{ color: S.dim }}>
                      {' '}· corr {fmt(analysis.correlacao)}
                    </span>
                  )}
                  <span style={{ color: S.dim }}>
                    {' '}· {fmtData(analysis.criado_em)}
                  </span>
                </button>
              ))}
            </div>

            <div
              style={{
                fontSize: 11,
                color: S.dim,
                textAlign: 'center',
                marginTop: 8,
              }}
            >
              Tocar reabre a análise com os mesmos parâmetros sobre dados atuais.
            </div>
          </Card>
        )}

        {status === 'done' && statsA && (
          <>
            {/* Regimes + correlação */}
            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                justifyContent: 'center',
              }}
            >
              {[statsA, statsB]
                .filter((stats): stats is AssetStats => Boolean(stats))
                .map((stats) => (
                  <Card
                    key={stats.symbol}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 12,
                      padding: '12px 16px',
                    }}
                  >
                    <strong style={{ fontSize: 15 }}>{stats.symbol}</strong>
                    <RegimeBadge regime={stats.regime} />
                    <span style={{ color: S.dim, fontSize: 13 }}>
                      vol. atual {fmt(stats.currentVolPct, 0)}% a.a. · média{' '}
                      {fmt(stats.annualVolPct, 0)}%
                    </span>
                  </Card>
                ))}

              {corr !== null && statsB && (
                <Card
                  title="Correlação de Pearson entre retornos alinhados pelo mesmo horário. Perto de 1 = movem juntos; perto de 0 = baixa relação linear; negativa = tendem a mover em direções opostas."
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    padding: '12px 16px',
                    cursor: 'help',
                  }}
                >
                  <strong style={{ fontSize: 14 }}>
                    Correlação {statsA.symbol} × {statsB.symbol}
                  </strong>
                  <span
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: Math.abs(corr) >= 0.7 ? S.a : S.text,
                    }}
                  >
                    {fmt(corr)}
                  </span>
                  <span style={{ color: S.dim, fontSize: 13 }}>
                    ({correlationLabel(corr)})
                  </span>
                </Card>
              )}
            </div>

            {/* Performance */}
            <Card style={{ height: 340 }}>
              <div
                style={{
                  fontSize: 12,
                  color: S.dim,
                  marginBottom: 8,
                  textAlign: 'center',
                }}
              >
                Performance (base 100 no primeiro candle alinhado) — candles{' '}
                {tf.label} · {usedPeriodLabel}
              </div>

              <ResponsiveContainer width="100%" height="90%">
                <LineChart data={charts.perf}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    stroke={S.dim}
                    fontSize={11}
                    minTickGap={40}
                  />
                  <YAxis
                    stroke={S.dim}
                    fontSize={11}
                    domain={['auto', 'auto']}
                    width={60}
                  />
                  <Tooltip
                    contentStyle={{
                      background: S.bg,
                      border: `1px solid ${S.border}`,
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: S.dim }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine
                    y={100}
                    stroke={S.dim}
                    strokeDasharray="4 4"
                  />
                  <Line
                    type="monotone"
                    dataKey={usedSymbolA}
                    stroke={S.a}
                    dot={false}
                    strokeWidth={2}
                  />
                  {statsB && (
                    <Line
                      type="monotone"
                      dataKey={usedSymbolB}
                      stroke={S.b}
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            {/* Volatilidade */}
            <Card style={{ height: 300 }}>
              <div
                style={{
                  fontSize: 12,
                  color: S.dim,
                  marginBottom: 8,
                  textAlign: 'center',
                }}
              >
                Volatilidade realizada anualizada (%) — {tf.windowLabel}
              </div>

              <ResponsiveContainer width="100%" height="88%">
                <LineChart data={charts.vol}>
                  <CartesianGrid stroke={S.border} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    stroke={S.dim}
                    fontSize={11}
                    minTickGap={40}
                  />
                  <YAxis stroke={S.dim} fontSize={11} width={50} />
                  <Tooltip
                    contentStyle={{
                      background: S.bg,
                      border: `1px solid ${S.border}`,
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: S.dim }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey={usedSymbolA}
                    stroke={S.a}
                    dot={false}
                    strokeWidth={2}
                    connectNulls
                  />
                  {statsB && (
                    <Line
                      type="monotone"
                      dataKey={usedSymbolB}
                      stroke={S.b}
                      dot={false}
                      strokeWidth={2}
                      connectNulls
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Card>

            {/* Tabela */}
            <Card>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 13,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <thead>
                  <tr style={{ color: S.dim, textAlign: 'center' }}>
                    <th style={{ padding: '6px 8px', textAlign: 'center' }}>
                      Métrica ({usedPeriodLabel} · {tf.label})
                    </th>
                    <th
                      style={{
                        padding: '6px 8px',
                        color: S.a,
                        textAlign: 'center',
                      }}
                    >
                      {statsA.symbol}
                    </th>
                    {statsB && (
                      <th
                        style={{
                          padding: '6px 8px',
                          color: S.b,
                          textAlign: 'center',
                        }}
                      >
                        {statsB.symbol}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {statRows.map((row) => (
                    <tr
                      key={row.label}
                      style={{
                        borderTop: `1px solid ${S.border}`,
                        textAlign: 'center',
                      }}
                    >
                      <td
                        title={row.tip}
                        style={{
                          padding: '8px',
                          color: S.dim,
                          cursor: 'help',
                          textAlign: 'center',
                        }}
                      >
                        {row.label}
                      </td>
                      <td
                        style={{
                          padding: '8px',
                          color: row.color?.(statsA),
                        }}
                      >
                        {row.get(statsA)}
                      </td>
                      {statsB && (
                        <td
                          style={{
                            padding: '8px',
                            color: row.color?.(statsB),
                          }}
                        >
                          {row.get(statsB)}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            {/* Relatório IA */}
            <Card>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    Relatório analítico
                  </div>
                  <div style={{ fontSize: 12, color: S.dim }}>
                    Gerado por IA a partir das métricas acima. Descritivo, não
                    recomendação.
                  </div>
                </div>

                <button
                  onClick={generateReport}
                  disabled={reportLoading}
                  style={{
                    background: 'transparent',
                    color: S.a,
                    border: `1px solid ${S.a}`,
                    borderRadius: 8,
                    padding: '8px 18px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: reportLoading ? 'wait' : 'pointer',
                    opacity: reportLoading ? 0.6 : 1,
                  }}
                >
                  {reportLoading ? 'Gerando...' : 'Gerar relatório'}
                </button>
              </div>

              {report && (
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 14,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    borderTop: `1px solid ${S.border}`,
                    paddingTop: 14,
                    textAlign: 'left',
                  }}
                >
                  {report}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
