/**
 * lib/opportunities/types.ts — VigIA Trade
 * ---------------------------------------------------------------------------
 * Contratos compartilhados da Central de Oportunidades e do gerenciamento
 * auditável de posição.
 *
 * Este arquivo espelha principalmente as migrações:
 *   supabase/migrations/20260718210000_opportunities_realtime.sql
 *   supabase/migrations/20260722010000_position_sizing_risk_management.sql
 *
 * Responsabilidades:
 * - Centralizar os estados aceitos pelo banco.
 * - Tipar oportunidades, decisões, resultados, eventos e ordens vinculadas.
 * - Tipar decisões, snapshots e prévias de dimensionamento de posição.
 * - Tipar os argumentos e retornos das RPCs usadas pela Central.
 * - Tipar as alterações recebidas pelo Supabase Realtime.
 *
 * Regras importantes:
 * - Este arquivo não consulta o Supabase e não executa ordens.
 * - Valores monetários e percentuais chegam como number pelo PostgREST.
 * - Datas são strings ISO 8601 enquanto permanecem na camada de dados.
 * - Os snapshots JSON preservam o contexto imutável da oportunidade e do risco.
 * - Martingale clássico é representado somente por martingale_testnet.
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
// Valores do gerenciamento de posição
// ---------------------------------------------------------------------------

export const POSITION_SIZING_MODES = [
  'fixed',
  'anti_martingale',
  'martingale_testnet',
] as const;

export type PositionSizingMode = ArrayValue<
  typeof POSITION_SIZING_MODES
>;

export const POSITION_SIZING_SCOPES = [
  'account',
  'strategy',
  'symbol',
  'symbol_timeframe',
] as const;

export type PositionSizingScope = ArrayValue<
  typeof POSITION_SIZING_SCOPES
>;

export const POSITION_SIZING_SOURCES = [
  'manual_opportunity',
  'manual_daytrade_testnet',
  'manual_order',
  'auto_trade',
  'system_recovery',
] as const;

export type PositionSizingSource = ArrayValue<
  typeof POSITION_SIZING_SOURCES
>;

export const POSITION_SIZING_STATUSES = [
  'reserved',
  'applied',
  'cancelled',
  'failed',
] as const;

export type PositionSizingStatus = ArrayValue<
  typeof POSITION_SIZING_STATUSES
>;

export const POSITION_SIZING_ENVIRONMENTS = [
  'testnet',
  'real',
] as const;

export type PositionSizingEnvironment = ArrayValue<
  typeof POSITION_SIZING_ENVIRONMENTS
>;

export const POSITION_SIZING_RESULT_CLASSES = [
  'win',
  'loss',
  'neutral',
] as const;

export type PositionSizingResultClass = ArrayValue<
  typeof POSITION_SIZING_RESULT_CLASSES
>;

export const POSITION_SIZING_LIMITING_RULES = [
  'martingale_testnet_only',
  'consecutive_loss_pause',
  'max_order_usdt',
  'balance_usage_limit',
  'available_balance_required',
] as const;

export type KnownPositionSizingLimitingRule = ArrayValue<
  typeof POSITION_SIZING_LIMITING_RULES
>;

/**
 * O banco preserva as regras como JSON para permitir novas restrições sem
 * exigir que a interface seja publicada simultaneamente.
 */
export type PositionSizingLimitingRule =
  | KnownPositionSizingLimitingRule
  | (string & {});

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

export interface PositionSizingPolicySnapshot extends JsonObject {
  sizing_mode?: PositionSizingMode;
  sizing_scope?: PositionSizingScope;
  policy_version?: string;

  base_risk_percent?: number;
  min_risk_percent?: number;
  max_risk_percent?: number;

  win_multiplier?: number;
  loss_multiplier?: number;
  loss_reduction_start?: number;

  martingale_loss_multiplier?: number;
  max_multiplier?: number;
  martingale_max_multiplier?: number;

  max_sequence_steps?: number;
  pause_after_consecutive_losses?: number;

  balance_usage_limit_pct?: number;
  estimated_fee_rate_pct?: number;
  estimated_slippage_pct?: number;
}

export interface PositionSizingSequenceSnapshot extends JsonObject {
  last_result?: PositionSizingResultClass;
  consecutive_wins?: number;
  consecutive_losses?: number;
  streak_length?: number;

  prior_result_source?: string | null;
  prior_outcome_id?: UUID | null;
  prior_journal_id?: UUID | null;
  prior_order_id?: UUID | null;
  prior_net_pnl_usdt?: number | null;
  prior_result_r?: number | null;
  prior_resolved_at?: ISODateString | null;

  inspected_count?: number;
  execution_environment?: PositionSizingEnvironment;
  scope?: PositionSizingScope;

  symbol?: string | null;
  timeframe?: string | null;
  strategy?: string | null;
}

export interface PositionSizingCalculationInput extends JsonObject {
  user_id?: UUID;
  opportunity_id?: UUID | null;
  daytrade_setup_id?: UUID | null;
  auto_trade_attempt_id?: UUID | null;

  source?: PositionSizingSource;
  execution_environment?: PositionSizingEnvironment;

  symbol?: string | null;
  timeframe?: string | null;
  strategy?: string | null;
  strategy_version?: string | null;

  available_balance_usdt?: number | null;
  base_quote_amount?: number | null;
  max_order_usdt?: number;

  entry_reference?: number | null;
  stop_reference?: number | null;
  stop_distance_pct?: number | null;

  sequence?: PositionSizingSequenceSnapshot | JsonObject;
  account_sequence?: PositionSizingSequenceSnapshot | JsonObject;
}

export interface PositionSizingResultSnapshot extends JsonObject {
  request_id?: UUID;
  order_id?: UUID | null;

  requested_quote_amount?: number | null;
  effective_quote_amount?: number | null;

  planned_risk_usdt?: number | null;
  actual_risk_usdt?: number | null;

  entry_price?: number | null;
  stop_price?: number | null;
  target_price?: number | null;

  applied_risk_percent?: number | null;
  sizing_effect_pnl_usdt?: number | null;
  fixed_risk_equivalent_pnl_usdt?: number | null;

  applied_at?: ISODateString | null;
  updated_at?: ISODateString;
}

export interface PositionSizingSnapshot extends JsonObject {
  decision_id?: UUID;
  request_id?: UUID;

  source?: PositionSizingSource;
  status?: PositionSizingStatus;
  execution_environment?: PositionSizingEnvironment;

  sizing_mode?: PositionSizingMode;
  sizing_scope?: PositionSizingScope;
  policy_version?: string;

  base_quote_amount?: number | null;
  available_balance_usdt?: number | null;
  balance_usage_limit_pct?: number;

  base_risk_percent?: number;
  target_risk_percent?: number | null;
  applied_risk_percent?: number | null;
  risk_multiplier?: number;
  sequence_step?: number;

  consecutive_wins?: number;
  consecutive_losses?: number;
  account_consecutive_wins?: number;
  account_consecutive_losses?: number;

  stop_distance_pct?: number;
  estimated_fee_rate_pct?: number;
  estimated_slippage_pct?: number;
  estimated_total_cost_pct?: number;
  estimated_loss_rate_pct?: number;

  planned_risk_usdt?: number | null;
  actual_risk_usdt?: number | null;
  requested_quote_amount?: number | null;
  effective_quote_amount?: number | null;
  max_order_usdt?: number;

  limiting_rules?: PositionSizingLimitingRule[] | JsonArray;

  calculation_input?: PositionSizingCalculationInput | JsonObject;
  policy_snapshot?: PositionSizingPolicySnapshot | JsonObject;
  result_snapshot?: PositionSizingResultSnapshot | JsonObject;

  applied_at?: ISODateString | null;
  created_at?: ISODateString;
  updated_at?: ISODateString;
}

// ---------------------------------------------------------------------------
// Configurações de dimensionamento do usuário
// ---------------------------------------------------------------------------

export interface PositionSizingSettings {
  auto_trade_sizing_mode: PositionSizingMode;
  auto_trade_sizing_scope: PositionSizingScope;

  auto_trade_base_risk_percent: number;
  auto_trade_min_risk_percent: number;
  auto_trade_max_risk_percent: number;

  auto_trade_win_multiplier: number;
  auto_trade_loss_multiplier: number;
  auto_trade_loss_reduction_start: number;

  auto_trade_martingale_loss_multiplier: number;
  auto_trade_max_multiplier: number;
  auto_trade_martingale_max_multiplier: number;

  auto_trade_max_sequence_steps: number;
  auto_trade_pause_after_consecutive_losses: number;

  auto_trade_balance_usage_limit_pct: number;
  auto_trade_estimated_fee_rate_pct: number;
  auto_trade_estimated_slippage_pct: number;

  auto_trade_sizing_policy_version: string;
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

  position_sizing_decision_id: UUID | null;
  sizing_snapshot: PositionSizingSnapshot | JsonObject;

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

  position_sizing_decision_id: UUID | null;
  fixed_risk_equivalent_pnl_usdt: number | null;
  sizing_effect_pnl_usdt: number | null;
  sizing_snapshot: PositionSizingSnapshot | JsonObject;

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
// Decisão auditável de dimensionamento
// ---------------------------------------------------------------------------

export interface PositionSizingDecision {
  id: UUID;
  user_id: UUID;

  opportunity_id: UUID | null;
  daytrade_setup_id: UUID | null;
  daytrade_journal_id: UUID | null;
  auto_trade_attempt_id: UUID | null;
  order_id: UUID | null;

  prior_outcome_id: UUID | null;
  prior_journal_id: UUID | null;
  prior_order_id: UUID | null;

  resolved_outcome_id: UUID | null;
  resolved_journal_id: UUID | null;

  request_id: UUID;

  source: PositionSizingSource;
  status: PositionSizingStatus;
  execution_environment: PositionSizingEnvironment;
  sizing_mode: PositionSizingMode;
  sizing_scope: PositionSizingScope;
  policy_version: string;

  base_quote_amount: number | null;
  available_balance_usdt: number | null;
  balance_usage_limit_pct: number;

  base_risk_percent: number;
  target_risk_percent: number | null;
  applied_risk_percent: number | null;
  risk_multiplier: number;
  sequence_step: number;

  consecutive_wins: number;
  consecutive_losses: number;
  account_consecutive_wins: number;
  account_consecutive_losses: number;

  stop_distance_pct: number;
  estimated_fee_rate_pct: number;
  estimated_slippage_pct: number;
  estimated_total_cost_pct: number;
  estimated_loss_rate_pct: number;

  planned_risk_usdt: number | null;
  actual_risk_usdt: number | null;

  requested_quote_amount: number | null;
  effective_quote_amount: number | null;
  max_order_usdt: number;

  limiting_rules: PositionSizingLimitingRule[] | JsonArray;

  calculation_input: PositionSizingCalculationInput | JsonObject;
  policy_snapshot: PositionSizingPolicySnapshot | JsonObject;
  result_snapshot: PositionSizingResultSnapshot | JsonObject;

  applied_at: ISODateString | null;
  created_at: ISODateString;
  updated_at: ISODateString;
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

  position_sizing_decision_id: UUID | null;
  sizing_mode: PositionSizingMode;
  base_risk_percent: number | null;
  target_risk_percent: number | null;
  applied_risk_percent: number | null;
  risk_multiplier: number;
  planned_risk_usdt: number | null;
  actual_risk_usdt: number | null;
  sizing_snapshot: PositionSizingSnapshot | JsonObject;
}

// ---------------------------------------------------------------------------
// Campos reutilizáveis por outras tabelas
// ---------------------------------------------------------------------------

export interface AutoTradeAttemptPositionSizingFields {
  position_sizing_decision_id: UUID | null;

  sizing_mode: PositionSizingMode;
  sizing_scope: PositionSizingScope;
  sizing_policy_version: string;

  base_risk_percent: number | null;
  target_risk_percent: number | null;
  applied_risk_percent: number | null;
  risk_multiplier: number;
  sequence_step: number;

  consecutive_wins: number;
  consecutive_losses: number;
  account_consecutive_wins: number;
  account_consecutive_losses: number;

  planned_risk_usdt: number | null;
  effective_quote_amount: number | null;

  sizing_snapshot: PositionSizingSnapshot | JsonObject;
}

export interface DayTradeJournalPositionSizingFields {
  position_sizing_decision_id: UUID | null;

  sizing_mode: PositionSizingMode;
  base_risk_percent: number | null;
  applied_risk_percent: number | null;
  risk_multiplier: number;

  fixed_risk_equivalent_pnl_usdt: number | null;
  sizing_effect_pnl_usdt: number | null;

  sizing_snapshot: PositionSizingSnapshot | JsonObject;
}

// ---------------------------------------------------------------------------
// Modelos compostos usados pela interface
// ---------------------------------------------------------------------------

export interface OpportunityRelations {
  decisions: OpportunityDecision[];
  outcomes: OpportunityOutcome[];
  events: OpportunityEvent[];
  orders: OpportunityOrder[];
  positionSizingDecisions?: PositionSizingDecision[];
}

export interface OpportunityDetails extends OpportunityRelations {
  opportunity: TradeOpportunity;
}

export interface OpportunityListItem extends TradeOpportunity {
  decisions?: OpportunityDecision[];
  outcomes?: OpportunityOutcome[];
  events?: OpportunityEvent[];
  orders?: OpportunityOrder[];
  positionSizingDecisions?: PositionSizingDecision[];
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

  /**
   * Campos opcionais enquanto consumidores antigos ainda não calculam o efeito
   * do dimensionamento. O arquivo metrics.ts atualizado passa a preenchê-los.
   */
  executedFixedRiskEquivalentPnlUsdt?: number;
  executedSizingEffectPnlUsdt?: number;

  avoidedLosses: number;
  missedWins: number;
  maximumDrawdownR: number | null;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
}

// ---------------------------------------------------------------------------
// Prévia e snapshots retornados pelas RPCs
// ---------------------------------------------------------------------------

export interface PositionSizingPreview {
  user_id: UUID;
  opportunity_id: UUID;
  source: PositionSizingSource;

  execution_environment: PositionSizingEnvironment;
  sizing_mode: PositionSizingMode;
  sizing_scope: PositionSizingScope;
  policy_version: string;

  symbol: string;
  timeframe: string;
  strategy: string;
  strategy_version: string;

  base_quote_amount: number | null;
  available_balance_usdt: number | null;
  balance_usage_limit_pct: number;
  balance_quote_limit_usdt: number | null;
  max_order_usdt: number;

  base_risk_percent: number;
  min_risk_percent: number;
  max_risk_percent: number;
  target_risk_percent: number | null;
  applied_risk_percent: number | null;

  risk_multiplier: number;
  sequence_step: number;

  consecutive_wins: number;
  consecutive_losses: number;
  account_consecutive_wins: number;
  account_consecutive_losses: number;

  prior_result_source: string | null;
  prior_outcome_id: UUID | null;
  prior_journal_id: UUID | null;
  prior_order_id: UUID | null;
  last_result: PositionSizingResultClass;

  stop_distance_pct: number;
  estimated_fee_rate_pct: number;
  estimated_slippage_pct: number;
  estimated_total_cost_pct: number;
  estimated_loss_rate_pct: number;

  planned_risk_usdt: number | null;
  requested_quote_amount: number | null;
  effective_quote_amount: number | null;

  limiting_rules: PositionSizingLimitingRule[] | JsonArray;

  should_pause: boolean;
  executable: boolean;
  blocked_reason: string | null;

  sequence: PositionSizingSequenceSnapshot | JsonObject;
  account_sequence: PositionSizingSequenceSnapshot | JsonObject;
  policy: PositionSizingPolicySnapshot | JsonObject;

  calculated_at: ISODateString;
}

export interface ReservePositionSizingResult {
  ok: boolean;
  reused?: boolean;
  decision: PositionSizingDecision;
  preview?: PositionSizingPreview | JsonObject;
}

export interface ApplyPositionSizingResult {
  ok: boolean;
  decision: PositionSizingDecision;
  sizing_snapshot: PositionSizingSnapshot | JsonObject;
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

export interface PreviewPositionSizingArgs {
  p_opportunity_id: UUID;
  p_available_balance_usdt?: number | null;
  p_user_id?: UUID | null;
  p_execution_environment?: PositionSizingEnvironment | null;
  p_source?: PositionSizingSource;
}

export interface ReservePositionSizingDecisionArgs {
  p_opportunity_id: UUID;
  p_available_balance_usdt: number;
  p_auto_trade_attempt_id?: UUID | null;
  p_source?: PositionSizingSource;
  p_user_id?: UUID | null;
  p_execution_environment?: PositionSizingEnvironment | null;
}

export interface ApplyPositionSizingDecisionArgs {
  p_decision_id: UUID;
  p_order_id: UUID;
  p_effective_quote_amount: number;
  p_actual_risk_usdt?: number | null;
  p_result_snapshot?: PositionSizingResultSnapshot | JsonObject;
}

export interface OpportunityRpcArgsMap {
  mark_opportunity_seen: MarkOpportunitySeenArgs;
  begin_opportunity_review: BeginOpportunityReviewArgs;
  accept_opportunity: AcceptOpportunityArgs;
  reject_opportunity: RejectOpportunityArgs;
  create_opportunity_from_daytrade_setup: CreateOpportunityFromDayTradeSetupArgs;
  preview_position_sizing: PreviewPositionSizingArgs;
}

export interface OpportunityRpcResultMap {
  mark_opportunity_seen: boolean;
  begin_opportunity_review: OpportunityLifecycleStatus;
  accept_opportunity: OpportunityLifecycleStatus;
  reject_opportunity: OpportunityLifecycleStatus;
  create_opportunity_from_daytrade_setup: UUID;
  preview_position_sizing: PositionSizingPreview;
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
  position_sizing_decisions: PositionSizingDecision;
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

  sizingModes?: PositionSizingMode[];
  sizingScopes?: PositionSizingScope[];
  sizingStatuses?: PositionSizingStatus[];

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
