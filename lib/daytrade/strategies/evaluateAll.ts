/**
 * Avaliador central multiestratégia.
 *
 * As estratégias v2 são deliberadamente mantidas fora do registro executável
 * principal. Elas existem somente para o teste prospectivo em shadow.
 */
import {
  calculateDayTradeIndicators,
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
  type DayTradeIndicators,
} from '../indicators';
import {
  DAYTRADE_STRATEGY_REGISTRY,
  type DayTradeStrategyId,
  type DayTradeStrategyExecutionMode,
} from './index';
import {
  evaluateTrendBreakout,
  type TrendBreakoutEvaluation,
  type TrendBreakoutOptions,
} from './trendBreakout';
import {
  evaluateTrendPullback,
  type TrendPullbackEvaluation,
  type TrendPullbackOptions,
} from './trendPullback';
import {
  evaluateSqueezeBreakout,
  type SqueezeBreakoutEvaluation,
  type SqueezeBreakoutOptions,
} from './squeezeBreakout';
import {
  evaluateRangeMeanReversion,
  type RangeMeanReversionEvaluation,
  type RangeMeanReversionOptions,
} from './rangeMeanReversion';
import {
  FAILED_BREAKOUT_REVERSAL_STRATEGY_ID,
  evaluateFailedBreakoutReversal,
  type FailedBreakoutReversalEvaluation,
  type FailedBreakoutReversalOptions,
} from './failedBreakoutReversal';
import {
  CONFIRMED_TREND_CONTINUATION_STRATEGY_ID,
  evaluateConfirmedTrendContinuation,
  type ConfirmedTrendContinuationEvaluation,
  type ConfirmedTrendContinuationOptions,
} from './confirmedTrendContinuation';

export type ForwardTestStrategyId =
  | DayTradeStrategyId
  | typeof FAILED_BREAKOUT_REVERSAL_STRATEGY_ID
  | typeof CONFIRMED_TREND_CONTINUATION_STRATEGY_ID;

export interface DayTradeStrategyOptionsMap {
  trend_breakout?: TrendBreakoutOptions;
  trend_pullback?: TrendPullbackOptions;
  squeeze_breakout?: SqueezeBreakoutOptions;
  range_mean_reversion?: RangeMeanReversionOptions;
  failed_breakout_reversal?: FailedBreakoutReversalOptions;
  confirmed_trend_continuation?: ConfirmedTrendContinuationOptions;
}

export type AnyDayTradeStrategyEvaluation =
  | TrendBreakoutEvaluation
  | TrendPullbackEvaluation
  | SqueezeBreakoutEvaluation
  | RangeMeanReversionEvaluation
  | FailedBreakoutReversalEvaluation
  | ConfirmedTrendContinuationEvaluation;

export interface DayTradeStrategyEvaluationMap {
  trend_breakout: TrendBreakoutEvaluation;
  trend_pullback: TrendPullbackEvaluation;
  squeeze_breakout: SqueezeBreakoutEvaluation;
  range_mean_reversion: RangeMeanReversionEvaluation;
  failed_breakout_reversal: FailedBreakoutReversalEvaluation;
  confirmed_trend_continuation: ConfirmedTrendContinuationEvaluation;
}

export interface EvaluateAllDayTradeStrategiesInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  livePrice?: number | null;
  strategyOptions?: DayTradeStrategyOptionsMap;
  enabledStrategies?: readonly ForwardTestStrategyId[];
}

export interface DayTradeStrategyResult<
  TEvaluation extends AnyDayTradeStrategyEvaluation =
    AnyDayTradeStrategyEvaluation,
> {
  strategy: ForwardTestStrategyId;
  executionMode: 'testnet_allowed' | 'shadow';
  authorizedForAutomaticOrders: boolean;
  evaluation: TEvaluation;
}

export interface EvaluateAllDayTradeStrategiesResult {
  candles: DayTradeCandle[];
  indicators: DayTradeIndicators;
  evaluations: Partial<DayTradeStrategyEvaluationMap>;
  results: DayTradeStrategyResult[];
  executableResults: DayTradeStrategyResult[];
  shadowResults: DayTradeStrategyResult[];
  highestScoreResult: DayTradeStrategyResult | null;
  highestExecutableScoreResult: DayTradeStrategyResult | null;
}

const DEFAULT_STRATEGY_IDS = [
  'trend_breakout',
  'trend_pullback',
  'squeeze_breakout',
  'range_mean_reversion',
] as const satisfies readonly DayTradeStrategyId[];

const FORWARD_TEST_STRATEGY_IDS = [
  ...DEFAULT_STRATEGY_IDS,
  FAILED_BREAKOUT_REVERSAL_STRATEGY_ID,
  CONFIRMED_TREND_CONTINUATION_STRATEGY_ID,
] as const satisfies readonly ForwardTestStrategyId[];

function resolveEnabledStrategies(
  value: readonly ForwardTestStrategyId[] | undefined,
): ForwardTestStrategyId[] {
  if (value === undefined) return [...DEFAULT_STRATEGY_IDS];
  const unique = Array.from(new Set(value));
  for (const strategyId of unique) {
    if (!FORWARD_TEST_STRATEGY_IDS.includes(strategyId)) {
      throw new Error(`Estratégia inválida: ${strategyId}.`);
    }
  }
  return unique;
}

function experimentalOrder(strategy: ForwardTestStrategyId): number {
  if (strategy === FAILED_BREAKOUT_REVERSAL_STRATEGY_ID) return 5;
  if (strategy === CONFIRMED_TREND_CONTINUATION_STRATEGY_ID) return 6;
  return DAYTRADE_STRATEGY_REGISTRY[strategy].displayOrder;
}

function createStrategyResult<
  TEvaluation extends AnyDayTradeStrategyEvaluation,
>(
  strategy: ForwardTestStrategyId,
  evaluation: TEvaluation,
): DayTradeStrategyResult<TEvaluation> {
  if (
    strategy === FAILED_BREAKOUT_REVERSAL_STRATEGY_ID ||
    strategy === CONFIRMED_TREND_CONTINUATION_STRATEGY_ID
  ) {
    return {
      strategy,
      executionMode: 'shadow',
      authorizedForAutomaticOrders: false,
      evaluation,
    };
  }
  const definition = DAYTRADE_STRATEGY_REGISTRY[strategy];
  return {
    strategy,
    executionMode: definition.executionMode,
    authorizedForAutomaticOrders: definition.authorizedForAutomaticOrders,
    evaluation,
  };
}

function compareByScoreThenOrder(
  left: DayTradeStrategyResult,
  right: DayTradeStrategyResult,
): number {
  const scoreDifference =
    right.evaluation.scorePct - left.evaluation.scorePct;
  return scoreDifference !== 0
    ? scoreDifference
    : experimentalOrder(left.strategy) - experimentalOrder(right.strategy);
}

function getHighestScoreResult(
  results: readonly DayTradeStrategyResult[],
): DayTradeStrategyResult | null {
  return results.length === 0
    ? null
    : [...results].sort(compareByScoreThenOrder)[0];
}

export function evaluateAllDayTradeStrategies(
  input: EvaluateAllDayTradeStrategiesInput,
): EvaluateAllDayTradeStrategiesResult {
  const candles = normalizeClosedCandles(input.candles);
  if (candles.length < 2) {
    throw new Error('São necessários pelo menos dois candles encerrados.');
  }
  const indicators = calculateDayTradeIndicators(candles, input.indicatorOptions);
  const enabledStrategies = resolveEnabledStrategies(input.enabledStrategies);
  const evaluations: Partial<DayTradeStrategyEvaluationMap> = {};
  const results: DayTradeStrategyResult[] = [];

  for (const strategyId of enabledStrategies) {
    switch (strategyId) {
      case 'trend_breakout': {
        const evaluation = evaluateTrendBreakout({
          candles,
          indicators,
          livePrice: input.livePrice,
          options: input.strategyOptions?.trend_breakout,
        });
        evaluations.trend_breakout = evaluation;
        results.push(createStrategyResult(strategyId, evaluation));
        break;
      }
      case 'trend_pullback': {
        const evaluation = evaluateTrendPullback({
          candles,
          indicators,
          livePrice: input.livePrice,
          options: input.strategyOptions?.trend_pullback,
        });
        evaluations.trend_pullback = evaluation;
        results.push(createStrategyResult(strategyId, evaluation));
        break;
      }
      case 'squeeze_breakout': {
        const evaluation = evaluateSqueezeBreakout({
          candles,
          indicators,
          livePrice: input.livePrice,
          options: input.strategyOptions?.squeeze_breakout,
        });
        evaluations.squeeze_breakout = evaluation;
        results.push(createStrategyResult(strategyId, evaluation));
        break;
      }
      case 'range_mean_reversion': {
        const evaluation = evaluateRangeMeanReversion({
          candles,
          indicators,
          livePrice: input.livePrice,
          options: input.strategyOptions?.range_mean_reversion,
        });
        evaluations.range_mean_reversion = evaluation;
        results.push(createStrategyResult(strategyId, evaluation));
        break;
      }
      case 'failed_breakout_reversal': {
        const evaluation = evaluateFailedBreakoutReversal({
          candles,
          indicators,
          livePrice: input.livePrice,
          options: input.strategyOptions?.failed_breakout_reversal,
        });
        evaluations.failed_breakout_reversal = evaluation;
        results.push(createStrategyResult(strategyId, evaluation));
        break;
      }
      case 'confirmed_trend_continuation': {
        const evaluation = evaluateConfirmedTrendContinuation({
          candles,
          indicators,
          livePrice: input.livePrice,
          options: input.strategyOptions?.confirmed_trend_continuation,
        });
        evaluations.confirmed_trend_continuation = evaluation;
        results.push(createStrategyResult(strategyId, evaluation));
        break;
      }
      default: {
        const exhaustiveCheck: never = strategyId;
        throw new Error(`Estratégia não implementada: ${String(exhaustiveCheck)}.`);
      }
    }
  }

  const sortedResults = [...results].sort(compareByScoreThenOrder);
  const executableResults = sortedResults.filter(
    (result) => result.authorizedForAutomaticOrders,
  );
  const shadowResults = sortedResults.filter(
    (result) => !result.authorizedForAutomaticOrders,
  );

  return {
    candles,
    indicators,
    evaluations,
    results: sortedResults,
    executableResults,
    shadowResults,
    highestScoreResult: getHighestScoreResult(sortedResults),
    highestExecutableScoreResult: getHighestScoreResult(executableResults),
  };
}

export function getAutomaticOrderCandidate(
  result: EvaluateAllDayTradeStrategiesResult,
): DayTradeStrategyResult | null {
  return getHighestScoreResult(
    result.executableResults.filter(
      (item) =>
        item.evaluation.allConditionsMet &&
        item.evaluation.status === 'condicoes_atendidas' &&
        item.evaluation.plan !== null,
    ),
  );
}

export function assertAutomaticOrderCandidate(
  result: DayTradeStrategyResult,
): void {
  if (
    result.strategy === FAILED_BREAKOUT_REVERSAL_STRATEGY_ID ||
    result.strategy === CONFIRMED_TREND_CONTINUATION_STRATEGY_ID
  ) {
    throw new Error(
      `A estratégia experimental ${result.strategy} está em shadow.`,
    );
  }
const definition = DAYTRADE_STRATEGY_REGISTRY[result.strategy];

const executionMode =
  definition.executionMode as DayTradeStrategyExecutionMode;

if (
  !definition.authorizedForAutomaticOrders ||
  executionMode !== 'testnet_allowed'
) {
    throw new Error(
      `A estratégia ${result.strategy} está em shadow e não pode criar ordem.`,
    );
  }
  if (
    !result.evaluation.allConditionsMet ||
    result.evaluation.status !== 'condicoes_atendidas' ||
    result.evaluation.plan === null
  ) {
    throw new Error(`A estratégia ${result.strategy} não possui setup elegível.`);
  }
}
