// ============================================================================
// VigIA Trade — Edge Function: executar-daytrade-testnet v2
// supabase/functions/executar-daytrade-testnet/index.ts
// ============================================================================
// Executa um setup Day Trade persistido exclusivamente na Binance Spot Testnet.
//
// Esta versão integra o fluxo manual da tela Day Trade ao gerenciamento de risco
// sequencial do VigIA, sem depender de arquivos _shared:
// - fixed: usa auto_trade_quote_amount como valor nominal-base;
// - anti_martingale: aumenta após vitórias e reduz após perdas;
// - martingale_testnet: aumenta após perdas, somente em Testnet;
// - calcula custos estimados até o stop antes de definir o valor da compra;
// - considera resultados executados da Central, do diário e de ordens diretas;
// - registra position_sizing_decisions antes de chamar binance-trade;
// - vincula decisão, ordem e daytrade_journal de forma idempotente;
// - bloqueia nova execução quando o limite de perdas consecutivas é alcançado;
// - mantém setup_id como request_id, evitando compra duplicada.
//
// Segurança:
// - publique com verify_jwt = true;
// - o usuário sempre é obtido do JWT;
// - chaves e saldo são consultados por binance-trade, nunca enviados pelo cliente;
// - esta função recusa contas reais e nunca habilita negociação real;
// - preview é o comportamento padrão;
// - execute exige confirm_testnet=true;
// - o limite absoluto de risco desta rota manual permanece em 2%.
// ============================================================================

import {
  createClient,
  type SupabaseClient,
} from 'jsr:@supabase/supabase-js@2';

// ============================================================================
// Tipos
// ============================================================================

type Action = 'preview' | 'execute';
type Timeframe = '5m' | '15m' | '30m' | '1h';
type PositionSizingMode =
  | 'fixed'
  | 'anti_martingale'
  | 'martingale_testnet';
type PositionSizingScope =
  | 'account'
  | 'strategy'
  | 'symbol'
  | 'symbol_timeframe';
type DecisionStatus = 'reserved' | 'applied' | 'cancelled' | 'failed';

type JsonRecord = Record<string, unknown>;

interface RequestBody {
  action?: unknown;
  setup_id?: unknown;
  risk_percent?: unknown;
  confirm_testnet?: unknown;
}

interface DayTradeSetup {
  id: string;
  user_id: string;
  symbol: string;
  timeframe: Timeframe;
  strategy: string;
  strategy_version: string;
  status: string;
  score: number;
  total_conditions: number;
  indicators: JsonRecord | null;
  plan: JsonRecord | null;
  entry_reference: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  risk_reward_ratio: number | string | null;
  candle_open_time: string;
  candle_close_time: string;
  last_closed_price: number | string | null;
  last_live_price: number | string | null;
}

interface UserSettingsRow {
  max_order_usdt: number | string | null;
  min_stop_pct: number | string | null;
  max_stop_pct: number | string | null;
  min_target_pct: number | string | null;
  max_target_pct: number | string | null;
  auto_trade_quote_amount: number | string | null;
  auto_trade_sizing_mode: string | null;
  auto_trade_sizing_scope: string | null;
  auto_trade_base_risk_percent: number | string | null;
  auto_trade_min_risk_percent: number | string | null;
  auto_trade_max_risk_percent: number | string | null;
  auto_trade_win_multiplier: number | string | null;
  auto_trade_loss_multiplier: number | string | null;
  auto_trade_loss_reduction_start: number | string | null;
  auto_trade_martingale_loss_multiplier: number | string | null;
  auto_trade_max_multiplier: number | string | null;
  auto_trade_martingale_max_multiplier: number | string | null;
  auto_trade_max_sequence_steps: number | string | null;
  auto_trade_pause_after_consecutive_losses: number | string | null;
  auto_trade_balance_usage_limit_pct: number | string | null;
  auto_trade_estimated_fee_rate_pct: number | string | null;
  auto_trade_estimated_slippage_pct: number | string | null;
  auto_trade_sizing_policy_version: string | null;
  auto_trade_paused_at: string | null;
  auto_trade_pause_reason: string | null;
}

interface ResolvedSizingPolicy {
  mode: PositionSizingMode;
  scope: PositionSizingScope;
  policyVersion: string;
  fixedQuoteAmount: number;
  maxOrderUsdt: number;
  baseRiskPercent: number;
  configuredBaseRiskPercent: number;
  manualRiskCapPercent: number | null;
  minimumRiskPercent: number;
  maximumRiskPercent: number;
  winMultiplier: number;
  lossMultiplier: number;
  lossReductionStart: number;
  martingaleLossMultiplier: number;
  maximumMultiplier: number;
  martingaleMaximumMultiplier: number;
  maximumSequenceSteps: number;
  pauseAfterConsecutiveLosses: number;
  balanceUsageLimitPct: number;
  estimatedFeeRatePct: number;
  estimatedSlippagePct: number;
  warnings: string[];
}

interface BinanceBalance {
  asset: string;
  free: string | number;
  locked: string | number;
}

interface ConnectionResponse {
  ok?: boolean;
  is_testnet?: boolean;
  balances?: BinanceBalance[];
  error?: string;
  code?: string;
}

interface SymbolRules {
  minNotional: number;
  maxNotional: number;
}

interface SequenceSnapshot {
  lastResult: 'win' | 'loss' | 'neutral';
  consecutiveWins: number;
  consecutiveLosses: number;
  streakLength: number;
  priorResultSource: string | null;
  priorOutcomeId: string | null;
  priorJournalId: string | null;
  priorOrderId: string | null;
  priorNetPnlUsdt: number | null;
  priorResultR: number | null;
  priorResolvedAt: string | null;
  inspectedCount: number;
  executionEnvironment: 'testnet';
  scope: PositionSizingScope;
  symbol: string;
  timeframe: string;
  strategy: string;
  raw: JsonRecord;
}

interface PositionSizingPreview {
  executable: boolean;
  blockedReason: string | null;
  errors: string[];
  warnings: string[];
  mode: PositionSizingMode;
  scope: PositionSizingScope;
  policyVersion: string;
  baseQuoteAmount: number;
  availableBalanceUsdt: number;
  totalBalanceUsdt: number;
  balanceUsageLimitPct: number;
  balanceQuoteLimitUsdt: number;
  maxOrderUsdt: number;
  exchangeMinNotionalUsdt: number;
  exchangeMaxNotionalUsdt: number;
  baseRiskPercent: number;
  configuredBaseRiskPercent: number;
  manualRiskCapPercent: number | null;
  targetRiskPercent: number;
  appliedRiskPercent: number;
  riskMultiplier: number;
  rawRiskMultiplier: number;
  sequenceStep: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  accountConsecutiveWins: number;
  accountConsecutiveLosses: number;
  stopDistancePct: number;
  targetDistancePct: number;
  grossRiskRewardRatio: number;
  estimatedFeeRatePct: number;
  estimatedSlippagePct: number;
  estimatedRoundTripFeePct: number;
  estimatedRoundTripSlippagePct: number;
  estimatedTotalCostPct: number;
  estimatedLossRatePct: number;
  maximumRiskUsdt: number;
  plannedRiskUsdt: number;
  requestedQuoteAmount: number;
  effectiveQuoteAmount: number;
  quoteAmountUsdt: number;
  estimatedQuantity: number;
  estimatedPriceRiskUsdt: number;
  estimatedFeesAtStopUsdt: number;
  estimatedSlippageAtStopUsdt: number;
  estimatedTotalRiskUsdt: number;
  estimatedTotalRiskPct: number;
  limitedBy:
    | 'fixed_quote'
    | 'risk'
    | 'available_balance'
    | 'configured_order_limit'
    | 'exchange_notional_limit'
    | 'none';
  limitingRules: string[];
  shouldPause: boolean;
  sequence: SequenceSnapshot;
  accountSequence: SequenceSnapshot;
  policy: ResolvedSizingPolicy;
  calculatedAt: string;
}

interface JournalRecord {
  id: string;
  order_id: string | null;
  status: string;
  metadata: JsonRecord | null;
  position_sizing_decision_id: string | null;
  sizing_mode: PositionSizingMode | null;
  base_risk_percent: number | string | null;
  applied_risk_percent: number | string | null;
  risk_multiplier: number | string | null;
  sizing_snapshot: JsonRecord | null;
}

interface OrderRecord {
  id: string;
  user_id: string;
  opportunity_id: string | null;
  is_testnet: boolean;
  symbol: string;
  status: string;
  qty: number | string | null;
  entry_price: number | string | null;
  stop_price: number | string | null;
  target_price: number | string | null;
  quote_amount: number | string;
  pnl_usdt: number | string | null;
  erro: string | null;
  criado_em: string;
  fechado_em: string | null;
  request_id: string;
  position_sizing_decision_id: string | null;
  sizing_mode: PositionSizingMode | null;
  base_risk_percent: number | string | null;
  target_risk_percent: number | string | null;
  applied_risk_percent: number | string | null;
  risk_multiplier: number | string | null;
  planned_risk_usdt: number | string | null;
  actual_risk_usdt: number | string | null;
  sizing_snapshot: JsonRecord | null;
}

interface PositionSizingDecisionRecord {
  id: string;
  user_id: string;
  opportunity_id: string | null;
  daytrade_setup_id: string | null;
  daytrade_journal_id: string | null;
  auto_trade_attempt_id: string | null;
  order_id: string | null;
  prior_outcome_id: string | null;
  prior_journal_id: string | null;
  prior_order_id: string | null;
  request_id: string;
  source: string;
  status: DecisionStatus;
  execution_environment: 'testnet' | 'real';
  sizing_mode: PositionSizingMode;
  sizing_scope: PositionSizingScope;
  policy_version: string;
  base_quote_amount: number | string | null;
  available_balance_usdt: number | string | null;
  balance_usage_limit_pct: number | string;
  base_risk_percent: number | string;
  target_risk_percent: number | string | null;
  applied_risk_percent: number | string | null;
  risk_multiplier: number | string;
  sequence_step: number | string;
  consecutive_wins: number | string;
  consecutive_losses: number | string;
  account_consecutive_wins: number | string;
  account_consecutive_losses: number | string;
  stop_distance_pct: number | string;
  estimated_fee_rate_pct: number | string;
  estimated_slippage_pct: number | string;
  estimated_total_cost_pct: number | string;
  estimated_loss_rate_pct: number | string;
  planned_risk_usdt: number | string | null;
  actual_risk_usdt: number | string | null;
  requested_quote_amount: number | string | null;
  effective_quote_amount: number | string | null;
  max_order_usdt: number | string;
  limiting_rules: unknown;
  calculation_input: JsonRecord | null;
  policy_snapshot: JsonRecord | null;
  result_snapshot: JsonRecord | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

interface BinanceInvocationResult {
  transportOk: boolean;
  status: number | null;
  payload: JsonRecord;
  error: string | null;
}

interface AuditApplicationResult {
  ok: boolean;
  rpcApplied: boolean;
  fallbackApplied: boolean;
  error: string | null;
}

// ============================================================================
// Configuração
// ============================================================================

const FUNCTION_VERSION = '2.0.0';
const MAX_BODY_BYTES = 16_384;
const FETCH_TIMEOUT_MS = 10_000;
const BINANCE_TRADE_TIMEOUT_MS = 30_000;
const SETUP_GRACE_MS = 30_000;
const LATE_ENTRY_ATR_MULTIPLIER = 0.5;
const ABSOLUTE_MANUAL_RISK_LIMIT_PCT = 2;

const PUBLIC_MARKET_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const TESTNET_BASE = 'https://testnet.binance.vision';

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

const DEFAULTS = {
  maxOrderUsdt: 100,
  minStopPct: 0.2,
  maxStopPct: 15,
  minTargetPct: 0.2,
  maxTargetPct: 50,
  fixedQuoteAmount: 25,
  mode: 'fixed' as PositionSizingMode,
  scope: 'strategy' as PositionSizingScope,
  baseRiskPercent: 0.5,
  minimumRiskPercent: 0.25,
  maximumRiskPercent: 1,
  winMultiplier: 1.25,
  lossMultiplier: 0.5,
  lossReductionStart: 2,
  martingaleLossMultiplier: 2,
  maximumMultiplier: 1.5,
  martingaleMaximumMultiplier: 4,
  maximumSequenceSteps: 2,
  pauseAfterConsecutiveLosses: 3,
  balanceUsageLimitPct: 95,
  estimatedFeeRatePct: 0.1,
  estimatedSlippagePct: 0.05,
  policyVersion: '1.0.0',
} as const;

const ALLOWED_BODY_FIELDS = new Set([
  'action',
  'setup_id',
  'risk_percent',
  'confirm_testnet',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-idempotency-key, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SETTINGS_SELECT = [
  'max_order_usdt',
  'min_stop_pct',
  'max_stop_pct',
  'min_target_pct',
  'max_target_pct',
  'auto_trade_quote_amount',
  'auto_trade_sizing_mode',
  'auto_trade_sizing_scope',
  'auto_trade_base_risk_percent',
  'auto_trade_min_risk_percent',
  'auto_trade_max_risk_percent',
  'auto_trade_win_multiplier',
  'auto_trade_loss_multiplier',
  'auto_trade_loss_reduction_start',
  'auto_trade_martingale_loss_multiplier',
  'auto_trade_max_multiplier',
  'auto_trade_martingale_max_multiplier',
  'auto_trade_max_sequence_steps',
  'auto_trade_pause_after_consecutive_losses',
  'auto_trade_balance_usage_limit_pct',
  'auto_trade_estimated_fee_rate_pct',
  'auto_trade_estimated_slippage_pct',
  'auto_trade_sizing_policy_version',
  'auto_trade_paused_at',
  'auto_trade_pause_reason',
].join(',');

const JOURNAL_SELECT = [
  'id',
  'order_id',
  'status',
  'metadata',
  'position_sizing_decision_id',
  'sizing_mode',
  'base_risk_percent',
  'applied_risk_percent',
  'risk_multiplier',
  'sizing_snapshot',
].join(',');

const ORDER_SELECT = [
  'id',
  'user_id',
  'opportunity_id',
  'is_testnet',
  'symbol',
  'status',
  'qty',
  'entry_price',
  'stop_price',
  'target_price',
  'quote_amount',
  'pnl_usdt',
  'erro',
  'criado_em',
  'fechado_em',
  'request_id',
  'position_sizing_decision_id',
  'sizing_mode',
  'base_risk_percent',
  'target_risk_percent',
  'applied_risk_percent',
  'risk_multiplier',
  'planned_risk_usdt',
  'actual_risk_usdt',
  'sizing_snapshot',
].join(',');

const DECISION_SELECT = [
  'id',
  'user_id',
  'opportunity_id',
  'daytrade_setup_id',
  'daytrade_journal_id',
  'auto_trade_attempt_id',
  'order_id',
  'prior_outcome_id',
  'prior_journal_id',
  'prior_order_id',
  'request_id',
  'source',
  'status',
  'execution_environment',
  'sizing_mode',
  'sizing_scope',
  'policy_version',
  'base_quote_amount',
  'available_balance_usdt',
  'balance_usage_limit_pct',
  'base_risk_percent',
  'target_risk_percent',
  'applied_risk_percent',
  'risk_multiplier',
  'sequence_step',
  'consecutive_wins',
  'consecutive_losses',
  'account_consecutive_wins',
  'account_consecutive_losses',
  'stop_distance_pct',
  'estimated_fee_rate_pct',
  'estimated_slippage_pct',
  'estimated_total_cost_pct',
  'estimated_loss_rate_pct',
  'planned_risk_usdt',
  'actual_risk_usdt',
  'requested_quote_amount',
  'effective_quote_amount',
  'max_order_usdt',
  'limiting_rules',
  'calculation_input',
  'policy_snapshot',
  'result_snapshot',
  'applied_at',
  'created_at',
  'updated_at',
].join(',');

// ============================================================================
// Erros e respostas
// ============================================================================

class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function errorResponse(
  status: number,
  error: string,
  code: string,
  details?: unknown,
): Response {
  return jsonResponse(
    {
      ok: false,
      error,
      code,
      ...(details === undefined ? {} : { details }),
    },
    status,
  );
}

// ============================================================================
// Utilitários
// ============================================================================

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = finite(value);
  if (parsed === null || !Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function numberInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = finite(value);
  if (parsed === null) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function floorMoney(value: number): number {
  return Math.floor((value + Number.EPSILON) * 100) / 100;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function truncate(value: unknown, maximumLength: number): string {
  const text = String(value ?? '');
  return text.length <= maximumLength
    ? text
    : `${text.slice(0, maximumLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Erro interno.');
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
}

function parseUuid(value: unknown, field: string): string {
  const normalized = asString(value)?.toLowerCase() ?? '';
  if (!isUuid(normalized)) {
    throw new RequestError(
      400,
      'INVALID_UUID',
      `${field} possui formato UUID inválido.`,
      { field },
    );
  }
  return normalized;
}

function parseAction(value: unknown): Action {
  if (value === undefined || value === null || value === '') return 'preview';
  if (value === 'preview' || value === 'execute') return value;
  throw new RequestError(
    400,
    'INVALID_ACTION',
    'action deve ser preview ou execute.',
  );
}

function parseOptionalRiskCap(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = finite(value);
  if (
    parsed === null ||
    parsed <= 0 ||
    parsed > ABSOLUTE_MANUAL_RISK_LIMIT_PCT
  ) {
    throw new RequestError(
      400,
      'INVALID_RISK_PERCENT',
      `risk_percent deve ser maior que zero e no máximo ${ABSOLUTE_MANUAL_RISK_LIMIT_PCT}%.`,
    );
  }
  return parsed;
}

function parseConfirmation(value: unknown): boolean {
  return value === true;
}

function isTimeframe(value: string): value is Timeframe {
  return value === '5m' || value === '15m' || value === '30m' || value === '1h';
}

function parseSizingMode(value: unknown): PositionSizingMode {
  return value === 'fixed' ||
      value === 'anti_martingale' ||
      value === 'martingale_testnet'
    ? value
    : DEFAULTS.mode;
}

function parseSizingScope(value: unknown): PositionSizingScope {
  return value === 'account' ||
      value === 'strategy' ||
      value === 'symbol' ||
      value === 'symbol_timeframe'
    ? value
    : DEFAULTS.scope;
}

function assertAllowedBodyFields(body: RequestBody): void {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_FIELDS.has(key)) {
      throw new RequestError(
        400,
        'UNSUPPORTED_FIELD',
        `Campo não suportado: ${key}.`,
      );
    }
  }
}

async function readBody(req: Request): Promise<RequestBody> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      'BODY_TOO_LARGE',
      'Corpo da requisição excede o limite permitido.',
    );
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RequestError(
      413,
      'BODY_TOO_LARGE',
      'Corpo da requisição excede o limite permitido.',
    );
  }

  if (!text.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RequestError(400, 'INVALID_JSON', 'JSON inválido.');
  }

  if (!isRecord(parsed)) {
    throw new RequestError(
      400,
      'INVALID_BODY',
      'O corpo da requisição deve ser um objeto JSON.',
    );
  }

  const body = parsed as RequestBody;
  assertAllowedBodyFields(body);
  return body;
}

// ============================================================================
// HTTP Binance e chamada interna
// ============================================================================

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchWithTimeout(url, init);
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text.slice(0, 300) };
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`,
    );
  }

  return payload;
}

async function fetchPublicPrice(symbol: string): Promise<{
  price: number;
  source: string;
}> {
  const errors: string[] = [];

  for (const base of PUBLIC_MARKET_BASES) {
    const url = new URL('/api/v3/ticker/price', base);
    url.searchParams.set('symbol', symbol);

    try {
      const payload = asRecord(await fetchJson(url.toString()));
      const price = positive(payload.price);
      if (price === null) throw new Error('Preço público inválido.');
      return { price, source: base };
    } catch (error) {
      errors.push(`${base}: ${errorMessage(error)}`);
    }
  }

  throw new RequestError(
    502,
    'PUBLIC_PRICE_UNAVAILABLE',
    'Não foi possível consultar o preço público.',
    { attempts: errors },
  );
}

async function fetchTestnetPrice(symbol: string): Promise<number> {
  const url = new URL('/api/v3/ticker/price', TESTNET_BASE);
  url.searchParams.set('symbol', symbol);
  const payload = asRecord(await fetchJson(url.toString()));
  const price = positive(payload.price);
  if (price === null) {
    throw new RequestError(
      502,
      'INVALID_TESTNET_PRICE',
      'A Binance Testnet retornou um preço inválido.',
    );
  }
  return price;
}

async function fetchTestnetSymbolRules(symbol: string): Promise<SymbolRules> {
  const url = new URL('/api/v3/exchangeInfo', TESTNET_BASE);
  url.searchParams.set('symbol', symbol);

  const payload = asRecord(await fetchJson(url.toString()));
  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  const market = isRecord(symbols[0]) ? symbols[0] : null;

  if (!market) {
    throw new RequestError(
      409,
      'TESTNET_SYMBOL_NOT_FOUND',
      'O par não existe na Binance Spot Testnet.',
    );
  }

  if (market.status !== 'TRADING' || market.isSpotTradingAllowed !== true) {
    throw new RequestError(
      409,
      'TESTNET_SYMBOL_NOT_TRADING',
      'O par está indisponível para negociação Spot na Testnet.',
    );
  }

  if (market.quoteAsset !== 'USDT') {
    throw new RequestError(
      409,
      'UNSUPPORTED_QUOTE_ASSET',
      'Somente pares cotados em USDT são aceitos.',
    );
  }

  const filters = Array.isArray(market.filters) ? market.filters : [];
  const notional = filters
    .map(asRecord)
    .find((filter) =>
      filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL'
    );

  return {
    minNotional: positive(notional?.minNotional) ?? 5,
    maxNotional: positive(notional?.maxNotional) ?? Number.MAX_SAFE_INTEGER,
  };
}

async function invokeBinanceTrade(options: {
  supabaseUrl: string;
  anonKey: string;
  authorization: string;
  requestId: string;
  body: JsonRecord;
}): Promise<BinanceInvocationResult> {
  try {
    const response = await fetchWithTimeout(
      `${options.supabaseUrl.replace(/\/$/, '')}/functions/v1/binance-trade`,
      {
        method: 'POST',
        headers: {
          Authorization: options.authorization,
          apikey: options.anonKey,
          'Content-Type': 'application/json',
          'x-client-info': `vigia-executar-daytrade-testnet/${FUNCTION_VERSION}`,
          'x-idempotency-key': options.requestId,
          'x-request-id': crypto.randomUUID(),
        },
        body: JSON.stringify(options.body),
      },
      BINANCE_TRADE_TIMEOUT_MS,
    );

    const text = await response.text();
    let payload: JsonRecord;

    try {
      const parsed = text ? JSON.parse(text) : {};
      payload = isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      payload = { error: text.slice(0, 1_000) };
    }

    return {
      transportOk: true,
      status: response.status,
      payload,
      error: null,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    const message = aborted
      ? 'O motor binance-trade não respondeu dentro do tempo limite.'
      : `Falha de rede ao chamar binance-trade: ${errorMessage(error)}`;

    return {
      transportOk: false,
      status: null,
      payload: {
        ok: false,
        code: aborted ? 'BINANCE_TRADE_TIMEOUT' : 'BINANCE_TRADE_NETWORK_ERROR',
        error: message,
        execution_status_unknown: true,
      },
      error: message,
    };
  }
}

// ============================================================================
// Setup e mercado
// ============================================================================

function readIndicatorNumber(
  indicators: JsonRecord | null,
  key: string,
): number | null {
  if (!indicators) return null;
  return positive(indicators[key]);
}

function readPlanNumber(plan: JsonRecord | null, key: string): number | null {
  if (!plan) return null;
  return positive(plan[key]);
}

function validateSetupFreshness(setup: DayTradeSetup): {
  ageMs: number;
  expiresAt: string;
} {
  if (!isTimeframe(setup.timeframe)) {
    throw new RequestError(
      409,
      'UNSUPPORTED_TIMEFRAME',
      'O timeframe salvo no setup não é suportado.',
    );
  }

  const closeTime = Date.parse(setup.candle_close_time);
  if (!Number.isFinite(closeTime)) {
    throw new RequestError(
      409,
      'INVALID_SETUP_TIME',
      'O horário de fechamento do setup é inválido.',
    );
  }

  const now = Date.now();
  const ageMs = now - closeTime;
  const maximumAge = TIMEFRAME_MS[setup.timeframe] + SETUP_GRACE_MS;

  if (ageMs < -SETUP_GRACE_MS) {
    throw new RequestError(
      409,
      'SETUP_FROM_FUTURE',
      'O setup possui horário de fechamento no futuro.',
    );
  }

  if (ageMs > maximumAge) {
    throw new RequestError(
      409,
      'SETUP_EXPIRED',
      'O setup venceu. Gere uma nova avaliação antes de executar a operação.',
      { expires_at: new Date(closeTime + maximumAge).toISOString() },
    );
  }

  return {
    ageMs: Math.max(0, ageMs),
    expiresAt: new Date(closeTime + maximumAge).toISOString(),
  };
}

function validateCurrentMarket(
  setup: DayTradeSetup,
  publicPrice: number,
  entry: number,
  stop: number,
  target: number,
): {
  atr: number;
  breakoutLevel: number;
  latestAcceptableEntry: number;
} {
  const atr =
    readIndicatorNumber(setup.indicators, 'atr') ??
    readPlanNumber(setup.plan, 'atr');
  const breakoutLevel =
    readIndicatorNumber(setup.indicators, 'breakout_level') ??
    readPlanNumber(setup.plan, 'breakoutLevel');
  const savedLatestAcceptableEntry =
    readPlanNumber(setup.plan, 'latestAcceptableEntry');

  if (atr === null) {
    throw new RequestError(
      409,
      'MISSING_ATR',
      'O setup não possui ATR válido para verificar atraso.',
    );
  }

  if (breakoutLevel === null) {
    throw new RequestError(
      409,
      'MISSING_BREAKOUT_LEVEL',
      'O setup não possui nível de rompimento válido.',
    );
  }

  const latestAcceptableEntry =
    savedLatestAcceptableEntry ?? entry + atr * LATE_ENTRY_ATR_MULTIPLIER;

  if (publicPrice <= stop) {
    throw new RequestError(
      409,
      'SETUP_INVALIDATED',
      'O preço atual já atingiu ou rompeu a invalidação do setup.',
    );
  }

  if (publicPrice <= breakoutLevel) {
    throw new RequestError(
      409,
      'BREAKOUT_LOST',
      'O preço atual retornou para baixo do nível de rompimento do setup.',
    );
  }

  if (publicPrice >= target) {
    throw new RequestError(
      409,
      'TARGET_ALREADY_REACHED',
      'O preço atual já atingiu ou ultrapassou o alvo planejado.',
    );
  }

  if (publicPrice > latestAcceptableEntry) {
    throw new RequestError(
      409,
      'LATE_ENTRY',
      'A entrada está atrasada: o preço atual ultrapassou o limite permitido.',
      { latest_acceptable_entry: latestAcceptableEntry },
    );
  }

  return { atr, breakoutLevel, latestAcceptableEntry };
}

function validateSetupPlan(setup: DayTradeSetup): {
  entry: number;
  stop: number;
  target: number;
  savedRiskReward: number;
} {
  const entry = positive(setup.entry_reference);
  const stop = positive(setup.stop_reference);
  const target = positive(setup.target_reference);
  const savedRiskReward = positive(setup.risk_reward_ratio);

  if (
    entry === null ||
    stop === null ||
    target === null ||
    savedRiskReward === null ||
    !(stop < entry && target > entry)
  ) {
    throw new RequestError(
      409,
      'INVALID_SAVED_PLAN',
      'O plano salvo possui relação inválida entre entrada, stop e alvo.',
    );
  }

  return { entry, stop, target, savedRiskReward };
}

// ============================================================================
// Política e sequência
// ============================================================================

function resolveSizingPolicy(
  settings: Partial<UserSettingsRow>,
  manualRiskCapPercent: number | null,
): ResolvedSizingPolicy {
  const warnings: string[] = [];
  const mode = parseSizingMode(settings.auto_trade_sizing_mode);
  const scope = parseSizingScope(settings.auto_trade_sizing_scope);

  const configuredBaseRiskPercent = numberInRange(
    settings.auto_trade_base_risk_percent,
    DEFAULTS.baseRiskPercent,
    0.01,
    10,
  );

  const configuredMaximum = numberInRange(
    settings.auto_trade_max_risk_percent,
    DEFAULTS.maximumRiskPercent,
    configuredBaseRiskPercent,
    10,
  );

  const maximumRiskPercent = Math.min(
    configuredMaximum,
    ABSOLUTE_MANUAL_RISK_LIMIT_PCT,
  );

  if (configuredMaximum > ABSOLUTE_MANUAL_RISK_LIMIT_PCT) {
    warnings.push(
      `A rota manual Testnet limita o risco a ${ABSOLUTE_MANUAL_RISK_LIMIT_PCT}%, mesmo que a política geral permita mais.`,
    );
  }

  let baseRiskPercent = Math.min(
    configuredBaseRiskPercent,
    maximumRiskPercent,
  );

  if (manualRiskCapPercent !== null && manualRiskCapPercent < baseRiskPercent) {
    baseRiskPercent = manualRiskCapPercent;
    warnings.push(
      `O risk_percent informado reduziu o risco-base desta execução para ${round(baseRiskPercent, 4)}%.`,
    );
  } else if (
    manualRiskCapPercent !== null &&
    manualRiskCapPercent > configuredBaseRiskPercent
  ) {
    warnings.push(
      'O risk_percent informado não pode elevar o risco acima da política salva; ele funciona somente como teto manual.',
    );
  }

  const configuredMinimum = numberInRange(
    settings.auto_trade_min_risk_percent,
    DEFAULTS.minimumRiskPercent,
    0.01,
    baseRiskPercent,
  );

  const minimumRiskPercent = Math.min(configuredMinimum, baseRiskPercent);

  if (mode === 'martingale_testnet') {
    warnings.push(
      'Martingale clássico permanece experimental e é permitido apenas na Testnet.',
    );
  }

  return {
    mode,
    scope,
    policyVersion:
      asString(settings.auto_trade_sizing_policy_version) ??
      DEFAULTS.policyVersion,
    fixedQuoteAmount:
      positive(settings.auto_trade_quote_amount) ?? DEFAULTS.fixedQuoteAmount,
    maxOrderUsdt:
      positive(settings.max_order_usdt) ?? DEFAULTS.maxOrderUsdt,
    baseRiskPercent,
    configuredBaseRiskPercent,
    manualRiskCapPercent,
    minimumRiskPercent,
    maximumRiskPercent: Math.max(baseRiskPercent, maximumRiskPercent),
    winMultiplier: numberInRange(
      settings.auto_trade_win_multiplier,
      DEFAULTS.winMultiplier,
      1,
      3,
    ),
    lossMultiplier: numberInRange(
      settings.auto_trade_loss_multiplier,
      DEFAULTS.lossMultiplier,
      0.01,
      1,
    ),
    lossReductionStart: integerInRange(
      settings.auto_trade_loss_reduction_start,
      DEFAULTS.lossReductionStart,
      1,
      10,
    ),
    martingaleLossMultiplier: numberInRange(
      settings.auto_trade_martingale_loss_multiplier,
      DEFAULTS.martingaleLossMultiplier,
      1,
      3,
    ),
    maximumMultiplier: numberInRange(
      settings.auto_trade_max_multiplier,
      DEFAULTS.maximumMultiplier,
      1,
      10,
    ),
    martingaleMaximumMultiplier: numberInRange(
      settings.auto_trade_martingale_max_multiplier,
      DEFAULTS.martingaleMaximumMultiplier,
      1,
      64,
    ),
    maximumSequenceSteps: integerInRange(
      settings.auto_trade_max_sequence_steps,
      DEFAULTS.maximumSequenceSteps,
      0,
      10,
    ),
    pauseAfterConsecutiveLosses: integerInRange(
      settings.auto_trade_pause_after_consecutive_losses,
      DEFAULTS.pauseAfterConsecutiveLosses,
      0,
      20,
    ),
    balanceUsageLimitPct: numberInRange(
      settings.auto_trade_balance_usage_limit_pct,
      DEFAULTS.balanceUsageLimitPct,
      0.01,
      100,
    ),
    estimatedFeeRatePct: numberInRange(
      settings.auto_trade_estimated_fee_rate_pct,
      DEFAULTS.estimatedFeeRatePct,
      0,
      5,
    ),
    estimatedSlippagePct: numberInRange(
      settings.auto_trade_estimated_slippage_pct,
      DEFAULTS.estimatedSlippagePct,
      0,
      5,
    ),
    warnings,
  };
}

function normalizeSequenceSnapshot(
  value: unknown,
  fallback: {
    scope: PositionSizingScope;
    symbol: string;
    timeframe: string;
    strategy: string;
  },
): SequenceSnapshot {
  const row = asRecord(value);
  const lastResultValue = asString(row.last_result);
  const lastResult =
    lastResultValue === 'win' ||
      lastResultValue === 'loss' ||
      lastResultValue === 'neutral'
      ? lastResultValue
      : 'neutral';

  const scope = parseSizingScope(row.scope ?? fallback.scope);

  return {
    lastResult,
    consecutiveWins: integerInRange(row.consecutive_wins, 0, 0, 1_000),
    consecutiveLosses: integerInRange(row.consecutive_losses, 0, 0, 1_000),
    streakLength: integerInRange(row.streak_length, 0, 0, 1_000),
    priorResultSource: asString(row.prior_result_source),
    priorOutcomeId: isUuid(row.prior_outcome_id) ? row.prior_outcome_id : null,
    priorJournalId: isUuid(row.prior_journal_id) ? row.prior_journal_id : null,
    priorOrderId: isUuid(row.prior_order_id) ? row.prior_order_id : null,
    priorNetPnlUsdt: finite(row.prior_net_pnl_usdt),
    priorResultR: finite(row.prior_result_r),
    priorResolvedAt: asString(row.prior_resolved_at),
    inspectedCount: integerInRange(row.inspected_count, 0, 0, 100_000),
    executionEnvironment: 'testnet',
    scope,
    symbol: asString(row.symbol) ?? fallback.symbol,
    timeframe: asString(row.timeframe) ?? fallback.timeframe,
    strategy: asString(row.strategy) ?? fallback.strategy,
    raw: row,
  };
}

async function loadSequenceSnapshot(
  admin: SupabaseClient,
  options: {
    userId: string;
    scope: PositionSizingScope;
    symbol: string;
    timeframe: string;
    strategy: string;
  },
): Promise<SequenceSnapshot> {
  const { data, error } = await admin.rpc(
    'position_sizing_sequence_snapshot',
    {
      p_user_id: options.userId,
      p_execution_environment: 'testnet',
      p_scope: options.scope,
      p_symbol: options.symbol,
      p_timeframe: options.timeframe,
      p_strategy: options.strategy,
    },
  );

  if (error) {
    throw new RequestError(
      500,
      'POSITION_SIZING_MIGRATION_REQUIRED',
      'Não foi possível carregar a sequência de risco. Aplique a migration de position sizing antes desta Edge Function.',
      { message: error.message },
    );
  }

  return normalizeSequenceSnapshot(data, {
    scope: options.scope,
    symbol: options.symbol,
    timeframe: options.timeframe,
    strategy: options.strategy,
  });
}

async function loadSizingSequences(
  admin: SupabaseClient,
  options: {
    userId: string;
    policy: ResolvedSizingPolicy;
    setup: DayTradeSetup;
  },
): Promise<{
  sequence: SequenceSnapshot;
  accountSequence: SequenceSnapshot;
}> {
  const [sequence, accountSequence] = await Promise.all([
    loadSequenceSnapshot(admin, {
      userId: options.userId,
      scope: options.policy.scope,
      symbol: options.setup.symbol,
      timeframe: options.setup.timeframe,
      strategy: options.setup.strategy,
    }),
    options.policy.scope === 'account'
      ? loadSequenceSnapshot(admin, {
          userId: options.userId,
          scope: 'account',
          symbol: options.setup.symbol,
          timeframe: options.setup.timeframe,
          strategy: options.setup.strategy,
        })
      : loadSequenceSnapshot(admin, {
          userId: options.userId,
          scope: 'account',
          symbol: options.setup.symbol,
          timeframe: options.setup.timeframe,
          strategy: options.setup.strategy,
        }),
  ]);

  return { sequence, accountSequence };
}

function calculatePolicySizing(options: {
  policy: ResolvedSizingPolicy;
  sequence: SequenceSnapshot;
  accountSequence: SequenceSnapshot;
  totalBalanceUsdt: number;
  availableBalanceUsdt: number;
  entryReference: number;
  stopReference: number;
  targetReference: number;
  currentTestnetPrice: number;
  minNotionalUsdt: number;
  maxNotionalUsdt: number;
}): PositionSizingPreview {
  const {
    policy,
    sequence,
    accountSequence,
    totalBalanceUsdt,
    availableBalanceUsdt,
    entryReference,
    stopReference,
    targetReference,
    currentTestnetPrice,
    minNotionalUsdt,
    maxNotionalUsdt,
  } = options;

  const errors: string[] = [];
  const warnings = [...policy.warnings];
  const limitingRules: string[] = [];

  if (!(totalBalanceUsdt > 0)) {
    errors.push('O saldo total em USDT deve ser maior que zero.');
  }

  if (!(availableBalanceUsdt > 0)) {
    errors.push('O saldo livre em USDT deve ser maior que zero.');
  }

  if (availableBalanceUsdt > totalBalanceUsdt + 0.00000001) {
    errors.push('O saldo livre não pode superar o saldo total.');
  }

  const stopDistancePct =
    ((entryReference - stopReference) / entryReference) * 100;
  const targetDistancePct =
    ((targetReference - entryReference) / entryReference) * 100;
  const grossRiskRewardRatio = targetDistancePct / stopDistancePct;

  const estimatedRoundTripFeePct = policy.estimatedFeeRatePct * 2;
  const estimatedRoundTripSlippagePct = policy.estimatedSlippagePct * 2;
  const estimatedTotalCostPct =
    estimatedRoundTripFeePct + estimatedRoundTripSlippagePct;
  const estimatedLossRatePct = stopDistancePct + estimatedTotalCostPct;

  if (!(estimatedLossRatePct > 0)) {
    errors.push('A taxa de perda estimada até o stop deve ser maior que zero.');
  }

  let rawRiskMultiplier = 1;
  let sequenceStep = 0;

  if (policy.mode === 'anti_martingale') {
    if (sequence.consecutiveWins > 0) {
      sequenceStep = Math.min(
        sequence.consecutiveWins,
        policy.maximumSequenceSteps,
      );
      rawRiskMultiplier = Math.min(
        Math.pow(policy.winMultiplier, sequenceStep),
        policy.maximumMultiplier,
      );
    } else if (
      sequence.consecutiveLosses >= policy.lossReductionStart
    ) {
      sequenceStep = Math.min(
        sequence.consecutiveLosses - policy.lossReductionStart + 1,
        policy.maximumSequenceSteps,
      );
      rawRiskMultiplier = Math.max(
        Math.pow(policy.lossMultiplier, sequenceStep),
        policy.minimumRiskPercent / policy.baseRiskPercent,
      );
    }
  } else if (
    policy.mode === 'martingale_testnet' &&
    sequence.consecutiveLosses > 0
  ) {
    sequenceStep = Math.min(
      sequence.consecutiveLosses,
      policy.maximumSequenceSteps,
    );
    rawRiskMultiplier = Math.min(
      Math.pow(policy.martingaleLossMultiplier, sequenceStep),
      policy.martingaleMaximumMultiplier,
    );
  }

  const targetRiskPercent = policy.mode === 'fixed'
    ? policy.baseRiskPercent
    : clamp(
        policy.baseRiskPercent * rawRiskMultiplier,
        policy.minimumRiskPercent,
        policy.maximumRiskPercent,
      );

  const riskMultiplier = policy.baseRiskPercent > 0
    ? targetRiskPercent / policy.baseRiskPercent
    : 1;

  const shouldPause =
    policy.pauseAfterConsecutiveLosses > 0 &&
    accountSequence.consecutiveLosses >=
      policy.pauseAfterConsecutiveLosses;

  if (shouldPause) {
    errors.push(
      `A conta atingiu ${accountSequence.consecutiveLosses} perdas consecutivas e exige pausa antes de uma nova execução.`,
    );
    limitingRules.push('consecutive_loss_pause');
  }

  const balanceQuoteLimitUsdt =
    availableBalanceUsdt * (policy.balanceUsageLimitPct / 100);
  const exchangeMax = Number.isFinite(maxNotionalUsdt)
    ? maxNotionalUsdt
    : Number.MAX_SAFE_INTEGER;

  const maximumRiskUsdt =
    availableBalanceUsdt * (targetRiskPercent / 100);

  const requestedQuoteAmount = policy.mode === 'fixed'
    ? policy.fixedQuoteAmount
    : maximumRiskUsdt / (estimatedLossRatePct / 100);

  const caps = [
    {
      name: 'available_balance' as const,
      value: balanceQuoteLimitUsdt,
      rule: 'balance_usage_limit',
    },
    {
      name: 'configured_order_limit' as const,
      value: policy.maxOrderUsdt,
      rule: 'max_order_usdt',
    },
    {
      name: 'exchange_notional_limit' as const,
      value: exchangeMax,
      rule: 'exchange_max_notional',
    },
  ];

  let effectiveQuoteAmount = requestedQuoteAmount;
  let limitedBy: PositionSizingPreview['limitedBy'] =
    policy.mode === 'fixed' ? 'fixed_quote' : 'risk';

  for (const cap of caps) {
    if (effectiveQuoteAmount > cap.value) {
      effectiveQuoteAmount = cap.value;
      limitedBy = cap.name;
      limitingRules.push(cap.rule);
    }
  }

  effectiveQuoteAmount = floorMoney(Math.max(0, effectiveQuoteAmount));

  if (effectiveQuoteAmount < minNotionalUsdt) {
    errors.push(
      `O valor calculado de ${effectiveQuoteAmount.toFixed(2)} USDT é menor que o mínimo de ${minNotionalUsdt.toFixed(2)} USDT.`,
    );
    limitingRules.push('exchange_min_notional');
  }

  if (effectiveQuoteAmount > availableBalanceUsdt) {
    errors.push('O valor calculado supera o saldo livre em USDT.');
  }

  const estimatedQuantity =
    currentTestnetPrice > 0
      ? effectiveQuoteAmount / currentTestnetPrice
      : 0;
  const estimatedPriceRiskUsdt =
    effectiveQuoteAmount * (stopDistancePct / 100);
  const estimatedFeesAtStopUsdt =
    effectiveQuoteAmount * (estimatedRoundTripFeePct / 100);
  const estimatedSlippageAtStopUsdt =
    effectiveQuoteAmount * (estimatedRoundTripSlippagePct / 100);
  const estimatedTotalRiskUsdt =
    estimatedPriceRiskUsdt +
    estimatedFeesAtStopUsdt +
    estimatedSlippageAtStopUsdt;
  const estimatedTotalRiskPct =
    availableBalanceUsdt > 0
      ? (estimatedTotalRiskUsdt / availableBalanceUsdt) * 100
      : 0;
  const appliedRiskPercent = estimatedTotalRiskPct;

  if (
    policy.mode !== 'fixed' &&
    estimatedTotalRiskUsdt > maximumRiskUsdt + 0.01
  ) {
    errors.push('O risco estimado ultrapassou o orçamento máximo da operação.');
  }

  if (grossRiskRewardRatio < 2) {
    warnings.push(
      `A relação risco/retorno bruta é ${grossRiskRewardRatio.toFixed(2)}:1, abaixo da referência de 2:1.`,
    );
  }

  if (limitedBy === 'available_balance') {
    warnings.push('O valor foi limitado pelo percentual utilizável do saldo livre.');
  } else if (limitedBy === 'configured_order_limit') {
    warnings.push('O valor foi limitado pelo máximo por ordem configurado.');
  } else if (limitedBy === 'exchange_notional_limit') {
    warnings.push('O valor foi limitado pelo máximo nocional informado pela Binance.');
  }

  if (policy.mode === 'fixed') {
    warnings.push(
      'Modo fixed: o valor-base vem de auto_trade_quote_amount; o risco percentual exibido é consequência do stop e dos custos.',
    );
  }

  const blockedReason = shouldPause
    ? 'CONSECUTIVE_LOSS_PAUSE_REQUIRED'
    : errors.length > 0
      ? 'POSITION_SIZING_BLOCKED'
      : null;

  return {
    executable: errors.length === 0,
    blockedReason,
    errors,
    warnings: uniqueStrings(warnings),
    mode: policy.mode,
    scope: policy.scope,
    policyVersion: policy.policyVersion,
    baseQuoteAmount: round(policy.fixedQuoteAmount),
    availableBalanceUsdt: round(availableBalanceUsdt),
    totalBalanceUsdt: round(totalBalanceUsdt),
    balanceUsageLimitPct: round(policy.balanceUsageLimitPct),
    balanceQuoteLimitUsdt: round(balanceQuoteLimitUsdt),
    maxOrderUsdt: round(policy.maxOrderUsdt),
    exchangeMinNotionalUsdt: round(minNotionalUsdt),
    exchangeMaxNotionalUsdt: exchangeMax,
    baseRiskPercent: round(policy.baseRiskPercent),
    configuredBaseRiskPercent: round(policy.configuredBaseRiskPercent),
    manualRiskCapPercent: policy.manualRiskCapPercent,
    targetRiskPercent: round(targetRiskPercent),
    appliedRiskPercent: round(appliedRiskPercent),
    riskMultiplier: round(riskMultiplier),
    rawRiskMultiplier: round(rawRiskMultiplier),
    sequenceStep,
    consecutiveWins: sequence.consecutiveWins,
    consecutiveLosses: sequence.consecutiveLosses,
    accountConsecutiveWins: accountSequence.consecutiveWins,
    accountConsecutiveLosses: accountSequence.consecutiveLosses,
    stopDistancePct: round(stopDistancePct),
    targetDistancePct: round(targetDistancePct),
    grossRiskRewardRatio: round(grossRiskRewardRatio),
    estimatedFeeRatePct: round(policy.estimatedFeeRatePct),
    estimatedSlippagePct: round(policy.estimatedSlippagePct),
    estimatedRoundTripFeePct: round(estimatedRoundTripFeePct),
    estimatedRoundTripSlippagePct: round(estimatedRoundTripSlippagePct),
    estimatedTotalCostPct: round(estimatedTotalCostPct),
    estimatedLossRatePct: round(estimatedLossRatePct),
    maximumRiskUsdt: round(maximumRiskUsdt),
    plannedRiskUsdt: round(estimatedTotalRiskUsdt),
    requestedQuoteAmount: round(requestedQuoteAmount),
    effectiveQuoteAmount: round(effectiveQuoteAmount),
    quoteAmountUsdt: round(effectiveQuoteAmount),
    estimatedQuantity: round(estimatedQuantity, 12),
    estimatedPriceRiskUsdt: round(estimatedPriceRiskUsdt),
    estimatedFeesAtStopUsdt: round(estimatedFeesAtStopUsdt),
    estimatedSlippageAtStopUsdt: round(estimatedSlippageAtStopUsdt),
    estimatedTotalRiskUsdt: round(estimatedTotalRiskUsdt),
    estimatedTotalRiskPct: round(estimatedTotalRiskPct),
    limitedBy,
    limitingRules: uniqueStrings(limitingRules),
    shouldPause,
    sequence,
    accountSequence,
    policy,
    calculatedAt: new Date().toISOString(),
  };
}

async function pauseAutoTradeForLossGuard(
  admin: SupabaseClient,
  userId: string,
  sizing: PositionSizingPreview,
): Promise<void> {
  if (!sizing.shouldPause) return;

  const reason = truncate(
    `Pausa automática: ${sizing.accountConsecutiveLosses} perdas consecutivas na conta Testnet; limite configurado ${sizing.policy.pauseAfterConsecutiveLosses}.`,
    1_000,
  );

  const { error } = await admin
    .from('user_settings')
    .update({
      auto_trade_paused_at: new Date().toISOString(),
      auto_trade_pause_reason: reason,
      auto_trade_last_error: reason,
      auto_trade_updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId);

  if (error) {
    console.error('Falha ao registrar pausa por perdas consecutivas:', error);
  }
}

// ============================================================================
// Persistência: diário, decisão e ordem
// ============================================================================

async function findJournal(
  client: SupabaseClient,
  userId: string,
  setupId: string,
): Promise<JournalRecord | null> {
  const { data, error } = await client
    .from('daytrade_journal')
    .select(JOURNAL_SELECT)
    .eq('user_id', userId)
    .eq('setup_id', setupId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'DAYTRADE_JOURNAL_UNAVAILABLE',
      'Não foi possível acessar daytrade_journal. Aplique as migrations antes desta Edge Function.',
      { message: error.message },
    );
  }

  return data as JournalRecord | null;
}

async function findOrderByRequestId(
  client: SupabaseClient,
  userId: string,
  requestId: string,
): Promise<OrderRecord | null> {
  const { data, error } = await client
    .from('orders')
    .select(ORDER_SELECT)
    .eq('user_id', userId)
    .eq('request_id', requestId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'ORDER_LOOKUP_FAILED',
      'Não foi possível consultar a ordem idempotente.',
      { message: error.message },
    );
  }

  return data as OrderRecord | null;
}

async function findDecisionBySetup(
  admin: SupabaseClient,
  userId: string,
  setupId: string,
): Promise<PositionSizingDecisionRecord | null> {
  const { data, error } = await admin
    .from('position_sizing_decisions')
    .select(DECISION_SELECT)
    .eq('user_id', userId)
    .eq('daytrade_setup_id', setupId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'POSITION_SIZING_MIGRATION_REQUIRED',
      'Não foi possível acessar position_sizing_decisions. Aplique a migration de position sizing antes desta Edge Function.',
      { message: error.message },
    );
  }

  return data as PositionSizingDecisionRecord | null;
}

async function saveJournalBeforeExecution(options: {
  admin: SupabaseClient;
  existing: JournalRecord | null;
  payload: JsonRecord;
}): Promise<JournalRecord> {
  const query = options.existing
    ? options.admin
        .from('daytrade_journal')
        .update(options.payload)
        .eq('id', options.existing.id)
    : options.admin
        .from('daytrade_journal')
        .insert(options.payload);

  const { data, error } = await query
    .select(JOURNAL_SELECT)
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new RequestError(
        409,
        'JOURNAL_ALREADY_EXISTS',
        'Este setup já está registrado no diário.',
      );
    }
    throw new RequestError(
      500,
      'JOURNAL_WRITE_FAILED',
      'Falha ao registrar o diário antes da execução.',
      { message: error.message },
    );
  }

  return data as JournalRecord;
}

function decisionSnapshot(
  setup: DayTradeSetup,
  sizing: PositionSizingPreview,
  market: {
    publicPrice: number;
    publicSource: string;
    testnetPrice: number;
    latestAcceptableEntry: number;
  },
): JsonRecord {
  return {
    source: 'executar-daytrade-testnet',
    version: FUNCTION_VERSION,
    setup: {
      id: setup.id,
      symbol: setup.symbol,
      timeframe: setup.timeframe,
      strategy: setup.strategy,
      strategy_version: setup.strategy_version,
      candle_close_time: setup.candle_close_time,
    },
    market: {
      public_price: market.publicPrice,
      public_source: market.publicSource,
      testnet_price: market.testnetPrice,
      latest_acceptable_entry: market.latestAcceptableEntry,
    },
    sizing,
  };
}

async function reserveDirectSizingDecision(options: {
  admin: SupabaseClient;
  userId: string;
  setup: DayTradeSetup;
  journalId: string;
  sizing: PositionSizingPreview;
  marketSnapshot: JsonRecord;
}): Promise<PositionSizingDecisionRecord> {
  const existing = await findDecisionBySetup(
    options.admin,
    options.userId,
    options.setup.id,
  );

  if (existing) {
    if (existing.status === 'cancelled' || existing.status === 'failed') {
      throw new RequestError(
        409,
        'POSITION_SIZING_DECISION_NOT_REUSABLE',
        'A decisão de risco deste setup foi encerrada e não pode ser reutilizada. Gere um novo setup.',
        { decision_id: existing.id, status: existing.status },
      );
    }
    return existing;
  }

  const sizing = options.sizing;
  const calculationInput: JsonRecord = {
    source: 'manual_daytrade_testnet',
    setup_id: options.setup.id,
    available_balance_usdt: sizing.availableBalanceUsdt,
    total_balance_usdt: sizing.totalBalanceUsdt,
    current_testnet_price: options.marketSnapshot.testnet_price ?? null,
    manual_risk_cap_percent: sizing.manualRiskCapPercent,
  };

  const payload = {
    user_id: options.userId,
    opportunity_id: null,
    daytrade_setup_id: options.setup.id,
    daytrade_journal_id: options.journalId,
    auto_trade_attempt_id: null,
    order_id: null,
    prior_outcome_id: sizing.sequence.priorOutcomeId,
    prior_journal_id: sizing.sequence.priorJournalId,
    prior_order_id: sizing.sequence.priorOrderId,
    request_id: options.setup.id,
    source: 'manual_daytrade_testnet',
    status: 'reserved',
    execution_environment: 'testnet',
    sizing_mode: sizing.mode,
    sizing_scope: sizing.scope,
    policy_version: sizing.policyVersion,
    base_quote_amount: sizing.baseQuoteAmount,
    available_balance_usdt: sizing.availableBalanceUsdt,
    balance_usage_limit_pct: sizing.balanceUsageLimitPct,
    base_risk_percent: sizing.baseRiskPercent,
    target_risk_percent: sizing.targetRiskPercent,
    applied_risk_percent: sizing.appliedRiskPercent,
    risk_multiplier: sizing.riskMultiplier,
    sequence_step: sizing.sequenceStep,
    consecutive_wins: sizing.consecutiveWins,
    consecutive_losses: sizing.consecutiveLosses,
    account_consecutive_wins: sizing.accountConsecutiveWins,
    account_consecutive_losses: sizing.accountConsecutiveLosses,
    stop_distance_pct: sizing.stopDistancePct,
    estimated_fee_rate_pct: sizing.estimatedFeeRatePct,
    estimated_slippage_pct: sizing.estimatedSlippagePct,
    estimated_total_cost_pct: sizing.estimatedTotalCostPct,
    estimated_loss_rate_pct: sizing.estimatedLossRatePct,
    planned_risk_usdt: sizing.plannedRiskUsdt,
    actual_risk_usdt: null,
    requested_quote_amount: sizing.requestedQuoteAmount,
    effective_quote_amount: sizing.effectiveQuoteAmount,
    max_order_usdt: sizing.maxOrderUsdt,
    limiting_rules: sizing.limitingRules,
    calculation_input: calculationInput,
    policy_snapshot: {
      ...options.marketSnapshot,
      sizing,
      decision_source: 'manual_daytrade_testnet',
      reserved_at: new Date().toISOString(),
    },
    result_snapshot: {},
  };

  const { data, error } = await options.admin
    .from('position_sizing_decisions')
    .insert(payload)
    .select(DECISION_SELECT)
    .single();

  if (error) {
    if (error.code === '23505') {
      const concurrent = await findDecisionBySetup(
        options.admin,
        options.userId,
        options.setup.id,
      );
      if (concurrent) return concurrent;
    }

    throw new RequestError(
      500,
      'POSITION_SIZING_RESERVATION_FAILED',
      'Não foi possível reservar a decisão de risco antes da ordem.',
      { message: error.message },
    );
  }

  const decision = data as PositionSizingDecisionRecord;

  const { error: journalLinkError } = await options.admin
    .from('daytrade_journal')
    .update({
      position_sizing_decision_id: decision.id,
      sizing_mode: decision.sizing_mode,
      base_risk_percent: decision.base_risk_percent,
      applied_risk_percent: decision.applied_risk_percent,
      risk_multiplier: decision.risk_multiplier,
      sizing_snapshot: decision.policy_snapshot ?? {},
    })
    .eq('id', options.journalId)
    .eq('user_id', options.userId);

  if (journalLinkError) {
    await options.admin
      .from('position_sizing_decisions')
      .update({
        status: 'failed',
        result_snapshot: {
          stage: 'journal_link_failed',
          message: journalLinkError.message,
          failed_at: new Date().toISOString(),
        },
      })
      .eq('id', decision.id);

    throw new RequestError(
      500,
      'POSITION_SIZING_JOURNAL_LINK_FAILED',
      'A decisão foi reservada, mas não pôde ser vinculada ao diário.',
      { decision_id: decision.id, message: journalLinkError.message },
    );
  }

  return decision;
}

function journalStatusFromOrder(status: string | undefined): string {
  switch (status) {
    case 'oco_ativa':
    case 'entrada_executada':
    case 'protecao_pendente':
      return 'aberta';
    case 'alvo_executado':
      return 'alvo_executado';
    case 'stop_executado':
      return 'stop_executado';
    case 'cancelada':
      return 'cancelada';
    case 'erro':
    case 'erro_pre_entrada':
    case 'entrada_sem_protecao':
      return 'erro';
    default:
      return 'ordem_enviada';
  }
}

function estimateActualRiskAtStop(
  order: OrderRecord,
  sizing: PositionSizingPreview,
): number {
  const quoteAmount = positive(order.quote_amount) ?? sizing.effectiveQuoteAmount;
  const entryPrice = positive(order.entry_price);
  const stopPrice = positive(order.stop_price);
  const actualStopDistancePct =
    entryPrice !== null && stopPrice !== null && stopPrice < entryPrice
      ? ((entryPrice - stopPrice) / entryPrice) * 100
      : sizing.stopDistancePct;

  return round(
    quoteAmount *
      ((actualStopDistancePct + sizing.estimatedTotalCostPct) / 100),
  );
}

async function updateJournalAfterInvocation(options: {
  admin: SupabaseClient;
  userId: string;
  journal: JournalRecord;
  order: OrderRecord | null;
  decision: PositionSizingDecisionRecord;
  sizing: PositionSizingPreview;
  invocation: BinanceInvocationResult;
  metadata: JsonRecord;
}): Promise<string | null> {
  const resultingStatus = journalStatusFromOrder(options.order?.status);
  const priorMetadata = asRecord(options.journal.metadata);
  const update: JsonRecord = {
    status: resultingStatus,
    order_id: options.order?.id ?? null,
    position_sizing_decision_id: options.decision.id,
    sizing_mode: options.decision.sizing_mode,
    base_risk_percent: options.decision.base_risk_percent,
    applied_risk_percent: options.decision.applied_risk_percent,
    risk_multiplier: options.decision.risk_multiplier,
    sizing_snapshot: options.decision.policy_snapshot ?? {},
    metadata: {
      ...priorMetadata,
      ...options.metadata,
      binance_trade_http_status: options.invocation.status,
      binance_trade_transport_ok: options.invocation.transportOk,
      binance_trade_response: options.invocation.payload,
      binance_trade_error: options.invocation.error,
      resulting_order_status: options.order?.status ?? null,
      position_sizing_decision_id: options.decision.id,
    },
  };

  if (
    resultingStatus === 'aberta' &&
    positive(options.order?.entry_price) !== null
  ) {
    update.aberto_em = new Date().toISOString();
    update.entry_price = Number(options.order?.entry_price);
    update.quantity = positive(options.order?.qty);
  }

  if (resultingStatus === 'erro') {
    update.notes = truncate(
      options.order?.erro ??
        options.invocation.payload.error ??
        options.invocation.error ??
        'Falha ao executar na Testnet.',
      5_000,
    );
  }

  if (!options.order && options.invocation.payload.execution_status_unknown === true) {
    update.status = 'ordem_enviada';
    update.notes = truncate(
      'O resultado da solicitação não foi confirmado. Não repita com outro setup_id; a reconciliação deve reutilizar o mesmo request_id.',
      5_000,
    );
  }

  const { error } = await options.admin
    .from('daytrade_journal')
    .update(update)
    .eq('id', options.journal.id)
    .eq('user_id', options.userId);

  if (error) {
    console.error('Falha ao atualizar diário após execução:', error);
    return error.message;
  }

  return null;
}

async function applyDecisionToOrder(options: {
  admin: SupabaseClient;
  userId: string;
  journalId: string;
  decision: PositionSizingDecisionRecord;
  order: OrderRecord;
  sizing: PositionSizingPreview;
}): Promise<AuditApplicationResult> {
  const actualRiskUsdt = estimateActualRiskAtStop(options.order, options.sizing);
  const effectiveQuoteAmount =
    positive(options.order.quote_amount) ?? options.sizing.effectiveQuoteAmount;
  const resultSnapshot = {
    stage: 'manual_daytrade_testnet_order_recorded',
    applied_by: 'executar-daytrade-testnet',
    applied_at: new Date().toISOString(),
    order_status: options.order.status,
    entry_price: positive(options.order.entry_price),
    stop_price: positive(options.order.stop_price),
    target_price: positive(options.order.target_price),
    quantity: positive(options.order.qty),
    effective_quote_amount: effectiveQuoteAmount,
    actual_risk_usdt: actualRiskUsdt,
  };

  const { error: journalLinkError } = await options.admin
    .from('daytrade_journal')
    .update({
      order_id: options.order.id,
      position_sizing_decision_id: options.decision.id,
    })
    .eq('id', options.journalId)
    .eq('user_id', options.userId);

  if (journalLinkError) {
    console.error('Falha ao vincular ordem ao diário antes da RPC:', journalLinkError);
  }

  const { error: rpcError } = await options.admin.rpc(
    'apply_position_sizing_decision',
    {
      p_decision_id: options.decision.id,
      p_order_id: options.order.id,
      p_effective_quote_amount: effectiveQuoteAmount,
      p_actual_risk_usdt: actualRiskUsdt,
      p_result_snapshot: resultSnapshot,
    },
  );

  if (!rpcError) {
    return {
      ok: true,
      rpcApplied: true,
      fallbackApplied: false,
      error: journalLinkError?.message ?? null,
    };
  }

  console.error('Falha na RPC apply_position_sizing_decision:', rpcError);

  const sizingSnapshot = {
    ...asRecord(options.decision.policy_snapshot),
    decision_id: options.decision.id,
    effective_quote_amount: effectiveQuoteAmount,
    actual_risk_usdt: actualRiskUsdt,
    applied_at: new Date().toISOString(),
  };

  const [orderUpdate, decisionUpdate, journalUpdate] = await Promise.all([
    options.admin
      .from('orders')
      .update({
        position_sizing_decision_id: options.decision.id,
        sizing_mode: options.decision.sizing_mode,
        base_risk_percent: options.decision.base_risk_percent,
        target_risk_percent: options.decision.target_risk_percent,
        applied_risk_percent: options.decision.applied_risk_percent,
        risk_multiplier: options.decision.risk_multiplier,
        planned_risk_usdt: options.decision.planned_risk_usdt,
        actual_risk_usdt: actualRiskUsdt,
        sizing_snapshot: sizingSnapshot,
      })
      .eq('id', options.order.id)
      .eq('user_id', options.userId),
    options.admin
      .from('position_sizing_decisions')
      .update({
        status: 'applied',
        order_id: options.order.id,
        daytrade_journal_id: options.journalId,
        effective_quote_amount: effectiveQuoteAmount,
        actual_risk_usdt: actualRiskUsdt,
        result_snapshot: {
          ...asRecord(options.decision.result_snapshot),
          ...resultSnapshot,
          rpc_fallback: true,
          rpc_error: rpcError.message,
        },
        applied_at: options.decision.applied_at ?? new Date().toISOString(),
      })
      .eq('id', options.decision.id)
      .eq('user_id', options.userId),
    options.admin
      .from('daytrade_journal')
      .update({
        order_id: options.order.id,
        position_sizing_decision_id: options.decision.id,
        sizing_mode: options.decision.sizing_mode,
        base_risk_percent: options.decision.base_risk_percent,
        applied_risk_percent: options.decision.applied_risk_percent,
        risk_multiplier: options.decision.risk_multiplier,
        sizing_snapshot: sizingSnapshot,
      })
      .eq('id', options.journalId)
      .eq('user_id', options.userId),
  ]);

  const fallbackErrors = [
    orderUpdate.error?.message,
    decisionUpdate.error?.message,
    journalUpdate.error?.message,
  ].filter((value): value is string => Boolean(value));

  return {
    ok: fallbackErrors.length === 0,
    rpcApplied: false,
    fallbackApplied: fallbackErrors.length === 0,
    error: fallbackErrors.length > 0
      ? fallbackErrors.join(' | ')
      : rpcError.message,
  };
}

async function markDecisionAfterFailure(options: {
  admin: SupabaseClient;
  decision: PositionSizingDecisionRecord;
  invocation: BinanceInvocationResult;
  order: OrderRecord | null;
}): Promise<void> {
  if (options.order) return;

  const executionUnknown =
    options.invocation.payload.execution_status_unknown === true ||
    !options.invocation.transportOk ||
    (options.invocation.status !== null && options.invocation.status >= 500);

  const existingSnapshot = asRecord(options.decision.result_snapshot);
  const patch: JsonRecord = {
    result_snapshot: {
      ...existingSnapshot,
      stage: executionUnknown
        ? 'execution_status_unknown'
        : 'pre_entry_failure',
      binance_trade_status: options.invocation.status,
      binance_trade_payload: options.invocation.payload,
      binance_trade_error: options.invocation.error,
      updated_at: new Date().toISOString(),
    },
  };

  if (!executionUnknown) {
    patch.status = 'failed';
  }

  const { error } = await options.admin
    .from('position_sizing_decisions')
    .update(patch)
    .eq('id', options.decision.id);

  if (error) {
    console.error('Falha ao registrar resultado da decisão:', error);
  }
}

function publicDecisionSummary(
  decision: PositionSizingDecisionRecord,
): JsonRecord {
  return {
    id: decision.id,
    status: decision.status,
    source: decision.source,
    execution_environment: decision.execution_environment,
    sizing_mode: decision.sizing_mode,
    sizing_scope: decision.sizing_scope,
    policy_version: decision.policy_version,
    base_risk_percent: finite(decision.base_risk_percent),
    target_risk_percent: finite(decision.target_risk_percent),
    applied_risk_percent: finite(decision.applied_risk_percent),
    risk_multiplier: finite(decision.risk_multiplier),
    sequence_step: finite(decision.sequence_step),
    consecutive_wins: finite(decision.consecutive_wins),
    consecutive_losses: finite(decision.consecutive_losses),
    account_consecutive_wins: finite(decision.account_consecutive_wins),
    account_consecutive_losses: finite(decision.account_consecutive_losses),
    planned_risk_usdt: finite(decision.planned_risk_usdt),
    actual_risk_usdt: finite(decision.actual_risk_usdt),
    requested_quote_amount: finite(decision.requested_quote_amount),
    effective_quote_amount: finite(decision.effective_quote_amount),
    limiting_rules: Array.isArray(decision.limiting_rules)
      ? decision.limiting_rules
      : [],
    order_id: decision.order_id,
    journal_id: decision.daytrade_journal_id,
    created_at: decision.created_at,
    applied_at: decision.applied_at,
  };
}

// ============================================================================
// Handler
// ============================================================================

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return errorResponse(
      405,
      'Método não permitido.',
      'METHOD_NOT_ALLOWED',
      { allowed: ['POST', 'OPTIONS'] },
    );
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return errorResponse(401, 'Usuário não autenticado.', 'UNAUTHORIZED');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse(
      500,
      'Configuração interna indisponível.',
      'SERVER_CONFIG_ERROR',
    );
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await readBody(req);
    const action = parseAction(body.action);
    const setupId = parseUuid(body.setup_id, 'setup_id');
    const manualRiskCapPercent = parseOptionalRiskCap(body.risk_percent);
    const confirmTestnet = parseConfirmation(body.confirm_testnet);

    if (action === 'execute' && !confirmTestnet) {
      throw new RequestError(
        400,
        'TESTNET_CONFIRMATION_REQUIRED',
        'Para executar, confirme explicitamente o uso da Testnet.',
        { required: { action: 'execute', confirm_testnet: true } },
      );
    }

    const token = authorization.slice('Bearer '.length).trim();
    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser(token);

    if (authError || !user) {
      throw new RequestError(
        401,
        'INVALID_SESSION',
        'Sessão inválida ou expirada.',
      );
    }

    const { data: setupData, error: setupError } = await admin
      .from('daytrade_setups')
      .select(
        'id,user_id,symbol,timeframe,strategy,strategy_version,status,score,total_conditions,indicators,plan,entry_reference,stop_reference,target_reference,risk_reward_ratio,candle_open_time,candle_close_time,last_closed_price,last_live_price',
      )
      .eq('id', setupId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (setupError) {
      throw new RequestError(
        500,
        'SETUP_LOOKUP_FAILED',
        'Falha ao consultar o setup.',
        { message: setupError.message },
      );
    }

    if (!setupData) {
      throw new RequestError(404, 'SETUP_NOT_FOUND', 'Setup não encontrado.');
    }

    const setup = setupData as DayTradeSetup;

    if (setup.strategy !== 'trend_breakout') {
      throw new RequestError(
        409,
        'UNSUPPORTED_STRATEGY',
        'A estratégia do setup não é suportada nesta função.',
        { strategy: setup.strategy },
      );
    }

    if (setup.status !== 'condicoes_atendidas') {
      throw new RequestError(
        409,
        'SETUP_NOT_EXECUTABLE',
        'Somente setups com todas as condições atendidas podem avançar.',
        { current_status: setup.status },
      );
    }

    if (setup.score !== setup.total_conditions) {
      throw new RequestError(
        409,
        'INCOMPLETE_CHECKLIST',
        'O checklist salvo não possui todas as condições atendidas.',
        { score: setup.score, total_conditions: setup.total_conditions },
      );
    }

    if (!isTimeframe(setup.timeframe)) {
      throw new RequestError(
        409,
        'UNSUPPORTED_TIMEFRAME',
        'Timeframe do setup não suportado.',
      );
    }

    const savedPlan = validateSetupPlan(setup);

    // Idempotência tem prioridade sobre validade temporal: uma repetição do
    // mesmo execute deve devolver a ordem já registrada, mesmo após o setup
    // original ter vencido.
    if (action === 'execute') {
      const [existingOrder, existingJournal, existingDecision] =
        await Promise.all([
          findOrderByRequestId(admin, user.id, setup.id),
          findJournal(admin, user.id, setup.id),
          findDecisionBySetup(admin, user.id, setup.id),
        ]);

      if (existingOrder) {
        return jsonResponse({
          ok: true,
          action: 'execute',
          environment: 'testnet',
          duplicate: true,
          message: 'Este setup já havia sido processado.',
          setup_id: setup.id,
          journal: existingJournal,
          order: existingOrder,
          position_sizing: existingDecision
            ? publicDecisionSummary(existingDecision)
            : null,
          educational_notice:
            'A operação pertence exclusivamente à Binance Spot Testnet.',
        });
      }
    }

    const freshness = validateSetupFreshness(setup);
    const publicMarket = await fetchPublicPrice(setup.symbol);
    const marketValidation = validateCurrentMarket(
      setup,
      publicMarket.price,
      savedPlan.entry,
      savedPlan.stop,
      savedPlan.target,
    );

    const connection = await invokeBinanceTrade({
      supabaseUrl,
      anonKey,
      authorization,
      requestId: setup.id,
      body: { action: 'test_connection' },
    });

    if (!connection.transportOk || connection.status === null) {
      throw new RequestError(
        502,
        'BINANCE_CONNECTION_FAILED',
        connection.error ?? 'Não foi possível conectar à Binance.',
        connection.payload,
      );
    }

    if (connection.status < 200 || connection.status >= 300) {
      throw new RequestError(
        connection.status,
        asString(connection.payload.code) ?? 'BINANCE_CONNECTION_FAILED',
        asString(connection.payload.error) ??
          'Não foi possível conectar à Binance.',
        connection.payload,
      );
    }

    const connectionPayload = connection.payload as ConnectionResponse;
    if (connectionPayload.is_testnet !== true) {
      throw new RequestError(
        403,
        'REAL_ACCOUNT_BLOCKED',
        'Esta função aceita exclusivamente chaves da Binance Spot Testnet.',
      );
    }

    const balances = Array.isArray(connectionPayload.balances)
      ? connectionPayload.balances
      : [];
    const usdt = balances.find((balance) => balance.asset === 'USDT');
    const freeUsdt = nonNegative(usdt?.free) ?? 0;
    const lockedUsdt = nonNegative(usdt?.locked) ?? 0;
    const totalUsdt = freeUsdt + lockedUsdt;

    if (!(freeUsdt > 0)) {
      throw new RequestError(
        409,
        'INSUFFICIENT_TESTNET_BALANCE',
        'A conta Testnet não possui saldo livre em USDT.',
      );
    }

    const [testnetPrice, symbolRules, settingsResult] = await Promise.all([
      fetchTestnetPrice(setup.symbol),
      fetchTestnetSymbolRules(setup.symbol),
      admin
        .from('user_settings')
        .select(SETTINGS_SELECT)
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);

    if (settingsResult.error) {
      throw new RequestError(
        500,
        'POSITION_SIZING_SETTINGS_UNAVAILABLE',
        'Falha ao consultar as configurações de risco. Aplique a migration de position sizing antes desta Edge Function.',
        { message: settingsResult.error.message },
      );
    }

    const settings = (settingsResult.data ?? {}) as Partial<UserSettingsRow>;
    const minStopPct =
      positive(settings.min_stop_pct) ?? DEFAULTS.minStopPct;
    const maxStopPct =
      positive(settings.max_stop_pct) ?? DEFAULTS.maxStopPct;
    const minTargetPct =
      positive(settings.min_target_pct) ?? DEFAULTS.minTargetPct;
    const maxTargetPct =
      positive(settings.max_target_pct) ?? DEFAULTS.maxTargetPct;

    const stopPct =
      ((savedPlan.entry - savedPlan.stop) / savedPlan.entry) * 100;
    const targetPct =
      ((savedPlan.target - savedPlan.entry) / savedPlan.entry) * 100;

    if (stopPct < minStopPct || stopPct > maxStopPct) {
      throw new RequestError(
        409,
        'STOP_OUTSIDE_LIMITS',
        'O stop do setup está fora dos limites configurados na conta.',
        { stop_pct: stopPct, allowed: [minStopPct, maxStopPct] },
      );
    }

    if (targetPct < minTargetPct || targetPct > maxTargetPct) {
      throw new RequestError(
        409,
        'TARGET_OUTSIDE_LIMITS',
        'O alvo do setup está fora dos limites configurados na conta.',
        { target_pct: targetPct, allowed: [minTargetPct, maxTargetPct] },
      );
    }

    const policy = resolveSizingPolicy(settings, manualRiskCapPercent);
    const { sequence, accountSequence } = await loadSizingSequences(admin, {
      userId: user.id,
      policy,
      setup,
    });

    const sizing = calculatePolicySizing({
      policy,
      sequence,
      accountSequence,
      totalBalanceUsdt: totalUsdt,
      availableBalanceUsdt: freeUsdt,
      entryReference: savedPlan.entry,
      stopReference: savedPlan.stop,
      targetReference: savedPlan.target,
      currentTestnetPrice: testnetPrice,
      minNotionalUsdt: symbolRules.minNotional,
      maxNotionalUsdt: symbolRules.maxNotional,
    });

    if (sizing.shouldPause) {
      await pauseAutoTradeForLossGuard(admin, user.id, sizing);
    }

    const preview = {
      setup: {
        id: setup.id,
        symbol: setup.symbol,
        timeframe: setup.timeframe,
        strategy: setup.strategy,
        strategy_version: setup.strategy_version,
        status: setup.status,
        candle_close_time: setup.candle_close_time,
        expires_at: freshness.expiresAt,
        age_ms: freshness.ageMs,
      },
      plan: {
        entry_reference: savedPlan.entry,
        stop_reference: savedPlan.stop,
        target_reference: savedPlan.target,
        saved_risk_reward_ratio: savedPlan.savedRiskReward,
        stop_pct: sizing.stopDistancePct,
        target_pct: sizing.targetDistancePct,
        gross_risk_reward_ratio: sizing.grossRiskRewardRatio,
        atr: marketValidation.atr,
        breakout_level: marketValidation.breakoutLevel,
        latest_acceptable_entry: marketValidation.latestAcceptableEntry,
      },
      market: {
        public_price: publicMarket.price,
        public_source: publicMarket.source,
        testnet_price: testnetPrice,
      },
      account: {
        environment: 'testnet',
        total_usdt: totalUsdt,
        free_usdt: freeUsdt,
        locked_usdt: lockedUsdt,
        max_order_usdt: policy.maxOrderUsdt,
        balance_usage_limit_pct: policy.balanceUsageLimitPct,
      },
      sizing,
      execution: {
        mode: 'testnet',
        request_id: setup.id,
        quote_amount: sizing.effectiveQuoteAmount,
        stop_pct: sizing.stopDistancePct,
        target_pct: sizing.targetDistancePct,
        requires_confirmation: true,
      },
    };

    if (!sizing.executable) {
      throw new RequestError(
        409,
        sizing.blockedReason ?? 'POSITION_SIZING_BLOCKED',
        sizing.shouldPause
          ? 'A execução foi bloqueada pelo limite de perdas consecutivas.'
          : 'O tamanho da posição não passou pelas regras de risco.',
        { preview, sizing },
      );
    }

    if (action === 'preview') {
      return jsonResponse({
        ok: true,
        action: 'preview',
        executable: true,
        preview,
        next_request: {
          action: 'execute',
          setup_id: setup.id,
          ...(manualRiskCapPercent === null
            ? {}
            : { risk_percent: manualRiskCapPercent }),
          confirm_testnet: true,
        },
        educational_notice:
          'A prévia usa saldo e regras atuais da Binance Spot Testnet. Ela não garante o preço final da compra.',
      });
    }

    const existingJournal = await findJournal(admin, user.id, setup.id);
    if (existingJournal?.order_id) {
      const previousOrder = await findOrderByRequestId(
        admin,
        user.id,
        setup.id,
      );
      const previousDecision = await findDecisionBySetup(
        admin,
        user.id,
        setup.id,
      );

      return jsonResponse({
        ok: true,
        action: 'execute',
        environment: 'testnet',
        duplicate: true,
        message: 'Este setup já havia sido processado.',
        preview,
        journal: existingJournal,
        order: previousOrder,
        position_sizing: previousDecision
          ? publicDecisionSummary(previousDecision)
          : null,
      });
    }

    const snapshot = decisionSnapshot(setup, sizing, {
      publicPrice: publicMarket.price,
      publicSource: publicMarket.source,
      testnetPrice,
      latestAcceptableEntry: marketValidation.latestAcceptableEntry,
    });

    const journalPayload: JsonRecord = {
      user_id: user.id,
      setup_id: setup.id,
      mode: 'testnet',
      status: 'ordem_enviada',
      symbol: setup.symbol,
      timeframe: setup.timeframe,
      strategy: setup.strategy,
      entry_reference: savedPlan.entry,
      stop_reference: savedPlan.stop,
      target_reference: savedPlan.target,
      risk_reward_ratio: sizing.grossRiskRewardRatio,
      planned_quantity: sizing.estimatedQuantity,
      planned_notional: sizing.effectiveQuoteAmount,
      risk_usdt: sizing.plannedRiskUsdt,
      risk_percent: sizing.appliedRiskPercent,
      sizing_mode: sizing.mode,
      base_risk_percent: sizing.baseRiskPercent,
      applied_risk_percent: sizing.appliedRiskPercent,
      risk_multiplier: sizing.riskMultiplier,
      sizing_snapshot: snapshot,
      metadata: snapshot,
    };

    const journal = await saveJournalBeforeExecution({
      admin,
      existing: existingJournal,
      payload: journalPayload,
    });

    const decision = await reserveDirectSizingDecision({
      admin,
      userId: user.id,
      setup,
      journalId: journal.id,
      sizing,
      marketSnapshot: snapshot,
    });

    const reservedQuoteAmount =
      positive(decision.effective_quote_amount) ?? sizing.effectiveQuoteAmount;

    const trade = await invokeBinanceTrade({
      supabaseUrl,
      anonKey,
      authorization,
      requestId: setup.id,
      body: {
        action: 'place_entry_oco',
        symbol: setup.symbol,
        quote_amount: reservedQuoteAmount,
        stop_pct: sizing.stopDistancePct,
        target_pct: sizing.targetDistancePct,
        request_id: setup.id,
        confirm_testnet: true,
      },
    });

    let order: OrderRecord | null = null;
    try {
      order = await findOrderByRequestId(admin, user.id, setup.id);
    } catch (lookupError) {
      console.error('Falha ao consultar ordem após execução:', lookupError);
    }

    const journalUpdateError = await updateJournalAfterInvocation({
      admin,
      userId: user.id,
      journal,
      order,
      decision,
      sizing,
      invocation: trade,
      metadata: snapshot,
    });

    let auditApplication: AuditApplicationResult | null = null;
    if (order) {
      auditApplication = await applyDecisionToOrder({
        admin,
        userId: user.id,
        journalId: journal.id,
        decision,
        order,
        sizing,
      });

      try {
        order = await findOrderByRequestId(admin, user.id, setup.id);
      } catch {
        // Mantém a ordem já carregada quando a atualização de leitura falha.
      }
    } else {
      await markDecisionAfterFailure({
        admin,
        decision,
        invocation: trade,
        order,
      });
    }

    const httpSucceeded =
      trade.transportOk &&
      trade.status !== null &&
      trade.status >= 200 &&
      trade.status < 300 &&
      trade.payload.ok === true;

    if (!httpSucceeded) {
      const status = trade.status !== null && trade.status >= 400
        ? trade.status
        : 502;
      const code = order
        ? 'TESTNET_ORDER_RECORDED_WITH_ERROR'
        : trade.payload.execution_status_unknown === true
          ? 'TESTNET_EXECUTION_STATUS_UNKNOWN'
          : 'TESTNET_EXECUTION_FAILED';

      return errorResponse(
        status,
        asString(trade.payload.error) ??
          trade.error ??
          'A execução Testnet falhou.',
        code,
        {
          preview,
          journal_id: journal.id,
          order,
          position_sizing: publicDecisionSummary(decision),
          audit_application: auditApplication,
          binance_trade: trade.payload,
          journal_update_error: journalUpdateError,
        },
      );
    }

    if (!order) {
      return errorResponse(
        502,
        'A Binance respondeu com sucesso, mas a ordem local não foi encontrada. Não repita com outro setup_id.',
        'TESTNET_ORDER_NOT_RECONCILED',
        {
          preview,
          journal_id: journal.id,
          position_sizing: publicDecisionSummary(decision),
          binance_trade: trade.payload,
          journal_update_error: journalUpdateError,
        },
      );
    }

    const refreshedDecision =
      await findDecisionBySetup(admin, user.id, setup.id) ?? decision;

    return jsonResponse({
      ok: true,
      action: 'execute',
      environment: 'testnet',
      duplicate: Boolean(trade.payload.duplicate),
      preview,
      journal_id: journal.id,
      order,
      position_sizing: publicDecisionSummary(refreshedDecision),
      audit_application: auditApplication,
      binance_trade: trade.payload,
      journal_update_error: journalUpdateError,
      educational_notice:
        'A operação foi executada exclusivamente na Binance Spot Testnet. Resultados simulados não garantem desempenho em conta real.',
    });
  } catch (error) {
    console.error('executar-daytrade-testnet:', error);

    if (error instanceof RequestError) {
      return errorResponse(
        error.status,
        error.message,
        error.code,
        error.details,
      );
    }

    return errorResponse(
      500,
      'Não foi possível concluir a solicitação Testnet.',
      'EXECUTION_ERROR',
      { message: errorMessage(error) },
    );
  }
});