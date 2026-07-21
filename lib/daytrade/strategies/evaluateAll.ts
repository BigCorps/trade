/**
 * lib/daytrade/strategies/evaluateAll.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Avaliador central das estratégias de Day Trade.
 *
 * Responsabilidades:
 * - Normalizar os candles uma única vez.
 * - Calcular os indicadores uma única vez.
 * - Executar as quatro estratégias sobre o mesmo snapshot de mercado.
 * - Separar a estratégia autorizada para ordens das estratégias shadow.
 * - Entregar uma resposta estável para interface, backtest e persistência.
 *
 * Regra de segurança:
 * - Apenas trend_breakout pode ser marcado como executável.
 * - As demais estratégias são calculadas somente para observação e comparação.
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

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export interface DayTradeStrategyOptionsMap {
  trend_breakout?: TrendBreakoutOptions;
  trend_pullback?: TrendPullbackOptions;
  squeeze_breakout?: SqueezeBreakoutOptions;
  range_mean_reversion?: RangeMeanReversionOptions;
}

export type AnyDayTradeStrategyEvaluation =
  | TrendBreakoutEvaluation
  | TrendPullbackEvaluation
  | SqueezeBreakoutEvaluation
  | RangeMeanReversionEvaluation;

export interface DayTradeStrategyEvaluationMap {
  trend_breakout: TrendBreakoutEvaluation;
  trend_pullback: TrendPullbackEvaluation;
  squeeze_breakout: SqueezeBreakoutEvaluation;
  range_mean_reversion: RangeMeanReversionEvaluation;
}

export interface EvaluateAllDayTradeStrategiesInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;

  /**
   * Preço ao vivo opcional.
   *
   * É usado somente para detectar entrada atrasada ou invalidação.
   * Nunca confirma setup.
   */
  livePrice?: number | null;

  /**
   * Permite alterar parâmetros de cada estratégia sem misturar configurações.
   */
  strategyOptions?: DayTradeStrategyOptionsMap;

  /**
   * Estratégias que devem ser avaliadas.
   *
   * Quando omitido, executa as quatro.
   */
  enabledStrategies?: readonly DayTradeStrategyId[];
}

export interface DayTradeStrategyResult<
  TEvaluation extends AnyDayTradeStrategyEvaluation =
    AnyDayTradeStrategyEvaluation,
> {
  strategy: DayTradeStrategyId;
  executionMode: 'testnet_allowed' | 'shadow';
  authorizedForAutomaticOrders: boolean;
  evaluation: TEvaluation;
}

export interface EvaluateAllDayTradeStrategiesResult {
  /**
   * Candles encerrados, validados, ordenados e deduplicados.
   */
  candles: DayTradeCandle[];

  /**
   * Snapshot único de indicadores usado por todas as estratégias.
   */
  indicators: DayTradeIndicators;

  /**
   * Resultado tipado por ID.
   */
  evaluations: Partial<DayTradeStrategyEvaluationMap>;

  /**
   * Lista pronta para iteração, persistência e interface.
   */
  results: DayTradeStrategyResult[];

  /**
   * Estratégias autorizadas a chegar ao fluxo de oportunidade automática.
   */
  executableResults: DayTradeStrategyResult[];

  /**
   * Estratégias calculadas apenas para comparação.
   */
  shadowResults: DayTradeStrategyResult[];

  /**
   * Melhor resultado por score, sem conceder autorização de execução.
   */
  highestScoreResult: DayTradeStrategyResult | null;

  /**
   * Melhor resultado entre estratégias autorizadas.
   */
  highestExecutableScoreResult: DayTradeStrategyResult | null;
}

// -----------------------------------------------------------------------------
// Configuração
// -----------------------------------------------------------------------------

const ALL_STRATEGY_IDS = [
  'trend_breakout',
  'trend_pullback',
  'squeeze_breakout',
  'range_mean_reversion',
] as const satisfies readonly DayTradeStrategyId[];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveEnabledStrategies(
  value: readonly DayTradeStrategyId[] | undefined,
): DayTradeStrategyId[] {
  if (value === undefined) {
    return [...ALL_STRATEGY_IDS];
  }

  const unique = Array.from(new Set(value));

  for (const strategyId of unique) {
    if (!ALL_STRATEGY_IDS.includes(strategyId)) {
      throw new Error(
        `Estratégia inválida: ${strategyId}. Valores aceitos: ${ALL_STRATEGY_IDS.join(', ')}.`,
      );
    }
  }

  return unique;
}

function createStrategyResult<
  TEvaluation extends AnyDayTradeStrategyEvaluation,
>(
  strategy: DayTradeStrategyId,
  evaluation: TEvaluation,
): DayTradeStrategyResult<TEvaluation> {
  const definition =
    DAYTRADE_STRATEGY_REGISTRY[strategy];

  return {
    strategy,
    executionMode: definition.executionMode,
    authorizedForAutomaticOrders:
      definition.authorizedForAutomaticOrders,
    evaluation,
  };
}

function compareByScoreThenOrder(
  left: DayTradeStrategyResult,
  right: DayTradeStrategyResult,
): number {
  const scoreDifference =
    right.evaluation.scorePct -
    left.evaluation.scorePct;

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const leftOrder =
    DAYTRADE_STRATEGY_REGISTRY[left.strategy]
      .displayOrder;

  const rightOrder =
    DAYTRADE_STRATEGY_REGISTRY[right.strategy]
      .displayOrder;

  return leftOrder - rightOrder;
}

function getHighestScoreResult(
  results: readonly DayTradeStrategyResult[],
): DayTradeStrategyResult | null {
  if (results.length === 0) {
    return null;
  }

  return [...results].sort(
    compareByScoreThenOrder,
  )[0];
}

// -----------------------------------------------------------------------------
// Avaliação central
// -----------------------------------------------------------------------------

export function evaluateAllDayTradeStrategies(
  input: EvaluateAllDayTradeStrategiesInput,
): EvaluateAllDayTradeStrategiesResult {
  const candles =
    normalizeClosedCandles(input.candles);

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
    resolveEnabledStrategies(
      input.enabledStrategies,
    );

  const evaluations: Partial<DayTradeStrategyEvaluationMap> =
    {};

  const results: DayTradeStrategyResult[] = [];

  for (const strategyId of enabledStrategies) {
    switch (strategyId) {
      case 'trend_breakout': {
        const evaluation =
          evaluateTrendBreakout({
            candles,
            indicators,
            livePrice: input.livePrice,
            options:
              input.strategyOptions
                ?.trend_breakout,
          });

        evaluations.trend_breakout =
          evaluation;

        results.push(
          createStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      case 'trend_pullback': {
        const evaluation =
          evaluateTrendPullback({
            candles,
            indicators,
            livePrice: input.livePrice,
            options:
              input.strategyOptions
                ?.trend_pullback,
          });

        evaluations.trend_pullback =
          evaluation;

        results.push(
          createStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      case 'squeeze_breakout': {
        const evaluation =
          evaluateSqueezeBreakout({
            candles,
            indicators,
            livePrice: input.livePrice,
            options:
              input.strategyOptions
                ?.squeeze_breakout,
          });

        evaluations.squeeze_breakout =
          evaluation;

        results.push(
          createStrategyResult(
            strategyId,
            evaluation,
          ),
        );

        break;
      }

      case 'range_mean_reversion': {
        const evaluation =
          evaluateRangeMeanReversion({
            candles,
            indicators,
            livePrice: input.livePrice,
            options:
              input.strategyOptions
                ?.range_mean_reversion,
          });

        evaluations.range_mean_reversion =
          evaluation;

        results.push(
          createStrategyResult(
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
      compareByScoreThenOrder,
    );

  const executableResults =
    sortedResults.filter(
      (result) =>
        result.authorizedForAutomaticOrders,
    );

  const shadowResults =
    sortedResults.filter(
      (result) =>
        !result.authorizedForAutomaticOrders,
    );

  return {
    candles,
    indicators,
    evaluations,
    results: sortedResults,
    executableResults,
    shadowResults,
    highestScoreResult:
      getHighestScoreResult(
        sortedResults,
      ),
    highestExecutableScoreResult:
      getHighestScoreResult(
        executableResults,
      ),
  };
}

// -----------------------------------------------------------------------------
// Helpers de segurança para execução
// -----------------------------------------------------------------------------

export function getAutomaticOrderCandidate(
  result: EvaluateAllDayTradeStrategiesResult,
): DayTradeStrategyResult | null {
  const candidates =
    result.executableResults.filter(
      (item) =>
        item.evaluation
          .allConditionsMet &&
        item.evaluation.status ===
          'condicoes_atendidas' &&
        item.evaluation.plan !== null,
    );

  return getHighestScoreResult(
    candidates,
  );
}

export function assertAutomaticOrderCandidate(
  result: DayTradeStrategyResult,
): void {
  const definition =
    DAYTRADE_STRATEGY_REGISTRY[result.strategy];

  if (
    !definition.authorizedForAutomaticOrders ||
    definition.executionMode !==
      'testnet_allowed'
  ) {
    throw new Error(
      `A estratégia ${result.strategy} está em modo shadow e não pode criar oportunidade ou ordem.`,
    );
  }

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