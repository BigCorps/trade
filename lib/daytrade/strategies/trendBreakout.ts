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

import {
  calculateDayTradeIndicators,
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
  type DayTradeIndicators,
  type VolatilityRegime,
} from '../indicators';

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