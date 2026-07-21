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
  DAYTRADE_STRATEGY_REGISTRY,
  type DayTradeStrategyId,
} from './strategies';

import {
  evaluateCommonBacktestStrategy,
  getBacktestStrategyDescriptor,
  type CommonDayTradeBacktestEvaluation,
  type CommonDayTradeBacktestPlan,
  type DayTradeBacktestStrategyOptionsMap,
} from './strategies/backtestAdapter';

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