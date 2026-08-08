/**
 * Estratégia prospectiva v2: reversão após rompimento fracassado.
 * Shadow only. Não executa ordens.
 */
import {
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicators,
  type VolatilityRegime,
} from '../indicators';

export const FAILED_BREAKOUT_REVERSAL_STRATEGY_ID = 'failed_breakout_reversal' as const;
export const FAILED_BREAKOUT_REVERSAL_STRATEGY_VERSION = '2.0.0' as const;

export type FailedBreakoutReversalStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export interface FailedBreakoutReversalOptions {
  minimumPierceAtr?: number;
  minimumReentryAtr?: number;
  minimumRelativeVolume?: number;
  minimumUpperWickFraction?: number;
  maximumCloseLocation?: number;
  maximumBullishExtensionAtr?: number;
  atrStopBuffer?: number;
  minimumRiskRewardRatio?: number;
  minimumStopDistanceAtr?: number;
  maximumStopDistanceAtr?: number;
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface FailedBreakoutReversalPlan {
  direction: 'short';
  entryReference: number;
  stopReference: number;
  targetReference: number;
  riskPerUnit: number;
  rewardPerUnit: number;
  riskRewardRatio: number;
  stopDistancePct: number;
  targetDistancePct: number;
  stopDistanceAtr: number;
  breakoutLevel: number;
  latestAcceptableEntry: number;
}

export interface FailedBreakoutReversalCondition {
  id: string;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface FailedBreakoutReversalEvaluation {
  strategy: typeof FAILED_BREAKOUT_REVERSAL_STRATEGY_ID;
  strategyVersion: typeof FAILED_BREAKOUT_REVERSAL_STRATEGY_VERSION;
  direction: 'short';
  status: FailedBreakoutReversalStatus;
  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;
  conditions: FailedBreakoutReversalCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;
  plan: FailedBreakoutReversalPlan | null;
  nextTrigger: string;
  summary: string;
  warnings: string[];
  educationalNotice: string;
  diagnostics: Record<string, number | string | boolean | null>;
}

const DEFAULTS = {
  minimumPierceAtr: 0.10,
  minimumReentryAtr: 0.05,
  minimumRelativeVolume: 1.10,
  minimumUpperWickFraction: 0.35,
  maximumCloseLocation: 0.45,
  maximumBullishExtensionAtr: 0.50,
  atrStopBuffer: 0.20,
  minimumRiskRewardRatio: 2.20,
  minimumStopDistanceAtr: 0.60,
  maximumStopDistanceAtr: 2.20,
  blockedVolatilityRegimes: ['indisponível'] as readonly VolatilityRegime[],
};

const finitePositive = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0;

export function resolveFailedBreakoutReversalOptions(
  options: FailedBreakoutReversalOptions = {},
) {
  return {
    ...DEFAULTS,
    ...options,
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ?? DEFAULTS.blockedVolatilityRegimes,
  };
}

function condition(
  value: Omit<FailedBreakoutReversalCondition, 'available'> & { available?: boolean },
): FailedBreakoutReversalCondition {
  return { ...value, available: value.available ?? true };
}

export function evaluateFailedBreakoutReversal(input: {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;
  livePrice?: number | null;
  options?: FailedBreakoutReversalOptions;
}): FailedBreakoutReversalEvaluation {
  const options = resolveFailedBreakoutReversalOptions(input.options);
  const candles = normalizeClosedCandles(input.candles);
  if (candles.length === 0) throw new Error('Informe candles encerrados.');
  const candle = candles[candles.length - 1];
  const indicators = input.indicators;
  const atr = indicators.atr;
  const breakout = indicators.breakoutLevel;
  const livePrice = input.livePrice ?? null;
  const range = Math.max(0, candle.high - candle.low);
  const bodyTop = Math.max(candle.open, candle.close);
  const upperWickFraction = range > 0 ? (candle.high - bodyTop) / range : 0;
  const closeLocation = range > 0 ? (candle.close - candle.low) / range : 1;
  const pierceAtr =
    finitePositive(atr) && finitePositive(breakout)
      ? (candle.high - breakout) / atr
      : null;
  const reentryAtr =
    finitePositive(atr) && finitePositive(breakout)
      ? (breakout - candle.close) / atr
      : null;
  const bullishExtensionAtr =
    finitePositive(atr) && finitePositive(indicators.emaFast)
      ? (candle.close - indicators.emaFast) / atr
      : null;

  let plan: FailedBreakoutReversalPlan | null = null;
  if (finitePositive(atr) && finitePositive(breakout)) {
    const entryReference = candle.close;
    const stopReference = Math.max(
      candle.high + atr * options.atrStopBuffer,
      breakout + atr * options.atrStopBuffer,
    );
    const riskPerUnit = stopReference - entryReference;
    const stopDistanceAtr = riskPerUnit / atr;
    const targetReference =
      entryReference - riskPerUnit * options.minimumRiskRewardRatio;
    if (
      entryReference > 0 &&
      stopReference > entryReference &&
      targetReference > 0 &&
      stopDistanceAtr >= options.minimumStopDistanceAtr &&
      stopDistanceAtr <= options.maximumStopDistanceAtr
    ) {
      plan = {
        direction: 'short',
        entryReference,
        stopReference,
        targetReference,
        riskPerUnit,
        rewardPerUnit: entryReference - targetReference,
        riskRewardRatio: options.minimumRiskRewardRatio,
        stopDistancePct: (riskPerUnit / entryReference) * 100,
        targetDistancePct: ((entryReference - targetReference) / entryReference) * 100,
        stopDistanceAtr,
        breakoutLevel: breakout,
        latestAcceptableEntry: entryReference - atr * 0.35,
      };
    }
  }

  const conditions: FailedBreakoutReversalCondition[] = [
    condition({
      id: 'dados_prontos',
      label: 'Indicadores completos',
      passed: indicators.ready,
      currentValue: indicators.candleCount,
      requiredValue: `≥ ${indicators.requiredCandles} candles`,
      explanation: indicators.ready ? 'Histórico suficiente.' : 'Aquecimento incompleto.',
    }),
    condition({
      id: 'rompimento_perfurado',
      label: 'Preço perfurou a máxima anterior',
      available: pierceAtr !== null,
      passed: pierceAtr !== null && pierceAtr >= options.minimumPierceAtr,
      currentValue: pierceAtr,
      requiredValue: `≥ ${options.minimumPierceAtr.toFixed(2)} ATR`,
      explanation: 'Exige tentativa real de rompimento antes da reversão.',
    }),
    condition({
      id: 'retorno_faixa',
      label: 'Fechamento retornou para dentro da faixa',
      available: reentryAtr !== null,
      passed: reentryAtr !== null && reentryAtr >= options.minimumReentryAtr,
      currentValue: reentryAtr,
      requiredValue: `≥ ${options.minimumReentryAtr.toFixed(2)} ATR abaixo do nível`,
      explanation: 'Confirma rejeição do rompimento no candle encerrado.',
    }),
    condition({
      id: 'rejeicao_pavio',
      label: 'Pavio superior relevante',
      passed: upperWickFraction >= options.minimumUpperWickFraction,
      currentValue: upperWickFraction,
      requiredValue: `≥ ${(options.minimumUpperWickFraction * 100).toFixed(0)}% da amplitude`,
      explanation: 'Procura rejeição, não apenas um fechamento marginal.',
    }),
    condition({
      id: 'fechamento_fraco',
      label: 'Fechamento na metade inferior',
      passed: closeLocation <= options.maximumCloseLocation,
      currentValue: closeLocation,
      requiredValue: `≤ ${(options.maximumCloseLocation * 100).toFixed(0)}% da amplitude`,
      explanation: 'O candle deve terminar próximo da região inferior.',
    }),
    condition({
      id: 'volume_confirmado',
      label: 'Volume confirma a falha',
      available: indicators.relativeVolume !== null,
      passed:
        indicators.relativeVolume !== null &&
        indicators.relativeVolume >= options.minimumRelativeVolume,
      currentValue: indicators.relativeVolume,
      requiredValue: `≥ ${options.minimumRelativeVolume.toFixed(2)}×`,
      explanation: 'Evita interpretar ruído sem participação.',
    }),
    condition({
      id: 'sem_extensao_bull',
      label: 'Não está excessivamente acima da EMA rápida',
      available: bullishExtensionAtr !== null,
      passed:
        bullishExtensionAtr !== null &&
        bullishExtensionAtr <= options.maximumBullishExtensionAtr,
      currentValue: bullishExtensionAtr,
      requiredValue: `≤ ${options.maximumBullishExtensionAtr.toFixed(2)} ATR`,
      explanation: 'Reduz shorts contra tendência ainda acelerando.',
    }),
    condition({
      id: 'volatilidade_permitida',
      label: 'Regime de volatilidade permitido',
      passed: !options.blockedVolatilityRegimes.includes(indicators.volatilityRegime),
      currentValue: indicators.volatilityRegime,
      requiredValue: `Fora de ${options.blockedVolatilityRegimes.join(', ')}`,
      explanation: 'O protocolo bloqueia apenas regime indisponível.',
    }),
    condition({
      id: 'plano_valido',
      label: 'Plano de risco válido',
      available: plan !== null,
      passed: plan !== null,
      currentValue: plan?.stopDistanceAtr ?? null,
      requiredValue:
        `${options.minimumStopDistanceAtr.toFixed(2)}–` +
        `${options.maximumStopDistanceAtr.toFixed(2)} ATR; alvo ` +
        `${options.minimumRiskRewardRatio.toFixed(2)}R`,
      explanation: 'Entrada, stop e alvo precisam respeitar o protocolo congelado.',
    }),
  ];

  const passedConditions = conditions.filter((item) => item.passed).length;
  const totalConditions = conditions.length;
  const allConditionsMet = indicators.ready && passedConditions === totalConditions;
  const liveInvalidated =
    allConditionsMet && plan !== null && livePrice !== null && livePrice >= plan.stopReference;
  const liveEntryLate =
    allConditionsMet && plan !== null && livePrice !== null && livePrice < plan.latestAcceptableEntry;
  let status: FailedBreakoutReversalStatus = 'aguardar';
  if (!indicators.ready) status = 'dados_insuficientes';
  else if (liveInvalidated) status = 'invalidado';
  else if (liveEntryLate) status = 'entrada_atrasada';
  else if (allConditionsMet) status = 'condicoes_atendidas';
  else if ((pierceAtr ?? -Infinity) >= 0 && passedConditions >= 5) status = 'observar';

  return {
    strategy: FAILED_BREAKOUT_REVERSAL_STRATEGY_ID,
    strategyVersion: FAILED_BREAKOUT_REVERSAL_STRATEGY_VERSION,
    direction: 'short',
    status,
    candleOpenTime: candle.openTime,
    candleCloseTime: candle.closeTime,
    evaluatedPrice: candle.close,
    livePrice,
    conditions,
    passedConditions,
    totalConditions,
    scorePct: (passedConditions / totalConditions) * 100,
    allConditionsMet,
    plan,
    nextTrigger:
      status === 'condicoes_atendidas'
        ? 'Rompimento fracassado confirmado no candle encerrado.'
        : 'Aguardar perfuração, retorno à faixa e rejeição com volume no mesmo candle.',
    summary: `${passedConditions} de ${totalConditions} condições atendidas.`,
    warnings: [
      'Estratégia em shadow: não executa ordens.',
      ...(indicators.volatilityRegime === 'extremo'
        ? ['Volatilidade extrema: risco de gaps e slippage acima da simulação.']
        : []),
    ],
    educationalNotice:
      'Hipótese prospectiva. Não representa recomendação nem promessa de resultado.',
    diagnostics: {
      ready: indicators.ready,
      candleCount: indicators.candleCount,
      volatilityRegime: indicators.volatilityRegime,
      relativeVolume: indicators.relativeVolume,
      pierceAtr,
      reentryAtr,
      upperWickFraction,
      closeLocation,
      bullishExtensionAtr,
      stopDistanceAtr: plan?.stopDistanceAtr ?? null,
    },
  };
}
