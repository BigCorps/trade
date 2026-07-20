/**
 * lib/opportunities/metrics.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Métricas puras da Central de Oportunidades.
 *
 * Responsabilidades:
 * - Medir a qualidade teórica dos setups.
 * - Medir o resultado das operações realmente executadas.
 * - Comparar oportunidades aceitas, recusadas e expiradas.
 * - Calcular taxa de acerto, expectativa, profit factor e drawdown.
 * - Calcular sequências, MFE, MAE e tempo médio de operação.
 * - Criar recortes por ativo, timeframe, estratégia, versão e origem.
 *
 * Regras importantes:
 * - Este arquivo não consulta o Supabase e não executa ordens.
 * - Resultados "tracking", ambíguos, inválidos ou cancelados não entram
 *   artificialmente na taxa de acerto.
 * - Taxa de acerto, expectativa e profit factor são métricas diferentes.
 * - A medição executada usa somente outcomes mode="executed".
 * - A medição teórica usa somente outcomes mode="theoretical".
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

export interface OpportunityDashboardMetrics
  extends OpportunityPerformanceSummary {
  entryDecisions: EntryDecisionMetrics;
  decisionQuality: DecisionQualityMetrics;
  theoretical: OutcomeModeMetrics;
  executed: OutcomeModeMetrics;

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
}

export interface CalculateOpportunityMetricsInput {
  opportunities: readonly (TradeOpportunity | OpportunityListItem)[];
  outcomes?: readonly OpportunityOutcome[];
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
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

function timestamp(value: ISODateString | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function holdingMinutes(outcome: OpportunityOutcome): number | null {
  const entryAt = timestamp(outcome.entry_at);
  const exitAt = timestamp(outcome.exit_at ?? outcome.resolved_at);

  if (entryAt === null || exitAt === null || exitAt < entryAt) {
    return null;
  }

  return (exitAt - entryAt) / 60_000;
}

// ---------------------------------------------------------------------------
// Normalização e deduplicação
// ---------------------------------------------------------------------------

function outcomeRecency(outcome: OpportunityOutcome): number {
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

    if (!current || outcomeRecency(outcome) >= outcomeRecency(current)) {
      latest.set(key, outcome);
    }
  }

  return [...latest.values()];
}

export function collectEmbeddedOutcomes(
  opportunities: readonly (TradeOpportunity | OpportunityListItem)[],
): OpportunityOutcome[] {
  const collected: OpportunityOutcome[] = [];

  for (const opportunity of opportunities) {
    const relations = (opportunity as OpportunityListItem).outcomes;

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
    index.set(outcomeKey(outcome.opportunity_id, outcome.mode), outcome);
  }

  return index;
}

// ---------------------------------------------------------------------------
// Classificação das amostras
// ---------------------------------------------------------------------------

function isConclusiveClass(resultClass: OutcomeResultClass): boolean {
  return (
    resultClass === 'win' ||
    resultClass === 'loss' ||
    resultClass === 'neutral'
  );
}

function isInvalidClass(resultClass: OutcomeResultClass): boolean {
  return resultClass === 'invalid' || resultClass === 'error';
}

function resultRValues(
  outcomes: readonly OpportunityOutcome[],
): number[] {
  const values: number[] = [];

  for (const outcome of outcomes) {
    const resultClass = classifyOutcomeResult(outcome);
    const value = finiteNumber(outcome.result_r);

    if (isConclusiveClass(resultClass) && value !== null) {
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
  const usable = sortResolvedOutcomes(outcomes).filter((outcome) => {
    const resultClass = classifyOutcomeResult(outcome);
    return (
      isConclusiveClass(resultClass) &&
      finiteNumber(outcome.result_r) !== null &&
      isResolvedOutcomeStatus(outcome.status)
    );
  });

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
    const resultClass = classifyOutcomeResult(outcome);

    if (resultClass === 'win') {
      currentWins += 1;
      currentLosses = 0;
      maximumWins = Math.max(maximumWins, currentWins);
      continue;
    }

    if (resultClass === 'loss') {
      currentLosses += 1;
      currentWins = 0;
      maximumLosses = Math.max(maximumLosses, currentLosses);
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
  const modeOutcomes = deduplicateOutcomes(outcomes).filter(
    (outcome) => outcome.mode === mode,
  );

  const resultClasses = modeOutcomes.map((outcome) => ({
    outcome,
    resultClass: classifyOutcomeResult(outcome),
  }));

  const tracking = resultClasses.filter(
    ({ resultClass }) => resultClass === 'tracking',
  ).length;

  const resolved = resultClasses.filter(({ outcome }) =>
    isResolvedOutcomeStatus(outcome.status),
  ).length;

  const wins = resultClasses.filter(
    ({ resultClass }) => resultClass === 'win',
  ).length;

  const losses = resultClasses.filter(
    ({ resultClass }) => resultClass === 'loss',
  ).length;

  const neutral = resultClasses.filter(
    ({ resultClass }) => resultClass === 'neutral',
  ).length;

  const invalidOrAmbiguous = resultClasses.filter(({ resultClass }) =>
    isInvalidClass(resultClass),
  ).length;

  const conclusive = wins + losses + neutral;
  const winLossDenominator = wins + losses;

  const rValues = resultRValues(modeOutcomes);
  const winningR = rValues.filter((value) => value > 0);
  const losingR = rValues.filter((value) => value < 0);

  const grossProfitR = sum(winningR);
  const grossLossR = Math.abs(sum(losingR));

  // Profit factor não deve virar Infinity na interface ou no JSON.
  // Quando não existem perdas suficientes, retorna null.
  const profitFactor =
    grossLossR > 0 ? grossProfitR / grossLossR : null;

  const drawdownSeries = calculateDrawdownSeries(modeOutcomes);
  const drawdowns = drawdownSeries.map((point) => point.drawdownR);
  const lastDrawdown = drawdownSeries.at(-1)?.drawdownR ?? null;
  const maximumDrawdownR =
    drawdowns.length > 0 ? Math.min(...drawdowns) : null;

  const streaks = calculateStreaks(modeOutcomes);

  const mfeValues = modeOutcomes
    .map((outcome) =>
      finiteNumber(outcome.maximum_favorable_excursion_r),
    )
    .filter((value): value is number => value !== null);

  const maeValues = modeOutcomes
    .map((outcome) =>
      finiteNumber(outcome.maximum_adverse_excursion_r),
    )
    .filter((value): value is number => value !== null);

  const holdingValues = modeOutcomes
    .map(holdingMinutes)
    .filter((value): value is number => value !== null);

  const grossPnlValues = modeOutcomes
    .map((outcome) => finiteNumber(outcome.gross_pnl_usdt))
    .filter((value): value is number => value !== null);

  const netPnlValues = modeOutcomes
    .map((outcome) => finiteNumber(outcome.net_pnl_usdt))
    .filter((value): value is number => value !== null);

  const feesValues = modeOutcomes
    .map((outcome) => finiteNumber(outcome.fees_usdt))
    .filter((value): value is number => value !== null);

  const slippageValues = modeOutcomes
    .map((outcome) => finiteNumber(outcome.slippage_usdt))
    .filter((value): value is number => value !== null);

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

    winRatePct: percentage(wins, winLossDenominator),
    lossRatePct: percentage(losses, winLossDenominator),

    totalResultR: sum(rValues),
    expectancyR: average(rValues),
    averageWinR: average(winningR),
    averageLossR: average(losingR),
    bestResultR: rValues.length > 0 ? Math.max(...rValues) : null,
    worstResultR: rValues.length > 0 ? Math.min(...rValues) : null,

    grossProfitR,
    grossLossR,
    profitFactor,

    grossPnlUsdt: sum(grossPnlValues),
    netPnlUsdt: sum(netPnlValues),
    feesUsdt: sum(feesValues),
    slippageUsdt: sum(slippageValues),

    maximumDrawdownR,
    currentDrawdownR: lastDrawdown,

    ...streaks,

    averageMfeR: average(mfeValues),
    averageMaeR: average(maeValues),

    averageHoldingMinutes: average(holdingValues),
    medianHoldingMinutes: median(holdingValues),
  };
}

// ---------------------------------------------------------------------------
// Métricas de decisão
// ---------------------------------------------------------------------------

export function calculateEntryDecisionMetrics(
  opportunities: readonly (TradeOpportunity | OpportunityListItem)[],
): EntryDecisionMetrics {
  const entryOpportunities = opportunities.filter(
    (opportunity) => opportunity.opportunity_type === 'entry',
  );

  const accepted = entryOpportunities.filter(
    (opportunity) => opportunity.entry_decision === 'accepted',
  ).length;

  const rejected = entryOpportunities.filter(
    (opportunity) => opportunity.entry_decision === 'rejected',
  ).length;

  const expired = entryOpportunities.filter(
    (opportunity) => opportunity.entry_decision === 'expired',
  ).length;

  const pending = entryOpportunities.filter(
    (opportunity) => opportunity.entry_decision === 'pending',
  ).length;

  const notApplicable = entryOpportunities.filter(
    (opportunity) => opportunity.entry_decision === 'not_applicable',
  ).length;

  const decided = accepted + rejected;

  return {
    totalEntryOpportunities: entryOpportunities.length,
    pending,
    accepted,
    rejected,
    expired,
    notApplicable,

    decided,
    acceptanceRatePct: percentage(accepted, decided),
    rejectionRatePct: percentage(rejected, decided),
    expirationRatePct: percentage(expired, entryOpportunities.length),
  };
}

function outcomesForDecision(
  opportunities: readonly (TradeOpportunity | OpportunityListItem)[],
  outcomeIndex: ReadonlyMap<string, OpportunityOutcome>,
  decision: 'accepted' | 'rejected' | 'expired',
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
      outcomeKey(opportunity.id, 'theoretical'),
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
    (outcome) => classifyOutcomeResult(outcome) === resultClass,
  ).length;
}

export function calculateDecisionQualityMetrics(
  opportunities: readonly (TradeOpportunity | OpportunityListItem)[],
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

  const acceptedWins = countResultClass(accepted, 'win');
  const acceptedLosses = countResultClass(accepted, 'loss');
  const rejectedWins = countResultClass(rejected, 'win');
  const rejectedLosses = countResultClass(rejected, 'loss');
  const expiredWins = countResultClass(expired, 'win');
  const expiredLosses = countResultClass(expired, 'loss');

  const acceptedR = sum(resultRValues(accepted));
  const rejectedR = sum(resultRValues(rejected));
  const expiredR = sum(resultRValues(expired));

  const acceptedConclusive = acceptedWins + acceptedLosses;
  const rejectedConclusive = rejectedWins + rejectedLosses;

  return {
    acceptedWithTheoreticalOutcome: accepted.length,
    rejectedWithTheoreticalOutcome: rejected.length,
    expiredWithTheoreticalOutcome: expired.length,

    acceptedTheoreticalWins: acceptedWins,
    acceptedTheoreticalLosses: acceptedLosses,
    acceptedTheoreticalResultR: acceptedR,
    acceptedTheoreticalWinRatePct: percentage(
      acceptedWins,
      acceptedConclusive,
    ),

    rejectedTheoreticalWins: rejectedWins,
    rejectedTheoreticalLosses: rejectedLosses,
    rejectedTheoreticalResultR: rejectedR,
    rejectedTheoreticalWinRatePct: percentage(
      rejectedWins,
      rejectedConclusive,
    ),

    expiredTheoreticalWins: expiredWins,
    expiredTheoreticalLosses: expiredLosses,
    expiredTheoreticalResultR: expiredR,

    avoidedLosses: rejectedLosses,
    missedWins: rejectedWins,
    rejectedNeutralOrInconclusive:
      rejected.length - rejectedWins - rejectedLosses,

    selectionResultDeltaR:
      accepted.length > 0 && rejected.length > 0
        ? acceptedR / accepted.length - rejectedR / rejected.length
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
    if (isResolvedOutcomeStatus(outcome.status)) {
      ids.add(outcome.opportunity_id);
    }
  }

  return ids.size;
}

export function calculateOpportunityDashboardMetrics(
  input: CalculateOpportunityMetricsInput,
): OpportunityDashboardMetrics {
  const opportunities = [...input.opportunities];
  const outcomes = resolveOutcomes(input);

  const entryDecisions = calculateEntryDecisionMetrics(opportunities);
  const decisionQuality = calculateDecisionQualityMetrics(
    opportunities,
    outcomes,
  );

  const theoretical = calculateOutcomeModeMetrics(
    outcomes,
    'theoretical',
  );

  const executed = calculateOutcomeModeMetrics(outcomes, 'executed');

  const resolvedOpportunities = uniqueResolvedOpportunityCount(outcomes);
  const trackingOpportunities = Math.max(
    0,
    opportunities.length - resolvedOpportunities,
  );

  return {
    totalOpportunities: opportunities.length,
    resolvedOpportunities,
    trackingOpportunities,

    acceptedEntries: entryDecisions.accepted,
    rejectedEntries: entryDecisions.rejected,
    expiredEntries: entryDecisions.expired,
    acceptanceRatePct: entryDecisions.acceptanceRatePct,

    theoreticalWins: theoretical.wins,
    theoreticalLosses: theoretical.losses,
    theoreticalWinRatePct: theoretical.winRatePct,
    theoreticalResultR: theoretical.totalResultR,
    theoreticalExpectancyR: theoretical.expectancyR,
    theoreticalProfitFactor: theoretical.profitFactor,

    executedWins: executed.wins,
    executedLosses: executed.losses,
    executedWinRatePct: executed.winRatePct,
    executedResultR: executed.totalResultR,
    executedNetPnlUsdt: executed.netPnlUsdt,
    executedExpectancyR: executed.expectancyR,
    executedProfitFactor: executed.profitFactor,

    avoidedLosses: decisionQuality.avoidedLosses,
    missedWins: decisionQuality.missedWins,

    // O resumo principal mede a qualidade da estratégia, portanto utiliza
    // a curva teórica completa. A interface também recebe o detalhamento
    // executado separadamente em `executed`.
    maximumDrawdownR: theoretical.maximumDrawdownR,
    maximumConsecutiveWins: theoretical.maximumConsecutiveWins,
    maximumConsecutiveLosses:
      theoretical.maximumConsecutiveLosses,

    entryDecisions,
    decisionQuality,
    theoretical,
    executed,

    unreadOpportunities: opportunities.filter(
      (opportunity) => opportunity.seen_at === null,
    ).length,

    pendingOpportunities: opportunities.filter((opportunity) =>
      ['pending', 'under_review', 'revalidating'].includes(
        opportunity.lifecycle_status,
      ),
    ).length,

    openPositions: opportunities.filter((opportunity) =>
      ['opening', 'open'].includes(opportunity.lifecycle_status),
    ).length,

    pendingExits: opportunities.filter((opportunity) =>
      ['exit_pending', 'closing'].includes(
        opportunity.lifecycle_status,
      ),
    ).length,

    attentionRequired: opportunities.filter(
      (opportunity) =>
        opportunity.lifecycle_status === 'error' ||
        opportunity.severity === 'critical',
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Recortes por dimensão
// ---------------------------------------------------------------------------

function dimensionValue(
  opportunity: TradeOpportunity | OpportunityListItem,
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

function sourceLabel(value: OpportunitySourceType): string {
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

function environmentLabel(value: ExecutionEnvironment): string {
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
    return sourceLabel(value as OpportunitySourceType);
  }

  if (dimension === 'execution_environment') {
    return environmentLabel(value as ExecutionEnvironment);
  }

  return value;
}

export function calculateMetricBreakdown(
  input: CalculateOpportunityMetricsInput,
  dimension: OpportunityMetricDimension,
): OpportunityMetricBreakdownItem[] {
  const outcomes = resolveOutcomes(input);
  const grouped = new Map<
    string,
    (TradeOpportunity | OpportunityListItem)[]
  >();

  for (const opportunity of input.opportunities) {
    const key = dimensionValue(opportunity, dimension);
    const current = grouped.get(key) ?? [];
    current.push(opportunity);
    grouped.set(key, current);
  }

  const outcomeIndex = new Map<UUID, OpportunityOutcome[]>();

  for (const outcome of outcomes) {
    const current = outcomeIndex.get(outcome.opportunity_id) ?? [];
    current.push(outcome);
    outcomeIndex.set(outcome.opportunity_id, current);
  }

  const result: OpportunityMetricBreakdownItem[] = [];

  for (const [key, opportunities] of grouped) {
    const groupOutcomes = opportunities.flatMap(
      (opportunity) => outcomeIndex.get(opportunity.id) ?? [],
    );

    result.push({
      dimension,
      key,
      label: dimensionLabel(dimension, key),
      totalOpportunities: opportunities.length,
      entryDecisions: calculateEntryDecisionMetrics(opportunities),
      theoretical: calculateOutcomeModeMetrics(
        groupOutcomes,
        'theoretical',
      ),
      executed: calculateOutcomeModeMetrics(
        groupOutcomes,
        'executed',
      ),
    });
  }

  return result.sort((left, right) => {
    if (right.totalOpportunities !== left.totalOpportunities) {
      return right.totalOpportunities - left.totalOpportunities;
    }

    return left.label.localeCompare(right.label, 'pt-BR');
  });
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
        outcome.opportunity_id === nextOutcome.opportunity_id &&
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
  return outcomes.filter((outcome) => outcome.id !== outcomeId);
}