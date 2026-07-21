/**
 * lib/daytrade/strategies/squeezeBreakout.ts — VigIA Trade
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

const DEFAULT_OPTIONS: ResolvedSqueezeBreakoutOptions = {
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

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} deve ser um número inteiro maior que zero.`);
  }

  return value;
}

export function resolveSqueezeBreakoutOptions(
  options: SqueezeBreakoutOptions = {},
): ResolvedSqueezeBreakoutOptions {
  const resolved: ResolvedSqueezeBreakoutOptions = {
    compressionLookback: positiveInteger(
      options.compressionLookback ?? DEFAULT_OPTIONS.compressionLookback,
      'compressionLookback',
    ),
    baselineLookback: positiveInteger(
      options.baselineLookback ?? DEFAULT_OPTIONS.baselineLookback,
      'baselineLookback',
    ),
    maximumRangeContractionRatio: positiveNumber(
      options.maximumRangeContractionRatio ??
        DEFAULT_OPTIONS.maximumRangeContractionRatio,
      'maximumRangeContractionRatio',
    ),
    maximumCompressionRangeAtr: positiveNumber(
      options.maximumCompressionRangeAtr ??
        DEFAULT_OPTIONS.maximumCompressionRangeAtr,
      'maximumCompressionRangeAtr',
    ),
    minimumRelativeVolume: positiveNumber(
      options.minimumRelativeVolume ?? DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    minimumPreviousCandleVolumeRatio: positiveNumber(
      options.minimumPreviousCandleVolumeRatio ??
        DEFAULT_OPTIONS.minimumPreviousCandleVolumeRatio,
      'minimumPreviousCandleVolumeRatio',
    ),
    minimumBreakoutDistanceAtr: nonNegativeNumber(
      options.minimumBreakoutDistanceAtr ??
        DEFAULT_OPTIONS.minimumBreakoutDistanceAtr,
      'minimumBreakoutDistanceAtr',
    ),
    observationDistanceAtr: nonNegativeNumber(
      options.observationDistanceAtr ?? DEFAULT_OPTIONS.observationDistanceAtr,
      'observationDistanceAtr',
    ),
    atrStopMultiple: positiveNumber(
      options.atrStopMultiple ?? DEFAULT_OPTIONS.atrStopMultiple,
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

interface CompressionMetrics {
  breakoutLevel: number;
  compressionLow: number;
  compressionRange: number;
  compressionRangeAtr: number;
  compressionAverageRange: number;
  baselineAverageRange: number;
  rangeContractionRatio: number;
}

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
  value: Omit<SqueezeBreakoutCondition, 'available'> & {
    available?: boolean;
  },
): SqueezeBreakoutCondition {
  return {
    ...value,
    available: value.available ?? true,
  };
}

function strategyRequiredCandleCount(
  options: ResolvedSqueezeBreakoutOptions,
): number {
  // Candle-base + compressão + candle atual de confirmação.
  return (
    options.baselineLookback +
    options.compressionLookback +
    1
  );
}

function calculateCompressionMetrics(
  candles: readonly DayTradeCandle[],
  atr: number | null,
  options: ResolvedSqueezeBreakoutOptions,
): CompressionMetrics | null {
  if (!isFinitePositive(atr)) return null;

  const required = strategyRequiredCandleCount(options);
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

  const compressionAverageRange = average(
    compressionCandles.map((candle) => candle.high - candle.low),
  );
  const baselineAverageRange = average(
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

function createPlan(
  currentCandle: DayTradeCandle,
  indicators: DayTradeIndicators,
  compression: CompressionMetrics | null,
  options: ResolvedSqueezeBreakoutOptions,
): SqueezeBreakoutPlan | null {
  const atr = indicators.atr;
  const emaFast = indicators.emaFast;
  const emaMedium = indicators.emaMedium;
  const emaSlow = indicators.emaSlow;

  if (
    compression === null ||
    !isFinitePositive(atr) ||
    !isFinitePositive(emaFast) ||
    !isFinitePositive(emaMedium) ||
    !isFinitePositive(emaSlow)
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

function determineNextTrigger(
  conditions: readonly SqueezeBreakoutCondition[],
  indicators: DayTradeIndicators,
  plan: SqueezeBreakoutPlan | null,
  compression: CompressionMetrics | null,
  status: SqueezeBreakoutStatus,
  options: ResolvedSqueezeBreakoutOptions,
): string {
  if (status === 'dados_insuficientes') {
    return 'Carregue mais candles encerrados para completar os indicadores e as janelas de compressão.';
  }

  if (status === 'invalidado' && plan) {
    return `A formação perdeu validade porque o preço atingiu ou ficou abaixo de ${formatNumber(plan.stopReference)}. Aguarde uma nova compressão.`;
  }

  if (status === 'entrada_atrasada' && plan) {
    return `Aguarde uma nova formação. O preço ultrapassou o limite de entrada de ${formatNumber(plan.latestAcceptableEntry)}.`;
  }

  if (status === 'condicoes_atendidas' && plan) {
    return `O candle encerrado confirmou o rompimento da compressão acima de ${formatNumber(plan.breakoutLevel)}.`;
  }

  const firstFailed = conditions.find(
    (item) => item.available && !item.passed,
  );

  switch (firstFailed?.id) {
    case 'tendencia_principal_positiva':
      return indicators.emaSlow === null
        ? 'Aguarde a EMA lenta ficar disponível.'
        : `Aguarde um fechamento acima da EMA lenta em ${formatNumber(indicators.emaSlow)}.`;

    case 'emas_alinhadas':
      return 'Aguarde o alinhamento EMA rápida > EMA intermediária > EMA lenta.';

    case 'compressao_confirmada':
      if (!compression) {
        return 'Aguarde histórico suficiente para medir a compressão.';
      }

      return `A faixa ainda precisa contrair para no máximo ${formatNumber(options.maximumRangeContractionRatio, 2)}× a amplitude-base e ${formatNumber(options.maximumCompressionRangeAtr, 2)} ATR de largura.`;

    case 'rompimento_confirmado':
      return compression
        ? `Aguarde um candle positivo fechando acima de ${formatNumber(compression.breakoutLevel)}.`
        : 'Aguarde a definição da máxima da compressão.';

    case 'volume_expansao':
      return `O rompimento ainda exige volume relativo mínimo de ${formatNumber(options.minimumRelativeVolume, 2)}× e volume pelo menos ${formatNumber(options.minimumPreviousCandleVolumeRatio, 2)}× o candle anterior.`;

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado pelo playbook.';

    case 'plano_risco_retorno':
      return `Aguarde uma formação com stop entre ${formatNumber(options.minimumStopDistanceAtr, 2)} e ${formatNumber(options.maximumStopDistanceAtr, 2)} ATR e alvo mínimo de ${formatNumber(options.minimumRiskRewardRatio, 2)}R.`;

    default:
      return 'Aguarde a conclusão conjunta das condições técnicas restantes no mesmo candle encerrado.';
  }
}

function determineSummary(
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
      : positiveNumber(input.livePrice, 'livePrice');

  const requiredByStrategy =
    strategyRequiredCandleCount(options);
  const strategyMissingCandles = Math.max(
    0,
    requiredByStrategy - candles.length,
  );
  const strategyReady = strategyMissingCandles === 0;

  const compression = calculateCompressionMetrics(
    candles,
    indicators.atr,
    options,
  );
  const plan = createPlan(
    currentCandle,
    indicators,
    compression,
    options,
  );

  const atrAvailable = isFinitePositive(indicators.atr);
  const emaFastAvailable = isFinitePositive(indicators.emaFast);
  const emaMediumAvailable = isFinitePositive(indicators.emaMedium);
  const emaSlowAvailable = isFinitePositive(indicators.emaSlow);

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
    (compression as CompressionMetrics).rangeContractionRatio <=
      options.maximumRangeContractionRatio &&
    (compression as CompressionMetrics).compressionRangeAtr <=
      options.maximumCompressionRangeAtr;

  const breakoutDistanceAtr =
    breakoutAvailable
      ? (
          currentCandle.close -
          (compression as CompressionMetrics).breakoutLevel
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
      (compression as CompressionMetrics).breakoutLevel &&
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
    condition({
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
          ? `${formatNumber(indicators.emaFast as number)} / ${formatNumber(indicators.emaMedium as number)} / ${formatNumber(indicators.emaSlow as number)}`
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
    condition({
      id: 'compressao_confirmada',
      label: 'Faixa recente comprimida',
      available: compressionAvailable,
      passed: compressionConfirmed,
      currentValue:
        compression === null
          ? null
          : `${formatNumber(compression.rangeContractionRatio, 2)}× base · ${formatNumber(compression.compressionRangeAtr, 2)} ATR`,
      requiredValue:
        `Contração ≤ ${formatNumber(options.maximumRangeContractionRatio, 2)}× e faixa ≤ ${formatNumber(options.maximumCompressionRangeAtr, 2)} ATR`,
      explanation:
        !compressionAvailable
          ? 'Ainda faltam candles ou ATR para medir a compressão.'
          : compressionConfirmed
            ? 'A amplitude média recente e a largura total da faixa estão dentro dos limites de compressão.'
            : 'A faixa recente ainda está ampla demais em relação ao histórico anterior ou ao ATR.',
    }),
    condition({
      id: 'rompimento_confirmado',
      label: 'Rompimento confirmado no fechamento',
      available: breakoutAvailable,
      passed: breakoutConfirmed,
      currentValue:
        breakoutDistanceAtr === null
          ? null
          : `${formatNumber(currentCandle.close)} · ${formatNumber(breakoutDistanceAtr, 2)} ATR`,
      requiredValue:
        compression === null
          ? 'Máxima da compressão disponível'
          : `Candle positivo fechando acima de ${formatNumber(compression.breakoutLevel)}`,
      explanation:
        !breakoutAvailable
          ? 'Ainda não existe faixa de compressão e ATR disponíveis.'
          : breakoutConfirmed
            ? 'O candle encerrou positivo, acima da máxima da compressão e próximo da própria máxima.'
            : 'O candle atual ainda não confirmou o rompimento da faixa.',
    }),
    condition({
      id: 'volume_expansao',
      label: 'Volume confirma a expansão',
      available: volumeAvailable,
      passed: volumeConfirmed,
      currentValue:
        indicators.relativeVolume === null ||
        previousCandleVolumeRatio === null
          ? null
          : `${formatNumber(indicators.relativeVolume, 2)}× média · ${formatNumber(previousCandleVolumeRatio, 2)}× candle anterior`,
      requiredValue:
        `Volume relativo ≥ ${formatNumber(options.minimumRelativeVolume, 2)}× e ` +
        `volume atual/anterior ≥ ${formatNumber(options.minimumPreviousCandleVolumeRatio, 2)}×`,
      explanation:
        !volumeAvailable
          ? 'O histórico de volume necessário ainda não está disponível.'
          : volumeConfirmed
            ? 'O volume do rompimento superou os dois limites configurados.'
            : 'O volume do rompimento ainda não superou os dois limites configurados.',
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

    nextTrigger: determineNextTrigger(
      conditions,
      indicators,
      plan,
      compression,
      status,
      options,
    ),
    summary: determineSummary(
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