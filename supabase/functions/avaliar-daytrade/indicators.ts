/**
 * lib/daytrade/indicators.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Motor puro de indicadores para o módulo de Day Trade.
 *
 * Responsabilidades:
 * - Validar, ordenar e deduplicar candles.
 * - Calcular EMA 20, EMA 50 e EMA 200.
 * - Calcular ATR 14 pelo método de Wilder.
 * - Calcular máxima e mínima anteriores, sem incluir o candle avaliado.
 * - Calcular médias de volume e volume relativo.
 * - Calcular volatilidade realizada anualizada.
 * - Calcular drawdown, amplitude e distâncias relevantes.
 * - Entregar séries alinhadas para gráficos, backtest e alertas.
 *
 * Regras importantes:
 * - Passe somente candles encerrados.
 * - Caso um candle tenha `isClosed: false`, ele será ignorado.
 * - Nenhuma função deste arquivo consulta APIs, banco de dados ou executa ordens.
 * - Este arquivo calcula fatos. A decisão do playbook ficará em outro módulo.
 */

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export interface DayTradeCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume?: number;
  isClosed?: boolean;
}

export interface DayTradeIndicatorOptions {
  /** Quantidade de candles existentes em um ano para o timeframe usado. */
  periodsPerYear: number;

  /** Quantidade de retornos usados na volatilidade móvel. */
  volatilityWindow: number;

  emaFastPeriod?: number;
  emaMediumPeriod?: number;
  emaSlowPeriod?: number;
  atrPeriod?: number;
  breakoutPeriod?: number;
  volumePeriod?: number;

  /**
   * Quantidade mínima de observações históricas de volatilidade exigidas para
   * classificar o regime atual contra a própria distribuição.
   */
  minimumRegimeSamples?: number;
}

export interface ResolvedIndicatorOptions {
  periodsPerYear: number;
  volatilityWindow: number;
  emaFastPeriod: number;
  emaMediumPeriod: number;
  emaSlowPeriod: number;
  atrPeriod: number;
  breakoutPeriod: number;
  volumePeriod: number;
  minimumRegimeSamples: number;
}

export type VolatilityRegime =
  | 'indisponível'
  | 'calmo'
  | 'normal'
  | 'volátil'
  | 'extremo';

export interface DrawdownSummary {
  maxDrawdownPct: number;
  currentDrawdownPct: number;
  timeInDrawdownPct: number;
  peakPrice: number;
}

export interface DayTradeIndicatorPoint {
  openTime: number;
  closeTime: number;
  close: number;

  emaFast: number | null;
  emaMedium: number | null;
  emaSlow: number | null;

  atr: number | null;
  atrPct: number | null;

  /** Máxima dos candles anteriores, sem incluir o candle atual. */
  priorHighestHigh: number | null;

  /** Mínima dos candles anteriores, sem incluir o candle atual. */
  priorLowestLow: number | null;

  /** Volume-base médio dos candles anteriores. */
  averageVolume: number | null;

  /** Volume financeiro médio em moeda de cotação dos candles anteriores. */
  averageQuoteVolume: number | null;

  /** Volume atual dividido pela média anterior. */
  relativeVolume: number | null;

  /** Volatilidade realizada anualizada, em percentual. */
  annualizedVolatilityPct: number | null;
}

export interface DayTradeIndicators {
  options: ResolvedIndicatorOptions;
  series: DayTradeIndicatorPoint[];

  candleCount: number;
  requiredCandles: number;
  ready: boolean;
  missingCandles: number;

  currentCandleOpenTime: number;
  currentCandleCloseTime: number;
  previousCandleCloseTime: number;

  currentPrice: number;
  previousClose: number;
  lastCandleReturnPct: number;
  currentCandleRangePct: number;

  emaFast: number | null;
  emaMedium: number | null;
  emaSlow: number | null;

  atr: number | null;
  atrPct: number | null;

  breakoutLevel: number | null;
  supportLevel: number | null;
  distanceToBreakoutPct: number | null;
  distanceFromSupportPct: number | null;
  distanceFromSlowEmaPct: number | null;

  currentVolume: number;
  currentQuoteVolume: number;
  averageVolume: number | null;
  averageQuoteVolume: number | null;
  relativeVolume: number | null;

  annualizedVolatilityPct: number | null;
  volatilityRegime: VolatilityRegime;
  volatilityPercentile: number | null;

  periodHigh: number;
  periodLow: number;
  amplitudePct: number;

  maxDrawdownPct: number;
  currentDrawdownPct: number;
  timeInDrawdownPct: number;

  comparisons: {
    priceAboveSlowEma: boolean | null;
    fastEmaAboveMediumEma: boolean | null;
    closeAboveBreakout: boolean | null;
    volumeAboveAverage: boolean | null;
  };
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const DEFAULTS = {
  emaFastPeriod: 20,
  emaMediumPeriod: 50,
  emaSlowPeriod: 200,
  atrPeriod: 14,
  breakoutPeriod: 20,
  volumePeriod: 20,
  minimumRegimeSamples: 20,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um número inteiro maior que zero.`);
  }

  return value;
}

export function resolveIndicatorOptions(
  options: DayTradeIndicatorOptions,
): ResolvedIndicatorOptions {
  const resolved: ResolvedIndicatorOptions = {
    periodsPerYear: positiveInteger(options.periodsPerYear, 'periodsPerYear'),
    volatilityWindow: positiveInteger(
      options.volatilityWindow,
      'volatilityWindow',
    ),
    emaFastPeriod: positiveInteger(
      options.emaFastPeriod ?? DEFAULTS.emaFastPeriod,
      'emaFastPeriod',
    ),
    emaMediumPeriod: positiveInteger(
      options.emaMediumPeriod ?? DEFAULTS.emaMediumPeriod,
      'emaMediumPeriod',
    ),
    emaSlowPeriod: positiveInteger(
      options.emaSlowPeriod ?? DEFAULTS.emaSlowPeriod,
      'emaSlowPeriod',
    ),
    atrPeriod: positiveInteger(
      options.atrPeriod ?? DEFAULTS.atrPeriod,
      'atrPeriod',
    ),
    breakoutPeriod: positiveInteger(
      options.breakoutPeriod ?? DEFAULTS.breakoutPeriod,
      'breakoutPeriod',
    ),
    volumePeriod: positiveInteger(
      options.volumePeriod ?? DEFAULTS.volumePeriod,
      'volumePeriod',
    ),
    minimumRegimeSamples: positiveInteger(
      options.minimumRegimeSamples ?? DEFAULTS.minimumRegimeSamples,
      'minimumRegimeSamples',
    ),
  };

  if (
    resolved.emaFastPeriod >= resolved.emaMediumPeriod ||
    resolved.emaMediumPeriod >= resolved.emaSlowPeriod
  ) {
    throw new Error(
      'Os períodos das EMAs devem respeitar: rápida < intermediária < lenta.',
    );
  }

  return resolved;
}

/**
 * Quantidade mínima de candles encerrados necessária para todos os indicadores
 * e para uma classificação inicial de regime de volatilidade.
 */
export function getRequiredCandleCount(
  options: DayTradeIndicatorOptions | ResolvedIndicatorOptions,
): number {
  const config = resolveIndicatorOptions(options);

  return Math.max(
    2,
    config.emaSlowPeriod,
    config.atrPeriod + 1,
    config.breakoutPeriod + 1,
    config.volumePeriod + 1,
    config.volatilityWindow + config.minimumRegimeSamples + 1,
  );
}

// ---------------------------------------------------------------------------
// Validação dos candles
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateCandle(candle: DayTradeCandle, index: number): void {
  const fields: Array<[keyof DayTradeCandle, unknown]> = [
    ['openTime', candle.openTime],
    ['closeTime', candle.closeTime],
    ['open', candle.open],
    ['high', candle.high],
    ['low', candle.low],
    ['close', candle.close],
    ['volume', candle.volume],
  ];

  for (const [field, value] of fields) {
    if (!isFiniteNumber(value)) {
      throw new Error(`Candle ${index}: ${String(field)} não é um número válido.`);
    }
  }

  if (candle.quoteVolume !== undefined && !isFiniteNumber(candle.quoteVolume)) {
    throw new Error(`Candle ${index}: quoteVolume não é um número válido.`);
  }

  if (candle.openTime < 0 || candle.closeTime <= candle.openTime) {
    throw new Error(`Candle ${index}: intervalo de tempo inválido.`);
  }

  if (
    candle.open <= 0 ||
    candle.high <= 0 ||
    candle.low <= 0 ||
    candle.close <= 0
  ) {
    throw new Error(`Candle ${index}: preços devem ser maiores que zero.`);
  }

  if (candle.volume < 0 || (candle.quoteVolume ?? 0) < 0) {
    throw new Error(`Candle ${index}: volumes não podem ser negativos.`);
  }

  if (
    candle.high < Math.max(candle.open, candle.close, candle.low) ||
    candle.low > Math.min(candle.open, candle.close, candle.high)
  ) {
    throw new Error(`Candle ${index}: máxima ou mínima inconsistente.`);
  }
}

/**
 * Remove candles ainda abertos, valida os dados, ordena por openTime e mantém
 * somente o último registro em caso de timestamp duplicado.
 */
export function normalizeClosedCandles(
  candles: readonly DayTradeCandle[],
): DayTradeCandle[] {
  const byOpenTime = new Map<number, DayTradeCandle>();

  candles.forEach((candle, index) => {
    if (candle.isClosed === false) return;

    validateCandle(candle, index);

    byOpenTime.set(candle.openTime, {
      ...candle,
      quoteVolume: candle.quoteVolume ?? 0,
      isClosed: true,
    });
  });

  return Array.from(byOpenTime.values()).sort(
    (left, right) => left.openTime - right.openTime,
  );
}

// ---------------------------------------------------------------------------
// Utilitários matemáticos
// ---------------------------------------------------------------------------

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sampleStandardDeviation(
  values: readonly number[],
): number | null {
  if (values.length < 2) return null;

  const average = mean(values);
  if (average === null) return null;

  const variance = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  ) / (values.length - 1);

  return Math.sqrt(variance);
}

export function quantile(
  values: readonly number[],
  probability: number,
): number | null {
  if (values.length === 0) return null;
  if (probability < 0 || probability > 1) {
    throw new Error('A probabilidade do quantil deve estar entre 0 e 1.');
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) return sorted[lowerIndex];

  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

export function percentileRank(
  values: readonly number[],
  current: number,
): number | null {
  if (values.length === 0 || !Number.isFinite(current)) return null;

  const below = values.filter((value) => value < current).length;
  const equal = values.filter((value) => value === current).length;

  return ((below + equal * 0.5) / values.length) * 100;
}

// ---------------------------------------------------------------------------
// Séries técnicas
// ---------------------------------------------------------------------------

export function exponentialMovingAverage(
  values: readonly number[],
  period: number,
): Array<number | null> {
  positiveInteger(period, 'period');

  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;

  const seed = mean(values.slice(0, period));
  if (seed === null) return result;

  result[period - 1] = seed;

  const multiplier = 2 / (period + 1);
  let previous = seed;

  for (let index = period; index < values.length; index += 1) {
    const next = (values[index] - previous) * multiplier + previous;
    result[index] = next;
    previous = next;
  }

  return result;
}

export function trueRangeSeries(
  candles: readonly DayTradeCandle[],
): number[] {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;

    const previousClose = candles[index - 1].close;

    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

/** ATR pelo alisamento de Wilder. */
export function averageTrueRange(
  candles: readonly DayTradeCandle[],
  period: number,
): Array<number | null> {
  positiveInteger(period, 'period');

  const ranges = trueRangeSeries(candles);
  const result: Array<number | null> = Array(candles.length).fill(null);

  if (ranges.length < period) return result;

  const seed = mean(ranges.slice(0, period));
  if (seed === null) return result;

  result[period - 1] = seed;
  let previous = seed;

  for (let index = period; index < ranges.length; index += 1) {
    const next = (previous * (period - 1) + ranges[index]) / period;
    result[index] = next;
    previous = next;
  }

  return result;
}

/**
 * Média móvel simples dos valores anteriores, sem incluir o valor do próprio
 * índice. Isso evita usar informação do candle atual para comparar o volume.
 */
export function rollingPriorAverage(
  values: readonly number[],
  period: number,
): Array<number | null> {
  positiveInteger(period, 'period');

  const result: Array<number | null> = Array(values.length).fill(null);
  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) sum += values[index - 1];
    if (index > period) sum -= values[index - period - 1];

    if (index >= period) {
      result[index] = sum / period;
    }
  }

  return result;
}

/** Máxima dos candles anteriores, sem incluir o candle do próprio índice. */
export function rollingPriorHighestHigh(
  candles: readonly DayTradeCandle[],
  period: number,
): Array<number | null> {
  positiveInteger(period, 'period');

  return candles.map((_, index) => {
    if (index < period) return null;

    let highest = Number.NEGATIVE_INFINITY;

    for (let cursor = index - period; cursor < index; cursor += 1) {
      highest = Math.max(highest, candles[cursor].high);
    }

    return highest;
  });
}

/** Mínima dos candles anteriores, sem incluir o candle do próprio índice. */
export function rollingPriorLowestLow(
  candles: readonly DayTradeCandle[],
  period: number,
): Array<number | null> {
  positiveInteger(period, 'period');

  return candles.map((_, index) => {
    if (index < period) return null;

    let lowest = Number.POSITIVE_INFINITY;

    for (let cursor = index - period; cursor < index; cursor += 1) {
      lowest = Math.min(lowest, candles[cursor].low);
    }

    return lowest;
  });
}

/**
 * Volatilidade realizada móvel, baseada em retornos logarítmicos e anualizada.
 * O resultado é alinhado ao candle que encerra cada janela.
 */
export function rollingAnnualizedVolatility(
  candles: readonly DayTradeCandle[],
  window: number,
  periodsPerYear: number,
): Array<number | null> {
  positiveInteger(window, 'window');
  positiveInteger(periodsPerYear, 'periodsPerYear');

  const result: Array<number | null> = Array(candles.length).fill(null);
  const returns: Array<number | null> = candles.map((candle, index) => {
    if (index === 0) return null;
    return Math.log(candle.close / candles[index - 1].close);
  });

  for (let index = window; index < candles.length; index += 1) {
    const sample: number[] = [];

    for (let cursor = index - window + 1; cursor <= index; cursor += 1) {
      const value = returns[cursor];
      if (value !== null) sample.push(value);
    }

    if (sample.length !== window) continue;

    const deviation = sampleStandardDeviation(sample);
    if (deviation === null) continue;

    result[index] = deviation * Math.sqrt(periodsPerYear) * 100;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Métricas de risco
// ---------------------------------------------------------------------------

export function calculateDrawdown(
  candles: readonly DayTradeCandle[],
): DrawdownSummary {
  if (candles.length === 0) {
    throw new Error('Não há candles para calcular drawdown.');
  }

  let peak = candles[0].close;
  let maxDrawdownPct = 0;
  let currentDrawdownPct = 0;
  let candlesInDrawdown = 0;

  candles.forEach((candle) => {
    peak = Math.max(peak, candle.close);

    const drawdownPct = ((candle.close - peak) / peak) * 100;

    if (drawdownPct < 0) candlesInDrawdown += 1;
    if (drawdownPct < maxDrawdownPct) maxDrawdownPct = drawdownPct;

    currentDrawdownPct = drawdownPct;
  });

  return {
    maxDrawdownPct,
    currentDrawdownPct,
    timeInDrawdownPct: (candlesInDrawdown / candles.length) * 100,
    peakPrice: peak,
  };
}

export function classifyVolatilityRegime(
  history: readonly number[],
  current: number | null,
  minimumSamples: number = DEFAULTS.minimumRegimeSamples,
): {
  regime: VolatilityRegime;
  percentile: number | null;
} {
  positiveInteger(minimumSamples, 'minimumSamples');

  const validHistory = history.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );

  if (
    current === null ||
    !Number.isFinite(current) ||
    validHistory.length < minimumSamples
  ) {
    return { regime: 'indisponível', percentile: null };
  }

  const percentile = percentileRank(validHistory, current);
  const q25 = quantile(validHistory, 0.25);
  const q75 = quantile(validHistory, 0.75);
  const q90 = quantile(validHistory, 0.9);

  if (q25 === null || q75 === null || q90 === null) {
    return { regime: 'indisponível', percentile: null };
  }

  if (current <= q25) return { regime: 'calmo', percentile };
  if (current <= q75) return { regime: 'normal', percentile };
  if (current <= q90) return { regime: 'volátil', percentile };

  return { regime: 'extremo', percentile };
}

// ---------------------------------------------------------------------------
// Cálculo agregado
// ---------------------------------------------------------------------------

export function calculateDayTradeIndicators(
  inputCandles: readonly DayTradeCandle[],
  options: DayTradeIndicatorOptions,
): DayTradeIndicators {
  const config = resolveIndicatorOptions(options);
  const candles = normalizeClosedCandles(inputCandles);

  if (candles.length < 2) {
    throw new Error(
      'São necessários pelo menos dois candles encerrados para calcular os indicadores.',
    );
  }

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const quoteVolumes = candles.map((candle) => candle.quoteVolume ?? 0);

  const emaFastSeries = exponentialMovingAverage(
    closes,
    config.emaFastPeriod,
  );
  const emaMediumSeries = exponentialMovingAverage(
    closes,
    config.emaMediumPeriod,
  );
  const emaSlowSeries = exponentialMovingAverage(
    closes,
    config.emaSlowPeriod,
  );

  const atrSeries = averageTrueRange(candles, config.atrPeriod);
  const priorHighestSeries = rollingPriorHighestHigh(
    candles,
    config.breakoutPeriod,
  );
  const priorLowestSeries = rollingPriorLowestLow(
    candles,
    config.breakoutPeriod,
  );
  const averageVolumeSeries = rollingPriorAverage(
    volumes,
    config.volumePeriod,
  );
  const averageQuoteVolumeSeries = rollingPriorAverage(
    quoteVolumes,
    config.volumePeriod,
  );
  const volatilitySeries = rollingAnnualizedVolatility(
    candles,
    config.volatilityWindow,
    config.periodsPerYear,
  );

  const series: DayTradeIndicatorPoint[] = candles.map((candle, index) => {
    const atr = atrSeries[index];
    const averageVolume = averageVolumeSeries[index];

    return {
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      close: candle.close,
      emaFast: emaFastSeries[index],
      emaMedium: emaMediumSeries[index],
      emaSlow: emaSlowSeries[index],
      atr,
      atrPct: atr === null ? null : (atr / candle.close) * 100,
      priorHighestHigh: priorHighestSeries[index],
      priorLowestLow: priorLowestSeries[index],
      averageVolume,
      averageQuoteVolume: averageQuoteVolumeSeries[index],
      relativeVolume:
        averageVolume === null || averageVolume <= 0
          ? null
          : candle.volume / averageVolume,
      annualizedVolatilityPct: volatilitySeries[index],
    };
  });

  const lastIndex = candles.length - 1;
  const current = candles[lastIndex];
  const previous = candles[lastIndex - 1];
  const currentPoint = series[lastIndex];

  const requiredCandles = getRequiredCandleCount(config);
  const missingCandles = Math.max(0, requiredCandles - candles.length);

  // O valor atual não participa da distribuição usada para classificá-lo.
  // Isso evita que o próprio candle altere os quartis contra os quais será
  // comparado.
  const validVolatilityHistory = volatilitySeries
    .slice(0, lastIndex)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );

  const regime = classifyVolatilityRegime(
    validVolatilityHistory,
    currentPoint.annualizedVolatilityPct,
    config.minimumRegimeSamples,
  );

  const drawdown = calculateDrawdown(candles);
  const periodHigh = Math.max(...candles.map((candle) => candle.high));
  const periodLow = Math.min(...candles.map((candle) => candle.low));

  const breakoutLevel = currentPoint.priorHighestHigh;
  const supportLevel = currentPoint.priorLowestLow;

  const distanceToBreakoutPct =
    breakoutLevel === null
      ? null
      : ((breakoutLevel - current.close) / current.close) * 100;

  const distanceFromSupportPct =
    supportLevel === null
      ? null
      : ((current.close - supportLevel) / current.close) * 100;

  const distanceFromSlowEmaPct =
    currentPoint.emaSlow === null
      ? null
      : ((current.close - currentPoint.emaSlow) / currentPoint.emaSlow) * 100;

  const allCoreValuesAvailable = [
    currentPoint.emaFast,
    currentPoint.emaMedium,
    currentPoint.emaSlow,
    currentPoint.atr,
    currentPoint.priorHighestHigh,
    currentPoint.priorLowestLow,
    currentPoint.averageVolume,
    currentPoint.annualizedVolatilityPct,
  ].every((value) => value !== null && Number.isFinite(value));

  return {
    options: config,
    series,

    candleCount: candles.length,
    requiredCandles,
    ready: missingCandles === 0 && allCoreValuesAvailable,
    missingCandles,

    currentCandleOpenTime: current.openTime,
    currentCandleCloseTime: current.closeTime,
    previousCandleCloseTime: previous.closeTime,

    currentPrice: current.close,
    previousClose: previous.close,
    lastCandleReturnPct: ((current.close / previous.close) - 1) * 100,
    currentCandleRangePct: ((current.high - current.low) / current.open) * 100,

    emaFast: currentPoint.emaFast,
    emaMedium: currentPoint.emaMedium,
    emaSlow: currentPoint.emaSlow,

    atr: currentPoint.atr,
    atrPct: currentPoint.atrPct,

    breakoutLevel,
    supportLevel,
    distanceToBreakoutPct,
    distanceFromSupportPct,
    distanceFromSlowEmaPct,

    currentVolume: current.volume,
    currentQuoteVolume: current.quoteVolume ?? 0,
    averageVolume: currentPoint.averageVolume,
    averageQuoteVolume: currentPoint.averageQuoteVolume,
    relativeVolume: currentPoint.relativeVolume,

    annualizedVolatilityPct: currentPoint.annualizedVolatilityPct,
    volatilityRegime: regime.regime,
    volatilityPercentile: regime.percentile,

    periodHigh,
    periodLow,
    amplitudePct: ((periodHigh - periodLow) / periodLow) * 100,

    maxDrawdownPct: drawdown.maxDrawdownPct,
    currentDrawdownPct: drawdown.currentDrawdownPct,
    timeInDrawdownPct: drawdown.timeInDrawdownPct,

    comparisons: {
      priceAboveSlowEma:
        currentPoint.emaSlow === null
          ? null
          : current.close > currentPoint.emaSlow,
      fastEmaAboveMediumEma:
        currentPoint.emaFast === null || currentPoint.emaMedium === null
          ? null
          : currentPoint.emaFast > currentPoint.emaMedium,
      closeAboveBreakout:
        breakoutLevel === null ? null : current.close > breakoutLevel,
      volumeAboveAverage:
        currentPoint.averageVolume === null
          ? null
          : current.volume > currentPoint.averageVolume,
    },
  };
}

// ---------------------------------------------------------------------------
// Configurações prontas por timeframe
// ---------------------------------------------------------------------------

export const DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS = {
  '5m': {
    periodsPerYear: 12 * 24 * 365,
    volatilityWindow: 288,
  },
  '15m': {
    periodsPerYear: 4 * 24 * 365,
    volatilityWindow: 96,
  },
  '30m': {
    periodsPerYear: 2 * 24 * 365,
    volatilityWindow: 48,
  },
  '1h': {
    periodsPerYear: 24 * 365,
    volatilityWindow: 24,
  },
} as const satisfies Record<string, DayTradeIndicatorOptions>;

export type DayTradeIndicatorTimeframe =
  keyof typeof DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS;
