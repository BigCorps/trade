// ============================================================================
// VigIA Trade — Edge Function: avaliar-daytrade-alertas
// supabase/functions/avaliar-daytrade-alertas/index.ts
// ============================================================================
// Executada por cron. Avalia regras de Day Trade usando candles encerrados,
// salva o setup correspondente e envia alertas somente nas transições de status.
//
// Segurança:
// - publicar com verify_jwt = false porque a chamada vem do pg_cron;
// - a função exige CRON_SECRET no header x-cron-secret;
// - usa SERVICE_ROLE somente no servidor;
// - não lê chaves Binance e não executa ordens.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================================
// SEÇÃO 1: indicators.ts
// ============================================================================

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

// ============================================================================
// SEÇÃO 2: strategies/trendBreakout.ts
// ============================================================================

/**
 * lib/daytrade/strategies/trendBreakout.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Primeiro playbook educacional do módulo de Day Trade.
 *
 * Estratégia:
 * - Tendência principal positiva.
 * - Alinhamento das médias rápidas.
 * - Rompimento confirmado por candle encerrado.
 * - Volume acima da média anterior.
 * - Volatilidade fora do regime extremo.
 * - Plano com invalidação coerente e alvo mínimo de 2R.
 *
 * Este módulo NÃO consulta APIs, NÃO executa ordens e NÃO usa IA para decidir.
 * Ele apenas aplica regras determinísticas aos indicadores calculados pelo
 * arquivo lib/daytrade/indicators.ts.
 */


// ---------------------------------------------------------------------------
// Identidade do playbook
// ---------------------------------------------------------------------------

export const TREND_BREAKOUT_STRATEGY_ID = 'trend_breakout' as const;
export const TREND_BREAKOUT_STRATEGY_VERSION = '1.0.0' as const;

export const TREND_BREAKOUT_EDUCATIONAL_NOTICE =
  'Este resultado verifica condições técnicas históricas e não representa recomendação de compra ou promessa de resultado.';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type TrendBreakoutStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export type TrendBreakoutConditionId =
  | 'preco_acima_ema_lenta'
  | 'emas_alinhadas'
  | 'rompimento_confirmado'
  | 'volume_confirmado'
  | 'volatilidade_aceitavel'
  | 'plano_risco_retorno';

export interface TrendBreakoutCondition {
  id: TrendBreakoutConditionId;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface TrendBreakoutPlan {
  direction: 'long';

  /** Fechamento do candle encerrado que confirmou o setup. */
  entryReference: number;

  /** Ponto em que a hipótese técnica deixa de ser válida. */
  stopReference: number;

  /** Alvo matemático calculado a partir do múltiplo de risco escolhido. */
  targetReference: number;

  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;

  stopDistancePct: number;
  targetDistancePct: number;
  stopDistanceAtr: number;

  breakoutLevel: number;
  breakoutDistancePct: number;

  /** Preço acima do qual a entrada passa a ser considerada atrasada. */
  latestAcceptableEntry: number;

  /** Menor preço observado no candle de confirmação. */
  confirmationCandleLow: number;

  /** Stop estrutural baseado na mínima do candle de confirmação. */
  structuralStopCandidate: number;

  /** Stop alternativo calculado por ATR. */
  atrStopCandidate: number;
}

export interface TrendBreakoutOptions {
  /** Volume atual dividido pela média dos candles anteriores. Padrão: 1. */
  minimumRelativeVolume?: number;

  /** Distância do stop calculado por ATR. Padrão: 1,5 ATR. */
  atrStopMultiple?: number;

  /** Relação alvo/risco mínima. Padrão: 2. */
  minimumRiskRewardRatio?: number;

  /** Distância máxima até o rompimento para mostrar OBSERVAR. Padrão: 0,5 ATR. */
  observationDistanceAtr?: number;

  /** Distância máxima após a entrada de referência. Padrão: 0,5 ATR. */
  maximumLateEntryDistanceAtr?: number;

  /** Stop mínimo permitido em múltiplos de ATR. Padrão: 0,5 ATR. */
  minimumStopDistanceAtr?: number;

  /** Stop máximo permitido em múltiplos de ATR. Padrão: 3 ATR. */
  maximumStopDistanceAtr?: number;

  /**
   * Regimes que impedem a confirmação. Por padrão, somente extremo e
   * indisponível bloqueiam o setup.
   */
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface ResolvedTrendBreakoutOptions {
  minimumRelativeVolume: number;
  atrStopMultiple: number;
  minimumRiskRewardRatio: number;
  observationDistanceAtr: number;
  maximumLateEntryDistanceAtr: number;
  minimumStopDistanceAtr: number;
  maximumStopDistanceAtr: number;
  blockedVolatilityRegimes: readonly VolatilityRegime[];
}

export interface EvaluateTrendBreakoutInput {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;

  /**
   * Preço atual opcional, normalmente vindo do WebSocket. Ele serve apenas
   * para detectar entrada atrasada ou invalidação. Nunca confirma rompimento.
   */
  livePrice?: number | null;

  options?: TrendBreakoutOptions;
}

export interface AnalyzeTrendBreakoutInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  livePrice?: number | null;
  strategyOptions?: TrendBreakoutOptions;
}

export interface TrendBreakoutEvaluation {
  strategy: typeof TREND_BREAKOUT_STRATEGY_ID;
  strategyVersion: typeof TREND_BREAKOUT_STRATEGY_VERSION;
  direction: 'long';
  status: TrendBreakoutStatus;

  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;

  conditions: TrendBreakoutCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;

  plan: TrendBreakoutPlan | null;

  nextTrigger: string;
  summary: string;
  warnings: string[];
  educationalNotice: string;

  diagnostics: {
    ready: boolean;
    candleCount: number;
    requiredCandles: number;
    missingCandles: number;
    volatilityRegime: VolatilityRegime;
    volatilityPercentile: number | null;
    relativeVolume: number | null;
    distanceToBreakoutAtr: number | null;
    stopDistanceAtr: number | null;
  };
}

// ---------------------------------------------------------------------------
// Configuração e validação
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: ResolvedTrendBreakoutOptions = {
  minimumRelativeVolume: 1,
  atrStopMultiple: 1.5,
  minimumRiskRewardRatio: 2,
  observationDistanceAtr: 0.5,
  maximumLateEntryDistanceAtr: 0.5,
  minimumStopDistanceAtr: 0.5,
  maximumStopDistanceAtr: 3,
  blockedVolatilityRegimes: ['extremo', 'indisponível'],
};

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número maior que zero.`);
  }

  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} deve ser um número maior ou igual a zero.`);
  }

  return value;
}

export function resolveTrendBreakoutOptions(
  options: TrendBreakoutOptions = {},
): ResolvedTrendBreakoutOptions {
  const resolved: ResolvedTrendBreakoutOptions = {
    minimumRelativeVolume: positiveNumber(
      options.minimumRelativeVolume ?? DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    atrStopMultiple: positiveNumber(
      options.atrStopMultiple ?? DEFAULT_OPTIONS.atrStopMultiple,
      'atrStopMultiple',
    ),
    minimumRiskRewardRatio: positiveNumber(
      options.minimumRiskRewardRatio ??
        DEFAULT_OPTIONS.minimumRiskRewardRatio,
      'minimumRiskRewardRatio',
    ),
    observationDistanceAtr: nonNegativeNumber(
      options.observationDistanceAtr ??
        DEFAULT_OPTIONS.observationDistanceAtr,
      'observationDistanceAtr',
    ),
    maximumLateEntryDistanceAtr: nonNegativeNumber(
      options.maximumLateEntryDistanceAtr ??
        DEFAULT_OPTIONS.maximumLateEntryDistanceAtr,
      'maximumLateEntryDistanceAtr',
    ),
    minimumStopDistanceAtr: positiveNumber(
      options.minimumStopDistanceAtr ??
        DEFAULT_OPTIONS.minimumStopDistanceAtr,
      'minimumStopDistanceAtr',
    ),
    maximumStopDistanceAtr: positiveNumber(
      options.maximumStopDistanceAtr ??
        DEFAULT_OPTIONS.maximumStopDistanceAtr,
      'maximumStopDistanceAtr',
    ),
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ??
      DEFAULT_OPTIONS.blockedVolatilityRegimes,
  };

  if (
    resolved.minimumStopDistanceAtr >= resolved.maximumStopDistanceAtr
  ) {
    throw new Error(
      'minimumStopDistanceAtr deve ser menor que maximumStopDistanceAtr.',
    );
  }

  if (resolved.blockedVolatilityRegimes.length === 0) {
    throw new Error(
      'blockedVolatilityRegimes deve possuir pelo menos um regime.',
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Utilitários internos
// ---------------------------------------------------------------------------

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function formatNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function formatPct(value: number, fractionDigits = 2): string {
  return `${new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}%`;
}

function condition(
  value: Omit<TrendBreakoutCondition, 'available'> & {
    available?: boolean;
  },
): TrendBreakoutCondition {
  return {
    ...value,
    available: value.available ?? true,
  };
}

function createPlan(
  candle: DayTradeCandle,
  indicators: DayTradeIndicators,
  options: ResolvedTrendBreakoutOptions,
): TrendBreakoutPlan | null {
  const entryReference = candle.close;
  const atr = indicators.atr;
  const breakoutLevel = indicators.breakoutLevel;

  if (
    !isFinitePositive(atr) ||
    !isFinitePositive(breakoutLevel) ||
    !Number.isFinite(candle.low) ||
    candle.low <= 0
  ) {
    return null;
  }

  const structuralStopCandidate = candle.low;
  const atrStopCandidate = entryReference - atr * options.atrStopMultiple;

  // Para uma posição comprada, o menor dos dois níveis oferece mais espaço
  // contra oscilações normais. A validação posterior impede stops excessivos.
  const stopReference = Math.min(
    structuralStopCandidate,
    atrStopCandidate,
  );

  if (
    !Number.isFinite(stopReference) ||
    stopReference <= 0 ||
    stopReference >= entryReference
  ) {
    return null;
  }

  const riskPerUnit = entryReference - stopReference;
  const rewardPerUnit = riskPerUnit * options.minimumRiskRewardRatio;
  const targetReference = entryReference + rewardPerUnit;
  const riskRewardRatio = rewardPerUnit / riskPerUnit;
  const stopDistanceAtr = riskPerUnit / atr;

  return {
    direction: 'long',
    entryReference,
    stopReference,
    targetReference,
    riskPerUnit,
    rewardPerUnit,
    riskRewardRatio,
    stopDistancePct: (riskPerUnit / entryReference) * 100,
    targetDistancePct: (rewardPerUnit / entryReference) * 100,
    stopDistanceAtr,
    breakoutLevel,
    breakoutDistancePct:
      ((entryReference - breakoutLevel) / breakoutLevel) * 100,
    latestAcceptableEntry:
      entryReference + atr * options.maximumLateEntryDistanceAtr,
    confirmationCandleLow: candle.low,
    structuralStopCandidate,
    atrStopCandidate,
  };
}

function determineNextTrigger(
  conditions: readonly TrendBreakoutCondition[],
  indicators: DayTradeIndicators,
  plan: TrendBreakoutPlan | null,
  status: TrendBreakoutStatus,
): string {
  if (status === 'dados_insuficientes') {
    return `Carregue mais ${indicators.missingCandles} candle(s) encerrado(s) para completar os indicadores.`;
  }

  if (status === 'invalidado' && plan) {
    return `A formação perdeu validade porque o preço atingiu ou ficou abaixo de ${formatNumber(plan.stopReference)}.`;
  }

  if (status === 'entrada_atrasada' && plan) {
    return `Aguarde uma nova formação. O preço ultrapassou o limite de entrada de ${formatNumber(plan.latestAcceptableEntry)}.`;
  }

  if (status === 'condicoes_atendidas' && plan) {
    return `O candle encerrado confirmou o rompimento acima de ${formatNumber(plan.breakoutLevel)} com as condições do playbook atendidas.`;
  }

  const firstFailed = conditions.find(
    (item) => item.available && !item.passed,
  );

  switch (firstFailed?.id) {
    case 'preco_acima_ema_lenta':
      return indicators.emaSlow === null
        ? 'Aguarde a EMA lenta ficar disponível.'
        : `Aguarde um fechamento acima da EMA lenta em ${formatNumber(indicators.emaSlow)}.`;

    case 'emas_alinhadas':
      return 'Aguarde a EMA rápida ficar acima da EMA intermediária.';

    case 'rompimento_confirmado':
      return indicators.breakoutLevel === null
        ? 'Aguarde o nível de rompimento ficar disponível.'
        : `Aguarde o fechamento de um candle acima de ${formatNumber(indicators.breakoutLevel)}.`;

    case 'volume_confirmado':
      return 'Aguarde um candle encerrado com volume igual ou superior à média exigida.';

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado pelo playbook.';

    case 'plano_risco_retorno':
      return 'Aguarde uma formação com distância de stop compatível com o ATR e alvo mínimo de 2R.';

    default:
      return 'Aguarde a conclusão das condições técnicas restantes.';
  }
}

function determineSummary(
  status: TrendBreakoutStatus,
  passed: number,
  total: number,
): string {
  switch (status) {
    case 'dados_insuficientes':
      return 'Ainda não há candles encerrados suficientes para avaliar o playbook com segurança estatística.';
    case 'aguardar':
      return `${passed} de ${total} condições foram atendidas. O cenário ainda não está próximo de uma entrada válida.`;
    case 'observar':
      return `${passed} de ${total} condições foram atendidas. O ativo está próximo do gatilho, mas ainda falta confirmação.`;
    case 'condicoes_atendidas':
      return `${passed} de ${total} condições foram atendidas no candle encerrado mais recente.`;
    case 'entrada_atrasada':
      return 'O setup foi confirmado, mas o preço ao vivo já se afastou demais da entrada de referência.';
    case 'invalidado':
      return 'O setup chegou a ser confirmado, mas o preço ao vivo atingiu o nível de invalidação.';
  }
}

// ---------------------------------------------------------------------------
// Avaliação principal
// ---------------------------------------------------------------------------

export function evaluateTrendBreakout(
  input: EvaluateTrendBreakoutInput,
): TrendBreakoutEvaluation {
  const options = resolveTrendBreakoutOptions(input.options);
  const candles = normalizeClosedCandles(input.candles);

  if (candles.length === 0) {
    throw new Error(
      'É necessário informar pelo menos um candle encerrado para avaliar o playbook.',
    );
  }

  const currentCandle = candles[candles.length - 1];
  const indicators = input.indicators;

  if (
    currentCandle.openTime !== indicators.currentCandleOpenTime ||
    currentCandle.closeTime !== indicators.currentCandleCloseTime
  ) {
    throw new Error(
      'Os indicadores e os candles não estão alinhados no mesmo candle encerrado.',
    );
  }

  const livePrice =
    input.livePrice === null || input.livePrice === undefined
      ? null
      : positiveNumber(input.livePrice, 'livePrice');

  const plan = createPlan(currentCandle, indicators, options);

  const priceAboveSlowEmaAvailable = isFinitePositive(indicators.emaSlow);
  const emasAlignedAvailable =
    isFinitePositive(indicators.emaFast) &&
    isFinitePositive(indicators.emaMedium);
  const breakoutAvailable = isFinitePositive(indicators.breakoutLevel);
  const volumeAvailable =
    indicators.relativeVolume !== null &&
    Number.isFinite(indicators.relativeVolume);
  const volatilityAvailable =
    indicators.volatilityRegime !== 'indisponível';

  const stopDistanceValid =
    plan !== null &&
    plan.stopDistanceAtr >= options.minimumStopDistanceAtr &&
    plan.stopDistanceAtr <= options.maximumStopDistanceAtr;

  const riskRewardValid =
    plan !== null &&
    plan.riskRewardRatio >= options.minimumRiskRewardRatio;

  const conditions: TrendBreakoutCondition[] = [
    condition({
      id: 'preco_acima_ema_lenta',
      label: 'Preço acima da EMA lenta',
      available: priceAboveSlowEmaAvailable,
      passed:
        priceAboveSlowEmaAvailable &&
        currentCandle.close > (indicators.emaSlow as number),
      currentValue: currentCandle.close,
      requiredValue:
        indicators.emaSlow === null
          ? 'EMA lenta disponível'
          : `Fechamento acima de ${formatNumber(indicators.emaSlow)}`,
      explanation:
        indicators.emaSlow === null
          ? 'A média lenta ainda não possui histórico suficiente.'
          : currentCandle.close > indicators.emaSlow
            ? `O fechamento está ${formatPct(((currentCandle.close - indicators.emaSlow) / indicators.emaSlow) * 100)} acima da EMA lenta.`
            : `O fechamento está ${formatPct(((indicators.emaSlow - currentCandle.close) / indicators.emaSlow) * 100)} abaixo da EMA lenta.`,
    }),
    condition({
      id: 'emas_alinhadas',
      label: 'EMA rápida acima da intermediária',
      available: emasAlignedAvailable,
      passed:
        emasAlignedAvailable &&
        (indicators.emaFast as number) >
          (indicators.emaMedium as number),
      currentValue:
        emasAlignedAvailable
          ? `${formatNumber(indicators.emaFast as number)} / ${formatNumber(indicators.emaMedium as number)}`
          : null,
      requiredValue: 'EMA rápida > EMA intermediária',
      explanation:
        !emasAlignedAvailable
          ? 'As médias ainda não possuem histórico suficiente.'
          : (indicators.emaFast as number) >
              (indicators.emaMedium as number)
            ? 'A média rápida está acima da intermediária, indicando alinhamento positivo de curto prazo.'
            : 'A média rápida ainda não está acima da intermediária.',
    }),
    condition({
      id: 'rompimento_confirmado',
      label: 'Rompimento confirmado no fechamento',
      available: breakoutAvailable,
      passed:
        breakoutAvailable &&
        currentCandle.close > (indicators.breakoutLevel as number),
      currentValue: currentCandle.close,
      requiredValue:
        indicators.breakoutLevel === null
          ? 'Nível de rompimento disponível'
          : `Fechamento acima de ${formatNumber(indicators.breakoutLevel)}`,
      explanation:
        indicators.breakoutLevel === null
          ? 'Ainda não há candles suficientes para calcular a máxima anterior.'
          : currentCandle.close > indicators.breakoutLevel
            ? `O candle encerrou ${formatPct(((currentCandle.close - indicators.breakoutLevel) / indicators.breakoutLevel) * 100)} acima da máxima anterior.`
            : `O fechamento ainda está ${formatPct(((indicators.breakoutLevel - currentCandle.close) / currentCandle.close) * 100)} abaixo do nível de rompimento.`,
    }),
    condition({
      id: 'volume_confirmado',
      label: 'Volume acima da média',
      available: volumeAvailable,
      passed:
        volumeAvailable &&
        (indicators.relativeVolume as number) >=
          options.minimumRelativeVolume,
      currentValue: indicators.relativeVolume,
      requiredValue: `Volume relativo ≥ ${formatNumber(options.minimumRelativeVolume, 2)}×`,
      explanation:
        indicators.relativeVolume === null
          ? 'A média anterior de volume ainda não está disponível.'
          : indicators.relativeVolume >= options.minimumRelativeVolume
            ? `O volume do candle foi ${formatNumber(indicators.relativeVolume, 2)}× a média anterior.`
            : `O volume do candle foi ${formatNumber(indicators.relativeVolume, 2)}× a média anterior e ainda não confirmou o movimento.`,
    }),
    condition({
      id: 'volatilidade_aceitavel',
      label: 'Volatilidade fora do regime bloqueado',
      available: volatilityAvailable,
      passed:
        volatilityAvailable &&
        !options.blockedVolatilityRegimes.includes(
          indicators.volatilityRegime,
        ),
      currentValue: indicators.volatilityRegime,
      requiredValue: `Fora de: ${options.blockedVolatilityRegimes.join(', ')}`,
      explanation:
        indicators.volatilityRegime === 'indisponível'
          ? 'Ainda não há histórico suficiente para classificar o regime de volatilidade.'
          : options.blockedVolatilityRegimes.includes(
                indicators.volatilityRegime,
              )
            ? `A volatilidade está em regime ${indicators.volatilityRegime}, bloqueado pelo playbook.`
            : `A volatilidade está em regime ${indicators.volatilityRegime}, permitido pelo playbook.`,
    }),
    condition({
      id: 'plano_risco_retorno',
      label: 'Plano com risco e alvo coerentes',
      available: plan !== null,
      passed: stopDistanceValid && riskRewardValid,
      currentValue:
        plan === null
          ? null
          : `${formatNumber(plan.stopDistanceAtr, 2)} ATR · ${formatNumber(plan.riskRewardRatio, 2)}R`,
      requiredValue:
        `${formatNumber(options.minimumStopDistanceAtr, 2)}–` +
        `${formatNumber(options.maximumStopDistanceAtr, 2)} ATR e ` +
        `alvo ≥ ${formatNumber(options.minimumRiskRewardRatio, 2)}R`,
      explanation:
        plan === null
          ? 'Não foi possível construir entrada, invalidação e alvo com os dados atuais.'
          : !stopDistanceValid
            ? `A distância do stop seria de ${formatNumber(plan.stopDistanceAtr, 2)} ATR, fora do intervalo permitido.`
            : `O stop está a ${formatNumber(plan.stopDistanceAtr, 2)} ATR e o alvo oferece ${formatNumber(plan.riskRewardRatio, 2)} vezes o risco.`,
    }),
  ];

  const passedConditions = conditions.filter((item) => item.passed).length;
  const totalConditions = conditions.length;
  const allConditionsMet =
    indicators.ready && passedConditions === totalConditions;

  const distanceToBreakoutAtr =
    isFinitePositive(indicators.atr) &&
    isFinitePositive(indicators.breakoutLevel)
      ? Math.max(
          0,
          indicators.breakoutLevel - currentCandle.close,
        ) / indicators.atr
      : null;

  const trendConditionsPassed = conditions
    .filter((item) =>
      [
        'preco_acima_ema_lenta',
        'emas_alinhadas',
        'volatilidade_aceitavel',
      ].includes(item.id),
    )
    .every((item) => item.passed);

  const nearBreakout =
    distanceToBreakoutAtr !== null &&
    distanceToBreakoutAtr <= options.observationDistanceAtr;

  const liveInvalidated =
    allConditionsMet &&
    plan !== null &&
    livePrice !== null &&
    livePrice <= plan.stopReference;

  const liveEntryLate =
    allConditionsMet &&
    plan !== null &&
    livePrice !== null &&
    livePrice > plan.latestAcceptableEntry;

  let status: TrendBreakoutStatus;

  if (!indicators.ready) {
    status = 'dados_insuficientes';
  } else if (liveInvalidated) {
    status = 'invalidado';
  } else if (liveEntryLate) {
    status = 'entrada_atrasada';
  } else if (allConditionsMet) {
    status = 'condicoes_atendidas';
  } else if (
    trendConditionsPassed &&
    nearBreakout &&
    passedConditions >= 3
  ) {
    status = 'observar';
  } else {
    status = 'aguardar';
  }

  const warnings: string[] = [];

  if (!indicators.ready) {
    warnings.push(
      `Faltam ${indicators.missingCandles} candle(s) encerrado(s) para completar os indicadores.`,
    );
  }

  if (indicators.volatilityRegime === 'extremo') {
    warnings.push(
      'A volatilidade está no regime extremo do próprio histórico analisado.',
    );
  }

  if (
    indicators.relativeVolume !== null &&
    indicators.relativeVolume < options.minimumRelativeVolume
  ) {
    warnings.push(
      'O rompimento não possui confirmação suficiente de volume pelo critério configurado.',
    );
  }

  if (plan && !stopDistanceValid) {
    warnings.push(
      `A invalidação ficaria a ${formatNumber(plan.stopDistanceAtr, 2)} ATR da entrada, fora do limite configurado.`,
    );
  }

  if (liveEntryLate && plan && livePrice !== null) {
    warnings.push(
      `O preço ao vivo está ${formatPct(((livePrice - plan.entryReference) / plan.entryReference) * 100)} acima da entrada de referência.`,
    );
  }

  if (liveInvalidated && plan) {
    warnings.push(
      `O preço ao vivo atingiu ou perdeu a invalidação em ${formatNumber(plan.stopReference)}.`,
    );
  }

  return {
    strategy: TREND_BREAKOUT_STRATEGY_ID,
    strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
    direction: 'long',
    status,

    candleOpenTime: currentCandle.openTime,
    candleCloseTime: currentCandle.closeTime,
    evaluatedPrice: currentCandle.close,
    livePrice,

    conditions,
    passedConditions,
    totalConditions,
    scorePct: (passedConditions / totalConditions) * 100,
    allConditionsMet,

    plan,

    nextTrigger: determineNextTrigger(
      conditions,
      indicators,
      plan,
      status,
    ),
    summary: determineSummary(
      status,
      passedConditions,
      totalConditions,
    ),
    warnings,
    educationalNotice: TREND_BREAKOUT_EDUCATIONAL_NOTICE,

    diagnostics: {
      ready: indicators.ready,
      candleCount: indicators.candleCount,
      requiredCandles: indicators.requiredCandles,
      missingCandles: indicators.missingCandles,
      volatilityRegime: indicators.volatilityRegime,
      volatilityPercentile: indicators.volatilityPercentile,
      relativeVolume: indicators.relativeVolume,
      distanceToBreakoutAtr,
      stopDistanceAtr: plan?.stopDistanceAtr ?? null,
    },
  };
}

/**
 * Atalho conveniente para calcular indicadores e avaliar o playbook em uma
 * única chamada. Útil na página, no backtest e em futuras Edge Functions.
 */
export function analyzeTrendBreakout(
  input: AnalyzeTrendBreakoutInput,
): {
  indicators: DayTradeIndicators;
  evaluation: TrendBreakoutEvaluation;
} {
  const indicators = calculateDayTradeIndicators(
    input.candles,
    input.indicatorOptions,
  );

  const evaluation = evaluateTrendBreakout({
    candles: input.candles,
    indicators,
    livePrice: input.livePrice,
    options: input.strategyOptions,
  });

  return { indicators, evaluation };
}

// ---------------------------------------------------------------------------
// Rótulos prontos para interface
// ---------------------------------------------------------------------------

export const TREND_BREAKOUT_STATUS_LABELS: Record<
  TrendBreakoutStatus,
  {
    label: string;
    shortDescription: string;
  }
> = {
  dados_insuficientes: {
    label: 'Dados insuficientes',
    shortDescription: 'Ainda faltam candles para calcular todos os critérios.',
  },
  aguardar: {
    label: 'Aguardar',
    shortDescription: 'As condições atuais ainda não formam um setup válido.',
  },
  observar: {
    label: 'Observar',
    shortDescription: 'O preço está próximo do gatilho, mas falta confirmação.',
  },
  condicoes_atendidas: {
    label: 'Condições atendidas',
    shortDescription: 'O último candle encerrado cumpriu todas as regras.',
  },
  entrada_atrasada: {
    label: 'Entrada atrasada',
    shortDescription: 'O preço ao vivo já se afastou da entrada calculada.',
  },
  invalidado: {
    label: 'Invalidado',
    shortDescription: 'O preço atingiu o ponto que invalida a formação.',
  },
};

// ============================================================================
// SEÇÃO 3: handler (index.ts original)
// ============================================================================

type AlertableStatus =
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

interface DayTradeAlertRule {
  id: string;
  user_id: string;
  symbol: string;
  timeframe: DayTradeIndicatorTimeframe;
  strategy: string;
  notify_statuses: AlertableStatus[];
  canal: 'email';
  ativo: boolean;
  cooldown_minutes: number;
  strategy_options: Record<string, unknown>;
  last_status: TrendBreakoutStatus | null;
  last_candle_open_time: string | null;
  last_triggered_at: string | null;
}

interface MarketData {
  closedCandles: DayTradeCandle[];
  livePrice: number;
  source: string;
}

interface UserNotificationState {
  email: string | null;
  enabled: boolean;
}

interface RunSummary {
  regras: number;
  grupos: number;
  avaliadas: number;
  setups_salvos: number;
  transicoes: number;
  eventos: number;
  emails_enviados: number;
  emails_nao_enviados: number;
  duplicados: number;
  erros: number;
}

const ALLOWED_TIMEFRAMES = new Set<DayTradeIndicatorTimeframe>([
  '5m',
  '15m',
  '30m',
  '1h',
]);

const ALERTABLE_STATUSES = new Set<AlertableStatus>([
  'observar',
  'condicoes_atendidas',
  'entrada_atrasada',
  'invalidado',
]);

const BINANCE_PUBLIC_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const EXTRA_CANDLES = 60;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RULES = 500;

const nowIso = () => new Date().toISOString();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truncate(value: unknown, limit = 500): string {
  return String(value ?? '').slice(0, limit);
}

function validRule(rule: DayTradeAlertRule): boolean {
  return (
    /^[A-Z0-9]{5,20}$/.test(rule.symbol) &&
    rule.symbol.endsWith('USDT') &&
    ALLOWED_TIMEFRAMES.has(rule.timeframe) &&
    rule.strategy === TREND_BREAKOUT_STRATEGY_ID &&
    Array.isArray(rule.notify_statuses) &&
    rule.notify_statuses.every((status) => ALERTABLE_STATUSES.has(status))
  );
}

function parseStrategyOptions(
  value: Record<string, unknown> | null | undefined,
): TrendBreakoutOptions {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};

  const numberOption = (
    key: keyof TrendBreakoutOptions,
    minimum: number,
    maximum: number,
  ): number | undefined => {
    if (source[key as string] === undefined) return undefined;
    const parsed = Number(source[key as string]);

    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(
        `strategy_options.${String(key)} deve estar entre ${minimum} e ${maximum}`,
      );
    }

    return parsed;
  };

  const parsed: TrendBreakoutOptions = {
    minimumRelativeVolume: numberOption('minimumRelativeVolume', 0.5, 10),
    atrStopMultiple: numberOption('atrStopMultiple', 0.25, 10),
    minimumRiskRewardRatio: numberOption(
      'minimumRiskRewardRatio',
      1,
      10,
    ),
    observationDistanceAtr: numberOption('observationDistanceAtr', 0, 10),
    maximumLateEntryDistanceAtr: numberOption(
      'maximumLateEntryDistanceAtr',
      0,
      10,
    ),
    minimumStopDistanceAtr: numberOption(
      'minimumStopDistanceAtr',
      0.1,
      10,
    ),
    maximumStopDistanceAtr: numberOption(
      'maximumStopDistanceAtr',
      0.2,
      20,
    ),
  };

  return Object.fromEntries(
    Object.entries(parsed).filter(([, option]) => option !== undefined),
  ) as TrendBreakoutOptions;
}

function parseKline(row: unknown): DayTradeCandle {
  if (!Array.isArray(row) || row.length < 8) {
    throw new Error('candle retornado em formato inesperado');
  }

  const candle: DayTradeCandle = {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    isClosed: true,
  };

  const values = [
    candle.openTime,
    candle.closeTime,
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume,
    candle.quoteVolume,
  ];

  if (values.some((item) => !Number.isFinite(item))) {
    throw new Error('candle retornado com valor numérico inválido');
  }

  return candle;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarketData(
  symbol: string,
  timeframe: DayTradeIndicatorTimeframe,
): Promise<MarketData> {
  const options = DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe];
  const required = getRequiredCandleCount(options);
  const limit = Math.min(1_000, required + EXTRA_CANDLES + 1);
  const failures: string[] = [];

  for (const baseUrl of BINANCE_PUBLIC_BASE_URLS) {
    const url = new URL('/api/v3/klines', baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', timeframe);
    url.searchParams.set('limit', String(limit));

    try {
      const response = await fetchWithTimeout(url.toString());

      if (!response.ok) {
        failures.push(`${baseUrl}: HTTP ${response.status}`);
        continue;
      }

      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        failures.push(`${baseUrl}: resposta vazia`);
        continue;
      }

      const parsed = rows.map(parseKline);
      const currentTime = Date.now();
      const closedCandles = parsed.filter(
        (candle) => candle.closeTime < currentTime,
      );
      const latest = parsed[parsed.length - 1];

      if (closedCandles.length < required || !latest) {
        failures.push(`${baseUrl}: histórico encerrado insuficiente`);
        continue;
      }

      return {
        closedCandles,
        livePrice: latest.close,
        source: baseUrl,
      };
    } catch (error) {
      failures.push(
        `${baseUrl}: ${
          error instanceof Error ? error.message : 'falha desconhecida'
        }`,
      );
    }
  }

  throw new Error(
    `não foi possível consultar ${symbol}/${timeframe}: ${failures.join(' | ')}`,
  );
}

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

function statusLabel(status: TrendBreakoutStatus): string {
  switch (status) {
    case 'dados_insuficientes':
      return 'Dados insuficientes';
    case 'aguardar':
      return 'Aguardar';
    case 'observar':
      return 'Observar';
    case 'condicoes_atendidas':
      return 'Condições atendidas';
    case 'entrada_atrasada':
      return 'Entrada atrasada';
    case 'invalidado':
      return 'Setup invalidado';
  }
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: value >= 1_000 ? 2 : 4,
    maximumFractionDigits: value >= 1_000 ? 2 : 8,
  });
}

function buildMessage(
  rule: DayTradeAlertRule,
  evaluation: TrendBreakoutEvaluation,
): string {
  const title = `${rule.symbol} · ${rule.timeframe} · ${statusLabel(evaluation.status)}`;
  const score = `${evaluation.passedConditions}/${evaluation.totalConditions} condições`;
  const plan = evaluation.plan;

  if (evaluation.status === 'condicoes_atendidas' && plan) {
    return [
      title,
      score,
      `Entrada de referência: ${formatPrice(plan.entryReference)} USDT`,
      `Invalidação: ${formatPrice(plan.stopReference)} USDT`,
      `Alvo: ${formatPrice(plan.targetReference)} USDT`,
      `Risco/retorno: ${plan.riskRewardRatio.toFixed(2)}R`,
      evaluation.nextTrigger,
    ].join('\n');
  }

  return [
    title,
    score,
    evaluation.summary,
    evaluation.nextTrigger,
  ].join('\n');
}

async function sendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<string | null> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const fromEmail = Deno.env.get('FROM_EMAIL');

  if (!apiKey || !fromEmail) {
    return 'RESEND_API_KEY ou FROM_EMAIL não configurado';
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `VigIA Trade <${fromEmail}>`,
      to: [to],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    return `Resend ${response.status}: ${truncate(await response.text(), 300)}`;
  }

  return null;
}

async function getUserNotificationState(
  admin: any,
  userId: string,
  cache: Map<string, UserNotificationState>,
): Promise<UserNotificationState> {
  const cached = cache.get(userId);
  if (cached) return cached;

  const [{ data: userResult }, { data: settings }] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    admin
      .from('user_settings')
      .select('email_notif')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  const state: UserNotificationState = {
    email: userResult?.user?.email ?? null,
    enabled: settings?.email_notif ?? true,
  };

  cache.set(userId, state);
  return state;
}

function cooldownAvailable(rule: DayTradeAlertRule): boolean {
  if (!rule.last_triggered_at || rule.cooldown_minutes <= 0) return true;

  const elapsed =
    Date.now() - new Date(rule.last_triggered_at).getTime();

  return elapsed >= rule.cooldown_minutes * 60_000;
}

async function saveSetup(
  admin: any,
  rule: DayTradeAlertRule,
  indicators: DayTradeIndicators,
  evaluation: TrendBreakoutEvaluation,
): Promise<Record<string, unknown>> {
  const plan = evaluation.plan;

  const row = {
    user_id: rule.user_id,
    symbol: rule.symbol,
    timeframe: rule.timeframe,
    strategy: TREND_BREAKOUT_STRATEGY_ID,
    status: evaluation.status,
    score: evaluation.passedConditions,
    total_conditions: evaluation.totalConditions,
    conditions: evaluation.conditions,
    indicators: indicatorSnapshot(indicators),
    warnings: evaluation.warnings,
    next_trigger: evaluation.nextTrigger,
    entry_reference: plan?.entryReference ?? null,
    stop_reference: plan?.stopReference ?? null,
    target_reference: plan?.targetReference ?? null,
    risk_reward_ratio: plan?.riskRewardRatio ?? null,
    last_closed_price: evaluation.evaluatedPrice,
    last_live_price: evaluation.livePrice,
    candle_open_time: new Date(evaluation.candleOpenTime).toISOString(),
    candle_close_time: new Date(evaluation.candleCloseTime).toISOString(),
  };

  const { data, error } = await admin
    .from('daytrade_setups')
    .upsert(row, {
      onConflict:
        'user_id,symbol,timeframe,strategy,candle_open_time',
    })
    .select(
      'id,user_id,symbol,timeframe,strategy,status,score,total_conditions,candle_open_time,candle_close_time,criado_em,atualizado_em',
    )
    .single();

  if (error || !data) {
    throw new Error(
      `falha ao salvar setup: ${error?.message ?? 'resposta vazia'}`,
    );
  }

  return data as Record<string, unknown>;
}

async function reserveEvent(
  admin: any,
  rule: DayTradeAlertRule,
  setupId: string,
  evaluation: TrendBreakoutEvaluation,
  message: string,
): Promise<{ eventId: string | null; duplicate: boolean }> {
  const { data, error } = await admin
    .from('daytrade_alert_events')
    .insert({
      rule_id: rule.id,
      setup_id: setupId,
      user_id: rule.user_id,
      status: evaluation.status,
      mensagem: message,
      notificado: false,
      payload: {
        symbol: rule.symbol,
        timeframe: rule.timeframe,
        strategy: rule.strategy,
        strategy_version: TREND_BREAKOUT_STRATEGY_VERSION,
        score: evaluation.passedConditions,
        total_conditions: evaluation.totalConditions,
        plan: evaluation.plan,
        summary: evaluation.summary,
        next_trigger: evaluation.nextTrigger,
        warnings: evaluation.warnings,
        candle_open_time: new Date(
          evaluation.candleOpenTime,
        ).toISOString(),
        candle_close_time: new Date(
          evaluation.candleCloseTime,
        ).toISOString(),
      },
    })
    .select('id')
    .single();

  if (error?.code === '23505') {
    return { eventId: null, duplicate: true };
  }

  if (error || !data?.id) {
    throw new Error(
      `falha ao reservar evento: ${error?.message ?? 'resposta vazia'}`,
    );
  }

  return { eventId: String(data.id), duplicate: false };
}

async function notifyEvent(
  admin: any,
  eventId: string,
  rule: DayTradeAlertRule,
  evaluation: TrendBreakoutEvaluation,
  message: string,
  userState: UserNotificationState,
): Promise<{ notified: boolean; error: string | null }> {
  const siteUrl = (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '');
  const setupLink = siteUrl
    ? `${siteUrl}/daytrade?symbol=${encodeURIComponent(rule.symbol)}&timeframe=${encodeURIComponent(rule.timeframe)}`
    : '';

  let error: string | null = null;

  if (!userState.enabled) {
    error = 'notificações por email desativadas nas configurações';
  } else if (!userState.email) {
    error = 'usuário sem email disponível';
  } else {
    const text = [
      message,
      setupLink ? `\nAbrir no VigIA: ${setupLink}` : '',
      '\nO alerta verifica condições técnicas objetivas. Não constitui recomendação de investimento nem promessa de resultado.',
      '\n— VigIA Trade',
    ].filter(Boolean).join('\n');

    error = await sendEmail(
      userState.email,
      `VigIA · ${rule.symbol} · ${statusLabel(evaluation.status)}`,
      text,
    );
  }

  const { error: updateError } = await admin
    .from('daytrade_alert_events')
    .update({
      notificado: error === null,
      erro_envio: error,
    })
    .eq('id', eventId);

  if (updateError) {
    throw new Error(
      `evento criado, mas falhou ao registrar envio: ${updateError.message}`,
    );
  }

  return { notified: error === null, error };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'método não permitido' }, 405);
  }

  const expectedSecret = Deno.env.get('CRON_SECRET') ?? '';
  const suppliedSecret = req.headers.get('x-cron-secret') ?? '';

  if (
    !expectedSecret ||
    !constantTimeEqual(expectedSecret, suppliedSecret)
  ) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: 'configuração interna ausente' }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const summary: RunSummary = {
    regras: 0,
    grupos: 0,
    avaliadas: 0,
    setups_salvos: 0,
    transicoes: 0,
    eventos: 0,
    emails_enviados: 0,
    emails_nao_enviados: 0,
    duplicados: 0,
    erros: 0,
  };

  const errors: Array<{ rule_id?: string; group?: string; error: string }> = [];

  try {
    const { data: rows, error: rulesError } = await admin
      .from('daytrade_alert_rules')
      .select(
        'id,user_id,symbol,timeframe,strategy,notify_statuses,canal,ativo,cooldown_minutes,strategy_options,last_status,last_candle_open_time,last_triggered_at',
      )
      .eq('ativo', true)
      .order('criado_em', { ascending: true })
      .limit(MAX_RULES);

    if (rulesError) {
      return jsonResponse({ error: rulesError.message }, 500);
    }

    const rules = ((rows ?? []) as DayTradeAlertRule[]).filter(validRule);
    summary.regras = rules.length;

    if (rules.length === 0) {
      return jsonResponse({ ok: true, ...summary, errors: [] });
    }

    const groups = new Map<string, DayTradeAlertRule[]>();

    for (const rule of rules) {
      const key = `${rule.symbol}|${rule.timeframe}`;
      const current = groups.get(key) ?? [];
      current.push(rule);
      groups.set(key, current);
    }

    summary.grupos = groups.size;

    const userCache = new Map<string, UserNotificationState>();

    for (const [groupKey, groupRules] of groups.entries()) {
      const sample = groupRules[0];
      if (!sample) continue;

      let market: MarketData;
      let indicators: DayTradeIndicators;

      try {
        market = await fetchMarketData(sample.symbol, sample.timeframe);
        indicators = calculateDayTradeIndicators(
          market.closedCandles,
          DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[sample.timeframe],
        );
      } catch (error) {
        summary.erros += groupRules.length;
        errors.push({
          group: groupKey,
          error: truncate(
            error instanceof Error ? error.message : 'erro de mercado',
          ),
        });
        continue;
      }

      for (const rule of groupRules) {
        try {
          const evaluation = evaluateTrendBreakout({
            candles: market.closedCandles,
            indicators,
            livePrice: market.livePrice,
            options: parseStrategyOptions(rule.strategy_options),
          });

          summary.avaliadas++;

          const setup = await saveSetup(
            admin,
            rule,
            indicators,
            evaluation,
          );
          summary.setups_salvos++;

          const previousStatus = rule.last_status;
          const statusChanged = previousStatus !== evaluation.status;
          const alertable = ALERTABLE_STATUSES.has(
            evaluation.status as AlertableStatus,
          );
          const requested = rule.notify_statuses.includes(
            evaluation.status as AlertableStatus,
          );
          const canTrigger =
            statusChanged &&
            alertable &&
            requested &&
            cooldownAvailable(rule);

          if (statusChanged) summary.transicoes++;

          let triggeredAt: string | null = null;

          if (canTrigger) {
            const setupId = String(setup.id);
            const message = buildMessage(rule, evaluation);
            const reservation = await reserveEvent(
              admin,
              rule,
              setupId,
              evaluation,
              message,
            );

            if (reservation.duplicate || !reservation.eventId) {
              summary.duplicados++;
            } else {
              summary.eventos++;
              triggeredAt = nowIso();

              const userState = await getUserNotificationState(
                admin,
                rule.user_id,
                userCache,
              );

              const delivery = await notifyEvent(
                admin,
                reservation.eventId,
                rule,
                evaluation,
                message,
                userState,
              );

              if (delivery.notified) summary.emails_enviados++;
              else summary.emails_nao_enviados++;
            }
          }

          const updates: Record<string, unknown> = {
            last_status: evaluation.status,
            last_candle_open_time: new Date(
              evaluation.candleOpenTime,
            ).toISOString(),
          };

          if (triggeredAt) updates.last_triggered_at = triggeredAt;

          const { error: ruleUpdateError } = await admin
            .from('daytrade_alert_rules')
            .update(updates)
            .eq('id', rule.id)
            .eq('user_id', rule.user_id);

          if (ruleUpdateError) {
            throw new Error(
              `falha ao atualizar estado da regra: ${ruleUpdateError.message}`,
            );
          }
        } catch (error) {
          summary.erros++;
          errors.push({
            rule_id: rule.id,
            error: truncate(
              error instanceof Error ? error.message : 'erro desconhecido',
            ),
          });
        }
      }
    }

    return jsonResponse({
      ok: summary.erros === 0,
      ...summary,
      errors: errors.slice(0, 30),
      generated_at: nowIso(),
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: truncate(
        error instanceof Error ? error.message : 'erro interno',
      ),
      ...summary,
      errors: errors.slice(0, 30),
    }, 500);
  }
});