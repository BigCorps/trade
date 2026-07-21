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

import {
  DAYTRADE_STRATEGY_IDS,
  DAYTRADE_STRATEGY_REGISTRY,
  type DayTradeStrategyId,
} from './strategies';

import {
  runMultiStrategyBacktest,
  type MultiStrategyBacktestInput,
  type MultiStrategyBacktestOptions,
  type MultiStrategyBacktestResult,
} from './multiStrategyBacktest';

import type {
  DayTradeCandle,
  DayTradeIndicatorOptions,
} from './indicators';

import type {
  DayTradeBacktestStrategyOptionsMap,
} from './strategies/backtestAdapter';

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