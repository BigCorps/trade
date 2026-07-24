export interface ValidationTrade {
  id: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  openedAt: string;
  resultR: number;
  replayR1x?: number | null;
  replayR15x?: number | null;
  replayR2x?: number | null;
  replayR3x?: number | null;
  replayDelay1?: number | null;
  replayDelay2?: number | null;
  assetTrend?: string | null;
  assetVolatility?: string | null;
  btcTrend?: string | null;
  btcVolatility?: string | null;
}

export interface NumericSummary {
  count: number;
  sum: number;
  mean: number | null;
  standardDeviation: number | null;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  maximumDrawdown: number;
}

const numeric = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values: readonly number[]): number | null {
  return values.length > 0 ? sum(values) / values.length : null;
}

export function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values) ?? 0;
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

export function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const bounded = Math.min(1, Math.max(0, probability));
  const position = (sorted.length - 1) * bounded;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function maximumDrawdown(values: readonly number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

export function summarize(values: readonly number[]): NumericSummary {
  const grossProfit = sum(values.filter((value) => value > 0));
  const grossLoss = Math.abs(sum(values.filter((value) => value < 0)));
  return {
    count: values.length,
    sum: sum(values),
    mean: mean(values),
    standardDeviation: standardDeviation(values),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maximumDrawdown: maximumDrawdown(values),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function weekKey(value: string): string {
  const date = new Date(value);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return String(utc.getUTCFullYear()) + '-W' + String(week).padStart(2, '0');
}

function groupedTotals(trades: readonly ValidationTrade[], key: (trade: ValidationTrade) => string): Record<string, number> {
  const output: Record<string, number> = {};
  for (const trade of trades) output[key(trade)] = (output[key(trade)] ?? 0) + trade.resultR;
  return output;
}

function bestGroupRemoval(base: number, groups: Record<string, number>): { key: string | null; resultWithout: number } {
  const entries = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  return entries.length > 0 ? { key: entries[0][0], resultWithout: base - entries[0][1] } : { key: null, resultWithout: base };
}

export function robustnessAnalysis(trades: readonly ValidationTrade[]) {
  const sorted = [...trades].sort((a, b) => b.resultR - a.resultR);
  const base = sum(sorted.map((trade) => trade.resultR));
  const positive = sorted.filter((trade) => trade.resultR > 0).map((trade) => trade.resultR);
  const topThreeProfit = sum(positive.slice(0, 3));
  const grossProfit = sum(positive);
  return {
    completeR: base,
    withoutBestTradeR: base - (sorted[0]?.resultR ?? 0),
    withoutBestThreeTradesR: base - sum(sorted.slice(0, 3).map((trade) => trade.resultR)),
    withoutBestSymbol: bestGroupRemoval(base, groupedTotals(trades, (trade) => trade.symbol)),
    withoutBestDay: bestGroupRemoval(base, groupedTotals(trades, (trade) => dayKey(trade.openedAt))),
    withoutBestWeek: bestGroupRemoval(base, groupedTotals(trades, (trade) => weekKey(trade.openedAt))),
    topThreeProfitSharePct: grossProfit > 0 ? (topThreeProfit / grossProfit) * 100 : null,
  };
}

export function signFlipBenchmark(values: readonly number[], iterations: number, seed: number) {
  if (values.length === 0 || iterations < 1) return { iterations: 0, probabilityAtLeastObservedPct: null, nullMedianR: null };
  const random = seededRandom(seed);
  const observed = sum(values);
  const simulated: number[] = [];
  let atLeast = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const result = sum(values.map((value) => Math.abs(value) * (random() < 0.5 ? -1 : 1)));
    simulated.push(result);
    if (observed >= 0 ? result >= observed : result <= observed) atLeast += 1;
  }
  return {
    iterations,
    probabilityAtLeastObservedPct: (atLeast / iterations) * 100,
    nullMedianR: quantile(simulated, 0.5),
  };
}

export function blockBootstrapMonteCarlo(trades: readonly ValidationTrade[], iterations: number, seed: number) {
  const daily = Object.values(groupedTotals(trades, (trade) => dayKey(trade.openedAt)));
  if (daily.length === 0 || iterations < 1) {
    return { iterations: 0, blocks: 0, probabilityNegativePct: null, finalR: null, drawdownR: null };
  }
  const random = seededRandom(seed ^ 0x9e3779b9);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  let negative = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const path: number[] = [];
    for (let index = 0; index < daily.length; index += 1) path.push(daily[Math.floor(random() * daily.length)]);
    const final = sum(path);
    finals.push(final);
    drawdowns.push(maximumDrawdown(path));
    if (final < 0) negative += 1;
  }
  return {
    iterations,
    blocks: daily.length,
    probabilityNegativePct: (negative / iterations) * 100,
    finalR: { p05: quantile(finals, 0.05), median: quantile(finals, 0.5), p95: quantile(finals, 0.95) },
    drawdownR: { median: quantile(drawdowns, 0.5), p95: quantile(drawdowns, 0.95), p99: quantile(drawdowns, 0.99) },
  };
}

function replaySummary(trades: readonly ValidationTrade[], field: keyof ValidationTrade): NumericSummary {
  const values = trades.map((trade) => numeric(trade[field])).filter((value): value is number => value !== null);
  return summarize(values);
}

function regimeBreakdown(trades: readonly ValidationTrade[]) {
  const groups = new Map<string, number[]>();
  for (const trade of trades) {
    const key = [trade.assetTrend ?? 'indefinida', trade.assetVolatility ?? 'indefinida', trade.btcTrend ?? 'indefinida'].join(' | ');
    const values = groups.get(key) ?? [];
    values.push(trade.resultR);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .map(([regime, values]) => ({ regime, ...summarize(values) }))
    .sort((a, b) => b.count - a.count);
}

export function buildValidationReport(trades: readonly ValidationTrade[], iterations = 5000, seed = 20260724) {
  const ordered = [...trades].sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
  const base = summarize(ordered.map((trade) => trade.resultR));
  const robustness = robustnessAnalysis(ordered);
  const stress = {
    recorded: base,
    replay1x: replaySummary(ordered, 'replayR1x'),
    costs15x: replaySummary(ordered, 'replayR15x'),
    costs2x: replaySummary(ordered, 'replayR2x'),
    costs3x: replaySummary(ordered, 'replayR3x'),
    delay1Candle: replaySummary(ordered, 'replayDelay1'),
    delay2Candles: replaySummary(ordered, 'replayDelay2'),
  };
  const monteCarlo = blockBootstrapMonteCarlo(ordered, iterations, seed);
  const randomBenchmark = signFlipBenchmark(ordered.map((trade) => trade.resultR), iterations, seed);
  const robustPositive = base.sum > 0
    && robustness.withoutBestThreeTradesR > 0
    && (stress.costs2x.count === 0 || stress.costs2x.sum > 0);
  return {
    version: 'validation-v1.0.0',
    generatedAt: new Date().toISOString(),
    operations: ordered.length,
    base,
    stress,
    robustness,
    regimes: regimeBreakdown(ordered),
    monteCarlo,
    randomBenchmark,
    readiness: {
      sample: ordered.length >= 100 ? 'minima' : ordered.length >= 50 ? 'preliminar' : 'insuficiente',
      robustPositive,
      readyForRealMoney: ordered.length >= 100 && robustPositive && (monteCarlo.probabilityNegativePct ?? 100) <= 20,
    },
  };
}
