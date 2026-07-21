/**
 * lib/daytrade/strategies/rangeMeanReversion.ts — VigIA Trade
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

import {
  calculateDayTradeIndicators,
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
  type DayTradeIndicators,
  type VolatilityRegime,
} from '../indicators';

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

const DEFAULT_OPTIONS: ResolvedRangeMeanReversionOptions = {
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

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} deve ser um número maior que zero.`);
  }

  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${name} deve ser um número maior ou igual a zero.`,
    );
  }

  return value;
}

function finiteNumber(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} deve ser um número válido.`);
  }

  return value;
}

function positiveInteger(value: number, name: string): number {
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
    rangeLookback: positiveInteger(
      options.rangeLookback ?? DEFAULT_OPTIONS.rangeLookback,
      'rangeLookback',
    ),
    meanLookback: positiveInteger(
      options.meanLookback ?? DEFAULT_OPTIONS.meanLookback,
      'meanLookback',
    ),
    maximumSlowEmaSlopeAtrPerCandle: nonNegativeNumber(
      options.maximumSlowEmaSlopeAtrPerCandle ??
        DEFAULT_OPTIONS.maximumSlowEmaSlopeAtrPerCandle,
      'maximumSlowEmaSlopeAtrPerCandle',
    ),
    maximumFastMediumEmaSpreadAtr: nonNegativeNumber(
      options.maximumFastMediumEmaSpreadAtr ??
        DEFAULT_OPTIONS.maximumFastMediumEmaSpreadAtr,
      'maximumFastMediumEmaSpreadAtr',
    ),
    minimumRangeWidthAtr: positiveNumber(
      options.minimumRangeWidthAtr ??
        DEFAULT_OPTIONS.minimumRangeWidthAtr,
      'minimumRangeWidthAtr',
    ),
    maximumRangeWidthAtr: positiveNumber(
      options.maximumRangeWidthAtr ??
        DEFAULT_OPTIONS.maximumRangeWidthAtr,
      'maximumRangeWidthAtr',
    ),
    maximumEntryZScore: finiteNumber(
      options.maximumEntryZScore ??
        DEFAULT_OPTIONS.maximumEntryZScore,
      'maximumEntryZScore',
    ),
    maximumSupportDistanceAtr: nonNegativeNumber(
      options.maximumSupportDistanceAtr ??
        DEFAULT_OPTIONS.maximumSupportDistanceAtr,
      'maximumSupportDistanceAtr',
    ),
    minimumRelativeVolume: nonNegativeNumber(
      options.minimumRelativeVolume ??
        DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    maximumRelativeVolume: positiveNumber(
      options.maximumRelativeVolume ??
        DEFAULT_OPTIONS.maximumRelativeVolume,
      'maximumRelativeVolume',
    ),
    atrStopMultiple: positiveNumber(
      options.atrStopMultiple ??
        DEFAULT_OPTIONS.atrStopMultiple,
      'atrStopMultiple',
    ),
    structuralStopBufferAtr: nonNegativeNumber(
      options.structuralStopBufferAtr ??
        DEFAULT_OPTIONS.structuralStopBufferAtr,
      'structuralStopBufferAtr',
    ),
    minimumRiskRewardRatio: positiveNumber(
      options.minimumRiskRewardRatio ??
        DEFAULT_OPTIONS.minimumRiskRewardRatio,
      'minimumRiskRewardRatio',
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

interface RangeMetrics {
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

function isFinitePositive(value: number | null): value is number {
  return (
    value !== null &&
    Number.isFinite(value) &&
    value > 0
  );
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

function sampleStandardDeviation(
  values: readonly number[],
): number | null {
  if (values.length < 2) return null;

  const mean = average(values);
  if (mean === null) return null;

  const variance =
    values.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0,
    ) /
    (values.length - 1);

  return Math.sqrt(variance);
}

function formatNumber(
  value: number,
  maximumFractionDigits = 8,
): string {
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(value);
}

function formatPct(
  value: number,
  fractionDigits = 2,
): string {
  return `${new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}%`;
}

function condition(
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

function strategyRequiredCandleCount(
  options: ResolvedRangeMeanReversionOptions,
): number {
  return Math.max(
    options.rangeLookback + 1,
    options.meanLookback + 1,
  );
}

function calculateRangeMetrics(
  candles: readonly DayTradeCandle[],
  indicators: DayTradeIndicators,
  options: ResolvedRangeMeanReversionOptions,
): RangeMetrics | null {
  const atr = indicators.atr;

  if (!isFinitePositive(atr)) {
    return null;
  }

  const required =
    strategyRequiredCandleCount(options);

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
  const meanReference = average(closes);
  const standardDeviation =
    sampleStandardDeviation(closes);

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
    !isFinitePositive(currentPoint.emaSlow) ||
    !isFinitePositive(previousSlopePoint.emaSlow) ||
    !isFinitePositive(indicators.emaFast) ||
    !isFinitePositive(indicators.emaMedium)
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

function createPlan(
  currentCandle: DayTradeCandle,
  indicators: DayTradeIndicators,
  metrics: RangeMetrics | null,
  options: ResolvedRangeMeanReversionOptions,
): RangeMeanReversionPlan | null {
  const atr = indicators.atr;
  const emaFast = indicators.emaFast;
  const emaMedium = indicators.emaMedium;
  const emaSlow = indicators.emaSlow;

  if (
    metrics === null ||
    !isFinitePositive(atr) ||
    !isFinitePositive(emaFast) ||
    !isFinitePositive(emaMedium) ||
    !isFinitePositive(emaSlow)
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

function determineNextTrigger(
  conditions: readonly RangeMeanReversionCondition[],
  indicators: DayTradeIndicators,
  metrics: RangeMetrics | null,
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
    return `A faixa perdeu validade porque o preço atingiu ou ficou abaixo de ${formatNumber(plan.stopReference)}.`;
  }

  if (
    status === 'entrada_atrasada' &&
    plan
  ) {
    return `Aguarde uma nova aproximação do suporte. O preço ultrapassou o limite de ${formatNumber(plan.latestAcceptableEntry)}.`;
  }

  if (
    status === 'condicoes_atendidas' &&
    plan
  ) {
    return `O candle confirmou recuperação dentro da faixa, com alvo técnico na média em ${formatNumber(plan.targetReference)}.`;
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
        ? `Aguarde uma faixa entre ${formatNumber(options.minimumRangeWidthAtr, 2)} e ${formatNumber(options.maximumRangeWidthAtr, 2)} ATR sem perda do suporte.`
        : 'Aguarde histórico suficiente para medir a faixa.';

    case 'preco_em_desconto':
      return metrics
        ? `Aguarde o preço voltar para próximo de ${formatNumber(metrics.rangeLow)} e atingir z-score de até ${formatNumber(options.maximumEntryZScore, 2)}.`
        : 'Aguarde a definição da faixa e da média.';

    case 'recuperacao_confirmada':
      return 'Aguarde um candle positivo fechando acima do fechamento anterior e próximo da própria máxima.';

    case 'volume_compativel':
      return `Aguarde volume relativo entre ${formatNumber(options.minimumRelativeVolume, 2)}× e ${formatNumber(options.maximumRelativeVolume, 2)}×.`;

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado.';

    case 'plano_risco_retorno':
      return `Aguarde uma recuperação que permita alvo mínimo de ${formatNumber(options.minimumRiskRewardRatio, 2)}R até a média da faixa.`;

    default:
      return 'Aguarde a conclusão conjunta das condições técnicas restantes.';
  }
}

function determineSummary(
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
      : positiveNumber(
          input.livePrice,
          'livePrice',
        );

  const requiredByStrategy =
    strategyRequiredCandleCount(
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
    calculateRangeMetrics(
      candles,
      indicators,
      options,
    );

  const plan =
    createPlan(
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
      condition({
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
            : `${formatNumber(metrics.slowEmaSlopeAtrPerCandle, 3)} ATR/candle · ${formatNumber(metrics.fastMediumEmaSpreadAtr, 2)} ATR`,
        requiredValue:
          `Inclinação ≤ ${formatNumber(options.maximumSlowEmaSlopeAtrPerCandle, 3)} e distância EMA20/50 ≤ ${formatNumber(options.maximumFastMediumEmaSpreadAtr, 2)} ATR`,
        explanation:
          metrics === null
            ? 'Ainda não há dados suficientes para medir lateralidade.'
            : lateralMarket
              ? 'A EMA lenta está quase plana e as médias rápidas estão próximas.'
              : 'A inclinação ou o afastamento das médias ainda indica tendência forte.',
      }),

      condition({
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
            : `${formatNumber(metrics.rangeWidthAtr, 2)} ATR · ${formatNumber(metrics.rangeLow)}–${formatNumber(metrics.rangeHigh)}`,
        requiredValue:
          `Largura entre ${formatNumber(options.minimumRangeWidthAtr, 2)} e ${formatNumber(options.maximumRangeWidthAtr, 2)} ATR`,
        explanation:
          metrics === null
            ? 'Ainda não há histórico suficiente para medir a faixa.'
            : stableRange
              ? 'A amplitude recente está dentro dos limites e o suporte continua preservado.'
              : 'A faixa está estreita demais, ampla demais ou o preço perdeu o suporte.',
      }),

      condition({
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
            : `z ${formatNumber(metrics.zScore, 2)} · ${formatNumber(metrics.supportDistanceAtr, 2)} ATR do suporte`,
        requiredValue:
          `z-score ≤ ${formatNumber(options.maximumEntryZScore, 2)} e distância ≤ ${formatNumber(options.maximumSupportDistanceAtr, 2)} ATR`,
        explanation:
          metrics === null
            ? 'A média, o desvio-padrão e o suporte ainda não estão disponíveis.'
            : discountedPrice
              ? 'O preço está abaixo da média e próximo da parte inferior da faixa.'
              : 'O preço ainda não está suficientemente descontado ou está longe do suporte.',
      }),

      condition({
        id: 'recuperacao_confirmada',
        label:
          'Recuperação confirmada no candle',
        available:
          recoveryAvailable,
        passed:
          recoveryConfirmed,
        currentValue:
          recoveryAvailable
            ? `${formatNumber(currentCandle.open)} → ${formatNumber(currentCandle.close)}`
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

      condition({
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
          `${formatNumber(options.minimumRelativeVolume, 2)}× a ${formatNumber(options.maximumRelativeVolume, 2)}× a média`,
        explanation:
          !volumeAvailable
            ? 'O volume relativo ainda não está disponível.'
            : volumeCompatible
              ? 'O volume está suficiente para confirmar reação sem caracterizar expansão extrema.'
              : 'O volume está fraco demais ou elevado demais para este playbook.',
      }),

      condition({
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

      condition({
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
            : `${formatNumber(plan.stopDistanceAtr, 2)} ATR · ${formatNumber(plan.riskRewardRatio, 2)}R`,
        requiredValue:
          `${formatNumber(options.minimumStopDistanceAtr, 2)}–${formatNumber(options.maximumStopDistanceAtr, 2)} ATR e alvo ≥ ${formatNumber(options.minimumRiskRewardRatio, 2)}R`,
        explanation:
          plan === null
            ? 'Não foi possível montar stop abaixo da faixa e alvo acima da entrada.'
            : !stopDistanceValid
              ? `O stop ficaria a ${formatNumber(plan.stopDistanceAtr, 2)} ATR, fora do intervalo permitido.`
              : !riskRewardValid
                ? `O retorno até a média seria de apenas ${formatNumber(plan.riskRewardRatio, 2)}R.`
                : `O alvo na média oferece ${formatNumber(plan.riskRewardRatio, 2)} vezes o risco.`,
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
      `A invalidação ficaria a ${formatNumber(plan.stopDistanceAtr, 2)} ATR da entrada, fora do limite configurado.`,
    );
  }

  if (
    plan &&
    !riskRewardValid
  ) {
    warnings.push(
      `O retorno disponível até a média seria de ${formatNumber(plan.riskRewardRatio, 2)}R, abaixo do mínimo configurado.`,
    );
  }

  if (
    liveEntryLate &&
    plan &&
    livePrice !== null
  ) {
    warnings.push(
      `O preço ao vivo está ${formatPct(((livePrice - plan.entryReference) / plan.entryReference) * 100)} acima da entrada de referência.`,
    );
  }

  if (
    liveInvalidated &&
    plan
  ) {
    warnings.push(
      `O preço ao vivo atingiu ou perdeu a invalidação em ${formatNumber(plan.stopReference)}.`,
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
      determineNextTrigger(
        conditions,
        indicators,
        metrics,
        plan,
        status,
        options,
      ),

    summary:
      determineSummary(
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