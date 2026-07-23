// ============================================================================
// VigIA Trade — Edge Function: avaliar-daytrade
// supabase/functions/avaliar-daytrade/index.ts
// ============================================================================
//
// Avalia quatro playbooks determinísticos usando somente candles encerrados
// da Binance e, opcionalmente, salva/atualiza os setups em
// public.daytrade_setups.
//
// Integração com a Central de Oportunidades:
// - persiste a versão exata da estratégia;
// - persiste as opções resolvidas, inclusive os valores padrão;
// - preserva o plano determinístico completo usado na avaliação;
// - somente trend_breakout pode chamar a RPC idempotente
//   create_opportunity_from_daytrade_setup;
// - trend_pullback, squeeze_breakout e range_mean_reversion permanecem shadow;
// - a RPC cria o resultado teórico inicial e a linha de auditoria;
// - falha ao criar a oportunidade não apaga o setup já calculado: o retorno
//   informa o erro e a função sincronizar-oportunidades pode refazer o vínculo.
//
// Segurança:
// - publique esta função com verify_jwt = true;
// - o usuário é obtido do JWT recebido;
// - a gravação usa o cliente autenticado e respeita as políticas RLS;
// - nenhuma chave Binance é necessária, pois os dados de mercado são públicos;
// - esta função NÃO cria nem executa ordens.
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
// supabase/functions/avaliar-daytrade/strategies/trendPullback.ts
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
// supabase/functions/avaliar-daytrade/strategies/squeezeBreakout.ts
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
// supabase/functions/avaliar-daytrade/strategies/rangeMeanReversion.ts
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
// supabase/functions/avaliar-daytrade/strategies/index.ts
// ============================================================================

/**
 * Registro central dos playbooks disponíveis na Edge Function avaliar-daytrade.
 *
 * Este arquivo foi preparado para o padrão atual da função:
 * - sem imports;
 * - usa as constantes das estratégias já presentes no mesmo escopo;
 * - mantém somente trend_breakout autorizado para criar oportunidades;
 * - mantém as outras três estratégias em modo shadow.
 */

// -----------------------------------------------------------------------------
// Tipos do registro
// -----------------------------------------------------------------------------

type EdgeDayTradeStrategyId =
  | typeof TREND_BREAKOUT_STRATEGY_ID
  | typeof TREND_PULLBACK_STRATEGY_ID
  | typeof SQUEEZE_BREAKOUT_STRATEGY_ID
  | typeof RANGE_MEAN_REVERSION_STRATEGY_ID;

type EdgeDayTradeStrategyVersion =
  | typeof TREND_BREAKOUT_STRATEGY_VERSION
  | typeof TREND_PULLBACK_STRATEGY_VERSION
  | typeof SQUEEZE_BREAKOUT_STRATEGY_VERSION
  | typeof RANGE_MEAN_REVERSION_STRATEGY_VERSION;

type EdgeDayTradeStrategyCategory =
  | 'trend_following'
  | 'mean_reversion';

type EdgeDayTradeStrategyExecutionMode =
  | 'testnet_allowed'
  | 'shadow';

type EdgeDayTradeMarketRegime =
  | 'tendência'
  | 'compressão'
  | 'lateralidade';

interface EdgeDayTradeStrategyDefinition {
  id: EdgeDayTradeStrategyId;
  version: EdgeDayTradeStrategyVersion;

  label: string;
  shortLabel: string;
  description: string;

  category: EdgeDayTradeStrategyCategory;
  preferredRegimes: readonly EdgeDayTradeMarketRegime[];

  /**
   * testnet_allowed:
   * a estratégia pode chegar ao fluxo que cria oportunidade automática.
   *
   * shadow:
   * a estratégia pode ser calculada e persistida, mas nunca pode criar ordem.
   */
  executionMode: EdgeDayTradeStrategyExecutionMode;

  /**
   * Trava explícita usada antes de qualquer RPC de oportunidade ou ordem.
   */
  authorizedForAutomaticOrders: boolean;

  /**
   * Permite salvar avaliações da estratégia.
   */
  enabledForPersistence: boolean;

  /**
   * Ordem sugerida de apresentação.
   */
  displayOrder: number;
}

// -----------------------------------------------------------------------------
// Registro
// -----------------------------------------------------------------------------

const EDGE_DEFAULT_DAYTRADE_STRATEGY_ID =
  TREND_BREAKOUT_STRATEGY_ID;

const EDGE_DAYTRADE_STRATEGY_REGISTRY = {
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
    enabledForPersistence: true,

    displayOrder: 4,
  },
} as const satisfies Record<
  EdgeDayTradeStrategyId,
  EdgeDayTradeStrategyDefinition
>;

// -----------------------------------------------------------------------------
// Listas derivadas
// -----------------------------------------------------------------------------

const EDGE_DAYTRADE_STRATEGY_IDS = [
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_PULLBACK_STRATEGY_ID,
  SQUEEZE_BREAKOUT_STRATEGY_ID,
  RANGE_MEAN_REVERSION_STRATEGY_ID,
] as const satisfies readonly EdgeDayTradeStrategyId[];

const EDGE_EXECUTABLE_DAYTRADE_STRATEGY_IDS =
  EDGE_DAYTRADE_STRATEGY_IDS.filter(
    (strategyId) =>
      EDGE_DAYTRADE_STRATEGY_REGISTRY[strategyId]
        .authorizedForAutomaticOrders,
  );

const EDGE_SHADOW_DAYTRADE_STRATEGY_IDS =
  EDGE_DAYTRADE_STRATEGY_IDS.filter(
    (strategyId) =>
      !EDGE_DAYTRADE_STRATEGY_REGISTRY[strategyId]
        .authorizedForAutomaticOrders,
  );

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isEdgeDayTradeStrategyId(
  value: unknown,
): value is EdgeDayTradeStrategyId {
  return (
    typeof value === 'string' &&
    EDGE_DAYTRADE_STRATEGY_IDS.includes(
      value as EdgeDayTradeStrategyId,
    )
  );
}

function assertEdgeDayTradeStrategyId(
  value: unknown,
): EdgeDayTradeStrategyId {
  if (!isEdgeDayTradeStrategyId(value)) {
    throw new Error(
      `Estratégia inválida. Valores aceitos: ${EDGE_DAYTRADE_STRATEGY_IDS.join(', ')}.`,
    );
  }

  return value;
}

function getEdgeDayTradeStrategyDefinition(
  strategyId: EdgeDayTradeStrategyId,
): EdgeDayTradeStrategyDefinition {
  return EDGE_DAYTRADE_STRATEGY_REGISTRY[
    strategyId
  ];
}

function isEdgeDayTradeStrategyAuthorizedForOrders(
  strategyId: EdgeDayTradeStrategyId,
): boolean {
  return EDGE_DAYTRADE_STRATEGY_REGISTRY[
    strategyId
  ].authorizedForAutomaticOrders;
}

function isEdgeDayTradeStrategyShadow(
  strategyId: EdgeDayTradeStrategyId,
): boolean {
  return (
    EDGE_DAYTRADE_STRATEGY_REGISTRY[
      strategyId
    ].executionMode === 'shadow'
  );
}

function listEdgeDayTradeStrategyDefinitions(
  options: {
    includeShadow?: boolean;
    onlyPersistenceEnabled?: boolean;
  } = {},
): EdgeDayTradeStrategyDefinition[] {
  const {
    includeShadow = true,
    onlyPersistenceEnabled = false,
  } = options;

  return EDGE_DAYTRADE_STRATEGY_IDS
    .map(
      (strategyId) =>
        EDGE_DAYTRADE_STRATEGY_REGISTRY[
          strategyId
        ],
    )
    .filter(
      (strategy) =>
        includeShadow ||
        strategy.executionMode !== 'shadow',
    )
    .filter(
      (strategy) =>
        !onlyPersistenceEnabled ||
        strategy.enabledForPersistence,
    )
    .sort(
      (left, right) =>
        left.displayOrder -
        right.displayOrder,
    );
}

/**
 * Trava obrigatória antes da criação de oportunidade automática.
 */
function assertEdgeStrategyCanCreateAutomaticOpportunity(
  strategyId: EdgeDayTradeStrategyId,
): void {
  const definition =
    getEdgeDayTradeStrategyDefinition(
      strategyId,
    );

  if (
    !definition.authorizedForAutomaticOrders ||
    definition.executionMode !==
      'testnet_allowed'
  ) {
    throw new Error(
      `A estratégia ${strategyId} está em modo shadow e não pode criar oportunidade ou ordem.`,
    );
  }
}

// ============================================================================
// supabase/functions/avaliar-daytrade/strategies/evaluateAll.ts
// ============================================================================

/**
 * Avaliador central das estratégias na Edge Function avaliar-daytrade.
 *
 * Padrão atual:
 * - sem imports;
 * - usa tipos e funções já presentes no mesmo escopo do index.ts;
 * - normaliza candles uma única vez;
 * - calcula indicadores uma única vez;
 * - executa as quatro estratégias sobre o mesmo snapshot;
 * - mantém somente trend_breakout autorizado para oportunidade automática.
 */

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

interface EdgeDayTradeStrategyOptionsMap {
  trend_breakout?: TrendBreakoutOptions;
  trend_pullback?: TrendPullbackOptions;
  squeeze_breakout?: SqueezeBreakoutOptions;
  range_mean_reversion?: RangeMeanReversionOptions;
}

type EdgeAnyDayTradeStrategyEvaluation =
  | TrendBreakoutEvaluation
  | TrendPullbackEvaluation
  | SqueezeBreakoutEvaluation
  | RangeMeanReversionEvaluation;

interface EdgeDayTradeStrategyEvaluationMap {
  trend_breakout: TrendBreakoutEvaluation;
  trend_pullback: TrendPullbackEvaluation;
  squeeze_breakout: SqueezeBreakoutEvaluation;
  range_mean_reversion: RangeMeanReversionEvaluation;
}

interface EvaluateAllEdgeDayTradeStrategiesInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;

  /**
   * Preço ao vivo opcional.
   *
   * Serve apenas para detectar entrada atrasada ou invalidação.
   * Nunca confirma uma estratégia.
   */
  livePrice?: number | null;

  /**
   * Opções isoladas por estratégia.
   */
  strategyOptions?: EdgeDayTradeStrategyOptionsMap;

  /**
   * Quando omitido, executa as quatro estratégias.
   */
  enabledStrategies?: readonly EdgeDayTradeStrategyId[];
}

interface EdgeDayTradeStrategyResult<
  TEvaluation extends EdgeAnyDayTradeStrategyEvaluation =
    EdgeAnyDayTradeStrategyEvaluation,
> {
  strategy: EdgeDayTradeStrategyId;
  executionMode: EdgeDayTradeStrategyExecutionMode;
  authorizedForAutomaticOrders: boolean;
  evaluation: TEvaluation;
}

interface EvaluateAllEdgeDayTradeStrategiesResult {
  /**
   * Candles encerrados, validados, ordenados e deduplicados.
   */
  candles: DayTradeCandle[];

  /**
   * Snapshot único de indicadores compartilhado pelas quatro estratégias.
   */
  indicators: DayTradeIndicators;

  /**
   * Mapa tipado por ID.
   */
  evaluations: Partial<EdgeDayTradeStrategyEvaluationMap>;

  /**
   * Lista ordenada por score e prioridade visual.
   */
  results: EdgeDayTradeStrategyResult[];

  /**
   * Estratégias autorizadas a chegar ao fluxo de oportunidade.
   */
  executableResults: EdgeDayTradeStrategyResult[];

  /**
   * Estratégias calculadas somente para observação.
   */
  shadowResults: EdgeDayTradeStrategyResult[];

  /**
   * Maior score geral, sem conceder autorização de execução.
   */
  highestScoreResult: EdgeDayTradeStrategyResult | null;

  /**
   * Maior score entre estratégias autorizadas.
   */
  highestExecutableScoreResult: EdgeDayTradeStrategyResult | null;
}

// -----------------------------------------------------------------------------
// Configuração
// -----------------------------------------------------------------------------

const EDGE_ALL_DAYTRADE_STRATEGY_IDS = [
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_PULLBACK_STRATEGY_ID,
  SQUEEZE_BREAKOUT_STRATEGY_ID,
  RANGE_MEAN_REVERSION_STRATEGY_ID,
] as const satisfies readonly EdgeDayTradeStrategyId[];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveEnabledEdgeDayTradeStrategies(
  value:
    | readonly EdgeDayTradeStrategyId[]
    | undefined,
): EdgeDayTradeStrategyId[] {
  if (value === undefined) {
    return [
      ...EDGE_ALL_DAYTRADE_STRATEGY_IDS,
    ];
  }

  const unique = Array.from(
    new Set(value),
  );

  for (const strategyId of unique) {
    if (
      !EDGE_ALL_DAYTRADE_STRATEGY_IDS.includes(
        strategyId,
      )
    ) {
      throw new Error(
        `Estratégia inválida: ${strategyId}. Valores aceitos: ${EDGE_ALL_DAYTRADE_STRATEGY_IDS.join(', ')}.`,
      );
    }
  }

  return unique;
}

function createEdgeDayTradeStrategyResult<
  TEvaluation extends EdgeAnyDayTradeStrategyEvaluation,
>(
  strategy: EdgeDayTradeStrategyId,
  evaluation: TEvaluation,
): EdgeDayTradeStrategyResult<TEvaluation> {
  const definition =
    EDGE_DAYTRADE_STRATEGY_REGISTRY[
      strategy
    ];

  return {
    strategy,
    executionMode:
      definition.executionMode,
    authorizedForAutomaticOrders:
      definition.authorizedForAutomaticOrders,
    evaluation,
  };
}

function compareEdgeDayTradeResultsByScore(
  left: EdgeDayTradeStrategyResult,
  right: EdgeDayTradeStrategyResult,
): number {
  const scoreDifference =
    right.evaluation.scorePct -
    left.evaluation.scorePct;

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const leftOrder =
    EDGE_DAYTRADE_STRATEGY_REGISTRY[
      left.strategy
    ].displayOrder;

  const rightOrder =
    EDGE_DAYTRADE_STRATEGY_REGISTRY[
      right.strategy
    ].displayOrder;

  return leftOrder - rightOrder;
}

function getHighestEdgeDayTradeScoreResult(
  results: readonly EdgeDayTradeStrategyResult[],
): EdgeDayTradeStrategyResult | null {
  if (results.length === 0) {
    return null;
  }

  return [...results].sort(
    compareEdgeDayTradeResultsByScore,
  )[0];
}

// -----------------------------------------------------------------------------
// Avaliação central
// -----------------------------------------------------------------------------

function evaluateAllEdgeDayTradeStrategies(
  input: EvaluateAllEdgeDayTradeStrategiesInput,
): EvaluateAllEdgeDayTradeStrategiesResult {
  const candles =
    normalizeClosedCandles(
      input.candles,
    );

  if (candles.length < 2) {
    throw new Error(
      'São necessários pelo menos dois candles encerrados para avaliar as estratégias.',
    );
  }

  const indicators =
    calculateDayTradeIndicators(
      candles,
      input.indicatorOptions,
    );

  const enabledStrategies =
    resolveEnabledEdgeDayTradeStrategies(
      input.enabledStrategies,
    );

  const evaluations: Partial<EdgeDayTradeStrategyEvaluationMap> =
    {};

  const results: EdgeDayTradeStrategyResult[] =
    [];

  for (
    const strategyId of enabledStrategies
  ) {
    switch (strategyId) {
      case TREND_BREAKOUT_STRATEGY_ID: {
        const evaluation =
          evaluateTrendBreakout({
            candles,
            indicators,
            livePrice:
              input.livePrice,
            options:
              input.strategyOptions
                ?.trend_breakout,
          });

        evaluations.trend_breakout =
          evaluation;

        results.push(
          createEdgeDayTradeStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      case TREND_PULLBACK_STRATEGY_ID: {
        const evaluation =
          evaluateTrendPullback({
            candles,
            indicators,
            livePrice:
              input.livePrice,
            options:
              input.strategyOptions
                ?.trend_pullback,
          });

        evaluations.trend_pullback =
          evaluation;

        results.push(
          createEdgeDayTradeStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      case SQUEEZE_BREAKOUT_STRATEGY_ID: {
        const evaluation =
          evaluateSqueezeBreakout({
            candles,
            indicators,
            livePrice:
              input.livePrice,
            options:
              input.strategyOptions
                ?.squeeze_breakout,
          });

        evaluations.squeeze_breakout =
          evaluation;

        results.push(
          createEdgeDayTradeStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      case RANGE_MEAN_REVERSION_STRATEGY_ID: {
        const evaluation =
          evaluateRangeMeanReversion({
            candles,
            indicators,
            livePrice:
              input.livePrice,
            options:
              input.strategyOptions
                ?.range_mean_reversion,
          });

        evaluations.range_mean_reversion =
          evaluation;

        results.push(
          createEdgeDayTradeStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      default: {
        const exhaustiveCheck: never =
          strategyId;

        throw new Error(
          `Estratégia não implementada: ${String(exhaustiveCheck)}.`,
        );
      }
    }
  }

  const sortedResults =
    [...results].sort(
      compareEdgeDayTradeResultsByScore,
    );

  const executableResults =
    sortedResults.filter(
      (result) =>
        result
          .authorizedForAutomaticOrders,
    );

  const shadowResults =
    sortedResults.filter(
      (result) =>
        !result
          .authorizedForAutomaticOrders,
    );

  return {
    candles,
    indicators,
    evaluations,
    results:
      sortedResults,
    executableResults,
    shadowResults,
    highestScoreResult:
      getHighestEdgeDayTradeScoreResult(
        sortedResults,
      ),
    highestExecutableScoreResult:
      getHighestEdgeDayTradeScoreResult(
        executableResults,
      ),
  };
}

// -----------------------------------------------------------------------------
// Helpers de segurança para oportunidade automática
// -----------------------------------------------------------------------------

function getEdgeAutomaticOpportunityCandidate(
  result: EvaluateAllEdgeDayTradeStrategiesResult,
): EdgeDayTradeStrategyResult | null {
  const candidates =
    result.executableResults.filter(
      (item) =>
        item.evaluation
          .allConditionsMet &&
        item.evaluation.status ===
          'condicoes_atendidas' &&
        item.evaluation.plan !== null,
    );

  return getHighestEdgeDayTradeScoreResult(
    candidates,
  );
}

function assertEdgeAutomaticOpportunityCandidate(
  result: EdgeDayTradeStrategyResult,
): void {
  assertEdgeStrategyCanCreateAutomaticOpportunity(
    result.strategy,
  );

  if (
    !result.evaluation
      .allConditionsMet ||
    result.evaluation.status !==
      'condicoes_atendidas' ||
    result.evaluation.plan === null
  ) {
    throw new Error(
      `A estratégia ${result.strategy} não possui setup elegível para execução.`,
    );
  }
}

// ============================================================================
// SEÇÃO FINAL: handler multiestratégia
// ============================================================================

// ---------------------------------------------------------------------------
// Tipos HTTP e persistência
// ---------------------------------------------------------------------------

interface EvaluateRequestBody {
  symbol?: unknown;
  timeframe?: unknown;
  live_price?: unknown;
  persist?: unknown;
  enabled_strategies?: unknown;
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

interface SavedSetupRow {
  id: string;
  symbol: string;
  timeframe: DayTradeIndicatorTimeframe;
  strategy: string;
  strategy_version: string;
  status: string;
  score: number;
  total_conditions: number;
  strategy_options: Record<string, unknown>;
  plan: Record<string, unknown>;
  candle_open_time: string;
  candle_close_time: string;
  criado_em?: string;
  atualizado_em?: string;
}

type OpportunityAutomationStatus =
  | 'not_persisted'
  | 'not_eligible'
  | 'created_or_existing'
  | 'error';

interface OpportunityAutomationResult {
  eligible: boolean;
  attempted: boolean;
  status: OpportunityAutomationStatus;
  opportunity_id: string | null;
  error: string | null;
}

interface StrategyPersistenceError {
  strategy: EdgeDayTradeStrategyId;
  message: string;
}

interface ResolvedEdgeStrategyOptionsMap {
  trend_breakout: ResolvedTrendBreakoutOptions;
  trend_pullback: ResolvedTrendPullbackOptions;
  squeeze_breakout: ResolvedSqueezeBreakoutOptions;
  range_mean_reversion: ResolvedRangeMeanReversionOptions;
}

interface NumericOptionSpec {
  minimum: number;
  maximum: number;
  integer?: boolean;
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

const ALLOWED_VOLATILITY_REGIMES = new Set<VolatilityRegime>([
  'indisponível',
  'calmo',
  'normal',
  'volátil',
  'extremo',
]);

const BINANCE_PUBLIC_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const MAX_BODY_BYTES = 32_768;
const FETCH_TIMEOUT_MS = 9_000;
const EXTRA_CANDLES = 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const EDGE_STRATEGY_NUMERIC_OPTION_SPECS: Record<
  EdgeDayTradeStrategyId,
  Record<string, NumericOptionSpec>
> = {
  trend_breakout: {
    minimumRelativeVolume: { minimum: 0.1, maximum: 20 },
    atrStopMultiple: { minimum: 0.1, maximum: 20 },
    minimumRiskRewardRatio: { minimum: 0.1, maximum: 20 },
    observationDistanceAtr: { minimum: 0, maximum: 20 },
    maximumLateEntryDistanceAtr: { minimum: 0, maximum: 20 },
    minimumStopDistanceAtr: { minimum: 0.05, maximum: 20 },
    maximumStopDistanceAtr: { minimum: 0.1, maximum: 40 },
  },
  trend_pullback: {
    minimumRelativeVolume: { minimum: 0.1, maximum: 20 },
    minimumPreviousCandleVolumeRatio: { minimum: 0.1, maximum: 20 },
    atrStopMultiple: { minimum: 0.1, maximum: 20 },
    structuralStopBufferAtr: { minimum: 0, maximum: 10 },
    minimumRiskRewardRatio: { minimum: 0.1, maximum: 20 },
    pullbackToleranceAtr: { minimum: 0, maximum: 10 },
    maximumLateEntryDistanceAtr: { minimum: 0, maximum: 20 },
    minimumStopDistanceAtr: { minimum: 0.05, maximum: 20 },
    maximumStopDistanceAtr: { minimum: 0.1, maximum: 40 },
  },
  squeeze_breakout: {
    compressionLookback: { minimum: 3, maximum: 500, integer: true },
    baselineLookback: { minimum: 3, maximum: 500, integer: true },
    maximumRangeContractionRatio: { minimum: 0.01, maximum: 1 },
    maximumCompressionRangeAtr: { minimum: 0.1, maximum: 50 },
    minimumRelativeVolume: { minimum: 0.1, maximum: 20 },
    minimumPreviousCandleVolumeRatio: { minimum: 0.1, maximum: 20 },
    minimumBreakoutDistanceAtr: { minimum: 0, maximum: 20 },
    observationDistanceAtr: { minimum: 0, maximum: 20 },
    atrStopMultiple: { minimum: 0.1, maximum: 20 },
    structuralStopBufferAtr: { minimum: 0, maximum: 10 },
    minimumRiskRewardRatio: { minimum: 0.1, maximum: 20 },
    maximumLateEntryDistanceAtr: { minimum: 0, maximum: 20 },
    minimumStopDistanceAtr: { minimum: 0.05, maximum: 20 },
    maximumStopDistanceAtr: { minimum: 0.1, maximum: 40 },
  },
  range_mean_reversion: {
    rangeLookback: { minimum: 10, maximum: 500, integer: true },
    meanLookback: { minimum: 5, maximum: 500, integer: true },
    maximumSlowEmaSlopeAtrPerCandle: { minimum: 0, maximum: 10 },
    maximumFastMediumEmaSpreadAtr: { minimum: 0, maximum: 20 },
    minimumRangeWidthAtr: { minimum: 0.1, maximum: 100 },
    maximumRangeWidthAtr: { minimum: 0.1, maximum: 200 },
    maximumEntryZScore: { minimum: -20, maximum: 20 },
    maximumSupportDistanceAtr: { minimum: 0, maximum: 20 },
    minimumRelativeVolume: { minimum: 0, maximum: 20 },
    maximumRelativeVolume: { minimum: 0.1, maximum: 50 },
    atrStopMultiple: { minimum: 0.1, maximum: 20 },
    structuralStopBufferAtr: { minimum: 0, maximum: 10 },
    minimumRiskRewardRatio: { minimum: 0.1, maximum: 20 },
    maximumLateEntryDistanceAtr: { minimum: 0, maximum: 20 },
    minimumStopDistanceAtr: { minimum: 0.05, maximum: 20 },
    maximumStopDistanceAtr: { minimum: 0.1, maximum: 40 },
  },
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
// Validação da requisição
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
    throw new Error(
      'Nesta etapa, o Day Trade aceita somente pares em USDT.',
    );
  }

  return symbol;
}

function parseTimeframe(
  value: unknown,
): DayTradeIndicatorTimeframe {
  if (
    typeof value !== 'string' ||
    !ALLOWED_TIMEFRAMES.has(
      value as DayTradeIndicatorTimeframe,
    )
  ) {
    throw new Error(
      'timeframe deve ser 5m, 15m, 30m ou 1h.',
    );
  }

  return value as DayTradeIndicatorTimeframe;
}

function parseOptionalPositiveNumber(
  value: unknown,
  name: string,
): number | null {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return null;
  }

  const parsed =
    typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${name} deve ser um número maior que zero.`,
    );
  }

  return parsed;
}

function parseBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;

  if (typeof value !== 'boolean') {
    throw new Error(
      `${name} deve ser verdadeiro ou falso.`,
    );
  }

  return value;
}

function parseBlockedVolatilityRegimesForStrategy(
  value: unknown,
  path: string,
): readonly VolatilityRegime[] | undefined {
  if (value === undefined) return undefined;

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} deve ser uma lista não vazia.`);
  }

  const regimes: VolatilityRegime[] = [];

  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !ALLOWED_VOLATILITY_REGIMES.has(
        item as VolatilityRegime,
      )
    ) {
      throw new Error(`${path} contém um regime inválido.`);
    }

    const regime = item as VolatilityRegime;
    if (!regimes.includes(regime)) regimes.push(regime);
  }

  return regimes;
}

function parseSingleEdgeStrategyOptions(
  value: unknown,
  strategyId: EdgeDayTradeStrategyId,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} deve ser um objeto.`);
  }

  const source = value as Record<string, unknown>;
  const numericSpecs = EDGE_STRATEGY_NUMERIC_OPTION_SPECS[strategyId];
  const allowed = new Set([
    ...Object.keys(numericSpecs),
    'blockedVolatilityRegimes',
  ]);

  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} não é suportado.`);
    }
  }

  const parsed: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(numericSpecs)) {
    const raw = source[key];
    if (raw === undefined) continue;

    const numeric = typeof raw === 'number' ? raw : Number(raw);

    if (
      !Number.isFinite(numeric) ||
      numeric < spec.minimum ||
      numeric > spec.maximum ||
      (spec.integer === true && !Number.isInteger(numeric))
    ) {
      const integerMessage = spec.integer ? ' inteiro' : '';
      throw new Error(
        `${path}.${key} deve ser um número${integerMessage} entre ${spec.minimum} e ${spec.maximum}.`,
      );
    }

    parsed[key] = numeric;
  }

  const regimes = parseBlockedVolatilityRegimesForStrategy(
    source.blockedVolatilityRegimes,
    `${path}.blockedVolatilityRegimes`,
  );

  if (regimes !== undefined) {
    parsed.blockedVolatilityRegimes = regimes;
  }

  return parsed;
}

function parseEdgeStrategyOptionsMap(
  value: unknown,
): EdgeDayTradeStrategyOptionsMap | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('strategy_options deve ser um objeto.');
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  const nestedMode = keys.some((key) =>
    isEdgeDayTradeStrategyId(key),
  );

  // Compatibilidade com o corpo antigo: opções planas continuam aplicadas
  // exclusivamente a trend_breakout.
  if (!nestedMode) {
    return {
      trend_breakout: parseSingleEdgeStrategyOptions(
        source,
        TREND_BREAKOUT_STRATEGY_ID,
        'strategy_options',
      ) as TrendBreakoutOptions | undefined,
    };
  }

  for (const key of keys) {
    if (!isEdgeDayTradeStrategyId(key)) {
      throw new Error(
        `strategy_options.${key} não corresponde a uma estratégia suportada.`,
      );
    }
  }

  return {
    trend_breakout: parseSingleEdgeStrategyOptions(
      source.trend_breakout,
      TREND_BREAKOUT_STRATEGY_ID,
      'strategy_options.trend_breakout',
    ) as TrendBreakoutOptions | undefined,
    trend_pullback: parseSingleEdgeStrategyOptions(
      source.trend_pullback,
      TREND_PULLBACK_STRATEGY_ID,
      'strategy_options.trend_pullback',
    ) as TrendPullbackOptions | undefined,
    squeeze_breakout: parseSingleEdgeStrategyOptions(
      source.squeeze_breakout,
      SQUEEZE_BREAKOUT_STRATEGY_ID,
      'strategy_options.squeeze_breakout',
    ) as SqueezeBreakoutOptions | undefined,
    range_mean_reversion: parseSingleEdgeStrategyOptions(
      source.range_mean_reversion,
      RANGE_MEAN_REVERSION_STRATEGY_ID,
      'strategy_options.range_mean_reversion',
    ) as RangeMeanReversionOptions | undefined,
  };
}

function parseEnabledEdgeStrategies(
  value: unknown,
): EdgeDayTradeStrategyId[] | undefined {
  if (value === undefined || value === null) return undefined;

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'enabled_strategies deve ser uma lista não vazia.',
    );
  }

  const strategies: EdgeDayTradeStrategyId[] = [];

  for (const item of value) {
    const strategyId = assertEdgeDayTradeStrategyId(item);
    if (!strategies.includes(strategyId)) strategies.push(strategyId);
  }

  // A estratégia autorizada precisa permanecer avaliada para preservar o
  // comportamento do Auto Trade e a compatibilidade da resposta principal.
  if (!strategies.includes(TREND_BREAKOUT_STRATEGY_ID)) {
    strategies.unshift(TREND_BREAKOUT_STRATEGY_ID);
  }

  return strategies;
}

function resolveAllEdgeStrategyOptions(
  parsed: EdgeDayTradeStrategyOptionsMap | undefined,
): ResolvedEdgeStrategyOptionsMap {
  return {
    trend_breakout: resolveTrendBreakoutOptions(
      parsed?.trend_breakout,
    ),
    trend_pullback: resolveTrendPullbackOptions(
      parsed?.trend_pullback,
    ),
    squeeze_breakout: resolveSqueezeBreakoutOptions(
      parsed?.squeeze_breakout,
    ),
    range_mean_reversion: resolveRangeMeanReversionOptions(
      parsed?.range_mean_reversion,
    ),
  };
}

async function readJsonBody(
  req: Request,
): Promise<EvaluateRequestBody> {
  const declaredLength = Number(
    req.headers.get('content-length') ?? 0,
  );

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BODY_BYTES
  ) {
    throw new Error(
      'Corpo da requisição excede o limite permitido.',
    );
  }

  const raw = await req.text();

  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error(
      'Corpo da requisição excede o limite permitido.',
    );
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
    throw new Error(
      'A Binance retornou um candle em formato inesperado.',
    );
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

  if (Object.values(candle).some((item) => !Number.isFinite(item))) {
    throw new Error(
      'A Binance retornou valores numéricos inválidos.',
    );
  }

  return candle;
}

async function fetchWithTimeout(
  url: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS,
  );

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
          const retryAfter = Number(
            response.headers.get('retry-after') ?? 1,
          );

          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(2_000, Math.max(250, retryAfter * 1_000)),
            ),
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

      return {
        closedCandles,
        livePrice: latestMarketCandle.close,
        baseUrl,
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
    `Não foi possível consultar os candles da Binance. ${failures.join(' | ')}`,
  );
}

// ---------------------------------------------------------------------------
// Serialização e persistência
// ---------------------------------------------------------------------------

function edgeIndicatorSnapshot(
  indicators: DayTradeIndicators,
  strategyId: EdgeDayTradeStrategyId,
  strategyVersion: string,
  strategyOptions: Record<string, unknown>,
): Record<string, unknown> {
  return {
    strategy: strategyId,
    strategy_version: strategyVersion,
    strategy_options: strategyOptions,
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

function edgeRecordSnapshot(
  value: unknown,
): Record<string, unknown> {
  if (value === null || value === undefined) return {};

  const serialized = JSON.parse(JSON.stringify(value)) as unknown;

  if (
    typeof serialized !== 'object' ||
    serialized === null ||
    Array.isArray(serialized)
  ) {
    return {};
  }

  return serialized as Record<string, unknown>;
}

function getResolvedOptionsForEdgeStrategy(
  strategyId: EdgeDayTradeStrategyId,
  options: ResolvedEdgeStrategyOptionsMap,
): Record<string, unknown> {
  return edgeRecordSnapshot(options[strategyId]);
}

function emptyOpportunityAutomationResult(
  persist: boolean,
  eligible: boolean,
): OpportunityAutomationResult {
  if (!persist) {
    return {
      eligible,
      attempted: false,
      status: 'not_persisted',
      opportunity_id: null,
      error: null,
    };
  }

  return {
    eligible,
    attempted: false,
    status: 'not_eligible',
    opportunity_id: null,
    error: null,
  };
}

async function createAutomaticOpportunity(
  supabase: ReturnType<typeof createClient>,
  setupId: string,
): Promise<OpportunityAutomationResult> {
  const { data, error } = await supabase.rpc(
    'create_opportunity_from_daytrade_setup',
    { p_setup_id: setupId },
  );

  if (error) {
    console.error('Falha ao criar oportunidade automática:', error);

    return {
      eligible: true,
      attempted: true,
      status: 'error',
      opportunity_id: null,
      error: error.message,
    };
  }

  const opportunityId = typeof data === 'string' ? data : null;

  if (!opportunityId) {
    return {
      eligible: true,
      attempted: true,
      status: 'error',
      opportunity_id: null,
      error: 'A RPC não retornou o identificador da oportunidade.',
    };
  }

  return {
    eligible: true,
    attempted: true,
    status: 'created_or_existing',
    opportunity_id: opportunityId,
    error: null,
  };
}

async function persistEdgeStrategyResult(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  symbol: string,
  timeframe: DayTradeIndicatorTimeframe,
  indicators: DayTradeIndicators,
  result: EdgeDayTradeStrategyResult,
  resolvedOptions: ResolvedEdgeStrategyOptionsMap,
): Promise<SavedSetupRow> {
  const evaluation = result.evaluation;
  const plan = evaluation.plan;
  const strategyDefinition = getEdgeDayTradeStrategyDefinition(
    result.strategy,
  );
  const strategyOptions = getResolvedOptionsForEdgeStrategy(
    result.strategy,
    resolvedOptions,
  );

  const row = {
    user_id: userId,
    symbol,
    timeframe,
    strategy: result.strategy,
    strategy_version: strategyDefinition.version,
    strategy_options: strategyOptions,
    plan: edgeRecordSnapshot(plan),
    status: evaluation.status,
    score: evaluation.passedConditions,
    total_conditions: evaluation.totalConditions,
    conditions: evaluation.conditions,
    indicators: edgeIndicatorSnapshot(
      indicators,
      result.strategy,
      strategyDefinition.version,
      strategyOptions,
    ),
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
      [
        'id',
        'symbol',
        'timeframe',
        'strategy',
        'strategy_version',
        'status',
        'score',
        'total_conditions',
        'strategy_options',
        'plan',
        'candle_open_time',
        'candle_close_time',
        'criado_em',
        'atualizado_em',
      ].join(','),
    )
    .single();

  if (error) throw new Error(error.message);

  return data as SavedSetupRow;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (req.method !== 'POST') {
    return errorResponse(
      405,
      'Método não permitido.',
      'METHOD_NOT_ALLOWED',
      { allowed: ['POST', 'OPTIONS'] },
    );
  }

  const authorization = req.headers.get('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    return errorResponse(
      401,
      'Usuário não autenticado.',
      'UNAUTHORIZED',
    );
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

  const supabase = createClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      global: {
        headers: { Authorization: authorization },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return errorResponse(
      401,
      'Sessão inválida ou expirada.',
      'INVALID_SESSION',
    );
  }

  try {
    const body = await readJsonBody(req);
    const symbol = parseSymbol(body.symbol);
    const timeframe = parseTimeframe(body.timeframe);
    const suppliedLivePrice = parseOptionalPositiveNumber(
      body.live_price,
      'live_price',
    );
    const persist = parseBoolean(
      body.persist,
      'persist',
      true,
    );
    const enabledStrategies = parseEnabledEdgeStrategies(
      body.enabled_strategies,
    );
    const parsedStrategyOptions = parseEdgeStrategyOptionsMap(
      body.strategy_options,
    );
    const resolvedStrategyOptions = resolveAllEdgeStrategyOptions(
      parsedStrategyOptions,
    );

    const indicatorOptions =
      DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe];
    const requiredCandles = getRequiredCandleCount(indicatorOptions);
    const requestedLimit = Math.min(
      1_000,
      requiredCandles + EXTRA_CANDLES + 1,
    );

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

    const multiStrategy = evaluateAllEdgeDayTradeStrategies({
      candles: market.closedCandles,
      indicatorOptions,
      livePrice,
      enabledStrategies,
      strategyOptions: resolvedStrategyOptions,
    });

    const breakoutEvaluation =
      multiStrategy.evaluations.trend_breakout;

    if (!breakoutEvaluation) {
      throw new Error(
        'A avaliação principal trend_breakout não foi calculada.',
      );
    }

    const savedSetups: Partial<
      Record<EdgeDayTradeStrategyId, SavedSetupRow>
    > = {};
    const persistenceErrors: StrategyPersistenceError[] = [];

    const automaticCandidate = getEdgeAutomaticOpportunityCandidate(
      multiStrategy,
    );

    let opportunity = emptyOpportunityAutomationResult(
      persist,
      automaticCandidate !== null,
    );

    if (persist) {
      const executableResult = multiStrategy.results.find(
        (result) =>
          result.strategy === TREND_BREAKOUT_STRATEGY_ID,
      );

      if (!executableResult) {
        throw new Error(
          'A estratégia executável trend_breakout não está no resultado.',
        );
      }

      // A estratégia executável é persistida primeiro. Falha aqui continua
      // retornando erro, preservando o comportamento seguro do Auto Trade.
      try {
        const savedBreakout = await persistEdgeStrategyResult(
          supabase,
          user.id,
          symbol,
          timeframe,
          multiStrategy.indicators,
          executableResult,
          resolvedStrategyOptions,
        );

        savedSetups.trend_breakout = savedBreakout;

        if (
          automaticCandidate?.strategy === TREND_BREAKOUT_STRATEGY_ID
        ) {
          assertEdgeAutomaticOpportunityCandidate(
            automaticCandidate,
          );

          opportunity = await createAutomaticOpportunity(
            supabase,
            savedBreakout.id,
          );
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Falha desconhecida.';

        console.error('Falha ao salvar trend_breakout:', error);

        return errorResponse(
          500,
          'A análise principal foi calculada, mas não pôde ser salva.',
          'SETUP_PERSIST_ERROR',
          {
            strategy: TREND_BREAKOUT_STRATEGY_ID,
            message,
          },
        );
      }

      // Estratégias shadow não podem bloquear a resposta principal nem criar
      // oportunidades. Erros são reportados separadamente.
      for (const shadowResult of multiStrategy.shadowResults) {
        try {
          const saved = await persistEdgeStrategyResult(
            supabase,
            user.id,
            symbol,
            timeframe,
            multiStrategy.indicators,
            shadowResult,
            resolvedStrategyOptions,
          );

          savedSetups[shadowResult.strategy] = saved;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Falha desconhecida.';

          console.error(
            `Falha ao salvar estratégia shadow ${shadowResult.strategy}:`,
            error,
          );

          persistenceErrors.push({
            strategy: shadowResult.strategy,
            message,
          });
        }
      }
    }

    const breakoutOptions = getResolvedOptionsForEdgeStrategy(
      TREND_BREAKOUT_STRATEGY_ID,
      resolvedStrategyOptions,
    );

    const breakoutIndicators = edgeIndicatorSnapshot(
      multiStrategy.indicators,
      TREND_BREAKOUT_STRATEGY_ID,
      TREND_BREAKOUT_STRATEGY_VERSION,
      breakoutOptions,
    );

    const shadowStrategies = multiStrategy.shadowResults.map(
      (result) => ({
        id: result.strategy,
        version:
          EDGE_DAYTRADE_STRATEGY_REGISTRY[result.strategy].version,
        execution_mode: result.executionMode,
        authorized_for_automatic_orders:
          result.authorizedForAutomaticOrders,
        setup: savedSetups[result.strategy] ?? null,
        evaluation: result.evaluation,
      }),
    );

    return jsonResponse({
      ok: true,
      persisted: persist,

      // Campos legados mantidos para clientes atuais.
      setup: savedSetups.trend_breakout ?? null,
      opportunity,
      strategy: {
        id: TREND_BREAKOUT_STRATEGY_ID,
        version: TREND_BREAKOUT_STRATEGY_VERSION,
        options: breakoutOptions,
      },
      indicators: breakoutIndicators,
      evaluation: breakoutEvaluation,

      // Novos campos multiestratégia.
      setups: savedSetups,
      persistence_errors: persistenceErrors,
      strategies: multiStrategy.results.map((result) => ({
        id: result.strategy,
        version:
          EDGE_DAYTRADE_STRATEGY_REGISTRY[result.strategy].version,
        execution_mode: result.executionMode,
        authorized_for_automatic_orders:
          result.authorizedForAutomaticOrders,
        options: getResolvedOptionsForEdgeStrategy(
          result.strategy,
          resolvedStrategyOptions,
        ),
        evaluation: result.evaluation,
      })),
      evaluations: multiStrategy.evaluations,
      shadow_strategies: shadowStrategies,
      highest_score_strategy:
        multiStrategy.highestScoreResult?.strategy ?? null,
      highest_executable_score_strategy:
        multiStrategy.highestExecutableScoreResult?.strategy ?? null,

      request: {
        symbol,
        timeframe,
        supplied_live_price: suppliedLivePrice,
        enabled_strategies:
          enabledStrategies ?? EDGE_ALL_DAYTRADE_STRATEGY_IDS,
      },
      market: {
        source: market.baseUrl,
        closed_candles: market.closedCandles.length,
        required_candles: requiredCandles,
        last_closed_candle_at: new Date(
          breakoutEvaluation.candleCloseTime,
        ).toISOString(),
        live_price: livePrice,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Erro desconhecido.';

    console.error('avaliar-daytrade:', error);

    const isInputError = [
      'symbol',
      'timeframe',
      'live_price',
      'persist',
      'enabled_strategies',
      'strategy_options',
      'JSON',
      'Corpo',
      'Day Trade aceita',
      'Estratégia inválida',
      'deve ser',
      'não é suportado',
      'não corresponde',
      'blockedVolatilityRegimes',
      'minimumStopDistanceAtr',
      'maximumStopDistanceAtr',
      'minimumRangeWidthAtr',
      'maximumRangeWidthAtr',
      'minimumRelativeVolume',
      'maximumRelativeVolume',
    ].some((part) => message.includes(part));

    return errorResponse(
      isInputError ? 400 : 502,
      message,
      isInputError ? 'INVALID_INPUT' : 'MARKET_DATA_ERROR',
    );
  }
});