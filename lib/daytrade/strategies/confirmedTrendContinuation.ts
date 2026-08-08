/**
 * Estratégia prospectiva v2: continuação confirmada após rompimento.
 * Shadow only. Não executa ordens.
 */
import {
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicators,
  type VolatilityRegime,
} from '../indicators';

export const CONFIRMED_TREND_CONTINUATION_STRATEGY_ID =
  'confirmed_trend_continuation' as const;
export const CONFIRMED_TREND_CONTINUATION_STRATEGY_VERSION = '2.0.0' as const;

export type ConfirmedTrendContinuationStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export interface ConfirmedTrendContinuationOptions {
  minimumBreakoutDistanceAtr?: number;
  minimumRelativeVolume?: number;
  minimumBodyFraction?: number;
  minimumCloseLocation?: number;
  atrStopMultiple?: number;
  breakoutRetestBufferAtr?: number;
  minimumRiskRewardRatio?: number;
  minimumStopDistanceAtr?: number;
  maximumStopDistanceAtr?: number;
  maximumLateEntryDistanceAtr?: number;
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface ConfirmedTrendContinuationPlan {
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
  breakoutLevel: number;
  latestAcceptableEntry: number;
}

export interface ConfirmedTrendContinuationCondition {
  id: string;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface ConfirmedTrendContinuationEvaluation {
  strategy: typeof CONFIRMED_TREND_CONTINUATION_STRATEGY_ID;
  strategyVersion: typeof CONFIRMED_TREND_CONTINUATION_STRATEGY_VERSION;
  direction: 'long';
  status: ConfirmedTrendContinuationStatus;
  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;
  conditions: ConfirmedTrendContinuationCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;
  plan: ConfirmedTrendContinuationPlan | null;
  nextTrigger: string;
  summary: string;
  warnings: string[];
  educationalNotice: string;
  diagnostics: Record<string, number | string | boolean | null>;
}

const DEFAULTS = {
  minimumBreakoutDistanceAtr: 0.25,
  minimumRelativeVolume: 1.25,
  minimumBodyFraction: 0.55,
  minimumCloseLocation: 0.75,
  atrStopMultiple: 1.40,
  breakoutRetestBufferAtr: 0.20,
  minimumRiskRewardRatio: 2.50,
  minimumStopDistanceAtr: 0.75,
  maximumStopDistanceAtr: 2.00,
  maximumLateEntryDistanceAtr: 0.35,
  blockedVolatilityRegimes: ['calmo', 'extremo', 'indisponível'] as readonly VolatilityRegime[],
};

const finitePositive = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0;

function resolveOptions(options: ConfirmedTrendContinuationOptions = {}) {
  return {
    ...DEFAULTS,
    ...options,
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ?? DEFAULTS.blockedVolatilityRegimes,
  };
}

/**
 * Mesmo resolvedor acima, exposto para o adaptador de backtest.
 *
 * Exportar em vez de duplicar os defaults evita que as duas cópias divirjam —
 * foi exatamente esse tipo de duplicação que fez as paletas do frontend
 * desencontrarem. Nenhum comportamento muda: é a mesma função.
 */
export const resolveConfirmedTrendContinuationOptions = resolveOptions;

function condition(
  value: Omit<ConfirmedTrendContinuationCondition, 'available'> & { available?: boolean },
): ConfirmedTrendContinuationCondition {
  return { ...value, available: value.available ?? true };
}

export function evaluateConfirmedTrendContinuation(input: {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;
  livePrice?: number | null;
  options?: ConfirmedTrendContinuationOptions;
}): ConfirmedTrendContinuationEvaluation {
  const options = resolveOptions(input.options);
  const candles = normalizeClosedCandles(input.candles);
  if (candles.length === 0) throw new Error('Informe candles encerrados.');
  const candle = candles[candles.length - 1];
  const indicators = input.indicators;
  const atr = indicators.atr;
  const breakout = indicators.breakoutLevel;
  const livePrice = input.livePrice ?? null;
  const range = Math.max(0, candle.high - candle.low);
  const bodyFraction = range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
  const closeLocation = range > 0 ? (candle.close - candle.low) / range : 0;
  const breakoutDistanceAtr =
    finitePositive(atr) && finitePositive(breakout)
      ? (candle.close - breakout) / atr
      : null;

  let plan: ConfirmedTrendContinuationPlan | null = null;
  if (finitePositive(atr) && finitePositive(breakout)) {
    const entryReference = candle.close;
    const structuralStop = Math.min(candle.low, breakout - atr * options.breakoutRetestBufferAtr);
    const atrStop = entryReference - atr * options.atrStopMultiple;
    const stopReference = Math.min(structuralStop, atrStop);
    const riskPerUnit = entryReference - stopReference;
    const stopDistanceAtr = riskPerUnit / atr;
    const targetReference =
      entryReference + riskPerUnit * options.minimumRiskRewardRatio;
    if (
      stopReference > 0 &&
      stopReference < entryReference &&
      stopDistanceAtr >= options.minimumStopDistanceAtr &&
      stopDistanceAtr <= options.maximumStopDistanceAtr
    ) {
      plan = {
        direction: 'long',
        entryReference,
        stopReference,
        targetReference,
        riskPerUnit,
        rewardPerUnit: targetReference - entryReference,
        riskRewardRatio: options.minimumRiskRewardRatio,
        stopDistancePct: (riskPerUnit / entryReference) * 100,
        targetDistancePct: ((targetReference - entryReference) / entryReference) * 100,
        stopDistanceAtr,
        breakoutLevel: breakout,
        latestAcceptableEntry:
          entryReference + atr * options.maximumLateEntryDistanceAtr,
      };
    }
  }

  const emasAvailable =
    finitePositive(indicators.emaFast) &&
    finitePositive(indicators.emaMedium) &&
    finitePositive(indicators.emaSlow);

  const conditions: ConfirmedTrendContinuationCondition[] = [
    condition({
      id: 'dados_prontos',
      label: 'Indicadores completos',
      passed: indicators.ready,
      currentValue: indicators.candleCount,
      requiredValue: `≥ ${indicators.requiredCandles} candles`,
      explanation: indicators.ready ? 'Histórico suficiente.' : 'Aquecimento incompleto.',
    }),
    condition({
      id: 'tendencia_estrutural',
      label: 'Preço e EMAs alinhados',
      available: emasAvailable,
      passed:
        emasAvailable &&
        candle.close > (indicators.emaSlow as number) &&
        (indicators.emaFast as number) > (indicators.emaMedium as number) &&
        (indicators.emaMedium as number) > (indicators.emaSlow as number),
      currentValue:
        emasAvailable
          ? `${indicators.emaFast?.toFixed(6)} / ${indicators.emaMedium?.toFixed(6)} / ${indicators.emaSlow?.toFixed(6)}`
          : null,
      requiredValue: 'Preço > EMA20 > EMA50 > EMA200',
      explanation: 'Exige tendência positiva completa, não apenas cruzamento curto.',
    }),
    condition({
      id: 'rompimento_distante',
      label: 'Rompimento com deslocamento mínimo',
      available: breakoutDistanceAtr !== null,
      passed:
        breakoutDistanceAtr !== null &&
        breakoutDistanceAtr >= options.minimumBreakoutDistanceAtr,
      currentValue: breakoutDistanceAtr,
      requiredValue: `≥ ${options.minimumBreakoutDistanceAtr.toFixed(2)} ATR`,
      explanation: 'Evita aceitar fechamento apenas alguns ticks acima da máxima.',
    }),
    condition({
      id: 'volume_confirmado',
      label: 'Volume acima da média',
      available: indicators.relativeVolume !== null,
      passed:
        indicators.relativeVolume !== null &&
        indicators.relativeVolume >= options.minimumRelativeVolume,
      currentValue: indicators.relativeVolume,
      requiredValue: `≥ ${options.minimumRelativeVolume.toFixed(2)}×`,
      explanation: 'Procura participação suficiente para sustentar a continuação.',
    }),
    condition({
      id: 'corpo_direcional',
      label: 'Corpo direcional forte',
      passed:
        candle.close > candle.open &&
        bodyFraction >= options.minimumBodyFraction,
      currentValue: bodyFraction,
      requiredValue: `Candle de alta e corpo ≥ ${(options.minimumBodyFraction * 100).toFixed(0)}%`,
      explanation: 'Reduz rompimentos com indecisão e pavios dominantes.',
    }),
    condition({
      id: 'fechamento_proximo_maxima',
      label: 'Fechamento próximo da máxima',
      passed: closeLocation >= options.minimumCloseLocation,
      currentValue: closeLocation,
      requiredValue: `≥ ${(options.minimumCloseLocation * 100).toFixed(0)}% da amplitude`,
      explanation: 'O candle deve conservar o deslocamento até o fechamento.',
    }),
    condition({
      id: 'volatilidade_permitida',
      label: 'Volatilidade normal ou volátil',
      passed: !options.blockedVolatilityRegimes.includes(indicators.volatilityRegime),
      currentValue: indicators.volatilityRegime,
      requiredValue: `Fora de ${options.blockedVolatilityRegimes.join(', ')}`,
      explanation: 'Bloqueia calmaria, extremos e regime indisponível.',
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
      explanation: 'Stop e alvo são congelados antes da próxima abertura.',
    }),
  ];

  const passedConditions = conditions.filter((item) => item.passed).length;
  const totalConditions = conditions.length;
  const allConditionsMet = indicators.ready && passedConditions === totalConditions;
  const liveInvalidated =
    allConditionsMet && plan !== null && livePrice !== null && livePrice <= plan.stopReference;
  const liveEntryLate =
    allConditionsMet && plan !== null && livePrice !== null && livePrice > plan.latestAcceptableEntry;
  let status: ConfirmedTrendContinuationStatus = 'aguardar';
  if (!indicators.ready) status = 'dados_insuficientes';
  else if (liveInvalidated) status = 'invalidado';
  else if (liveEntryLate) status = 'entrada_atrasada';
  else if (allConditionsMet) status = 'condicoes_atendidas';
  else if ((breakoutDistanceAtr ?? -Infinity) >= 0 && passedConditions >= 5) status = 'observar';

  return {
    strategy: CONFIRMED_TREND_CONTINUATION_STRATEGY_ID,
    strategyVersion: CONFIRMED_TREND_CONTINUATION_STRATEGY_VERSION,
    direction: 'long',
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
        ? 'Continuação confirmada no candle encerrado.'
        : 'Aguardar tendência completa, deslocamento, volume e fechamento forte.',
    summary: `${passedConditions} de ${totalConditions} condições atendidas.`,
    warnings: [
      'Estratégia em shadow: não executa ordens.',
      ...(indicators.volatilityRegime === 'extremo'
        ? ['Regime extremo bloqueado pelo protocolo.']
        : []),
    ],
    educationalNotice:
      'Hipótese prospectiva. Não representa recomendação nem promessa de resultado.',
    diagnostics: {
      ready: indicators.ready,
      candleCount: indicators.candleCount,
      volatilityRegime: indicators.volatilityRegime,
      relativeVolume: indicators.relativeVolume,
      breakoutDistanceAtr,
      bodyFraction,
      closeLocation,
      stopDistanceAtr: plan?.stopDistanceAtr ?? null,
    },
  };
}
