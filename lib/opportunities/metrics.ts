/**
 * lib/opportunities/metrics.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Métricas puras da Central de Oportunidades e do gerenciamento de posição.
 *
 * Responsabilidades:
 * - Medir a qualidade teórica dos setups.
 * - Medir o resultado das operações realmente executadas.
 * - Comparar oportunidades aceitas, recusadas e expiradas.
 * - Calcular taxa de acerto, expectativa, profit factor e drawdown.
 * - Calcular sequências, MFE, MAE e tempo médio de operação.
 * - Medir o efeito financeiro do dimensionamento contra o risco fixo.
 * - Resumir modos, multiplicadores, limites e riscos planejados/reais.
 * - Criar recortes por ativo, timeframe, estratégia, versão e origem.
 *
 * Regras importantes:
 * - Este arquivo não consulta o Supabase e não executa ordens.
 * - Resultados "tracking", ambíguos, inválidos ou cancelados não entram
 *   artificialmente na taxa de acerto.
 * - Taxa de acerto, expectativa e profit factor são métricas diferentes.
 * - A medição executada usa somente outcomes mode="executed".
 * - A medição teórica usa somente outcomes mode="theoretical".
 * - O efeito do dimensionamento é lido dos outcomes executados já deduplicados.
 * - Decisões reservadas ou falhas não são tratadas como operações executadas.
 */

import {
  classifyOutcomeResult,
  isResolvedOutcomeStatus,
  type OutcomeResultClass,
} from './status';
import type {
  ExecutionEnvironment,
  ISODateString,
  OpportunityListItem,
  OpportunityOutcome,
  OpportunityOutcomeMode,
  OpportunityPerformanceSummary,
  OpportunitySourceType,
  PositionSizingDecision,
  PositionSizingEnvironment,
  PositionSizingMode,
  PositionSizingScope,
  PositionSizingStatus,
  TradeOpportunity,
  UUID,
} from './types';

// ---------------------------------------------------------------------------
// Contratos públicos
// ---------------------------------------------------------------------------

export type OpportunityMetricDimension =
  | 'symbol'
  | 'timeframe'
  | 'strategy'
  | 'strategy_version'
  | 'source_type'
  | 'execution_environment';

export interface OutcomeModeMetrics {
  mode: OpportunityOutcomeMode;

  total: number;
  tracking: number;
  resolved: number;
  conclusive: number;
  invalidOrAmbiguous: number;

  wins: number;
  losses: number;
  neutral: number;

  winRatePct: number | null;
  lossRatePct: number | null;

  totalResultR: number;
  expectancyR: number | null;
  averageWinR: number | null;
  averageLossR: number | null;
  bestResultR: number | null;
  worstResultR: number | null;

  grossProfitR: number;
  grossLossR: number;
  profitFactor: number | null;

  grossPnlUsdt: number;
  netPnlUsdt: number;
  feesUsdt: number;
  slippageUsdt: number;

  /**
   * Só são preenchidos com valores diferentes de zero quando as Edges já
   * persistiram a comparação de risco nos outcomes executados.
   */
  fixedRiskEquivalentPnlUsdt: number;
  sizingEffectPnlUsdt: number;
  sizingComparisonCount: number;

  maximumDrawdownR: number | null;
  currentDrawdownR: number | null;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  currentConsecutiveWins: number;
  currentConsecutiveLosses: number;

  averageMfeR: number | null;
  averageMaeR: number | null;

  averageHoldingMinutes: number | null;
  medianHoldingMinutes: number | null;
}

export interface EntryDecisionMetrics {
  totalEntryOpportunities: number;
  pending: number;
  accepted: number;
  rejected: number;
  expired: number;
  notApplicable: number;

  decided: number;
  acceptanceRatePct: number | null;
  rejectionRatePct: number | null;
  expirationRatePct: number | null;
}

export interface DecisionQualityMetrics {
  acceptedWithTheoreticalOutcome: number;
  rejectedWithTheoreticalOutcome: number;
  expiredWithTheoreticalOutcome: number;

  acceptedTheoreticalWins: number;
  acceptedTheoreticalLosses: number;
  acceptedTheoreticalResultR: number;
  acceptedTheoreticalWinRatePct: number | null;

  rejectedTheoreticalWins: number;
  rejectedTheoreticalLosses: number;
  rejectedTheoreticalResultR: number;
  rejectedTheoreticalWinRatePct: number | null;

  expiredTheoreticalWins: number;
  expiredTheoreticalLosses: number;
  expiredTheoreticalResultR: number;

  avoidedLosses: number;
  missedWins: number;
  rejectedNeutralOrInconclusive: number;

  selectionResultDeltaR: number | null;
}

export interface PositionSizingModeCount {
  mode: PositionSizingMode;
  total: number;
  applied: number;
  failed: number;
  cancelled: number;
  reserved: number;
}

export interface PositionSizingEnvironmentCount {
  environment: PositionSizingEnvironment;
  total: number;
  applied: number;
}

export interface PositionSizingScopeCount {
  scope: PositionSizingScope;
  total: number;
  applied: number;
}

export interface PositionSizingMetrics {
  totalDecisions: number;
  appliedDecisions: number;
  reservedDecisions: number;
  failedDecisions: number;
  cancelledDecisions: number;

  fixedDecisions: number;
  antiMartingaleDecisions: number;
  martingaleTestnetDecisions: number;

  testnetDecisions: number;
  realDecisions: number;

  decisionsWithLimits: number;
  consecutiveLossPauseBlocks: number;

  averageRiskMultiplier: number | null;
  maximumRiskMultiplier: number | null;
  minimumRiskMultiplier: number | null;

  averageBaseRiskPct: number | null;
  averageTargetRiskPct: number | null;
  averageAppliedRiskPct: number | null;

  averagePlannedRiskUsdt: number | null;
  totalPlannedRiskUsdt: number;
  averageActualRiskUsdt: number | null;
  totalActualRiskUsdt: number;

  averageRequestedQuoteAmountUsdt: number | null;
  averageEffectiveQuoteAmountUsdt: number | null;
  totalEffectiveQuoteAmountUsdt: number;

  averageSequenceStep: number | null;
  maximumSequenceStep: number;

  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  maximumAccountConsecutiveWins: number;
  maximumAccountConsecutiveLosses: number;

  sizingComparisonCount: number;
  fixedRiskEquivalentPnlUsdt: number;
  sizingEffectPnlUsdt: number;
  sizingEffectPositiveTrades: number;
  sizingEffectNegativeTrades: number;
  sizingEffectNeutralTrades: number;

  modeCounts: PositionSizingModeCount[];
  environmentCounts: PositionSizingEnvironmentCount[];
  scopeCounts: PositionSizingScopeCount[];
}

export interface OpportunityDashboardMetrics
  extends OpportunityPerformanceSummary {
  entryDecisions: EntryDecisionMetrics;
  decisionQuality: DecisionQualityMetrics;
  theoretical: OutcomeModeMetrics;
  executed: OutcomeModeMetrics;
  sizing: PositionSizingMetrics;

  unreadOpportunities: number;
  pendingOpportunities: number;
  openPositions: number;
  pendingExits: number;
  attentionRequired: number;
}

export interface OpportunityMetricBreakdownItem {
  dimension: OpportunityMetricDimension;
  key: string;
  label: string;
  totalOpportunities: number;
  entryDecisions: EntryDecisionMetrics;
  theoretical: OutcomeModeMetrics;
  executed: OutcomeModeMetrics;
  sizing: PositionSizingMetrics;
}

export interface CalculateOpportunityMetricsInput {
  opportunities: readonly (TradeOpportunity | OpportunityListItem)[];
  outcomes?: readonly OpportunityOutcome[];
  positionSizingDecisions?: readonly PositionSizingDecision[];
}

export interface DrawdownPoint {
  outcomeId: UUID;
  opportunityId: UUID;
  resolvedAt: ISODateString;
  resultR: number;
  equityR: number;
  peakEquityR: number;
  drawdownR: number;
}

// ---------------------------------------------------------------------------
// Utilitários numéricos
// ---------------------------------------------------------------------------

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number | null {
  return values.length > 0 ? sum(values) / values.length : null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    const left = sorted[middle - 1];
    const right = sorted[middle];

    if (left === undefined || right === undefined) {
      return null;
    }

    return (left + right) / 2;
  }

  return sorted[middle] ?? null;
}

function percentage(
  numerator: number,
  denominator: number,
): number | null {
  return denominator > 0
    ? (numerator / denominator) * 100
    : null;
}

function timestamp(
  value: ISODateString | null | undefined,
): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function holdingMinutes(
  outcome: OpportunityOutcome,
): number | null {
  const entryAt = timestamp(outcome.entry_at);
  const exitAt = timestamp(
    outcome.exit_at ?? outcome.resolved_at,
  );

  if (
    entryAt === null ||
    exitAt === null ||
    exitAt < entryAt
  ) {
    return null;
  }

  return (exitAt - entryAt) / 60_000;
}

function numberValues(
  values: readonly (number | null | undefined)[],
): number[] {
  return values.filter(
    (value): value is number =>
      typeof value === 'number' &&
      Number.isFinite(value),
  );
}

function maximum(
  values: readonly number[],
): number | null {
  return values.length > 0 ? Math.max(...values) : null;
}

function minimum(
  values: readonly number[],
): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

// ---------------------------------------------------------------------------
// Normalização e deduplicação dos outcomes
// ---------------------------------------------------------------------------

function outcomeRecency(
  outcome: OpportunityOutcome,
): number {
  return (
    timestamp(outcome.updated_at) ??
    timestamp(outcome.resolved_at) ??
    timestamp(outcome.created_at) ??
    0
  );
}

/**
 * Mantém somente o registro mais recente de cada oportunidade + modo.
 * A restrição do banco já deve garantir unicidade; esta proteção também
 * evita métricas duplicadas durante reconexões do Realtime.
 */
export function deduplicateOutcomes(
  outcomes: readonly OpportunityOutcome[],
): OpportunityOutcome[] {
  const latest = new Map<string, OpportunityOutcome>();

  for (const outcome of outcomes) {
    const key = `${outcome.opportunity_id}:${outcome.mode}`;
    const current = latest.get(key);

    if (
      !current ||
      outcomeRecency(outcome) >= outcomeRecency(current)
    ) {
      latest.set(key, outcome);
    }
  }

  return [...latest.values()];
}

export function collectEmbeddedOutcomes(
  opportunities: readonly (
    | TradeOpportunity
    | OpportunityListItem
  )[],
): OpportunityOutcome[] {
  const collected: OpportunityOutcome[] = [];

  for (const opportunity of opportunities) {
    const relations =
      (opportunity as OpportunityListItem).outcomes;

    if (Array.isArray(relations)) {
      collected.push(...relations);
    }
  }

  return deduplicateOutcomes(collected);
}

function resolveOutcomes(
  input: CalculateOpportunityMetricsInput,
): OpportunityOutcome[] {
  if (input.outcomes) {
    return deduplicateOutcomes(input.outcomes);
  }

  return collectEmbeddedOutcomes(input.opportunities);
}

function outcomeKey(
  opportunityId: UUID,
  mode: OpportunityOutcomeMode,
): string {
  return `${opportunityId}:${mode}`;
}

export function createOutcomeIndex(
  outcomes: readonly OpportunityOutcome[],
): ReadonlyMap<string, OpportunityOutcome> {
  const index = new Map<string, OpportunityOutcome>();

  for (const outcome of deduplicateOutcomes(outcomes)) {
    index.set(
      outcomeKey(outcome.opportunity_id, outcome.mode),
      outcome,
    );
  }

  return index;
}

// ---------------------------------------------------------------------------
// Normalização e deduplicação das decisões de dimensionamento
// ---------------------------------------------------------------------------

function positionSizingDecisionRecency(
  decision: PositionSizingDecision,
): number {
  return (
    timestamp(decision.updated_at) ??
    timestamp(decision.applied_at) ??
    timestamp(decision.created_at) ??
    0
  );
}

/**
 * Deduplica somente o mesmo ID. Decisões diferentes permanecem no histórico,
 * inclusive reservas antigas e novas tentativas auditáveis.
 */
export function deduplicatePositionSizingDecisions(
  decisions: readonly PositionSizingDecision[],
): PositionSizingDecision[] {
  const latest = new Map<UUID, PositionSizingDecision>();

  for (const decision of decisions) {
    const current = latest.get(decision.id);

    if (
      !current ||
      positionSizingDecisionRecency(decision) >=
        positionSizingDecisionRecency(current)
    ) {
      latest.set(decision.id, decision);
    }
  }

  return [...latest.values()];
}

export function collectEmbeddedPositionSizingDecisions(
  opportunities: readonly (
    | TradeOpportunity
    | OpportunityListItem
  )[],
): PositionSizingDecision[] {
  const collected: PositionSizingDecision[] = [];

  for (const opportunity of opportunities) {
    const relations =
      (opportunity as OpportunityListItem)
        .positionSizingDecisions;

    if (Array.isArray(relations)) {
      collected.push(...relations);
    }
  }

  return deduplicatePositionSizingDecisions(collected);
}

function resolvePositionSizingDecisions(
  input: CalculateOpportunityMetricsInput,
): PositionSizingDecision[] {
  if (input.positionSizingDecisions) {
    return deduplicatePositionSizingDecisions(
      input.positionSizingDecisions,
    );
  }

  return collectEmbeddedPositionSizingDecisions(
    input.opportunities,
  );
}

/**
 * Retorna a decisão mais recente de cada oportunidade. É adequada para badges
 * e cards; métricas históricas devem usar a coleção completa deduplicada.
 */
export function createLatestPositionSizingDecisionIndex(
  decisions: readonly PositionSizingDecision[],
): ReadonlyMap<UUID, PositionSizingDecision> {
  const index = new Map<UUID, PositionSizingDecision>();

  for (
    const decision of deduplicatePositionSizingDecisions(
      decisions,
    )
  ) {
    if (!decision.opportunity_id) {
      continue;
    }

    const current = index.get(decision.opportunity_id);

    if (
      !current ||
      positionSizingDecisionRecency(decision) >=
        positionSizingDecisionRecency(current)
    ) {
      index.set(decision.opportunity_id, decision);
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Classificação das amostras
// ---------------------------------------------------------------------------

function isConclusiveClass(
  resultClass: OutcomeResultClass,
): boolean {
  return (
    resultClass === 'win' ||
    resultClass === 'loss' ||
    resultClass === 'neutral'
  );
}

function isInvalidClass(
  resultClass: OutcomeResultClass,
): boolean {
  return (
    resultClass === 'invalid' ||
    resultClass === 'error'
  );
}

function resultRValues(
  outcomes: readonly OpportunityOutcome[],
): number[] {
  const values: number[] = [];

  for (const outcome of outcomes) {
    const resultClass = classifyOutcomeResult(outcome);
    const value = finiteNumber(outcome.result_r);

    if (
      isConclusiveClass(resultClass) &&
      value !== null
    ) {
      values.push(value);
    }
  }

  return values;
}

function sortResolvedOutcomes(
  outcomes: readonly OpportunityOutcome[],
): OpportunityOutcome[] {
  return [...outcomes].sort((left, right) => {
    const leftTime =
      timestamp(left.resolved_at) ??
      timestamp(left.exit_at) ??
      timestamp(left.updated_at) ??
      timestamp(left.created_at) ??
      0;

    const rightTime =
      timestamp(right.resolved_at) ??
      timestamp(right.exit_at) ??
      timestamp(right.updated_at) ??
      timestamp(right.created_at) ??
      0;

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.id.localeCompare(right.id);
  });
}

// ---------------------------------------------------------------------------
// Drawdown e sequências
// ---------------------------------------------------------------------------

export function calculateDrawdownSeries(
  outcomes: readonly OpportunityOutcome[],
): DrawdownPoint[] {
  const usable = sortResolvedOutcomes(outcomes).filter(
    (outcome) => {
      const resultClass =
        classifyOutcomeResult(outcome);

      return (
        isConclusiveClass(resultClass) &&
        finiteNumber(outcome.result_r) !== null &&
        isResolvedOutcomeStatus(outcome.status)
      );
    },
  );

  const series: DrawdownPoint[] = [];
  let equityR = 0;
  let peakEquityR = 0;

  for (const outcome of usable) {
    const resultR = finiteNumber(outcome.result_r);

    if (resultR === null) {
      continue;
    }

    equityR += resultR;
    peakEquityR = Math.max(peakEquityR, equityR);

    const resolvedAt =
      outcome.resolved_at ??
      outcome.exit_at ??
      outcome.updated_at ??
      outcome.created_at;

    series.push({
      outcomeId: outcome.id,
      opportunityId: outcome.opportunity_id,
      resolvedAt,
      resultR,
      equityR,
      peakEquityR,
      drawdownR: equityR - peakEquityR,
    });
  }

  return series;
}

interface StreakMetrics {
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  currentConsecutiveWins: number;
  currentConsecutiveLosses: number;
}

function calculateStreaks(
  outcomes: readonly OpportunityOutcome[],
): StreakMetrics {
  const sorted = sortResolvedOutcomes(outcomes);

  let currentWins = 0;
  let currentLosses = 0;
  let maximumWins = 0;
  let maximumLosses = 0;

  for (const outcome of sorted) {
    const resultClass =
      classifyOutcomeResult(outcome);

    if (resultClass === 'win') {
      currentWins += 1;
      currentLosses = 0;
      maximumWins = Math.max(
        maximumWins,
        currentWins,
      );
      continue;
    }

    if (resultClass === 'loss') {
      currentLosses += 1;
      currentWins = 0;
      maximumLosses = Math.max(
        maximumLosses,
        currentLosses,
      );
      continue;
    }

    if (resultClass === 'neutral') {
      currentWins = 0;
      currentLosses = 0;
    }
  }

  return {
    maximumConsecutiveWins: maximumWins,
    maximumConsecutiveLosses: maximumLosses,
    currentConsecutiveWins: currentWins,
    currentConsecutiveLosses: currentLosses,
  };
}

// ---------------------------------------------------------------------------
// Métricas por modo
// ---------------------------------------------------------------------------

export function calculateOutcomeModeMetrics(
  outcomes: readonly OpportunityOutcome[],
  mode: OpportunityOutcomeMode,
): OutcomeModeMetrics {
  const modeOutcomes = deduplicateOutcomes(
    outcomes,
  ).filter((outcome) => outcome.mode === mode);

  const resultClasses = modeOutcomes.map(
    (outcome) => ({
      outcome,
      resultClass:
        classifyOutcomeResult(outcome),
    }),
  );

  const tracking = resultClasses.filter(
    ({ resultClass }) =>
      resultClass === 'tracking',
  ).length;

  const resolved = resultClasses.filter(
    ({ outcome }) =>
      isResolvedOutcomeStatus(outcome.status),
  ).length;

  const wins = resultClasses.filter(
    ({ resultClass }) => resultClass === 'win',
  ).length;

  const losses = resultClasses.filter(
    ({ resultClass }) => resultClass === 'loss',
  ).length;

  const neutral = resultClasses.filter(
    ({ resultClass }) =>
      resultClass === 'neutral',
  ).length;

  const invalidOrAmbiguous =
    resultClasses.filter(({ resultClass }) =>
      isInvalidClass(resultClass),
    ).length;

  const conclusive = wins + losses + neutral;
  const winLossDenominator = wins + losses;

  const rValues = resultRValues(modeOutcomes);
  const winningR = rValues.filter(
    (value) => value > 0,
  );
  const losingR = rValues.filter(
    (value) => value < 0,
  );

  const grossProfitR = sum(winningR);
  const grossLossR = Math.abs(sum(losingR));

  // Profit factor não deve virar Infinity na interface ou no JSON.
  // Quando não existem perdas suficientes, retorna null.
  const profitFactor =
    grossLossR > 0
      ? grossProfitR / grossLossR
      : null;

  const drawdownSeries =
    calculateDrawdownSeries(modeOutcomes);
  const drawdowns = drawdownSeries.map(
    (point) => point.drawdownR,
  );
  const lastDrawdown =
    drawdownSeries.at(-1)?.drawdownR ?? null;
  const maximumDrawdownR =
    drawdowns.length > 0
      ? Math.min(...drawdowns)
      : null;

  const streaks = calculateStreaks(modeOutcomes);

  const mfeValues = numberValues(
    modeOutcomes.map(
      (outcome) =>
        outcome.maximum_favorable_excursion_r,
    ),
  );

  const maeValues = numberValues(
    modeOutcomes.map(
      (outcome) =>
        outcome.maximum_adverse_excursion_r,
    ),
  );

  const holdingValues = modeOutcomes
    .map(holdingMinutes)
    .filter(
      (value): value is number =>
        value !== null,
    );

  const grossPnlValues = numberValues(
    modeOutcomes.map(
      (outcome) => outcome.gross_pnl_usdt,
    ),
  );

  const netPnlValues = numberValues(
    modeOutcomes.map(
      (outcome) => outcome.net_pnl_usdt,
    ),
  );

  const feesValues = numberValues(
    modeOutcomes.map(
      (outcome) => outcome.fees_usdt,
    ),
  );

  const slippageValues = numberValues(
    modeOutcomes.map(
      (outcome) => outcome.slippage_usdt,
    ),
  );

  const fixedRiskEquivalentValues =
    mode === 'executed'
      ? numberValues(
          modeOutcomes.map(
            (outcome) =>
              outcome.fixed_risk_equivalent_pnl_usdt,
          ),
        )
      : [];

  const sizingEffectValues =
    mode === 'executed'
      ? numberValues(
          modeOutcomes.map(
            (outcome) =>
              outcome.sizing_effect_pnl_usdt,
          ),
        )
      : [];

  const sizingComparisonIds =
    mode === 'executed'
      ? new Set(
          modeOutcomes
            .filter(
              (outcome) =>
                finiteNumber(
                  outcome
                    .fixed_risk_equivalent_pnl_usdt,
                ) !== null ||
                finiteNumber(
                  outcome.sizing_effect_pnl_usdt,
                ) !== null,
            )
            .map((outcome) => outcome.id),
        )
      : new Set<UUID>();

  return {
    mode,

    total: modeOutcomes.length,
    tracking,
    resolved,
    conclusive,
    invalidOrAmbiguous,

    wins,
    losses,
    neutral,

    winRatePct: percentage(
      wins,
      winLossDenominator,
    ),
    lossRatePct: percentage(
      losses,
      winLossDenominator,
    ),

    totalResultR: sum(rValues),
    expectancyR: average(rValues),
    averageWinR: average(winningR),
    averageLossR: average(losingR),
    bestResultR:
      rValues.length > 0
        ? Math.max(...rValues)
        : null,
    worstResultR:
      rValues.length > 0
        ? Math.min(...rValues)
        : null,

    grossProfitR,
    grossLossR,
    profitFactor,

    grossPnlUsdt: sum(grossPnlValues),
    netPnlUsdt: sum(netPnlValues),
    feesUsdt: sum(feesValues),
    slippageUsdt: sum(slippageValues),

    fixedRiskEquivalentPnlUsdt:
      sum(fixedRiskEquivalentValues),
    sizingEffectPnlUsdt:
      sum(sizingEffectValues),
    sizingComparisonCount:
      sizingComparisonIds.size,

    maximumDrawdownR,
    currentDrawdownR: lastDrawdown,

    ...streaks,

    averageMfeR: average(mfeValues),
    averageMaeR: average(maeValues),

    averageHoldingMinutes:
      average(holdingValues),
    medianHoldingMinutes:
      median(holdingValues),
  };
}

// ---------------------------------------------------------------------------
// Métricas do gerenciamento de posição
// ---------------------------------------------------------------------------

function decisionsByStatus(
  decisions: readonly PositionSizingDecision[],
  status: PositionSizingStatus,
): PositionSizingDecision[] {
  return decisions.filter(
    (decision) => decision.status === status,
  );
}

function countByMode(
  decisions: readonly PositionSizingDecision[],
  mode: PositionSizingMode,
  status?: PositionSizingStatus,
): number {
  return decisions.filter(
    (decision) =>
      decision.sizing_mode === mode &&
      (!status || decision.status === status),
  ).length;
}

function countByEnvironment(
  decisions: readonly PositionSizingDecision[],
  environment: PositionSizingEnvironment,
  status?: PositionSizingStatus,
): number {
  return decisions.filter(
    (decision) =>
      decision.execution_environment ===
        environment &&
      (!status || decision.status === status),
  ).length;
}

function countByScope(
  decisions: readonly PositionSizingDecision[],
  scope: PositionSizingScope,
  status?: PositionSizingStatus,
): number {
  return decisions.filter(
    (decision) =>
      decision.sizing_scope === scope &&
      (!status || decision.status === status),
  ).length;
}

function outcomeSizingComparisonValues(
  outcomes: readonly OpportunityOutcome[],
): {
  count: number;
  fixedRiskEquivalentPnlUsdt: number;
  sizingEffectPnlUsdt: number;
  positive: number;
  negative: number;
  neutral: number;
} {
  const executed = deduplicateOutcomes(
    outcomes,
  ).filter(
    (outcome) => outcome.mode === 'executed',
  );

  let count = 0;
  let fixedRiskEquivalentPnlUsdt = 0;
  let sizingEffectPnlUsdt = 0;
  let positive = 0;
  let negative = 0;
  let neutral = 0;

  for (const outcome of executed) {
    const fixed =
      finiteNumber(
        outcome.fixed_risk_equivalent_pnl_usdt,
      );
    const effect =
      finiteNumber(
        outcome.sizing_effect_pnl_usdt,
      );

    if (fixed === null && effect === null) {
      continue;
    }

    count += 1;

    if (fixed !== null) {
      fixedRiskEquivalentPnlUsdt += fixed;
    }

    if (effect !== null) {
      sizingEffectPnlUsdt += effect;

      if (effect > 0) {
        positive += 1;
      } else if (effect < 0) {
        negative += 1;
      } else {
        neutral += 1;
      }
    } else {
      neutral += 1;
    }
  }

  return {
    count,
    fixedRiskEquivalentPnlUsdt,
    sizingEffectPnlUsdt,
    positive,
    negative,
    neutral,
  };
}

export function calculatePositionSizingMetrics(
  decisions: readonly PositionSizingDecision[],
  outcomes: readonly OpportunityOutcome[] = [],
): PositionSizingMetrics {
  const unique =
    deduplicatePositionSizingDecisions(decisions);

  const applied =
    decisionsByStatus(unique, 'applied');
  const reserved =
    decisionsByStatus(unique, 'reserved');
  const failed =
    decisionsByStatus(unique, 'failed');
  const cancelled =
    decisionsByStatus(unique, 'cancelled');

  /**
   * Médias de risco e capital consideram somente decisões aplicadas.
   * Uma reserva sem ordem não deve distorcer o risco realmente utilizado.
   */
  const riskMultipliers = numberValues(
    applied.map(
      (decision) => decision.risk_multiplier,
    ),
  );

  const baseRisks = numberValues(
    applied.map(
      (decision) =>
        decision.base_risk_percent,
    ),
  );

  const targetRisks = numberValues(
    applied.map(
      (decision) =>
        decision.target_risk_percent,
    ),
  );

  const appliedRisks = numberValues(
    applied.map(
      (decision) =>
        decision.applied_risk_percent,
    ),
  );

  const plannedRisks = numberValues(
    applied.map(
      (decision) =>
        decision.planned_risk_usdt,
    ),
  );

  const actualRisks = numberValues(
    applied.map(
      (decision) =>
        decision.actual_risk_usdt,
    ),
  );

  const requestedQuotes = numberValues(
    applied.map(
      (decision) =>
        decision.requested_quote_amount,
    ),
  );

  const effectiveQuotes = numberValues(
    applied.map(
      (decision) =>
        decision.effective_quote_amount,
    ),
  );

  const sequenceSteps = numberValues(
    applied.map(
      (decision) => decision.sequence_step,
    ),
  );

  const comparison =
    outcomeSizingComparisonValues(outcomes);

  const modeCounts: PositionSizingModeCount[] = (
    [
      'fixed',
      'anti_martingale',
      'martingale_testnet',
    ] as const
  ).map((mode) => ({
    mode,
    total: countByMode(unique, mode),
    applied: countByMode(
      unique,
      mode,
      'applied',
    ),
    failed: countByMode(
      unique,
      mode,
      'failed',
    ),
    cancelled: countByMode(
      unique,
      mode,
      'cancelled',
    ),
    reserved: countByMode(
      unique,
      mode,
      'reserved',
    ),
  }));

  const environmentCounts:
    PositionSizingEnvironmentCount[] = (
      ['testnet', 'real'] as const
    ).map((environment) => ({
      environment,
      total: countByEnvironment(
        unique,
        environment,
      ),
      applied: countByEnvironment(
        unique,
        environment,
        'applied',
      ),
    }));

  const scopeCounts: PositionSizingScopeCount[] = (
    [
      'account',
      'strategy',
      'symbol',
      'symbol_timeframe',
    ] as const
  ).map((scope) => ({
    scope,
    total: countByScope(unique, scope),
    applied: countByScope(
      unique,
      scope,
      'applied',
    ),
  }));

  return {
    totalDecisions: unique.length,
    appliedDecisions: applied.length,
    reservedDecisions: reserved.length,
    failedDecisions: failed.length,
    cancelledDecisions: cancelled.length,

    fixedDecisions:
      countByMode(unique, 'fixed'),
    antiMartingaleDecisions:
      countByMode(unique, 'anti_martingale'),
    martingaleTestnetDecisions:
      countByMode(unique, 'martingale_testnet'),

    testnetDecisions:
      countByEnvironment(unique, 'testnet'),
    realDecisions:
      countByEnvironment(unique, 'real'),

    decisionsWithLimits: unique.filter(
      (decision) =>
        Array.isArray(decision.limiting_rules) &&
        decision.limiting_rules.length > 0,
    ).length,

    consecutiveLossPauseBlocks: unique.filter(
      (decision) =>
        Array.isArray(decision.limiting_rules) &&
        decision.limiting_rules.some(
          (rule) =>
            rule ===
            'consecutive_loss_pause',
        ),
    ).length,

    averageRiskMultiplier:
      average(riskMultipliers),
    maximumRiskMultiplier:
      maximum(riskMultipliers),
    minimumRiskMultiplier:
      minimum(riskMultipliers),

    averageBaseRiskPct:
      average(baseRisks),
    averageTargetRiskPct:
      average(targetRisks),
    averageAppliedRiskPct:
      average(appliedRisks),

    averagePlannedRiskUsdt:
      average(plannedRisks),
    totalPlannedRiskUsdt:
      sum(plannedRisks),

    averageActualRiskUsdt:
      average(actualRisks),
    totalActualRiskUsdt:
      sum(actualRisks),

    averageRequestedQuoteAmountUsdt:
      average(requestedQuotes),
    averageEffectiveQuoteAmountUsdt:
      average(effectiveQuotes),
    totalEffectiveQuoteAmountUsdt:
      sum(effectiveQuotes),

    averageSequenceStep:
      average(sequenceSteps),
    maximumSequenceStep:
      maximum(sequenceSteps) ?? 0,

    maximumConsecutiveWins:
      maximum(
        unique.map(
          (decision) =>
            decision.consecutive_wins,
        ),
      ) ?? 0,

    maximumConsecutiveLosses:
      maximum(
        unique.map(
          (decision) =>
            decision.consecutive_losses,
        ),
      ) ?? 0,

    maximumAccountConsecutiveWins:
      maximum(
        unique.map(
          (decision) =>
            decision.account_consecutive_wins,
        ),
      ) ?? 0,

    maximumAccountConsecutiveLosses:
      maximum(
        unique.map(
          (decision) =>
            decision.account_consecutive_losses,
        ),
      ) ?? 0,

    sizingComparisonCount: comparison.count,
    fixedRiskEquivalentPnlUsdt:
      comparison.fixedRiskEquivalentPnlUsdt,
    sizingEffectPnlUsdt:
      comparison.sizingEffectPnlUsdt,

    sizingEffectPositiveTrades:
      comparison.positive,
    sizingEffectNegativeTrades:
      comparison.negative,
    sizingEffectNeutralTrades:
      comparison.neutral,

    modeCounts,
    environmentCounts,
    scopeCounts,
  };
}

// ---------------------------------------------------------------------------
// Métricas de decisão
// ---------------------------------------------------------------------------

export function calculateEntryDecisionMetrics(
  opportunities: readonly (
    | TradeOpportunity
    | OpportunityListItem
  )[],
): EntryDecisionMetrics {
  const entryOpportunities =
    opportunities.filter(
      (opportunity) =>
        opportunity.opportunity_type === 'entry',
    );

  const accepted = entryOpportunities.filter(
    (opportunity) =>
      opportunity.entry_decision === 'accepted',
  ).length;

  const rejected = entryOpportunities.filter(
    (opportunity) =>
      opportunity.entry_decision === 'rejected',
  ).length;

  const expired = entryOpportunities.filter(
    (opportunity) =>
      opportunity.entry_decision === 'expired',
  ).length;

  const pending = entryOpportunities.filter(
    (opportunity) =>
      opportunity.entry_decision === 'pending',
  ).length;

  const notApplicable =
    entryOpportunities.filter(
      (opportunity) =>
        opportunity.entry_decision ===
        'not_applicable',
    ).length;

  const decided = accepted + rejected;

  return {
    totalEntryOpportunities:
      entryOpportunities.length,
    pending,
    accepted,
    rejected,
    expired,
    notApplicable,

    decided,
    acceptanceRatePct:
      percentage(accepted, decided),
    rejectionRatePct:
      percentage(rejected, decided),
    expirationRatePct:
      percentage(
        expired,
        entryOpportunities.length,
      ),
  };
}

function outcomesForDecision(
  opportunities: readonly (
    | TradeOpportunity
    | OpportunityListItem
  )[],
  outcomeIndex: ReadonlyMap<
    string,
    OpportunityOutcome
  >,
  decision:
    | 'accepted'
    | 'rejected'
    | 'expired',
): OpportunityOutcome[] {
  const matched: OpportunityOutcome[] = [];

  for (const opportunity of opportunities) {
    if (
      opportunity.opportunity_type !== 'entry' ||
      opportunity.entry_decision !== decision
    ) {
      continue;
    }

    const outcome = outcomeIndex.get(
      outcomeKey(
        opportunity.id,
        'theoretical',
      ),
    );

    if (outcome) {
      matched.push(outcome);
    }
  }

  return matched;
}

function countResultClass(
  outcomes: readonly OpportunityOutcome[],
  resultClass: OutcomeResultClass,
): number {
  return outcomes.filter(
    (outcome) =>
      classifyOutcomeResult(outcome) ===
      resultClass,
  ).length;
}

export function calculateDecisionQualityMetrics(
  opportunities: readonly (
    | TradeOpportunity
    | OpportunityListItem
  )[],
  outcomes: readonly OpportunityOutcome[],
): DecisionQualityMetrics {
  const outcomeIndex = createOutcomeIndex(outcomes);

  const accepted = outcomesForDecision(
    opportunities,
    outcomeIndex,
    'accepted',
  );

  const rejected = outcomesForDecision(
    opportunities,
    outcomeIndex,
    'rejected',
  );

  const expired = outcomesForDecision(
    opportunities,
    outcomeIndex,
    'expired',
  );

  const acceptedWins =
    countResultClass(accepted, 'win');
  const acceptedLosses =
    countResultClass(accepted, 'loss');
  const rejectedWins =
    countResultClass(rejected, 'win');
  const rejectedLosses =
    countResultClass(rejected, 'loss');
  const expiredWins =
    countResultClass(expired, 'win');
  const expiredLosses =
    countResultClass(expired, 'loss');

  const acceptedR =
    sum(resultRValues(accepted));
  const rejectedR =
    sum(resultRValues(rejected));
  const expiredR =
    sum(resultRValues(expired));

  const acceptedConclusive =
    acceptedWins + acceptedLosses;
  const rejectedConclusive =
    rejectedWins + rejectedLosses;

  return {
    acceptedWithTheoreticalOutcome:
      accepted.length,
    rejectedWithTheoreticalOutcome:
      rejected.length,
    expiredWithTheoreticalOutcome:
      expired.length,

    acceptedTheoreticalWins:
      acceptedWins,
    acceptedTheoreticalLosses:
      acceptedLosses,
    acceptedTheoreticalResultR:
      acceptedR,
    acceptedTheoreticalWinRatePct:
      percentage(
        acceptedWins,
        acceptedConclusive,
      ),

    rejectedTheoreticalWins:
      rejectedWins,
    rejectedTheoreticalLosses:
      rejectedLosses,
    rejectedTheoreticalResultR:
      rejectedR,
    rejectedTheoreticalWinRatePct:
      percentage(
        rejectedWins,
        rejectedConclusive,
      ),

    expiredTheoreticalWins:
      expiredWins,
    expiredTheoreticalLosses:
      expiredLosses,
    expiredTheoreticalResultR:
      expiredR,

    avoidedLosses: rejectedLosses,
    missedWins: rejectedWins,
    rejectedNeutralOrInconclusive:
      rejected.length -
      rejectedWins -
      rejectedLosses,

    selectionResultDeltaR:
      accepted.length > 0 &&
      rejected.length > 0
        ? acceptedR / accepted.length -
          rejectedR / rejected.length
        : null,
  };
}

// ---------------------------------------------------------------------------
// Painel agregado
// ---------------------------------------------------------------------------

function uniqueResolvedOpportunityCount(
  outcomes: readonly OpportunityOutcome[],
): number {
  const ids = new Set<UUID>();

  for (const outcome of outcomes) {
    if (
      isResolvedOutcomeStatus(outcome.status)
    ) {
      ids.add(outcome.opportunity_id);
    }
  }

  return ids.size;
}

export function calculateOpportunityDashboardMetrics(
  input: CalculateOpportunityMetricsInput,
): OpportunityDashboardMetrics {
  const opportunities = [
    ...input.opportunities,
  ];
  const outcomes = resolveOutcomes(input);
  const sizingDecisions =
    resolvePositionSizingDecisions(input);

  const entryDecisions =
    calculateEntryDecisionMetrics(
      opportunities,
    );

  const decisionQuality =
    calculateDecisionQualityMetrics(
      opportunities,
      outcomes,
    );

  const theoretical =
    calculateOutcomeModeMetrics(
      outcomes,
      'theoretical',
    );

  const executed =
    calculateOutcomeModeMetrics(
      outcomes,
      'executed',
    );

  const sizing =
    calculatePositionSizingMetrics(
      sizingDecisions,
      outcomes,
    );

  const resolvedOpportunities =
    uniqueResolvedOpportunityCount(outcomes);

  const trackingOpportunities =
    Math.max(
      0,
      opportunities.length -
        resolvedOpportunities,
    );

  return {
    totalOpportunities:
      opportunities.length,
    resolvedOpportunities,
    trackingOpportunities,

    acceptedEntries:
      entryDecisions.accepted,
    rejectedEntries:
      entryDecisions.rejected,
    expiredEntries:
      entryDecisions.expired,
    acceptanceRatePct:
      entryDecisions.acceptanceRatePct,

    theoreticalWins:
      theoretical.wins,
    theoreticalLosses:
      theoretical.losses,
    theoreticalWinRatePct:
      theoretical.winRatePct,
    theoreticalResultR:
      theoretical.totalResultR,
    theoreticalExpectancyR:
      theoretical.expectancyR,
    theoreticalProfitFactor:
      theoretical.profitFactor,

    executedWins:
      executed.wins,
    executedLosses:
      executed.losses,
    executedWinRatePct:
      executed.winRatePct,
    executedResultR:
      executed.totalResultR,
    executedNetPnlUsdt:
      executed.netPnlUsdt,
    executedExpectancyR:
      executed.expectancyR,
    executedProfitFactor:
      executed.profitFactor,

    executedFixedRiskEquivalentPnlUsdt:
      sizing.fixedRiskEquivalentPnlUsdt,

    executedSizingEffectPnlUsdt:
      sizing.sizingEffectPnlUsdt,

    avoidedLosses:
      decisionQuality.avoidedLosses,
    missedWins:
      decisionQuality.missedWins,

    /**
     * O resumo principal mede a qualidade da estratégia, portanto utiliza
     * a curva teórica completa. A interface também recebe o detalhamento
     * executado separadamente em `executed`.
     */
    maximumDrawdownR:
      theoretical.maximumDrawdownR,
    maximumConsecutiveWins:
      theoretical.maximumConsecutiveWins,
    maximumConsecutiveLosses:
      theoretical.maximumConsecutiveLosses,

    entryDecisions,
    decisionQuality,
    theoretical,
    executed,
    sizing,

    unreadOpportunities:
      opportunities.filter(
        (opportunity) =>
          opportunity.seen_at === null,
      ).length,

    pendingOpportunities:
      opportunities.filter(
        (opportunity) =>
          [
            'pending',
            'under_review',
            'revalidating',
          ].includes(
            opportunity.lifecycle_status,
          ),
      ).length,

    openPositions:
      opportunities.filter(
        (opportunity) =>
          ['opening', 'open'].includes(
            opportunity.lifecycle_status,
          ),
      ).length,

    pendingExits:
      opportunities.filter(
        (opportunity) =>
          [
            'exit_pending',
            'closing',
          ].includes(
            opportunity.lifecycle_status,
          ),
      ).length,

    attentionRequired:
      opportunities.filter(
        (opportunity) =>
          opportunity.lifecycle_status ===
            'error' ||
          opportunity.severity === 'critical',
      ).length,
  };
}

// ---------------------------------------------------------------------------
// Recortes por dimensão
// ---------------------------------------------------------------------------

function dimensionValue(
  opportunity:
    | TradeOpportunity
    | OpportunityListItem,
  dimension: OpportunityMetricDimension,
): string {
  switch (dimension) {
    case 'symbol':
      return opportunity.symbol;

    case 'timeframe':
      return opportunity.timeframe;

    case 'strategy':
      return opportunity.strategy;

    case 'strategy_version':
      return opportunity.strategy_version;

    case 'source_type':
      return opportunity.source_type;

    case 'execution_environment':
      return opportunity.execution_environment;
  }
}

function sourceLabel(
  value: OpportunitySourceType,
): string {
  switch (value) {
    case 'daytrade_setup':
      return 'Day Trade';

    case 'alert_event':
      return 'Alertas';

    case 'analysis_scenario':
      return 'Análise';

    case 'position_exit':
      return 'Saídas';

    case 'manual_test':
      return 'Teste manual';
  }
}

function environmentLabel(
  value: ExecutionEnvironment,
): string {
  switch (value) {
    case 'none':
      return 'Somente acompanhamento';

    case 'testnet':
      return 'Binance Testnet';

    case 'real':
      return 'Binance real';
  }
}

function dimensionLabel(
  dimension: OpportunityMetricDimension,
  value: string,
): string {
  if (dimension === 'source_type') {
    return sourceLabel(
      value as OpportunitySourceType,
    );
  }

  if (
    dimension ===
    'execution_environment'
  ) {
    return environmentLabel(
      value as ExecutionEnvironment,
    );
  }

  return value;
}

export function calculateMetricBreakdown(
  input: CalculateOpportunityMetricsInput,
  dimension: OpportunityMetricDimension,
): OpportunityMetricBreakdownItem[] {
  const outcomes = resolveOutcomes(input);
  const sizingDecisions =
    resolvePositionSizingDecisions(input);

  const grouped = new Map<
    string,
    (
      | TradeOpportunity
      | OpportunityListItem
    )[]
  >();

  for (
    const opportunity of input.opportunities
  ) {
    const key = dimensionValue(
      opportunity,
      dimension,
    );
    const current = grouped.get(key) ?? [];
    current.push(opportunity);
    grouped.set(key, current);
  }

  const outcomeIndex = new Map<
    UUID,
    OpportunityOutcome[]
  >();

  for (const outcome of outcomes) {
    const current =
      outcomeIndex.get(
        outcome.opportunity_id,
      ) ?? [];

    current.push(outcome);

    outcomeIndex.set(
      outcome.opportunity_id,
      current,
    );
  }

  const sizingIndex = new Map<
    UUID,
    PositionSizingDecision[]
  >();

  for (const decision of sizingDecisions) {
    if (!decision.opportunity_id) {
      continue;
    }

    const current =
      sizingIndex.get(
        decision.opportunity_id,
      ) ?? [];

    current.push(decision);

    sizingIndex.set(
      decision.opportunity_id,
      current,
    );
  }

  const result:
    OpportunityMetricBreakdownItem[] = [];

  for (
    const [key, opportunities] of grouped
  ) {
    const groupOutcomes =
      opportunities.flatMap(
        (opportunity) =>
          outcomeIndex.get(
            opportunity.id,
          ) ?? [],
      );

    const groupSizingDecisions =
      opportunities.flatMap(
        (opportunity) =>
          sizingIndex.get(
            opportunity.id,
          ) ?? [],
      );

    result.push({
      dimension,
      key,
      label:
        dimensionLabel(
          dimension,
          key,
        ),
      totalOpportunities:
        opportunities.length,

      entryDecisions:
        calculateEntryDecisionMetrics(
          opportunities,
        ),

      theoretical:
        calculateOutcomeModeMetrics(
          groupOutcomes,
          'theoretical',
        ),

      executed:
        calculateOutcomeModeMetrics(
          groupOutcomes,
          'executed',
        ),

      sizing:
        calculatePositionSizingMetrics(
          groupSizingDecisions,
          groupOutcomes,
        ),
    });
  }

  return result.sort(
    (left, right) => {
      if (
        right.totalOpportunities !==
        left.totalOpportunities
      ) {
        return (
          right.totalOpportunities -
          left.totalOpportunities
        );
      }

      return left.label.localeCompare(
        right.label,
        'pt-BR',
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Atualização imutável útil para eventos Realtime
// ---------------------------------------------------------------------------

export function upsertOutcomeCollection(
  outcomes: readonly OpportunityOutcome[],
  nextOutcome: OpportunityOutcome,
): OpportunityOutcome[] {
  const next = outcomes.filter(
    (outcome) =>
      !(
        outcome.opportunity_id ===
          nextOutcome.opportunity_id &&
        outcome.mode === nextOutcome.mode
      ),
  );

  next.push(nextOutcome);
  return deduplicateOutcomes(next);
}

export function removeOutcomeFromCollection(
  outcomes: readonly OpportunityOutcome[],
  outcomeId: UUID,
): OpportunityOutcome[] {
  return outcomes.filter(
    (outcome) => outcome.id !== outcomeId,
  );
}

export function upsertPositionSizingDecisionCollection(
  decisions: readonly PositionSizingDecision[],
  nextDecision: PositionSizingDecision,
): PositionSizingDecision[] {
  const next = decisions.filter(
    (decision) =>
      decision.id !== nextDecision.id,
  );

  next.push(nextDecision);

  return deduplicatePositionSizingDecisions(
    next,
  ).sort(
    (left, right) =>
      positionSizingDecisionRecency(right) -
      positionSizingDecisionRecency(left),
  );
}

export function removePositionSizingDecisionFromCollection(
  decisions: readonly PositionSizingDecision[],
  decisionId: UUID,
): PositionSizingDecision[] {
  return decisions.filter(
    (decision) =>
      decision.id !== decisionId,
  );
}
