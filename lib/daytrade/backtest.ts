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

import {
  calculateDayTradeIndicators,
  classifyVolatilityRegime,
  getRequiredCandleCount,
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
  type DayTradeIndicators,
  type DayTradeIndicatorPoint,
  type VolatilityRegime,
} from './indicators';

import { calculatePositionSize } from './risk';

import {
  evaluateTrendBreakout,
  TREND_BREAKOUT_STRATEGY_ID,
  TREND_BREAKOUT_STRATEGY_VERSION,
  type TrendBreakoutEvaluation,
  type TrendBreakoutOptions,
  type TrendBreakoutPlan,
} from './strategies/trendBreakout';

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

const DEFAULT_OPTIONS: ResolvedTrendBreakoutBacktestOptions = {
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
    options.riskPercent ?? DEFAULT_OPTIONS.riskPercent,
    'riskPercent',
  );

  if (riskPercent > 2) {
    throw new Error('riskPercent não pode ultrapassar 2% por operação.');
  }

  const intrabarPriority =
    options.intrabarPriority ?? DEFAULT_OPTIONS.intrabarPriority;

  if (!['stop_first', 'target_first'].includes(intrabarPriority)) {
    throw new Error('intrabarPriority inválido.');
  }

  const maxPositionNotional =
    options.maxPositionNotional ?? DEFAULT_OPTIONS.maxPositionNotional;

  if (
    maxPositionNotional !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(maxPositionNotional) || maxPositionNotional <= 0)
  ) {
    throw new Error('maxPositionNotional deve ser maior que zero.');
  }

  return {
    initialCapitalUsdt: positive(
      options.initialCapitalUsdt ?? DEFAULT_OPTIONS.initialCapitalUsdt,
      'initialCapitalUsdt',
    ),
    riskPercent,
    feeRatePct: nonNegative(
      options.feeRatePct ?? DEFAULT_OPTIONS.feeRatePct,
      'feeRatePct',
    ),
    slippagePct: nonNegative(
      options.slippagePct ?? DEFAULT_OPTIONS.slippagePct,
      'slippagePct',
    ),
    stepSize: positive(
      options.stepSize ?? DEFAULT_OPTIONS.stepSize,
      'stepSize',
    ),
    minQuantity: nonNegative(
      options.minQuantity ?? DEFAULT_OPTIONS.minQuantity,
      'minQuantity',
    ),
    minNotional: nonNegative(
      options.minNotional ?? DEFAULT_OPTIONS.minNotional,
      'minNotional',
    ),
    maxPositionNotional,
    intrabarPriority,
    maximumHoldingCandles: nonNegativeInteger(
      options.maximumHoldingCandles ?? DEFAULT_OPTIONS.maximumHoldingCandles,
      'maximumHoldingCandles',
    ),
    maximumNextOpenDistanceAtr: nonNegative(
      options.maximumNextOpenDistanceAtr ??
        DEFAULT_OPTIONS.maximumNextOpenDistanceAtr,
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
      candles: candles.slice(Math.max(0, index - 1), index + 1),
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