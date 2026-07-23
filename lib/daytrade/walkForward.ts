/**
 * lib/daytrade/walkForward.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Validação walk-forward sobre o motor multi-estratégia.
 *
 * Objetivo:
 * - Dividir o histórico em janelas sequenciais de validação.
 * - Executar o mesmo backtest determinístico em cada janela, com aquecimento.
 * - Medir a consistência temporal do resultado (não apenas o agregado).
 *
 * Regras importantes:
 * - Este módulo NÃO consulta APIs, NÃO grava no banco e NÃO executa ordens.
 * - Os parâmetros são idênticos em todas as janelas. Isto mede robustez
 *   temporal de uma configuração fixa; não é otimização por janela.
 * - Cada janela reinicia o capital da simulação. Por isso a agregação usa
 *   métricas em R (independentes de capital composto), e não PnL somado.
 * - Operações abertas no fim da janela (exitReason "end_of_data") são
 *   descartadas por padrão, pois não têm resultado real. Isto introduz um
 *   pequeno viés de sobrevivência no fim de cada janela, documentado aqui.
 * - Janelas com poucas operações são sinalizadas como amostra baixa e NÃO
 *   devem ser interpretadas isoladamente.
 *
 * Limitações honestas:
 * - Walk-forward com parâmetros fixos detecta inconsistência entre períodos,
 *   mas não elimina o viés de seleção se você comparar muitas configurações
 *   e escolher a melhor. Defina critérios de aprovação ANTES de rodar.
 */

import {
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
} from './indicators';

import type { DayTradeStrategyId } from './strategies';

import type { DayTradeBacktestStrategyOptionsMap } from './strategies/backtestAdapter';

import {
  runMultiStrategyBacktest,
  type MultiStrategyBacktestOptions,
  type MultiStrategyBacktestResult,
  type MultiStrategyBacktestTrade,
} from './multiStrategyBacktest';

// -----------------------------------------------------------------------------
// Identidade do módulo
// -----------------------------------------------------------------------------

export const WALK_FORWARD_VERSION = '1.0.0' as const;

export const WALK_FORWARD_EDUCATIONAL_NOTICE =
  'Resultado educacional. A validação walk-forward mede consistência histórica de regras fixas e não representa recomendação nem promessa de resultado.';

// -----------------------------------------------------------------------------
// Tipos públicos
// -----------------------------------------------------------------------------

export interface WalkForwardOptions {
  /** Quantidade de candles avaliados em cada janela de validação. */
  windowCandles: number;

  /**
   * Candles anteriores à janela usados apenas para aquecer os indicadores.
   * Deve ser maior que o requisito dos indicadores (EMA lenta, volatilidade,
   * amostras de regime). Padrão: 300.
   */
  warmupCandles?: number;

  /**
   * Janelas com menos operações que este valor são marcadas com
   * lowSample = true. Padrão: 3.
   */
  minimumTradesPerWindow?: number;

  /**
   * Descarta operações encerradas por "end_of_data" (posição ainda aberta no
   * fim da janela). Padrão: true.
   */
  excludeEndOfDataTrades?: boolean;
}

export interface ResolvedWalkForwardOptions {
  windowCandles: number;
  warmupCandles: number;
  minimumTradesPerWindow: number;
  excludeEndOfDataTrades: boolean;
}

export interface WalkForwardInput {
  strategyId: DayTradeStrategyId;
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  strategyOptions?: Partial<DayTradeBacktestStrategyOptionsMap>;
  backtestOptions?: MultiStrategyBacktestOptions;
  walkForwardOptions: WalkForwardOptions;
}

export interface WalkForwardWindowResult {
  index: number;

  /** Posição da janela na série normalizada (sem contar o aquecimento). */
  firstCandleIndex: number;
  lastCandleIndex: number;

  firstCandleOpenTime: number;
  lastCandleCloseTime: number;

  candleCount: number;

  /** Janela pulada por dados insuficientes ou erro do motor. */
  skipped: boolean;
  skipReason: string | null;

  trades: number;
  excludedEndOfDataTrades: number;

  wins: number;
  losses: number;
  breakeven: number;

  winRatePct: number | null;
  sumR: number;
  averageR: number | null;
  medianR: number | null;
  bestR: number | null;
  worstR: number | null;

  /** Amostra insuficiente para leitura individual. */
  lowSample: boolean;
}

export interface WalkForwardAggregate {
  windowCount: number;
  evaluatedWindowCount: number;
  skippedWindowCount: number;
  lowSampleWindowCount: number;

  totalTrades: number;
  excludedEndOfDataTrades: number;

  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number | null;

  sumR: number;
  averageR: number | null;
  medianR: number | null;

  /** Desvio padrão do resultado por operação, em R. */
  standardDeviationR: number | null;

  /** Erro padrão da média (desvio padrão dividido pela raiz de n). */
  standardErrorR: number | null;

  /**
   * Estatística t da média contra zero (média / erro padrão).
   *
   * Regra prática: |t| abaixo de 2 significa que o resultado NÃO é
   * distinguível de sorte. Não é prova de ausência de vantagem, é ausência
   * de evidência. Atenção: quando muitas configurações são comparadas, um
   * |t| acima de 2 aparece por acaso com frequência — este número só tem
   * valor pleno em teste definido antes de rodar.
   */
  tStatistic: number | null;

  /** Soma dos R positivos dividida pela soma absoluta dos R negativos. */
  profitFactorR: number | null;

  /** Percentual de janelas avaliadas com soma de R positiva. */
  positiveWindowsPct: number | null;
  positiveWindows: number;

  bestWindowSumR: number | null;
  worstWindowSumR: number | null;
}

export interface WalkForwardResult {
  version: typeof WALK_FORWARD_VERSION;
  strategy: DayTradeStrategyId;

  options: ResolvedWalkForwardOptions;

  candleCount: number;
  firstCandleOpenTime: number | null;
  lastCandleCloseTime: number | null;

  windows: WalkForwardWindowResult[];
  aggregate: WalkForwardAggregate;

  warnings: string[];
  educationalNotice: typeof WALK_FORWARD_EDUCATIONAL_NOTICE;

  /**
   * Resultados completos por janela, na mesma ordem de windows (janelas
   * puladas ficam como null). Úteis para inspecionar trades e equity curve.
   */
  windowResults: Array<MultiStrategyBacktestResult | null>;
}

// -----------------------------------------------------------------------------
// Defaults e validação
// -----------------------------------------------------------------------------

const WALK_FORWARD_DEFAULTS = {
  warmupCandles: 300,
  minimumTradesPerWindow: 3,
  excludeEndOfDataTrades: true,
} as const;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um número inteiro maior que zero.`);
  }
  return value;
}

export function resolveWalkForwardOptions(
  options: WalkForwardOptions,
): ResolvedWalkForwardOptions {
  return {
    windowCandles: positiveInteger(options.windowCandles, 'windowCandles'),
    warmupCandles: positiveInteger(
      options.warmupCandles ?? WALK_FORWARD_DEFAULTS.warmupCandles,
      'warmupCandles',
    ),
    minimumTradesPerWindow: positiveInteger(
      options.minimumTradesPerWindow ??
        WALK_FORWARD_DEFAULTS.minimumTradesPerWindow,
      'minimumTradesPerWindow',
    ),
    excludeEndOfDataTrades:
      options.excludeEndOfDataTrades ??
      WALK_FORWARD_DEFAULTS.excludeEndOfDataTrades,
  };
}

// -----------------------------------------------------------------------------
// Auxiliares numéricos
// -----------------------------------------------------------------------------

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// -----------------------------------------------------------------------------
// Estatísticas de um conjunto de trades
// -----------------------------------------------------------------------------

interface TradeSetStats {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRatePct: number | null;
  sumR: number;
  averageR: number | null;
  medianR: number | null;
  bestR: number | null;
  worstR: number | null;
  standardDeviationR: number | null;
}

function computeTradeSetStats(
  trades: readonly MultiStrategyBacktestTrade[],
): TradeSetStats {
  const rValues = trades.map((trade) => trade.resultR);

  const wins = trades.filter((trade) => trade.result === 'win').length;
  const losses = trades.filter((trade) => trade.result === 'loss').length;
  const breakeven = trades.length - wins - losses;

  const decisive = wins + losses;

  const averageR =
    rValues.length === 0 ? null : sum(rValues) / rValues.length;

  /**
   * Desvio padrão amostral (n-1), base do erro padrão da média.
   *
   * Quando todas as operações têm o mesmo resultado (por exemplo, poucas
   * operações todas encerradas no stop cheio), a soma dos quadrados dá um
   * resíduo de ponto flutuante em vez de zero exato. Sem o corte abaixo, esse
   * resíduo vira um erro padrão minúsculo e produz uma estatística t
   * absurdamente alta. Valores abaixo da tolerância são tratados como zero.
   */
  const rawStandardDeviation =
    rValues.length < 2 || averageR === null
      ? null
      : Math.sqrt(
          sum(rValues.map((value) => (value - averageR) ** 2)) /
            (rValues.length - 1),
        );

  const standardDeviationR =
    rawStandardDeviation === null || rawStandardDeviation < 1e-6
      ? null
      : rawStandardDeviation;

  return {
    trades: trades.length,
    wins,
    losses,
    breakeven,
    winRatePct: decisive === 0 ? null : (wins / decisive) * 100,
    sumR: sum(rValues),
    averageR,
    medianR: median(rValues),
    bestR: rValues.length === 0 ? null : Math.max(...rValues),
    worstR: rValues.length === 0 ? null : Math.min(...rValues),
    standardDeviationR,
  };
}

// -----------------------------------------------------------------------------
// Execução principal
// -----------------------------------------------------------------------------

export function runWalkForwardBacktest(
  input: WalkForwardInput,
): WalkForwardResult {
  const options = resolveWalkForwardOptions(input.walkForwardOptions);
  const candles = normalizeClosedCandles(input.candles);
  const warnings: string[] = [];

  const minimumTotal = options.warmupCandles + options.windowCandles;

  if (candles.length < minimumTotal) {
    throw new Error(
      `A validação walk-forward exige pelo menos ${minimumTotal} candles ` +
        `(${options.warmupCandles} de aquecimento + ${options.windowCandles} ` +
        `da primeira janela). Foram recebidos ${candles.length}.`,
    );
  }

  const windows: WalkForwardWindowResult[] = [];
  const windowResults: Array<MultiStrategyBacktestResult | null> = [];
  const allTrades: MultiStrategyBacktestTrade[] = [];

  let excludedEndOfDataTotal = 0;
  let windowIndex = 0;

  for (
    let start = options.warmupCandles;
    start < candles.length;
    start += options.windowCandles
  ) {
    const end = Math.min(start + options.windowCandles, candles.length);
    const windowCandleCount = end - start;

    // Descarta janela final residual muito curta (menos de metade do tamanho):
    // ela teria peso estatístico desproporcionalmente baixo e ruído alto.
    if (
      windowCandleCount < Math.ceil(options.windowCandles / 2) &&
      windows.length > 0
    ) {
      warnings.push(
        `A janela residual final com ${windowCandleCount} candles foi ` +
          `descartada por ter menos da metade do tamanho configurado.`,
      );
      break;
    }

    const sliceStart = start - options.warmupCandles;
    const slice = candles.slice(sliceStart, end);

    const windowStartOpenTime = candles[start].openTime;
    const windowEndCloseTime = candles[end - 1].closeTime;

    const base: Omit<
      WalkForwardWindowResult,
      | 'skipped'
      | 'skipReason'
      | 'trades'
      | 'excludedEndOfDataTrades'
      | 'wins'
      | 'losses'
      | 'breakeven'
      | 'winRatePct'
      | 'sumR'
      | 'averageR'
      | 'medianR'
      | 'bestR'
      | 'worstR'
      | 'lowSample'
    > = {
      index: windowIndex,
      firstCandleIndex: start,
      lastCandleIndex: end - 1,
      firstCandleOpenTime: windowStartOpenTime,
      lastCandleCloseTime: windowEndCloseTime,
      candleCount: windowCandleCount,
    };

    let result: MultiStrategyBacktestResult;

    try {
      result = runMultiStrategyBacktest({
        strategyId: input.strategyId,
        candles: slice,
        indicatorOptions: input.indicatorOptions,
        strategyOptions: input.strategyOptions,
        backtestOptions: input.backtestOptions,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erro desconhecido no motor.';

      warnings.push(
        `A janela ${windowIndex} foi pulada: ${message} ` +
          `Considere aumentar warmupCandles.`,
      );

      windows.push({
        ...base,
        skipped: true,
        skipReason: message,
        trades: 0,
        excludedEndOfDataTrades: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        winRatePct: null,
        sumR: 0,
        averageR: null,
        medianR: null,
        bestR: null,
        worstR: null,
        lowSample: true,
      });

      windowResults.push(null);
      windowIndex += 1;
      continue;
    }

    // Somente operações cujo sinal pertence à janela de validação contam.
    // Sinais gerados durante o aquecimento são descartados: eles existem
    // apenas para estabilizar indicadores, não para medir resultado.
    const inWindow = result.trades.filter(
      (trade) => trade.entryTime >= windowStartOpenTime,
    );

    const endOfData = inWindow.filter(
      (trade) => trade.exitReason === 'end_of_data',
    );

    const counted = options.excludeEndOfDataTrades
      ? inWindow.filter((trade) => trade.exitReason !== 'end_of_data')
      : inWindow;

    excludedEndOfDataTotal += options.excludeEndOfDataTrades
      ? endOfData.length
      : 0;

    const stats = computeTradeSetStats(counted);

    windows.push({
      ...base,
      skipped: false,
      skipReason: null,
      trades: stats.trades,
      excludedEndOfDataTrades: options.excludeEndOfDataTrades
        ? endOfData.length
        : 0,
      wins: stats.wins,
      losses: stats.losses,
      breakeven: stats.breakeven,
      winRatePct: stats.winRatePct,
      sumR: stats.sumR,
      averageR: stats.averageR,
      medianR: stats.medianR,
      bestR: stats.bestR,
      worstR: stats.worstR,
      lowSample: stats.trades < options.minimumTradesPerWindow,
    });

    windowResults.push(result);
    allTrades.push(...counted);
    windowIndex += 1;
  }

  // ---------------------------------------------------------------------------
  // Agregação global (em R, sem capital composto entre janelas)
  // ---------------------------------------------------------------------------

  const evaluatedWindows = windows.filter((window) => !window.skipped);
  const lowSampleWindows = evaluatedWindows.filter(
    (window) => window.lowSample,
  );
  const positiveWindows = evaluatedWindows.filter(
    (window) => window.sumR > 0,
  );

  const globalStats = computeTradeSetStats(allTrades);

  const positiveR = sum(
    allTrades
      .map((trade) => trade.resultR)
      .filter((value) => value > 0),
  );
  const negativeR = Math.abs(
    sum(
      allTrades
        .map((trade) => trade.resultR)
        .filter((value) => value < 0),
    ),
  );

  const windowSums = evaluatedWindows.map((window) => window.sumR);

  if (globalStats.trades < 100) {
    warnings.push(
      `Foram avaliadas ${globalStats.trades} operações no total. Abaixo de ` +
        `~100 operações, a diferença entre habilidade e acaso não é ` +
        `estatisticamente distinguível; trate o resultado como preliminar.`,
    );
  }

  if (
    evaluatedWindows.length > 0 &&
    lowSampleWindows.length / evaluatedWindows.length > 0.5
  ) {
    warnings.push(
      'Mais da metade das janelas tem amostra baixa. Considere janelas ' +
        'maiores (windowCandles) ou um período total mais longo.',
    );
  }

  return {
    version: WALK_FORWARD_VERSION,
    strategy: input.strategyId,
    options,
    candleCount: candles.length,
    firstCandleOpenTime: candles.length > 0 ? candles[0].openTime : null,
    lastCandleCloseTime:
      candles.length > 0 ? candles[candles.length - 1].closeTime : null,
    windows,
    aggregate: {
      windowCount: windows.length,
      evaluatedWindowCount: evaluatedWindows.length,
      skippedWindowCount: windows.length - evaluatedWindows.length,
      lowSampleWindowCount: lowSampleWindows.length,

      totalTrades: globalStats.trades,
      excludedEndOfDataTrades: excludedEndOfDataTotal,

      wins: globalStats.wins,
      losses: globalStats.losses,
      breakeven: globalStats.breakeven,
      winRatePct: globalStats.winRatePct,

      sumR: globalStats.sumR,
      averageR: globalStats.averageR,
      medianR: globalStats.medianR,

      standardDeviationR: globalStats.standardDeviationR,

      standardErrorR:
        globalStats.standardDeviationR === null || globalStats.trades < 2
          ? null
          : globalStats.standardDeviationR / Math.sqrt(globalStats.trades),

      /**
       * Nulo quando não há dispersão mensurável ou a amostra é pequena demais.
       * Com menos de 5 operações a estatística t não tem significado prático,
       * mesmo quando é calculável.
       */
      tStatistic:
        globalStats.standardDeviationR === null ||
        globalStats.averageR === null ||
        globalStats.trades < 5
          ? null
          : globalStats.averageR /
            (globalStats.standardDeviationR / Math.sqrt(globalStats.trades)),

      profitFactorR: negativeR === 0 ? null : positiveR / negativeR,

      positiveWindowsPct:
        evaluatedWindows.length === 0
          ? null
          : (positiveWindows.length / evaluatedWindows.length) * 100,
      positiveWindows: positiveWindows.length,

      bestWindowSumR:
        windowSums.length === 0 ? null : Math.max(...windowSums),
      worstWindowSumR:
        windowSums.length === 0 ? null : Math.min(...windowSums),
    },
    warnings,
    educationalNotice: WALK_FORWARD_EDUCATIONAL_NOTICE,
    windowResults,
  };
}
