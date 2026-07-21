/**
 * lib/daytrade/strategies/trendPullback.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Playbook de continuação de tendência após pullback.
 *
 * Regras:
 * - preço acima da EMA 200;
 * - EMA 20 > EMA 50 > EMA 200;
 * - recuo recente até a região entre EMA 20 e EMA 50;
 * - recuperação confirmada por candle encerrado;
 * - volume suficiente;
 * - volatilidade aceitável;
 * - plano com stop coerente e alvo mínimo de 2R.
 *
 * Este módulo não consulta APIs, não grava no banco e não executa ordens.
 */

import {
  calculateDayTradeIndicators,
  normalizeClosedCandles,
  type DayTradeCandle,
  type DayTradeIndicatorOptions,
  type DayTradeIndicators,
  type VolatilityRegime,
} from '../indicators';

export const TREND_PULLBACK_STRATEGY_ID = 'trend_pullback' as const;
export const TREND_PULLBACK_STRATEGY_VERSION = '1.0.0' as const;

export const TREND_PULLBACK_EDUCATIONAL_NOTICE =
  'Este resultado verifica condições técnicas históricas e não representa recomendação de compra ou promessa de resultado.';

export type TrendPullbackStatus =
  | 'dados_insuficientes'
  | 'aguardar'
  | 'observar'
  | 'condicoes_atendidas'
  | 'entrada_atrasada'
  | 'invalidado';

export type TrendPullbackConditionId =
  | 'tendencia_principal_positiva'
  | 'emas_alinhadas'
  | 'pullback_na_zona'
  | 'recuperacao_confirmada'
  | 'volume_recuperacao'
  | 'volatilidade_aceitavel'
  | 'plano_risco_retorno';

export interface TrendPullbackCondition {
  id: TrendPullbackConditionId;
  label: string;
  passed: boolean;
  available: boolean;
  currentValue: number | string | null;
  requiredValue: string;
  explanation: string;
}

export interface TrendPullbackPlan {
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
  pullbackLow: number;
  pullbackZoneUpper: number;
  pullbackZoneLower: number;
  emaFast: number;
  emaMedium: number;
  emaSlow: number;
  structuralStopCandidate: number;
  atrStopCandidate: number;
}

export interface TrendPullbackOptions {
  minimumRelativeVolume?: number;
  minimumPreviousCandleVolumeRatio?: number;
  atrStopMultiple?: number;
  structuralStopBufferAtr?: number;
  minimumRiskRewardRatio?: number;
  pullbackToleranceAtr?: number;
  maximumLateEntryDistanceAtr?: number;
  minimumStopDistanceAtr?: number;
  maximumStopDistanceAtr?: number;
  blockedVolatilityRegimes?: readonly VolatilityRegime[];
}

export interface ResolvedTrendPullbackOptions {
  minimumRelativeVolume: number;
  minimumPreviousCandleVolumeRatio: number;
  atrStopMultiple: number;
  structuralStopBufferAtr: number;
  minimumRiskRewardRatio: number;
  pullbackToleranceAtr: number;
  maximumLateEntryDistanceAtr: number;
  minimumStopDistanceAtr: number;
  maximumStopDistanceAtr: number;
  blockedVolatilityRegimes: readonly VolatilityRegime[];
}

export interface EvaluateTrendPullbackInput {
  candles: readonly DayTradeCandle[];
  indicators: DayTradeIndicators;
  livePrice?: number | null;
  options?: TrendPullbackOptions;
}

export interface AnalyzeTrendPullbackInput {
  candles: readonly DayTradeCandle[];
  indicatorOptions: DayTradeIndicatorOptions;
  livePrice?: number | null;
  strategyOptions?: TrendPullbackOptions;
}

export interface TrendPullbackEvaluation {
  strategy: typeof TREND_PULLBACK_STRATEGY_ID;
  strategyVersion: typeof TREND_PULLBACK_STRATEGY_VERSION;
  direction: 'long';
  status: TrendPullbackStatus;
  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedPrice: number;
  livePrice: number | null;
  conditions: TrendPullbackCondition[];
  passedConditions: number;
  totalConditions: number;
  scorePct: number;
  allConditionsMet: boolean;
  plan: TrendPullbackPlan | null;
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
    previousCandleVolumeRatio: number | null;
    pullbackTouched: boolean | null;
    recoveryConfirmed: boolean | null;
    pullbackLow: number | null;
    pullbackZoneUpper: number | null;
    pullbackZoneLower: number | null;
    stopDistanceAtr: number | null;
  };
}

const DEFAULT_OPTIONS: ResolvedTrendPullbackOptions = {
  minimumRelativeVolume: 0.8,
  minimumPreviousCandleVolumeRatio: 1.05,
  atrStopMultiple: 1.2,
  structuralStopBufferAtr: 0.1,
  minimumRiskRewardRatio: 2,
  pullbackToleranceAtr: 0.25,
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

export function resolveTrendPullbackOptions(
  options: TrendPullbackOptions = {},
): ResolvedTrendPullbackOptions {
  const resolved: ResolvedTrendPullbackOptions = {
    minimumRelativeVolume: positiveNumber(
      options.minimumRelativeVolume ?? DEFAULT_OPTIONS.minimumRelativeVolume,
      'minimumRelativeVolume',
    ),
    minimumPreviousCandleVolumeRatio: positiveNumber(
      options.minimumPreviousCandleVolumeRatio ??
        DEFAULT_OPTIONS.minimumPreviousCandleVolumeRatio,
      'minimumPreviousCandleVolumeRatio',
    ),
    atrStopMultiple: positiveNumber(
      options.atrStopMultiple ?? DEFAULT_OPTIONS.atrStopMultiple,
      'atrStopMultiple',
    ),
    structuralStopBufferAtr: nonNegativeNumber(
      options.structuralStopBufferAtr ?? DEFAULT_OPTIONS.structuralStopBufferAtr,
      'structuralStopBufferAtr',
    ),
    minimumRiskRewardRatio: positiveNumber(
      options.minimumRiskRewardRatio ?? DEFAULT_OPTIONS.minimumRiskRewardRatio,
      'minimumRiskRewardRatio',
    ),
    pullbackToleranceAtr: nonNegativeNumber(
      options.pullbackToleranceAtr ?? DEFAULT_OPTIONS.pullbackToleranceAtr,
      'pullbackToleranceAtr',
    ),
    maximumLateEntryDistanceAtr: nonNegativeNumber(
      options.maximumLateEntryDistanceAtr ??
        DEFAULT_OPTIONS.maximumLateEntryDistanceAtr,
      'maximumLateEntryDistanceAtr',
    ),
    minimumStopDistanceAtr: positiveNumber(
      options.minimumStopDistanceAtr ?? DEFAULT_OPTIONS.minimumStopDistanceAtr,
      'minimumStopDistanceAtr',
    ),
    maximumStopDistanceAtr: positiveNumber(
      options.maximumStopDistanceAtr ?? DEFAULT_OPTIONS.maximumStopDistanceAtr,
      'maximumStopDistanceAtr',
    ),
    blockedVolatilityRegimes:
      options.blockedVolatilityRegimes ??
      DEFAULT_OPTIONS.blockedVolatilityRegimes,
  };

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
  value: Omit<TrendPullbackCondition, 'available'> & {
    available?: boolean;
  },
): TrendPullbackCondition {
  return { ...value, available: value.available ?? true };
}

function candleIntersectsZone(
  candle: DayTradeCandle,
  lower: number,
  upper: number,
): boolean {
  return candle.low <= upper && candle.high >= lower;
}

function createPlan(
  currentCandle: DayTradeCandle,
  previousCandle: DayTradeCandle | null,
  indicators: DayTradeIndicators,
  options: ResolvedTrendPullbackOptions,
): TrendPullbackPlan | null {
  const entryReference = currentCandle.close;
  const atr = indicators.atr;
  const emaFast = indicators.emaFast;
  const emaMedium = indicators.emaMedium;
  const emaSlow = indicators.emaSlow;

  if (
    previousCandle === null ||
    !isFinitePositive(atr) ||
    !isFinitePositive(emaFast) ||
    !isFinitePositive(emaMedium) ||
    !isFinitePositive(emaSlow)
  ) {
    return null;
  }

  const pullbackLow = Math.min(previousCandle.low, currentCandle.low);
  const structuralStopCandidate =
    pullbackLow - atr * options.structuralStopBufferAtr;
  const atrStopCandidate =
    entryReference - atr * options.atrStopMultiple;
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
  const rewardPerUnit =
    riskPerUnit * options.minimumRiskRewardRatio;
  const targetReference = entryReference + rewardPerUnit;

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
    stopDistanceAtr: riskPerUnit / atr,
    latestAcceptableEntry:
      entryReference + atr * options.maximumLateEntryDistanceAtr,
    pullbackLow,
    pullbackZoneUpper:
      emaFast + atr * options.pullbackToleranceAtr,
    pullbackZoneLower:
      emaMedium - atr * options.pullbackToleranceAtr,
    emaFast,
    emaMedium,
    emaSlow,
    structuralStopCandidate,
    atrStopCandidate,
  };
}

function determineNextTrigger(
  conditions: readonly TrendPullbackCondition[],
  indicators: DayTradeIndicators,
  plan: TrendPullbackPlan | null,
  status: TrendPullbackStatus,
  options: ResolvedTrendPullbackOptions,
): string {
  if (status === 'dados_insuficientes') {
    return `Carregue mais ${indicators.missingCandles} candle(s) encerrado(s) para completar os indicadores.`;
  }

  if (status === 'invalidado' && plan) {
    return `A formação perdeu validade porque o preço atingiu ou ficou abaixo de ${formatNumber(plan.stopReference)}. Aguarde um novo pullback.`;
  }

  if (status === 'entrada_atrasada' && plan) {
    return `Aguarde um novo pullback. O preço ultrapassou o limite de entrada de ${formatNumber(plan.latestAcceptableEntry)}.`;
  }

  if (status === 'condicoes_atendidas' && plan) {
    return `O candle encerrado confirmou a recuperação acima da EMA rápida em ${formatNumber(plan.emaFast)}.`;
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

    case 'pullback_na_zona':
      return plan
        ? `Aguarde um recuo controlado até a região entre ${formatNumber(plan.pullbackZoneLower)} e ${formatNumber(plan.pullbackZoneUpper)}.`
        : 'Aguarde as médias e o ATR ficarem disponíveis para calcular a região de pullback.';

    case 'recuperacao_confirmada':
      return indicators.emaFast === null
        ? 'Aguarde a EMA rápida ficar disponível.'
        : `Aguarde um candle positivo fechando acima da EMA rápida em ${formatNumber(indicators.emaFast)}, acima do fechamento anterior e próximo da máxima.`;

    case 'volume_recuperacao':
      return `A recuperação exige volume relativo mínimo de ${formatNumber(options.minimumRelativeVolume, 2)}× e volume atual/anterior mínimo de ${formatNumber(options.minimumPreviousCandleVolumeRatio, 2)}×.`;

    case 'volatilidade_aceitavel':
      return 'Aguarde a volatilidade sair do regime bloqueado pelo playbook.';

    case 'plano_risco_retorno':
      return `Aguarde uma formação com stop entre ${formatNumber(options.minimumStopDistanceAtr, 2)} e ${formatNumber(options.maximumStopDistanceAtr, 2)} ATR e alvo mínimo de ${formatNumber(options.minimumRiskRewardRatio, 2)}R.`;

    default:
      return 'Aguarde a conclusão conjunta das condições técnicas restantes.';
  }
}

function determineSummary(
  status: TrendPullbackStatus,
  passed: number,
  total: number,
): string {
  switch (status) {
    case 'dados_insuficientes':
      return 'Ainda não há candles encerrados suficientes para avaliar o pullback.';
    case 'aguardar':
      return `${passed} de ${total} condições foram atendidas. Ainda não existe um pullback válido.`;
    case 'observar':
      return `${passed} de ${total} condições foram atendidas. O ativo está na região de pullback ou iniciando recuperação.`;
    case 'condicoes_atendidas':
      return `${passed} de ${total} condições foram atendidas no candle encerrado mais recente.`;
    case 'entrada_atrasada':
      return 'O pullback foi confirmado, mas o preço ao vivo já se afastou demais da entrada.';
    case 'invalidado':
      return 'O pullback foi confirmado, mas o preço ao vivo atingiu a invalidação.';
  }
}

export function evaluateTrendPullback(
  input: EvaluateTrendPullbackInput,
): TrendPullbackEvaluation {
  const options = resolveTrendPullbackOptions(input.options);
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

  const plan = createPlan(
    currentCandle,
    previousCandle,
    indicators,
    options,
  );

  const atrAvailable = isFinitePositive(indicators.atr);
  const emaFastAvailable = isFinitePositive(indicators.emaFast);
  const emaMediumAvailable = isFinitePositive(indicators.emaMedium);
  const emaSlowAvailable = isFinitePositive(indicators.emaSlow);
  const previousCandleAvailable = previousCandle !== null;

  const trendAvailable = emaSlowAvailable;
  const alignmentAvailable =
    emaFastAvailable && emaMediumAvailable && emaSlowAvailable;
  const pullbackAvailable =
    previousCandleAvailable &&
    atrAvailable &&
    emaFastAvailable &&
    emaMediumAvailable;
  const recoveryAvailable =
    previousCandleAvailable && emaFastAvailable;
  const volumeAvailable =
    previousCandleAvailable &&
    previousCandle.volume > 0 &&
    indicators.relativeVolume !== null &&
    Number.isFinite(indicators.relativeVolume);
  const volatilityAvailable =
    indicators.volatilityRegime !== 'indisponível';

  const pullbackZoneUpper =
    atrAvailable && emaFastAvailable
      ? (indicators.emaFast as number) +
        (indicators.atr as number) * options.pullbackToleranceAtr
      : null;
  const pullbackZoneLower =
    atrAvailable && emaMediumAvailable
      ? (indicators.emaMedium as number) -
        (indicators.atr as number) * options.pullbackToleranceAtr
      : null;

  const pullbackLow =
    previousCandle === null
      ? null
      : Math.min(previousCandle.low, currentCandle.low);

  const previousTouchesZone =
    previousCandle !== null &&
    pullbackZoneLower !== null &&
    pullbackZoneUpper !== null &&
    candleIntersectsZone(
      previousCandle,
      pullbackZoneLower,
      pullbackZoneUpper,
    );

  const currentTouchesZone =
    pullbackZoneLower !== null &&
    pullbackZoneUpper !== null &&
    candleIntersectsZone(
      currentCandle,
      pullbackZoneLower,
      pullbackZoneUpper,
    );

  const pullbackTouched =
    pullbackAvailable &&
    pullbackLow !== null &&
    pullbackZoneLower !== null &&
    pullbackLow >= pullbackZoneLower &&
    (previousTouchesZone || currentTouchesZone);

  const currentRange = currentCandle.high - currentCandle.low;
  const closeLocation =
    currentRange > 0
      ? (currentCandle.close - currentCandle.low) / currentRange
      : 0;

  const recoveryConfirmed =
    recoveryAvailable &&
    currentCandle.close > (indicators.emaFast as number) &&
    currentCandle.close > currentCandle.open &&
    currentCandle.close > (previousCandle as DayTradeCandle).close &&
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

  const conditions: TrendPullbackCondition[] = [
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
      requiredValue: 'EMA rápida > EMA intermediária > EMA lenta',
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
      id: 'pullback_na_zona',
      label: 'Recuo controlado até a região das médias',
      available: pullbackAvailable,
      passed: pullbackTouched,
      currentValue:
        pullbackLow === null ? null : formatNumber(pullbackLow),
      requiredValue:
        pullbackZoneLower === null || pullbackZoneUpper === null
          ? 'Região de pullback disponível'
          : `Mínima recente entre ${formatNumber(pullbackZoneLower)} e ${formatNumber(pullbackZoneUpper)}`,
      explanation:
        !pullbackAvailable
          ? 'Ainda faltam candles, ATR ou médias para calcular a região.'
          : pullbackTouched
            ? 'Um dos dois candles mais recentes recuou até a região permitida.'
            : 'Os candles recentes ainda não formaram um recuo controlado.',
    }),
    condition({
      id: 'recuperacao_confirmada',
      label: 'Recuperação confirmada no fechamento',
      available: recoveryAvailable,
      passed: recoveryConfirmed,
      currentValue: currentCandle.close,
      requiredValue:
        indicators.emaFast === null
          ? 'EMA rápida disponível'
          : `Candle positivo acima de ${formatNumber(indicators.emaFast)}, acima do fechamento anterior e próximo da máxima`,
      explanation:
        !recoveryAvailable
          ? 'Ainda não existe candle anterior ou EMA rápida.'
          : recoveryConfirmed
            ? 'O candle encerrou positivo, acima da EMA rápida e próximo da máxima.'
            : 'O candle atual ainda não confirmou força suficiente.',
    }),
    condition({
      id: 'volume_recuperacao',
      label: 'Volume confirma a recuperação',
      available: volumeAvailable,
      passed: volumeConfirmed,
      currentValue:
        indicators.relativeVolume === null ||
        previousCandleVolumeRatio === null
          ? null
          : `${formatNumber(indicators.relativeVolume, 2)}× média · ${formatNumber(previousCandleVolumeRatio, 2)}× anterior`,
      requiredValue:
        `Volume relativo ≥ ${formatNumber(options.minimumRelativeVolume, 2)}× e ` +
        `volume atual/anterior ≥ ${formatNumber(options.minimumPreviousCandleVolumeRatio, 2)}×`,
      explanation:
        !volumeAvailable
          ? 'O histórico de volume necessário ainda não está disponível.'
          : volumeConfirmed
            ? 'O volume superou os dois limites configurados.'
            : 'O volume ainda não superou os dois limites configurados.',
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
          ? 'Ainda não há histórico para classificar a volatilidade.'
          : options.blockedVolatilityRegimes.includes(
                indicators.volatilityRegime,
              )
            ? `O regime ${indicators.volatilityRegime} está bloqueado.`
            : `O regime ${indicators.volatilityRegime} é permitido.`,
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
          ? 'Não foi possível construir entrada, invalidação e alvo.'
          : !stopDistanceValid
            ? `A distância do stop seria de ${formatNumber(plan.stopDistanceAtr, 2)} ATR.`
            : `O stop está a ${formatNumber(plan.stopDistanceAtr, 2)} ATR e o alvo oferece ${formatNumber(plan.riskRewardRatio, 2)}R.`,
    }),
  ];

  const passedConditions =
    conditions.filter((item) => item.passed).length;
  const totalConditions = conditions.length;
  const allConditionsMet =
    indicators.ready &&
    previousCandleAvailable &&
    passedConditions === totalConditions;

  const trendConditionsPassed = conditions
    .filter((item) =>
      [
        'tendencia_principal_positiva',
        'emas_alinhadas',
        'volatilidade_aceitavel',
      ].includes(item.id),
    )
    .every((item) => item.passed);

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

  let status: TrendPullbackStatus;

  if (!indicators.ready || !previousCandleAvailable) {
    status = 'dados_insuficientes';
  } else if (liveInvalidated) {
    status = 'invalidado';
  } else if (liveEntryLate) {
    status = 'entrada_atrasada';
  } else if (allConditionsMet) {
    status = 'condicoes_atendidas';
  } else if (
    trendConditionsPassed &&
    pullbackTouched &&
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

  if (!previousCandleAvailable) {
    warnings.push(
      'É necessário pelo menos um candle anterior para avaliar o pullback.',
    );
  }

  if (indicators.volatilityRegime === 'extremo') {
    warnings.push(
      'A volatilidade está no regime extremo do histórico analisado.',
    );
  }

  if (
    indicators.relativeVolume !== null &&
    indicators.relativeVolume < options.minimumRelativeVolume
  ) {
    warnings.push(
      'A recuperação não possui volume relativo suficiente.',
    );
  }

  if (
    previousCandleVolumeRatio !== null &&
    previousCandleVolumeRatio <
      options.minimumPreviousCandleVolumeRatio
  ) {
    warnings.push(
      'O volume atual ainda não superou o volume do candle anterior.',
    );
  }

  if (plan && !stopDistanceValid) {
    warnings.push(
      `A invalidação ficaria a ${formatNumber(plan.stopDistanceAtr, 2)} ATR da entrada.`,
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
    strategy: TREND_PULLBACK_STRATEGY_ID,
    strategyVersion: TREND_PULLBACK_STRATEGY_VERSION,
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
      options,
    ),
    summary: determineSummary(
      status,
      passedConditions,
      totalConditions,
    ),
    warnings,
    educationalNotice: TREND_PULLBACK_EDUCATIONAL_NOTICE,
    diagnostics: {
      ready: indicators.ready && previousCandleAvailable,
      candleCount: indicators.candleCount,
      requiredCandles: indicators.requiredCandles,
      missingCandles:
        indicators.missingCandles +
        (previousCandleAvailable ? 0 : 1),
      volatilityRegime: indicators.volatilityRegime,
      volatilityPercentile: indicators.volatilityPercentile,
      relativeVolume: indicators.relativeVolume,
      previousCandleVolumeRatio,
      pullbackTouched:
        pullbackAvailable ? pullbackTouched : null,
      recoveryConfirmed:
        recoveryAvailable ? recoveryConfirmed : null,
      pullbackLow,
      pullbackZoneUpper,
      pullbackZoneLower,
      stopDistanceAtr: plan?.stopDistanceAtr ?? null,
    },
  };
}

export function analyzeTrendPullback(
  input: AnalyzeTrendPullbackInput,
): {
  indicators: DayTradeIndicators;
  evaluation: TrendPullbackEvaluation;
} {
  const indicators = calculateDayTradeIndicators(
    input.candles,
    input.indicatorOptions,
  );

  const evaluation = evaluateTrendPullback({
    candles: input.candles,
    indicators,
    livePrice: input.livePrice,
    options: input.strategyOptions,
  });

  return { indicators, evaluation };
}

export const TREND_PULLBACK_STATUS_LABELS: Record<
  TrendPullbackStatus,
  { label: string; shortDescription: string }
> = {
  dados_insuficientes: {
    label: 'Dados insuficientes',
    shortDescription: 'Ainda faltam candles para calcular os critérios.',
  },
  aguardar: {
    label: 'Aguardar',
    shortDescription: 'As condições ainda não formam um pullback válido.',
  },
  observar: {
    label: 'Observar',
    shortDescription: 'O preço recuou até a região, mas falta confirmação.',
  },
  condicoes_atendidas: {
    label: 'Condições atendidas',
    shortDescription: 'O último candle cumpriu todas as regras.',
  },
  entrada_atrasada: {
    label: 'Entrada atrasada',
    shortDescription: 'O preço já se afastou da entrada calculada.',
  },
  invalidado: {
    label: 'Invalidado',
    shortDescription: 'O preço atingiu o ponto de invalidação.',
  },
};