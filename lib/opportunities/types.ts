/**
 * lib/opportunities/types.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Contratos compartilhados da Central de Oportunidades.
 *
 * Este arquivo espelha a migração:
 *   supabase/migrations/20260718210000_opportunities_realtime.sql
 *
 * Responsabilidades:
 * - Centralizar os estados aceitos pelo banco.
 * - Tipar oportunidades, decisões, resultados, eventos e ordens vinculadas.
 * - Tipar os argumentos e retornos das RPCs da Central.
 * - Tipar as alterações recebidas pelo Supabase Realtime.
 *
 * Regras importantes:
 * - Este arquivo não consulta o Supabase e não executa ordens.
 * - Valores monetários e percentuais chegam como number pelo PostgREST.
 * - Datas são strings ISO 8601 enquanto permanecem na camada de dados.
 * - Os snapshots JSON preservam o contexto imutável da oportunidade.
 */

// ---------------------------------------------------------------------------
// Tipos JSON e identificadores básicos
// ---------------------------------------------------------------------------

export type UUID = string;
export type ISODateString = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue | undefined };
export type JsonArray = JsonValue[];

type ArrayValue<T extends readonly unknown[]> = T[number];

// ---------------------------------------------------------------------------
// Valores aceitos pelo banco
// ---------------------------------------------------------------------------

export const OPPORTUNITY_SOURCE_TYPES = [
  'daytrade_setup',
  'alert_event',
  'analysis_scenario',
  'position_exit',
  'manual_test',
] as const;

export type OpportunitySourceType = ArrayValue<
  typeof OPPORTUNITY_SOURCE_TYPES
>;

export const OPPORTUNITY_TYPES = ['entry', 'exit'] as const;
export type OpportunityType = ArrayValue<typeof OPPORTUNITY_TYPES>;

export const TRADE_DIRECTIONS = ['long', 'short'] as const;
export type TradeDirection = ArrayValue<typeof TRADE_DIRECTIONS>;

export const OPPORTUNITY_SEVERITIES = [
  'normal',
  'high',
  'critical',
] as const;

export type OpportunitySeverity = ArrayValue<
  typeof OPPORTUNITY_SEVERITIES
>;

export const OPPORTUNITY_LIFECYCLE_STATUSES = [
  'pending',
  'under_review',
  'revalidating',
  'invalidated',
  'expired',
  'rejected',
  'opening',
  'open',
  'exit_pending',
  'closing',
  'closed',
  'error',
] as const;

export type OpportunityLifecycleStatus = ArrayValue<
  typeof OPPORTUNITY_LIFECYCLE_STATUSES
>;

export const OPPORTUNITY_ENTRY_DECISIONS = [
  'pending',
  'accepted',
  'rejected',
  'expired',
  'not_applicable',
] as const;

export type OpportunityEntryDecision = ArrayValue<
  typeof OPPORTUNITY_ENTRY_DECISIONS
>;

export const OPPORTUNITY_EXIT_DECISIONS = [
  'pending',
  'accepted',
  'kept',
  'automatic',
  'not_applicable',
] as const;

export type OpportunityExitDecision = ArrayValue<
  typeof OPPORTUNITY_EXIT_DECISIONS
>;

export const EXECUTION_ENVIRONMENTS = ['none', 'testnet', 'real'] as const;
export type ExecutionEnvironment = ArrayValue<
  typeof EXECUTION_ENVIRONMENTS
>;

export const OPPORTUNITY_DECISION_TYPES = ['entry', 'exit'] as const;
export type OpportunityDecisionType = ArrayValue<
  typeof OPPORTUNITY_DECISION_TYPES
>;

export const OPPORTUNITY_DECISION_VALUES = [
  'accepted',
  'rejected',
  'kept',
  'automatic',
] as const;

export type OpportunityDecisionValue = ArrayValue<
  typeof OPPORTUNITY_DECISION_VALUES
>;

export const OPPORTUNITY_OUTCOME_MODES = [
  'theoretical',
  'executed',
] as const;

export type OpportunityOutcomeMode = ArrayValue<
  typeof OPPORTUNITY_OUTCOME_MODES
>;

export const OPPORTUNITY_OUTCOME_STATUSES = [
  'tracking',
  'target_hit',
  'stop_hit',
  'manual_exit',
  'expired',
  'invalidated',
  'ambiguous',
  'cancelled',
  'error',
] as const;

export type OpportunityOutcomeStatus = ArrayValue<
  typeof OPPORTUNITY_OUTCOME_STATUSES
>;

export const OPPORTUNITY_EVENT_ACTORS = [
  'system',
  'user',
  'edge_function',
  'exchange',
] as const;

export type OpportunityEventActor = ArrayValue<
  typeof OPPORTUNITY_EVENT_ACTORS
>;

export const ORDER_STATUSES = [
  'pendente',
  'entrada_enviada',
  'entrada_executada',
  'protecao_pendente',
  'oco_ativa',
  'entrada_sem_protecao',
  'alvo_executado',
  'stop_executado',
  'cancelada',
  'erro_pre_entrada',
  'erro',
] as const;

export type OrderStatus = ArrayValue<typeof ORDER_STATUSES>;

// ---------------------------------------------------------------------------
// Snapshots preservados em JSONB
// ---------------------------------------------------------------------------

export interface OpportunityPlanSnapshot extends JsonObject {
  direction?: TradeDirection;
  entryReference?: number;
  stopReference?: number;
  targetReference?: number;
  riskPerUnit?: number;
  rewardPerUnit?: number;
  riskRewardRatio?: number;
  stopDistancePct?: number;
  targetDistancePct?: number;
  stopDistanceAtr?: number;
  breakoutLevel?: number;
  breakoutDistancePct?: number;
  latestAcceptableEntry?: number | null;
  confirmationCandleLow?: number;
  structuralStopCandidate?: number;
  atrStopCandidate?: number;
}

export interface DayTradeOpportunitySourceSnapshot extends JsonObject {
  setupId?: UUID;
  status?: string;
  candleOpenTime?: ISODateString;
  candleCloseTime?: ISODateString;
  lastClosedPrice?: number | null;
  lastLivePrice?: number | null;
  nextTrigger?: string | null;
}

export interface OpportunityMarketSnapshot extends JsonObject {
  lastClosedPrice?: number | null;
  lastLivePrice?: number | null;
  indicators?: JsonObject;
  capturedAt?: ISODateString;
  source?: string;
}

export interface OpportunityConditionSnapshot extends JsonObject {
  id?: string;
  label?: string;
  passed?: boolean;
  available?: boolean;
  currentValue?: JsonPrimitive;
  requiredValue?: string;
  explanation?: string;
}

export interface OpportunityMetadata extends JsonObject {
  strategyOptions?: JsonObject;
  createdBy?: string;
  emailSentAt?: ISODateString;
  emailMessageId?: string;
  lastRevalidationAt?: ISODateString;
}

// ---------------------------------------------------------------------------
// Linhas das tabelas da Central de Oportunidades
// ---------------------------------------------------------------------------

export interface TradeOpportunity {
  id: UUID;
  user_id: UUID;

  source_type: OpportunitySourceType;
  source_id: UUID;
  parent_opportunity_id: UUID | null;

  opportunity_type: OpportunityType;
  market: string;
  provider: string;
  symbol: string;
  timeframe: string;
  direction: TradeDirection;
  quote_asset: string;
  severity: OpportunitySeverity;

  strategy: string;
  strategy_version: string;

  lifecycle_status: OpportunityLifecycleStatus;
  entry_decision: OpportunityEntryDecision;
  exit_decision: OpportunityExitDecision;

  execution_environment: ExecutionEnvironment;
  quote_amount: number | null;

  detected_at: ISODateString;
  expires_at: ISODateString | null;
  seen_at: ISODateString | null;
  review_started_at: ISODateString | null;
  accepted_at: ISODateString | null;
  rejected_at: ISODateString | null;
  invalidated_at: ISODateString | null;
  opened_at: ISODateString | null;
  exit_requested_at: ISODateString | null;
  closed_at: ISODateString | null;

  entry_reference: number | null;
  maximum_entry_price: number | null;
  stop_reference: number | null;
  target_reference: number | null;
  gross_risk_reward: number | null;
  estimated_net_risk_reward: number | null;

  score: number | null;
  total_conditions: number | null;

  source_snapshot: DayTradeOpportunitySourceSnapshot | JsonObject;
  market_snapshot: OpportunityMarketSnapshot | JsonObject;
  plan_snapshot: OpportunityPlanSnapshot | JsonObject;
  conditions_snapshot: OpportunityConditionSnapshot[] | JsonArray;
  warnings: string[] | JsonArray;
  metadata: OpportunityMetadata | JsonObject;

  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface OpportunityDecision {
  id: UUID;
  opportunity_id: UUID;
  user_id: UUID;

  decision_type: OpportunityDecisionType;
  decision: OpportunityDecisionValue;
  market_price: number | null;
  reason: string | null;
  metadata: JsonObject;
  request_id: UUID;
  created_at: ISODateString;
}

export interface OpportunityOutcome {
  id: UUID;
  opportunity_id: UUID;
  user_id: UUID;

  mode: OpportunityOutcomeMode;
  status: OpportunityOutcomeStatus;

  entry_price: number | null;
  entry_at: ISODateString | null;
  exit_price: number | null;
  exit_at: ISODateString | null;
  exit_reason: string | null;

  gross_pnl_pct: number | null;
  net_pnl_pct: number | null;
  gross_pnl_usdt: number | null;
  net_pnl_usdt: number | null;
  result_r: number | null;

  fees_usdt: number;
  slippage_usdt: number;

  maximum_favorable_excursion_r: number | null;
  maximum_adverse_excursion_r: number | null;

  target_hit_at: ISODateString | null;
  stop_hit_at: ISODateString | null;
  resolved_at: ISODateString | null;

  metadata: JsonObject;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface OpportunityEvent {
  id: UUID;
  opportunity_id: UUID;
  user_id: UUID;

  event_type: string;
  actor_type: OpportunityEventActor;
  event_data: JsonObject;
  created_at: ISODateString;
}

// ---------------------------------------------------------------------------
// Ordem Binance vinculada à oportunidade
// ---------------------------------------------------------------------------

export interface OpportunityOrder {
  id: UUID;
  user_id: UUID;
  opportunity_id: UUID | null;

  is_testnet: boolean;
  symbol: string;
  quote_amount: number;
  qty: number | null;

  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  exit_price: number | null;

  entry_order_id: number | null;
  oco_list_id: number | null;

  status: OrderStatus;
  erro: string | null;
  raw: JsonObject | null;

  pnl_usdt: number | null;

  request_id: UUID;
  client_order_id: string | null;
  list_client_order_id: string | null;

  criado_em: ISODateString;
  fechado_em: ISODateString | null;
  protected_at: ISODateString | null;
  last_checked_at: ISODateString | null;

  binance_status: string | null;
  unprotected_reason: string | null;
}

// ---------------------------------------------------------------------------
// Modelos compostos usados pela interface
// ---------------------------------------------------------------------------

export interface OpportunityRelations {
  decisions: OpportunityDecision[];
  outcomes: OpportunityOutcome[];
  events: OpportunityEvent[];
  orders: OpportunityOrder[];
}

export interface OpportunityDetails extends OpportunityRelations {
  opportunity: TradeOpportunity;
}

export interface OpportunityListItem extends TradeOpportunity {
  decisions?: OpportunityDecision[];
  outcomes?: OpportunityOutcome[];
  events?: OpportunityEvent[];
  orders?: OpportunityOrder[];
}

export interface OpportunityPerformanceSummary {
  totalOpportunities: number;
  resolvedOpportunities: number;
  trackingOpportunities: number;

  acceptedEntries: number;
  rejectedEntries: number;
  expiredEntries: number;
  acceptanceRatePct: number | null;

  theoreticalWins: number;
  theoreticalLosses: number;
  theoreticalWinRatePct: number | null;
  theoreticalResultR: number;
  theoreticalExpectancyR: number | null;
  theoreticalProfitFactor: number | null;

  executedWins: number;
  executedLosses: number;
  executedWinRatePct: number | null;
  executedResultR: number;
  executedNetPnlUsdt: number;
  executedExpectancyR: number | null;
  executedProfitFactor: number | null;

  avoidedLosses: number;
  missedWins: number;
  maximumDrawdownR: number | null;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
}

// ---------------------------------------------------------------------------
// RPCs públicas da Central
// ---------------------------------------------------------------------------

export interface MarkOpportunitySeenArgs {
  p_opportunity_id: UUID;
}

export interface BeginOpportunityReviewArgs {
  p_opportunity_id: UUID;
}

export interface AcceptOpportunityArgs {
  p_opportunity_id: UUID;
  p_market_price?: number | null;
  p_request_id?: UUID;
}

export interface RejectOpportunityArgs {
  p_opportunity_id: UUID;
  p_reason?: string | null;
  p_market_price?: number | null;
  p_request_id?: UUID;
}

export interface CreateOpportunityFromDayTradeSetupArgs {
  p_setup_id: UUID;
  p_expires_at?: ISODateString | null;
}

export interface OpportunityRpcArgsMap {
  mark_opportunity_seen: MarkOpportunitySeenArgs;
  begin_opportunity_review: BeginOpportunityReviewArgs;
  accept_opportunity: AcceptOpportunityArgs;
  reject_opportunity: RejectOpportunityArgs;
  create_opportunity_from_daytrade_setup: CreateOpportunityFromDayTradeSetupArgs;
}

export interface OpportunityRpcResultMap {
  mark_opportunity_seen: boolean;
  begin_opportunity_review: OpportunityLifecycleStatus;
  accept_opportunity: OpportunityLifecycleStatus;
  reject_opportunity: OpportunityLifecycleStatus;
  create_opportunity_from_daytrade_setup: UUID;
}

export type OpportunityRpcName = keyof OpportunityRpcArgsMap;

// ---------------------------------------------------------------------------
// Supabase Realtime
// ---------------------------------------------------------------------------

export interface OpportunityRealtimeTableMap {
  trade_opportunities: TradeOpportunity;
  opportunity_decisions: OpportunityDecision;
  opportunity_outcomes: OpportunityOutcome;
  opportunity_events: OpportunityEvent;
  orders: OpportunityOrder;
}

export type OpportunityRealtimeTable = keyof OpportunityRealtimeTableMap;
export type OpportunityRealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface OpportunityRealtimeChange<
  TTable extends OpportunityRealtimeTable = OpportunityRealtimeTable,
> {
  schema: 'public';
  table: TTable;
  commit_timestamp: ISODateString;
  eventType: OpportunityRealtimeEventType;
  new: Partial<OpportunityRealtimeTableMap[TTable]>;
  old: Partial<OpportunityRealtimeTableMap[TTable]>;
  errors: string[] | null;
}

// ---------------------------------------------------------------------------
// Filtros e paginação
// ---------------------------------------------------------------------------

export interface OpportunityFilters {
  lifecycleStatuses?: OpportunityLifecycleStatus[];
  opportunityTypes?: OpportunityType[];
  sourceTypes?: OpportunitySourceType[];
  outcomeModes?: OpportunityOutcomeMode[];
  outcomeStatuses?: OpportunityOutcomeStatus[];
  executionEnvironments?: ExecutionEnvironment[];
  symbols?: string[];
  timeframes?: string[];
  strategies?: string[];
  strategyVersions?: string[];
  detectedFrom?: ISODateString;
  detectedTo?: ISODateString;
}

export interface OpportunityPagination {
  limit: number;
  offset: number;
}

export interface OpportunityPageResult {
  items: OpportunityListItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}