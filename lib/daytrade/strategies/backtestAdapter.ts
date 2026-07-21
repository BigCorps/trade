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

import {
  getRequiredCandleCount,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
  type DayTradeIndicators,
} from '../indicators';

import {
  DAYTRADE_STRATEGY_REGISTRY,
  type DayTradeStrategyId,
} from './index';

import {
  evaluateTrendBreakout,
  resolveTrendBreakoutOptions,
  type TrendBreakoutEvaluation,
  type TrendBreakoutOptions,
  type TrendBreakoutPlan,
} from './trendBreakout';

import {
  evaluateTrendPullback,
  resolveTrendPullbackOptions,
  type TrendPullbackEvaluation,
  type TrendPullbackOptions,
  type TrendPullbackPlan,
} from './trendPullback';

import {
  evaluateSqueezeBreakout,
  resolveSqueezeBreakoutOptions,
  type SqueezeBreakoutEvaluation,
  type SqueezeBreakoutOptions,
  type SqueezeBreakoutPlan,
} from './squeezeBreakout';

import {
  evaluateRangeMeanReversion,
  resolveRangeMeanReversionOptions,
  type RangeMeanReversionEvaluation,
  type RangeMeanReversionOptions,
  type RangeMeanReversionPlan,
} from './rangeMeanReversion';

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