// ============================================================================
// VigIA Trade — Edge Function: processar-backtest-daytrade (bundle único)
// supabase/functions/processar-backtest-daytrade/index.ts
// ============================================================================
// Worker assíncrono das análises aprofundadas criadas por backtest-daytrade.
//
// Este arquivo contém o motor completo no próprio index.ts, sem dependência de
// arquivos _shared, conforme o formato usado nas Edge Functions online.
//
// Segurança:
// - verify_jwt = false no supabase/config.toml;
// - exige x-cron-secret compatível com CRON_SECRET;
// - utiliza service_role apenas no servidor;
// - não acessa chaves da Binance do usuário;
// - não cria nem executa ordens;
// - processa uma tarefa por invocação para evitar concorrência excessiva;
// - martingale_testnet permanece restrito a backtest/Testnet.
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

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
// SEÇÃO 3: risk.ts (isFiniteNumber renomeado para isFiniteRiskNumber)
// ============================================================================

/**
 * lib/daytrade/risk.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Motor puro de gerenciamento de risco para o módulo de Day Trade.
 *
 * Responsabilidades:
 * - Validar entrada, stop e alvo.
 * - Calcular risco máximo em USDT a partir do saldo e do percentual definido.
 * - Estimar taxas e slippage de forma conservadora.
 * - Calcular a quantidade máxima permitida pelo risco.
 * - Limitar a quantidade ao saldo disponível e às regras da corretora.
 * - Arredondar a quantidade para baixo conforme o stepSize do ativo.
 * - Calcular risco/retorno bruto e líquido estimado.
 * - Entregar avisos claros para a interface, sem executar ordens.
 *
 * Regras importantes:
 * - Este arquivo NÃO consulta APIs, NÃO envia ordens e NÃO usa IA para decidir.
 * - Por padrão, não permite risco superior a 2% do saldo por operação.
 * - Por padrão, não considera alavancagem.
 * - Quantidades são sempre arredondadas para baixo, nunca para cima.
 */

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type TradeDirection = 'long' | 'short';

export interface TradePlanLike {
  direction?: TradeDirection;
  entryReference: number;
  stopReference: number;
  targetReference?: number | null;
}

export interface PositionRiskPolicy {
  /** Percentual mostrado como referência conservadora. Padrão: 1%. */
  recommendedRiskPercent?: number;

  /** Percentual máximo aceito pelo cálculo. Padrão: 2%. */
  maximumRiskPercent?: number;
}

export interface PositionSizingInput {
  accountBalance: number;

  /**
   * Saldo realmente livre para a operação. Quando omitido, usa accountBalance.
   * O cálculo nunca considera mais do que o saldo total informado.
   */
  availableBalance?: number;

  /** Percentual do saldo total que pode ser perdido no stop. */
  riskPercent: number;

  direction?: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number | null;

  /** Taxa estimada por execução, em percentual. Padrão: 0,1%. */
  feeRatePct?: number;

  /** Slippage adversa estimada por execução, em percentual. Padrão: 0,05%. */
  slippagePct?: number;

  /** Incremento mínimo da quantidade aceito pela corretora. */
  stepSize?: number;

  /** Quantidade mínima permitida pela corretora. */
  minQuantity?: number;

  /** Quantidade máxima permitida pela corretora. */
  maxQuantity?: number;

  /** Valor nocional mínimo da ordem. */
  minNotional?: number;

  /** Valor nocional máximo permitido para a operação. */
  maxNotional?: number;

  /** Mantido falso no modo educacional. */
  allowLeverage?: boolean;

  /** Usado somente quando allowLeverage=true. */
  leverage?: number;

  policy?: PositionRiskPolicy;
}

export type PositionSizingFailureStatus =
  | 'invalid_input'
  | 'risk_limit_exceeded'
  | 'insufficient_balance'
  | 'quantity_below_minimum'
  | 'notional_below_minimum'
  | 'quantity_zero';

export type PositionSizingSuccessStatus =
  | 'ready'
  | 'limited_by_balance'
  | 'limited_by_max_quantity'
  | 'limited_by_max_notional';

export interface PositionSizingDiagnostics {
  recommendedRiskPercent: number;
  maximumRiskPercent: number;
  effectiveAvailableBalance: number | null;
  buyingPower: number | null;
  rawRiskQuantity: number | null;
  affordableQuantity: number | null;
  quantityBeforeRounding: number | null;
  quantityAfterRounding: number | null;
  minimumRequiredQuantity: number | null;
  minimumRequiredNotional: number | null;
}

export interface PositionSizingFailure {
  ok: false;
  status: PositionSizingFailureStatus;
  errors: string[];
  warnings: string[];
  diagnostics: PositionSizingDiagnostics;
}

export interface PositionSizingSuccess {
  ok: true;
  status: PositionSizingSuccessStatus;
  errors: [];
  warnings: string[];

  direction: TradeDirection;
  accountBalance: number;
  availableBalance: number;
  riskPercent: number;

  entryPrice: number;
  stopPrice: number;
  targetPrice: number | null;

  quantity: number;
  notional: number;

  /** Distância simples entre entrada e stop por unidade do ativo. */
  priceRiskPerUnit: number;

  /** Risco estimado por unidade incluindo taxas e slippage até o stop. */
  estimatedRiskPerUnit: number;

  maximumRiskUsdt: number;
  estimatedPriceRiskUsdt: number;
  estimatedFeesAtStopUsdt: number;
  estimatedSlippageAtStopUsdt: number;
  estimatedTotalRiskUsdt: number;
  estimatedTotalRiskPct: number;

  grossRewardPerUnit: number | null;
  estimatedNetRewardPerUnit: number | null;
  grossRiskRewardRatio: number | null;
  estimatedNetRiskRewardRatio: number | null;

  estimatedGrossRewardUsdt: number | null;
  estimatedNetRewardUsdt: number | null;

  feeRatePct: number;
  slippagePct: number;
  leverage: number;

  diagnostics: PositionSizingDiagnostics;
}

export type PositionSizingResult =
  | PositionSizingFailure
  | PositionSizingSuccess;

export interface PositionSizingFromPlanInput
  extends Omit<
    PositionSizingInput,
    'direction' | 'entryPrice' | 'stopPrice' | 'targetPrice'
  > {
  plan: TradePlanLike;
}

export interface RiskRewardInput {
  direction?: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  feeRatePct?: number;
  slippagePct?: number;
}

export interface RiskRewardResult {
  valid: boolean;
  errors: string[];
  direction: TradeDirection;
  priceRiskPerUnit: number | null;
  estimatedRiskPerUnit: number | null;
  grossRewardPerUnit: number | null;
  estimatedNetRewardPerUnit: number | null;
  grossRiskRewardRatio: number | null;
  estimatedNetRiskRewardRatio: number | null;
}

export interface RMultipleInput {
  direction?: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  exitPrice: number;
  feeRatePct?: number;
  slippagePct?: number;
}

export interface RMultipleResult {
  valid: boolean;
  errors: string[];
  grossPnlPerUnit: number | null;
  estimatedNetPnlPerUnit: number | null;
  estimatedInitialRiskPerUnit: number | null;
  grossRMultiple: number | null;
  estimatedNetRMultiple: number | null;
}

// ---------------------------------------------------------------------------
// Configuração padrão
// ---------------------------------------------------------------------------

const DEFAULT_FEE_RATE_PCT = 0.1;
const DEFAULT_SLIPPAGE_PCT = 0.05;
const DEFAULT_STEP_SIZE = 0.00000001;
const DEFAULT_RECOMMENDED_RISK_PERCENT = 1;
const DEFAULT_MAXIMUM_RISK_PERCENT = 2;
const MAX_DECIMAL_PLACES = 12;

// ---------------------------------------------------------------------------
// Validações e utilitários
// ---------------------------------------------------------------------------

function isFiniteRiskNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isPositive(value: number): boolean {
  return isFiniteRiskNumber(value) && value > 0;
}

function isNonNegative(value: number): boolean {
  return isFiniteRiskNumber(value) && value >= 0;
}

function resolveDirection(direction?: TradeDirection): TradeDirection {
  return direction ?? 'long';
}

function resolvePolicy(policy?: PositionRiskPolicy): {
  recommendedRiskPercent: number;
  maximumRiskPercent: number;
} {
  const recommendedRiskPercent =
    policy?.recommendedRiskPercent ?? DEFAULT_RECOMMENDED_RISK_PERCENT;
  const maximumRiskPercent =
    policy?.maximumRiskPercent ?? DEFAULT_MAXIMUM_RISK_PERCENT;

  if (!isPositive(recommendedRiskPercent)) {
    throw new Error('recommendedRiskPercent deve ser maior que zero.');
  }

  if (!isPositive(maximumRiskPercent)) {
    throw new Error('maximumRiskPercent deve ser maior que zero.');
  }

  if (recommendedRiskPercent > maximumRiskPercent) {
    throw new Error(
      'recommendedRiskPercent não pode ser maior que maximumRiskPercent.',
    );
  }

  return { recommendedRiskPercent, maximumRiskPercent };
}

function resolveCostRates(input: {
  feeRatePct?: number;
  slippagePct?: number;
}): { feeRatePct: number; slippagePct: number } {
  const feeRatePct = input.feeRatePct ?? DEFAULT_FEE_RATE_PCT;
  const slippagePct = input.slippagePct ?? DEFAULT_SLIPPAGE_PCT;

  if (!isNonNegative(feeRatePct)) {
    throw new Error('feeRatePct deve ser maior ou igual a zero.');
  }

  if (!isNonNegative(slippagePct)) {
    throw new Error('slippagePct deve ser maior ou igual a zero.');
  }

  return { feeRatePct, slippagePct };
}

function validatePriceStructure(
  direction: TradeDirection,
  entryPrice: number,
  stopPrice: number,
  targetPrice?: number | null,
): string[] {
  const errors: string[] = [];

  if (!isPositive(entryPrice)) {
    errors.push('O preço de entrada deve ser maior que zero.');
  }

  if (!isPositive(stopPrice)) {
    errors.push('O preço de stop deve ser maior que zero.');
  }

  if (targetPrice !== null && targetPrice !== undefined && !isPositive(targetPrice)) {
    errors.push('O preço-alvo deve ser maior que zero.');
  }

  if (errors.length > 0) return errors;

  if (direction === 'long') {
    if (stopPrice >= entryPrice) {
      errors.push(
        'Em uma operação comprada, o stop deve ficar abaixo da entrada.',
      );
    }

    if (
      targetPrice !== null &&
      targetPrice !== undefined &&
      targetPrice <= entryPrice
    ) {
      errors.push(
        'Em uma operação comprada, o alvo deve ficar acima da entrada.',
      );
    }
  } else {
    if (stopPrice <= entryPrice) {
      errors.push(
        'Em uma operação vendida, o stop deve ficar acima da entrada.',
      );
    }

    if (
      targetPrice !== null &&
      targetPrice !== undefined &&
      targetPrice >= entryPrice
    ) {
      errors.push(
        'Em uma operação vendida, o alvo deve ficar abaixo da entrada.',
      );
    }
  }

  return errors;
}

function decimalPlaces(value: number): number {
  if (!isFiniteRiskNumber(value)) return 0;

  const text = value.toString().toLowerCase();

  if (text.includes('e-')) {
    const [coefficient, exponentText] = text.split('e-');
    const exponent = Number(exponentText);
    const coefficientDecimals = coefficient.split('.')[1]?.length ?? 0;
    return Math.min(MAX_DECIMAL_PLACES, exponent + coefficientDecimals);
  }

  return Math.min(MAX_DECIMAL_PLACES, text.split('.')[1]?.length ?? 0);
}

/**
 * Arredonda sempre para baixo conforme o stepSize, evitando elevar o risco.
 */
export function roundQuantityDown(
  quantity: number,
  stepSize = DEFAULT_STEP_SIZE,
): number {
  if (!isNonNegative(quantity)) {
    throw new Error('quantity deve ser maior ou igual a zero.');
  }

  if (!isPositive(stepSize)) {
    throw new Error('stepSize deve ser maior que zero.');
  }

  const precision = decimalPlaces(stepSize);
  const factor = 10 ** precision;
  const integerStep = Math.max(1, Math.round(stepSize * factor));
  const integerQuantity = Math.floor(
    (quantity * factor + Number.EPSILON * factor) / integerStep,
  ) * integerStep;

  return Number((integerQuantity / factor).toFixed(precision));
}

function priceRiskPerUnit(
  direction: TradeDirection,
  entryPrice: number,
  stopPrice: number,
): number {
  return direction === 'long'
    ? entryPrice - stopPrice
    : stopPrice - entryPrice;
}

function grossRewardPerUnit(
  direction: TradeDirection,
  entryPrice: number,
  targetPrice: number,
): number {
  return direction === 'long'
    ? targetPrice - entryPrice
    : entryPrice - targetPrice;
}

function executionFeePerUnit(price: number, feeRatePct: number): number {
  return price * (feeRatePct / 100);
}

function executionSlippagePerUnit(
  price: number,
  slippagePct: number,
): number {
  return price * (slippagePct / 100);
}

function calculateEstimatedRiskPerUnit(input: {
  entryPrice: number;
  stopPrice: number;
  priceRisk: number;
  feeRatePct: number;
  slippagePct: number;
}): {
  estimatedFees: number;
  estimatedSlippage: number;
  estimatedRisk: number;
} {
  const estimatedFees =
    executionFeePerUnit(input.entryPrice, input.feeRatePct) +
    executionFeePerUnit(input.stopPrice, input.feeRatePct);

  const estimatedSlippage =
    executionSlippagePerUnit(input.entryPrice, input.slippagePct) +
    executionSlippagePerUnit(input.stopPrice, input.slippagePct);

  return {
    estimatedFees,
    estimatedSlippage,
    estimatedRisk: input.priceRisk + estimatedFees + estimatedSlippage,
  };
}

function emptyDiagnostics(
  recommendedRiskPercent: number,
  maximumRiskPercent: number,
): PositionSizingDiagnostics {
  return {
    recommendedRiskPercent,
    maximumRiskPercent,
    effectiveAvailableBalance: null,
    buyingPower: null,
    rawRiskQuantity: null,
    affordableQuantity: null,
    quantityBeforeRounding: null,
    quantityAfterRounding: null,
    minimumRequiredQuantity: null,
    minimumRequiredNotional: null,
  };
}

function failure(
  status: PositionSizingFailureStatus,
  errors: string[],
  warnings: string[],
  diagnostics: PositionSizingDiagnostics,
): PositionSizingFailure {
  return {
    ok: false,
    status,
    errors,
    warnings,
    diagnostics,
  };
}

function minimumQuantityForNotional(
  minNotional: number,
  entryPrice: number,
): number {
  if (minNotional <= 0 || entryPrice <= 0) return 0;
  return minNotional / entryPrice;
}

// ---------------------------------------------------------------------------
// Relação risco/retorno
// ---------------------------------------------------------------------------

export function calculateRiskReward(
  input: RiskRewardInput,
): RiskRewardResult {
  const direction = resolveDirection(input.direction);
  const errors = validatePriceStructure(
    direction,
    input.entryPrice,
    input.stopPrice,
    input.targetPrice,
  );

  let rates: { feeRatePct: number; slippagePct: number };

  try {
    rates = resolveCostRates(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Custos inválidos.');
    rates = {
      feeRatePct: DEFAULT_FEE_RATE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
    };
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      direction,
      priceRiskPerUnit: null,
      estimatedRiskPerUnit: null,
      grossRewardPerUnit: null,
      estimatedNetRewardPerUnit: null,
      grossRiskRewardRatio: null,
      estimatedNetRiskRewardRatio: null,
    };
  }

  const priceRisk = priceRiskPerUnit(
    direction,
    input.entryPrice,
    input.stopPrice,
  );
  const grossReward = grossRewardPerUnit(
    direction,
    input.entryPrice,
    input.targetPrice,
  );

  const riskEstimate = calculateEstimatedRiskPerUnit({
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    priceRisk,
    ...rates,
  });

  const rewardCosts =
    executionFeePerUnit(input.entryPrice, rates.feeRatePct) +
    executionFeePerUnit(input.targetPrice, rates.feeRatePct) +
    executionSlippagePerUnit(input.entryPrice, rates.slippagePct) +
    executionSlippagePerUnit(input.targetPrice, rates.slippagePct);

  const netReward = grossReward - rewardCosts;

  return {
    valid: true,
    errors: [],
    direction,
    priceRiskPerUnit: priceRisk,
    estimatedRiskPerUnit: riskEstimate.estimatedRisk,
    grossRewardPerUnit: grossReward,
    estimatedNetRewardPerUnit: netReward,
    grossRiskRewardRatio: grossReward / priceRisk,
    estimatedNetRiskRewardRatio:
      netReward > 0 ? netReward / riskEstimate.estimatedRisk : 0,
  };
}

// ---------------------------------------------------------------------------
// Dimensionamento da posição
// ---------------------------------------------------------------------------

export function calculatePositionSize(
  input: PositionSizingInput,
): PositionSizingResult {
  let policy: {
    recommendedRiskPercent: number;
    maximumRiskPercent: number;
  };

  try {
    policy = resolvePolicy(input.policy);
  } catch (error) {
    policy = {
      recommendedRiskPercent: DEFAULT_RECOMMENDED_RISK_PERCENT,
      maximumRiskPercent: DEFAULT_MAXIMUM_RISK_PERCENT,
    };

    return failure(
      'invalid_input',
      [error instanceof Error ? error.message : 'Política de risco inválida.'],
      [],
      emptyDiagnostics(
        policy.recommendedRiskPercent,
        policy.maximumRiskPercent,
      ),
    );
  }

  const diagnostics = emptyDiagnostics(
    policy.recommendedRiskPercent,
    policy.maximumRiskPercent,
  );
  const errors: string[] = [];
  const warnings: string[] = [];
  const direction = resolveDirection(input.direction);

  if (!isPositive(input.accountBalance)) {
    errors.push('O saldo total deve ser maior que zero.');
  }

  if (!isPositive(input.riskPercent)) {
    errors.push('O percentual de risco deve ser maior que zero.');
  }

  errors.push(
    ...validatePriceStructure(
      direction,
      input.entryPrice,
      input.stopPrice,
      input.targetPrice,
    ),
  );

  const availableBalanceInput = input.availableBalance ?? input.accountBalance;

  if (!isPositive(availableBalanceInput)) {
    errors.push('O saldo disponível deve ser maior que zero.');
  }

  const stepSize = input.stepSize ?? DEFAULT_STEP_SIZE;
  const minQuantity = input.minQuantity ?? 0;
  const maxQuantity = input.maxQuantity ?? Number.POSITIVE_INFINITY;
  const minNotional = input.minNotional ?? 0;
  const maxNotional = input.maxNotional ?? Number.POSITIVE_INFINITY;
  const allowLeverage = input.allowLeverage ?? false;
  const requestedLeverage = input.leverage ?? 1;

  if (!isPositive(stepSize)) errors.push('stepSize deve ser maior que zero.');
  if (!isNonNegative(minQuantity)) {
    errors.push('minQuantity deve ser maior ou igual a zero.');
  }
  if (!(isPositive(maxQuantity) || maxQuantity === Number.POSITIVE_INFINITY)) {
    errors.push('maxQuantity deve ser maior que zero.');
  }
  if (!isNonNegative(minNotional)) {
    errors.push('minNotional deve ser maior ou igual a zero.');
  }
  if (!(isPositive(maxNotional) || maxNotional === Number.POSITIVE_INFINITY)) {
    errors.push('maxNotional deve ser maior que zero.');
  }
  if (!isPositive(requestedLeverage)) {
    errors.push('leverage deve ser maior que zero.');
  }

  let rates: { feeRatePct: number; slippagePct: number };

  try {
    rates = resolveCostRates(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Custos inválidos.');
    rates = {
      feeRatePct: DEFAULT_FEE_RATE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
    };
  }

  if (errors.length > 0) {
    return failure('invalid_input', errors, warnings, diagnostics);
  }

  if (input.riskPercent > policy.maximumRiskPercent) {
    return failure(
      'risk_limit_exceeded',
      [
        `O risco informado de ${input.riskPercent}% supera o limite de ${policy.maximumRiskPercent}% por operação.`,
      ],
      warnings,
      diagnostics,
    );
  }

  if (input.riskPercent > policy.recommendedRiskPercent) {
    warnings.push(
      `O risco informado está acima da referência conservadora de ${policy.recommendedRiskPercent}% por operação.`,
    );
  }

  const effectiveAvailableBalance = Math.min(
    input.accountBalance,
    availableBalanceInput,
  );
  const leverage = allowLeverage ? requestedLeverage : 1;

  if (!allowLeverage && requestedLeverage > 1) {
    warnings.push(
      'A alavancagem informada foi ignorada porque allowLeverage está desativado.',
    );
  }

  if (allowLeverage && leverage > 1) {
    warnings.push(
      'O cálculo está considerando alavancagem. Perdas e liquidação exigem controles adicionais fora deste módulo.',
    );
  }

  const buyingPower = effectiveAvailableBalance * leverage;
  diagnostics.effectiveAvailableBalance = effectiveAvailableBalance;
  diagnostics.buyingPower = buyingPower;

  const priceRisk = priceRiskPerUnit(
    direction,
    input.entryPrice,
    input.stopPrice,
  );

  const riskEstimate = calculateEstimatedRiskPerUnit({
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    priceRisk,
    ...rates,
  });

  const maximumRiskUsdt = input.accountBalance * (input.riskPercent / 100);
  const rawRiskQuantity = maximumRiskUsdt / riskEstimate.estimatedRisk;

  // Reserva taxa estimada da entrada para não ultrapassar o saldo disponível.
  const entryCostMultiplier =
    1 + rates.feeRatePct / 100 + rates.slippagePct / 100;
  const affordableQuantity =
    buyingPower / (input.entryPrice * entryCostMultiplier);

  diagnostics.rawRiskQuantity = rawRiskQuantity;
  diagnostics.affordableQuantity = affordableQuantity;

  let quantityBeforeRounding = Math.min(rawRiskQuantity, affordableQuantity);
  let successStatus: PositionSizingSuccessStatus = 'ready';

  if (affordableQuantity < rawRiskQuantity) {
    successStatus = 'limited_by_balance';
    warnings.push(
      'A quantidade foi reduzida porque o saldo disponível não comporta toda a posição calculada pelo limite de risco.',
    );
  }

  if (maxQuantity < quantityBeforeRounding) {
    quantityBeforeRounding = maxQuantity;
    successStatus = 'limited_by_max_quantity';
    warnings.push(
      'A quantidade foi reduzida para respeitar o limite máximo permitido.',
    );
  }

  const quantityAllowedByMaxNotional =
    maxNotional === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : maxNotional / input.entryPrice;

  if (quantityAllowedByMaxNotional < quantityBeforeRounding) {
    quantityBeforeRounding = quantityAllowedByMaxNotional;
    successStatus = 'limited_by_max_notional';
    warnings.push(
      'A quantidade foi reduzida para respeitar o valor nocional máximo.',
    );
  }

  diagnostics.quantityBeforeRounding = quantityBeforeRounding;

  const quantity = roundQuantityDown(quantityBeforeRounding, stepSize);
  const minimumByNotional = minimumQuantityForNotional(
    minNotional,
    input.entryPrice,
  );
  const minimumRequiredQuantity = Math.max(minQuantity, minimumByNotional);

  diagnostics.quantityAfterRounding = quantity;
  diagnostics.minimumRequiredQuantity = minimumRequiredQuantity;
  diagnostics.minimumRequiredNotional = minNotional;

  if (quantity <= 0) {
    return failure(
      'quantity_zero',
      [
        'O tamanho calculado ficou abaixo do incremento mínimo de quantidade. Aumentar a posição para atingir o mínimo elevaria o risco definido.',
      ],
      warnings,
      diagnostics,
    );
  }

  if (quantity < minQuantity) {
    return failure(
      'quantity_below_minimum',
      [
        `A quantidade segura calculada (${quantity}) ficou abaixo da quantidade mínima permitida (${minQuantity}).`,
      ],
      warnings,
      diagnostics,
    );
  }

  const notional = quantity * input.entryPrice;

  if (notional < minNotional) {
    return failure(
      'notional_below_minimum',
      [
        `O valor seguro calculado (${notional}) ficou abaixo do nocional mínimo permitido (${minNotional}).`,
      ],
      warnings,
      diagnostics,
    );
  }

  if (notional > buyingPower + Number.EPSILON) {
    return failure(
      'insufficient_balance',
      [
        'O saldo disponível não é suficiente para a quantidade calculada após o arredondamento.',
      ],
      warnings,
      diagnostics,
    );
  }

  const estimatedPriceRiskUsdt = priceRisk * quantity;
  const estimatedFeesAtStopUsdt = riskEstimate.estimatedFees * quantity;
  const estimatedSlippageAtStopUsdt =
    riskEstimate.estimatedSlippage * quantity;
  const estimatedTotalRiskUsdt = riskEstimate.estimatedRisk * quantity;
  const estimatedTotalRiskPct =
    (estimatedTotalRiskUsdt / input.accountBalance) * 100;

  if (estimatedTotalRiskUsdt > maximumRiskUsdt + 1e-8) {
    return failure(
      'invalid_input',
      [
        'O risco estimado ultrapassou o limite após os ajustes de quantidade. Revise stepSize e os parâmetros informados.',
      ],
      warnings,
      diagnostics,
    );
  }

  let grossReward: number | null = null;
  let netReward: number | null = null;
  let grossRiskRewardRatio: number | null = null;
  let estimatedNetRiskRewardRatio: number | null = null;
  let estimatedGrossRewardUsdt: number | null = null;
  let estimatedNetRewardUsdt: number | null = null;

  if (input.targetPrice !== null && input.targetPrice !== undefined) {
    const riskReward = calculateRiskReward({
      direction,
      entryPrice: input.entryPrice,
      stopPrice: input.stopPrice,
      targetPrice: input.targetPrice,
      ...rates,
    });

    if (riskReward.valid) {
      grossReward = riskReward.grossRewardPerUnit;
      netReward = riskReward.estimatedNetRewardPerUnit;
      grossRiskRewardRatio = riskReward.grossRiskRewardRatio;
      estimatedNetRiskRewardRatio =
        riskReward.estimatedNetRiskRewardRatio;
      estimatedGrossRewardUsdt =
        riskReward.grossRewardPerUnit !== null
          ? riskReward.grossRewardPerUnit * quantity
          : null;
      estimatedNetRewardUsdt =
        riskReward.estimatedNetRewardPerUnit !== null
          ? riskReward.estimatedNetRewardPerUnit * quantity
          : null;

      if (
        estimatedNetRiskRewardRatio !== null &&
        estimatedNetRiskRewardRatio < 1
      ) {
        warnings.push(
          'Após taxas e slippage estimados, o ganho potencial ficou menor que o risco estimado.',
        );
      }
    }
  }

  return {
    ok: true,
    status: successStatus,
    errors: [],
    warnings,

    direction,
    accountBalance: input.accountBalance,
    availableBalance: effectiveAvailableBalance,
    riskPercent: input.riskPercent,

    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    targetPrice: input.targetPrice ?? null,

    quantity,
    notional,

    priceRiskPerUnit: priceRisk,
    estimatedRiskPerUnit: riskEstimate.estimatedRisk,

    maximumRiskUsdt,
    estimatedPriceRiskUsdt,
    estimatedFeesAtStopUsdt,
    estimatedSlippageAtStopUsdt,
    estimatedTotalRiskUsdt,
    estimatedTotalRiskPct,

    grossRewardPerUnit: grossReward,
    estimatedNetRewardPerUnit: netReward,
    grossRiskRewardRatio,
    estimatedNetRiskRewardRatio,

    estimatedGrossRewardUsdt,
    estimatedNetRewardUsdt,

    feeRatePct: rates.feeRatePct,
    slippagePct: rates.slippagePct,
    leverage,

    diagnostics,
  };
}

/**
 * Atalho compatível estruturalmente com TrendBreakoutPlan.
 */
export function calculatePositionSizeFromPlan(
  input: PositionSizingFromPlanInput,
): PositionSizingResult {
  return calculatePositionSize({
    accountBalance: input.accountBalance,
    availableBalance: input.availableBalance,
    riskPercent: input.riskPercent,
    direction: input.plan.direction ?? 'long',
    entryPrice: input.plan.entryReference,
    stopPrice: input.plan.stopReference,
    targetPrice: input.plan.targetReference ?? null,
    feeRatePct: input.feeRatePct,
    slippagePct: input.slippagePct,
    stepSize: input.stepSize,
    minQuantity: input.minQuantity,
    maxQuantity: input.maxQuantity,
    minNotional: input.minNotional,
    maxNotional: input.maxNotional,
    allowLeverage: input.allowLeverage,
    leverage: input.leverage,
    policy: input.policy,
  });
}

// ---------------------------------------------------------------------------
// Resultado em múltiplos de R para o diário futuro
// ---------------------------------------------------------------------------

export function calculateRMultiple(input: RMultipleInput): RMultipleResult {
  const direction = resolveDirection(input.direction);
  const errors = validatePriceStructure(
    direction,
    input.entryPrice,
    input.stopPrice,
  );

  if (!isPositive(input.exitPrice)) {
    errors.push('O preço de saída deve ser maior que zero.');
  }

  let rates: { feeRatePct: number; slippagePct: number };

  try {
    rates = resolveCostRates(input);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Custos inválidos.');
    rates = {
      feeRatePct: DEFAULT_FEE_RATE_PCT,
      slippagePct: DEFAULT_SLIPPAGE_PCT,
    };
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      grossPnlPerUnit: null,
      estimatedNetPnlPerUnit: null,
      estimatedInitialRiskPerUnit: null,
      grossRMultiple: null,
      estimatedNetRMultiple: null,
    };
  }

  const initialPriceRisk = priceRiskPerUnit(
    direction,
    input.entryPrice,
    input.stopPrice,
  );
  const initialRiskEstimate = calculateEstimatedRiskPerUnit({
    entryPrice: input.entryPrice,
    stopPrice: input.stopPrice,
    priceRisk: initialPriceRisk,
    ...rates,
  });

  const grossPnl =
    direction === 'long'
      ? input.exitPrice - input.entryPrice
      : input.entryPrice - input.exitPrice;

  const exitCosts =
    executionFeePerUnit(input.entryPrice, rates.feeRatePct) +
    executionFeePerUnit(input.exitPrice, rates.feeRatePct) +
    executionSlippagePerUnit(input.entryPrice, rates.slippagePct) +
    executionSlippagePerUnit(input.exitPrice, rates.slippagePct);

  const netPnl = grossPnl - exitCosts;

  return {
    valid: true,
    errors: [],
    grossPnlPerUnit: grossPnl,
    estimatedNetPnlPerUnit: netPnl,
    estimatedInitialRiskPerUnit: initialRiskEstimate.estimatedRisk,
    grossRMultiple: grossPnl / initialPriceRisk,
    estimatedNetRMultiple: netPnl / initialRiskEstimate.estimatedRisk,
  };
}

// ============================================================================
// SEÇÃO 4: backtest.ts (DEFAULT_OPTIONS renomeado para DEFAULT_BACKTEST_OPTIONS)
// ============================================================================

/**
 * lib/daytrade/backtest.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Motor puro de backtest do playbook Tendência com Rompimento.
 *
 * Princípios:
 * - utiliza somente candles encerrados;
 * - o sinal nasce no fechamento do candle de confirmação;
 * - a entrada é simulada na abertura do candle seguinte;
 * - nunca consulta candles futuros para confirmar um sinal;
 * - considera taxas, slippage, dimensionamento por risco e saldo disponível;
 * - mantém somente uma posição aberta por vez;
 * - quando stop e alvo são tocados no mesmo candle, o padrão conservador
 *   considera o stop primeiro.
 *
 * Este arquivo NÃO consulta APIs, NÃO grava no banco e NÃO executa ordens.
 */


// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type BacktestIntrabarPriority = 'stop_first' | 'target_first';

export type BacktestExitReason =
  | 'stop'
  | 'target'
  | 'maximum_holding'
  | 'end_of_data';

export type BacktestTradeResult = 'win' | 'loss' | 'breakeven';

export type BacktestSkippedSignalReason =
  | 'position_open'
  | 'no_next_candle'
  | 'entry_below_stop'
  | 'entry_above_reference_limit'
  | 'position_sizing_failed';

export interface TrendBreakoutBacktestOptions {
  /** Patrimônio inicial da simulação. Padrão: 1.000 USDT. */
  initialCapitalUsdt?: number;

  /** Percentual do patrimônio arriscado por operação. Padrão: 1%. Máximo: 2%. */
  riskPercent?: number;

  /** Taxa estimada por execução. Padrão: 0,1%. */
  feeRatePct?: number;

  /** Slippage adversa estimada por execução. Padrão: 0,05%. */
  slippagePct?: number;

  /** Incremento mínimo usado no arredondamento da quantidade. */
  stepSize?: number;

  /** Quantidade mínima opcional. */
  minQuantity?: number;

  /** Nocional mínimo opcional. */
  minNotional?: number;

  /** Limita o valor de cada posição. Por padrão, usa todo o saldo disponível. */
  maxPositionNotional?: number;

  /**
   * Ordem assumida quando a máxima toca o alvo e a mínima toca o stop no
   * mesmo candle. O padrão stop_first é deliberadamente conservador.
   */
  intrabarPriority?: BacktestIntrabarPriority;

  /**
   * Número máximo de candles após a entrada. Zero desativa o encerramento por
   * tempo. O padrão é zero.
   */
  maximumHoldingCandles?: number;

  /**
   * Distância máxima entre a abertura seguinte e a entrada de referência,
   * em múltiplos de ATR. O padrão usa o mesmo limite do playbook: 0,5 ATR.
   */
  maximumNextOpenDistanceAtr?: number;
}

export interface ResolvedTrendBreakoutBacktestOptions {
  initialCapitalUsdt: number;
  riskPercent: number;
  feeRatePct: number;
  slippagePct: number;
  stepSize: number;
  minQuantity: number;
  minNotional: number;
  maxPositionNotional: number;
  intrabarPriority: BacktestIntrabarPriority;
  maximumHoldingCandles: number;
  maximumNextOpenDistanceAtr: number;
}

export interface TrendBreakoutBacktestInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  strategyOptions?: TrendBreakoutOptions;
  backtestOptions?: TrendBreakoutBacktestOptions;
}

export interface BacktestSkippedSignal {
  signalCandleOpenTime: number;
  signalCandleCloseTime: number;
  reason: BacktestSkippedSignalReason;
  explanation: string;
}

export interface TrendBreakoutBacktestTrade {
  id: number;
  strategy: typeof TREND_BREAKOUT_STRATEGY_ID;
  strategyVersion: typeof TREND_BREAKOUT_STRATEGY_VERSION;
  direction: 'long';

  signalCandleOpenTime: number;
  signalCandleCloseTime: number;
  entryTime: number;
  exitTime: number;

  signalClose: number;
  plannedEntryReference: number;
  rawEntryPrice: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  rawExitPrice: number;
  exitPrice: number;

  quantity: number;
  entryNotional: number;
  initialRiskUsdt: number;

  entryFeeUsdt: number;
  exitFeeUsdt: number;
  totalFeesUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  resultR: number;

  result: BacktestTradeResult;
  exitReason: BacktestExitReason;
  holdingCandles: number;

  signalScore: number;
  signalTotalConditions: number;
  signalAtr: number;
  signalRelativeVolume: number | null;
  signalVolatilityRegime: VolatilityRegime;
  equityBefore: number;
  equityAfter: number;
}

export interface TrendBreakoutBacktestMetrics {
  initialCapitalUsdt: number;
  finalCapitalUsdt: number;
  netPnlUsdt: number;
  netReturnPct: number;

  signals: number;
  enteredTrades: number;
  skippedSignals: number;

  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;

  grossProfitUsdt: number;
  grossLossUsdt: number;
  profitFactor: number | null;
  averagePnlUsdt: number;
  averageR: number;
  medianR: number;
  bestR: number;
  worstR: number;

  maximumDrawdownUsdt: number;
  maximumDrawdownPct: number;
  averageHoldingCandles: number;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  exposurePct: number;
}

export interface TrendBreakoutBacktestResult {
  strategy: typeof TREND_BREAKOUT_STRATEGY_ID;
  strategyVersion: typeof TREND_BREAKOUT_STRATEGY_VERSION;
  assumptions: {
    signalTiming: 'candle_close';
    entryTiming: 'next_candle_open';
    onePositionAtATime: true;
    intrabarPriority: BacktestIntrabarPriority;
    targetAdjustment: 'preserve_signal_r_multiple_from_actual_next_open';
    costsIncluded: true;
    educationalOnly: true;
  };

  options: ResolvedTrendBreakoutBacktestOptions;
  indicatorOptions: DayTradeIndicators['options'];
  strategyOptions: TrendBreakoutOptions;

  candleCount: number;
  warmupCandles: number;
  testedCandleCount: number;
  firstCandleOpenTime: number;
  lastCandleCloseTime: number;

  metrics: TrendBreakoutBacktestMetrics;
  trades: TrendBreakoutBacktestTrade[];
  skippedSignals: BacktestSkippedSignal[];
  equityCurve: Array<{
    time: number;
    equityUsdt: number;
    drawdownUsdt: number;
    drawdownPct: number;
  }>;

  warnings: string[];
  educationalNotice: string;
}

// ---------------------------------------------------------------------------
// Configuração e validação
// ---------------------------------------------------------------------------

const DEFAULT_BACKTEST_OPTIONS: ResolvedTrendBreakoutBacktestOptions = {
  initialCapitalUsdt: 1_000,
  riskPercent: 1,
  feeRatePct: 0.1,
  slippagePct: 0.05,
  stepSize: 0.00000001,
  minQuantity: 0,
  minNotional: 0,
  maxPositionNotional: Number.MAX_SAFE_INTEGER,
  intrabarPriority: 'stop_first',
  maximumHoldingCandles: 0,
  maximumNextOpenDistanceAtr: 0.5,
};

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser maior que zero.`);
  }
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} deve ser maior ou igual a zero.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} deve ser um inteiro maior ou igual a zero.`);
  }
  return value;
}

export function resolveTrendBreakoutBacktestOptions(
  options: TrendBreakoutBacktestOptions = {},
): ResolvedTrendBreakoutBacktestOptions {
  const riskPercent = positive(
    options.riskPercent ?? DEFAULT_BACKTEST_OPTIONS.riskPercent,
    'riskPercent',
  );

  if (riskPercent > 2) {
    throw new Error('riskPercent não pode ultrapassar 2% por operação.');
  }

  const intrabarPriority =
    options.intrabarPriority ?? DEFAULT_BACKTEST_OPTIONS.intrabarPriority;

  if (!['stop_first', 'target_first'].includes(intrabarPriority)) {
    throw new Error('intrabarPriority inválido.');
  }

  const maxPositionNotional =
    options.maxPositionNotional ?? DEFAULT_BACKTEST_OPTIONS.maxPositionNotional;

  if (
    maxPositionNotional !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(maxPositionNotional) || maxPositionNotional <= 0)
  ) {
    throw new Error('maxPositionNotional deve ser maior que zero.');
  }

  return {
    initialCapitalUsdt: positive(
      options.initialCapitalUsdt ?? DEFAULT_BACKTEST_OPTIONS.initialCapitalUsdt,
      'initialCapitalUsdt',
    ),
    riskPercent,
    feeRatePct: nonNegative(
      options.feeRatePct ?? DEFAULT_BACKTEST_OPTIONS.feeRatePct,
      'feeRatePct',
    ),
    slippagePct: nonNegative(
      options.slippagePct ?? DEFAULT_BACKTEST_OPTIONS.slippagePct,
      'slippagePct',
    ),
    stepSize: positive(
      options.stepSize ?? DEFAULT_BACKTEST_OPTIONS.stepSize,
      'stepSize',
    ),
    minQuantity: nonNegative(
      options.minQuantity ?? DEFAULT_BACKTEST_OPTIONS.minQuantity,
      'minQuantity',
    ),
    minNotional: nonNegative(
      options.minNotional ?? DEFAULT_BACKTEST_OPTIONS.minNotional,
      'minNotional',
    ),
    maxPositionNotional,
    intrabarPriority,
    maximumHoldingCandles: nonNegativeInteger(
      options.maximumHoldingCandles ?? DEFAULT_BACKTEST_OPTIONS.maximumHoldingCandles,
      'maximumHoldingCandles',
    ),
    maximumNextOpenDistanceAtr: nonNegative(
      options.maximumNextOpenDistanceAtr ??
        DEFAULT_BACKTEST_OPTIONS.maximumNextOpenDistanceAtr,
      'maximumNextOpenDistanceAtr',
    ),
  };
}

// ---------------------------------------------------------------------------
// Indicadores históricos sem lookahead
// ---------------------------------------------------------------------------

interface IndicatorRuntimeState {
  periodHigh: number;
  periodLow: number;
  peakClose: number;
  maximumDrawdownPct: number;
  candlesInDrawdown: number;
}

function available(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

function snapshotIndicatorsAt(
  candles: readonly DayTradeCandle[],
  point: DayTradeIndicatorPoint,
  index: number,
  full: DayTradeIndicators,
  regime: { regime: VolatilityRegime; percentile: number | null },
  runtime: IndicatorRuntimeState,
): DayTradeIndicators {
  const current = candles[index];
  const previous = candles[index - 1];
  const candleCount = index + 1;
  const requiredCandles = getRequiredCandleCount(full.options);
  const missingCandles = Math.max(0, requiredCandles - candleCount);

  const coreReady = [
    point.emaFast,
    point.emaMedium,
    point.emaSlow,
    point.atr,
    point.priorHighestHigh,
    point.priorLowestLow,
    point.averageVolume,
    point.annualizedVolatilityPct,
  ].every(available);

  const currentDrawdownPct =
    ((current.close - runtime.peakClose) / runtime.peakClose) * 100;

  return {
    options: full.options,
    // A avaliação do playbook usa somente o ponto corrente. Manter um item
    // evita copiar toda a série em cada candle do backtest.
    series: [point],

    candleCount,
    requiredCandles,
    ready: missingCandles === 0 && coreReady,
    missingCandles,

    currentCandleOpenTime: current.openTime,
    currentCandleCloseTime: current.closeTime,
    previousCandleCloseTime: previous.closeTime,

    currentPrice: current.close,
    previousClose: previous.close,
    lastCandleReturnPct: ((current.close / previous.close) - 1) * 100,
    currentCandleRangePct:
      ((current.high - current.low) / current.open) * 100,

    emaFast: point.emaFast,
    emaMedium: point.emaMedium,
    emaSlow: point.emaSlow,

    atr: point.atr,
    atrPct: point.atrPct,

    breakoutLevel: point.priorHighestHigh,
    supportLevel: point.priorLowestLow,
    distanceToBreakoutPct:
      point.priorHighestHigh === null
        ? null
        : ((point.priorHighestHigh - current.close) / current.close) * 100,
    distanceFromSupportPct:
      point.priorLowestLow === null
        ? null
        : ((current.close - point.priorLowestLow) / current.close) * 100,
    distanceFromSlowEmaPct:
      point.emaSlow === null
        ? null
        : ((current.close - point.emaSlow) / point.emaSlow) * 100,

    currentVolume: current.volume,
    currentQuoteVolume: current.quoteVolume ?? 0,
    averageVolume: point.averageVolume,
    averageQuoteVolume: point.averageQuoteVolume,
    relativeVolume: point.relativeVolume,

    annualizedVolatilityPct: point.annualizedVolatilityPct,
    volatilityRegime: regime.regime,
    volatilityPercentile: regime.percentile,

    periodHigh: runtime.periodHigh,
    periodLow: runtime.periodLow,
    amplitudePct:
      ((runtime.periodHigh - runtime.periodLow) / runtime.periodLow) * 100,

    maxDrawdownPct: runtime.maximumDrawdownPct,
    currentDrawdownPct,
    timeInDrawdownPct: (runtime.candlesInDrawdown / candleCount) * 100,

    comparisons: {
      priceAboveSlowEma:
        point.emaSlow === null ? null : current.close > point.emaSlow,
      fastEmaAboveMediumEma:
        point.emaFast === null || point.emaMedium === null
          ? null
          : point.emaFast > point.emaMedium,
      closeAboveBreakout:
        point.priorHighestHigh === null
          ? null
          : current.close > point.priorHighestHigh,
      volumeAboveAverage:
        point.averageVolume === null
          ? null
          : current.volume > point.averageVolume,
    },
  };
}

function buildHistoricalEvaluations(
  candles: readonly DayTradeCandle[],
  indicatorOptions: DayTradeIndicatorOptions,
  strategyOptions: TrendBreakoutOptions,
): Array<TrendBreakoutEvaluation | null> {
  const full = calculateDayTradeIndicators(candles, indicatorOptions);
  const evaluations: Array<TrendBreakoutEvaluation | null> = new Array(
    candles.length,
  ).fill(null);

  const volatilityHistory: number[] = [];
  const runtime: IndicatorRuntimeState = {
    periodHigh: candles[0].high,
    periodLow: candles[0].low,
    peakClose: candles[0].close,
    maximumDrawdownPct: 0,
    candlesInDrawdown: 0,
  };

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    const point = full.series[index];

    runtime.periodHigh = Math.max(runtime.periodHigh, candle.high);
    runtime.periodLow = Math.min(runtime.periodLow, candle.low);
    runtime.peakClose = Math.max(runtime.peakClose, candle.close);

    const currentDrawdown =
      ((candle.close - runtime.peakClose) / runtime.peakClose) * 100;

    if (currentDrawdown < 0) runtime.candlesInDrawdown += 1;
    runtime.maximumDrawdownPct = Math.min(
      runtime.maximumDrawdownPct,
      currentDrawdown,
    );

    const regime = classifyVolatilityRegime(
      volatilityHistory,
      point.annualizedVolatilityPct,
      full.options.minimumRegimeSamples,
    );

    if (
      point.annualizedVolatilityPct !== null &&
      Number.isFinite(point.annualizedVolatilityPct) &&
      point.annualizedVolatilityPct >= 0
    ) {
      volatilityHistory.push(point.annualizedVolatilityPct);
    }

    if (index === 0) continue;

    const snapshot = snapshotIndicatorsAt(
      candles,
      point,
      index,
      full,
      regime,
      runtime,
    );

    evaluations[index] = evaluateTrendBreakout({
      candles: candles.slice(0, index + 1),
      indicators: snapshot,
      // No histórico, o único preço legitimamente conhecido no instante do
      // sinal é o fechamento do próprio candle.
      livePrice: candle.close,
      options: strategyOptions,
    });
  }

  return evaluations;
}

// ---------------------------------------------------------------------------
// Simulação das operações
// ---------------------------------------------------------------------------

interface OpenTrade {
  id: number;
  signal: TrendBreakoutEvaluation;
  plan: TrendBreakoutPlan;
  entryIndex: number;
  entryTime: number;
  signalClose: number;
  plannedEntryReference: number;
  rawEntryPrice: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  stopExecutionPrice: number;
  targetExecutionPrice: number;
  quantity: number;
  entryNotional: number;
  initialRiskUsdt: number;
  entryFeeUsdt: number;
  equityBefore: number;
}

function applyBuySlippage(price: number, slippagePct: number): number {
  return price * (1 + slippagePct / 100);
}

function applySellSlippage(price: number, slippagePct: number): number {
  return price * (1 - slippagePct / 100);
}

function executionFee(
  price: number,
  quantity: number,
  feeRatePct: number,
): number {
  return price * quantity * (feeRatePct / 100);
}

function tradeResult(netPnlUsdt: number): BacktestTradeResult {
  if (netPnlUsdt > 1e-8) return 'win';
  if (netPnlUsdt < -1e-8) return 'loss';
  return 'breakeven';
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function chooseExit(
  trade: OpenTrade,
  candle: DayTradeCandle,
  priority: BacktestIntrabarPriority,
): { rawExitPrice: number; reason: BacktestExitReason } | null {
  // Gap abaixo do stop: assume saída na abertura, não no stop teórico.
  if (candle.open <= trade.stopPrice) {
    return { rawExitPrice: candle.open, reason: 'stop' };
  }

  // Para alvo limite, adota o alvo como preenchimento conservador mesmo que
  // a abertura ocorra acima dele.
  if (candle.open >= trade.targetPrice) {
    return { rawExitPrice: trade.targetPrice, reason: 'target' };
  }

  const touchedStop = candle.low <= trade.stopPrice;
  const touchedTarget = candle.high >= trade.targetPrice;

  if (touchedStop && touchedTarget) {
    return priority === 'stop_first'
      ? { rawExitPrice: trade.stopPrice, reason: 'stop' }
      : { rawExitPrice: trade.targetPrice, reason: 'target' };
  }

  if (touchedStop) {
    return { rawExitPrice: trade.stopPrice, reason: 'stop' };
  }

  if (touchedTarget) {
    return { rawExitPrice: trade.targetPrice, reason: 'target' };
  }

  return null;
}

function createTrade(
  signal: TrendBreakoutEvaluation,
  plan: TrendBreakoutPlan,
  nextCandle: DayTradeCandle,
  entryIndex: number,
  equity: number,
  options: ResolvedTrendBreakoutBacktestOptions,
  tradeId: number,
): { trade: OpenTrade | null; skipped: BacktestSkippedSignal | null } {
  const atr = signal.diagnostics.stopDistanceAtr === null
    ? null
    : plan.riskPerUnit / signal.diagnostics.stopDistanceAtr;

  if (
    atr !== null &&
    nextCandle.open >
      plan.entryReference + atr * options.maximumNextOpenDistanceAtr
  ) {
    return {
      trade: null,
      skipped: {
        signalCandleOpenTime: signal.candleOpenTime,
        signalCandleCloseTime: signal.candleCloseTime,
        reason: 'entry_above_reference_limit',
        explanation:
          'A abertura do candle seguinte ficou além do limite máximo de distância da entrada de referência.',
      },
    };
  }

  if (nextCandle.open <= plan.stopReference) {
    return {
      trade: null,
      skipped: {
        signalCandleOpenTime: signal.candleOpenTime,
        signalCandleCloseTime: signal.candleCloseTime,
        reason: 'entry_below_stop',
        explanation:
          'A abertura seguinte ocorreu no stop ou abaixo dele; o setup foi descartado antes da entrada.',
      },
    };
  }

  const rawEntryPrice = nextCandle.open;
  const priceRisk = rawEntryPrice - plan.stopReference;
  const targetPrice = rawEntryPrice + priceRisk * plan.riskRewardRatio;

  const sizing = calculatePositionSize({
    accountBalance: equity,
    availableBalance: equity,
    riskPercent: options.riskPercent,
    direction: 'long',
    entryPrice: rawEntryPrice,
    stopPrice: plan.stopReference,
    targetPrice,
    feeRatePct: options.feeRatePct,
    slippagePct: options.slippagePct,
    stepSize: options.stepSize,
    minQuantity: options.minQuantity,
    minNotional: options.minNotional,
    maxNotional: options.maxPositionNotional,
    allowLeverage: false,
    policy: {
      recommendedRiskPercent: 1,
      maximumRiskPercent: 2,
    },
  });

  if (!sizing.ok) {
    return {
      trade: null,
      skipped: {
        signalCandleOpenTime: signal.candleOpenTime,
        signalCandleCloseTime: signal.candleCloseTime,
        reason: 'position_sizing_failed',
        explanation: sizing.errors.join(' '),
      },
    };
  }

  const entryPrice = applyBuySlippage(
    rawEntryPrice,
    options.slippagePct,
  );
  const stopExecutionPrice = applySellSlippage(
    plan.stopReference,
    options.slippagePct,
  );
  const targetExecutionPrice = applySellSlippage(
    targetPrice,
    options.slippagePct,
  );
  const entryFeeUsdt = executionFee(
    entryPrice,
    sizing.quantity,
    options.feeRatePct,
  );

  return {
    skipped: null,
    trade: {
      id: tradeId,
      signal,
      plan,
      entryIndex,
      entryTime: nextCandle.openTime,
      signalClose: signal.evaluatedPrice,
      plannedEntryReference: plan.entryReference,
      rawEntryPrice,
      entryPrice,
      stopPrice: plan.stopReference,
      targetPrice,
      stopExecutionPrice,
      targetExecutionPrice,
      quantity: sizing.quantity,
      entryNotional: entryPrice * sizing.quantity,
      initialRiskUsdt: sizing.estimatedTotalRiskUsdt,
      entryFeeUsdt,
      equityBefore: equity,
    },
  };
}

function closeTrade(
  trade: OpenTrade,
  rawExitPrice: number,
  exitTime: number,
  exitIndex: number,
  reason: BacktestExitReason,
  options: ResolvedTrendBreakoutBacktestOptions,
): TrendBreakoutBacktestTrade {
  const exitPrice = applySellSlippage(rawExitPrice, options.slippagePct);
  const exitFeeUsdt = executionFee(
    exitPrice,
    trade.quantity,
    options.feeRatePct,
  );
  const grossPnlUsdt =
    (exitPrice - trade.entryPrice) * trade.quantity;
  const totalFeesUsdt = trade.entryFeeUsdt + exitFeeUsdt;
  const netPnlUsdt = grossPnlUsdt - totalFeesUsdt;
  const resultR = trade.initialRiskUsdt > 0
    ? netPnlUsdt / trade.initialRiskUsdt
    : 0;
  const equityAfter = Math.max(0, trade.equityBefore + netPnlUsdt);

  return {
    id: trade.id,
    strategy: TREND_BREAKOUT_STRATEGY_ID,
    strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
    direction: 'long',

    signalCandleOpenTime: trade.signal.candleOpenTime,
    signalCandleCloseTime: trade.signal.candleCloseTime,
    entryTime: trade.entryTime,
    exitTime,

    signalClose: trade.signalClose,
    plannedEntryReference: trade.plannedEntryReference,
    rawEntryPrice: trade.rawEntryPrice,
    entryPrice: trade.entryPrice,
    stopPrice: trade.stopPrice,
    targetPrice: trade.targetPrice,
    rawExitPrice,
    exitPrice,

    quantity: trade.quantity,
    entryNotional: trade.entryNotional,
    initialRiskUsdt: trade.initialRiskUsdt,

    entryFeeUsdt: trade.entryFeeUsdt,
    exitFeeUsdt,
    totalFeesUsdt,
    grossPnlUsdt,
    netPnlUsdt,
    resultR,

    result: tradeResult(netPnlUsdt),
    exitReason: reason,
    holdingCandles: exitIndex - trade.entryIndex + 1,

    signalScore: trade.signal.passedConditions,
    signalTotalConditions: trade.signal.totalConditions,
    signalAtr: trade.plan.riskPerUnit / trade.plan.stopDistanceAtr,
    signalRelativeVolume: trade.signal.diagnostics.relativeVolume,
    signalVolatilityRegime: trade.signal.diagnostics.volatilityRegime,
    equityBefore: trade.equityBefore,
    equityAfter,
  };
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

function calculateMetrics(
  trades: readonly TrendBreakoutBacktestTrade[],
  initialCapital: number,
  signals: number,
  skippedSignals: number,
  exposureCandles: number,
  testedCandleCount: number,
): {
  metrics: TrendBreakoutBacktestMetrics;
  equityCurve: TrendBreakoutBacktestResult['equityCurve'];
} {
  const finalCapital = trades.length === 0
    ? initialCapital
    : trades[trades.length - 1].equityAfter;
  const netPnl = finalCapital - initialCapital;
  const wins = trades.filter((trade) => trade.result === 'win');
  const losses = trades.filter((trade) => trade.result === 'loss');
  const breakeven = trades.filter(
    (trade) => trade.result === 'breakeven',
  );
  const grossProfit = wins.reduce(
    (sum, trade) => sum + trade.netPnlUsdt,
    0,
  );
  const grossLoss = Math.abs(
    losses.reduce((sum, trade) => sum + trade.netPnlUsdt, 0),
  );
  const rValues = trades.map((trade) => trade.resultR);

  let peak = initialCapital;
  let maximumDrawdownUsdt = 0;
  let maximumDrawdownPct = 0;
  const equityCurve: TrendBreakoutBacktestResult['equityCurve'] = [
    {
      time: trades[0]?.signalCandleOpenTime ?? 0,
      equityUsdt: initialCapital,
      drawdownUsdt: 0,
      drawdownPct: 0,
    },
  ];

  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let maximumConsecutiveWins = 0;
  let maximumConsecutiveLosses = 0;

  for (const trade of trades) {
    peak = Math.max(peak, trade.equityAfter);
    const drawdownUsdt = peak - trade.equityAfter;
    const drawdownPct = peak > 0 ? (drawdownUsdt / peak) * 100 : 0;

    maximumDrawdownUsdt = Math.max(maximumDrawdownUsdt, drawdownUsdt);
    maximumDrawdownPct = Math.max(maximumDrawdownPct, drawdownPct);

    equityCurve.push({
      time: trade.exitTime,
      equityUsdt: trade.equityAfter,
      drawdownUsdt,
      drawdownPct,
    });

    if (trade.result === 'win') {
      consecutiveWins += 1;
      consecutiveLosses = 0;
    } else if (trade.result === 'loss') {
      consecutiveLosses += 1;
      consecutiveWins = 0;
    } else {
      consecutiveWins = 0;
      consecutiveLosses = 0;
    }

    maximumConsecutiveWins = Math.max(
      maximumConsecutiveWins,
      consecutiveWins,
    );
    maximumConsecutiveLosses = Math.max(
      maximumConsecutiveLosses,
      consecutiveLosses,
    );
  }

  return {
    equityCurve,
    metrics: {
      initialCapitalUsdt: initialCapital,
      finalCapitalUsdt: finalCapital,
      netPnlUsdt: netPnl,
      netReturnPct: (netPnl / initialCapital) * 100,

      signals,
      enteredTrades: trades.length,
      skippedSignals,

      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      breakeven: breakeven.length,
      winRatePct:
        trades.length === 0 ? 0 : (wins.length / trades.length) * 100,

      grossProfitUsdt: grossProfit,
      grossLossUsdt: grossLoss,
      profitFactor:
        grossLoss === 0
          ? grossProfit > 0
            ? null
            : 0
          : grossProfit / grossLoss,
      averagePnlUsdt:
        trades.length === 0 ? 0 : netPnl / trades.length,
      averageR:
        rValues.length === 0
          ? 0
          : rValues.reduce((sum, value) => sum + value, 0) /
            rValues.length,
      medianR: median(rValues),
      bestR: rValues.length === 0 ? 0 : Math.max(...rValues),
      worstR: rValues.length === 0 ? 0 : Math.min(...rValues),

      maximumDrawdownUsdt,
      maximumDrawdownPct,
      averageHoldingCandles:
        trades.length === 0
          ? 0
          : trades.reduce(
              (sum, trade) => sum + trade.holdingCandles,
              0,
            ) / trades.length,
      maximumConsecutiveWins,
      maximumConsecutiveLosses,
      exposurePct:
        testedCandleCount <= 0
          ? 0
          : (exposureCandles / testedCandleCount) * 100,
    },
  };
}

// ---------------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------------

export function runTrendBreakoutBacktest(
  input: TrendBreakoutBacktestInput,
): TrendBreakoutBacktestResult {
  const candles = normalizeClosedCandles(input.candles);
  const options = resolveTrendBreakoutBacktestOptions(
    input.backtestOptions,
  );
  const strategyOptions = input.strategyOptions ?? {};

  if (candles.length < 2) {
    throw new Error('O backtest exige pelo menos dois candles encerrados.');
  }

  const fullIndicators = calculateDayTradeIndicators(
    candles,
    input.indicatorOptions,
  );
  const warmupCandles = fullIndicators.requiredCandles;

  if (candles.length <= warmupCandles) {
    throw new Error(
      `O histórico deve possuir mais de ${warmupCandles} candles para incluir aquecimento e período testado.`,
    );
  }

  const evaluations = buildHistoricalEvaluations(
    candles,
    input.indicatorOptions,
    strategyOptions,
  );

  const trades: TrendBreakoutBacktestTrade[] = [];
  const skippedSignals: BacktestSkippedSignal[] = [];

  let equity = options.initialCapitalUsdt;
  let openTrade: OpenTrade | null = null;
  let pendingSignal: TrendBreakoutEvaluation | null = null;
  let signals = 0;
  let exposureCandles = 0;
  let nextTradeId = 1;

  const firstTestedIndex = Math.max(1, warmupCandles - 1);

  for (let index = firstTestedIndex; index < candles.length; index++) {
    const candle = candles[index];

    // A entrada usa exclusivamente a abertura posterior ao sinal.
    if (pendingSignal && !openTrade) {
      const plan = pendingSignal.plan;

      if (plan) {
        const created = createTrade(
          pendingSignal,
          plan,
          candle,
          index,
          equity,
          options,
          nextTradeId,
        );

        if (created.trade) {
          openTrade = created.trade;
          nextTradeId += 1;
        } else if (created.skipped) {
          skippedSignals.push(created.skipped);
        }
      }

      pendingSignal = null;
    }

    if (openTrade) {
      exposureCandles += 1;

      let selectedExit = chooseExit(
        openTrade,
        candle,
        options.intrabarPriority,
      );

      if (
        !selectedExit &&
        options.maximumHoldingCandles > 0 &&
        index - openTrade.entryIndex + 1 >= options.maximumHoldingCandles
      ) {
        selectedExit = {
          rawExitPrice: candle.close,
          reason: 'maximum_holding',
        };
      }

      if (selectedExit) {
        const closed = closeTrade(
          openTrade,
          selectedExit.rawExitPrice,
          candle.closeTime,
          index,
          selectedExit.reason,
          options,
        );
        trades.push(closed);
        equity = closed.equityAfter;
        openTrade = null;
      }
    }

    const evaluation = evaluations[index];

    if (evaluation?.status === 'condicoes_atendidas') {
      signals += 1;

      if (index >= candles.length - 1) {
        skippedSignals.push({
          signalCandleOpenTime: evaluation.candleOpenTime,
          signalCandleCloseTime: evaluation.candleCloseTime,
          reason: 'no_next_candle',
          explanation:
            'O sinal ocorreu no último candle disponível e não existe uma abertura posterior para simular a entrada.',
        });
      } else if (openTrade || pendingSignal) {
        skippedSignals.push({
          signalCandleOpenTime: evaluation.candleOpenTime,
          signalCandleCloseTime: evaluation.candleCloseTime,
          reason: 'position_open',
          explanation:
            'O sinal foi ignorado porque a estratégia permite somente uma posição aberta por vez.',
        });
      } else {
        pendingSignal = evaluation;
      }
    }

    if (equity <= 0) break;
  }

  if (openTrade) {
    const lastIndex = candles.length - 1;
    const last = candles[lastIndex];
    const closed = closeTrade(
      openTrade,
      last.close,
      last.closeTime,
      lastIndex,
      'end_of_data',
      options,
    );
    trades.push(closed);
    equity = closed.equityAfter;
    openTrade = null;
  }

  if (pendingSignal) {
    skippedSignals.push({
      signalCandleOpenTime: pendingSignal.candleOpenTime,
      signalCandleCloseTime: pendingSignal.candleCloseTime,
      reason: 'no_next_candle',
      explanation:
        'O histórico terminou antes da abertura necessária para executar o sinal.',
    });
  }

  const testedCandleCount = Math.max(0, candles.length - firstTestedIndex);
  const calculated = calculateMetrics(
    trades,
    options.initialCapitalUsdt,
    signals,
    skippedSignals.length,
    exposureCandles,
    testedCandleCount,
  );

  const warnings: string[] = [
    'Resultados passados, inclusive simulados, não garantem desempenho futuro.',
    'O backtest não reproduz fila de ordens, liquidez real, indisponibilidade da corretora ou mudanças de regras da Binance.',
  ];

  if (options.intrabarPriority === 'stop_first') {
    warnings.push(
      'Quando stop e alvo são tocados no mesmo candle, o resultado considera o stop primeiro.',
    );
  }

  if (trades.length < 30) {
    warnings.push(
      'A amostra possui menos de 30 operações e ainda é pequena para conclusões estatísticas.',
    );
  }

  return {
    strategy: TREND_BREAKOUT_STRATEGY_ID,
    strategyVersion: TREND_BREAKOUT_STRATEGY_VERSION,
    assumptions: {
      signalTiming: 'candle_close',
      entryTiming: 'next_candle_open',
      onePositionAtATime: true,
      intrabarPriority: options.intrabarPriority,
      targetAdjustment:
        'preserve_signal_r_multiple_from_actual_next_open',
      costsIncluded: true,
      educationalOnly: true,
    },

    options,
    indicatorOptions: fullIndicators.options,
    strategyOptions,

    candleCount: candles.length,
    warmupCandles,
    testedCandleCount,
    firstCandleOpenTime: candles[0].openTime,
    lastCandleCloseTime: candles[candles.length - 1].closeTime,

    metrics: calculated.metrics,
    trades,
    skippedSignals,
    equityCurve: calculated.equityCurve,

    warnings,
    educationalNotice:
      'Backtest educacional baseado em regras determinísticas. Não constitui recomendação de investimento ou promessa de rentabilidade.',
  };
}

// ============================================================================
// SEÇÃO 5: strategies/trendPullback.ts
// ============================================================================

/**
 * supabase/functions/avaliar-daytrade/strategies/trendPullback.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Playbook de continuação de tendência após pullback.
 *
 * Regras:
 * - preço acima da EMA 200;
 * - EMA 20 > EMA 50 > EMA 200;
 * - recuo recente até a região entre EMA 20 e EMA 50;
 * - recuperação confirmada por candle encerrado;
 * - volume suficiente;
 * - volatilidade aceitável;
 * - plano com stop coerente e alvo mínimo de 2R.
 *
 * Este módulo não consulta APIs, não grava no banco e não executa ordens.
 */


export const TREND_PULLBACK_STRATEGY_ID = 'trend_pullback' as const;
export const TREND_PULLBACK_STRATEGY_VERSION = '1.0.0' as const;

export const TREND_PULLBACK_EDUCATIONAL_NOTICE =
  'Este resultado verifica condições técnicas históricas e não representa recomendação de compra ou promessa de resultado.';

export type TrendPullbackStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export type TrendPullbackConditionId =
  | 'tendencia_principal_positiva'
  | 'emas_alinhadas'
  | 'pullback_na_zona'
  | 'recuperacao_confirmada'
  | 'volume_recuperacao'
  | 'volatilidade_aceitavel'
  | 'plano_risco_retorno';

export interface TrendPullbackCondition {
  id: TrendPullbackConditionId;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface TrendPullbackPlan {
  direction: 'long';
  entryReference: number;
  stopReference: number;
  targetReference: number;
  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;
  stopDistancePct: number;
  targetDistancePct: number;
  stopDistanceAtr: number;
  latestAcceptableEntry: number;
  pullbackLow: number;
  pullbackZoneUpper: number;
  pullbackZoneLower: number;
  emaFast: number;
  emaMedium: number;
  emaSlow: number;
  structuralStopCandidate: number;
  atrStopCandidate: number;
}

export interface TrendPullbackOptions {
  minimumRelativeVolume?: number;
  minimumPreviousCandleVolumeRatio?: number;
  atrStopMultiple?: number;
  structuralStopBufferAtr?: number;
  minimumRiskRewardRatio?: number;
  pullbackToleranceAtr?: number;
  maximumLateEntryDistanceAtr?: number;
  minimumStopDistanceAtr?: number;
  maximumStopDistanceAtr?: number;
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface ResolvedTrendPullbackOptions {
  minimumRelativeVolume: number;
  minimumPreviousCandleVolumeRatio: number;
  atrStopMultiple: number;
  structuralStopBufferAtr: number;
  minimumRiskRewardRatio: number;
  pullbackToleranceAtr: number;
  maximumLateEntryDistanceAtr: number;
  minimumStopDistanceAtr: number;
  maximumStopDistanceAtr: number;
  blockedVolatilityRegimes: readonly VolatilityRegime[];
}

export interface EvaluateTrendPullbackInput {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;
  livePrice?: number | null;
  options?: TrendPullbackOptions;
}

export interface AnalyzeTrendPullbackInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  livePrice?: number | null;
  strategyOptions?: TrendPullbackOptions;
}

export interface TrendPullbackEvaluation {
  strategy: typeof TREND_PULLBACK_STRATEGY_ID;
  strategyVersion: typeof TREND_PULLBACK_STRATEGY_VERSION;
  direction: 'long';
  status: TrendPullbackStatus;
  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;
  conditions: TrendPullbackCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;
  plan: TrendPullbackPlan | null;
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
    previousCandleVolumeRatio: number | null;
    pullbackTouched: boolean | null;
    recoveryConfirmed: boolean | null;
    pullbackLow: number | null;
    pullbackZoneUpper: number | null;
    pullbackZoneLower: number | null;
    stopDistanceAtr: number | null;
  };
}

const TREND_PULLBACK_DEFAULT_OPTIONS: ResolvedTrendPullbackOptions = {
  minimumRelativeVolume: 0.8,
  minimumPreviousCandleVolumeRatio: 1.05,
  atrStopMultiple: 1.2,
  structuralStopBufferAtr: 0.1,
  minimumRiskRewardRatio: 2,
  pullbackToleranceAtr: 0.25,
  maximumLateEntryDistanceAtr: 0.35,
  minimumStopDistanceAtr: 0.5,
  maximumStopDistanceAtr: 3,
  blockedVolatilityRegimes: ['extremo', 'indisponível'],
};

function positiveTrendPullbackNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número maior que zero.`);
  }
  return value;
}

function nonNegativeTrendPullbackNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} deve ser um número maior ou igual a zero.`);
  }
  return value;
}

export function resolveTrendPullbackOptions(
  options: TrendPullbackOptions = {},
): ResolvedTrendPullbackOptions {
  const resolved: ResolvedTrendPullbackOptions = {
    minimumRelativeVolume: positiveTrendPullbackNumber(
      options.minimumRelativeVolume ?? TREND_PULLBACK_DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    minimumPreviousCandleVolumeRatio: positiveTrendPullbackNumber(
      options.minimumPreviousCandleVolumeRatio ??
        TREND_PULLBACK_DEFAULT_OPTIONS.minimumPreviousCandleVolumeRatio,
      'minimumPreviousCandleVolumeRatio',
    ),
    atrStopMultiple: positiveTrendPullbackNumber(
      options.atrStopMultiple ?? TREND_PULLBACK_DEFAULT_OPTIONS.atrStopMultiple,
      'atrStopMultiple',
    ),
    structuralStopBufferAtr: nonNegativeTrendPullbackNumber(
      options.structuralStopBufferAtr ?? TREND_PULLBACK_DEFAULT_OPTIONS.structuralStopBufferAtr,
      'structuralStopBufferAtr',
    ),
    minimumRiskRewardRatio: positiveTrendPullbackNumber(
      options.minimumRiskRewardRatio ?? TREND_PULLBACK_DEFAULT_OPTIONS.minimumRiskRewardRatio,
      'minimumRiskRewardRatio',
    ),
    pullbackToleranceAtr: nonNegativeTrendPullbackNumber(
      options.pullbackToleranceAtr ?? TREND_PULLBACK_DEFAULT_OPTIONS.pullbackToleranceAtr,
      'pullbackToleranceAtr',
    ),
    maximumLateEntryDistanceAtr: nonNegativeTrendPullbackNumber(
      options.maximumLateEntryDistanceAtr ??
        TREND_PULLBACK_DEFAULT_OPTIONS.maximumLateEntryDistanceAtr,
      'maximumLateEntryDistanceAtr',
    ),
    minimumStopDistanceAtr: positiveTrendPullbackNumber(
      options.minimumStopDistanceAtr ?? TREND_PULLBACK_DEFAULT_OPTIONS.minimumStopDistanceAtr,
      'minimumStopDistanceAtr',
    ),
    maximumStopDistanceAtr: positiveTrendPullbackNumber(
      options.maximumStopDistanceAtr ?? TREND_PULLBACK_DEFAULT_OPTIONS.maximumStopDistanceAtr,
      'maximumStopDistanceAtr',
    ),
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ??
      TREND_PULLBACK_DEFAULT_OPTIONS.blockedVolatilityRegimes,
  };

  if (resolved.minimumStopDistanceAtr >= resolved.maximumStopDistanceAtr) {
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

function isFinitePositiveTrendPullback(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function formatTrendPullbackNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function formatTrendPullbackPct(value: number, fractionDigits = 2): string {
  return `${new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}%`;
}

function trendPullbackCondition(
  value: Omit<TrendPullbackCondition, 'available'> & {
    available?: boolean;
  },
): TrendPullbackCondition {
  return { ...value, available: value.available ?? true };
}

function candleIntersectsPullbackZone(
  candle: DayTradeCandle,
  lower: number,
  upper: number,
): boolean {
  return candle.low <= upper && candle.high >= lower;
}

function createTrendPullbackPlan(
  currentCandle: DayTradeCandle,
  previousCandle: DayTradeCandle | null,
  indicators: DayTradeIndicators,
  options: ResolvedTrendPullbackOptions,
): TrendPullbackPlan | null {
  const entryReference = currentCandle.close;
  const atr = indicators.atr;
  const emaFast = indicators.emaFast;
  const emaMedium = indicators.emaMedium;
  const emaSlow = indicators.emaSlow;

  if (
    previousCandle === null ||
    !isFinitePositiveTrendPullback(atr) ||
    !isFinitePositiveTrendPullback(emaFast) ||
    !isFinitePositiveTrendPullback(emaMedium) ||
    !isFinitePositiveTrendPullback(emaSlow)
  ) {
    return null;
  }

  const pullbackLow = Math.min(previousCandle.low, currentCandle.low);
  const structuralStopCandidate =
    pullbackLow - atr * options.structuralStopBufferAtr;
  const atrStopCandidate =
    entryReference - atr * options.atrStopMultiple;
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
  const rewardPerUnit =
    riskPerUnit * options.minimumRiskRewardRatio;
  const targetReference = entryReference + rewardPerUnit;

  return {
    direction: 'long',
    entryReference,
    stopReference,
    targetReference,
    riskPerUnit,
    rewardPerUnit,
    riskRewardRatio: rewardPerUnit / riskPerUnit,
    stopDistancePct: (riskPerUnit / entryReference) * 100,
    targetDistancePct: (rewardPerUnit / entryReference) * 100,
    stopDistanceAtr: riskPerUnit / atr,
    latestAcceptableEntry:
      entryReference + atr * options.maximumLateEntryDistanceAtr,
    pullbackLow,
    pullbackZoneUpper:
      emaFast + atr * options.pullbackToleranceAtr,
    pullbackZoneLower:
      emaMedium - atr * options.pullbackToleranceAtr,
    emaFast,
    emaMedium,
    emaSlow,
    structuralStopCandidate,
    atrStopCandidate,
  };
}

function determineTrendPullbackNextTrigger(
  conditions: readonly TrendPullbackCondition[],
  indicators: DayTradeIndicators,
  plan: TrendPullbackPlan | null,
  status: TrendPullbackStatus,
  options: ResolvedTrendPullbackOptions,
): string {
  if (status === 'dados_insuficientes') {
    return `Carregue mais ${indicators.missingCandles} candle(s) encerrado(s) para completar os indicadores.`;
  }

  if (status === 'invalidado' && plan) {
    return `A formação perdeu validade porque o preço atingiu ou ficou abaixo de ${formatTrendPullbackNumber(plan.stopReference)}. Aguarde um novo pullback.`;
  }

  if (status === 'entrada_atrasada' && plan) {
    return `Aguarde um novo pullback. O preço ultrapassou o limite de entrada de ${formatTrendPullbackNumber(plan.latestAcceptableEntry)}.`;
  }

  if (status === 'condicoes_atendidas' && plan) {
    return `O candle encerrado confirmou a recuperação acima da EMA rápida em ${formatTrendPullbackNumber(plan.emaFast)}.`;
  }

  const firstFailed = conditions.find(
    (item) => item.available && !item.passed,
  );

  switch (firstFailed?.id) {
    case 'tendencia_principal_positiva':
      return indicators.emaSlow === null
        ? 'Aguarde a EMA lenta ficar disponível.'
        : `Aguarde um fechamento acima da EMA lenta em ${formatTrendPullbackNumber(indicators.emaSlow)}.`;

    case 'emas_alinhadas':
      return 'Aguarde o alinhamento EMA rápida > EMA intermediária > EMA lenta.';

    case 'pullback_na_zona':
      return plan
        ? `Aguarde um recuo controlado até a região entre ${formatTrendPullbackNumber(plan.pullbackZoneLower)} e ${formatTrendPullbackNumber(plan.pullbackZoneUpper)}.`
        : 'Aguarde as médias e o ATR ficarem disponíveis para calcular a região de pullback.';

    case 'recuperacao_confirmada':
      return indicators.emaFast === null
        ? 'Aguarde a EMA rápida ficar disponível.'
        : `Aguarde um candle positivo fechando acima da EMA rápida em ${formatTrendPullbackNumber(indicators.emaFast)}, acima do fechamento anterior e próximo da máxima.`;

    case 'volume_recuperacao':
      return `A recuperação exige volume relativo mínimo de ${formatTrendPullbackNumber(options.minimumRelativeVolume, 2)}× e volume atual/anterior mínimo de ${formatTrendPullbackNumber(options.minimumPreviousCandleVolumeRatio, 2)}×.`;

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado pelo playbook.';

    case 'plano_risco_retorno':
      return `Aguarde uma formação com stop entre ${formatTrendPullbackNumber(options.minimumStopDistanceAtr, 2)} e ${formatTrendPullbackNumber(options.maximumStopDistanceAtr, 2)} ATR e alvo mínimo de ${formatTrendPullbackNumber(options.minimumRiskRewardRatio, 2)}R.`;

    default:
      return 'Aguarde a conclusão conjunta das condições técnicas restantes.';
  }
}

function determineTrendPullbackSummary(
  status: TrendPullbackStatus,
  passed: number,
  total: number,
): string {
  switch (status) {
    case 'dados_insuficientes':
      return 'Ainda não há candles encerrados suficientes para avaliar o pullback.';
    case 'aguardar':
      return `${passed} de ${total} condições foram atendidas. Ainda não existe um pullback válido.`;
    case 'observar':
      return `${passed} de ${total} condições foram atendidas. O ativo está na região de pullback ou iniciando recuperação.`;
    case 'condicoes_atendidas':
      return `${passed} de ${total} condições foram atendidas no candle encerrado mais recente.`;
    case 'entrada_atrasada':
      return 'O pullback foi confirmado, mas o preço ao vivo já se afastou demais da entrada.';
    case 'invalidado':
      return 'O pullback foi confirmado, mas o preço ao vivo atingiu a invalidação.';
  }
}

export function evaluateTrendPullback(
  input: EvaluateTrendPullbackInput,
): TrendPullbackEvaluation {
  const options = resolveTrendPullbackOptions(input.options);
  const candles = normalizeClosedCandles(input.candles);

  if (candles.length === 0) {
    throw new Error(
      'É necessário informar pelo menos um candle encerrado para avaliar o playbook.',
    );
  }

  const currentCandle = candles[candles.length - 1];
  const previousCandle =
    candles.length >= 2 ? candles[candles.length - 2] : null;
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
      : positiveTrendPullbackNumber(input.livePrice, 'livePrice');

  const plan = createTrendPullbackPlan(
    currentCandle,
    previousCandle,
    indicators,
    options,
  );

  const atrAvailable = isFinitePositiveTrendPullback(indicators.atr);
  const emaFastAvailable = isFinitePositiveTrendPullback(indicators.emaFast);
  const emaMediumAvailable = isFinitePositiveTrendPullback(indicators.emaMedium);
  const emaSlowAvailable = isFinitePositiveTrendPullback(indicators.emaSlow);
  const previousCandleAvailable = previousCandle !== null;

  const trendAvailable = emaSlowAvailable;
  const alignmentAvailable =
    emaFastAvailable && emaMediumAvailable && emaSlowAvailable;
  const pullbackAvailable =
    previousCandleAvailable &&
    atrAvailable &&
    emaFastAvailable &&
    emaMediumAvailable;
  const recoveryAvailable =
    previousCandleAvailable && emaFastAvailable;
  const volumeAvailable =
    previousCandleAvailable &&
    previousCandle.volume > 0 &&
    indicators.relativeVolume !== null &&
    Number.isFinite(indicators.relativeVolume);
  const volatilityAvailable =
    indicators.volatilityRegime !== 'indisponível';

  const pullbackZoneUpper =
    atrAvailable && emaFastAvailable
      ? (indicators.emaFast as number) +
        (indicators.atr as number) * options.pullbackToleranceAtr
      : null;
  const pullbackZoneLower =
    atrAvailable && emaMediumAvailable
      ? (indicators.emaMedium as number) -
        (indicators.atr as number) * options.pullbackToleranceAtr
      : null;

  const pullbackLow =
    previousCandle === null
      ? null
      : Math.min(previousCandle.low, currentCandle.low);

  const previousTouchesZone =
    previousCandle !== null &&
    pullbackZoneLower !== null &&
    pullbackZoneUpper !== null &&
    candleIntersectsPullbackZone(
      previousCandle,
      pullbackZoneLower,
      pullbackZoneUpper,
    );

  const currentTouchesZone =
    pullbackZoneLower !== null &&
    pullbackZoneUpper !== null &&
    candleIntersectsPullbackZone(
      currentCandle,
      pullbackZoneLower,
      pullbackZoneUpper,
    );

  const pullbackTouched =
    pullbackAvailable &&
    pullbackLow !== null &&
    pullbackZoneLower !== null &&
    pullbackLow >= pullbackZoneLower &&
    (previousTouchesZone || currentTouchesZone);

  const currentRange = currentCandle.high - currentCandle.low;
  const closeLocation =
    currentRange > 0
      ? (currentCandle.close - currentCandle.low) / currentRange
      : 0;

  const recoveryConfirmed =
    recoveryAvailable &&
    currentCandle.close > (indicators.emaFast as number) &&
    currentCandle.close > currentCandle.open &&
    currentCandle.close > (previousCandle as DayTradeCandle).close &&
    closeLocation >= 0.6;

  const previousCandleVolumeRatio =
    previousCandle !== null && previousCandle.volume > 0
      ? currentCandle.volume / previousCandle.volume
      : null;

  const volumeConfirmed =
    volumeAvailable &&
    (indicators.relativeVolume as number) >=
      options.minimumRelativeVolume &&
    (previousCandleVolumeRatio as number) >=
      options.minimumPreviousCandleVolumeRatio;

  const stopDistanceValid =
    plan !== null &&
    plan.stopDistanceAtr >= options.minimumStopDistanceAtr &&
    plan.stopDistanceAtr <= options.maximumStopDistanceAtr;

  const riskRewardValid =
    plan !== null &&
    plan.riskRewardRatio >= options.minimumRiskRewardRatio;

  const conditions: TrendPullbackCondition[] = [
    trendPullbackCondition({
      id: 'tendencia_principal_positiva',
      label: 'Preço acima da EMA lenta',
      available: trendAvailable,
      passed:
        trendAvailable &&
        currentCandle.close > (indicators.emaSlow as number),
      currentValue: currentCandle.close,
      requiredValue:
        indicators.emaSlow === null
          ? 'EMA lenta disponível'
          : `Fechamento acima de ${formatTrendPullbackNumber(indicators.emaSlow)}`,
      explanation:
        indicators.emaSlow === null
          ? 'A média lenta ainda não possui histórico suficiente.'
          : currentCandle.close > indicators.emaSlow
            ? `O fechamento está ${formatTrendPullbackPct(((currentCandle.close - indicators.emaSlow) / indicators.emaSlow) * 100)} acima da EMA lenta.`
            : `O fechamento está ${formatTrendPullbackPct(((indicators.emaSlow - currentCandle.close) / indicators.emaSlow) * 100)} abaixo da EMA lenta.`,
    }),
    trendPullbackCondition({
      id: 'emas_alinhadas',
      label: 'EMAs 20, 50 e 200 alinhadas',
      available: alignmentAvailable,
      passed:
        alignmentAvailable &&
        (indicators.emaFast as number) >
          (indicators.emaMedium as number) &&
        (indicators.emaMedium as number) >
          (indicators.emaSlow as number),
      currentValue:
        alignmentAvailable
          ? `${formatTrendPullbackNumber(indicators.emaFast as number)} / ${formatTrendPullbackNumber(indicators.emaMedium as number)} / ${formatTrendPullbackNumber(indicators.emaSlow as number)}`
          : null,
      requiredValue: 'EMA rápida > EMA intermediária > EMA lenta',
      explanation:
        !alignmentAvailable
          ? 'As médias ainda não possuem histórico suficiente.'
          : (indicators.emaFast as number) >
                (indicators.emaMedium as number) &&
              (indicators.emaMedium as number) >
                (indicators.emaSlow as number)
            ? 'As três médias estão alinhadas em ordem positiva.'
            : 'As três médias ainda não estão alinhadas em ordem positiva.',
    }),
    trendPullbackCondition({
      id: 'pullback_na_zona',
      label: 'Recuo controlado até a região das médias',
      available: pullbackAvailable,
      passed: pullbackTouched,
      currentValue:
        pullbackLow === null ? null : formatTrendPullbackNumber(pullbackLow),
      requiredValue:
        pullbackZoneLower === null || pullbackZoneUpper === null
          ? 'Região de pullback disponível'
          : `Mínima recente entre ${formatTrendPullbackNumber(pullbackZoneLower)} e ${formatTrendPullbackNumber(pullbackZoneUpper)}`,
      explanation:
        !pullbackAvailable
          ? 'Ainda faltam candles, ATR ou médias para calcular a região.'
          : pullbackTouched
            ? 'Um dos dois candles mais recentes recuou até a região permitida.'
            : 'Os candles recentes ainda não formaram um recuo controlado.',
    }),
    trendPullbackCondition({
      id: 'recuperacao_confirmada',
      label: 'Recuperação confirmada no fechamento',
      available: recoveryAvailable,
      passed: recoveryConfirmed,
      currentValue: currentCandle.close,
      requiredValue:
        indicators.emaFast === null
          ? 'EMA rápida disponível'
          : `Candle positivo acima de ${formatTrendPullbackNumber(indicators.emaFast)}, acima do fechamento anterior e próximo da máxima`,
      explanation:
        !recoveryAvailable
          ? 'Ainda não existe candle anterior ou EMA rápida.'
          : recoveryConfirmed
            ? 'O candle encerrou positivo, acima da EMA rápida e próximo da máxima.'
            : 'O candle atual ainda não confirmou força suficiente.',
    }),
    trendPullbackCondition({
      id: 'volume_recuperacao',
      label: 'Volume confirma a recuperação',
      available: volumeAvailable,
      passed: volumeConfirmed,
      currentValue:
        indicators.relativeVolume === null ||
        previousCandleVolumeRatio === null
          ? null
          : `${formatTrendPullbackNumber(indicators.relativeVolume, 2)}× média · ${formatTrendPullbackNumber(previousCandleVolumeRatio, 2)}× anterior`,
      requiredValue:
        `Volume relativo ≥ ${formatTrendPullbackNumber(options.minimumRelativeVolume, 2)}× e ` +
        `volume atual/anterior ≥ ${formatTrendPullbackNumber(options.minimumPreviousCandleVolumeRatio, 2)}×`,
      explanation:
        !volumeAvailable
          ? 'O histórico de volume necessário ainda não está disponível.'
          : volumeConfirmed
            ? 'O volume superou os dois limites configurados.'
            : 'O volume ainda não superou os dois limites configurados.',
    }),
    trendPullbackCondition({
      id: 'volatilidade_aceitavel',
      label: 'Volatilidade fora do regime bloqueado',
      available: volatilityAvailable,
      passed:
        volatilityAvailable &&
        !options.blockedVolatilityRegimes.includes(
          indicators.volatilityRegime,
        ),
      currentValue: indicators.volatilityRegime,
      requiredValue:
        `Fora de: ${options.blockedVolatilityRegimes.join(', ')}`,
      explanation:
        indicators.volatilityRegime === 'indisponível'
          ? 'Ainda não há histórico para classificar a volatilidade.'
          : options.blockedVolatilityRegimes.includes(
                indicators.volatilityRegime,
              )
            ? `O regime ${indicators.volatilityRegime} está bloqueado.`
            : `O regime ${indicators.volatilityRegime} é permitido.`,
    }),
    trendPullbackCondition({
      id: 'plano_risco_retorno',
      label: 'Plano com risco e alvo coerentes',
      available: plan !== null,
      passed: stopDistanceValid && riskRewardValid,
      currentValue:
        plan === null
          ? null
          : `${formatTrendPullbackNumber(plan.stopDistanceAtr, 2)} ATR · ${formatTrendPullbackNumber(plan.riskRewardRatio, 2)}R`,
      requiredValue:
        `${formatTrendPullbackNumber(options.minimumStopDistanceAtr, 2)}–` +
        `${formatTrendPullbackNumber(options.maximumStopDistanceAtr, 2)} ATR e ` +
        `alvo ≥ ${formatTrendPullbackNumber(options.minimumRiskRewardRatio, 2)}R`,
      explanation:
        plan === null
          ? 'Não foi possível construir entrada, invalidação e alvo.'
          : !stopDistanceValid
            ? `A distância do stop seria de ${formatTrendPullbackNumber(plan.stopDistanceAtr, 2)} ATR.`
            : `O stop está a ${formatTrendPullbackNumber(plan.stopDistanceAtr, 2)} ATR e o alvo oferece ${formatTrendPullbackNumber(plan.riskRewardRatio, 2)}R.`,
    }),
  ];

  const passedConditions =
    conditions.filter((item) => item.passed).length;
  const totalConditions = conditions.length;
  const allConditionsMet =
    indicators.ready &&
    previousCandleAvailable &&
    passedConditions === totalConditions;

  const trendConditionsPassed = conditions
    .filter((item) =>
      [
        'tendencia_principal_positiva',
        'emas_alinhadas',
        'volatilidade_aceitavel',
      ].includes(item.id),
    )
    .every((item) => item.passed);

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

  let status: TrendPullbackStatus;

  if (!indicators.ready || !previousCandleAvailable) {
    status = 'dados_insuficientes';
  } else if (liveInvalidated) {
    status = 'invalidado';
  } else if (liveEntryLate) {
    status = 'entrada_atrasada';
  } else if (allConditionsMet) {
    status = 'condicoes_atendidas';
  } else if (
    trendConditionsPassed &&
    pullbackTouched &&
    passedConditions >= 4
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

  if (!previousCandleAvailable) {
    warnings.push(
      'É necessário pelo menos um candle anterior para avaliar o pullback.',
    );
  }

  if (indicators.volatilityRegime === 'extremo') {
    warnings.push(
      'A volatilidade está no regime extremo do histórico analisado.',
    );
  }

  if (
    indicators.relativeVolume !== null &&
    indicators.relativeVolume < options.minimumRelativeVolume
  ) {
    warnings.push(
      'A recuperação não possui volume relativo suficiente.',
    );
  }

  if (
    previousCandleVolumeRatio !== null &&
    previousCandleVolumeRatio <
      options.minimumPreviousCandleVolumeRatio
  ) {
    warnings.push(
      'O volume atual ainda não superou o volume do candle anterior.',
    );
  }

  if (plan && !stopDistanceValid) {
    warnings.push(
      `A invalidação ficaria a ${formatTrendPullbackNumber(plan.stopDistanceAtr, 2)} ATR da entrada.`,
    );
  }

  if (liveEntryLate && plan && livePrice !== null) {
    warnings.push(
      `O preço ao vivo está ${formatTrendPullbackPct(((livePrice - plan.entryReference) / plan.entryReference) * 100)} acima da entrada de referência.`,
    );
  }

  if (liveInvalidated && plan) {
    warnings.push(
      `O preço ao vivo atingiu ou perdeu a invalidação em ${formatTrendPullbackNumber(plan.stopReference)}.`,
    );
  }

  return {
    strategy: TREND_PULLBACK_STRATEGY_ID,
    strategyVersion: TREND_PULLBACK_STRATEGY_VERSION,
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
    nextTrigger: determineTrendPullbackNextTrigger(
      conditions,
      indicators,
      plan,
      status,
      options,
    ),
    summary: determineTrendPullbackSummary(
      status,
      passedConditions,
      totalConditions,
    ),
    warnings,
    educationalNotice: TREND_PULLBACK_EDUCATIONAL_NOTICE,
    diagnostics: {
      ready: indicators.ready && previousCandleAvailable,
      candleCount: indicators.candleCount,
      requiredCandles: indicators.requiredCandles,
      missingCandles:
        indicators.missingCandles +
        (previousCandleAvailable ? 0 : 1),
      volatilityRegime: indicators.volatilityRegime,
      volatilityPercentile: indicators.volatilityPercentile,
      relativeVolume: indicators.relativeVolume,
      previousCandleVolumeRatio,
      pullbackTouched:
        pullbackAvailable ? pullbackTouched : null,
      recoveryConfirmed:
        recoveryAvailable ? recoveryConfirmed : null,
      pullbackLow,
      pullbackZoneUpper,
      pullbackZoneLower,
      stopDistanceAtr: plan?.stopDistanceAtr ?? null,
    },
  };
}

export function analyzeTrendPullback(
  input: AnalyzeTrendPullbackInput,
): {
  indicators: DayTradeIndicators;
  evaluation: TrendPullbackEvaluation;
} {
  const indicators = calculateDayTradeIndicators(
    input.candles,
    input.indicatorOptions,
  );

  const evaluation = evaluateTrendPullback({
    candles: input.candles,
    indicators,
    livePrice: input.livePrice,
    options: input.strategyOptions,
  });

  return { indicators, evaluation };
}

export const TREND_PULLBACK_STATUS_LABELS: Record<
  TrendPullbackStatus,
  { label: string; shortDescription: string }
> = {
  dados_insuficientes: {
    label: 'Dados insuficientes',
    shortDescription: 'Ainda faltam candles para calcular os critérios.',
  },
  aguardar: {
    label: 'Aguardar',
    shortDescription: 'As condições ainda não formam um pullback válido.',
  },
  observar: {
    label: 'Observar',
    shortDescription: 'O preço recuou até a região, mas falta confirmação.',
  },
  condicoes_atendidas: {
    label: 'Condições atendidas',
    shortDescription: 'O último candle cumpriu todas as regras.',
  },
  entrada_atrasada: {
    label: 'Entrada atrasada',
    shortDescription: 'O preço já se afastou da entrada calculada.',
  },
  invalidado: {
    label: 'Invalidado',
    shortDescription: 'O preço atingiu o ponto de invalidação.',
  },
};

// ============================================================================
// SEÇÃO 6: strategies/squeezeBreakout.ts
// ============================================================================

/**
 * supabase/functions/avaliar-daytrade/strategies/squeezeBreakout.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Playbook de rompimento após compressão de preço e amplitude.
 *
 * Estratégia:
 * - Tendência principal positiva.
 * - EMA 20 acima da EMA 50 e EMA 50 acima da EMA 200.
 * - Faixa recente comprimida em relação à amplitude histórica anterior.
 * - Rompimento confirmado acima da máxima da compressão.
 * - Expansão de volume no candle de confirmação.
 * - Volatilidade fora do regime extremo.
 * - Plano com stop técnico e alvo mínimo de 2R.
 *
 * Este módulo NÃO consulta APIs, NÃO grava no banco e NÃO executa ordens.
 * Ele apenas aplica regras determinísticas aos candles e indicadores recebidos.
 */


// -----------------------------------------------------------------------------
// Identidade do playbook
// -----------------------------------------------------------------------------

export const SQUEEZE_BREAKOUT_STRATEGY_ID = 'squeeze_breakout' as const;
export const SQUEEZE_BREAKOUT_STRATEGY_VERSION = '1.0.0' as const;

export const SQUEEZE_BREAKOUT_EDUCATIONAL_NOTICE =
  'Este resultado verifica condições técnicas históricas e não representa recomendação de compra ou promessa de resultado.';

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type SqueezeBreakoutStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export type SqueezeBreakoutConditionId =
  | 'tendencia_principal_positiva'
  | 'emas_alinhadas'
  | 'compressao_confirmada'
  | 'rompimento_confirmado'
  | 'volume_expansao'
  | 'volatilidade_aceitavel'
  | 'plano_risco_retorno';

export interface SqueezeBreakoutCondition {
  id: SqueezeBreakoutConditionId;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface SqueezeBreakoutPlan {
  direction: 'long';

  /** Fechamento do candle encerrado que confirmou o rompimento. */
  entryReference: number;

  /** Ponto em que a hipótese técnica deixa de ser válida. */
  stopReference: number;

  /** Alvo matemático calculado pelo múltiplo de risco configurado. */
  targetReference: number;

  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;

  stopDistancePct: number;
  targetDistancePct: number;
  stopDistanceAtr: number;

  /** Máxima da faixa comprimida, sem incluir o candle de confirmação. */
  breakoutLevel: number;

  /** Mínima da faixa comprimida, sem incluir o candle de confirmação. */
  compressionLow: number;

  /** Largura absoluta da faixa comprimida. */
  compressionRange: number;

  /** Largura da compressão medida em ATR. */
  compressionRangeAtr: number;

  /** Preço acima do qual a entrada passa a ser considerada atrasada. */
  latestAcceptableEntry: number;

  /** Stop abaixo da mínima da compressão, com buffer de ATR. */
  structuralStopCandidate: number;

  /** Stop alternativo limitado por ATR. */
  atrStopCandidate: number;

  emaFast: number;
  emaMedium: number;
  emaSlow: number;
}

export interface SqueezeBreakoutOptions {
  /**
   * Quantidade de candles anteriores que formam a compressão.
   * O candle atual nunca participa da faixa. Padrão: 12.
   */
  compressionLookback?: number;

  /**
   * Quantidade de candles anteriores à compressão usada como referência de
   * amplitude. Padrão: 24.
   */
  baselineLookback?: number;

  /**
   * Média da amplitude da compressão dividida pela média da amplitude-base.
   * Padrão máximo: 0,75.
   */
  maximumRangeContractionRatio?: number;

  /**
   * Largura máxima de toda a faixa comprimida em múltiplos de ATR.
   * Padrão: 4 ATR.
   */
  maximumCompressionRangeAtr?: number;

  /** Volume atual dividido pela média anterior. Padrão: 1,2. */
  minimumRelativeVolume?: number;

  /** Volume atual dividido pelo candle anterior. Padrão: 1,1. */
  minimumPreviousCandleVolumeRatio?: number;

  /** Distância mínima do fechamento acima da faixa. Padrão: 0 ATR. */
  minimumBreakoutDistanceAtr?: number;

  /** Distância máxima para considerar o ativo próximo do gatilho. Padrão: 0,25 ATR. */
  observationDistanceAtr?: number;

  /** Distância do stop alternativo calculado por ATR. Padrão: 1,5 ATR. */
  atrStopMultiple?: number;

  /** Buffer abaixo da mínima da compressão. Padrão: 0,1 ATR. */
  structuralStopBufferAtr?: number;

  /** Relação alvo/risco mínima. Padrão: 2. */
  minimumRiskRewardRatio?: number;

  /** Distância máxima após a entrada de referência. Padrão: 0,35 ATR. */
  maximumLateEntryDistanceAtr?: number;

  /** Stop mínimo permitido. Padrão: 0,5 ATR. */
  minimumStopDistanceAtr?: number;

  /** Stop máximo permitido. Padrão: 3 ATR. */
  maximumStopDistanceAtr?: number;

  /** Regimes que bloqueiam a confirmação. */
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface ResolvedSqueezeBreakoutOptions {
  compressionLookback: number;
  baselineLookback: number;
  maximumRangeContractionRatio: number;
  maximumCompressionRangeAtr: number;
  minimumRelativeVolume: number;
  minimumPreviousCandleVolumeRatio: number;
  minimumBreakoutDistanceAtr: number;
  observationDistanceAtr: number;
  atrStopMultiple: number;
  structuralStopBufferAtr: number;
  minimumRiskRewardRatio: number;
  maximumLateEntryDistanceAtr: number;
  minimumStopDistanceAtr: number;
  maximumStopDistanceAtr: number;
  blockedVolatilityRegimes: readonly VolatilityRegime[];
}

export interface EvaluateSqueezeBreakoutInput {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;

  /**
   * Preço atual opcional. Serve somente para detectar entrada atrasada ou
   * invalidação; nunca confirma o setup.
   */
  livePrice?: number | null;

  options?: SqueezeBreakoutOptions;
}

export interface AnalyzeSqueezeBreakoutInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  livePrice?: number | null;
  strategyOptions?: SqueezeBreakoutOptions;
}

export interface SqueezeBreakoutEvaluation {
  strategy: typeof SQUEEZE_BREAKOUT_STRATEGY_ID;
  strategyVersion: typeof SQUEEZE_BREAKOUT_STRATEGY_VERSION;
  direction: 'long';
  status: SqueezeBreakoutStatus;

  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;

  conditions: SqueezeBreakoutCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;

  plan: SqueezeBreakoutPlan | null;

  nextTrigger: string;
  summary: string;
  warnings: string[];
  educationalNotice: string;

  diagnostics: {
    ready: boolean;
    candleCount: number;
    requiredCandles: number;
    strategyRequiredCandles: number;
    missingCandles: number;
    volatilityRegime: VolatilityRegime;
    volatilityPercentile: number | null;
    relativeVolume: number | null;
    previousCandleVolumeRatio: number | null;
    compressionRangeAtr: number | null;
    rangeContractionRatio: number | null;
    compressionAverageRange: number | null;
    baselineAverageRange: number | null;
    breakoutLevel: number | null;
    compressionLow: number | null;
    distanceToCompressionBreakoutAtr: number | null;
    stopDistanceAtr: number | null;
  };
}

// -----------------------------------------------------------------------------
// Configuração e validação
// -----------------------------------------------------------------------------

const SQUEEZE_BREAKOUT_DEFAULT_OPTIONS: ResolvedSqueezeBreakoutOptions = {
  compressionLookback: 12,
  baselineLookback: 24,
  maximumRangeContractionRatio: 0.75,
  maximumCompressionRangeAtr: 4,
  minimumRelativeVolume: 1.2,
  minimumPreviousCandleVolumeRatio: 1.1,
  minimumBreakoutDistanceAtr: 0,
  observationDistanceAtr: 0.25,
  atrStopMultiple: 1.5,
  structuralStopBufferAtr: 0.1,
  minimumRiskRewardRatio: 2,
  maximumLateEntryDistanceAtr: 0.35,
  minimumStopDistanceAtr: 0.5,
  maximumStopDistanceAtr: 3,
  blockedVolatilityRegimes: ['extremo', 'indisponível'],
};

function positiveSqueezeBreakoutNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número maior que zero.`);
  }

  return value;
}

function nonNegativeSqueezeBreakoutNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} deve ser um número maior ou igual a zero.`);
  }

  return value;
}

function positiveSqueezeBreakoutInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um número inteiro maior que zero.`);
  }

  return value;
}

export function resolveSqueezeBreakoutOptions(
  options: SqueezeBreakoutOptions = {},
): ResolvedSqueezeBreakoutOptions {
  const resolved: ResolvedSqueezeBreakoutOptions = {
    compressionLookback: positiveSqueezeBreakoutInteger(
      options.compressionLookback ?? SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.compressionLookback,
      'compressionLookback',
    ),
    baselineLookback: positiveSqueezeBreakoutInteger(
      options.baselineLookback ?? SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.baselineLookback,
      'baselineLookback',
    ),
    maximumRangeContractionRatio: positiveSqueezeBreakoutNumber(
      options.maximumRangeContractionRatio ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.maximumRangeContractionRatio,
      'maximumRangeContractionRatio',
    ),
    maximumCompressionRangeAtr: positiveSqueezeBreakoutNumber(
      options.maximumCompressionRangeAtr ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.maximumCompressionRangeAtr,
      'maximumCompressionRangeAtr',
    ),
    minimumRelativeVolume: positiveSqueezeBreakoutNumber(
      options.minimumRelativeVolume ?? SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    minimumPreviousCandleVolumeRatio: positiveSqueezeBreakoutNumber(
      options.minimumPreviousCandleVolumeRatio ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.minimumPreviousCandleVolumeRatio,
      'minimumPreviousCandleVolumeRatio',
    ),
    minimumBreakoutDistanceAtr: nonNegativeSqueezeBreakoutNumber(
      options.minimumBreakoutDistanceAtr ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.minimumBreakoutDistanceAtr,
      'minimumBreakoutDistanceAtr',
    ),
    observationDistanceAtr: nonNegativeSqueezeBreakoutNumber(
      options.observationDistanceAtr ?? SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.observationDistanceAtr,
      'observationDistanceAtr',
    ),
    atrStopMultiple: positiveSqueezeBreakoutNumber(
      options.atrStopMultiple ?? SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.atrStopMultiple,
      'atrStopMultiple',
    ),
    structuralStopBufferAtr: nonNegativeSqueezeBreakoutNumber(
      options.structuralStopBufferAtr ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.structuralStopBufferAtr,
      'structuralStopBufferAtr',
    ),
    minimumRiskRewardRatio: positiveSqueezeBreakoutNumber(
      options.minimumRiskRewardRatio ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.minimumRiskRewardRatio,
      'minimumRiskRewardRatio',
    ),
    maximumLateEntryDistanceAtr: nonNegativeSqueezeBreakoutNumber(
      options.maximumLateEntryDistanceAtr ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.maximumLateEntryDistanceAtr,
      'maximumLateEntryDistanceAtr',
    ),
    minimumStopDistanceAtr: positiveSqueezeBreakoutNumber(
      options.minimumStopDistanceAtr ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.minimumStopDistanceAtr,
      'minimumStopDistanceAtr',
    ),
    maximumStopDistanceAtr: positiveSqueezeBreakoutNumber(
      options.maximumStopDistanceAtr ??
        SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.maximumStopDistanceAtr,
      'maximumStopDistanceAtr',
    ),
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ??
      SQUEEZE_BREAKOUT_DEFAULT_OPTIONS.blockedVolatilityRegimes,
  };

  if (resolved.compressionLookback < 3) {
    throw new Error('compressionLookback deve ser pelo menos 3.');
  }

  if (resolved.baselineLookback < 3) {
    throw new Error('baselineLookback deve ser pelo menos 3.');
  }

  if (resolved.maximumRangeContractionRatio > 1) {
    throw new Error(
      'maximumRangeContractionRatio deve ser menor ou igual a 1.',
    );
  }

  if (resolved.minimumStopDistanceAtr >= resolved.maximumStopDistanceAtr) {
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

// -----------------------------------------------------------------------------
// Utilitários internos
// -----------------------------------------------------------------------------

interface SqueezeBreakoutCompressionMetrics {
  breakoutLevel: number;
  compressionLow: number;
  compressionRange: number;
  compressionRangeAtr: number;
  compressionAverageRange: number;
  baselineAverageRange: number;
  rangeContractionRatio: number;
}

function isFinitePositiveSqueezeBreakout(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function averageSqueezeBreakout(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSqueezeBreakoutNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function formatSqueezeBreakoutPct(value: number, fractionDigits = 2): string {
  return `${new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}%`;
}

function squeezeBreakoutCondition(
  value: Omit<SqueezeBreakoutCondition, 'available'> & {
    available?: boolean;
  },
): SqueezeBreakoutCondition {
  return {
    ...value,
    available: value.available ?? true,
  };
}

function getSqueezeBreakoutRequiredCandleCount(
  options: ResolvedSqueezeBreakoutOptions,
): number {
  // Candle-base + compressão + candle atual de confirmação.
  return (
    options.baselineLookback +
    options.compressionLookback +
    1
  );
}

function calculateSqueezeBreakoutCompressionMetrics(
  candles: readonly DayTradeCandle[],
  atr: number | null,
  options: ResolvedSqueezeBreakoutOptions,
): SqueezeBreakoutCompressionMetrics | null {
  if (!isFinitePositiveSqueezeBreakout(atr)) return null;

  const required = getSqueezeBreakoutRequiredCandleCount(options);
  if (candles.length < required) return null;

  const currentIndex = candles.length - 1;
  const compressionStart =
    currentIndex - options.compressionLookback;
  const baselineStart =
    compressionStart - options.baselineLookback;

  if (baselineStart < 0) return null;

  const compressionCandles = candles.slice(
    compressionStart,
    currentIndex,
  );
  const baselineCandles = candles.slice(
    baselineStart,
    compressionStart,
  );

  if (
    compressionCandles.length !== options.compressionLookback ||
    baselineCandles.length !== options.baselineLookback
  ) {
    return null;
  }

  const breakoutLevel = Math.max(
    ...compressionCandles.map((candle) => candle.high),
  );
  const compressionLow = Math.min(
    ...compressionCandles.map((candle) => candle.low),
  );
  const compressionRange = breakoutLevel - compressionLow;

  const compressionAverageRange = averageSqueezeBreakout(
    compressionCandles.map((candle) => candle.high - candle.low),
  );
  const baselineAverageRange = averageSqueezeBreakout(
    baselineCandles.map((candle) => candle.high - candle.low),
  );

  if (
    compressionAverageRange === null ||
    baselineAverageRange === null ||
    baselineAverageRange <= 0 ||
    compressionRange <= 0
  ) {
    return null;
  }

  return {
    breakoutLevel,
    compressionLow,
    compressionRange,
    compressionRangeAtr: compressionRange / atr,
    compressionAverageRange,
    baselineAverageRange,
    rangeContractionRatio:
      compressionAverageRange / baselineAverageRange,
  };
}

function createSqueezeBreakoutPlan(
  currentCandle: DayTradeCandle,
  indicators: DayTradeIndicators,
  compression: SqueezeBreakoutCompressionMetrics | null,
  options: ResolvedSqueezeBreakoutOptions,
): SqueezeBreakoutPlan | null {
  const atr = indicators.atr;
  const emaFast = indicators.emaFast;
  const emaMedium = indicators.emaMedium;
  const emaSlow = indicators.emaSlow;

  if (
    compression === null ||
    !isFinitePositiveSqueezeBreakout(atr) ||
    !isFinitePositiveSqueezeBreakout(emaFast) ||
    !isFinitePositiveSqueezeBreakout(emaMedium) ||
    !isFinitePositiveSqueezeBreakout(emaSlow)
  ) {
    return null;
  }

  const entryReference = currentCandle.close;
  const structuralStopCandidate =
    compression.compressionLow -
    atr * options.structuralStopBufferAtr;
  const atrStopCandidate =
    entryReference - atr * options.atrStopMultiple;

  // Evita um stop excessivamente distante, mas exige que ele permaneça abaixo
  // da antiga resistência da compressão.
  const stopReference = Math.max(
    structuralStopCandidate,
    atrStopCandidate,
  );

  if (
    !Number.isFinite(stopReference) ||
    stopReference <= 0 ||
    stopReference >= entryReference ||
    stopReference >= compression.breakoutLevel
  ) {
    return null;
  }

  const riskPerUnit = entryReference - stopReference;
  const rewardPerUnit =
    riskPerUnit * options.minimumRiskRewardRatio;
  const targetReference = entryReference + rewardPerUnit;
  const stopDistanceAtr = riskPerUnit / atr;

  return {
    direction: 'long',
    entryReference,
    stopReference,
    targetReference,
    riskPerUnit,
    rewardPerUnit,
    riskRewardRatio: rewardPerUnit / riskPerUnit,
    stopDistancePct: (riskPerUnit / entryReference) * 100,
    targetDistancePct: (rewardPerUnit / entryReference) * 100,
    stopDistanceAtr,
    breakoutLevel: compression.breakoutLevel,
    compressionLow: compression.compressionLow,
    compressionRange: compression.compressionRange,
    compressionRangeAtr: compression.compressionRangeAtr,
    latestAcceptableEntry:
      entryReference +
      atr * options.maximumLateEntryDistanceAtr,
    structuralStopCandidate,
    atrStopCandidate,
    emaFast,
    emaMedium,
    emaSlow,
  };
}

function determineSqueezeBreakoutNextTrigger(
  conditions: readonly SqueezeBreakoutCondition[],
  indicators: DayTradeIndicators,
  plan: SqueezeBreakoutPlan | null,
  compression: SqueezeBreakoutCompressionMetrics | null,
  status: SqueezeBreakoutStatus,
  options: ResolvedSqueezeBreakoutOptions,
): string {
  if (status === 'dados_insuficientes') {
    return 'Carregue mais candles encerrados para completar os indicadores e as janelas de compressão.';
  }

  if (status === 'invalidado' && plan) {
    return `A formação perdeu validade porque o preço atingiu ou ficou abaixo de ${formatSqueezeBreakoutNumber(plan.stopReference)}. Aguarde uma nova compressão.`;
  }

  if (status === 'entrada_atrasada' && plan) {
    return `Aguarde uma nova formação. O preço ultrapassou o limite de entrada de ${formatSqueezeBreakoutNumber(plan.latestAcceptableEntry)}.`;
  }

  if (status === 'condicoes_atendidas' && plan) {
    return `O candle encerrado confirmou o rompimento da compressão acima de ${formatSqueezeBreakoutNumber(plan.breakoutLevel)}.`;
  }

  const firstFailed = conditions.find(
    (item) => item.available && !item.passed,
  );

  switch (firstFailed?.id) {
    case 'tendencia_principal_positiva':
      return indicators.emaSlow === null
        ? 'Aguarde a EMA lenta ficar disponível.'
        : `Aguarde um fechamento acima da EMA lenta em ${formatSqueezeBreakoutNumber(indicators.emaSlow)}.`;

    case 'emas_alinhadas':
      return 'Aguarde o alinhamento EMA rápida > EMA intermediária > EMA lenta.';

    case 'compressao_confirmada':
      if (!compression) {
        return 'Aguarde histórico suficiente para medir a compressão.';
      }

      return `A faixa ainda precisa contrair para no máximo ${formatSqueezeBreakoutNumber(options.maximumRangeContractionRatio, 2)}× a amplitude-base e ${formatSqueezeBreakoutNumber(options.maximumCompressionRangeAtr, 2)} ATR de largura.`;

    case 'rompimento_confirmado':
      return compression
        ? `Aguarde um candle positivo fechando acima de ${formatSqueezeBreakoutNumber(compression.breakoutLevel)}.`
        : 'Aguarde a definição da máxima da compressão.';

    case 'volume_expansao':
      return `O rompimento ainda exige volume relativo mínimo de ${formatSqueezeBreakoutNumber(options.minimumRelativeVolume, 2)}× e volume pelo menos ${formatSqueezeBreakoutNumber(options.minimumPreviousCandleVolumeRatio, 2)}× o candle anterior.`;

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado pelo playbook.';

    case 'plano_risco_retorno':
      return `Aguarde uma formação com stop entre ${formatSqueezeBreakoutNumber(options.minimumStopDistanceAtr, 2)} e ${formatSqueezeBreakoutNumber(options.maximumStopDistanceAtr, 2)} ATR e alvo mínimo de ${formatSqueezeBreakoutNumber(options.minimumRiskRewardRatio, 2)}R.`;

    default:
      return 'Aguarde a conclusão conjunta das condições técnicas restantes no mesmo candle encerrado.';
  }
}

function determineSqueezeBreakoutSummary(
  status: SqueezeBreakoutStatus,
  passed: number,
  total: number,
): string {
  switch (status) {
    case 'dados_insuficientes':
      return 'Ainda não há candles encerrados suficientes para avaliar a compressão.';
    case 'aguardar':
      return `${passed} de ${total} condições foram atendidas. Ainda não existe uma compressão válida com rompimento.`;
    case 'observar':
      return `${passed} de ${total} condições foram atendidas. A faixa está comprimida e o preço está próximo do gatilho.`;
    case 'condicoes_atendidas':
      return `${passed} de ${total} condições foram atendidas no candle encerrado mais recente.`;
    case 'entrada_atrasada':
      return 'O rompimento foi confirmado, mas o preço ao vivo já se afastou demais da entrada de referência.';
    case 'invalidado':
      return 'O rompimento chegou a ser confirmado, mas o preço ao vivo atingiu o nível de invalidação.';
  }
}

// -----------------------------------------------------------------------------
// Avaliação principal
// -----------------------------------------------------------------------------

export function evaluateSqueezeBreakout(
  input: EvaluateSqueezeBreakoutInput,
): SqueezeBreakoutEvaluation {
  const options = resolveSqueezeBreakoutOptions(input.options);
  const candles = normalizeClosedCandles(input.candles);

  if (candles.length === 0) {
    throw new Error(
      'É necessário informar pelo menos um candle encerrado para avaliar o playbook.',
    );
  }

  const currentCandle = candles[candles.length - 1];
  const previousCandle =
    candles.length >= 2 ? candles[candles.length - 2] : null;
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
      : positiveSqueezeBreakoutNumber(input.livePrice, 'livePrice');

  const requiredByStrategy =
    getSqueezeBreakoutRequiredCandleCount(options);
  const strategyMissingCandles = Math.max(
    0,
    requiredByStrategy - candles.length,
  );
  const strategyReady = strategyMissingCandles === 0;

  const compression = calculateSqueezeBreakoutCompressionMetrics(
    candles,
    indicators.atr,
    options,
  );
  const plan = createSqueezeBreakoutPlan(
    currentCandle,
    indicators,
    compression,
    options,
  );

  const atrAvailable = isFinitePositiveSqueezeBreakout(indicators.atr);
  const emaFastAvailable = isFinitePositiveSqueezeBreakout(indicators.emaFast);
  const emaMediumAvailable = isFinitePositiveSqueezeBreakout(indicators.emaMedium);
  const emaSlowAvailable = isFinitePositiveSqueezeBreakout(indicators.emaSlow);

  const trendAvailable = emaSlowAvailable;
  const alignmentAvailable =
    emaFastAvailable && emaMediumAvailable && emaSlowAvailable;
  const compressionAvailable =
    strategyReady && compression !== null;
  const breakoutAvailable =
    compressionAvailable && atrAvailable;
  const volumeAvailable =
    previousCandle !== null &&
    previousCandle.volume > 0 &&
    indicators.relativeVolume !== null &&
    Number.isFinite(indicators.relativeVolume);
  const volatilityAvailable =
    indicators.volatilityRegime !== 'indisponível';

  const compressionConfirmed =
    compressionAvailable &&
    (compression as SqueezeBreakoutCompressionMetrics).rangeContractionRatio <=
      options.maximumRangeContractionRatio &&
    (compression as SqueezeBreakoutCompressionMetrics).compressionRangeAtr <=
      options.maximumCompressionRangeAtr;

  const breakoutDistanceAtr =
    breakoutAvailable
      ? (
          currentCandle.close -
          (compression as SqueezeBreakoutCompressionMetrics).breakoutLevel
        ) / (indicators.atr as number)
      : null;

  const candleRange = currentCandle.high - currentCandle.low;
  const closeLocation =
    candleRange > 0
      ? (currentCandle.close - currentCandle.low) /
        candleRange
      : 0;

  const breakoutConfirmed =
    breakoutAvailable &&
    breakoutDistanceAtr !== null &&
    breakoutDistanceAtr >=
      options.minimumBreakoutDistanceAtr &&
    currentCandle.close >
      (compression as SqueezeBreakoutCompressionMetrics).breakoutLevel &&
    currentCandle.close > currentCandle.open &&
    closeLocation >= 0.6;

  const previousCandleVolumeRatio =
    previousCandle !== null && previousCandle.volume > 0
      ? currentCandle.volume / previousCandle.volume
      : null;

  const volumeConfirmed =
    volumeAvailable &&
    (indicators.relativeVolume as number) >=
      options.minimumRelativeVolume &&
    (previousCandleVolumeRatio as number) >=
      options.minimumPreviousCandleVolumeRatio;

  const stopDistanceValid =
    plan !== null &&
    plan.stopDistanceAtr >= options.minimumStopDistanceAtr &&
    plan.stopDistanceAtr <= options.maximumStopDistanceAtr;

  const riskRewardValid =
    plan !== null &&
    plan.riskRewardRatio >= options.minimumRiskRewardRatio;

  const conditions: SqueezeBreakoutCondition[] = [
    squeezeBreakoutCondition({
      id: 'tendencia_principal_positiva',
      label: 'Preço acima da EMA lenta',
      available: trendAvailable,
      passed:
        trendAvailable &&
        currentCandle.close > (indicators.emaSlow as number),
      currentValue: currentCandle.close,
      requiredValue:
        indicators.emaSlow === null
          ? 'EMA lenta disponível'
          : `Fechamento acima de ${formatSqueezeBreakoutNumber(indicators.emaSlow)}`,
      explanation:
        indicators.emaSlow === null
          ? 'A média lenta ainda não possui histórico suficiente.'
          : currentCandle.close > indicators.emaSlow
            ? `O fechamento está ${formatSqueezeBreakoutPct(((currentCandle.close - indicators.emaSlow) / indicators.emaSlow) * 100)} acima da EMA lenta.`
            : `O fechamento está ${formatSqueezeBreakoutPct(((indicators.emaSlow - currentCandle.close) / indicators.emaSlow) * 100)} abaixo da EMA lenta.`,
    }),
    squeezeBreakoutCondition({
      id: 'emas_alinhadas',
      label: 'EMAs 20, 50 e 200 alinhadas',
      available: alignmentAvailable,
      passed:
        alignmentAvailable &&
        (indicators.emaFast as number) >
          (indicators.emaMedium as number) &&
        (indicators.emaMedium as number) >
          (indicators.emaSlow as number),
      currentValue:
        alignmentAvailable
          ? `${formatSqueezeBreakoutNumber(indicators.emaFast as number)} / ${formatSqueezeBreakoutNumber(indicators.emaMedium as number)} / ${formatSqueezeBreakoutNumber(indicators.emaSlow as number)}`
          : null,
      requiredValue:
        'EMA rápida > EMA intermediária > EMA lenta',
      explanation:
        !alignmentAvailable
          ? 'As médias ainda não possuem histórico suficiente.'
          : (indicators.emaFast as number) >
                (indicators.emaMedium as number) &&
              (indicators.emaMedium as number) >
                (indicators.emaSlow as number)
            ? 'As três médias estão alinhadas em ordem positiva.'
            : 'As três médias ainda não estão alinhadas em ordem positiva.',
    }),
    squeezeBreakoutCondition({
      id: 'compressao_confirmada',
      label: 'Faixa recente comprimida',
      available: compressionAvailable,
      passed: compressionConfirmed,
      currentValue:
        compression === null
          ? null
          : `${formatSqueezeBreakoutNumber(compression.rangeContractionRatio, 2)}× base · ${formatSqueezeBreakoutNumber(compression.compressionRangeAtr, 2)} ATR`,
      requiredValue:
        `Contração ≤ ${formatSqueezeBreakoutNumber(options.maximumRangeContractionRatio, 2)}× e faixa ≤ ${formatSqueezeBreakoutNumber(options.maximumCompressionRangeAtr, 2)} ATR`,
      explanation:
        !compressionAvailable
          ? 'Ainda faltam candles ou ATR para medir a compressão.'
          : compressionConfirmed
            ? 'A amplitude média recente e a largura total da faixa estão dentro dos limites de compressão.'
            : 'A faixa recente ainda está ampla demais em relação ao histórico anterior ou ao ATR.',
    }),
    squeezeBreakoutCondition({
      id: 'rompimento_confirmado',
      label: 'Rompimento confirmado no fechamento',
      available: breakoutAvailable,
      passed: breakoutConfirmed,
      currentValue:
        breakoutDistanceAtr === null
          ? null
          : `${formatSqueezeBreakoutNumber(currentCandle.close)} · ${formatSqueezeBreakoutNumber(breakoutDistanceAtr, 2)} ATR`,
      requiredValue:
        compression === null
          ? 'Máxima da compressão disponível'
          : `Candle positivo fechando acima de ${formatSqueezeBreakoutNumber(compression.breakoutLevel)}`,
      explanation:
        !breakoutAvailable
          ? 'Ainda não existe faixa de compressão e ATR disponíveis.'
          : breakoutConfirmed
            ? 'O candle encerrou positivo, acima da máxima da compressão e próximo da própria máxima.'
            : 'O candle atual ainda não confirmou o rompimento da faixa.',
    }),
    squeezeBreakoutCondition({
      id: 'volume_expansao',
      label: 'Volume confirma a expansão',
      available: volumeAvailable,
      passed: volumeConfirmed,
      currentValue:
        indicators.relativeVolume === null ||
        previousCandleVolumeRatio === null
          ? null
          : `${formatSqueezeBreakoutNumber(indicators.relativeVolume, 2)}× média · ${formatSqueezeBreakoutNumber(previousCandleVolumeRatio, 2)}× candle anterior`,
      requiredValue:
        `Volume relativo ≥ ${formatSqueezeBreakoutNumber(options.minimumRelativeVolume, 2)}× e ` +
        `volume atual/anterior ≥ ${formatSqueezeBreakoutNumber(options.minimumPreviousCandleVolumeRatio, 2)}×`,
      explanation:
        !volumeAvailable
          ? 'O histórico de volume necessário ainda não está disponível.'
          : volumeConfirmed
            ? 'O volume do rompimento superou os dois limites configurados.'
            : 'O volume do rompimento ainda não superou os dois limites configurados.',
    }),
    squeezeBreakoutCondition({
      id: 'volatilidade_aceitavel',
      label: 'Volatilidade fora do regime bloqueado',
      available: volatilityAvailable,
      passed:
        volatilityAvailable &&
        !options.blockedVolatilityRegimes.includes(
          indicators.volatilityRegime,
        ),
      currentValue: indicators.volatilityRegime,
      requiredValue:
        `Fora de: ${options.blockedVolatilityRegimes.join(', ')}`,
      explanation:
        indicators.volatilityRegime === 'indisponível'
          ? 'Ainda não há histórico suficiente para classificar a volatilidade.'
          : options.blockedVolatilityRegimes.includes(
                indicators.volatilityRegime,
              )
            ? `A volatilidade está em regime ${indicators.volatilityRegime}, bloqueado pelo playbook.`
            : `A volatilidade está em regime ${indicators.volatilityRegime}, permitido pelo playbook.`,
    }),
    squeezeBreakoutCondition({
      id: 'plano_risco_retorno',
      label: 'Plano com risco e alvo coerentes',
      available: plan !== null,
      passed: stopDistanceValid && riskRewardValid,
      currentValue:
        plan === null
          ? null
          : `${formatSqueezeBreakoutNumber(plan.stopDistanceAtr, 2)} ATR · ${formatSqueezeBreakoutNumber(plan.riskRewardRatio, 2)}R`,
      requiredValue:
        `${formatSqueezeBreakoutNumber(options.minimumStopDistanceAtr, 2)}–` +
        `${formatSqueezeBreakoutNumber(options.maximumStopDistanceAtr, 2)} ATR e ` +
        `alvo ≥ ${formatSqueezeBreakoutNumber(options.minimumRiskRewardRatio, 2)}R`,
      explanation:
        plan === null
          ? 'Não foi possível construir entrada, invalidação e alvo com os dados atuais.'
          : !stopDistanceValid
            ? `A distância do stop seria de ${formatSqueezeBreakoutNumber(plan.stopDistanceAtr, 2)} ATR, fora do intervalo permitido.`
            : `O stop está a ${formatSqueezeBreakoutNumber(plan.stopDistanceAtr, 2)} ATR e o alvo oferece ${formatSqueezeBreakoutNumber(plan.riskRewardRatio, 2)} vezes o risco.`,
    }),
  ];

  const passedConditions =
    conditions.filter((item) => item.passed).length;
  const totalConditions = conditions.length;
  const ready =
    indicators.ready &&
    strategyReady &&
    previousCandle !== null;

  const allConditionsMet =
    ready && passedConditions === totalConditions;

  const trendConditionsPassed = conditions
    .filter((item) =>
      [
        'tendencia_principal_positiva',
        'emas_alinhadas',
        'volatilidade_aceitavel',
      ].includes(item.id),
    )
    .every((item) => item.passed);

  const nearBreakout =
    compression !== null &&
    atrAvailable &&
    currentCandle.close <= compression.breakoutLevel &&
    (
      compression.breakoutLevel -
      currentCandle.close
    ) / (indicators.atr as number) <=
      options.observationDistanceAtr;

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

  let status: SqueezeBreakoutStatus;

  if (!ready) {
    status = 'dados_insuficientes';
  } else if (liveInvalidated) {
    status = 'invalidado';
  } else if (liveEntryLate) {
    status = 'entrada_atrasada';
  } else if (allConditionsMet) {
    status = 'condicoes_atendidas';
  } else if (
    trendConditionsPassed &&
    compressionConfirmed &&
    nearBreakout &&
    passedConditions >= 4
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

  if (strategyMissingCandles > 0) {
    warnings.push(
      `Faltam ${strategyMissingCandles} candle(s) para completar as janelas de compressão e referência.`,
    );
  }

  if (indicators.volatilityRegime === 'extremo') {
    warnings.push(
      'A volatilidade está no regime extremo do próprio histórico analisado.',
    );
  }

  if (
    compression !== null &&
    compression.rangeContractionRatio >
      options.maximumRangeContractionRatio
  ) {
    warnings.push(
      'A amplitude média recente ainda não contraiu o suficiente em relação à janela-base.',
    );
  }

  if (
    compression !== null &&
    compression.compressionRangeAtr >
      options.maximumCompressionRangeAtr
  ) {
    warnings.push(
      'A largura total da faixa comprimida ainda está grande demais em múltiplos de ATR.',
    );
  }

  if (
    indicators.relativeVolume !== null &&
    indicators.relativeVolume <
      options.minimumRelativeVolume
  ) {
    warnings.push(
      'O rompimento não possui volume relativo suficiente pelo critério configurado.',
    );
  }

  if (
    previousCandleVolumeRatio !== null &&
    previousCandleVolumeRatio <
      options.minimumPreviousCandleVolumeRatio
  ) {
    warnings.push(
      'O volume do candle atual ainda não superou o candle anterior pelo critério configurado.',
    );
  }

  if (plan && !stopDistanceValid) {
    warnings.push(
      `A invalidação ficaria a ${formatSqueezeBreakoutNumber(plan.stopDistanceAtr, 2)} ATR da entrada, fora do limite configurado.`,
    );
  }

  if (liveEntryLate && plan && livePrice !== null) {
    warnings.push(
      `O preço ao vivo está ${formatSqueezeBreakoutPct(((livePrice - plan.entryReference) / plan.entryReference) * 100)} acima da entrada de referência.`,
    );
  }

  if (liveInvalidated && plan) {
    warnings.push(
      `O preço ao vivo atingiu ou perdeu a invalidação em ${formatSqueezeBreakoutNumber(plan.stopReference)}.`,
    );
  }

  return {
    strategy: SQUEEZE_BREAKOUT_STRATEGY_ID,
    strategyVersion: SQUEEZE_BREAKOUT_STRATEGY_VERSION,
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

    nextTrigger: determineSqueezeBreakoutNextTrigger(
      conditions,
      indicators,
      plan,
      compression,
      status,
      options,
    ),
    summary: determineSqueezeBreakoutSummary(
      status,
      passedConditions,
      totalConditions,
    ),
    warnings,
    educationalNotice:
      SQUEEZE_BREAKOUT_EDUCATIONAL_NOTICE,

    diagnostics: {
      ready,
      candleCount: indicators.candleCount,
      requiredCandles: indicators.requiredCandles,
      strategyRequiredCandles: requiredByStrategy,
      missingCandles: Math.max(
        indicators.missingCandles,
        strategyMissingCandles,
      ),
      volatilityRegime: indicators.volatilityRegime,
      volatilityPercentile:
        indicators.volatilityPercentile,
      relativeVolume: indicators.relativeVolume,
      previousCandleVolumeRatio,
      compressionRangeAtr:
        compression?.compressionRangeAtr ?? null,
      rangeContractionRatio:
        compression?.rangeContractionRatio ?? null,
      compressionAverageRange:
        compression?.compressionAverageRange ?? null,
      baselineAverageRange:
        compression?.baselineAverageRange ?? null,
      breakoutLevel:
        compression?.breakoutLevel ?? null,
      compressionLow:
        compression?.compressionLow ?? null,
      distanceToCompressionBreakoutAtr:
        breakoutDistanceAtr,
      stopDistanceAtr:
        plan?.stopDistanceAtr ?? null,
    },
  };
}

/**
 * Calcula os indicadores e avalia o playbook em uma única chamada.
 */
export function analyzeSqueezeBreakout(
  input: AnalyzeSqueezeBreakoutInput,
): {
  indicators: DayTradeIndicators;
  evaluation: SqueezeBreakoutEvaluation;
} {
  const indicators = calculateDayTradeIndicators(
    input.candles,
    input.indicatorOptions,
  );

  const evaluation = evaluateSqueezeBreakout({
    candles: input.candles,
    indicators,
    livePrice: input.livePrice,
    options: input.strategyOptions,
  });

  return { indicators, evaluation };
}

// -----------------------------------------------------------------------------
// Rótulos prontos para interface
// -----------------------------------------------------------------------------

export const SQUEEZE_BREAKOUT_STATUS_LABELS: Record<
  SqueezeBreakoutStatus,
  {
    label: string;
    shortDescription: string;
  }
> = {
  dados_insuficientes: {
    label: 'Dados insuficientes',
    shortDescription:
      'Ainda faltam candles para medir a compressão.',
  },
  aguardar: {
    label: 'Aguardar',
    shortDescription:
      'As condições atuais ainda não formam uma compressão válida.',
  },
  observar: {
    label: 'Observar',
    shortDescription:
      'A faixa está comprimida e o preço está próximo do rompimento.',
  },
  condicoes_atendidas: {
    label: 'Condições atendidas',
    shortDescription:
      'O último candle confirmou o rompimento da compressão.',
  },
  entrada_atrasada: {
    label: 'Entrada atrasada',
    shortDescription:
      'O preço ao vivo já se afastou da entrada calculada.',
  },
  invalidado: {
    label: 'Invalidado',
    shortDescription:
      'O preço atingiu o ponto que invalida a formação.',
  },
};

// ============================================================================
// SEÇÃO 7: strategies/rangeMeanReversion.ts
// ============================================================================

/**
 * supabase/functions/avaliar-daytrade/strategies/rangeMeanReversion.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Playbook de reversão à média para mercados laterais.
 *
 * Estratégia:
 * - Identifica ausência de tendência forte.
 * - Mede uma faixa recente de preço.
 * - Procura preço descontado próximo ao suporte da faixa.
 * - Exige confirmação de recuperação no candle encerrado.
 * - Evita volume e volatilidade incompatíveis com reversão à média.
 * - Usa stop técnico abaixo da faixa e alvo na média recente.
 *
 * Este módulo NÃO consulta APIs, NÃO grava no banco e NÃO executa ordens.
 * Ele apenas aplica regras determinísticas aos candles e indicadores recebidos.
 */


// -----------------------------------------------------------------------------
// Identidade do playbook
// -----------------------------------------------------------------------------

export const RANGE_MEAN_REVERSION_STRATEGY_ID =
  'range_mean_reversion' as const;

export const RANGE_MEAN_REVERSION_STRATEGY_VERSION =
  '1.0.0' as const;

export const RANGE_MEAN_REVERSION_EDUCATIONAL_NOTICE =
  'Este resultado verifica condições técnicas históricas e não representa recomendação de compra ou promessa de resultado.';

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type RangeMeanReversionStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export type RangeMeanReversionConditionId =
  | 'mercado_lateral'
  | 'faixa_estavel'
  | 'preco_em_desconto'
  | 'recuperacao_confirmada'
  | 'volume_compativel'
  | 'volatilidade_aceitavel'
  | 'plano_risco_retorno';

export interface RangeMeanReversionCondition {
  id: RangeMeanReversionConditionId;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface RangeMeanReversionPlan {
  direction: 'long';

  /** Fechamento do candle que confirmou a recuperação. */
  entryReference: number;

  /** Ponto abaixo do qual a hipótese de faixa perde validade. */
  stopReference: number;

  /** Alvo principal na média da faixa. */
  targetReference: number;

  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;

  stopDistancePct: number;
  targetDistancePct: number;
  stopDistanceAtr: number;

  rangeHigh: number;
  rangeLow: number;
  rangeMidpoint: number;
  rangeWidth: number;
  rangeWidthAtr: number;

  meanReference: number;
  zScore: number;

  latestAcceptableEntry: number;
  structuralStopCandidate: number;
  atrStopCandidate: number;

  emaFast: number;
  emaMedium: number;
  emaSlow: number;
}

export interface RangeMeanReversionOptions {
  /** Janela usada para formar a faixa. Padrão: 30 candles. */
  rangeLookback?: number;

  /** Janela da média e do desvio-padrão. Padrão: 20 candles. */
  meanLookback?: number;

  /** Inclinação máxima da EMA lenta em ATR por candle. Padrão: 0,03. */
  maximumSlowEmaSlopeAtrPerCandle?: number;

  /** Distância máxima entre EMA 20 e EMA 50 em ATR. Padrão: 0,75. */
  maximumFastMediumEmaSpreadAtr?: number;

  /** Largura mínima da faixa em ATR. Padrão: 2. */
  minimumRangeWidthAtr?: number;

  /** Largura máxima da faixa em ATR. Padrão: 8. */
  maximumRangeWidthAtr?: number;

  /** Z-score máximo para considerar o preço descontado. Padrão: -1. */
  maximumEntryZScore?: number;

  /** Distância máxima do preço ao suporte da faixa. Padrão: 0,75 ATR. */
  maximumSupportDistanceAtr?: number;

  /** Volume relativo mínimo. Padrão: 0,5. */
  minimumRelativeVolume?: number;

  /** Volume relativo máximo para evitar rompimento. Padrão: 2,5. */
  maximumRelativeVolume?: number;

  /** Stop alternativo calculado por ATR. Padrão: 1 ATR. */
  atrStopMultiple?: number;

  /** Buffer abaixo do suporte. Padrão: 0,15 ATR. */
  structuralStopBufferAtr?: number;

  /** Relação alvo/risco mínima. Padrão: 2. */
  minimumRiskRewardRatio?: number;

  /** Distância máxima depois da entrada. Padrão: 0,3 ATR. */
  maximumLateEntryDistanceAtr?: number;

  /** Stop mínimo permitido. Padrão: 0,35 ATR. */
  minimumStopDistanceAtr?: number;

  /** Stop máximo permitido. Padrão: 2,5 ATR. */
  maximumStopDistanceAtr?: number;

  /** Regimes que bloqueiam a estratégia. */
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface ResolvedRangeMeanReversionOptions {
  rangeLookback: number;
  meanLookback: number;
  maximumSlowEmaSlopeAtrPerCandle: number;
  maximumFastMediumEmaSpreadAtr: number;
  minimumRangeWidthAtr: number;
  maximumRangeWidthAtr: number;
  maximumEntryZScore: number;
  maximumSupportDistanceAtr: number;
  minimumRelativeVolume: number;
  maximumRelativeVolume: number;
  atrStopMultiple: number;
  structuralStopBufferAtr: number;
  minimumRiskRewardRatio: number;
  maximumLateEntryDistanceAtr: number;
  minimumStopDistanceAtr: number;
  maximumStopDistanceAtr: number;
  blockedVolatilityRegimes: readonly VolatilityRegime[];
}

export interface EvaluateRangeMeanReversionInput {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;
  livePrice?: number | null;
  options?: RangeMeanReversionOptions;
}

export interface AnalyzeRangeMeanReversionInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  livePrice?: number | null;
  strategyOptions?: RangeMeanReversionOptions;
}

export interface RangeMeanReversionEvaluation {
  strategy: typeof RANGE_MEAN_REVERSION_STRATEGY_ID;
  strategyVersion:
    typeof RANGE_MEAN_REVERSION_STRATEGY_VERSION;
  direction: 'long';
  status: RangeMeanReversionStatus;

  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;

  conditions: RangeMeanReversionCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;

  plan: RangeMeanReversionPlan | null;

  nextTrigger: string;
  summary: string;
  warnings: string[];
  educationalNotice: string;

  diagnostics: {
    ready: boolean;
    candleCount: number;
    requiredCandles: number;
    strategyRequiredCandles: number;
    missingCandles: number;
    volatilityRegime: VolatilityRegime;
    volatilityPercentile: number | null;
    relativeVolume: number | null;
    rangeHigh: number | null;
    rangeLow: number | null;
    rangeMidpoint: number | null;
    rangeWidthAtr: number | null;
    meanReference: number | null;
    standardDeviation: number | null;
    zScore: number | null;
    slowEmaSlopeAtrPerCandle: number | null;
    fastMediumEmaSpreadAtr: number | null;
    supportDistanceAtr: number | null;
    stopDistanceAtr: number | null;
  };
}

// -----------------------------------------------------------------------------
// Configuração e validação
// -----------------------------------------------------------------------------

const RANGE_MEAN_REVERSION_DEFAULT_OPTIONS: ResolvedRangeMeanReversionOptions = {
  rangeLookback: 30,
  meanLookback: 20,
  maximumSlowEmaSlopeAtrPerCandle: 0.03,
  maximumFastMediumEmaSpreadAtr: 0.75,
  minimumRangeWidthAtr: 2,
  maximumRangeWidthAtr: 8,
  maximumEntryZScore: -1,
  maximumSupportDistanceAtr: 0.75,
  minimumRelativeVolume: 0.5,
  maximumRelativeVolume: 2.5,
  atrStopMultiple: 1,
  structuralStopBufferAtr: 0.15,
  minimumRiskRewardRatio: 2,
  maximumLateEntryDistanceAtr: 0.3,
  minimumStopDistanceAtr: 0.35,
  maximumStopDistanceAtr: 2.5,
  blockedVolatilityRegimes: ['extremo', 'indisponível'],
};

function positiveRangeMeanReversionNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número maior que zero.`);
  }

  return value;
}

function nonNegativeRangeMeanReversionNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} deve ser um número maior ou igual a zero.`,
    );
  }

  return value;
}

function finiteRangeMeanReversionNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} deve ser um número válido.`);
  }

  return value;
}

function positiveRangeMeanReversionInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} deve ser um número inteiro maior que zero.`,
    );
  }

  return value;
}

export function resolveRangeMeanReversionOptions(
  options: RangeMeanReversionOptions = {},
): ResolvedRangeMeanReversionOptions {
  const resolved: ResolvedRangeMeanReversionOptions = {
    rangeLookback: positiveRangeMeanReversionInteger(
      options.rangeLookback ?? RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.rangeLookback,
      'rangeLookback',
    ),
    meanLookback: positiveRangeMeanReversionInteger(
      options.meanLookback ?? RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.meanLookback,
      'meanLookback',
    ),
    maximumSlowEmaSlopeAtrPerCandle: nonNegativeRangeMeanReversionNumber(
      options.maximumSlowEmaSlopeAtrPerCandle ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumSlowEmaSlopeAtrPerCandle,
      'maximumSlowEmaSlopeAtrPerCandle',
    ),
    maximumFastMediumEmaSpreadAtr: nonNegativeRangeMeanReversionNumber(
      options.maximumFastMediumEmaSpreadAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumFastMediumEmaSpreadAtr,
      'maximumFastMediumEmaSpreadAtr',
    ),
    minimumRangeWidthAtr: positiveRangeMeanReversionNumber(
      options.minimumRangeWidthAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.minimumRangeWidthAtr,
      'minimumRangeWidthAtr',
    ),
    maximumRangeWidthAtr: positiveRangeMeanReversionNumber(
      options.maximumRangeWidthAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumRangeWidthAtr,
      'maximumRangeWidthAtr',
    ),
    maximumEntryZScore: finiteRangeMeanReversionNumber(
      options.maximumEntryZScore ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumEntryZScore,
      'maximumEntryZScore',
    ),
    maximumSupportDistanceAtr: nonNegativeRangeMeanReversionNumber(
      options.maximumSupportDistanceAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumSupportDistanceAtr,
      'maximumSupportDistanceAtr',
    ),
    minimumRelativeVolume: nonNegativeRangeMeanReversionNumber(
      options.minimumRelativeVolume ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    maximumRelativeVolume: positiveRangeMeanReversionNumber(
      options.maximumRelativeVolume ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumRelativeVolume,
      'maximumRelativeVolume',
    ),
    atrStopMultiple: positiveRangeMeanReversionNumber(
      options.atrStopMultiple ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.atrStopMultiple,
      'atrStopMultiple',
    ),
    structuralStopBufferAtr: nonNegativeRangeMeanReversionNumber(
      options.structuralStopBufferAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.structuralStopBufferAtr,
      'structuralStopBufferAtr',
    ),
    minimumRiskRewardRatio: positiveRangeMeanReversionNumber(
      options.minimumRiskRewardRatio ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.minimumRiskRewardRatio,
      'minimumRiskRewardRatio',
    ),
    maximumLateEntryDistanceAtr: nonNegativeRangeMeanReversionNumber(
      options.maximumLateEntryDistanceAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumLateEntryDistanceAtr,
      'maximumLateEntryDistanceAtr',
    ),
    minimumStopDistanceAtr: positiveRangeMeanReversionNumber(
      options.minimumStopDistanceAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.minimumStopDistanceAtr,
      'minimumStopDistanceAtr',
    ),
    maximumStopDistanceAtr: positiveRangeMeanReversionNumber(
      options.maximumStopDistanceAtr ??
        RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.maximumStopDistanceAtr,
      'maximumStopDistanceAtr',
    ),
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ??
      RANGE_MEAN_REVERSION_DEFAULT_OPTIONS.blockedVolatilityRegimes,
  };

  if (resolved.rangeLookback < 10) {
    throw new Error('rangeLookback deve ser pelo menos 10.');
  }

  if (resolved.meanLookback < 5) {
    throw new Error('meanLookback deve ser pelo menos 5.');
  }

  if (
    resolved.minimumRangeWidthAtr >=
    resolved.maximumRangeWidthAtr
  ) {
    throw new Error(
      'minimumRangeWidthAtr deve ser menor que maximumRangeWidthAtr.',
    );
  }

  if (
    resolved.minimumRelativeVolume >=
    resolved.maximumRelativeVolume
  ) {
    throw new Error(
      'minimumRelativeVolume deve ser menor que maximumRelativeVolume.',
    );
  }

  if (
    resolved.minimumStopDistanceAtr >=
    resolved.maximumStopDistanceAtr
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

// -----------------------------------------------------------------------------
// Utilitários internos
// -----------------------------------------------------------------------------

interface RangeMeanReversionMetrics {
  rangeHigh: number;
  rangeLow: number;
  rangeMidpoint: number;
  rangeWidth: number;
  rangeWidthAtr: number;
  meanReference: number;
  standardDeviation: number;
  zScore: number;
  supportDistanceAtr: number;
  slowEmaSlopeAtrPerCandle: number;
  fastMediumEmaSpreadAtr: number;
}

function isFinitePositiveRangeMeanReversion(value: number | null): value is number {
  return (
    value !== null &&
    Number.isFinite(value) &&
    value > 0
  );
}

function averageRangeMeanReversion(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

function sampleStandardDeviationRangeMeanReversion(
  values: readonly number[],
): number | null {
  if (values.length < 2) return null;

  const mean = averageRangeMeanReversion(values);
  if (mean === null) return null;

  const variance =
    values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) /
    (values.length - 1);

  return Math.sqrt(variance);
}

function formatRangeMeanReversionNumber(
  value: number,
  maximumFractionDigits = 8,
): string {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function formatRangeMeanReversionPct(
  value: number,
  fractionDigits = 2,
): string {
  return `${new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}%`;
}

function rangeMeanReversionCondition(
  value: Omit<
    RangeMeanReversionCondition,
    'available'
  > & {
    available?: boolean;
  },
): RangeMeanReversionCondition {
  return {
    ...value,
    available: value.available ?? true,
  };
}

function getRangeMeanReversionRequiredCandleCount(
  options: ResolvedRangeMeanReversionOptions,
): number {
  return Math.max(
    options.rangeLookback + 1,
    options.meanLookback + 1,
  );
}

function calculateRangeMeanReversionMetrics(
  candles: readonly DayTradeCandle[],
  indicators: DayTradeIndicators,
  options: ResolvedRangeMeanReversionOptions,
): RangeMeanReversionMetrics | null {
  const atr = indicators.atr;

  if (!isFinitePositiveRangeMeanReversion(atr)) {
    return null;
  }

  const required =
    getRangeMeanReversionRequiredCandleCount(options);

  if (candles.length < required) {
    return null;
  }

  const currentIndex = candles.length - 1;

  const rangeCandles = candles.slice(
    currentIndex - options.rangeLookback,
    currentIndex,
  );

  const meanCandles = candles.slice(
    currentIndex - options.meanLookback + 1,
    currentIndex + 1,
  );

  if (
    rangeCandles.length !== options.rangeLookback ||
    meanCandles.length !== options.meanLookback
  ) {
    return null;
  }

  const rangeHigh = Math.max(
    ...rangeCandles.map((candle) => candle.high),
  );
  const rangeLow = Math.min(
    ...rangeCandles.map((candle) => candle.low),
  );
  const rangeWidth = rangeHigh - rangeLow;

  const closes = meanCandles.map(
    (candle) => candle.close,
  );
  const meanReference = averageRangeMeanReversion(closes);
  const standardDeviation =
    sampleStandardDeviationRangeMeanReversion(closes);

  if (
    meanReference === null ||
    standardDeviation === null ||
    standardDeviation <= 0 ||
    rangeWidth <= 0
  ) {
    return null;
  }

  const currentPrice =
    candles[currentIndex].close;

  const currentPoint =
    indicators.series[indicators.series.length - 1];
  const previousSlopePoint =
    indicators.series[
      Math.max(0, indicators.series.length - 4)
    ];

  if (
    !currentPoint ||
    !previousSlopePoint ||
    !isFinitePositiveRangeMeanReversion(currentPoint.emaSlow) ||
    !isFinitePositiveRangeMeanReversion(previousSlopePoint.emaSlow) ||
    !isFinitePositiveRangeMeanReversion(indicators.emaFast) ||
    !isFinitePositiveRangeMeanReversion(indicators.emaMedium)
  ) {
    return null;
  }

  const slopePeriods = Math.max(
    1,
    indicators.series.length - 1 -
      Math.max(0, indicators.series.length - 4),
  );

  const slowEmaSlopeAtrPerCandle =
    Math.abs(
      currentPoint.emaSlow -
        previousSlopePoint.emaSlow,
    ) /
    atr /
    slopePeriods;

  return {
    rangeHigh,
    rangeLow,
    rangeMidpoint:
      rangeLow + rangeWidth / 2,
    rangeWidth,
    rangeWidthAtr: rangeWidth / atr,
    meanReference,
    standardDeviation,
    zScore:
      (currentPrice - meanReference) /
      standardDeviation,
    supportDistanceAtr:
      (currentPrice - rangeLow) / atr,
    slowEmaSlopeAtrPerCandle,
    fastMediumEmaSpreadAtr:
      Math.abs(
        indicators.emaFast -
          indicators.emaMedium,
      ) / atr,
  };
}

function createRangeMeanReversionPlan(
  currentCandle: DayTradeCandle,
  indicators: DayTradeIndicators,
  metrics: RangeMeanReversionMetrics | null,
  options: ResolvedRangeMeanReversionOptions,
): RangeMeanReversionPlan | null {
  const atr = indicators.atr;
  const emaFast = indicators.emaFast;
  const emaMedium = indicators.emaMedium;
  const emaSlow = indicators.emaSlow;

  if (
    metrics === null ||
    !isFinitePositiveRangeMeanReversion(atr) ||
    !isFinitePositiveRangeMeanReversion(emaFast) ||
    !isFinitePositiveRangeMeanReversion(emaMedium) ||
    !isFinitePositiveRangeMeanReversion(emaSlow)
  ) {
    return null;
  }

  const entryReference =
    currentCandle.close;

  const structuralStopCandidate =
    metrics.rangeLow -
    atr * options.structuralStopBufferAtr;

  const atrStopCandidate =
    entryReference -
    atr * options.atrStopMultiple;

  /*
   * Usa o stop mais próximo entre o estrutural e o limite por ATR.
   * O plano só é válido quando o stop permanece abaixo do suporte da faixa.
   */
  const stopReference = Math.max(
    structuralStopCandidate,
    atrStopCandidate,
  );

  const targetReference =
    metrics.meanReference;

  if (
    !Number.isFinite(stopReference) ||
    stopReference <= 0 ||
    stopReference >= entryReference ||
    stopReference >= metrics.rangeLow ||
    !Number.isFinite(targetReference) ||
    targetReference <= entryReference
  ) {
    return null;
  }

  const riskPerUnit =
    entryReference - stopReference;
  const rewardPerUnit =
    targetReference - entryReference;

  if (
    riskPerUnit <= 0 ||
    rewardPerUnit <= 0
  ) {
    return null;
  }

  const stopDistanceAtr =
    riskPerUnit / atr;

  return {
    direction: 'long',
    entryReference,
    stopReference,
    targetReference,
    riskPerUnit,
    rewardPerUnit,
    riskRewardRatio:
      rewardPerUnit / riskPerUnit,
    stopDistancePct:
      (riskPerUnit / entryReference) * 100,
    targetDistancePct:
      (rewardPerUnit / entryReference) * 100,
    stopDistanceAtr,
    rangeHigh: metrics.rangeHigh,
    rangeLow: metrics.rangeLow,
    rangeMidpoint: metrics.rangeMidpoint,
    rangeWidth: metrics.rangeWidth,
    rangeWidthAtr: metrics.rangeWidthAtr,
    meanReference: metrics.meanReference,
    zScore: metrics.zScore,
    latestAcceptableEntry:
      entryReference +
      atr * options.maximumLateEntryDistanceAtr,
    structuralStopCandidate,
    atrStopCandidate,
    emaFast,
    emaMedium,
    emaSlow,
  };
}

function determineRangeMeanReversionNextTrigger(
  conditions: readonly RangeMeanReversionCondition[],
  indicators: DayTradeIndicators,
  metrics: RangeMeanReversionMetrics | null,
  plan: RangeMeanReversionPlan | null,
  status: RangeMeanReversionStatus,
  options: ResolvedRangeMeanReversionOptions,
): string {
  if (status === 'dados_insuficientes') {
    return 'Carregue mais candles encerrados para completar a faixa, a média e os indicadores.';
  }

  if (
    status === 'invalidado' &&
    plan
  ) {
    return `A faixa perdeu validade porque o preço atingiu ou ficou abaixo de ${formatRangeMeanReversionNumber(plan.stopReference)}.`;
  }

  if (
    status === 'entrada_atrasada' &&
    plan
  ) {
    return `Aguarde uma nova aproximação do suporte. O preço ultrapassou o limite de ${formatRangeMeanReversionNumber(plan.latestAcceptableEntry)}.`;
  }

  if (
    status === 'condicoes_atendidas' &&
    plan
  ) {
    return `O candle confirmou recuperação dentro da faixa, com alvo técnico na média em ${formatRangeMeanReversionNumber(plan.targetReference)}.`;
  }

  const firstFailed = conditions.find(
    (item) =>
      item.available && !item.passed,
  );

  switch (firstFailed?.id) {
    case 'mercado_lateral':
      return 'Aguarde a inclinação da EMA lenta e a distância entre as médias diminuírem.';

    case 'faixa_estavel':
      return metrics
        ? `Aguarde uma faixa entre ${formatRangeMeanReversionNumber(options.minimumRangeWidthAtr, 2)} e ${formatRangeMeanReversionNumber(options.maximumRangeWidthAtr, 2)} ATR sem perda do suporte.`
        : 'Aguarde histórico suficiente para medir a faixa.';

    case 'preco_em_desconto':
      return metrics
        ? `Aguarde o preço voltar para próximo de ${formatRangeMeanReversionNumber(metrics.rangeLow)} e atingir z-score de até ${formatRangeMeanReversionNumber(options.maximumEntryZScore, 2)}.`
        : 'Aguarde a definição da faixa e da média.';

    case 'recuperacao_confirmada':
      return 'Aguarde um candle positivo fechando acima do fechamento anterior e próximo da própria máxima.';

    case 'volume_compativel':
      return `Aguarde volume relativo entre ${formatRangeMeanReversionNumber(options.minimumRelativeVolume, 2)}× e ${formatRangeMeanReversionNumber(options.maximumRelativeVolume, 2)}×.`;

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado.';

    case 'plano_risco_retorno':
      return `Aguarde uma recuperação que permita alvo mínimo de ${formatRangeMeanReversionNumber(options.minimumRiskRewardRatio, 2)}R até a média da faixa.`;

    default:
      return 'Aguarde a conclusão conjunta das condições técnicas restantes.';
  }
}

function determineRangeMeanReversionSummary(
  status: RangeMeanReversionStatus,
  passed: number,
  total: number,
): string {
  switch (status) {
    case 'dados_insuficientes':
      return 'Ainda não há candles encerrados suficientes para medir a faixa e a média.';
    case 'aguardar':
      return `${passed} de ${total} condições foram atendidas. O cenário ainda não forma uma reversão à média válida.`;
    case 'observar':
      return `${passed} de ${total} condições foram atendidas. O preço está descontado dentro de uma faixa lateral.`;
    case 'condicoes_atendidas':
      return `${passed} de ${total} condições foram atendidas no candle encerrado mais recente.`;
    case 'entrada_atrasada':
      return 'A recuperação foi confirmada, mas o preço ao vivo já se afastou demais da entrada.';
    case 'invalidado':
      return 'A recuperação chegou a ser confirmada, mas o preço ao vivo perdeu o nível de invalidação.';
  }
}

// -----------------------------------------------------------------------------
// Avaliação principal
// -----------------------------------------------------------------------------

export function evaluateRangeMeanReversion(
  input: EvaluateRangeMeanReversionInput,
): RangeMeanReversionEvaluation {
  const options =
    resolveRangeMeanReversionOptions(
      input.options,
    );

  const candles =
    normalizeClosedCandles(
      input.candles,
    );

  if (candles.length === 0) {
    throw new Error(
      'É necessário informar pelo menos um candle encerrado para avaliar o playbook.',
    );
  }

  const currentCandle =
    candles[candles.length - 1];

  const previousCandle =
    candles.length >= 2
      ? candles[candles.length - 2]
      : null;

  const indicators =
    input.indicators;

  if (
    currentCandle.openTime !==
      indicators.currentCandleOpenTime ||
    currentCandle.closeTime !==
      indicators.currentCandleCloseTime
  ) {
    throw new Error(
      'Os indicadores e os candles não estão alinhados no mesmo candle encerrado.',
    );
  }

  const livePrice =
    input.livePrice === null ||
    input.livePrice === undefined
      ? null
      : positiveRangeMeanReversionNumber(
          input.livePrice,
          'livePrice',
        );

  const requiredByStrategy =
    getRangeMeanReversionRequiredCandleCount(
      options,
    );

  const strategyMissingCandles =
    Math.max(
      0,
      requiredByStrategy -
        candles.length,
    );

  const strategyReady =
    strategyMissingCandles === 0;

  const metrics =
    calculateRangeMeanReversionMetrics(
      candles,
      indicators,
      options,
    );

  const plan =
    createRangeMeanReversionPlan(
      currentCandle,
      indicators,
      metrics,
      options,
    );

  const lateralAvailable =
    metrics !== null;

  const rangeAvailable =
    metrics !== null;

  const discountAvailable =
    metrics !== null;

  const recoveryAvailable =
    previousCandle !== null;

  const volumeAvailable =
    indicators.relativeVolume !== null &&
    Number.isFinite(
      indicators.relativeVolume,
    );

  const volatilityAvailable =
    indicators.volatilityRegime !==
    'indisponível';

  const lateralMarket =
    metrics !== null &&
    metrics.slowEmaSlopeAtrPerCandle <=
      options.maximumSlowEmaSlopeAtrPerCandle &&
    metrics.fastMediumEmaSpreadAtr <=
      options.maximumFastMediumEmaSpreadAtr;

  const stableRange =
    metrics !== null &&
    metrics.rangeWidthAtr >=
      options.minimumRangeWidthAtr &&
    metrics.rangeWidthAtr <=
      options.maximumRangeWidthAtr &&
    currentCandle.close >
      metrics.rangeLow;

  const discountedPrice =
    metrics !== null &&
    metrics.zScore <=
      options.maximumEntryZScore &&
    metrics.supportDistanceAtr >= 0 &&
    metrics.supportDistanceAtr <=
      options.maximumSupportDistanceAtr;

  const candleRange =
    currentCandle.high -
    currentCandle.low;

  const closeLocation =
    candleRange > 0
      ? (
          currentCandle.close -
          currentCandle.low
        ) /
        candleRange
      : 0;

  const recoveryConfirmed =
    previousCandle !== null &&
    currentCandle.close >
      currentCandle.open &&
    currentCandle.close >
      previousCandle.close &&
    closeLocation >= 0.6;

  const volumeCompatible =
    volumeAvailable &&
    (indicators.relativeVolume as number) >=
      options.minimumRelativeVolume &&
    (indicators.relativeVolume as number) <=
      options.maximumRelativeVolume;

  const volatilityCompatible =
    volatilityAvailable &&
    !options.blockedVolatilityRegimes.includes(
      indicators.volatilityRegime,
    );

  const stopDistanceValid =
    plan !== null &&
    plan.stopDistanceAtr >=
      options.minimumStopDistanceAtr &&
    plan.stopDistanceAtr <=
      options.maximumStopDistanceAtr;

  const riskRewardValid =
    plan !== null &&
    plan.riskRewardRatio >=
      options.minimumRiskRewardRatio;

  const conditions: RangeMeanReversionCondition[] =
    [
      rangeMeanReversionCondition({
        id: 'mercado_lateral',
        label:
          'Mercado sem tendência forte',
        available:
          lateralAvailable,
        passed:
          lateralMarket,
        currentValue:
          metrics === null
            ? null
            : `${formatRangeMeanReversionNumber(metrics.slowEmaSlopeAtrPerCandle, 3)} ATR/candle · ${formatRangeMeanReversionNumber(metrics.fastMediumEmaSpreadAtr, 2)} ATR`,
        requiredValue:
          `Inclinação ≤ ${formatRangeMeanReversionNumber(options.maximumSlowEmaSlopeAtrPerCandle, 3)} e distância EMA20/50 ≤ ${formatRangeMeanReversionNumber(options.maximumFastMediumEmaSpreadAtr, 2)} ATR`,
        explanation:
          metrics === null
            ? 'Ainda não há dados suficientes para medir lateralidade.'
            : lateralMarket
              ? 'A EMA lenta está quase plana e as médias rápidas estão próximas.'
              : 'A inclinação ou o afastamento das médias ainda indica tendência forte.',
      }),

      rangeMeanReversionCondition({
        id: 'faixa_estavel',
        label:
          'Faixa recente estável',
        available:
          rangeAvailable,
        passed:
          stableRange,
        currentValue:
          metrics === null
            ? null
            : `${formatRangeMeanReversionNumber(metrics.rangeWidthAtr, 2)} ATR · ${formatRangeMeanReversionNumber(metrics.rangeLow)}–${formatRangeMeanReversionNumber(metrics.rangeHigh)}`,
        requiredValue:
          `Largura entre ${formatRangeMeanReversionNumber(options.minimumRangeWidthAtr, 2)} e ${formatRangeMeanReversionNumber(options.maximumRangeWidthAtr, 2)} ATR`,
        explanation:
          metrics === null
            ? 'Ainda não há histórico suficiente para medir a faixa.'
            : stableRange
              ? 'A amplitude recente está dentro dos limites e o suporte continua preservado.'
              : 'A faixa está estreita demais, ampla demais ou o preço perdeu o suporte.',
      }),

      rangeMeanReversionCondition({
        id: 'preco_em_desconto',
        label:
          'Preço descontado perto do suporte',
        available:
          discountAvailable,
        passed:
          discountedPrice,
        currentValue:
          metrics === null
            ? null
            : `z ${formatRangeMeanReversionNumber(metrics.zScore, 2)} · ${formatRangeMeanReversionNumber(metrics.supportDistanceAtr, 2)} ATR do suporte`,
        requiredValue:
          `z-score ≤ ${formatRangeMeanReversionNumber(options.maximumEntryZScore, 2)} e distância ≤ ${formatRangeMeanReversionNumber(options.maximumSupportDistanceAtr, 2)} ATR`,
        explanation:
          metrics === null
            ? 'A média, o desvio-padrão e o suporte ainda não estão disponíveis.'
            : discountedPrice
              ? 'O preço está abaixo da média e próximo da parte inferior da faixa.'
              : 'O preço ainda não está suficientemente descontado ou está longe do suporte.',
      }),

      rangeMeanReversionCondition({
        id: 'recuperacao_confirmada',
        label:
          'Recuperação confirmada no candle',
        available:
          recoveryAvailable,
        passed:
          recoveryConfirmed,
        currentValue:
          recoveryAvailable
            ? `${formatRangeMeanReversionNumber(currentCandle.open)} → ${formatRangeMeanReversionNumber(currentCandle.close)}`
            : null,
        requiredValue:
          'Candle positivo, acima do fechamento anterior e próximo da máxima',
        explanation:
          !recoveryAvailable
            ? 'É necessário pelo menos um candle anterior.'
            : recoveryConfirmed
              ? 'O candle confirmou reação compradora dentro da faixa.'
              : 'O candle ainda não confirmou reação compradora suficiente.',
      }),

      rangeMeanReversionCondition({
        id: 'volume_compativel',
        label:
          'Volume compatível com reversão',
        available:
          volumeAvailable,
        passed:
          volumeCompatible,
        currentValue:
          indicators.relativeVolume,
        requiredValue:
          `${formatRangeMeanReversionNumber(options.minimumRelativeVolume, 2)}× a ${formatRangeMeanReversionNumber(options.maximumRelativeVolume, 2)}× a média`,
        explanation:
          !volumeAvailable
            ? 'O volume relativo ainda não está disponível.'
            : volumeCompatible
              ? 'O volume está suficiente para confirmar reação sem caracterizar expansão extrema.'
              : 'O volume está fraco demais ou elevado demais para este playbook.',
      }),

      rangeMeanReversionCondition({
        id: 'volatilidade_aceitavel',
        label:
          'Volatilidade fora do regime bloqueado',
        available:
          volatilityAvailable,
        passed:
          volatilityCompatible,
        currentValue:
          indicators.volatilityRegime,
        requiredValue:
          `Fora de: ${options.blockedVolatilityRegimes.join(', ')}`,
        explanation:
          indicators.volatilityRegime ===
          'indisponível'
            ? 'Ainda não há histórico suficiente para classificar a volatilidade.'
            : volatilityCompatible
              ? `A volatilidade está em regime ${indicators.volatilityRegime}, permitido pela estratégia.`
              : `A volatilidade está em regime ${indicators.volatilityRegime}, bloqueado pela estratégia.`,
      }),

      rangeMeanReversionCondition({
        id: 'plano_risco_retorno',
        label:
          'Plano com retorno até a média',
        available:
          plan !== null,
        passed:
          stopDistanceValid &&
          riskRewardValid,
        currentValue:
          plan === null
            ? null
            : `${formatRangeMeanReversionNumber(plan.stopDistanceAtr, 2)} ATR · ${formatRangeMeanReversionNumber(plan.riskRewardRatio, 2)}R`,
        requiredValue:
          `${formatRangeMeanReversionNumber(options.minimumStopDistanceAtr, 2)}–${formatRangeMeanReversionNumber(options.maximumStopDistanceAtr, 2)} ATR e alvo ≥ ${formatRangeMeanReversionNumber(options.minimumRiskRewardRatio, 2)}R`,
        explanation:
          plan === null
            ? 'Não foi possível montar stop abaixo da faixa e alvo acima da entrada.'
            : !stopDistanceValid
              ? `O stop ficaria a ${formatRangeMeanReversionNumber(plan.stopDistanceAtr, 2)} ATR, fora do intervalo permitido.`
              : !riskRewardValid
                ? `O retorno até a média seria de apenas ${formatRangeMeanReversionNumber(plan.riskRewardRatio, 2)}R.`
                : `O alvo na média oferece ${formatRangeMeanReversionNumber(plan.riskRewardRatio, 2)} vezes o risco.`,
      }),
    ];

  const passedConditions =
    conditions.filter(
      (item) => item.passed,
    ).length;

  const totalConditions =
    conditions.length;

  const ready =
    indicators.ready &&
    strategyReady &&
    previousCandle !== null;

  const allConditionsMet =
    ready &&
    passedConditions ===
      totalConditions;

  const nearSetup =
    lateralMarket &&
    stableRange &&
    metrics !== null &&
    metrics.supportDistanceAtr <=
      options.maximumSupportDistanceAtr +
        0.25 &&
    metrics.zScore <=
      options.maximumEntryZScore +
        0.35;

  const liveInvalidated =
    allConditionsMet &&
    plan !== null &&
    livePrice !== null &&
    livePrice <=
      plan.stopReference;

  const liveEntryLate =
    allConditionsMet &&
    plan !== null &&
    livePrice !== null &&
    livePrice >
      plan.latestAcceptableEntry;

  let status: RangeMeanReversionStatus;

  if (!ready) {
    status =
      'dados_insuficientes';
  } else if (liveInvalidated) {
    status =
      'invalidado';
  } else if (liveEntryLate) {
    status =
      'entrada_atrasada';
  } else if (allConditionsMet) {
    status =
      'condicoes_atendidas';
  } else if (
    nearSetup &&
    passedConditions >= 4
  ) {
    status =
      'observar';
  } else {
    status =
      'aguardar';
  }

  const warnings: string[] = [];

  if (!indicators.ready) {
    warnings.push(
      `Faltam ${indicators.missingCandles} candle(s) encerrado(s) para completar os indicadores.`,
    );
  }

  if (
    strategyMissingCandles > 0
  ) {
    warnings.push(
      `Faltam ${strategyMissingCandles} candle(s) para completar as janelas de faixa e média.`,
    );
  }

  if (
    indicators.volatilityRegime ===
    'extremo'
  ) {
    warnings.push(
      'A volatilidade está no regime extremo do próprio histórico analisado.',
    );
  }

  if (
    metrics !== null &&
    metrics.slowEmaSlopeAtrPerCandle >
      options.maximumSlowEmaSlopeAtrPerCandle
  ) {
    warnings.push(
      'A EMA lenta ainda possui inclinação excessiva para uma estratégia de reversão à média.',
    );
  }

  if (
    metrics !== null &&
    metrics.fastMediumEmaSpreadAtr >
      options.maximumFastMediumEmaSpreadAtr
  ) {
    warnings.push(
      'As médias rápida e intermediária estão afastadas demais para caracterizar lateralidade.',
    );
  }

  if (
    metrics !== null &&
    metrics.zScore >
      options.maximumEntryZScore
  ) {
    warnings.push(
      'O preço ainda não está suficientemente abaixo da média recente.',
    );
  }

  if (
    metrics !== null &&
    metrics.supportDistanceAtr >
      options.maximumSupportDistanceAtr
  ) {
    warnings.push(
      'O preço ainda está distante demais do suporte da faixa.',
    );
  }

  if (
    indicators.relativeVolume !== null &&
    indicators.relativeVolume >
      options.maximumRelativeVolume
  ) {
    warnings.push(
      'O volume relativo está alto e pode indicar rompimento, não reversão dentro da faixa.',
    );
  }

  if (
    plan &&
    !stopDistanceValid
  ) {
    warnings.push(
      `A invalidação ficaria a ${formatRangeMeanReversionNumber(plan.stopDistanceAtr, 2)} ATR da entrada, fora do limite configurado.`,
    );
  }

  if (
    plan &&
    !riskRewardValid
  ) {
    warnings.push(
      `O retorno disponível até a média seria de ${formatRangeMeanReversionNumber(plan.riskRewardRatio, 2)}R, abaixo do mínimo configurado.`,
    );
  }

  if (
    liveEntryLate &&
    plan &&
    livePrice !== null
  ) {
    warnings.push(
      `O preço ao vivo está ${formatRangeMeanReversionPct(((livePrice - plan.entryReference) / plan.entryReference) * 100)} acima da entrada de referência.`,
    );
  }

  if (
    liveInvalidated &&
    plan
  ) {
    warnings.push(
      `O preço ao vivo atingiu ou perdeu a invalidação em ${formatRangeMeanReversionNumber(plan.stopReference)}.`,
    );
  }

  return {
    strategy:
      RANGE_MEAN_REVERSION_STRATEGY_ID,
    strategyVersion:
      RANGE_MEAN_REVERSION_STRATEGY_VERSION,
    direction:
      'long',
    status,

    candleOpenTime:
      currentCandle.openTime,
    candleCloseTime:
      currentCandle.closeTime,
    evaluatedPrice:
      currentCandle.close,
    livePrice,

    conditions,
    passedConditions,
    totalConditions,
    scorePct:
      (
        passedConditions /
        totalConditions
      ) * 100,
    allConditionsMet,

    plan,

    nextTrigger:
      determineRangeMeanReversionNextTrigger(
        conditions,
        indicators,
        metrics,
        plan,
        status,
        options,
      ),

    summary:
      determineRangeMeanReversionSummary(
        status,
        passedConditions,
        totalConditions,
      ),

    warnings,

    educationalNotice:
      RANGE_MEAN_REVERSION_EDUCATIONAL_NOTICE,

    diagnostics: {
      ready,
      candleCount:
        indicators.candleCount,
      requiredCandles:
        indicators.requiredCandles,
      strategyRequiredCandles:
        requiredByStrategy,
      missingCandles:
        Math.max(
          indicators.missingCandles,
          strategyMissingCandles,
        ),
      volatilityRegime:
        indicators.volatilityRegime,
      volatilityPercentile:
        indicators.volatilityPercentile,
      relativeVolume:
        indicators.relativeVolume,
      rangeHigh:
        metrics?.rangeHigh ?? null,
      rangeLow:
        metrics?.rangeLow ?? null,
      rangeMidpoint:
        metrics?.rangeMidpoint ?? null,
      rangeWidthAtr:
        metrics?.rangeWidthAtr ?? null,
      meanReference:
        metrics?.meanReference ?? null,
      standardDeviation:
        metrics?.standardDeviation ?? null,
      zScore:
        metrics?.zScore ?? null,
      slowEmaSlopeAtrPerCandle:
        metrics?.slowEmaSlopeAtrPerCandle ??
        null,
      fastMediumEmaSpreadAtr:
        metrics?.fastMediumEmaSpreadAtr ??
        null,
      supportDistanceAtr:
        metrics?.supportDistanceAtr ??
        null,
      stopDistanceAtr:
        plan?.stopDistanceAtr ?? null,
    },
  };
}

/**
 * Calcula os indicadores e avalia o playbook em uma única chamada.
 */
export function analyzeRangeMeanReversion(
  input: AnalyzeRangeMeanReversionInput,
): {
  indicators: DayTradeIndicators;
  evaluation: RangeMeanReversionEvaluation;
} {
  const indicators =
    calculateDayTradeIndicators(
      input.candles,
      input.indicatorOptions,
    );

  const evaluation =
    evaluateRangeMeanReversion({
      candles: input.candles,
      indicators,
      livePrice: input.livePrice,
      options: input.strategyOptions,
    });

  return {
    indicators,
    evaluation,
  };
}

// -----------------------------------------------------------------------------
// Rótulos prontos para interface
// -----------------------------------------------------------------------------

export const RANGE_MEAN_REVERSION_STATUS_LABELS: Record<
  RangeMeanReversionStatus,
  {
    label: string;
    shortDescription: string;
  }
> = {
  dados_insuficientes: {
    label:
      'Dados insuficientes',
    shortDescription:
      'Ainda faltam candles para medir a faixa e a média.',
  },

  aguardar: {
    label:
      'Aguardar',
    shortDescription:
      'O cenário atual ainda não forma uma reversão à média válida.',
  },

  observar: {
    label:
      'Observar',
    shortDescription:
      'O preço está descontado dentro de uma faixa lateral.',
  },

  condicoes_atendidas: {
    label:
      'Condições atendidas',
    shortDescription:
      'O último candle confirmou recuperação dentro da faixa.',
  },

  entrada_atrasada: {
    label:
      'Entrada atrasada',
    shortDescription:
      'O preço ao vivo já se afastou da entrada calculada.',
  },

  invalidado: {
    label:
      'Invalidado',
    shortDescription:
      'O preço perdeu o suporte e atingiu a invalidação.',
  },
};

// ============================================================================
// SEÇÃO 8: strategies/index.ts — registro central
// ============================================================================

/**
 * lib/daytrade/strategies/index.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Registro central dos playbooks disponíveis no módulo de Day Trade.
 *
 * Responsabilidades:
 * - Reexportar tipos, constantes e funções das estratégias.
 * - Expor metadados estáveis para interface, backtest e avaliadores.
 * - Definir explicitamente quais estratégias podem criar ordens.
 *
 * Regra de segurança atual:
 * - trend_breakout: autorizado para oportunidades e ordens Testnet.
 * - trend_pullback: somente observação e comparação.
 * - squeeze_breakout: somente observação e comparação.
 * - range_mean_reversion: somente observação e comparação.
 */

// -----------------------------------------------------------------------------
// Reexports
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Tipos do registro
// -----------------------------------------------------------------------------

export type DayTradeStrategyId =
  | typeof TREND_BREAKOUT_STRATEGY_ID
  | typeof TREND_PULLBACK_STRATEGY_ID
  | typeof SQUEEZE_BREAKOUT_STRATEGY_ID
  | typeof RANGE_MEAN_REVERSION_STRATEGY_ID;

export type DayTradeStrategyVersion =
  | typeof TREND_BREAKOUT_STRATEGY_VERSION
  | typeof TREND_PULLBACK_STRATEGY_VERSION
  | typeof SQUEEZE_BREAKOUT_STRATEGY_VERSION
  | typeof RANGE_MEAN_REVERSION_STRATEGY_VERSION;

export type DayTradeStrategyCategory =
  | 'trend_following'
  | 'mean_reversion';

export type DayTradeStrategyExecutionMode =
  | 'testnet_allowed'
  | 'shadow';

export type DayTradeMarketRegime =
  | 'tendência'
  | 'compressão'
  | 'lateralidade';

export interface DayTradeStrategyDefinition {
  id: DayTradeStrategyId;
  version: DayTradeStrategyVersion;

  label: string;
  shortLabel: string;
  description: string;

  category: DayTradeStrategyCategory;
  preferredRegimes: readonly DayTradeMarketRegime[];

  /**
   * testnet_allowed:
   * pode gerar oportunidade automática e chegar ao executor Testnet.
   *
   * shadow:
   * pode ser calculada, salva e comparada, mas não pode criar ordens.
   */
  executionMode: DayTradeStrategyExecutionMode;

  /**
   * Trava explícita para qualquer fluxo que possa criar oportunidade ou ordem.
   */
  authorizedForAutomaticOrders: boolean;

  /**
   * Permite exibir e executar backtest da estratégia.
   */
  enabledForBacktest: boolean;

  /**
   * Permite salvar avaliações históricas em daytrade_setups.
   */
  enabledForPersistence: boolean;

  /**
   * Ordem sugerida para apresentação na interface.
   */
  displayOrder: number;
}

// -----------------------------------------------------------------------------
// Registro
// -----------------------------------------------------------------------------

export const DEFAULT_DAYTRADE_STRATEGY_ID =
  TREND_BREAKOUT_STRATEGY_ID;

export const DAYTRADE_STRATEGY_REGISTRY = {
  [TREND_BREAKOUT_STRATEGY_ID]: {
    id: TREND_BREAKOUT_STRATEGY_ID,
    version: TREND_BREAKOUT_STRATEGY_VERSION,
    label: 'Tendência com rompimento',
    shortLabel: 'Trend Breakout',
    description:
      'Busca tendência positiva, alinhamento das médias, rompimento confirmado, volume e plano mínimo de risco e retorno.',
    category: 'trend_following',
    preferredRegimes: ['tendência'],
    executionMode: 'testnet_allowed',
    authorizedForAutomaticOrders: true,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 1,
  },

  [TREND_PULLBACK_STRATEGY_ID]: {
    id: TREND_PULLBACK_STRATEGY_ID,
    version: TREND_PULLBACK_STRATEGY_VERSION,
    label: 'Pullback na tendência',
    shortLabel: 'Trend Pullback',
    description:
      'Procura recuo controlado até a zona das médias e recuperação confirmada dentro de uma tendência positiva.',
    category: 'trend_following',
    preferredRegimes: ['tendência'],
    executionMode: 'shadow',
    authorizedForAutomaticOrders: false,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 2,
  },

  [SQUEEZE_BREAKOUT_STRATEGY_ID]: {
    id: SQUEEZE_BREAKOUT_STRATEGY_ID,
    version: SQUEEZE_BREAKOUT_STRATEGY_VERSION,
    label: 'Rompimento de compressão',
    shortLabel: 'Squeeze Breakout',
    description:
      'Procura redução de amplitude seguida por rompimento confirmado com expansão de volume.',
    category: 'trend_following',
    preferredRegimes: ['compressão', 'tendência'],
    executionMode: 'shadow',
    authorizedForAutomaticOrders: false,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 3,
  },

  [RANGE_MEAN_REVERSION_STRATEGY_ID]: {
    id: RANGE_MEAN_REVERSION_STRATEGY_ID,
    version: RANGE_MEAN_REVERSION_STRATEGY_VERSION,
    label: 'Reversão à média na faixa',
    shortLabel: 'Range Mean Reversion',
    description:
      'Procura preço descontado próximo ao suporte de uma faixa lateral, com recuperação em direção à média recente.',
    category: 'mean_reversion',
    preferredRegimes: ['lateralidade'],
    executionMode: 'shadow',
    authorizedForAutomaticOrders: false,
    enabledForBacktest: true,
    enabledForPersistence: true,
    displayOrder: 4,
  },
} as const satisfies Record<
  DayTradeStrategyId,
  DayTradeStrategyDefinition
>;

// -----------------------------------------------------------------------------
// Listas derivadas
// -----------------------------------------------------------------------------

export const DAYTRADE_STRATEGY_IDS = [
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_PULLBACK_STRATEGY_ID,
  SQUEEZE_BREAKOUT_STRATEGY_ID,
  RANGE_MEAN_REVERSION_STRATEGY_ID,
] as const satisfies readonly DayTradeStrategyId[];

export const EXECUTABLE_DAYTRADE_STRATEGY_IDS =
  DAYTRADE_STRATEGY_IDS.filter(
    (strategyId) =>
      DAYTRADE_STRATEGY_REGISTRY[strategyId]
        .authorizedForAutomaticOrders,
  );

export const SHADOW_DAYTRADE_STRATEGY_IDS =
  DAYTRADE_STRATEGY_IDS.filter(
    (strategyId) =>
      !DAYTRADE_STRATEGY_REGISTRY[strategyId]
        .authorizedForAutomaticOrders,
  );

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function isDayTradeStrategyId(
  value: unknown,
): value is DayTradeStrategyId {
  return (
    typeof value === 'string' &&
    DAYTRADE_STRATEGY_IDS.includes(
      value as DayTradeStrategyId,
    )
  );
}

export function assertDayTradeStrategyId(
  value: unknown,
): DayTradeStrategyId {
  if (!isDayTradeStrategyId(value)) {
    throw new Error(
      `Estratégia inválida. Valores aceitos: ${DAYTRADE_STRATEGY_IDS.join(', ')}.`,
    );
  }

  return value;
}

export function getDayTradeStrategyDefinition(
  strategyId: DayTradeStrategyId,
): DayTradeStrategyDefinition {
  return DAYTRADE_STRATEGY_REGISTRY[strategyId];
}

export function isDayTradeStrategyAuthorizedForOrders(
  strategyId: DayTradeStrategyId,
): boolean {
  return DAYTRADE_STRATEGY_REGISTRY[strategyId]
    .authorizedForAutomaticOrders;
}

export function listDayTradeStrategyDefinitions(
  options: {
    includeShadow?: boolean;
    onlyBacktestEnabled?: boolean;
    onlyPersistenceEnabled?: boolean;
  } = {},
): DayTradeStrategyDefinition[] {
  const {
    includeShadow = true,
    onlyBacktestEnabled = false,
    onlyPersistenceEnabled = false,
  } = options;

  return DAYTRADE_STRATEGY_IDS
    .map(
      (strategyId) =>
        DAYTRADE_STRATEGY_REGISTRY[strategyId],
    )
    .filter(
      (strategy) =>
        includeShadow ||
        strategy.executionMode !== 'shadow',
    )
    .filter(
      (strategy) =>
        !onlyBacktestEnabled ||
        strategy.enabledForBacktest,
    )
    .filter(
      (strategy) =>
        !onlyPersistenceEnabled ||
        strategy.enabledForPersistence,
    )
    .sort(
      (left, right) =>
        left.displayOrder - right.displayOrder,
    );
}

// ============================================================================
// SEÇÃO 9: strategies/backtestAdapter.ts
// ============================================================================

/**
 * lib/daytrade/strategies/backtestAdapter.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Adaptador comum entre o motor de backtest e os quatro playbooks.
 *
 * Objetivos:
 * - permitir seleção da estratégia por ID;
 * - manter um único contrato de avaliação e plano;
 * - resolver o aquecimento adicional exigido por cada estratégia;
 * - impedir que regras de execução automática contaminem o backtest;
 * - facilitar a migração gradual do backtest originalmente fixo em
 *   trend_breakout para um motor multiestratégia.
 */

// -----------------------------------------------------------------------------
// Mapas tipados
// -----------------------------------------------------------------------------

export interface DayTradeBacktestStrategyOptionsMap {
  trend_breakout: TrendBreakoutOptions;
  trend_pullback: TrendPullbackOptions;
  squeeze_breakout: SqueezeBreakoutOptions;
  range_mean_reversion: RangeMeanReversionOptions;
}

export interface DayTradeBacktestStrategyEvaluationMap {
  trend_breakout: TrendBreakoutEvaluation;
  trend_pullback: TrendPullbackEvaluation;
  squeeze_breakout: SqueezeBreakoutEvaluation;
  range_mean_reversion: RangeMeanReversionEvaluation;
}

export interface DayTradeBacktestStrategyPlanMap {
  trend_breakout: TrendBreakoutPlan;
  trend_pullback: TrendPullbackPlan;
  squeeze_breakout: SqueezeBreakoutPlan;
  range_mean_reversion: RangeMeanReversionPlan;
}

export type AnyDayTradeBacktestStrategyOptions =
  DayTradeBacktestStrategyOptionsMap[DayTradeStrategyId];

export type AnyDayTradeBacktestStrategyEvaluation =
  DayTradeBacktestStrategyEvaluationMap[DayTradeStrategyId];

export type AnyDayTradeBacktestStrategyPlan =
  DayTradeBacktestStrategyPlanMap[DayTradeStrategyId];

// -----------------------------------------------------------------------------
// Contratos comuns
// -----------------------------------------------------------------------------

export interface CommonDayTradeBacktestPlan {
  direction: 'long';

  entryReference: number;
  stopReference: number;
  targetReference: number;

  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;

  stopDistancePct: number;
  targetDistancePct: number;
  stopDistanceAtr: number;

  latestAcceptableEntry: number;
}

export interface CommonDayTradeBacktestEvaluation {
  strategy: DayTradeStrategyId;
  strategyVersion: string;
  direction: 'long';

  status:
    | 'dados_insuficientes'
    | 'aguardar'
    | 'observar'
    | 'condicoes_atendidas'
    | 'entrada_atrasada'
    | 'invalidado';

  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;

  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;

  plan: CommonDayTradeBacktestPlan | null;

  nextTrigger: string;
  summary: string;
  warnings: string[];
  educationalNotice: string;

  diagnostics: {
    ready: boolean;
    candleCount: number;
    requiredCandles: number;
    missingCandles: number;
    volatilityRegime: string;
    relativeVolume: number | null;
  };
}

export interface EvaluateBacktestStrategyInput<
  TStrategyId extends DayTradeStrategyId =
    DayTradeStrategyId,
> {
  strategyId: TStrategyId;
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;
  livePrice?: number | null;
  strategyOptions?: Partial<
    DayTradeBacktestStrategyOptionsMap
  >[TStrategyId];
}

export interface DayTradeBacktestStrategyDescriptor {
  id: DayTradeStrategyId;
  version: string;
  label: string;
  shortLabel: string;
  description: string;
  displayOrder: number;

  /**
   * Quantidade mínima de candles necessária considerando indicadores e regras
   * específicas do playbook.
   */
  requiredCandleCount: number;

  /**
   * Limite padrão entre a entrada de referência e a abertura seguinte.
   */
  defaultMaximumNextOpenDistanceAtr: number;
}

// -----------------------------------------------------------------------------
// Avaliação pelo ID
// -----------------------------------------------------------------------------

export function evaluateBacktestStrategy<
  TStrategyId extends DayTradeStrategyId,
>(
  input: EvaluateBacktestStrategyInput<TStrategyId>,
): DayTradeBacktestStrategyEvaluationMap[TStrategyId] {
  const {
    strategyId,
    candles,
    indicators,
    livePrice,
  } = input;

  switch (strategyId) {
    case 'trend_breakout':
      return evaluateTrendBreakout({
        candles,
        indicators,
        livePrice,
        options:
          input.strategyOptions as
            | TrendBreakoutOptions
            | undefined,
      }) as DayTradeBacktestStrategyEvaluationMap[TStrategyId];

    case 'trend_pullback':
      return evaluateTrendPullback({
        candles,
        indicators,
        livePrice,
        options:
          input.strategyOptions as
            | TrendPullbackOptions
            | undefined,
      }) as DayTradeBacktestStrategyEvaluationMap[TStrategyId];

    case 'squeeze_breakout':
      return evaluateSqueezeBreakout({
        candles,
        indicators,
        livePrice,
        options:
          input.strategyOptions as
            | SqueezeBreakoutOptions
            | undefined,
      }) as DayTradeBacktestStrategyEvaluationMap[TStrategyId];

    case 'range_mean_reversion':
      return evaluateRangeMeanReversion({
        candles,
        indicators,
        livePrice,
        options:
          input.strategyOptions as
            | RangeMeanReversionOptions
            | undefined,
      }) as DayTradeBacktestStrategyEvaluationMap[TStrategyId];

    default: {
      const exhaustiveCheck: never =
        strategyId;

      throw new Error(
        `Estratégia de backtest não implementada: ${String(exhaustiveCheck)}.`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Normalização para o motor genérico
// -----------------------------------------------------------------------------

export function toCommonBacktestEvaluation(
  evaluation: AnyDayTradeBacktestStrategyEvaluation,
): CommonDayTradeBacktestEvaluation {
  return {
    strategy: evaluation.strategy,
    strategyVersion:
      evaluation.strategyVersion,
    direction: evaluation.direction,
    status: evaluation.status,

    candleOpenTime:
      evaluation.candleOpenTime,
    candleCloseTime:
      evaluation.candleCloseTime,
    evaluatedPrice:
      evaluation.evaluatedPrice,
    livePrice: evaluation.livePrice,

    passedConditions:
      evaluation.passedConditions,
    totalConditions:
      evaluation.totalConditions,
    scorePct: evaluation.scorePct,
    allConditionsMet:
      evaluation.allConditionsMet,

    plan:
      evaluation.plan === null
        ? null
        : {
            direction:
              evaluation.plan.direction,

            entryReference:
              evaluation.plan.entryReference,
            stopReference:
              evaluation.plan.stopReference,
            targetReference:
              evaluation.plan.targetReference,

            riskPerUnit:
              evaluation.plan.riskPerUnit,
            rewardPerUnit:
              evaluation.plan.rewardPerUnit,
            riskRewardRatio:
              evaluation.plan.riskRewardRatio,

            stopDistancePct:
              evaluation.plan.stopDistancePct,
            targetDistancePct:
              evaluation.plan.targetDistancePct,
            stopDistanceAtr:
              evaluation.plan.stopDistanceAtr,

            latestAcceptableEntry:
              evaluation.plan
                .latestAcceptableEntry,
          },

    nextTrigger: evaluation.nextTrigger,
    summary: evaluation.summary,
    warnings: evaluation.warnings,
    educationalNotice:
      evaluation.educationalNotice,

    diagnostics: {
      ready:
        evaluation.diagnostics.ready,
      candleCount:
        evaluation.diagnostics.candleCount,
      requiredCandles:
        evaluation.diagnostics
          .requiredCandles,
      missingCandles:
        evaluation.diagnostics
          .missingCandles,
      volatilityRegime:
        evaluation.diagnostics
          .volatilityRegime,
      relativeVolume:
        evaluation.diagnostics
          .relativeVolume,
    },
  };
}

export function evaluateCommonBacktestStrategy(
  input: EvaluateBacktestStrategyInput,
): CommonDayTradeBacktestEvaluation {
  const evaluation =
    evaluateBacktestStrategy(input);

  return toCommonBacktestEvaluation(
    evaluation,
  );
}

// -----------------------------------------------------------------------------
// Elegibilidade de sinal
// -----------------------------------------------------------------------------

export function isBacktestEntrySignal(
  evaluation: CommonDayTradeBacktestEvaluation,
): boolean {
  return (
    evaluation.status ===
      'condicoes_atendidas' &&
    evaluation.allConditionsMet &&
    evaluation.plan !== null
  );
}

// -----------------------------------------------------------------------------
// Aquecimento por estratégia
// -----------------------------------------------------------------------------

export function getBacktestStrategyRequiredCandleCount(
  strategyId: DayTradeStrategyId,
  indicatorOptions: DayTradeIndicatorOptions,
  strategyOptions:
    Partial<DayTradeBacktestStrategyOptionsMap> = {},
): number {
  const indicatorRequired =
    getRequiredCandleCount(
      indicatorOptions,
    );

  switch (strategyId) {
    case 'trend_breakout':
      return indicatorRequired;

    case 'trend_pullback':
      return Math.max(
        indicatorRequired,
        2,
      );

    case 'squeeze_breakout': {
      const resolved =
        resolveSqueezeBreakoutOptions(
          strategyOptions
            .squeeze_breakout,
        );

      const strategyRequired =
        resolved.baselineLookback +
        resolved.compressionLookback +
        1;

      return Math.max(
        indicatorRequired,
        strategyRequired,
      );
    }

    case 'range_mean_reversion': {
      const resolved =
        resolveRangeMeanReversionOptions(
          strategyOptions
            .range_mean_reversion,
        );

      const strategyRequired =
        Math.max(
          resolved.rangeLookback + 1,
          resolved.meanLookback + 1,
        );

      return Math.max(
        indicatorRequired,
        strategyRequired,
      );
    }

    default: {
      const exhaustiveCheck: never =
        strategyId;

      throw new Error(
        `Estratégia inválida: ${String(exhaustiveCheck)}.`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Distância máxima da próxima abertura
// -----------------------------------------------------------------------------

export function getDefaultMaximumNextOpenDistanceAtr(
  strategyId: DayTradeStrategyId,
  strategyOptions:
    Partial<DayTradeBacktestStrategyOptionsMap> = {},
): number {
  switch (strategyId) {
    case 'trend_breakout':
      return resolveTrendBreakoutOptions(
        strategyOptions.trend_breakout,
      ).maximumLateEntryDistanceAtr;

    case 'trend_pullback':
      return resolveTrendPullbackOptions(
        strategyOptions.trend_pullback,
      ).maximumLateEntryDistanceAtr;

    case 'squeeze_breakout':
      return resolveSqueezeBreakoutOptions(
        strategyOptions.squeeze_breakout,
      ).maximumLateEntryDistanceAtr;

    case 'range_mean_reversion':
      return resolveRangeMeanReversionOptions(
        strategyOptions
          .range_mean_reversion,
      ).maximumLateEntryDistanceAtr;

    default: {
      const exhaustiveCheck: never =
        strategyId;

      throw new Error(
        `Estratégia inválida: ${String(exhaustiveCheck)}.`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Metadados para backtest e interface
// -----------------------------------------------------------------------------

export function getBacktestStrategyDescriptor(
  strategyId: DayTradeStrategyId,
  indicatorOptions: DayTradeIndicatorOptions,
  strategyOptions:
    Partial<DayTradeBacktestStrategyOptionsMap> = {},
): DayTradeBacktestStrategyDescriptor {
  const definition =
    DAYTRADE_STRATEGY_REGISTRY[
      strategyId
    ];

  return {
    id: definition.id,
    version: definition.version,
    label: definition.label,
    shortLabel:
      definition.shortLabel,
    description:
      definition.description,
    displayOrder:
      definition.displayOrder,

    requiredCandleCount:
      getBacktestStrategyRequiredCandleCount(
        strategyId,
        indicatorOptions,
        strategyOptions,
      ),

    defaultMaximumNextOpenDistanceAtr:
      getDefaultMaximumNextOpenDistanceAtr(
        strategyId,
        strategyOptions,
      ),
  };
}

// ============================================================================
// SEÇÃO 10: multiStrategyBacktest.ts
// ============================================================================

/**
 * lib/daytrade/multiStrategyBacktest.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Motor genérico de backtest para os quatro playbooks:
 *
 * - trend_breakout
 * - trend_pullback
 * - squeeze_breakout
 * - range_mean_reversion
 *
 * Princípios:
 * - utiliza somente candles encerrados;
 * - o sinal nasce no fechamento do candle de confirmação;
 * - a entrada é simulada na abertura do candle seguinte;
 * - não usa candles futuros para confirmar sinais;
 * - calcula a série de indicadores uma única vez;
 * - considera taxas, slippage, risco e saldo disponível;
 * - mantém somente uma posição aberta por vez;
 * - preserva o múltiplo de risco do plano ao ajustar a entrada;
 * - usa stop_first como prioridade intrabar conservadora por padrão.
 *
 * Este arquivo não consulta APIs, não grava no banco e não executa ordens.
 */

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type MultiStrategyBacktestIntrabarPriority =
  | 'stop_first'
  | 'target_first';

export type MultiStrategyBacktestExitReason =
  | 'stop'
  | 'target'
  | 'maximum_holding'
  | 'end_of_data';

export type MultiStrategyBacktestTradeResult =
  | 'win'
  | 'loss'
  | 'breakeven';

export type MultiStrategyBacktestSkippedSignalReason =
  | 'position_open'
  | 'no_next_candle'
  | 'entry_below_stop'
  | 'entry_above_reference_limit'
  | 'position_sizing_failed';

export interface MultiStrategyBacktestOptions {
  /** Patrimônio inicial da simulação. Padrão: 1.000 USDT. */
  initialCapitalUsdt?: number;

  /** Percentual do patrimônio arriscado por operação. Padrão: 1%. Máximo: 2%. */
  riskPercent?: number;

  /** Taxa estimada por execução. Padrão: 0,1%. */
  feeRatePct?: number;

  /** Slippage adversa estimada por execução. Padrão: 0,05%. */
  slippagePct?: number;

  /** Incremento mínimo usado no arredondamento da quantidade. */
  stepSize?: number;

  /** Quantidade mínima opcional. */
  minQuantity?: number;

  /** Nocional mínimo opcional. */
  minNotional?: number;

  /** Limite de nocional por posição. */
  maxPositionNotional?: number;

  /**
   * Prioridade quando o candle toca stop e alvo.
   * Padrão: stop_first.
   */
  intrabarPriority?: MultiStrategyBacktestIntrabarPriority;

  /**
   * Número máximo de candles após a entrada.
   * Zero desativa o encerramento por tempo.
   */
  maximumHoldingCandles?: number;

  /**
   * Distância máxima entre a abertura seguinte e a entrada de referência,
   * em múltiplos de ATR.
   *
   * Quando omitida, usa o limite padrão da estratégia selecionada.
   */
  maximumNextOpenDistanceAtr?: number;
}

export interface ResolvedMultiStrategyBacktestOptions {
  initialCapitalUsdt: number;
  riskPercent: number;
  feeRatePct: number;
  slippagePct: number;
  stepSize: number;
  minQuantity: number;
  minNotional: number;
  maxPositionNotional: number;
  intrabarPriority: MultiStrategyBacktestIntrabarPriority;
  maximumHoldingCandles: number;
  maximumNextOpenDistanceAtr: number;
}

export interface MultiStrategyBacktestInput {
  strategyId: DayTradeStrategyId;
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;

  /**
   * Opções isoladas por estratégia.
   *
   * Apenas a chave correspondente a strategyId será utilizada.
   */
  strategyOptions?: Partial<DayTradeBacktestStrategyOptionsMap>;

  backtestOptions?: MultiStrategyBacktestOptions;
}

export interface MultiStrategyBacktestSkippedSignal {
  strategy: DayTradeStrategyId;
  signalCandleOpenTime: number;
  signalCandleCloseTime: number;
  reason: MultiStrategyBacktestSkippedSignalReason;
  explanation: string;
}

export interface MultiStrategyBacktestTrade {
  id: number;

  strategy: DayTradeStrategyId;
  strategyVersion: string;
  direction: 'long';

  signalCandleOpenTime: number;
  signalCandleCloseTime: number;
  entryTime: number;
  exitTime: number;

  signalClose: number;
  plannedEntryReference: number;
  rawEntryPrice: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  rawExitPrice: number;
  exitPrice: number;

  quantity: number;
  entryNotional: number;
  initialRiskUsdt: number;

  entryFeeUsdt: number;
  exitFeeUsdt: number;
  totalFeesUsdt: number;
  grossPnlUsdt: number;
  netPnlUsdt: number;
  resultR: number;

  result: MultiStrategyBacktestTradeResult;
  exitReason: MultiStrategyBacktestExitReason;
  holdingCandles: number;

  signalScorePct: number;
  signalPassedConditions: number;
  signalTotalConditions: number;
  signalAtr: number;
  signalRelativeVolume: number | null;
  signalVolatilityRegime: string;

  equityBefore: number;
  equityAfter: number;
}

export interface MultiStrategyBacktestMetrics {
  initialCapitalUsdt: number;
  finalCapitalUsdt: number;
  netPnlUsdt: number;
  netReturnPct: number;

  signals: number;
  enteredTrades: number;
  skippedSignals: number;

  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;

  grossProfitUsdt: number;
  grossLossUsdt: number;
  profitFactor: number | null;

  averagePnlUsdt: number;
  averageR: number;
  medianR: number;
  bestR: number;
  worstR: number;

  maximumDrawdownUsdt: number;
  maximumDrawdownPct: number;

  averageHoldingCandles: number;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;

  exposurePct: number;
}

export interface MultiStrategyBacktestResult {
  strategy: DayTradeStrategyId;
  strategyVersion: string;
  strategyLabel: string;
  strategyShortLabel: string;

  assumptions: {
    signalTiming: 'candle_close';
    entryTiming: 'next_candle_open';
    onePositionAtATime: true;
    intrabarPriority: MultiStrategyBacktestIntrabarPriority;
    targetAdjustment:
      'preserve_signal_r_multiple_from_actual_next_open';
    costsIncluded: true;
    educationalOnly: true;
  };

  options: ResolvedMultiStrategyBacktestOptions;
  indicatorOptions: DayTradeIndicators['options'];
  strategyOptions: Partial<DayTradeBacktestStrategyOptionsMap>;

  candleCount: number;
  warmupCandles: number;
  testedCandleCount: number;
  firstCandleOpenTime: number;
  lastCandleCloseTime: number;

  metrics: MultiStrategyBacktestMetrics;
  trades: MultiStrategyBacktestTrade[];
  skippedSignals: MultiStrategyBacktestSkippedSignal[];

  equityCurve: Array<{
    time: number;
    equityUsdt: number;
    drawdownUsdt: number;
    drawdownPct: number;
  }>;

  warnings: string[];
  educationalNotice: string;
}

// -----------------------------------------------------------------------------
// Configuração
// -----------------------------------------------------------------------------

const MULTI_STRATEGY_BACKTEST_DEFAULTS = {
  initialCapitalUsdt: 1_000,
  riskPercent: 1,
  feeRatePct: 0.1,
  slippagePct: 0.05,
  stepSize: 0.00000001,
  minQuantity: 0,
  minNotional: 0,
  maxPositionNotional: Number.MAX_SAFE_INTEGER,
  intrabarPriority: 'stop_first',
  maximumHoldingCandles: 0,
} as const;

// -----------------------------------------------------------------------------
// Validação
// -----------------------------------------------------------------------------

function positiveBacktestNumber(
  value: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} deve ser maior que zero.`,
    );
  }

  return value;
}

function nonNegativeBacktestNumber(
  value: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} deve ser maior ou igual a zero.`,
    );
  }

  return value;
}

function nonNegativeBacktestInteger(
  value: number,
  name: string,
): number {
  if (
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `${name} deve ser um inteiro maior ou igual a zero.`,
    );
  }

  return value;
}

export function resolveMultiStrategyBacktestOptions(
  strategyId: DayTradeStrategyId,
  indicatorOptions: DayTradeIndicatorOptions,
  strategyOptions:
    Partial<DayTradeBacktestStrategyOptionsMap> = {},
  options: MultiStrategyBacktestOptions = {},
): ResolvedMultiStrategyBacktestOptions {
  const descriptor =
    getBacktestStrategyDescriptor(
      strategyId,
      indicatorOptions,
      strategyOptions,
    );

  const riskPercent =
    positiveBacktestNumber(
      options.riskPercent ??
        MULTI_STRATEGY_BACKTEST_DEFAULTS
          .riskPercent,
      'riskPercent',
    );

  if (riskPercent > 2) {
    throw new Error(
      'riskPercent não pode ultrapassar 2% por operação.',
    );
  }

  const intrabarPriority =
    options.intrabarPriority ??
    MULTI_STRATEGY_BACKTEST_DEFAULTS
      .intrabarPriority;

  if (
    intrabarPriority !== 'stop_first' &&
    intrabarPriority !== 'target_first'
  ) {
    throw new Error(
      'intrabarPriority inválido.',
    );
  }

  const maxPositionNotional =
    options.maxPositionNotional ??
    MULTI_STRATEGY_BACKTEST_DEFAULTS
      .maxPositionNotional;

  if (
    maxPositionNotional !==
      Number.POSITIVE_INFINITY &&
    (
      !Number.isFinite(
        maxPositionNotional,
      ) ||
      maxPositionNotional <= 0
    )
  ) {
    throw new Error(
      'maxPositionNotional deve ser maior que zero.',
    );
  }

  return {
    initialCapitalUsdt:
      positiveBacktestNumber(
        options.initialCapitalUsdt ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .initialCapitalUsdt,
        'initialCapitalUsdt',
      ),

    riskPercent,

    feeRatePct:
      nonNegativeBacktestNumber(
        options.feeRatePct ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .feeRatePct,
        'feeRatePct',
      ),

    slippagePct:
      nonNegativeBacktestNumber(
        options.slippagePct ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .slippagePct,
        'slippagePct',
      ),

    stepSize:
      positiveBacktestNumber(
        options.stepSize ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .stepSize,
        'stepSize',
      ),

    minQuantity:
      nonNegativeBacktestNumber(
        options.minQuantity ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .minQuantity,
        'minQuantity',
      ),

    minNotional:
      nonNegativeBacktestNumber(
        options.minNotional ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .minNotional,
        'minNotional',
      ),

    maxPositionNotional,

    intrabarPriority,

    maximumHoldingCandles:
      nonNegativeBacktestInteger(
        options.maximumHoldingCandles ??
          MULTI_STRATEGY_BACKTEST_DEFAULTS
            .maximumHoldingCandles,
        'maximumHoldingCandles',
      ),

    maximumNextOpenDistanceAtr:
      nonNegativeBacktestNumber(
        options.maximumNextOpenDistanceAtr ??
          descriptor
            .defaultMaximumNextOpenDistanceAtr,
        'maximumNextOpenDistanceAtr',
      ),
  };
}

// -----------------------------------------------------------------------------
// Indicadores históricos sem lookahead
// -----------------------------------------------------------------------------

interface HistoricalIndicatorRuntimeState {
  periodHigh: number;
  periodLow: number;
  peakClose: number;
  maximumDrawdownPct: number;
  candlesInDrawdown: number;
}

function isAvailableBacktestValue(
  value: number | null,
): value is number {
  return (
    value !== null &&
    Number.isFinite(value)
  );
}

function snapshotHistoricalIndicatorsAt(
  candles: readonly DayTradeCandle[],
  point: DayTradeIndicatorPoint,
  index: number,
  full: DayTradeIndicators,
  regime: {
    regime: VolatilityRegime;
    percentile: number | null;
  },
  runtime: HistoricalIndicatorRuntimeState,
): DayTradeIndicators {
  const current = candles[index];
  const previous = candles[index - 1];

  const candleCount = index + 1;
  const requiredCandles =
    getRequiredCandleCount(
      full.options,
    );

  const missingCandles =
    Math.max(
      0,
      requiredCandles - candleCount,
    );

  const coreReady = [
    point.emaFast,
    point.emaMedium,
    point.emaSlow,
    point.atr,
    point.priorHighestHigh,
    point.priorLowestLow,
    point.averageVolume,
    point.annualizedVolatilityPct,
  ].every(
    isAvailableBacktestValue,
  );

  const currentDrawdownPct =
    (
      (
        current.close -
        runtime.peakClose
      ) /
      runtime.peakClose
    ) * 100;

  return {
    options: full.options,

    /**
     * A série é limitada ao ponto atual.
     * Estratégias que usam inclinação ou janelas internas não enxergam futuro.
     */
    series:
      full.series.slice(
        0,
        index + 1,
      ),

    candleCount,
    requiredCandles,

    ready:
      missingCandles === 0 &&
      coreReady,

    missingCandles,

    currentCandleOpenTime:
      current.openTime,

    currentCandleCloseTime:
      current.closeTime,

    previousCandleCloseTime:
      previous.closeTime,

    currentPrice:
      current.close,

    previousClose:
      previous.close,

    lastCandleReturnPct:
      (
        current.close /
        previous.close -
        1
      ) * 100,

    currentCandleRangePct:
      (
        (
          current.high -
          current.low
        ) /
        current.open
      ) * 100,

    emaFast:
      point.emaFast,

    emaMedium:
      point.emaMedium,

    emaSlow:
      point.emaSlow,

    atr:
      point.atr,

    atrPct:
      point.atrPct,

    breakoutLevel:
      point.priorHighestHigh,

    supportLevel:
      point.priorLowestLow,

    distanceToBreakoutPct:
      point.priorHighestHigh === null
        ? null
        : (
            (
              point.priorHighestHigh -
              current.close
            ) /
            current.close
          ) * 100,

    distanceFromSupportPct:
      point.priorLowestLow === null
        ? null
        : (
            (
              current.close -
              point.priorLowestLow
            ) /
            current.close
          ) * 100,

    distanceFromSlowEmaPct:
      point.emaSlow === null
        ? null
        : (
            (
              current.close -
              point.emaSlow
            ) /
            point.emaSlow
          ) * 100,

    currentVolume:
      current.volume,

    currentQuoteVolume:
      current.quoteVolume ?? 0,

    averageVolume:
      point.averageVolume,

    averageQuoteVolume:
      point.averageQuoteVolume,

    relativeVolume:
      point.relativeVolume,

    annualizedVolatilityPct:
      point.annualizedVolatilityPct,

    volatilityRegime:
      regime.regime,

    volatilityPercentile:
      regime.percentile,

    periodHigh:
      runtime.periodHigh,

    periodLow:
      runtime.periodLow,

    amplitudePct:
      (
        (
          runtime.periodHigh -
          runtime.periodLow
        ) /
        runtime.periodLow
      ) * 100,

    maxDrawdownPct:
      runtime.maximumDrawdownPct,

    currentDrawdownPct,

    timeInDrawdownPct:
      (
        runtime.candlesInDrawdown /
        candleCount
      ) * 100,

    comparisons: {
      priceAboveSlowEma:
        point.emaSlow === null
          ? null
          : current.close >
            point.emaSlow,

      fastEmaAboveMediumEma:
        point.emaFast === null ||
        point.emaMedium === null
          ? null
          : point.emaFast >
            point.emaMedium,

      closeAboveBreakout:
        point.priorHighestHigh ===
        null
          ? null
          : current.close >
            point.priorHighestHigh,

      volumeAboveAverage:
        point.averageVolume === null
          ? null
          : current.volume >
            point.averageVolume,
    },
  };
}

function buildMultiStrategyHistoricalEvaluations(
  strategyId: DayTradeStrategyId,
  candles: readonly DayTradeCandle[],
  indicatorOptions: DayTradeIndicatorOptions,
  strategyOptions:
    Partial<DayTradeBacktestStrategyOptionsMap>,
): Array<CommonDayTradeBacktestEvaluation | null> {
  const full =
    calculateDayTradeIndicators(
      candles,
      indicatorOptions,
    );

  const evaluations:
    Array<CommonDayTradeBacktestEvaluation | null> =
      new Array(
        candles.length,
      ).fill(null);

  const volatilityHistory: number[] =
    [];

  const runtime: HistoricalIndicatorRuntimeState =
    {
      periodHigh:
        candles[0].high,

      periodLow:
        candles[0].low,

      peakClose:
        candles[0].close,

      maximumDrawdownPct: 0,

      candlesInDrawdown: 0,
    };

  for (
    let index = 0;
    index < candles.length;
    index += 1
  ) {
    const candle =
      candles[index];

    const point =
      full.series[index];

    runtime.periodHigh =
      Math.max(
        runtime.periodHigh,
        candle.high,
      );

    runtime.periodLow =
      Math.min(
        runtime.periodLow,
        candle.low,
      );

    runtime.peakClose =
      Math.max(
        runtime.peakClose,
        candle.close,
      );

    const currentDrawdown =
      (
        (
          candle.close -
          runtime.peakClose
        ) /
        runtime.peakClose
      ) * 100;

    if (currentDrawdown < 0) {
      runtime.candlesInDrawdown += 1;
    }

    runtime.maximumDrawdownPct =
      Math.min(
        runtime.maximumDrawdownPct,
        currentDrawdown,
      );

    const regime =
      classifyVolatilityRegime(
        volatilityHistory,
        point
          .annualizedVolatilityPct,
        full.options
          .minimumRegimeSamples,
      );

    if (
      point
        .annualizedVolatilityPct !==
        null &&
      Number.isFinite(
        point
          .annualizedVolatilityPct,
      ) &&
      point
        .annualizedVolatilityPct >=
        0
    ) {
      volatilityHistory.push(
        point
          .annualizedVolatilityPct,
      );
    }

    if (index === 0) {
      continue;
    }

    const snapshot =
      snapshotHistoricalIndicatorsAt(
        candles,
        point,
        index,
        full,
        regime,
        runtime,
      );

    evaluations[index] =
      evaluateCommonBacktestStrategy({
        strategyId,
        candles:
          candles.slice(
            0,
            index + 1,
          ),
        indicators:
          snapshot,
        livePrice:
          candle.close,
        strategyOptions:
          strategyOptions[
            strategyId
          ],
      });
  }

  return evaluations;
}

// -----------------------------------------------------------------------------
// Simulação das operações
// -----------------------------------------------------------------------------

interface OpenMultiStrategyBacktestTrade {
  id: number;

  signal:
    CommonDayTradeBacktestEvaluation;

  plan:
    CommonDayTradeBacktestPlan;

  entryIndex: number;
  entryTime: number;

  signalClose: number;
  plannedEntryReference: number;

  rawEntryPrice: number;
  entryPrice: number;

  stopPrice: number;
  targetPrice: number;

  quantity: number;
  entryNotional: number;
  initialRiskUsdt: number;
  entryFeeUsdt: number;

  equityBefore: number;
}

function applyBacktestBuySlippage(
  price: number,
  slippagePct: number,
): number {
  return (
    price *
    (
      1 +
      slippagePct / 100
    )
  );
}

function applyBacktestSellSlippage(
  price: number,
  slippagePct: number,
): number {
  return (
    price *
    (
      1 -
      slippagePct / 100
    )
  );
}

function calculateBacktestExecutionFee(
  price: number,
  quantity: number,
  feeRatePct: number,
): number {
  return (
    price *
    quantity *
    (
      feeRatePct / 100
    )
  );
}

function classifyBacktestTradeResult(
  netPnlUsdt: number,
): MultiStrategyBacktestTradeResult {
  if (netPnlUsdt > 1e-8) {
    return 'win';
  }

  if (netPnlUsdt < -1e-8) {
    return 'loss';
  }

  return 'breakeven';
}

function medianBacktestValue(
  values: readonly number[],
): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted =
    [...values].sort(
      (
        left,
        right,
      ) =>
        left - right,
    );

  const middle =
    Math.floor(
      sorted.length / 2,
    );

  return (
    sorted.length % 2 === 0
      ? (
          sorted[middle - 1] +
          sorted[middle]
        ) / 2
      : sorted[middle]
  );
}

function chooseMultiStrategyBacktestExit(
  trade:
    OpenMultiStrategyBacktestTrade,
  candle: DayTradeCandle,
  priority:
    MultiStrategyBacktestIntrabarPriority,
): {
  rawExitPrice: number;
  reason:
    MultiStrategyBacktestExitReason;
} | null {
  /**
   * Gap abaixo do stop:
   * assume saída na abertura.
   */
  if (
    candle.open <=
    trade.stopPrice
  ) {
    return {
      rawExitPrice:
        candle.open,
      reason: 'stop',
    };
  }

  /**
   * Gap acima do alvo:
   * usa o alvo como preenchimento conservador.
   */
  if (
    candle.open >=
    trade.targetPrice
  ) {
    return {
      rawExitPrice:
        trade.targetPrice,
      reason: 'target',
    };
  }

  const touchedStop =
    candle.low <=
    trade.stopPrice;

  const touchedTarget =
    candle.high >=
    trade.targetPrice;

  if (
    touchedStop &&
    touchedTarget
  ) {
    return (
      priority ===
        'stop_first'
        ? {
            rawExitPrice:
              trade.stopPrice,
            reason: 'stop',
          }
        : {
            rawExitPrice:
              trade.targetPrice,
            reason: 'target',
          }
    );
  }

  if (touchedStop) {
    return {
      rawExitPrice:
        trade.stopPrice,
      reason: 'stop',
    };
  }

  if (touchedTarget) {
    return {
      rawExitPrice:
        trade.targetPrice,
      reason: 'target',
    };
  }

  return null;
}

function createMultiStrategyBacktestTrade(
  signal:
    CommonDayTradeBacktestEvaluation,
  plan:
    CommonDayTradeBacktestPlan,
  nextCandle:
    DayTradeCandle,
  entryIndex: number,
  equity: number,
  options:
    ResolvedMultiStrategyBacktestOptions,
  tradeId: number,
): {
  trade:
    OpenMultiStrategyBacktestTrade |
    null;

  skipped:
    MultiStrategyBacktestSkippedSignal |
    null;
} {
  const atr =
    plan.stopDistanceAtr > 0
      ? (
          plan.riskPerUnit /
          plan.stopDistanceAtr
        )
      : null;

  if (
    atr !== null &&
    nextCandle.open >
      plan.entryReference +
      atr *
        options
          .maximumNextOpenDistanceAtr
  ) {
    return {
      trade: null,

      skipped: {
        strategy:
          signal.strategy,

        signalCandleOpenTime:
          signal.candleOpenTime,

        signalCandleCloseTime:
          signal.candleCloseTime,

        reason:
          'entry_above_reference_limit',

        explanation:
          'A abertura do candle seguinte ficou além do limite máximo de distância da entrada de referência.',
      },
    };
  }

  if (
    nextCandle.open <=
    plan.stopReference
  ) {
    return {
      trade: null,

      skipped: {
        strategy:
          signal.strategy,

        signalCandleOpenTime:
          signal.candleOpenTime,

        signalCandleCloseTime:
          signal.candleCloseTime,

        reason:
          'entry_below_stop',

        explanation:
          'A abertura seguinte ocorreu no stop ou abaixo dele; o setup foi descartado antes da entrada.',
      },
    };
  }

  const rawEntryPrice =
    nextCandle.open;

  const priceRisk =
    rawEntryPrice -
    plan.stopReference;

  const targetPrice =
    rawEntryPrice +
    priceRisk *
      plan.riskRewardRatio;

  const sizing =
    calculatePositionSize({
      accountBalance:
        equity,

      availableBalance:
        equity,

      riskPercent:
        options.riskPercent,

      direction:
        'long',

      entryPrice:
        rawEntryPrice,

      stopPrice:
        plan.stopReference,

      targetPrice,

      feeRatePct:
        options.feeRatePct,

      slippagePct:
        options.slippagePct,

      stepSize:
        options.stepSize,

      minQuantity:
        options.minQuantity,

      minNotional:
        options.minNotional,

      maxNotional:
        options
          .maxPositionNotional,

      allowLeverage:
        false,

      policy: {
        recommendedRiskPercent: 1,
        maximumRiskPercent: 2,
      },
    });

  if (!sizing.ok) {
    return {
      trade: null,

      skipped: {
        strategy:
          signal.strategy,

        signalCandleOpenTime:
          signal.candleOpenTime,

        signalCandleCloseTime:
          signal.candleCloseTime,

        reason:
          'position_sizing_failed',

        explanation:
          sizing.errors.join(' '),
      },
    };
  }

  const entryPrice =
    applyBacktestBuySlippage(
      rawEntryPrice,
      options.slippagePct,
    );

  const entryFeeUsdt =
    calculateBacktestExecutionFee(
      entryPrice,
      sizing.quantity,
      options.feeRatePct,
    );

  return {
    skipped: null,

    trade: {
      id:
        tradeId,

      signal,
      plan,

      entryIndex,

      entryTime:
        nextCandle.openTime,

      signalClose:
        signal.evaluatedPrice,

      plannedEntryReference:
        plan.entryReference,

      rawEntryPrice,
      entryPrice,

      stopPrice:
        plan.stopReference,

      targetPrice,

      quantity:
        sizing.quantity,

      entryNotional:
        entryPrice *
        sizing.quantity,

      initialRiskUsdt:
        sizing
          .estimatedTotalRiskUsdt,

      entryFeeUsdt,

      equityBefore:
        equity,
    },
  };
}

function closeMultiStrategyBacktestTrade(
  trade:
    OpenMultiStrategyBacktestTrade,
  rawExitPrice: number,
  exitTime: number,
  exitIndex: number,
  reason:
    MultiStrategyBacktestExitReason,
  options:
    ResolvedMultiStrategyBacktestOptions,
): MultiStrategyBacktestTrade {
  const exitPrice =
    applyBacktestSellSlippage(
      rawExitPrice,
      options.slippagePct,
    );

  const exitFeeUsdt =
    calculateBacktestExecutionFee(
      exitPrice,
      trade.quantity,
      options.feeRatePct,
    );

  const grossPnlUsdt =
    (
      exitPrice -
      trade.entryPrice
    ) *
    trade.quantity;

  const totalFeesUsdt =
    trade.entryFeeUsdt +
    exitFeeUsdt;

  const netPnlUsdt =
    grossPnlUsdt -
    totalFeesUsdt;

  const resultR =
    trade.initialRiskUsdt > 0
      ? (
          netPnlUsdt /
          trade.initialRiskUsdt
        )
      : 0;

  const equityAfter =
    Math.max(
      0,
      trade.equityBefore +
        netPnlUsdt,
    );

  const signalAtr =
    trade.plan
      .stopDistanceAtr > 0
      ? (
          trade.plan
            .riskPerUnit /
          trade.plan
            .stopDistanceAtr
        )
      : 0;

  return {
    id:
      trade.id,

    strategy:
      trade.signal.strategy,

    strategyVersion:
      trade.signal
        .strategyVersion,

    direction:
      'long',

    signalCandleOpenTime:
      trade.signal
        .candleOpenTime,

    signalCandleCloseTime:
      trade.signal
        .candleCloseTime,

    entryTime:
      trade.entryTime,

    exitTime,

    signalClose:
      trade.signalClose,

    plannedEntryReference:
      trade
        .plannedEntryReference,

    rawEntryPrice:
      trade.rawEntryPrice,

    entryPrice:
      trade.entryPrice,

    stopPrice:
      trade.stopPrice,

    targetPrice:
      trade.targetPrice,

    rawExitPrice,
    exitPrice,

    quantity:
      trade.quantity,

    entryNotional:
      trade.entryNotional,

    initialRiskUsdt:
      trade.initialRiskUsdt,

    entryFeeUsdt:
      trade.entryFeeUsdt,

    exitFeeUsdt,

    totalFeesUsdt,

    grossPnlUsdt,

    netPnlUsdt,

    resultR,

    result:
      classifyBacktestTradeResult(
        netPnlUsdt,
      ),

    exitReason:
      reason,

    holdingCandles:
      exitIndex -
      trade.entryIndex +
      1,

    signalScorePct:
      trade.signal.scorePct,

    signalPassedConditions:
      trade.signal
        .passedConditions,

    signalTotalConditions:
      trade.signal
        .totalConditions,

    signalAtr,

    signalRelativeVolume:
      trade.signal
        .diagnostics
        .relativeVolume,

    signalVolatilityRegime:
      trade.signal
        .diagnostics
        .volatilityRegime,

    equityBefore:
      trade.equityBefore,

    equityAfter,
  };
}

// -----------------------------------------------------------------------------
// Métricas
// -----------------------------------------------------------------------------

function calculateMultiStrategyBacktestMetrics(
  trades:
    readonly MultiStrategyBacktestTrade[],
  initialCapital:
    number,
  signals:
    number,
  skippedSignals:
    number,
  exposureCandles:
    number,
  testedCandleCount:
    number,
): {
  metrics:
    MultiStrategyBacktestMetrics;

  equityCurve:
    MultiStrategyBacktestResult[
      'equityCurve'
    ];
} {
  const finalCapital =
    trades.length === 0
      ? initialCapital
      : trades[
          trades.length - 1
        ].equityAfter;

  const netPnl =
    finalCapital -
    initialCapital;

  const wins =
    trades.filter(
      (trade) =>
        trade.result === 'win',
    );

  const losses =
    trades.filter(
      (trade) =>
        trade.result === 'loss',
    );

  const breakeven =
    trades.filter(
      (trade) =>
        trade.result ===
        'breakeven',
    );

  const grossProfit =
    wins.reduce(
      (
        sum,
        trade,
      ) =>
        sum +
        trade.netPnlUsdt,
      0,
    );

  const grossLoss =
    Math.abs(
      losses.reduce(
        (
          sum,
          trade,
        ) =>
          sum +
          trade.netPnlUsdt,
        0,
      ),
    );

  const rValues =
    trades.map(
      (trade) =>
        trade.resultR,
    );

  let peak =
    initialCapital;

  let maximumDrawdownUsdt =
    0;

  let maximumDrawdownPct =
    0;

  const equityCurve:
    MultiStrategyBacktestResult[
      'equityCurve'
    ] = [
      {
        time:
          trades[0]
            ?.signalCandleOpenTime ??
          0,

        equityUsdt:
          initialCapital,

        drawdownUsdt: 0,

        drawdownPct: 0,
      },
    ];

  let consecutiveWins = 0;
  let consecutiveLosses = 0;

  let maximumConsecutiveWins =
    0;

  let maximumConsecutiveLosses =
    0;

  for (const trade of trades) {
    peak =
      Math.max(
        peak,
        trade.equityAfter,
      );

    const drawdownUsdt =
      peak -
      trade.equityAfter;

    const drawdownPct =
      peak > 0
        ? (
            drawdownUsdt /
            peak
          ) * 100
        : 0;

    maximumDrawdownUsdt =
      Math.max(
        maximumDrawdownUsdt,
        drawdownUsdt,
      );

    maximumDrawdownPct =
      Math.max(
        maximumDrawdownPct,
        drawdownPct,
      );

    equityCurve.push({
      time:
        trade.exitTime,

      equityUsdt:
        trade.equityAfter,

      drawdownUsdt,

      drawdownPct,
    });

    if (
      trade.result === 'win'
    ) {
      consecutiveWins += 1;
      consecutiveLosses = 0;
    } else if (
      trade.result === 'loss'
    ) {
      consecutiveLosses += 1;
      consecutiveWins = 0;
    } else {
      consecutiveWins = 0;
      consecutiveLosses = 0;
    }

    maximumConsecutiveWins =
      Math.max(
        maximumConsecutiveWins,
        consecutiveWins,
      );

    maximumConsecutiveLosses =
      Math.max(
        maximumConsecutiveLosses,
        consecutiveLosses,
      );
  }

  return {
    equityCurve,

    metrics: {
      initialCapitalUsdt:
        initialCapital,

      finalCapitalUsdt:
        finalCapital,

      netPnlUsdt:
        netPnl,

      netReturnPct:
        (
          netPnl /
          initialCapital
        ) * 100,

      signals,

      enteredTrades:
        trades.length,

      skippedSignals,

      totalTrades:
        trades.length,

      wins:
        wins.length,

      losses:
        losses.length,

      breakeven:
        breakeven.length,

      winRatePct:
        trades.length === 0
          ? 0
          : (
              wins.length /
              trades.length
            ) * 100,

      grossProfitUsdt:
        grossProfit,

      grossLossUsdt:
        grossLoss,

      profitFactor:
        grossLoss === 0
          ? (
              grossProfit > 0
                ? null
                : 0
            )
          : (
              grossProfit /
              grossLoss
            ),

      averagePnlUsdt:
        trades.length === 0
          ? 0
          : (
              netPnl /
              trades.length
            ),

      averageR:
        rValues.length === 0
          ? 0
          : (
              rValues.reduce(
                (
                  sum,
                  value,
                ) =>
                  sum + value,
                0,
              ) /
              rValues.length
            ),

      medianR:
        medianBacktestValue(
          rValues,
        ),

      bestR:
        rValues.length === 0
          ? 0
          : Math.max(
              ...rValues,
            ),

      worstR:
        rValues.length === 0
          ? 0
          : Math.min(
              ...rValues,
            ),

      maximumDrawdownUsdt,

      maximumDrawdownPct,

      averageHoldingCandles:
        trades.length === 0
          ? 0
          : (
              trades.reduce(
                (
                  sum,
                  trade,
                ) =>
                  sum +
                  trade
                    .holdingCandles,
                0,
              ) /
              trades.length
            ),

      maximumConsecutiveWins,

      maximumConsecutiveLosses,

      exposurePct:
        testedCandleCount <= 0
          ? 0
          : (
              exposureCandles /
              testedCandleCount
            ) * 100,
    },
  };
}

// -----------------------------------------------------------------------------
// Execução principal
// -----------------------------------------------------------------------------

export function runMultiStrategyBacktest(
  input:
    MultiStrategyBacktestInput,
): MultiStrategyBacktestResult {
  const candles =
    normalizeClosedCandles(
      input.candles,
    );

  if (candles.length < 2) {
    throw new Error(
      'O backtest exige pelo menos dois candles encerrados.',
    );
  }

  const strategyOptions =
    input.strategyOptions ?? {};

  const descriptor =
    getBacktestStrategyDescriptor(
      input.strategyId,
      input.indicatorOptions,
      strategyOptions,
    );

  const options =
    resolveMultiStrategyBacktestOptions(
      input.strategyId,
      input.indicatorOptions,
      strategyOptions,
      input.backtestOptions,
    );

  const fullIndicators =
    calculateDayTradeIndicators(
      candles,
      input.indicatorOptions,
    );

  const warmupCandles =
    Math.max(
      fullIndicators
        .requiredCandles,
      descriptor
        .requiredCandleCount,
    );

  if (
    candles.length <=
    warmupCandles
  ) {
    throw new Error(
      `O histórico deve possuir mais de ${warmupCandles} candles para incluir aquecimento e período testado.`,
    );
  }

  const evaluations =
    buildMultiStrategyHistoricalEvaluations(
      input.strategyId,
      candles,
      input.indicatorOptions,
      strategyOptions,
    );

  const trades:
    MultiStrategyBacktestTrade[] =
      [];

  const skippedSignals:
    MultiStrategyBacktestSkippedSignal[] =
      [];

  let equity =
    options.initialCapitalUsdt;

  let openTrade:
    OpenMultiStrategyBacktestTrade |
    null = null;

  let pendingSignal:
    CommonDayTradeBacktestEvaluation |
    null = null;

  let signals = 0;
  let exposureCandles = 0;
  let nextTradeId = 1;

  const firstTestedIndex =
    Math.max(
      1,
      warmupCandles - 1,
    );

  for (
    let index =
      firstTestedIndex;

    index <
    candles.length;

    index += 1
  ) {
    const candle =
      candles[index];

    /**
     * A entrada usa somente a abertura posterior ao sinal.
     */
    if (
      pendingSignal &&
      !openTrade
    ) {
      const plan =
        pendingSignal.plan;

      if (plan) {
        const created =
          createMultiStrategyBacktestTrade(
            pendingSignal,
            plan,
            candle,
            index,
            equity,
            options,
            nextTradeId,
          );

        if (created.trade) {
          openTrade =
            created.trade;

          nextTradeId += 1;
        } else if (
          created.skipped
        ) {
          skippedSignals.push(
            created.skipped,
          );
        }
      }

      pendingSignal = null;
    }

    if (openTrade) {
      exposureCandles += 1;

      let selectedExit =
        chooseMultiStrategyBacktestExit(
          openTrade,
          candle,
          options
            .intrabarPriority,
        );

      if (
        !selectedExit &&
        options
          .maximumHoldingCandles >
          0 &&
        (
          index -
          openTrade.entryIndex +
          1
        ) >=
          options
            .maximumHoldingCandles
      ) {
        selectedExit = {
          rawExitPrice:
            candle.close,

          reason:
            'maximum_holding',
        };
      }

      if (selectedExit) {
        const closed =
          closeMultiStrategyBacktestTrade(
            openTrade,
            selectedExit
              .rawExitPrice,
            candle.closeTime,
            index,
            selectedExit.reason,
            options,
          );

        trades.push(
          closed,
        );

        equity =
          closed.equityAfter;

        openTrade = null;
      }
    }

    const evaluation =
      evaluations[index];

    if (
      evaluation
        ?.status ===
        'condicoes_atendidas' &&
      evaluation
        .allConditionsMet &&
      evaluation.plan !== null
    ) {
      signals += 1;

      if (
        index >=
        candles.length - 1
      ) {
        skippedSignals.push({
          strategy:
            input.strategyId,

          signalCandleOpenTime:
            evaluation
              .candleOpenTime,

          signalCandleCloseTime:
            evaluation
              .candleCloseTime,

          reason:
            'no_next_candle',

          explanation:
            'O sinal ocorreu no último candle disponível e não existe uma abertura posterior para simular a entrada.',
        });
      } else if (
        openTrade ||
        pendingSignal
      ) {
        skippedSignals.push({
          strategy:
            input.strategyId,

          signalCandleOpenTime:
            evaluation
              .candleOpenTime,

          signalCandleCloseTime:
            evaluation
              .candleCloseTime,

          reason:
            'position_open',

          explanation:
            'O sinal foi ignorado porque o backtest permite somente uma posição aberta por vez.',
        });
      } else {
        pendingSignal =
          evaluation;
      }
    }

    if (equity <= 0) {
      break;
    }
  }

  if (openTrade) {
    const lastIndex =
      candles.length - 1;

    const last =
      candles[lastIndex];

    const closed =
      closeMultiStrategyBacktestTrade(
        openTrade,
        last.close,
        last.closeTime,
        lastIndex,
        'end_of_data',
        options,
      );

    trades.push(
      closed,
    );

    equity =
      closed.equityAfter;

    openTrade = null;
  }

  if (pendingSignal) {
    skippedSignals.push({
      strategy:
        input.strategyId,

      signalCandleOpenTime:
        pendingSignal
          .candleOpenTime,

      signalCandleCloseTime:
        pendingSignal
          .candleCloseTime,

      reason:
        'no_next_candle',

      explanation:
        'O histórico terminou antes da abertura necessária para executar o sinal.',
    });
  }

  const testedCandleCount =
    Math.max(
      0,
      candles.length -
      firstTestedIndex,
    );

  const calculated =
    calculateMultiStrategyBacktestMetrics(
      trades,
      options
        .initialCapitalUsdt,
      signals,
      skippedSignals.length,
      exposureCandles,
      testedCandleCount,
    );

  const warnings = [
    'Resultados passados não garantem resultados futuros.',
    'A simulação usa candles OHLCV e não conhece a sequência real dos negócios dentro de cada candle.',
    'O backtest não reproduz fila de ordens, liquidez real, indisponibilidade da corretora ou mudanças de regras da Binance.',
  ];

  if (
    options.intrabarPriority ===
    'stop_first'
  ) {
    warnings.push(
      'Quando stop e alvo são tocados no mesmo candle, o resultado considera o stop primeiro.',
    );
  }

  if (trades.length < 30) {
    warnings.push(
      'A amostra possui menos de 30 operações e ainda é pequena para conclusões estatísticas.',
    );
  }

  const registryDefinition =
    DAYTRADE_STRATEGY_REGISTRY[
      input.strategyId
    ];

  if (
    registryDefinition
      .executionMode ===
    'shadow'
  ) {
    warnings.push(
      'Esta estratégia está em modo shadow no Auto Trade. O resultado do backtest não autoriza criação de oportunidades ou ordens.',
    );
  }

  return {
    strategy:
      input.strategyId,

    strategyVersion:
      descriptor.version,

    strategyLabel:
      descriptor.label,

    strategyShortLabel:
      descriptor.shortLabel,

    assumptions: {
      signalTiming:
        'candle_close',

      entryTiming:
        'next_candle_open',

      onePositionAtATime:
        true,

      intrabarPriority:
        options
          .intrabarPriority,

      targetAdjustment:
        'preserve_signal_r_multiple_from_actual_next_open',

      costsIncluded:
        true,

      educationalOnly:
        true,
    },

    options,

    indicatorOptions:
      fullIndicators.options,

    strategyOptions,

    candleCount:
      candles.length,

    warmupCandles,

    testedCandleCount,

    firstCandleOpenTime:
      candles[0].openTime,

    lastCandleCloseTime:
      candles[
        candles.length - 1
      ].closeTime,

    metrics:
      calculated.metrics,

    trades,

    skippedSignals,

    equityCurve:
      calculated.equityCurve,

    warnings,

    educationalNotice:
      'Backtest educacional baseado em regras determinísticas. Não constitui recomendação de investimento ou promessa de rentabilidade.',
  };
}

// ============================================================================
// SEÇÃO 11: compareBacktests.ts
// ============================================================================

/**
 * lib/daytrade/compareBacktests.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Comparador dos quatro playbooks sobre o mesmo histórico.
 *
 * Responsabilidades:
 * - executar o mesmo motor de backtest para todas as estratégias;
 * - usar candles, indicadores, capital, custos e regras iguais;
 * - gerar tabela comparativa;
 * - identificar líderes por retorno, profit factor, R médio e drawdown;
 * - separar resultados com amostra pequena;
 * - não liberar estratégias shadow para execução automática.
 *
 * Este arquivo não consulta APIs, não grava no banco e não executa ordens.
 */

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export type BacktestSampleQuality =
  | 'insuficiente'
  | 'pequena'
  | 'moderada'
  | 'ampla';

export interface CompareDayTradeBacktestsOptions {
  /**
   * Estratégias incluídas.
   *
   * Padrão: as quatro registradas.
   */
  strategyIds?: readonly DayTradeStrategyId[];

  /**
   * Quantidade mínima de operações para entrar no ranking principal.
   *
   * Padrão: 30.
   */
  minimumTradesForRanking?: number;

  /**
   * Executa todas mesmo quando uma estratégia falha.
   *
   * Padrão: true.
   */
  continueOnStrategyError?: boolean;
}

export interface CompareDayTradeBacktestsInput {
  candles: readonly DayTradeCandle[];

  indicatorOptions: DayTradeIndicatorOptions;

  strategyOptions?: Partial<
    DayTradeBacktestStrategyOptionsMap
  >;

  backtestOptions?: MultiStrategyBacktestOptions;

  comparisonOptions?: CompareDayTradeBacktestsOptions;
}

export interface DayTradeBacktestComparisonRow {
  strategy: DayTradeStrategyId;
  strategyVersion: string;

  label: string;
  shortLabel: string;

  executionMode:
    | 'testnet_allowed'
    | 'shadow';

  authorizedForAutomaticOrders: boolean;

  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;

  winRatePct: number;

  initialCapitalUsdt: number;
  finalCapitalUsdt: number;

  netPnlUsdt: number;
  netReturnPct: number;

  profitFactor: number | null;

  averageR: number;
  medianR: number;
  bestR: number;
  worstR: number;

  maximumDrawdownUsdt: number;
  maximumDrawdownPct: number;

  averageHoldingCandles: number;
  exposurePct: number;

  signals: number;
  skippedSignals: number;

  sampleQuality: BacktestSampleQuality;
  eligibleForMainRanking: boolean;

  profitable: boolean;
  positiveExpectancy: boolean;
  controlledDrawdown: boolean;
}

export interface DayTradeBacktestComparisonFailure {
  strategy: DayTradeStrategyId;
  label: string;
  error: string;
}

export interface DayTradeBacktestComparisonLeader {
  strategy: DayTradeStrategyId;
  label: string;
  value: number | null;
}

export interface DayTradeBacktestComparisonLeaders {
  highestNetReturn:
    DayTradeBacktestComparisonLeader | null;

  highestNetPnl:
    DayTradeBacktestComparisonLeader | null;

  highestProfitFactor:
    DayTradeBacktestComparisonLeader | null;

  highestWinRate:
    DayTradeBacktestComparisonLeader | null;

  highestAverageR:
    DayTradeBacktestComparisonLeader | null;

  lowestDrawdown:
    DayTradeBacktestComparisonLeader | null;

  highestTradeCount:
    DayTradeBacktestComparisonLeader | null;
}

export interface DayTradeBacktestComparisonResult {
  generatedAt: string;

  strategyIds: DayTradeStrategyId[];

  minimumTradesForRanking: number;

  candleCount: number;
  firstCandleOpenTime: number;
  lastCandleCloseTime: number;

  commonAssumptions: {
    signalTiming: 'candle_close';
    entryTiming: 'next_candle_open';
    onePositionAtATime: true;
    costsIncluded: true;
    educationalOnly: true;
  };

  /**
   * Resultados completos de cada motor.
   */
  results: Partial<
    Record<
      DayTradeStrategyId,
      MultiStrategyBacktestResult
    >
  >;

  /**
   * Tabela pronta para interface.
   */
  rows: DayTradeBacktestComparisonRow[];

  /**
   * Ranking principal.
   *
   * Considera apenas estratégias com a amostra mínima.
   * Ordenação:
   * 1. retorno líquido;
   * 2. drawdown;
   * 3. R médio;
   * 4. número de operações.
   */
  mainRanking: DayTradeBacktestComparisonRow[];

  /**
   * Resultados com menos operações que o mínimo.
   */
  provisionalRanking: DayTradeBacktestComparisonRow[];

  leaders: DayTradeBacktestComparisonLeaders;

  /**
   * Estratégias que merecem mais validação.
   *
   * Não significa autorização para Auto Trade.
   */
  candidatesForFurtherValidation: DayTradeBacktestComparisonRow[];

  failures: DayTradeBacktestComparisonFailure[];

  warnings: string[];

  educationalNotice: string;
}

// -----------------------------------------------------------------------------
// Validação
// -----------------------------------------------------------------------------

const DEFAULT_MINIMUM_TRADES_FOR_RANKING = 30;

function resolveComparisonStrategyIds(
  value:
    | readonly DayTradeStrategyId[]
    | undefined,
): DayTradeStrategyId[] {
  const source =
    value ?? DAYTRADE_STRATEGY_IDS;

  const unique =
    Array.from(
      new Set(source),
    );

  for (const strategyId of unique) {
    if (
      !DAYTRADE_STRATEGY_IDS.includes(
        strategyId,
      )
    ) {
      throw new Error(
        `Estratégia inválida para comparação: ${strategyId}.`,
      );
    }
  }

  if (unique.length === 0) {
    throw new Error(
      'Informe pelo menos uma estratégia para comparação.',
    );
  }

  return unique;
}

function resolveMinimumTradesForRanking(
  value: number | undefined,
): number {
  const resolved =
    value ??
    DEFAULT_MINIMUM_TRADES_FOR_RANKING;

  if (
    !Number.isInteger(resolved) ||
    resolved < 1
  ) {
    throw new Error(
      'minimumTradesForRanking deve ser um inteiro maior ou igual a 1.',
    );
  }

  return resolved;
}

// -----------------------------------------------------------------------------
// Classificação da amostra
// -----------------------------------------------------------------------------

export function classifyBacktestSampleQuality(
  totalTrades: number,
): BacktestSampleQuality {
  if (totalTrades < 10) {
    return 'insuficiente';
  }

  if (totalTrades < 30) {
    return 'pequena';
  }

  if (totalTrades < 100) {
    return 'moderada';
  }

  return 'ampla';
}

// -----------------------------------------------------------------------------
// Conversão para linha comparativa
// -----------------------------------------------------------------------------

function createComparisonRow(
  result: MultiStrategyBacktestResult,
  minimumTradesForRanking: number,
): DayTradeBacktestComparisonRow {
  const definition =
    DAYTRADE_STRATEGY_REGISTRY[
      result.strategy
    ];

  const metrics =
    result.metrics;

  const sampleQuality =
    classifyBacktestSampleQuality(
      metrics.totalTrades,
    );

  return {
    strategy:
      result.strategy,

    strategyVersion:
      result.strategyVersion,

    label:
      result.strategyLabel,

    shortLabel:
      result.strategyShortLabel,

    executionMode:
      definition.executionMode,

    authorizedForAutomaticOrders:
      definition
        .authorizedForAutomaticOrders,

    totalTrades:
      metrics.totalTrades,

    wins:
      metrics.wins,

    losses:
      metrics.losses,

    breakeven:
      metrics.breakeven,

    winRatePct:
      metrics.winRatePct,

    initialCapitalUsdt:
      metrics.initialCapitalUsdt,

    finalCapitalUsdt:
      metrics.finalCapitalUsdt,

    netPnlUsdt:
      metrics.netPnlUsdt,

    netReturnPct:
      metrics.netReturnPct,

    profitFactor:
      metrics.profitFactor,

    averageR:
      metrics.averageR,

    medianR:
      metrics.medianR,

    bestR:
      metrics.bestR,

    worstR:
      metrics.worstR,

    maximumDrawdownUsdt:
      metrics.maximumDrawdownUsdt,

    maximumDrawdownPct:
      metrics.maximumDrawdownPct,

    averageHoldingCandles:
      metrics.averageHoldingCandles,

    exposurePct:
      metrics.exposurePct,

    signals:
      metrics.signals,

    skippedSignals:
      metrics.skippedSignals,

    sampleQuality,

    eligibleForMainRanking:
      metrics.totalTrades >=
      minimumTradesForRanking,

    profitable:
      metrics.netPnlUsdt > 0,

    positiveExpectancy:
      metrics.averageR > 0,

    controlledDrawdown:
      metrics.maximumDrawdownPct <= 20,
  };
}

// -----------------------------------------------------------------------------
// Ordenações
// -----------------------------------------------------------------------------

function compareMainRankingRows(
  left: DayTradeBacktestComparisonRow,
  right: DayTradeBacktestComparisonRow,
): number {
  const returnDifference =
    right.netReturnPct -
    left.netReturnPct;

  if (returnDifference !== 0) {
    return returnDifference;
  }

  const drawdownDifference =
    left.maximumDrawdownPct -
    right.maximumDrawdownPct;

  if (drawdownDifference !== 0) {
    return drawdownDifference;
  }

  const averageRDifference =
    right.averageR -
    left.averageR;

  if (averageRDifference !== 0) {
    return averageRDifference;
  }

  const tradeCountDifference =
    right.totalTrades -
    left.totalTrades;

  if (tradeCountDifference !== 0) {
    return tradeCountDifference;
  }

  return (
    DAYTRADE_STRATEGY_REGISTRY[
      left.strategy
    ].displayOrder -
    DAYTRADE_STRATEGY_REGISTRY[
      right.strategy
    ].displayOrder
  );
}

function compareProvisionalRows(
  left: DayTradeBacktestComparisonRow,
  right: DayTradeBacktestComparisonRow,
): number {
  const tradeCountDifference =
    right.totalTrades -
    left.totalTrades;

  if (tradeCountDifference !== 0) {
    return tradeCountDifference;
  }

  return compareMainRankingRows(
    left,
    right,
  );
}

// -----------------------------------------------------------------------------
// Líderes
// -----------------------------------------------------------------------------

function createLeader(
  row: DayTradeBacktestComparisonRow,
  value: number | null,
): DayTradeBacktestComparisonLeader {
  return {
    strategy:
      row.strategy,

    label:
      row.label,

    value,
  };
}

function highestBy(
  rows:
    readonly DayTradeBacktestComparisonRow[],
  selector:
    (
      row:
        DayTradeBacktestComparisonRow,
    ) => number,
): DayTradeBacktestComparisonRow | null {
  if (rows.length === 0) {
    return null;
  }

  return [...rows].sort(
    (
      left,
      right,
    ) =>
      selector(right) -
      selector(left),
  )[0];
}

function lowestBy(
  rows:
    readonly DayTradeBacktestComparisonRow[],
  selector:
    (
      row:
        DayTradeBacktestComparisonRow,
    ) => number,
): DayTradeBacktestComparisonRow | null {
  if (rows.length === 0) {
    return null;
  }

  return [...rows].sort(
    (
      left,
      right,
    ) =>
      selector(left) -
      selector(right),
  )[0];
}

function createComparisonLeaders(
  rows:
    readonly DayTradeBacktestComparisonRow[],
): DayTradeBacktestComparisonLeaders {
  const highestNetReturn =
    highestBy(
      rows,
      (row) =>
        row.netReturnPct,
    );

  const highestNetPnl =
    highestBy(
      rows,
      (row) =>
        row.netPnlUsdt,
    );

  const rowsWithProfitFactor =
    rows.filter(
      (row) =>
        row.profitFactor !== null,
    );

  const highestProfitFactor =
    highestBy(
      rowsWithProfitFactor,
      (row) =>
        row.profitFactor ?? 0,
    );

  const highestWinRate =
    highestBy(
      rows,
      (row) =>
        row.winRatePct,
    );

  const highestAverageR =
    highestBy(
      rows,
      (row) =>
        row.averageR,
    );

  const lowestDrawdown =
    lowestBy(
      rows,
      (row) =>
        row.maximumDrawdownPct,
    );

  const highestTradeCount =
    highestBy(
      rows,
      (row) =>
        row.totalTrades,
    );

  return {
    highestNetReturn:
      highestNetReturn
        ? createLeader(
            highestNetReturn,
            highestNetReturn
              .netReturnPct,
          )
        : null,

    highestNetPnl:
      highestNetPnl
        ? createLeader(
            highestNetPnl,
            highestNetPnl
              .netPnlUsdt,
          )
        : null,

    highestProfitFactor:
      highestProfitFactor
        ? createLeader(
            highestProfitFactor,
            highestProfitFactor
              .profitFactor,
          )
        : null,

    highestWinRate:
      highestWinRate
        ? createLeader(
            highestWinRate,
            highestWinRate
              .winRatePct,
          )
        : null,

    highestAverageR:
      highestAverageR
        ? createLeader(
            highestAverageR,
            highestAverageR
              .averageR,
          )
        : null,

    lowestDrawdown:
      lowestDrawdown
        ? createLeader(
            lowestDrawdown,
            lowestDrawdown
              .maximumDrawdownPct,
          )
        : null,

    highestTradeCount:
      highestTradeCount
        ? createLeader(
            highestTradeCount,
            highestTradeCount
              .totalTrades,
          )
        : null,
  };
}

// -----------------------------------------------------------------------------
// Execução
// -----------------------------------------------------------------------------

export function compareDayTradeBacktests(
  input: CompareDayTradeBacktestsInput,
): DayTradeBacktestComparisonResult {
  if (input.candles.length === 0) {
    throw new Error(
      'Não existem candles para comparar.',
    );
  }

  const comparisonOptions =
    input.comparisonOptions ?? {};

  const strategyIds =
    resolveComparisonStrategyIds(
      comparisonOptions
        .strategyIds,
    );

  const minimumTradesForRanking =
    resolveMinimumTradesForRanking(
      comparisonOptions
        .minimumTradesForRanking,
    );

  const continueOnStrategyError =
    comparisonOptions
      .continueOnStrategyError ??
    true;

  const results:
    Partial<
      Record<
        DayTradeStrategyId,
        MultiStrategyBacktestResult
      >
    > = {};

  const failures:
    DayTradeBacktestComparisonFailure[] =
      [];

  for (const strategyId of strategyIds) {
    const backtestInput:
      MultiStrategyBacktestInput = {
        strategyId,

        candles:
          input.candles,

        indicatorOptions:
          input.indicatorOptions,

        strategyOptions:
          input.strategyOptions,

        backtestOptions:
          input.backtestOptions,
      };

    try {
      results[strategyId] =
        runMultiStrategyBacktest(
          backtestInput,
        );
    } catch (error) {
      const definition =
        DAYTRADE_STRATEGY_REGISTRY[
          strategyId
        ];

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      failures.push({
        strategy:
          strategyId,

        label:
          definition.label,

        error:
          message,
      });

      if (!continueOnStrategyError) {
        throw error;
      }
    }
  }

  const rows =
    strategyIds
      .map(
        (strategyId) =>
          results[strategyId],
      )
      .filter(
        (
          result,
        ): result is
          MultiStrategyBacktestResult =>
          result !== undefined,
      )
      .map(
        (result) =>
          createComparisonRow(
            result,
            minimumTradesForRanking,
          ),
      );

  const mainRanking =
    rows
      .filter(
        (row) =>
          row
            .eligibleForMainRanking,
      )
      .sort(
        compareMainRankingRows,
      );

  const provisionalRanking =
    rows
      .filter(
        (row) =>
          !row
            .eligibleForMainRanking,
      )
      .sort(
        compareProvisionalRows,
      );

  const candidatesForFurtherValidation =
    mainRanking.filter(
      (row) =>
        row.profitable &&
        row.positiveExpectancy &&
        (
          row.profitFactor ===
            null ||
          row.profitFactor > 1
        ) &&
        row.controlledDrawdown,
    );

  const warnings: string[] = [
    'Os quatro backtests são independentes e cada estratégia mantém sua própria simulação de posição única.',
    'A classificação principal não representa recomendação de investimento nem autorização para execução automática.',
    'Estratégias em modo shadow continuam proibidas de criar oportunidades ou ordens, mesmo quando lideram o backtest.',
  ];

  if (mainRanking.length === 0) {
    warnings.push(
      `Nenhuma estratégia alcançou a amostra mínima de ${minimumTradesForRanking} operações. Use apenas o ranking provisório.`,
    );
  }

  if (failures.length > 0) {
    warnings.push(
      `${failures.length} estratégia(s) não puderam concluir o backtest.`,
    );
  }

  const sortedCandles =
    [...input.candles].sort(
      (
        left,
        right,
      ) =>
        left.openTime -
        right.openTime,
    );

  return {
    generatedAt:
      new Date().toISOString(),

    strategyIds,

    minimumTradesForRanking,

    candleCount:
      sortedCandles.length,

    firstCandleOpenTime:
      sortedCandles[0]
        .openTime,

    lastCandleCloseTime:
      sortedCandles[
        sortedCandles.length - 1
      ].closeTime,

    commonAssumptions: {
      signalTiming:
        'candle_close',

      entryTiming:
        'next_candle_open',

      onePositionAtATime:
        true,

      costsIncluded:
        true,

      educationalOnly:
        true,
    },

    results,

    rows,

    mainRanking,

    provisionalRanking,

    leaders:
      createComparisonLeaders(
        rows,
      ),

    candidatesForFurtherValidation,

    failures,

    warnings,

    educationalNotice:
      'Comparação educacional de estratégias baseada em dados históricos e regras determinísticas. Não constitui recomendação, garantia de resultado ou autorização para negociar.',
  };
}

// ============================================================================
// SEÇÃO 11.1: gerenciamento de risco sequencial para backtests
// ============================================================================
//
// Esta camada é deliberadamente aplicada APÓS a geração dos sinais e das
// saídas. Assim, o caminho técnico (sinal, entrada, stop, alvo e saída) é
// idêntico entre risco fixo e risco dinâmico. Apenas quantidade, risco em USDT,
// custos proporcionais, PnL e curva patrimonial são recalculados.
//
// O fechamento forçado por end_of_data participa do patrimônio final, mas não
// alimenta a sequência de vitórias/derrotas usada na próxima decisão.
// ============================================================================

type BacktestPositionSizingMode =
  | 'fixed'
  | 'anti_martingale'
  | 'martingale_testnet';

type BacktestPositionSizingScope = 'strategy';

interface BacktestMoneyManagementOptions {
  mode?: BacktestPositionSizingMode;
  baseRiskPercent?: number;
  minimumRiskPercent?: number;
  maximumRiskPercent?: number;
  winMultiplier?: number;
  lossMultiplier?: number;
  lossReductionStart?: number;
  martingaleLossMultiplier?: number;
  maximumMultiplier?: number;
  martingaleMaximumMultiplier?: number;
  maximumSequenceSteps?: number;
  pauseAfterConsecutiveLosses?: number;
  balanceUsageLimitPct?: number;
  compareWithFixed?: boolean;
  policyVersion?: string;
}

interface ResolvedBacktestMoneyManagementOptions {
  mode: BacktestPositionSizingMode;
  scope: BacktestPositionSizingScope;
  baseRiskPercent: number;
  minimumRiskPercent: number;
  maximumRiskPercent: number;
  winMultiplier: number;
  lossMultiplier: number;
  lossReductionStart: number;
  martingaleLossMultiplier: number;
  maximumMultiplier: number;
  martingaleMaximumMultiplier: number;
  maximumSequenceSteps: number;
  pauseAfterConsecutiveLosses: number;
  balanceUsageLimitPct: number;
  compareWithFixed: boolean;
  policyVersion: string;
}

interface BacktestSizingDecision {
  mode: BacktestPositionSizingMode;
  scope: BacktestPositionSizingScope;
  policyVersion: string;
  baseRiskPercent: number;
  targetRiskPercent: number;
  appliedRiskPercent: number;
  riskMultiplier: number;
  rawRiskMultiplier: number;
  sequenceStep: number;
  consecutiveWinsBefore: number;
  consecutiveLossesBefore: number;
  sequenceEligible: boolean;
  wouldPauseAutoTrade: boolean;
  plannedRiskUsdt: number;
  actualRiskUsdt: number;
  requestedQuantity: number;
  effectiveQuantity: number;
  effectiveQuoteAmount: number;
  limitingRules: string[];
}

type BacktestTradeWithSizing = (
  | TrendBreakoutBacktestTrade
  | MultiStrategyBacktestTrade
) & {
  sizingMode: BacktestPositionSizingMode;
  sizingScope: BacktestPositionSizingScope;
  sizingPolicyVersion: string;
  baseRiskPercent: number;
  targetRiskPercent: number;
  appliedRiskPercent: number;
  riskMultiplier: number;
  rawRiskMultiplier: number;
  sequenceStep: number;
  consecutiveWinsBefore: number;
  consecutiveLossesBefore: number;
  sequenceEligible: boolean;
  wouldPauseAutoTrade: boolean;
  plannedRiskUsdt: number;
  actualRiskUsdt: number;
  requestedQuantity: number;
  effectiveQuantity: number;
  effectiveQuoteAmount: number;
  fixedRiskEquivalentPnlUsdt: number | null;
  sizingEffectPnlUsdt: number | null;
  limitingRules: string[];
  sizingDecision: BacktestSizingDecision;
};

type BacktestResultWithSizing = (
  | TrendBreakoutBacktestResult
  | MultiStrategyBacktestResult
) & {
  trades: BacktestTradeWithSizing[];
  moneyManagement: Record<string, unknown>;
};

interface BacktestSizingOverlay {
  result: BacktestResultWithSizing;
  summary: {
    maximumMultiplierApplied: number;
    maximumAppliedRiskPercent: number;
    averageAppliedRiskPercent: number;
    maximumSequenceStep: number;
    maximumEligibleConsecutiveWins: number;
    maximumEligibleConsecutiveLosses: number;
    pauseThresholdHits: number;
    forcedEndOfDataTrades: number;
    balanceLimitedTrades: number;
    notionalLimitedTrades: number;
    exchangeMinimumBlockedTrades: number;
    zeroQuantityTrades: number;
    limitingRuleCounts: Record<string, number>;
  };
}

const BACKTEST_MONEY_MANAGEMENT_DEFAULTS = {
  fixedBaseRiskPercent: 1,
  dynamicBaseRiskPercent: 0.5,
  minimumRiskPercent: 0.25,
  maximumRiskPercent: 1,
  winMultiplier: 1.25,
  lossMultiplier: 0.5,
  lossReductionStart: 2,
  martingaleLossMultiplier: 2,
  maximumMultiplier: 1.5,
  martingaleMaximumMultiplier: 4,
  maximumSequenceSteps: 2,
  pauseAfterConsecutiveLosses: 3,
  balanceUsageLimitPct: 95,
  compareWithFixed: true,
  policyVersion: '1.0.0',
} as const;

function clampBacktestNumber(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function floorBacktestQuantity(value: number, stepSize: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(stepSize) || stepSize <= 0) return value;

  const steps = Math.floor((value + Number.EPSILON) / stepSize);
  const rounded = steps * stepSize;
  const decimals = Math.min(
    14,
    Math.max(0, Math.ceil(-Math.log10(stepSize)) + 2),
  );

  return Number(rounded.toFixed(decimals));
}

function resolveBacktestMoneyManagementOptions(
  input: BacktestMoneyManagementOptions,
  backtestOptions: MultiStrategyBacktestOptions,
): ResolvedBacktestMoneyManagementOptions {
  const mode = input.mode ?? 'fixed';
  const fallbackBaseRisk = mode === 'fixed'
    ? backtestOptions.riskPercent ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.fixedBaseRiskPercent
    : BACKTEST_MONEY_MANAGEMENT_DEFAULTS.dynamicBaseRiskPercent;
  const baseRiskPercent = input.baseRiskPercent ?? fallbackBaseRisk;

  const minimumRiskPercent = input.minimumRiskPercent ?? (
    mode === 'fixed'
      ? baseRiskPercent
      : Math.min(
          BACKTEST_MONEY_MANAGEMENT_DEFAULTS.minimumRiskPercent,
          baseRiskPercent,
        )
  );
  const maximumRiskPercent = input.maximumRiskPercent ?? (
    mode === 'fixed'
      ? baseRiskPercent
      : Math.max(
          BACKTEST_MONEY_MANAGEMENT_DEFAULTS.maximumRiskPercent,
          baseRiskPercent,
        )
  );

  if (minimumRiskPercent > baseRiskPercent) {
    throw new Error(
      'money_management_options.minimumRiskPercent não pode ser maior que baseRiskPercent.',
    );
  }
  if (baseRiskPercent > maximumRiskPercent) {
    throw new Error(
      'money_management_options.baseRiskPercent não pode ser maior que maximumRiskPercent.',
    );
  }

  return {
    mode,
    scope: 'strategy',
    baseRiskPercent,
    minimumRiskPercent,
    maximumRiskPercent,
    winMultiplier:
      input.winMultiplier ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.winMultiplier,
    lossMultiplier:
      input.lossMultiplier ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.lossMultiplier,
    lossReductionStart:
      input.lossReductionStart ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.lossReductionStart,
    martingaleLossMultiplier:
      input.martingaleLossMultiplier ??
      BACKTEST_MONEY_MANAGEMENT_DEFAULTS.martingaleLossMultiplier,
    maximumMultiplier:
      input.maximumMultiplier ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.maximumMultiplier,
    martingaleMaximumMultiplier:
      input.martingaleMaximumMultiplier ??
      BACKTEST_MONEY_MANAGEMENT_DEFAULTS.martingaleMaximumMultiplier,
    maximumSequenceSteps:
      input.maximumSequenceSteps ??
      BACKTEST_MONEY_MANAGEMENT_DEFAULTS.maximumSequenceSteps,
    pauseAfterConsecutiveLosses:
      input.pauseAfterConsecutiveLosses ??
      BACKTEST_MONEY_MANAGEMENT_DEFAULTS.pauseAfterConsecutiveLosses,
    balanceUsageLimitPct:
      input.balanceUsageLimitPct ??
      BACKTEST_MONEY_MANAGEMENT_DEFAULTS.balanceUsageLimitPct,
    compareWithFixed:
      input.compareWithFixed ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.compareWithFixed,
    policyVersion:
      input.policyVersion ?? BACKTEST_MONEY_MANAGEMENT_DEFAULTS.policyVersion,
  };
}

function fixedBacktestMoneyManagementPolicy(
  selected: ResolvedBacktestMoneyManagementOptions,
): ResolvedBacktestMoneyManagementOptions {
  return {
    ...selected,
    mode: 'fixed',
    minimumRiskPercent: selected.baseRiskPercent,
    maximumRiskPercent: selected.baseRiskPercent,
  };
}

function resolveBacktestSizingDecision(
  policy: ResolvedBacktestMoneyManagementOptions,
  equity: number,
  consecutiveWins: number,
  consecutiveLosses: number,
): Omit<
  BacktestSizingDecision,
  | 'plannedRiskUsdt'
  | 'actualRiskUsdt'
  | 'requestedQuantity'
  | 'effectiveQuantity'
  | 'effectiveQuoteAmount'
  | 'limitingRules'
> {
  let rawRiskMultiplier = 1;
  let sequenceStep = 0;

  if (policy.mode === 'anti_martingale') {
    if (consecutiveWins > 0) {
      sequenceStep = Math.min(consecutiveWins, policy.maximumSequenceSteps);
      rawRiskMultiplier = Math.min(
        Math.pow(policy.winMultiplier, sequenceStep),
        policy.maximumMultiplier,
      );
    } else if (consecutiveLosses >= policy.lossReductionStart) {
      sequenceStep = Math.min(
        consecutiveLosses - policy.lossReductionStart + 1,
        policy.maximumSequenceSteps,
      );
      rawRiskMultiplier = Math.max(
        Math.pow(policy.lossMultiplier, sequenceStep),
        policy.minimumRiskPercent / policy.baseRiskPercent,
      );
    }
  } else if (policy.mode === 'martingale_testnet' && consecutiveLosses > 0) {
    sequenceStep = Math.min(consecutiveLosses, policy.maximumSequenceSteps);
    rawRiskMultiplier = Math.min(
      Math.pow(policy.martingaleLossMultiplier, sequenceStep),
      policy.martingaleMaximumMultiplier,
    );
  }

  const targetRiskPercent = policy.baseRiskPercent * rawRiskMultiplier;
  const appliedRiskPercent = clampBacktestNumber(
    targetRiskPercent,
    policy.minimumRiskPercent,
    policy.maximumRiskPercent,
  );
  const riskMultiplier = policy.baseRiskPercent > 0
    ? appliedRiskPercent / policy.baseRiskPercent
    : 1;

  return {
    mode: policy.mode,
    scope: policy.scope,
    policyVersion: policy.policyVersion,
    baseRiskPercent: policy.baseRiskPercent,
    targetRiskPercent,
    appliedRiskPercent,
    riskMultiplier,
    rawRiskMultiplier,
    sequenceStep,
    consecutiveWinsBefore: consecutiveWins,
    consecutiveLossesBefore: consecutiveLosses,
    sequenceEligible: true,
    wouldPauseAutoTrade:
      policy.pauseAfterConsecutiveLosses > 0 &&
      consecutiveLosses >= policy.pauseAfterConsecutiveLosses,
  };
}

function classifyOverlayTradeResult(
  netPnlUsdt: number,
): BacktestTradeResult {
  if (netPnlUsdt > 1e-8) return 'win';
  if (netPnlUsdt < -1e-8) return 'loss';
  return 'breakeven';
}

function calculateOverlayMetrics(
  trades: readonly BacktestTradeWithSizing[],
  originalResult: TrendBreakoutBacktestResult | MultiStrategyBacktestResult,
): {
  metrics: TrendBreakoutBacktestMetrics | MultiStrategyBacktestMetrics;
  equityCurve: Array<{
    time: number;
    equityUsdt: number;
    drawdownUsdt: number;
    drawdownPct: number;
  }>;
} {
  const initialCapitalUsdt = originalResult.metrics.initialCapitalUsdt;
  const finalCapitalUsdt = trades.length > 0
    ? trades[trades.length - 1].equityAfter
    : initialCapitalUsdt;
  const netPnlUsdt = finalCapitalUsdt - initialCapitalUsdt;
  const wins = trades.filter((trade) => trade.result === 'win');
  const losses = trades.filter((trade) => trade.result === 'loss');
  const breakeven = trades.filter((trade) => trade.result === 'breakeven');
  const grossProfitUsdt = wins.reduce(
    (sum, trade) => sum + trade.netPnlUsdt,
    0,
  );
  const grossLossUsdt = Math.abs(
    losses.reduce((sum, trade) => sum + trade.netPnlUsdt, 0),
  );
  const rValues = trades.map((trade) => trade.resultR);

  let peak = initialCapitalUsdt;
  let maximumDrawdownUsdt = 0;
  let maximumDrawdownPct = 0;
  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let maximumConsecutiveWins = 0;
  let maximumConsecutiveLosses = 0;

  const equityCurve = [{
    time: trades[0]?.signalCandleOpenTime ?? originalResult.firstCandleOpenTime,
    equityUsdt: initialCapitalUsdt,
    drawdownUsdt: 0,
    drawdownPct: 0,
  }];

  for (const trade of trades) {
    peak = Math.max(peak, trade.equityAfter);
    const drawdownUsdt = peak - trade.equityAfter;
    const drawdownPct = peak > 0 ? (drawdownUsdt / peak) * 100 : 0;
    maximumDrawdownUsdt = Math.max(maximumDrawdownUsdt, drawdownUsdt);
    maximumDrawdownPct = Math.max(maximumDrawdownPct, drawdownPct);

    equityCurve.push({
      time: trade.exitTime,
      equityUsdt: trade.equityAfter,
      drawdownUsdt,
      drawdownPct,
    });

    if (trade.result === 'win') {
      consecutiveWins += 1;
      consecutiveLosses = 0;
    } else if (trade.result === 'loss') {
      consecutiveLosses += 1;
      consecutiveWins = 0;
    } else {
      consecutiveWins = 0;
      consecutiveLosses = 0;
    }

    maximumConsecutiveWins = Math.max(maximumConsecutiveWins, consecutiveWins);
    maximumConsecutiveLosses = Math.max(
      maximumConsecutiveLosses,
      consecutiveLosses,
    );
  }

  const averageR = rValues.length === 0
    ? 0
    : rValues.reduce((sum, value) => sum + value, 0) / rValues.length;

  const metrics = {
    ...originalResult.metrics,
    initialCapitalUsdt,
    finalCapitalUsdt,
    netPnlUsdt,
    netReturnPct:
      initialCapitalUsdt > 0 ? (netPnlUsdt / initialCapitalUsdt) * 100 : 0,
    enteredTrades: trades.length,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRatePct: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    grossProfitUsdt,
    grossLossUsdt,
    profitFactor:
      grossLossUsdt === 0 ? (grossProfitUsdt > 0 ? null : 0) : grossProfitUsdt / grossLossUsdt,
    averagePnlUsdt: trades.length === 0 ? 0 : netPnlUsdt / trades.length,
    averageR,
    medianR: medianBacktestValue(rValues),
    bestR: rValues.length === 0 ? 0 : Math.max(...rValues),
    worstR: rValues.length === 0 ? 0 : Math.min(...rValues),
    maximumDrawdownUsdt,
    maximumDrawdownPct,
    averageHoldingCandles:
      trades.length === 0
        ? 0
        : trades.reduce((sum, trade) => sum + trade.holdingCandles, 0) /
          trades.length,
    maximumConsecutiveWins,
    maximumConsecutiveLosses,
  } as TrendBreakoutBacktestMetrics | MultiStrategyBacktestMetrics;

  return { metrics, equityCurve };
}

function applyBacktestSizingOverlay(
  originalResult: TrendBreakoutBacktestResult | MultiStrategyBacktestResult,
  policy: ResolvedBacktestMoneyManagementOptions,
): BacktestSizingOverlay {
  const sourceTrades = originalResult.trades as Array<
    TrendBreakoutBacktestTrade | MultiStrategyBacktestTrade
  >;
  const options = originalResult.options;
  const stepSize = Number(options.stepSize) > 0 ? Number(options.stepSize) : 0;
  const minimumQuantity = Math.max(0, Number(options.minQuantity) || 0);
  const minimumNotional = Math.max(0, Number(options.minNotional) || 0);
  const maximumPositionNotional = Number.isFinite(Number(options.maxPositionNotional))
    ? Math.max(0, Number(options.maxPositionNotional))
    : Number.MAX_SAFE_INTEGER;
  const balanceUsageFraction = policy.balanceUsageLimitPct / 100;

  let equity = originalResult.metrics.initialCapitalUsdt;
  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let maximumEligibleConsecutiveWins = 0;
  let maximumEligibleConsecutiveLosses = 0;
  let maximumMultiplierApplied = 1;
  let maximumAppliedRiskPercent = policy.baseRiskPercent;
  let maximumSequenceStep = 0;
  let appliedRiskSum = 0;
  let pauseThresholdHits = 0;
  let forcedEndOfDataTrades = 0;
  let balanceLimitedTrades = 0;
  let notionalLimitedTrades = 0;
  let exchangeMinimumBlockedTrades = 0;
  let zeroQuantityTrades = 0;
  const limitingRuleCounts: Record<string, number> = {};
  const trades: BacktestTradeWithSizing[] = [];

  for (const sourceTrade of sourceTrades) {
    const baseDecision = resolveBacktestSizingDecision(
      policy,
      equity,
      consecutiveWins,
      consecutiveLosses,
    );
    const limitingRules: string[] = [];
    const sourceQuantity = Math.max(0, Number(sourceTrade.quantity) || 0);
    const sourceInitialRiskUsdt = Math.max(
      0,
      Number(sourceTrade.initialRiskUsdt) || 0,
    );
    const estimatedRiskPerUnit =
      sourceQuantity > 0 && sourceInitialRiskUsdt > 0
        ? sourceInitialRiskUsdt / sourceQuantity
        : Math.max(
            0,
            (Number(sourceTrade.entryPrice) || 0) -
              (Number(sourceTrade.stopPrice) || 0),
          );
    const plannedRiskUsdt = Math.max(
      0,
      equity * (baseDecision.appliedRiskPercent / 100),
    );
    const requestedQuantity = estimatedRiskPerUnit > 0
      ? plannedRiskUsdt / estimatedRiskPerUnit
      : 0;
    const entryPrice = Math.max(0, Number(sourceTrade.entryPrice) || 0);
    const entryFeePerUnit = sourceQuantity > 0
      ? Math.max(0, Number(sourceTrade.entryFeeUsdt) || 0) / sourceQuantity
      : entryPrice * ((Number(options.feeRatePct) || 0) / 100);
    const availableCapital = Math.max(0, equity * balanceUsageFraction);
    const cashRequiredPerUnit = Math.max(
      Number.EPSILON,
      entryPrice + entryFeePerUnit,
    );
    const balanceQuantityLimit = availableCapital / cashRequiredPerUnit;
    const notionalQuantityLimit = entryPrice > 0
      ? maximumPositionNotional / entryPrice
      : 0;

    let effectiveQuantity = Math.min(
      requestedQuantity,
      balanceQuantityLimit,
      notionalQuantityLimit,
    );

    if (balanceQuantityLimit + 1e-12 < requestedQuantity) {
      limitingRules.push('balance_usage_limit');
      balanceLimitedTrades += 1;
    }
    if (notionalQuantityLimit + 1e-12 < requestedQuantity) {
      limitingRules.push('maximum_position_notional');
      notionalLimitedTrades += 1;
    }

    effectiveQuantity = floorBacktestQuantity(effectiveQuantity, stepSize);
    let effectiveQuoteAmount = entryPrice * effectiveQuantity;

    if (
      effectiveQuantity <= 0 ||
      effectiveQuantity + 1e-12 < minimumQuantity ||
      effectiveQuoteAmount + 1e-8 < minimumNotional
    ) {
      if (effectiveQuantity + 1e-12 < minimumQuantity) {
        limitingRules.push('minimum_quantity');
      }
      if (effectiveQuoteAmount + 1e-8 < minimumNotional) {
        limitingRules.push('minimum_notional');
      }
      limitingRules.push('position_sizing_blocked');
      exchangeMinimumBlockedTrades += 1;
      effectiveQuantity = 0;
      effectiveQuoteAmount = 0;
    }

    if (effectiveQuantity <= 0) zeroQuantityTrades += 1;

    const quantityRatio = sourceQuantity > 0
      ? effectiveQuantity / sourceQuantity
      : 0;
    const entryFeeUsdt = (Number(sourceTrade.entryFeeUsdt) || 0) * quantityRatio;
    const exitFeeUsdt = (Number(sourceTrade.exitFeeUsdt) || 0) * quantityRatio;
    const totalFeesUsdt = entryFeeUsdt + exitFeeUsdt;
    const grossPnlUsdt = (Number(sourceTrade.grossPnlUsdt) || 0) * quantityRatio;
    const netPnlUsdt = grossPnlUsdt - totalFeesUsdt;
    const actualRiskUsdt = estimatedRiskPerUnit * effectiveQuantity;
    const resultR = actualRiskUsdt > 0 ? netPnlUsdt / actualRiskUsdt : 0;
    const result = classifyOverlayTradeResult(netPnlUsdt);
    const equityBefore = equity;
    const equityAfter = Math.max(0, equityBefore + netPnlUsdt);
    const sequenceEligible = sourceTrade.exitReason !== 'end_of_data';
    const wouldPauseAutoTrade =
      baseDecision.wouldPauseAutoTrade ||
      (
        sequenceEligible &&
        result === 'loss' &&
        policy.pauseAfterConsecutiveLosses > 0 &&
        consecutiveLosses + 1 >= policy.pauseAfterConsecutiveLosses
      );

    if (wouldPauseAutoTrade) pauseThresholdHits += 1;
    if (!sequenceEligible) forcedEndOfDataTrades += 1;

    const sizingDecision: BacktestSizingDecision = {
      ...baseDecision,
      sequenceEligible,
      wouldPauseAutoTrade,
      plannedRiskUsdt,
      actualRiskUsdt,
      requestedQuantity,
      effectiveQuantity,
      effectiveQuoteAmount,
      limitingRules,
    };

    for (const rule of limitingRules) {
      limitingRuleCounts[rule] = (limitingRuleCounts[rule] ?? 0) + 1;
    }

    maximumMultiplierApplied = Math.max(
      maximumMultiplierApplied,
      baseDecision.riskMultiplier,
    );
    maximumAppliedRiskPercent = Math.max(
      maximumAppliedRiskPercent,
      baseDecision.appliedRiskPercent,
    );
    maximumSequenceStep = Math.max(maximumSequenceStep, baseDecision.sequenceStep);
    appliedRiskSum += baseDecision.appliedRiskPercent;

    trades.push({
      ...sourceTrade,
      quantity: effectiveQuantity,
      entryNotional: effectiveQuoteAmount,
      initialRiskUsdt: actualRiskUsdt,
      entryFeeUsdt,
      exitFeeUsdt,
      totalFeesUsdt,
      grossPnlUsdt,
      netPnlUsdt,
      resultR,
      result,
      equityBefore,
      equityAfter,
      sizingMode: policy.mode,
      sizingScope: policy.scope,
      sizingPolicyVersion: policy.policyVersion,
      baseRiskPercent: policy.baseRiskPercent,
      targetRiskPercent: baseDecision.targetRiskPercent,
      appliedRiskPercent: baseDecision.appliedRiskPercent,
      riskMultiplier: baseDecision.riskMultiplier,
      rawRiskMultiplier: baseDecision.rawRiskMultiplier,
      sequenceStep: baseDecision.sequenceStep,
      consecutiveWinsBefore: consecutiveWins,
      consecutiveLossesBefore: consecutiveLosses,
      sequenceEligible,
      wouldPauseAutoTrade,
      plannedRiskUsdt,
      actualRiskUsdt,
      requestedQuantity,
      effectiveQuantity,
      effectiveQuoteAmount,
      fixedRiskEquivalentPnlUsdt: null,
      sizingEffectPnlUsdt: null,
      limitingRules,
      sizingDecision,
    } as BacktestTradeWithSizing);

    equity = equityAfter;

    if (sequenceEligible) {
      if (result === 'win') {
        consecutiveWins += 1;
        consecutiveLosses = 0;
      } else if (result === 'loss') {
        consecutiveLosses += 1;
        consecutiveWins = 0;
      } else {
        consecutiveWins = 0;
        consecutiveLosses = 0;
      }

      maximumEligibleConsecutiveWins = Math.max(
        maximumEligibleConsecutiveWins,
        consecutiveWins,
      );
      maximumEligibleConsecutiveLosses = Math.max(
        maximumEligibleConsecutiveLosses,
        consecutiveLosses,
      );
    }
  }

  const calculated = calculateOverlayMetrics(trades, originalResult);
  const warnings = [...originalResult.warnings];

  if (policy.mode === 'martingale_testnet') {
    warnings.push(
      'Martingale é experimental e deve permanecer restrito ao backtest e à Binance Spot Testnet.',
    );
  }
  if (forcedEndOfDataTrades > 0) {
    warnings.push(
      `${forcedEndOfDataTrades} operação(ões) encerrada(s) por fim dos dados não alimentaram a sequência do gerenciamento de risco.`,
    );
  }
  if (zeroQuantityTrades > 0) {
    warnings.push(
      `${zeroQuantityTrades} operação(ões) mantiveram o caminho técnico, mas ficaram com quantidade zero por limites de saldo ou mínimos de negociação.`,
    );
  }

  const summary = {
    maximumMultiplierApplied,
    maximumAppliedRiskPercent,
    averageAppliedRiskPercent:
      trades.length === 0 ? 0 : appliedRiskSum / trades.length,
    maximumSequenceStep,
    maximumEligibleConsecutiveWins,
    maximumEligibleConsecutiveLosses,
    pauseThresholdHits,
    forcedEndOfDataTrades,
    balanceLimitedTrades,
    notionalLimitedTrades,
    exchangeMinimumBlockedTrades,
    zeroQuantityTrades,
    limitingRuleCounts,
  };

  const result = {
    ...originalResult,
    metrics: calculated.metrics,
    trades,
    equityCurve: calculated.equityCurve,
    warnings,
    moneyManagement: {
      applied: true,
      riskAtStopSizing: true,
      sameSignalAndExitPath: true,
      policy,
      summary,
    },
  } as BacktestResultWithSizing;

  return { result, summary };
}

function enrichBacktestResultWithMoneyManagement(
  originalResult: TrendBreakoutBacktestResult | MultiStrategyBacktestResult,
  policy: ResolvedBacktestMoneyManagementOptions,
): BacktestResultWithSizing {
  const selectedOverlay = applyBacktestSizingOverlay(originalResult, policy);
  const fixedPolicy = fixedBacktestMoneyManagementPolicy(policy);
  const fixedOverlay = applyBacktestSizingOverlay(originalResult, fixedPolicy);
  const selectedTrades = selectedOverlay.result.trades;
  const fixedTrades = fixedOverlay.result.trades;
  const fixedById = new Map(fixedTrades.map((trade) => [trade.id, trade]));

  for (const trade of selectedTrades) {
    const fixedTrade = fixedById.get(trade.id);
    const fixedPnl = fixedTrade?.netPnlUsdt ?? null;
    trade.fixedRiskEquivalentPnlUsdt = fixedPnl;
    trade.sizingEffectPnlUsdt = fixedPnl === null
      ? null
      : trade.netPnlUsdt - fixedPnl;
  }

  const selectedMetrics = selectedOverlay.result.metrics;
  const fixedMetrics = fixedOverlay.result.metrics;
  const sameTradePath =
    selectedTrades.length === fixedTrades.length &&
    selectedTrades.every((trade, index) => {
      const fixedTrade = fixedTrades[index];
      return Boolean(
        fixedTrade &&
        trade.id === fixedTrade.id &&
        trade.entryTime === fixedTrade.entryTime &&
        trade.exitTime === fixedTrade.exitTime &&
        trade.exitReason === fixedTrade.exitReason
      );
    });

  selectedOverlay.result.moneyManagement = {
    ...(selectedOverlay.result.moneyManagement ?? {}),
    comparisonToFixed: policy.compareWithFixed
      ? {
          enabled: true,
          sameTradePath,
          fixedPolicy,
          selected: {
            finalCapitalUsdt: selectedMetrics.finalCapitalUsdt,
            netPnlUsdt: selectedMetrics.netPnlUsdt,
            netReturnPct: selectedMetrics.netReturnPct,
            maximumDrawdownUsdt: selectedMetrics.maximumDrawdownUsdt,
            maximumDrawdownPct: selectedMetrics.maximumDrawdownPct,
          },
          fixed: {
            finalCapitalUsdt: fixedMetrics.finalCapitalUsdt,
            netPnlUsdt: fixedMetrics.netPnlUsdt,
            netReturnPct: fixedMetrics.netReturnPct,
            maximumDrawdownUsdt: fixedMetrics.maximumDrawdownUsdt,
            maximumDrawdownPct: fixedMetrics.maximumDrawdownPct,
          },
          effect: {
            pnlUsdt: selectedMetrics.netPnlUsdt - fixedMetrics.netPnlUsdt,
            returnPct: selectedMetrics.netReturnPct - fixedMetrics.netReturnPct,
            drawdownUsdt:
              selectedMetrics.maximumDrawdownUsdt - fixedMetrics.maximumDrawdownUsdt,
            drawdownPct:
              selectedMetrics.maximumDrawdownPct - fixedMetrics.maximumDrawdownPct,
          },
          fixedEquityCurve: fixedOverlay.result.equityCurve,
        }
      : { enabled: false },
  };

  return selectedOverlay.result;
}

function rebuildComparisonWithMoneyManagement(
  comparison: DayTradeBacktestComparisonResult,
  policy: ResolvedBacktestMoneyManagementOptions,
): DayTradeBacktestComparisonResult & { moneyManagement: Record<string, unknown> } {
  const enhancedResults: Partial<
    Record<DayTradeStrategyId, MultiStrategyBacktestResult>
  > = {};
  const fixedRows: DayTradeBacktestComparisonRow[] = [];

  for (const strategyId of comparison.strategyIds) {
    const originalResult = comparison.results[strategyId];
    if (!originalResult) continue;

    const enhanced = enrichBacktestResultWithMoneyManagement(
      originalResult,
      policy,
    );
    enhancedResults[strategyId] = enhanced as MultiStrategyBacktestResult;

    const fixedPolicy = fixedBacktestMoneyManagementPolicy(policy);
    const fixed = applyBacktestSizingOverlay(originalResult, fixedPolicy).result;
    fixedRows.push(
      createComparisonRow(
        fixed as MultiStrategyBacktestResult,
        comparison.minimumTradesForRanking,
      ),
    );
  }

  const rows = comparison.strategyIds
    .map((strategyId) => enhancedResults[strategyId])
    .filter((result): result is MultiStrategyBacktestResult => result !== undefined)
    .map((result) =>
      createComparisonRow(result, comparison.minimumTradesForRanking)
    );
  const mainRanking = rows
    .filter((row) => row.eligibleForMainRanking)
    .sort(compareMainRankingRows);
  const provisionalRanking = rows
    .filter((row) => !row.eligibleForMainRanking)
    .sort(compareProvisionalRows);
  const candidatesForFurtherValidation = mainRanking.filter(
    (row) =>
      row.profitable &&
      row.positiveExpectancy &&
      (row.profitFactor === null || row.profitFactor > 1) &&
      row.controlledDrawdown,
  );

  return {
    ...comparison,
    results: enhancedResults,
    rows,
    mainRanking,
    provisionalRanking,
    leaders: createComparisonLeaders(rows),
    candidatesForFurtherValidation,
    warnings: [
      ...comparison.warnings,
      'O ranking principal foi recalculado após o gerenciamento de risco, mantendo o mesmo caminho técnico de cada estratégia.',
      ...(policy.mode === 'martingale_testnet'
        ? ['Martingale permanece experimental e restrito a backtest/Testnet.']
        : []),
    ],
    moneyManagement: {
      applied: true,
      policy,
      fixedRows,
      fixedLeaders: createComparisonLeaders(fixedRows),
      sameSignalAndExitPath: true,
    },
  };
}

// ============================================================================
// SEÇÃO 12: motor compartilhado para análises aprofundadas
// ============================================================================

/**
 * Este arquivo é usado pelo worker de backtests extensos.
 *
 * Princípios:
 * - os candles são buscados em páginas, mas o backtest é executado sobre uma
 *   série única, contínua, ordenada e deduplicada;
 * - nenhum resultado de bloco é simplesmente somado;
 * - capital, posição, drawdown, aquecimento e indicadores pertencem à mesma
 *   execução, preservando a continuidade temporal;
 * - não acessa chaves da Binance e não cria ordens.
 */

export type DeepBacktestMode = 'single' | 'compare_all';
export type DeepBacktestPhase =
  | 'fetching_candles'
  | 'normalizing_candles'
  | 'running_backtest'
  | 'building_analytics'
  | 'completed';

export interface DeepBacktestProgress {
  phase: DeepBacktestPhase;
  progressPct: number;
  processedCandles: number;
  totalCandles: number;
  message: string;
}

export type DeepBacktestProgressCallback = (
  progress: DeepBacktestProgress,
) => void | Promise<void>;

export interface FetchDeepBacktestCandlesInput {
  symbol: string;
  timeframe: DayTradeIndicatorTimeframe;
  startTime: number;
  endTime: number;
  maximumCandles?: number;
  requestTimeoutMs?: number;
  onProgress?: DeepBacktestProgressCallback;
}

export interface DeepBacktestInput {
  mode: DeepBacktestMode;
  strategyId?: DayTradeStrategyId;
  symbol: string;
  timeframe: DayTradeIndicatorTimeframe;
  startTime: number;
  endTime: number;
  strategyOptions?: Partial<DayTradeBacktestStrategyOptionsMap>;
  backtestOptions?: MultiStrategyBacktestOptions;
  comparisonOptions?: CompareDayTradeBacktestsOptions;
  moneyManagementOptions?: ResolvedBacktestMoneyManagementOptions | null;
  maximumCandles?: number;
  requestTimeoutMs?: number;
  onProgress?: DeepBacktestProgressCallback;
}

export type DeepBacktestTrade =
  | TrendBreakoutBacktestTrade
  | MultiStrategyBacktestTrade;

export type DeepBacktestStrategyResult =
  | TrendBreakoutBacktestResult
  | MultiStrategyBacktestResult;

export type DeepMarketRegime = 'alta' | 'baixa' | 'lateral';

export interface DeepPerformanceBreakdownRow {
  key: string;
  label: string;
  startTime: number;
  endTime: number;
  marketRegime: DeepMarketRegime | null;
  marketReturnPct: number | null;
  candleCount: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number;
  grossProfitUsdt: number;
  grossLossUsdt: number;
  netPnlUsdt: number;
  returnOnStartingEquityPct: number;
  profitFactor: number | null;
  averagePnlUsdt: number;
  averageR: number;
  bestR: number;
  worstR: number;
  maximumDrawdownUsdt: number;
  maximumDrawdownPct: number;
  averageHoldingCandles: number;
}

export interface DeepVolatilityBreakdownRow
  extends Omit<
    DeepPerformanceBreakdownRow,
    'startTime' | 'endTime' | 'marketRegime' | 'marketReturnPct' | 'candleCount'
  > {
  volatilityRegime: string;
}

export interface DeepStrategyAnalytics {
  strategy: DayTradeStrategyId;
  strategyVersion: string;
  monthly: DeepPerformanceBreakdownRow[];
  quarterly: DeepPerformanceBreakdownRow[];
  byVolatilityRegime: DeepVolatilityBreakdownRow[];
  byMarketRegime: Array<
    DeepPerformanceBreakdownRow & {
      marketRegime: DeepMarketRegime;
    }
  >;
  consistency: {
    profitableMonths: number;
    losingMonths: number;
    breakevenMonths: number;
    profitableMonthsPct: number;
    bestMonth: DeepPerformanceBreakdownRow | null;
    worstMonth: DeepPerformanceBreakdownRow | null;
    longestProfitableMonthStreak: number;
    longestLosingMonthStreak: number;
  };
}

export interface DeepBacktestAnalytics {
  generatedAt: string;
  candleCount: number;
  firstCandleOpenTime: number;
  lastCandleCloseTime: number;
  continuity: {
    continuousSeries: true;
    independentBlockSummation: false;
    indicatorsPreservedAcrossPages: true;
    equityPreservedAcrossPages: true;
    openPositionPreservedAcrossPages: true;
  };
  strategies: Partial<Record<DayTradeStrategyId, DeepStrategyAnalytics>>;
}

export interface DeepBacktestExecutionResult {
  ok: true;
  mode: DeepBacktestMode;
  strategy: DayTradeStrategyId | null;
  symbol: string;
  timeframe: DayTradeIndicatorTimeframe;
  startTime: number;
  endTime: number;
  candleCount: number;
  executionMs: number;
  generatedAt: string;
  result?: DeepBacktestStrategyResult;
  comparison?: DayTradeBacktestComparisonResult & {
    moneyManagement?: Record<string, unknown>;
  };
  moneyManagement: ResolvedBacktestMoneyManagementOptions | null;
  analytics: DeepBacktestAnalytics;
}

const DEEP_PUBLIC_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const DEEP_TIMEFRAME_MILLISECONDS: Record<
  DayTradeIndicatorTimeframe,
  number
> = {
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
};

const DEEP_MAXIMUM_CANDLES = 220_000;
const DEEP_BINANCE_PAGE_SIZE = 1_000;
const DEEP_REQUEST_TIMEOUT_MS = 15_000;
const DEEP_MARKET_REGIME_THRESHOLD_PCT = 3;

function deepFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function deepRound(value: number, decimals = 8): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function deepClamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

async function emitDeepProgress(
  callback: DeepBacktestProgressCallback | undefined,
  progress: DeepBacktestProgress,
): Promise<void> {
  if (!callback) return;
  await callback({
    ...progress,
    progressPct: deepClamp(progress.progressPct, 0, 100),
  });
}

function validateDeepRange(input: FetchDeepBacktestCandlesInput): void {
  if (!/^[A-Z0-9]{5,20}$/.test(input.symbol) || !input.symbol.endsWith('USDT')) {
    throw new Error('symbol inválido; use um par Spot cotado em USDT.');
  }

  if (!(input.timeframe in DEEP_TIMEFRAME_MILLISECONDS)) {
    throw new Error('timeframe deve ser 5m, 15m, 30m ou 1h.');
  }

  if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime)) {
    throw new Error('startTime e endTime devem ser timestamps válidos.');
  }

  if (input.startTime < 0 || input.endTime <= input.startTime) {
    throw new Error('O período informado é inválido.');
  }
}

function estimateDeepCandleCount(
  timeframe: DayTradeIndicatorTimeframe,
  startTime: number,
  endTime: number,
): number {
  return Math.max(
    0,
    Math.ceil(
      (endTime - startTime) /
        DEEP_TIMEFRAME_MILLISECONDS[timeframe],
    ),
  );
}

async function deepFetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

function parseDeepBinanceKline(row: unknown): DayTradeCandle | null {
  if (!Array.isArray(row) || row.length < 7) return null;

  const openTime = deepFiniteNumber(row[0]);
  const open = deepFiniteNumber(row[1]);
  const high = deepFiniteNumber(row[2]);
  const low = deepFiniteNumber(row[3]);
  const close = deepFiniteNumber(row[4]);
  const volume = deepFiniteNumber(row[5]);
  const closeTime = deepFiniteNumber(row[6]);
  const quoteVolume = deepFiniteNumber(row[7]) ?? 0;

  if (
    openTime === null ||
    closeTime === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  ) {
    return null;
  }

  return {
    openTime,
    closeTime,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    isClosed: true,
  };
}

async function fetchDeepKlinePage(
  symbol: string,
  timeframe: DayTradeIndicatorTimeframe,
  startTime: number,
  endTime: number,
  limit: number,
  timeoutMs: number,
): Promise<DayTradeCandle[]> {
  const errors: string[] = [];

  for (const baseUrl of DEEP_PUBLIC_BASE_URLS) {
    const url = new URL('/api/v3/klines', baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', timeframe);
    url.searchParams.set('startTime', String(startTime));
    url.searchParams.set('endTime', String(Math.max(startTime, endTime - 1)));
    url.searchParams.set('limit', String(limit));

    try {
      const response = await deepFetchWithTimeout(url.toString(), timeoutMs);
      const text = await response.text();

      if (!response.ok) {
        errors.push(`${baseUrl}: HTTP ${response.status} ${text.slice(0, 160)}`);
        continue;
      }

      const decoded = JSON.parse(text);
      if (!Array.isArray(decoded)) {
        errors.push(`${baseUrl}: resposta inesperada`);
        continue;
      }

      return decoded
        .map(parseDeepBinanceKline)
        .filter((item): item is DayTradeCandle => item !== null);
    } catch (error) {
      errors.push(
        `${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Não foi possível consultar candles públicos da Binance. ${errors.join(' | ')}`,
  );
}

export async function fetchDeepBacktestCandles(
  input: FetchDeepBacktestCandlesInput,
): Promise<DayTradeCandle[]> {
  validateDeepRange(input);

  const maximumCandles = Math.floor(
    input.maximumCandles ?? DEEP_MAXIMUM_CANDLES,
  );
  const timeoutMs = Math.floor(
    input.requestTimeoutMs ?? DEEP_REQUEST_TIMEOUT_MS,
  );

  if (maximumCandles < 350 || maximumCandles > DEEP_MAXIMUM_CANDLES) {
    throw new Error(
      `maximumCandles deve estar entre 350 e ${DEEP_MAXIMUM_CANDLES}.`,
    );
  }

  const estimatedCandles = estimateDeepCandleCount(
    input.timeframe,
    input.startTime,
    input.endTime,
  );

  if (estimatedCandles > maximumCandles) {
    throw new Error(
      `O período possui aproximadamente ${estimatedCandles} candles, acima do limite de ${maximumCandles}.`,
    );
  }

  const byOpenTime = new Map<number, DayTradeCandle>();
  const timeframeMs = DEEP_TIMEFRAME_MILLISECONDS[input.timeframe];
  const now = Date.now();
  const effectiveEndTime = Math.min(input.endTime, now);
  let cursor = input.startTime;
  let previousCursor = -1;

  await emitDeepProgress(input.onProgress, {
    phase: 'fetching_candles',
    progressPct: 1,
    processedCandles: 0,
    totalCandles: estimatedCandles,
    message: 'Iniciando a busca paginada dos candles públicos.',
  });

  while (cursor < effectiveEndTime) {
    if (cursor <= previousCursor) {
      throw new Error('A paginação dos candles deixou de avançar.');
    }
    previousCursor = cursor;

    const remainingEstimate = Math.max(
      1,
      Math.ceil((effectiveEndTime - cursor) / timeframeMs),
    );
    const pageLimit = Math.min(DEEP_BINANCE_PAGE_SIZE, remainingEstimate);

    const page = await fetchDeepKlinePage(
      input.symbol,
      input.timeframe,
      cursor,
      effectiveEndTime,
      pageLimit,
      timeoutMs,
    );

    if (page.length === 0) break;

    let latestOpenTime = cursor;
    for (const candle of page) {
      latestOpenTime = Math.max(latestOpenTime, candle.openTime);

      if (
        candle.openTime >= input.startTime &&
        candle.openTime < effectiveEndTime &&
        candle.closeTime < now
      ) {
        byOpenTime.set(candle.openTime, candle);
      }
    }

    if (byOpenTime.size > maximumCandles) {
      throw new Error(
        `O histórico ultrapassou o limite de ${maximumCandles} candles.`,
      );
    }

    const elapsedRatio =
      (Math.min(latestOpenTime + timeframeMs, effectiveEndTime) - input.startTime) /
      (effectiveEndTime - input.startTime);

    await emitDeepProgress(input.onProgress, {
      phase: 'fetching_candles',
      progressPct: 2 + deepClamp(elapsedRatio, 0, 1) * 68,
      processedCandles: byOpenTime.size,
      totalCandles: estimatedCandles,
      message: `Baixados ${byOpenTime.size} de aproximadamente ${estimatedCandles} candles.`,
    });

    const nextCursor = latestOpenTime + timeframeMs;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;

    if (page.length < pageLimit) break;
  }

  await emitDeepProgress(input.onProgress, {
    phase: 'normalizing_candles',
    progressPct: 72,
    processedCandles: byOpenTime.size,
    totalCandles: estimatedCandles,
    message: 'Ordenando, validando e deduplicando o histórico.',
  });

  const candles = normalizeClosedCandles([...byOpenTime.values()]).filter(
    (candle) =>
      candle.openTime >= input.startTime &&
      candle.openTime < effectiveEndTime &&
      candle.closeTime < now,
  );

  if (candles.length < 350) {
    throw new Error(
      `Foram obtidos apenas ${candles.length} candles encerrados. O mínimo é 350.`,
    );
  }

  return candles;
}

function deepLegacyTrendBreakoutOptions(
  options: MultiStrategyBacktestOptions = {},
): TrendBreakoutBacktestOptions {
  return {
    initialCapitalUsdt: options.initialCapitalUsdt,
    riskPercent: options.riskPercent,
    feeRatePct: options.feeRatePct,
    slippagePct: options.slippagePct,
    stepSize: options.stepSize,
    minQuantity: options.minQuantity,
    minNotional: options.minNotional,
    maxPositionNotional: options.maxPositionNotional,
    intrabarPriority: options.intrabarPriority,
    maximumHoldingCandles: options.maximumHoldingCandles,
    maximumNextOpenDistanceAtr: options.maximumNextOpenDistanceAtr,
  };
}

function deepTradeResult(trade: DeepBacktestTrade): 'win' | 'loss' | 'breakeven' {
  if (trade.netPnlUsdt > 0) return 'win';
  if (trade.netPnlUsdt < 0) return 'loss';
  return 'breakeven';
}

function calculateTradeGroupMetrics(
  key: string,
  label: string,
  trades: readonly DeepBacktestTrade[],
  startTime: number,
  endTime: number,
  startingEquity: number,
  candleCount: number,
  marketRegime: DeepMarketRegime | null,
  marketReturnPct: number | null,
): DeepPerformanceBreakdownRow {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const wins = ordered.filter((trade) => deepTradeResult(trade) === 'win').length;
  const losses = ordered.filter((trade) => deepTradeResult(trade) === 'loss').length;
  const breakeven = ordered.length - wins - losses;
  const grossProfitUsdt = ordered.reduce(
    (sum, trade) => sum + Math.max(0, trade.netPnlUsdt),
    0,
  );
  const grossLossUsdt = Math.abs(
    ordered.reduce(
      (sum, trade) => sum + Math.min(0, trade.netPnlUsdt),
      0,
    ),
  );
  const netPnlUsdt = ordered.reduce((sum, trade) => sum + trade.netPnlUsdt, 0);
  const averageR = ordered.length === 0
    ? 0
    : ordered.reduce((sum, trade) => sum + trade.resultR, 0) / ordered.length;
  const averagePnlUsdt = ordered.length === 0 ? 0 : netPnlUsdt / ordered.length;
  const averageHoldingCandles = ordered.length === 0
    ? 0
    : ordered.reduce((sum, trade) => sum + trade.holdingCandles, 0) /
      ordered.length;

  let equity = startingEquity;
  let peak = startingEquity;
  let maximumDrawdownUsdt = 0;
  let maximumDrawdownPct = 0;

  for (const trade of ordered) {
    equity += trade.netPnlUsdt;
    peak = Math.max(peak, equity);
    const drawdownUsdt = Math.max(0, peak - equity);
    const drawdownPct = peak <= 0 ? 0 : (drawdownUsdt / peak) * 100;
    maximumDrawdownUsdt = Math.max(maximumDrawdownUsdt, drawdownUsdt);
    maximumDrawdownPct = Math.max(maximumDrawdownPct, drawdownPct);
  }

  const rValues = ordered.map((trade) => trade.resultR);

  return {
    key,
    label,
    startTime,
    endTime,
    marketRegime,
    marketReturnPct:
      marketReturnPct === null ? null : deepRound(marketReturnPct, 6),
    candleCount,
    totalTrades: ordered.length,
    wins,
    losses,
    breakeven,
    winRatePct: ordered.length === 0 ? 0 : deepRound((wins / ordered.length) * 100, 6),
    grossProfitUsdt: deepRound(grossProfitUsdt),
    grossLossUsdt: deepRound(grossLossUsdt),
    netPnlUsdt: deepRound(netPnlUsdt),
    returnOnStartingEquityPct:
      startingEquity <= 0 ? 0 : deepRound((netPnlUsdt / startingEquity) * 100, 6),
    profitFactor:
      grossLossUsdt > 0
        ? deepRound(grossProfitUsdt / grossLossUsdt, 8)
        : grossProfitUsdt > 0
          ? null
          : 0,
    averagePnlUsdt: deepRound(averagePnlUsdt),
    averageR: deepRound(averageR, 8),
    bestR: rValues.length === 0 ? 0 : deepRound(Math.max(...rValues), 8),
    worstR: rValues.length === 0 ? 0 : deepRound(Math.min(...rValues), 8),
    maximumDrawdownUsdt: deepRound(maximumDrawdownUsdt),
    maximumDrawdownPct: deepRound(maximumDrawdownPct, 6),
    averageHoldingCandles: deepRound(averageHoldingCandles, 4),
  };
}

function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function quarterKey(timestamp: number): string {
  const date = new Date(timestamp);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}

function marketRegimeFromReturn(returnPct: number): DeepMarketRegime {
  if (returnPct >= DEEP_MARKET_REGIME_THRESHOLD_PCT) return 'alta';
  if (returnPct <= -DEEP_MARKET_REGIME_THRESHOLD_PCT) return 'baixa';
  return 'lateral';
}

interface CandlePeriodSummary {
  key: string;
  label: string;
  startTime: number;
  endTime: number;
  candleCount: number;
  firstClose: number;
  lastClose: number;
  marketReturnPct: number;
  marketRegime: DeepMarketRegime;
}

function buildCandlePeriodSummaries(
  candles: readonly DayTradeCandle[],
  keyResolver: (timestamp: number) => string,
): Map<string, CandlePeriodSummary> {
  const grouped = new Map<string, DayTradeCandle[]>();

  for (const candle of candles) {
    const key = keyResolver(candle.openTime);
    const existing = grouped.get(key);
    if (existing) existing.push(candle);
    else grouped.set(key, [candle]);
  }

  const result = new Map<string, CandlePeriodSummary>();

  for (const [key, values] of grouped) {
    values.sort((a, b) => a.openTime - b.openTime);
    const first = values[0];
    const last = values[values.length - 1];
    const marketReturnPct = ((last.close / first.close) - 1) * 100;

    result.set(key, {
      key,
      label: key,
      startTime: first.openTime,
      endTime: last.closeTime,
      candleCount: values.length,
      firstClose: first.close,
      lastClose: last.close,
      marketReturnPct,
      marketRegime: marketRegimeFromReturn(marketReturnPct),
    });
  }

  return result;
}

function groupTradesByKey(
  trades: readonly DeepBacktestTrade[],
  keyResolver: (timestamp: number) => string,
): Map<string, DeepBacktestTrade[]> {
  const grouped = new Map<string, DeepBacktestTrade[]>();

  for (const trade of trades) {
    const key = keyResolver(trade.entryTime);
    const existing = grouped.get(key);
    if (existing) existing.push(trade);
    else grouped.set(key, [trade]);
  }

  return grouped;
}

function buildTemporalBreakdown(
  candles: readonly DayTradeCandle[],
  trades: readonly DeepBacktestTrade[],
  startingEquity: number,
  keyResolver: (timestamp: number) => string,
): DeepPerformanceBreakdownRow[] {
  const candlePeriods = buildCandlePeriodSummaries(candles, keyResolver);
  const tradeGroups = groupTradesByKey(trades, keyResolver);
  const rows: DeepPerformanceBreakdownRow[] = [];
  let runningEquity = startingEquity;

  for (const period of [...candlePeriods.values()].sort(
    (a, b) => a.startTime - b.startTime,
  )) {
    const periodTrades = tradeGroups.get(period.key) ?? [];
    const row = calculateTradeGroupMetrics(
      period.key,
      period.label,
      periodTrades,
      period.startTime,
      period.endTime,
      runningEquity,
      period.candleCount,
      period.marketRegime,
      period.marketReturnPct,
    );
    rows.push(row);
    runningEquity += row.netPnlUsdt;
  }

  return rows;
}

function buildVolatilityBreakdown(
  trades: readonly DeepBacktestTrade[],
  startingEquity: number,
): DeepVolatilityBreakdownRow[] {
  const grouped = new Map<string, DeepBacktestTrade[]>();

  for (const trade of trades) {
    const regime = 'signalVolatilityRegime' in trade
      ? String(trade.signalVolatilityRegime)
      : 'indisponível';
    const existing = grouped.get(regime);
    if (existing) existing.push(trade);
    else grouped.set(regime, [trade]);
  }

  return [...grouped.entries()]
    .map(([regime, values]) => {
      const base = calculateTradeGroupMetrics(
        regime,
        regime,
        values,
        values.length === 0 ? 0 : Math.min(...values.map((trade) => trade.entryTime)),
        values.length === 0 ? 0 : Math.max(...values.map((trade) => trade.exitTime)),
        startingEquity,
        0,
        null,
        null,
      );

      const {
        startTime: _startTime,
        endTime: _endTime,
        marketRegime: _marketRegime,
        marketReturnPct: _marketReturnPct,
        candleCount: _candleCount,
        ...rest
      } = base;

      return {
        ...rest,
        volatilityRegime: regime,
      };
    })
    .sort((a, b) => b.totalTrades - a.totalTrades);
}

function buildMarketRegimeBreakdown(
  monthly: readonly DeepPerformanceBreakdownRow[],
  trades: readonly DeepBacktestTrade[],
  startingEquity: number,
): Array<DeepPerformanceBreakdownRow & { marketRegime: DeepMarketRegime }> {
  const monthRegime = new Map<string, DeepMarketRegime>();
  for (const row of monthly) {
    if (row.marketRegime) monthRegime.set(row.key, row.marketRegime);
  }

  const grouped = new Map<DeepMarketRegime, DeepBacktestTrade[]>();
  grouped.set('alta', []);
  grouped.set('baixa', []);
  grouped.set('lateral', []);

  for (const trade of trades) {
    const regime = monthRegime.get(monthKey(trade.entryTime)) ?? 'lateral';
    grouped.get(regime)?.push(trade);
  }

  return (['alta', 'baixa', 'lateral'] as const).map((regime) => {
    const values = grouped.get(regime) ?? [];
    return {
      ...calculateTradeGroupMetrics(
        regime,
        regime,
        values,
        values.length === 0 ? 0 : Math.min(...values.map((trade) => trade.entryTime)),
        values.length === 0 ? 0 : Math.max(...values.map((trade) => trade.exitTime)),
        startingEquity,
        0,
        regime,
        null,
      ),
      marketRegime: regime,
    };
  });
}

function longestSignedStreak(
  rows: readonly DeepPerformanceBreakdownRow[],
  predicate: (row: DeepPerformanceBreakdownRow) => boolean,
): number {
  let best = 0;
  let current = 0;

  for (const row of rows) {
    if (predicate(row)) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }

  return best;
}

function buildDeepStrategyAnalytics(
  result: DeepBacktestStrategyResult,
  candles: readonly DayTradeCandle[],
): DeepStrategyAnalytics {
  const trades = result.trades as readonly DeepBacktestTrade[];
  const startingEquity = result.metrics.initialCapitalUsdt;
  const monthly = buildTemporalBreakdown(
    candles,
    trades,
    startingEquity,
    monthKey,
  );
  const quarterly = buildTemporalBreakdown(
    candles,
    trades,
    startingEquity,
    quarterKey,
  );
  const profitableMonths = monthly.filter((row) => row.netPnlUsdt > 0).length;
  const losingMonths = monthly.filter((row) => row.netPnlUsdt < 0).length;
  const breakevenMonths = monthly.length - profitableMonths - losingMonths;
  const sortedByPnl = [...monthly].sort((a, b) => b.netPnlUsdt - a.netPnlUsdt);

  return {
    strategy: result.strategy,
    strategyVersion: result.strategyVersion,
    monthly,
    quarterly,
    byVolatilityRegime: buildVolatilityBreakdown(trades, startingEquity),
    byMarketRegime: buildMarketRegimeBreakdown(monthly, trades, startingEquity),
    consistency: {
      profitableMonths,
      losingMonths,
      breakevenMonths,
      profitableMonthsPct:
        monthly.length === 0
          ? 0
          : deepRound((profitableMonths / monthly.length) * 100, 6),
      bestMonth: sortedByPnl[0] ?? null,
      worstMonth: sortedByPnl.length === 0
        ? null
        : sortedByPnl[sortedByPnl.length - 1],
      longestProfitableMonthStreak: longestSignedStreak(
        monthly,
        (row) => row.netPnlUsdt > 0,
      ),
      longestLosingMonthStreak: longestSignedStreak(
        monthly,
        (row) => row.netPnlUsdt < 0,
      ),
    },
  };
}

export function buildDeepBacktestAnalytics(
  candles: readonly DayTradeCandle[],
  result?: DeepBacktestStrategyResult,
  comparison?: DayTradeBacktestComparisonResult,
): DeepBacktestAnalytics {
  if (candles.length === 0) {
    throw new Error('Não há candles para construir a análise aprofundada.');
  }

  const strategies: Partial<Record<DayTradeStrategyId, DeepStrategyAnalytics>> = {};

  if (result) {
    strategies[result.strategy] = buildDeepStrategyAnalytics(result, candles);
  }

  if (comparison) {
    for (const strategyId of comparison.strategyIds) {
      const strategyResult = comparison.results[strategyId];
      if (!strategyResult) continue;
      strategies[strategyId] = buildDeepStrategyAnalytics(
        strategyResult,
        candles,
      );
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    candleCount: candles.length,
    firstCandleOpenTime: candles[0].openTime,
    lastCandleCloseTime: candles[candles.length - 1].closeTime,
    continuity: {
      continuousSeries: true,
      independentBlockSummation: false,
      indicatorsPreservedAcrossPages: true,
      equityPreservedAcrossPages: true,
      openPositionPreservedAcrossPages: true,
    },
    strategies,
  };
}

export async function executeDeepDayTradeBacktest(
  input: DeepBacktestInput,
): Promise<DeepBacktestExecutionResult> {
  const startedAt = Date.now();
  const strategyId = input.strategyId ?? TREND_BREAKOUT_STRATEGY_ID;
  const strategyOptions = input.strategyOptions ?? {};
  const backtestOptions = input.backtestOptions ?? {};
  const moneyManagementOptions = input.moneyManagementOptions ?? null;

  const candles = await fetchDeepBacktestCandles({
    symbol: input.symbol,
    timeframe: input.timeframe,
    startTime: input.startTime,
    endTime: input.endTime,
    maximumCandles: input.maximumCandles,
    requestTimeoutMs: input.requestTimeoutMs,
    onProgress: input.onProgress,
  });

  await emitDeepProgress(input.onProgress, {
    phase: 'running_backtest',
    progressPct: 76,
    processedCandles: candles.length,
    totalCandles: candles.length,
    message:
      input.mode === 'compare_all'
        ? 'Executando as quatro estratégias sobre o mesmo histórico contínuo.'
        : `Executando a estratégia ${strategyId} sobre o histórico contínuo.`,
  });

  const indicatorOptions = DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[input.timeframe];
  let result: DeepBacktestStrategyResult | undefined;
  let comparison: DayTradeBacktestComparisonResult | undefined;

  if (input.mode === 'compare_all') {
    comparison = compareDayTradeBacktests({
      candles,
      indicatorOptions,
      strategyOptions,
      backtestOptions,
      comparisonOptions: input.comparisonOptions,
    });
  } else if (strategyId === TREND_BREAKOUT_STRATEGY_ID) {
    result = runTrendBreakoutBacktest({
      candles,
      indicatorOptions,
      strategyOptions: strategyOptions.trend_breakout,
      backtestOptions: deepLegacyTrendBreakoutOptions(backtestOptions),
    });
  } else {
    result = runMultiStrategyBacktest({
      strategyId,
      candles,
      indicatorOptions,
      strategyOptions,
      backtestOptions,
    });
  }

  if (moneyManagementOptions) {
    if (comparison) {
      comparison = rebuildComparisonWithMoneyManagement(
        comparison,
        moneyManagementOptions,
      );
    }

    if (result) {
      result = enrichBacktestResultWithMoneyManagement(
        result,
        moneyManagementOptions,
      );
    }
  }

  await emitDeepProgress(input.onProgress, {
    phase: 'building_analytics',
    progressPct: 96,
    processedCandles: candles.length,
    totalCandles: candles.length,
    message: 'Calculando resultados mensais, trimestrais e por regime.',
  });

  const analytics = buildDeepBacktestAnalytics(candles, result, comparison);
  const generatedAt = new Date().toISOString();

  const response: DeepBacktestExecutionResult = {
    ok: true,
    mode: input.mode,
    strategy: input.mode === 'single' ? strategyId : null,
    symbol: input.symbol,
    timeframe: input.timeframe,
    startTime: input.startTime,
    endTime: input.endTime,
    candleCount: candles.length,
    executionMs: Date.now() - startedAt,
    generatedAt,
    moneyManagement: moneyManagementOptions,
    analytics,
  };

  if (result) response.result = result;
  if (comparison) response.comparison = comparison;

  await emitDeepProgress(input.onProgress, {
    phase: 'completed',
    progressPct: 100,
    processedCandles: candles.length,
    totalCandles: candles.length,
    message: 'Análise aprofundada concluída.',
  });

  return response;
}

// ============================================================================
// Tipos
// ============================================================================

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

type BacktestRunStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

type HistoryMode = 'candle_count' | 'date_range';

type SupabaseClient = ReturnType<typeof createClient>;

interface ClaimedBacktestRun {
  id: string;
  user_id: string;
  status: BacktestRunStatus;
  mode: DeepBacktestMode;
  strategy: string | null;
  symbol: string;
  timeframe: string;
  history_mode: HistoryMode;
  candle_count: number | null;
  start_time: string | null;
  end_time: string | null;
  estimated_candles: number | null;
  total_candles: number | null;
  processed_candles: number | null;
  progress_pct: number | null;
  progress_message: string | null;
  request_payload: JsonObject | null;
  attempts: number | null;
  max_attempts: number | null;
  locked_at: string | null;
  heartbeat_at: string | null;
  locked_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface NormalizedRunRequest {
  mode: DeepBacktestMode;
  strategyId: DayTradeStrategyId;
  symbol: string;
  timeframe: DayTradeIndicatorTimeframe;
  historyMode: HistoryMode;
  startTime: number;
  endTime: number;
  estimatedCandles: number;
  strategyOptions: Partial<DayTradeBacktestStrategyOptionsMap>;
  backtestOptions: MultiStrategyBacktestOptions;
  moneyManagementOptions: ResolvedBacktestMoneyManagementOptions | null;
  comparisonOptions: CompareDayTradeBacktestsOptions;
}

interface WorkerResult {
  ok: true;
  worker_id: string;
  processed: boolean;
  run_id: string | null;
  status: BacktestRunStatus | 'idle';
  elapsed_ms: number;
  message: string;
}

class WorkerRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'WorkerRequestError';
    this.status = status;
  }
}

// ============================================================================
// Configuração
// ============================================================================

const ALLOWED_TIMEFRAMES = new Set<DayTradeIndicatorTimeframe>([
  '5m',
  '15m',
  '30m',
  '1h',
]);

const TIMEFRAME_MILLISECONDS: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
};

const DEFAULT_STRATEGY_ID: DayTradeStrategyId = 'trend_breakout';
const MAXIMUM_CANDLES = 220_000;
const DEFAULT_CANDLE_COUNT = 3_000;
const MINIMUM_CANDLE_COUNT = 350;
const MAX_ERROR_MESSAGE_LENGTH = 4_000;
const PROGRESS_WRITE_MIN_INTERVAL_MS = 1_500;
const PROGRESS_WRITE_MIN_DELTA_PCT = 0.5;
const STALE_LOCK_MINUTES = 20;

// ============================================================================
// Utilitários HTTP e segurança
// ============================================================================

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '*';
  const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowedOrigin = configured.length === 0
    ? '*'
    : configured.includes(origin)
      ? origin
      : configured[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-cron-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  };
}

function jsonResponse(
  req: Request,
  payload: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders(req),
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);

  if (leftBytes.length !== rightBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}

function assertCronAuthorization(req: Request): void {
  const configuredSecret = Deno.env.get('CRON_SECRET')?.trim() ?? '';
  const receivedSecret = req.headers.get('x-cron-secret')?.trim() ?? '';

  if (!configuredSecret) {
    throw new WorkerRequestError('CRON_SECRET não configurado.', 500);
  }

  if (!receivedSecret || !constantTimeEqual(receivedSecret, configuredSecret)) {
    throw new WorkerRequestError('x-cron-secret inválido.', 401);
  }
}

// ============================================================================
// Conversão e validação
// ============================================================================

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asPositiveInteger(value: unknown): number | null {
  const parsed = asFiniteNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = asString(value);
  if (!text) return null;

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return truncate(
      `${error.name}: ${error.message}`,
      MAX_ERROR_MESSAGE_LENGTH,
    );
  }

  return truncate(String(error), MAX_ERROR_MESSAGE_LENGTH);
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function parseMode(value: unknown): DeepBacktestMode {
  return value === 'compare_all' ? 'compare_all' : 'single';
}

function parseStrategyId(value: unknown): DayTradeStrategyId {
  const text = asString(value);
  if (!text) return DEFAULT_STRATEGY_ID;

  if (!isDayTradeStrategyId(text)) {
    throw new Error(
      `Estratégia inválida. Use: ${DAYTRADE_STRATEGY_IDS.join(', ')}.`,
    );
  }

  return text;
}

function parseTimeframe(value: unknown): DayTradeIndicatorTimeframe {
  const text = asString(value) as DayTradeIndicatorTimeframe | null;
  if (!text || !ALLOWED_TIMEFRAMES.has(text)) {
    throw new Error('timeframe deve ser 5m, 15m, 30m ou 1h.');
  }

  return text;
}

function parseSymbol(value: unknown): string {
  const symbol = (asString(value) ?? 'BTCUSDT').toUpperCase();

  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !symbol.endsWith('USDT')) {
    throw new Error('symbol inválido; use um par Spot cotado em USDT.');
  }

  return symbol;
}

function parseOptionsObject<T extends object>(value: unknown): T {
  if (value === null || value === undefined) return {} as T;
  if (!isPlainRecord(value)) throw new Error('As opções devem ser um objeto JSON.');
  return value as T;
}

function estimateCandleCount(
  timeframe: DayTradeIndicatorTimeframe,
  startTime: number,
  endTime: number,
): number {
  return Math.max(
    0,
    Math.ceil((endTime - startTime) / TIMEFRAME_MILLISECONDS[timeframe]),
  );
}

function resolveDateRange(
  run: ClaimedBacktestRun,
  payload: Record<string, unknown>,
  timeframe: DayTradeIndicatorTimeframe,
): {
  historyMode: HistoryMode;
  startTime: number;
  endTime: number;
  estimatedCandles: number;
} {
  const historyMode =
    asString(payload.history_mode) === 'candle_count' ||
      run.history_mode === 'candle_count'
      ? 'candle_count'
      : 'date_range';

  const payloadStartTime = parseTimestamp(payload.start_time);
  const payloadEndTime = parseTimestamp(payload.end_time);
  const rowStartTime = parseTimestamp(run.start_time);
  const rowEndTime = parseTimestamp(run.end_time);

  if (historyMode === 'date_range') {
    const startTime = payloadStartTime ?? rowStartTime;
    const requestedEndTime = payloadEndTime ?? rowEndTime;

    if (startTime === null || requestedEndTime === null) {
      throw new Error('A tarefa não possui start_time e end_time válidos.');
    }

    const endTime = Math.min(requestedEndTime, Date.now());
    if (endTime <= startTime) {
      throw new Error('O período da tarefa é inválido ou ainda não começou.');
    }

    const estimatedCandles =
      asPositiveInteger(payload.estimated_candle_count) ??
      asPositiveInteger(run.estimated_candles) ??
      estimateCandleCount(timeframe, startTime, endTime);

    if (estimatedCandles > MAXIMUM_CANDLES) {
      throw new Error(
        `O período possui aproximadamente ${estimatedCandles} candles, acima do limite de ${MAXIMUM_CANDLES}.`,
      );
    }

    return {
      historyMode,
      startTime,
      endTime,
      estimatedCandles,
    };
  }

  const candleCount =
    asPositiveInteger(payload.candle_count) ??
    asPositiveInteger(run.candle_count) ??
    DEFAULT_CANDLE_COUNT;

  if (candleCount < MINIMUM_CANDLE_COUNT || candleCount > MAXIMUM_CANDLES) {
    throw new Error(
      `candle_count deve estar entre ${MINIMUM_CANDLE_COUNT} e ${MAXIMUM_CANDLES}.`,
    );
  }

  const endTime = Math.min(payloadEndTime ?? rowEndTime ?? Date.now(), Date.now());
  const startTime =
    payloadStartTime ??
    rowStartTime ??
    endTime - candleCount * TIMEFRAME_MILLISECONDS[timeframe];

  if (endTime <= startTime) {
    throw new Error('Não foi possível derivar o período da tarefa por candles.');
  }

  return {
    historyMode,
    startTime,
    endTime,
    estimatedCandles: candleCount,
  };
}


function workerMoneyManagementValue(
  source: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): unknown {
  return source[camelCase] ?? source[snakeCase];
}

function workerOptionalNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} deve estar entre ${minimum} e ${maximum}.`);
  }
  return parsed;
}

function workerOptionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = workerOptionalNumber(value, label, minimum, maximum);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} deve ser um número inteiro.`);
  }
  return parsed;
}

function workerOptionalBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  throw new Error(`${label} deve ser booleano.`);
}

function parseWorkerMoneyManagementOptions(
  value: unknown,
  backtestOptions: MultiStrategyBacktestOptions,
): ResolvedBacktestMoneyManagementOptions | null {
  if (value === undefined || value === null) return null;

  const source = asRecord(value);
  if (!source) {
    throw new Error('money_management_options deve ser um objeto.');
  }

  const rawMode = workerMoneyManagementValue(source, 'mode', 'mode');
  const mode = rawMode === undefined || rawMode === null || rawMode === ''
    ? 'fixed'
    : String(rawMode);

  if (
    mode !== 'fixed' &&
    mode !== 'anti_martingale' &&
    mode !== 'martingale_testnet'
  ) {
    throw new Error(
      'money_management_options.mode deve ser fixed, anti_martingale ou martingale_testnet.',
    );
  }

  const policyVersionRaw = workerMoneyManagementValue(
    source,
    'policyVersion',
    'policy_version',
  );
  let policyVersion: string | undefined;

  if (policyVersionRaw !== undefined && policyVersionRaw !== null) {
    policyVersion = String(policyVersionRaw).trim();
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(policyVersion)) {
      throw new Error(
        'money_management_options.policyVersion deve ter de 1 a 40 caracteres alfanuméricos, ponto, hífen ou sublinhado.',
      );
    }
  }

  const parsed: BacktestMoneyManagementOptions = {
    mode: mode as BacktestPositionSizingMode,
    baseRiskPercent: workerOptionalNumber(
      workerMoneyManagementValue(source, 'baseRiskPercent', 'base_risk_percent'),
      'money_management_options.baseRiskPercent',
      0.01,
      10,
    ),
    minimumRiskPercent: workerOptionalNumber(
      workerMoneyManagementValue(source, 'minimumRiskPercent', 'minimum_risk_percent'),
      'money_management_options.minimumRiskPercent',
      0.01,
      10,
    ),
    maximumRiskPercent: workerOptionalNumber(
      workerMoneyManagementValue(source, 'maximumRiskPercent', 'maximum_risk_percent'),
      'money_management_options.maximumRiskPercent',
      0.01,
      10,
    ),
    winMultiplier: workerOptionalNumber(
      workerMoneyManagementValue(source, 'winMultiplier', 'win_multiplier'),
      'money_management_options.winMultiplier',
      1,
      3,
    ),
    lossMultiplier: workerOptionalNumber(
      workerMoneyManagementValue(source, 'lossMultiplier', 'loss_multiplier'),
      'money_management_options.lossMultiplier',
      0.01,
      1,
    ),
    lossReductionStart: workerOptionalInteger(
      workerMoneyManagementValue(source, 'lossReductionStart', 'loss_reduction_start'),
      'money_management_options.lossReductionStart',
      1,
      10,
    ),
    martingaleLossMultiplier: workerOptionalNumber(
      workerMoneyManagementValue(
        source,
        'martingaleLossMultiplier',
        'martingale_loss_multiplier',
      ),
      'money_management_options.martingaleLossMultiplier',
      1,
      3,
    ),
    maximumMultiplier: workerOptionalNumber(
      workerMoneyManagementValue(source, 'maximumMultiplier', 'maximum_multiplier'),
      'money_management_options.maximumMultiplier',
      1,
      10,
    ),
    martingaleMaximumMultiplier: workerOptionalNumber(
      workerMoneyManagementValue(
        source,
        'martingaleMaximumMultiplier',
        'martingale_maximum_multiplier',
      ),
      'money_management_options.martingaleMaximumMultiplier',
      1,
      64,
    ),
    maximumSequenceSteps: workerOptionalInteger(
      workerMoneyManagementValue(source, 'maximumSequenceSteps', 'maximum_sequence_steps'),
      'money_management_options.maximumSequenceSteps',
      0,
      10,
    ),
    pauseAfterConsecutiveLosses: workerOptionalInteger(
      workerMoneyManagementValue(
        source,
        'pauseAfterConsecutiveLosses',
        'pause_after_consecutive_losses',
      ),
      'money_management_options.pauseAfterConsecutiveLosses',
      0,
      20,
    ),
    balanceUsageLimitPct: workerOptionalNumber(
      workerMoneyManagementValue(source, 'balanceUsageLimitPct', 'balance_usage_limit_pct'),
      'money_management_options.balanceUsageLimitPct',
      1,
      100,
    ),
    compareWithFixed: workerOptionalBoolean(
      workerMoneyManagementValue(source, 'compareWithFixed', 'compare_with_fixed'),
      'money_management_options.compareWithFixed',
    ),
    policyVersion,
  };

  return resolveBacktestMoneyManagementOptions(parsed, backtestOptions);
}

function normalizeRunRequest(run: ClaimedBacktestRun): NormalizedRunRequest {
  const payload = asRecord(run.request_payload) ?? {};
  const mode = parseMode(payload.mode ?? run.mode);
  const strategyId = parseStrategyId(payload.strategy ?? run.strategy);
  const symbol = parseSymbol(payload.symbol ?? run.symbol);
  const timeframe = parseTimeframe(payload.timeframe ?? run.timeframe);
  const history = resolveDateRange(run, payload, timeframe);
  const backtestOptions = parseOptionsObject<MultiStrategyBacktestOptions>(
    payload.backtest_options,
  );
  const moneyManagementOptions = parseWorkerMoneyManagementOptions(
    payload.money_management_options ?? payload.money_management,
    backtestOptions,
  );

  return {
    mode,
    strategyId,
    symbol,
    timeframe,
    historyMode: history.historyMode,
    startTime: history.startTime,
    endTime: history.endTime,
    estimatedCandles: history.estimatedCandles,
    strategyOptions: parseOptionsObject<
      Partial<DayTradeBacktestStrategyOptionsMap>
    >(payload.strategy_options),
    backtestOptions,
    moneyManagementOptions,
    comparisonOptions: parseOptionsObject<CompareDayTradeBacktestsOptions>(
      payload.comparison_options,
    ),
  };
}

// ============================================================================
// Persistência e reserva de tarefas
// ============================================================================

async function claimNextRun(
  client: SupabaseClient,
  workerId: string,
): Promise<ClaimedBacktestRun | null> {
  const { data, error } = await client.rpc('claim_next_backtest_run', {
    p_worker_id: workerId,
    p_stale_after_minutes: STALE_LOCK_MINUTES,
  });

  if (error) {
    throw new Error(`Não foi possível reservar uma tarefa: ${error.message}`);
  }

  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] as ClaimedBacktestRun;
}

async function updateClaimedRun(
  client: SupabaseClient,
  runId: string,
  workerId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await client
    .from('backtest_runs')
    .update(values)
    .eq('id', runId)
    .eq('status', 'processing')
    .eq('locked_by', workerId);

  if (error) {
    throw new Error(`Não foi possível atualizar a tarefa: ${error.message}`);
  }
}

function createProgressWriter(
  client: SupabaseClient,
  run: ClaimedBacktestRun,
  workerId: string,
  estimatedCandles: number,
): (progress: DeepBacktestProgress) => Promise<void> {
  let lastWriteAt = 0;
  let lastProgressPct = -1;
  let latestTotalCandles = Math.max(
    0,
    run.total_candles ?? estimatedCandles,
  );

  return async (progress: DeepBacktestProgress): Promise<void> => {
    const now = Date.now();
    const progressPct = clamp(progress.progressPct, 0, 100);
    const isTerminal = progressPct >= 100 || progress.phase === 'completed';
    const enoughTime = now - lastWriteAt >= PROGRESS_WRITE_MIN_INTERVAL_MS;
    const enoughDelta =
      Math.abs(progressPct - lastProgressPct) >= PROGRESS_WRITE_MIN_DELTA_PCT;

    if (!isTerminal && !enoughTime && !enoughDelta) return;

    latestTotalCandles = Math.max(
      latestTotalCandles,
      progress.totalCandles,
      progress.processedCandles,
    );

    await updateClaimedRun(client, run.id, workerId, {
      progress_pct: progressPct,
      processed_candles: Math.max(0, Math.floor(progress.processedCandles)),
      total_candles: Math.max(0, Math.floor(latestTotalCandles)),
      progress_message: truncate(progress.message, 1_000),
      heartbeat_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    lastWriteAt = now;
    lastProgressPct = progressPct;
  };
}

async function completeRun(
  client: SupabaseClient,
  run: ClaimedBacktestRun,
  workerId: string,
  request: NormalizedRunRequest,
  result: unknown,
  executionMs: number,
): Promise<void> {
  const resultRecord = asRecord(result);
  const actualCandleCount =
    asPositiveInteger(resultRecord?.candleCount) ?? request.estimatedCandles;

  const { error } = await client
    .from('backtest_runs')
    .update({
      status: 'completed',
      progress_pct: 100,
      processed_candles: actualCandleCount,
      total_candles: actualCandleCount,
      progress_message: 'Análise aprofundada concluída.',
      result_payload: toJsonObject(result),
      error_message: null,
      execution_ms: Math.max(0, Math.floor(executionMs)),
      completed_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      locked_at: null,
      locked_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', run.id)
    .eq('status', 'processing')
    .eq('locked_by', workerId);

  if (error) {
    throw new Error(`Não foi possível concluir a tarefa: ${error.message}`);
  }
}

async function failOrRetryRun(
  client: SupabaseClient,
  run: ClaimedBacktestRun,
  workerId: string,
  error: unknown,
): Promise<BacktestRunStatus> {
  const attempts = Math.max(1, run.attempts ?? 1);
  const maxAttempts = Math.max(1, run.max_attempts ?? 3);
  const shouldRetry = attempts < maxAttempts;
  const message = normalizeError(error);
  const nextAttemptAt = new Date(
    Date.now() + Math.min(15, attempts * 2) * 60 * 1_000,
  ).toISOString();

  const values = shouldRetry
    ? {
        status: 'pending',
        progress_message:
          `Tentativa ${attempts} falhou. Nova tentativa será realizada automaticamente.`,
        error_message: message,
        next_attempt_at: nextAttemptAt,
        heartbeat_at: null,
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      }
    : {
        status: 'failed',
        progress_message: 'A análise aprofundada falhou.',
        error_message: message,
        failed_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      };

  const { error: updateError } = await client
    .from('backtest_runs')
    .update(values)
    .eq('id', run.id)
    .eq('status', 'processing')
    .eq('locked_by', workerId);

  if (updateError) {
    console.error('[processar-backtest-daytrade] falha ao registrar erro', {
      runId: run.id,
      updateError: updateError.message,
      originalError: message,
    });
  }

  return shouldRetry ? 'pending' : 'failed';
}

// ============================================================================
// Execução da tarefa
// ============================================================================

async function processRun(
  client: SupabaseClient,
  run: ClaimedBacktestRun,
  workerId: string,
): Promise<{
  status: BacktestRunStatus;
  executionMs: number;
  message: string;
}> {
  const startedAt = Date.now();

  try {
    const request = normalizeRunRequest(run);
    const progressWriter = createProgressWriter(
      client,
      run,
      workerId,
      request.estimatedCandles,
    );

    await updateClaimedRun(client, run.id, workerId, {
      progress_pct: Math.max(1, run.progress_pct ?? 0),
      processed_candles: Math.max(0, run.processed_candles ?? 0),
      total_candles: Math.max(
        request.estimatedCandles,
        run.total_candles ?? 0,
      ),
      progress_message: request.moneyManagementOptions
        ? `Worker iniciado. Preparando a análise com gerenciamento ${request.moneyManagementOptions.mode}.`
        : 'Worker iniciado. Preparando a análise aprofundada.',
      heartbeat_at: new Date().toISOString(),
      started_at: run.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_message: null,
    });

    const deepInput: DeepBacktestInput = {
      mode: request.mode,
      strategyId: request.strategyId,
      symbol: request.symbol,
      timeframe: request.timeframe,
      startTime: request.startTime,
      endTime: request.endTime,
      strategyOptions: request.strategyOptions,
      backtestOptions: request.backtestOptions,
      comparisonOptions: request.comparisonOptions,
      moneyManagementOptions: request.moneyManagementOptions,
      maximumCandles: MAXIMUM_CANDLES,
      onProgress: progressWriter,
    };

    const result = await executeDeepDayTradeBacktest(deepInput);
    const executionMs = Date.now() - startedAt;

    await completeRun(
      client,
      run,
      workerId,
      request,
      result,
      executionMs,
    );

    return {
      status: 'completed',
      executionMs,
      message: 'Análise aprofundada concluída.',
    };
  } catch (error) {
    const status = await failOrRetryRun(client, run, workerId, error);
    return {
      status,
      executionMs: Date.now() - startedAt,
      message:
        status === 'pending'
          ? 'A análise falhou temporariamente e voltou para a fila.'
          : normalizeError(error),
    };
  }
}

// ============================================================================
// Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  const workerId = crypto.randomUUID();

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req),
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'método não permitido' }, 405);
  }

  try {
    assertCronAuthorization(req);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceRoleKey) {
      throw new WorkerRequestError(
        'SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados.',
        500,
      );
    }

    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          'x-worker-id': workerId,
        },
      },
    });

    const run = await claimNextRun(client, workerId);

    if (!run) {
      const response: WorkerResult = {
        ok: true,
        worker_id: workerId,
        processed: false,
        run_id: null,
        status: 'idle',
        elapsed_ms: Date.now() - startedAt,
        message: 'Nenhuma análise pendente disponível.',
      };

      return jsonResponse(req, response);
    }

    console.info('[processar-backtest-daytrade] tarefa reservada', {
      workerId,
      runId: run.id,
      userId: run.user_id,
      attempts: run.attempts,
      symbol: run.symbol,
      timeframe: run.timeframe,
      mode: run.mode,
    });

    const processed = await processRun(client, run, workerId);

    const response: WorkerResult = {
      ok: true,
      worker_id: workerId,
      processed: true,
      run_id: run.id,
      status: processed.status,
      elapsed_ms: Date.now() - startedAt,
      message: processed.message,
    };

    return jsonResponse(req, response);
  } catch (error) {
    const status = error instanceof WorkerRequestError ? error.status : 500;

    console.error('[processar-backtest-daytrade]', {
      workerId,
      error: normalizeError(error),
    });

    return jsonResponse(
      req,
      {
        error: normalizeError(error),
        worker_id: workerId,
        elapsed_ms: Date.now() - startedAt,
      },
      status,
    );
  }
});
