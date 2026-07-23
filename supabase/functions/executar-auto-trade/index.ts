// ============================================================================
// VigIA Trade — Edge Function: executar-auto-trade v3
// supabase/functions/executar-auto-trade/index.ts
// ============================================================================
//
// Responsabilidades:
// - localizar oportunidades elegíveis para usuários com Auto Trade ativo;
// - selecionar no máximo uma oportunidade por usuário em cada execução;
// - reservar a oportunidade atomicamente pela RPC claim_auto_trade_opportunity;
// - marcar a tentativa como dispatching antes de qualquer chamada externa;
// - encaminhar a execução ao motor binance-trade;
// - deixar o binance-trade consultar o saldo real e reservar a decisão de
//   dimensionamento em position_sizing_decisions;
// - finalizar a auditoria em auto_trade_attempts;
// - preservar no retorno os dados de risco fixo, anti-martingale ou martingale
//   exclusivo da Testnet;
// - pausar o Auto Trade quando houver estado incerto, entrada sem proteção ou
//   bloqueio de segurança por perdas consecutivas.
//
// Esta função NÃO:
// - acessa api_secret;
// - assina requisições da Binance;
// - calcula o valor efetivo da ordem no navegador ou no cron;
// - cria ordens diretamente.
//
// O valor quote_amount retornado pelo claim é provisório. O binance-trade é a
// fonte autoritativa do valor efetivo porque consulta o saldo livre na Binance,
// executa preview_position_sizing/reserve_position_sizing_decision e só então
// cria a ordem.
//
// Publicação recomendada:
//   verify_jwt = false
//
// Autenticação interna:
//   x-cron-secret: <CRON_SECRET>
//
// Corpo opcional:
//   {
//     "opportunity_id": "<uuid>",
//     "user_id": "<uuid>",
//     "limit": 5,
//     "scan_limit": 100,
//     "lock_seconds": 180,
//     "dry_run": false
//   }
// ============================================================================

import {
  createClient,
  type SupabaseClient,
} from 'jsr:@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface RequestBody {
  opportunity_id?: unknown;
  user_id?: unknown;
  limit?: unknown;
  scan_limit?: unknown;
  lock_seconds?: unknown;
  dry_run?: unknown;
}

interface ParsedRequest {
  opportunityId: string | null;
  userId: string | null;
  limit: number;
  scanLimit: number;
  lockSeconds: number;
  dryRun: boolean;
}

interface OpportunityRow {
  id: string;
  user_id: string;
  opportunity_type: string;
  source_type: string;
  source_id: string;
  market: string;
  provider: string;
  symbol: string;
  timeframe: string;
  direction: string;
  quote_asset: string;
  severity: string;
  strategy: string;
  strategy_version: string;
  lifecycle_status: string;
  entry_decision: string;
  execution_environment: string;
  detected_at: string;
  expires_at: string | null;
  entry_reference: number | string | null;
  maximum_entry_price: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  gross_risk_reward: number | string | null;
  score: number | string | null;
  total_conditions: number | string | null;
  warnings: unknown;
  quote_amount: number | string | null;
  position_sizing_decision_id: string | null;
  sizing_snapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

type SizingMode =
  | 'fixed'
  | 'anti_martingale'
  | 'martingale_testnet';

type SizingScope =
  | 'account'
  | 'strategy'
  | 'symbol'
  | 'symbol_timeframe';

interface AutoTradeSettingsRow {
  user_id: string;
  auto_trade_enabled: boolean;
  auto_trade_paused_at: string | null;
  auto_trade_environment: 'testnet' | 'real';
  auto_trade_symbols: string[];
  auto_trade_timeframes: string[];
  auto_trade_strategies: string[];
  auto_trade_sizing_mode: SizingMode;
  auto_trade_sizing_scope: SizingScope;
  auto_trade_sizing_policy_version: string;
  auto_trade_quote_amount: number | string;
  auto_trade_base_risk_percent: number | string;
  auto_trade_min_risk_percent: number | string;
  auto_trade_max_risk_percent: number | string;
  auto_trade_pause_after_consecutive_losses: number;
}

interface RetryAttemptRow {
  opportunity_id: string;
  status: 'failed' | 'abandoned';
  attempt_count: number;
  updated_at: string;
}

interface Candidate {
  opportunity: OpportunityRow;
  source: 'fresh' | 'retry' | 'direct';
  previousAttemptStatus: string | null;
  previousAttemptCount: number;
  scorePct: number | null;
  riskReward: number | null;
  settings: AutoTradeSettingsRow | null;
}

interface ClaimPayload {
  claimed?: boolean;
  code?: string;
  message?: string;
  attempt_id?: string;
  worker_id?: string;
  user_id?: string;
  opportunity_id?: string;
  request_id?: string;
  environment?: 'testnet' | 'real';
  quote_amount?: number | string;
  symbol?: string;
  timeframe?: string;
  strategy?: string;
  strategy_version?: string;
  score_pct?: number | string;
  risk_reward?: number | string;
  attempt_count?: number;
  lock_expires_at?: string;
  order_id?: string | null;
  status?: string;
  [key: string]: unknown;
}

interface DispatchPayload {
  updated?: boolean;
  code?: string;
  status?: string;
  attempt_id?: string;
  opportunity_id?: string;
  request_id?: string;
  lock_expires_at?: string;
  [key: string]: unknown;
}

interface FinalizePayload {
  updated?: boolean;
  duplicate?: boolean;
  code?: string;
  status?: string;
  order_id?: string | null;
  [key: string]: unknown;
}

interface BinanceInvocationResult {
  transportOk: boolean;
  status: number | null;
  payload: Record<string, unknown>;
  rawText: string;
  error: string | null;
}

interface PositionSizingSummary {
  decision_id: string | null;
  source: string | null;
  status: string | null;
  execution_environment: 'testnet' | 'real' | null;
  mode: SizingMode | null;
  scope: SizingScope | null;
  policy_version: string | null;
  base_quote_amount: number | null;
  requested_quote_amount: number | null;
  effective_quote_amount: number | null;
  available_balance_usdt: number | null;
  balance_usage_limit_pct: number | null;
  base_risk_percent: number | null;
  target_risk_percent: number | null;
  applied_risk_percent: number | null;
  risk_multiplier: number | null;
  sequence_step: number | null;
  consecutive_wins: number | null;
  consecutive_losses: number | null;
  account_consecutive_wins: number | null;
  account_consecutive_losses: number | null;
  planned_risk_usdt: number | null;
  actual_risk_usdt: number | null;
  stop_distance_pct: number | null;
  estimated_total_cost_pct: number | null;
  estimated_loss_rate_pct: number | null;
  limiting_rules: unknown[];
}

type ProcessingDisposition =
  | 'dry_run'
  | 'executed'
  | 'duplicate'
  | 'blocked'
  | 'failed'
  | 'skipped'
  | 'claim_error'
  | 'dispatch_error'
  | 'finalize_error';

interface ProcessingItem {
  opportunity_id: string;
  user_id: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  source: Candidate['source'];
  disposition: ProcessingDisposition;
  code: string;
  message: string;
  attempt_id: string | null;
  order_id: string | null;
  http_status: number | null;
  execution_environment: 'testnet' | 'real' | null;
  provisional_quote_amount_usdt: number | null;
  effective_quote_amount_usdt: number | null;
  planned_risk_usdt: number | null;
  actual_risk_usdt: number | null;
  sizing_mode: SizingMode | null;
  sizing_scope: SizingScope | null;
  sizing_policy_version: string | null;
  risk_multiplier: number | null;
  sequence_step: number | null;
  consecutive_wins: number | null;
  consecutive_losses: number | null;
  account_consecutive_losses: number | null;
  position_sizing_decision_id: string | null;
  limiting_rules: unknown[];
  auto_trade_paused: boolean;
  duration_ms: number;
}

interface RuntimeContext {
  requestId: string;
  workerId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  cronSecret: string;
  admin: SupabaseClient;
}

interface ResolvedExecutionResult {
  finalStatus: 'executed' | 'duplicate' | 'blocked' | 'failed';
  disposition: ProcessingDisposition;
  code: string;
  message: string;
  orderId: string | null;
  pauseAutoTrade: boolean;
  sizing: PositionSizingSummary | null;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 16_384;
const DEFAULT_EXECUTION_LIMIT = 5;
const MAX_EXECUTION_LIMIT = 10;
const DEFAULT_SCAN_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
const DEFAULT_LOCK_SECONDS = 180;
const MIN_LOCK_SECONDS = 60;
const MAX_LOCK_SECONDS = 600;
const BINANCE_TIMEOUT_MS = 55_000;
const MAX_STORED_RESPONSE_BYTES = 64_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OPPORTUNITY_SELECT = [
  'id',
  'user_id',
  'opportunity_type',
  'source_type',
  'source_id',
  'market',
  'provider',
  'symbol',
  'timeframe',
  'direction',
  'quote_asset',
  'severity',
  'strategy',
  'strategy_version',
  'lifecycle_status',
  'entry_decision',
  'execution_environment',
  'detected_at',
  'expires_at',
  'entry_reference',
  'maximum_entry_price',
  'stop_reference',
  'target_reference',
  'gross_risk_reward',
  'score',
  'total_conditions',
  'warnings',
  'quote_amount',
  'position_sizing_decision_id',
  'sizing_snapshot',
  'metadata',
].join(',');

const SETTINGS_SELECT = [
  'user_id',
  'auto_trade_enabled',
  'auto_trade_paused_at',
  'auto_trade_environment',
  'auto_trade_symbols',
  'auto_trade_timeframes',
  'auto_trade_strategies',
  'auto_trade_sizing_mode',
  'auto_trade_sizing_scope',
  'auto_trade_sizing_policy_version',
  'auto_trade_quote_amount',
  'auto_trade_base_risk_percent',
  'auto_trade_min_risk_percent',
  'auto_trade_max_risk_percent',
  'auto_trade_pause_after_consecutive_losses',
].join(',');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, x-cron-secret, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAUSE_CODES = new Set([
  'ENTRY_UNPROTECTED',
  'ENTRY_FILLED_SUMMARY_FAILED',
  'ENTRY_STATUS_UNKNOWN',
  'ENTRY_PENDING_CONFIRMATION',
  'UNPROTECTED_POSITION_EXISTS',
  'ENTRY_FILLED_OCO_NOT_CONFIRMED',
  'OCO_STATUS_UNKNOWN',
  'BINANCE_TRADE_TIMEOUT',
  'BINANCE_TRADE_NETWORK_ERROR',
  'CONSECUTIVE_LOSS_PAUSE_REQUIRED',
]);

const PERMANENT_BLOCK_CODES = new Set([
  'OPPORTUNITY_EXPIRED',
  'OPPORTUNITY_INVALIDATED_BY_STOP',
  'OPPORTUNITY_TARGET_ALREADY_REACHED',
  'OPPORTUNITY_LOST_BREAKOUT',
  'OPPORTUNITY_ENTRY_TOO_LATE',
  'INVALID_OPPORTUNITY_PLAN',
  'OPPORTUNITY_NOT_EXECUTABLE',
  'OPPORTUNITY_NOT_ACCEPTED',
  'NOT_AN_ENTRY_OPPORTUNITY',
  'UNSUPPORTED_DIRECTION',
  'UNSUPPORTED_PROVIDER',
  'UNSUPPORTED_QUOTE_ASSET',
  'QUOTE_AMOUNT_MISMATCH',
  'MAX_ORDER_EXCEEDED',
  'STOP_OUTSIDE_LIMITS',
  'TARGET_OUTSIDE_LIMITS',
  'MAX_OPEN_ORDERS_REACHED',
  'DAILY_LOSS_LIMIT_REACHED',
  'REAL_TRADING_DISABLED',
  'CENTRAL_REAL_EXECUTION_DISABLED',
  'TESTNET_KEY_REQUIRED',
  'REAL_KEY_REQUIRED',
  'KEY_NOT_CONFIGURED',
  'BINANCE_KEY_NOT_CONFIGURED',
  'BINANCE_TRADING_DISABLED',
  'INSUFFICIENT_USDT_BALANCE',
  'BELOW_MIN_NOTIONAL',
  'ABOVE_MAX_NOTIONAL',
  'SYMBOL_NOT_TRADING',
  'SYMBOL_NOT_FOUND',
  'QUOTE_ASSET_NOT_USDT',
  'QUOTE_ORDER_QTY_UNAVAILABLE',
  'AUTO_TRADE_DAILY_LIMIT_REACHED',
  'AUTO_TRADE_COOLDOWN_ACTIVE',
  'SCORE_BELOW_MINIMUM',
  'RISK_REWARD_BELOW_MINIMUM',
  'OPPORTUNITY_HAS_WARNINGS',
  'SYMBOL_NOT_ALLOWED',
  'TIMEFRAME_NOT_ALLOWED',
  'STRATEGY_NOT_ALLOWED',
  'AUTO_TRADE_AMOUNT_ABOVE_LIMIT',
  'MARTINGALE_REAL_FORBIDDEN',
  'CONSECUTIVE_LOSS_PAUSE_REQUIRED',
  'BALANCE_REQUIRED',
  'POSITION_SIZING_ENVIRONMENT_MISMATCH',
  'POSITION_SIZING_DECISION_NOT_REUSABLE',
  'POSITION_SIZING_AMOUNT_INVALID',
]);

// ---------------------------------------------------------------------------
// Respostas
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  requestId: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Request-Id': requestId,
    },
  });
}

function errorResponse(
  status: number,
  error: string,
  code: string,
  requestId: string,
  details?: unknown,
): Response {
  return jsonResponse(
    {
      ok: false,
      error,
      code,
      request_id: requestId,
      ...(details === undefined ? {} : { details }),
    },
    requestId,
    status,
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Erro desconhecido.';
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

function parseUuid(
  value: unknown,
  field: string,
  optional = true,
): string | null {
  if (value === undefined || value === null || value === '') {
    if (optional) {
      return null;
    }

    throw new Error(`${field} é obrigatório.`);
  }

  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new Error(`${field} deve ser um UUID válido.`);
  }

  return value.trim().toLowerCase();
}

function parseInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${field} deve ser um inteiro entre ${minimum} e ${maximum}.`,
    );
  }

  return parsed;
}

function parseBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${field} deve ser verdadeiro ou falso.`);
  }

  return value;
}

function assertAllowedKeys(body: RequestBody): void {
  const allowed = new Set([
    'opportunity_id',
    'user_id',
    'limit',
    'scan_limit',
    'lock_seconds',
    'dry_run',
  ]);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new Error(`Campo não suportado: ${key}.`);
    }
  }
}

async function readBody(req: Request): Promise<RequestBody> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BODY_BYTES
  ) {
    throw new Error('Corpo da requisição excede o limite permitido.');
  }

  const raw = await req.text();

  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new Error('Corpo da requisição excede o limite permitido.');
  }

  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('JSON deve ser um objeto.');
    }

    return parsed as RequestBody;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'JSON deve ser um objeto.'
    ) {
      throw error;
    }

    throw new Error('JSON inválido.');
  }
}

function parseRequest(body: RequestBody): ParsedRequest {
  assertAllowedKeys(body);

  const opportunityId = parseUuid(
    body.opportunity_id,
    'opportunity_id',
  );
  const userId = parseUuid(body.user_id, 'user_id');

  return {
    opportunityId,
    userId,
    limit: parseInteger(
      body.limit,
      'limit',
      opportunityId ? 1 : DEFAULT_EXECUTION_LIMIT,
      1,
      MAX_EXECUTION_LIMIT,
    ),
    scanLimit: parseInteger(
      body.scan_limit,
      'scan_limit',
      opportunityId ? 1 : DEFAULT_SCAN_LIMIT,
      1,
      MAX_SCAN_LIMIT,
    ),
    lockSeconds: parseInteger(
      body.lock_seconds,
      'lock_seconds',
      DEFAULT_LOCK_SECONDS,
      MIN_LOCK_SECONDS,
      MAX_LOCK_SECONDS,
    ),
    dryRun: parseBoolean(body.dry_run, 'dry_run', false),
  };
}

// ---------------------------------------------------------------------------
// Autenticação interna
// ---------------------------------------------------------------------------

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);

  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |=
      (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function authenticateInternal(
  req: Request,
  requestId: string,
): RuntimeContext | Response {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const cronSecret = Deno.env.get('CRON_SECRET');

  if (!supabaseUrl || !serviceRoleKey || !cronSecret) {
    console.error(
      `[${requestId}] SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou CRON_SECRET ausente.`,
    );

    return errorResponse(
      500,
      'Configuração interna indisponível.',
      'SERVER_CONFIG_ERROR',
      requestId,
    );
  }

  const supplied = req.headers.get('x-cron-secret')?.trim() ?? '';

  if (!supplied || !timingSafeEqual(supplied, cronSecret)) {
    return errorResponse(
      403,
      'Credencial interna inválida.',
      'INVALID_INTERNAL_CREDENTIAL',
      requestId,
    );
  }

  return {
    requestId,
    workerId: crypto.randomUUID(),
    supabaseUrl,
    serviceRoleKey,
    cronSecret,
    admin: createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Utilidades de dados
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = finite(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function sizingModeOrNull(value: unknown): SizingMode | null {
  return value === 'fixed' ||
      value === 'anti_martingale' ||
      value === 'martingale_testnet'
    ? value
    : null;
}

function sizingScopeOrNull(value: unknown): SizingScope | null {
  return value === 'account' ||
      value === 'strategy' ||
      value === 'symbol' ||
      value === 'symbol_timeframe'
    ? value
    : null;
}

function executionEnvironmentOrNull(
  value: unknown,
): 'testnet' | 'real' | null {
  return value === 'testnet' || value === 'real' ? value : null;
}

function scorePct(opportunity: OpportunityRow): number | null {
  const score = finite(opportunity.score);
  const total = positive(opportunity.total_conditions);

  if (score === null || total === null) {
    return null;
  }

  return Math.round((score / total) * 10_000) / 100;
}

function severityWeight(severity: string): number {
  if (severity === 'critical') {
    return 3;
  }

  if (severity === 'high') {
    return 2;
  }

  return 1;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uuidFrom(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

function payloadString(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractOrderId(payload: Record<string, unknown>): string | null {
  const direct = uuidFrom(payload.order_id);

  if (direct) {
    return direct;
  }

  const order = isRecord(payload.order) ? payload.order : null;
  return uuidFrom(order?.id);
}

function emptySizingSummary(): PositionSizingSummary {
  return {
    decision_id: null,
    source: null,
    status: null,
    execution_environment: null,
    mode: null,
    scope: null,
    policy_version: null,
    base_quote_amount: null,
    requested_quote_amount: null,
    effective_quote_amount: null,
    available_balance_usdt: null,
    balance_usage_limit_pct: null,
    base_risk_percent: null,
    target_risk_percent: null,
    applied_risk_percent: null,
    risk_multiplier: null,
    sequence_step: null,
    consecutive_wins: null,
    consecutive_losses: null,
    account_consecutive_wins: null,
    account_consecutive_losses: null,
    planned_risk_usdt: null,
    actual_risk_usdt: null,
    stop_distance_pct: null,
    estimated_total_cost_pct: null,
    estimated_loss_rate_pct: null,
    limiting_rules: [],
  };
}

function parsePositionSizingRecord(
  source: Record<string, unknown>,
): PositionSizingSummary | null {
  if (Object.keys(source).length === 0) {
    return null;
  }

  const summary = emptySizingSummary();

  summary.decision_id =
    uuidFrom(source.decision_id) ??
    uuidFrom(source.position_sizing_decision_id) ??
    uuidFrom(source.id);
  summary.source = textOrNull(source.source);
  summary.status = textOrNull(source.status);
  summary.execution_environment = executionEnvironmentOrNull(
    source.execution_environment,
  );
  summary.mode = sizingModeOrNull(
    source.mode ?? source.sizing_mode,
  );
  summary.scope = sizingScopeOrNull(
    source.scope ?? source.sizing_scope,
  );
  summary.policy_version = textOrNull(
    source.policy_version ?? source.sizing_policy_version,
  );
  summary.base_quote_amount = finite(source.base_quote_amount);
  summary.requested_quote_amount = finite(
    source.requested_quote_amount,
  );
  summary.effective_quote_amount = finite(
    source.effective_quote_amount ?? source.quote_amount,
  );
  summary.available_balance_usdt = finite(
    source.available_balance_usdt,
  );
  summary.balance_usage_limit_pct = finite(
    source.balance_usage_limit_pct,
  );
  summary.base_risk_percent = finite(source.base_risk_percent);
  summary.target_risk_percent = finite(source.target_risk_percent);
  summary.applied_risk_percent = finite(source.applied_risk_percent);
  summary.risk_multiplier = finite(source.risk_multiplier);
  summary.sequence_step = integerOrNull(source.sequence_step);
  summary.consecutive_wins = integerOrNull(source.consecutive_wins);
  summary.consecutive_losses = integerOrNull(source.consecutive_losses);
  summary.account_consecutive_wins = integerOrNull(
    source.account_consecutive_wins,
  );
  summary.account_consecutive_losses = integerOrNull(
    source.account_consecutive_losses,
  );
  summary.planned_risk_usdt = finite(source.planned_risk_usdt);
  summary.actual_risk_usdt = finite(source.actual_risk_usdt);
  summary.stop_distance_pct = finite(source.stop_distance_pct);
  summary.estimated_total_cost_pct = finite(
    source.estimated_total_cost_pct,
  );
  summary.estimated_loss_rate_pct = finite(
    source.estimated_loss_rate_pct,
  );
  summary.limiting_rules = Array.isArray(source.limiting_rules)
    ? source.limiting_rules
    : [];

  const hasMeaningfulValue = Object.entries(summary).some(
    ([key, value]) =>
      key === 'limiting_rules'
        ? Array.isArray(value) && value.length > 0
        : value !== null,
  );

  return hasMeaningfulValue ? summary : null;
}

function extractPositionSizing(
  payload: Record<string, unknown>,
): PositionSizingSummary | null {
  const direct = parsePositionSizingRecord(
    asRecord(payload.position_sizing),
  );

  if (direct) {
    return direct;
  }

  const order = asRecord(payload.order);
  const fromOrder = parsePositionSizingRecord(order);

  if (fromOrder) {
    return fromOrder;
  }

  return null;
}

function compactResponsePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  try {
    const serialized = JSON.stringify(payload);

    if (new TextEncoder().encode(serialized).byteLength <= MAX_STORED_RESPONSE_BYTES) {
      return payload;
    }
  } catch {
    // O fallback abaixo preserva somente os campos operacionais.
  }

  const order = isRecord(payload.order) ? payload.order : {};
  const sizing = extractPositionSizing(payload);

  return {
    truncated: true,
    ok: payload.ok ?? null,
    duplicate: payload.duplicate ?? null,
    code: payload.code ?? null,
    error: payload.error ?? null,
    detail: payload.detail ?? null,
    request_id: payload.request_id ?? null,
    order_id: payload.order_id ?? order.id ?? null,
    opportunity_id: payload.opportunity_id ?? null,
    status: payload.status ?? order.status ?? null,
    entrada_executada: payload.entrada_executada ?? null,
    protecao_confirmada: payload.protecao_confirmada ?? null,
    execution_status_unknown: payload.execution_status_unknown ?? null,
    requires_manual_attention: payload.requires_manual_attention ?? null,
    position_sizing: sizing,
  };
}

function settingsSizingPreview(
  settings: AutoTradeSettingsRow | null,
): PositionSizingSummary | null {
  if (!settings) {
    return null;
  }

  const summary = emptySizingSummary();
  summary.execution_environment = settings.auto_trade_environment;
  summary.mode = settings.auto_trade_sizing_mode;
  summary.scope = settings.auto_trade_sizing_scope;
  summary.policy_version = settings.auto_trade_sizing_policy_version;
  summary.base_quote_amount = finite(settings.auto_trade_quote_amount);
  summary.base_risk_percent = finite(
    settings.auto_trade_base_risk_percent,
  );
  summary.target_risk_percent = null;
  summary.applied_risk_percent = null;

  return summary;
}

function processingItemBase(
  candidate: Candidate,
): Pick<
  ProcessingItem,
  | 'opportunity_id'
  | 'user_id'
  | 'symbol'
  | 'timeframe'
  | 'strategy'
  | 'source'
> {
  return {
    opportunity_id: candidate.opportunity.id,
    user_id: candidate.opportunity.user_id,
    symbol: candidate.opportunity.symbol,
    timeframe: candidate.opportunity.timeframe,
    strategy: candidate.opportunity.strategy,
    source: candidate.source,
  };
}

function sizingFields(
  sizing: PositionSizingSummary | null,
  provisionalQuoteAmount: number | null,
): Pick<
  ProcessingItem,
  | 'execution_environment'
  | 'provisional_quote_amount_usdt'
  | 'effective_quote_amount_usdt'
  | 'planned_risk_usdt'
  | 'actual_risk_usdt'
  | 'sizing_mode'
  | 'sizing_scope'
  | 'sizing_policy_version'
  | 'risk_multiplier'
  | 'sequence_step'
  | 'consecutive_wins'
  | 'consecutive_losses'
  | 'account_consecutive_losses'
  | 'position_sizing_decision_id'
  | 'limiting_rules'
> {
  return {
    execution_environment: sizing?.execution_environment ?? null,
    provisional_quote_amount_usdt: provisionalQuoteAmount,
    effective_quote_amount_usdt:
      sizing?.effective_quote_amount ?? provisionalQuoteAmount,
    planned_risk_usdt: sizing?.planned_risk_usdt ?? null,
    actual_risk_usdt: sizing?.actual_risk_usdt ?? null,
    sizing_mode: sizing?.mode ?? null,
    sizing_scope: sizing?.scope ?? null,
    sizing_policy_version: sizing?.policy_version ?? null,
    risk_multiplier: sizing?.risk_multiplier ?? null,
    sequence_step: sizing?.sequence_step ?? null,
    consecutive_wins: sizing?.consecutive_wins ?? null,
    consecutive_losses: sizing?.consecutive_losses ?? null,
    account_consecutive_losses:
      sizing?.account_consecutive_losses ?? null,
    position_sizing_decision_id: sizing?.decision_id ?? null,
    limiting_rules: sizing?.limiting_rules ?? [],
  };
}

// ---------------------------------------------------------------------------
// Seleção de candidatos
// ---------------------------------------------------------------------------

async function loadOpportunityById(
  admin: SupabaseClient,
  opportunityId: string,
  requestedUserId: string | null,
): Promise<OpportunityRow[]> {
  let query = admin
    .from('trade_opportunities')
    .select(OPPORTUNITY_SELECT)
    .eq('id', opportunityId)
    .limit(1);

  if (requestedUserId) {
    query = query.eq('user_id', requestedUserId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `Falha ao consultar a oportunidade: ${error.message}`,
    );
  }

  return (data ?? []) as OpportunityRow[];
}

async function loadFreshOpportunities(
  admin: SupabaseClient,
  parsed: ParsedRequest,
): Promise<OpportunityRow[]> {
  let query = admin
    .from('trade_opportunities')
    .select(OPPORTUNITY_SELECT)
    .eq('opportunity_type', 'entry')
    .eq('entry_decision', 'pending')
    .in('lifecycle_status', ['pending', 'under_review'])
    .gt('expires_at', new Date().toISOString())
    .order('detected_at', { ascending: false })
    .limit(parsed.scanLimit);

  if (parsed.userId) {
    query = query.eq('user_id', parsed.userId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `Falha ao consultar oportunidades pendentes: ${error.message}`,
    );
  }

  return (data ?? []) as OpportunityRow[];
}

async function loadRetryAttempts(
  admin: SupabaseClient,
  parsed: ParsedRequest,
): Promise<RetryAttemptRow[]> {
  let query = admin
    .from('auto_trade_attempts')
    .select('opportunity_id,status,attempt_count,updated_at')
    .in('status', ['failed', 'abandoned'])
    .is('order_id', null)
    .order('updated_at', { ascending: true })
    .limit(parsed.scanLimit);

  if (parsed.userId) {
    query = query.eq('user_id', parsed.userId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `Falha ao consultar tentativas recuperáveis: ${error.message}`,
    );
  }

  return (data ?? []) as RetryAttemptRow[];
}

async function loadRetryOpportunities(
  admin: SupabaseClient,
  attempts: readonly RetryAttemptRow[],
): Promise<OpportunityRow[]> {
  const ids = uniqueStrings(
    attempts.map((attempt) => attempt.opportunity_id),
  );

  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await admin
    .from('trade_opportunities')
    .select(OPPORTUNITY_SELECT)
    .in('id', ids)
    .eq('opportunity_type', 'entry')
    .eq('entry_decision', 'accepted')
    .eq('lifecycle_status', 'revalidating')
    .gt('expires_at', new Date().toISOString());

  if (error) {
    throw new Error(
      `Falha ao consultar oportunidades para nova tentativa: ${error.message}`,
    );
  }

  return (data ?? []) as OpportunityRow[];
}

async function loadSettingsMap(
  admin: SupabaseClient,
  userIds: readonly string[],
): Promise<Map<string, AutoTradeSettingsRow>> {
  const map = new Map<string, AutoTradeSettingsRow>();
  const ids = uniqueStrings(userIds);

  if (ids.length === 0) {
    return map;
  }

  const { data, error } = await admin
    .from('user_settings')
    .select(SETTINGS_SELECT)
    .in('user_id', ids);

  if (error) {
    throw new Error(
      `Falha ao consultar configurações do Auto Trade: ${error.message}`,
    );
  }

  for (const row of (data ?? []) as AutoTradeSettingsRow[]) {
    map.set(row.user_id, row);
  }

  return map;
}

function passesFastSettingsFilter(
  opportunity: OpportunityRow,
  settings: AutoTradeSettingsRow | undefined,
): boolean {
  if (
    !settings ||
    settings.auto_trade_enabled !== true ||
    settings.auto_trade_paused_at !== null
  ) {
    return false;
  }

  if (
    settings.auto_trade_sizing_mode === 'martingale_testnet' &&
    settings.auto_trade_environment !== 'testnet'
  ) {
    return false;
  }

  return (
    settings.auto_trade_symbols.includes(opportunity.symbol) &&
    settings.auto_trade_timeframes.includes(opportunity.timeframe) &&
    settings.auto_trade_strategies.includes(opportunity.strategy)
  );
}

function rankCandidates(left: Candidate, right: Candidate): number {
  if (left.source === 'retry' && right.source !== 'retry') {
    return -1;
  }

  if (right.source === 'retry' && left.source !== 'retry') {
    return 1;
  }

  const scoreDifference =
    (right.scorePct ?? -1) - (left.scorePct ?? -1);

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const riskDifference =
    (right.riskReward ?? -1) - (left.riskReward ?? -1);

  if (riskDifference !== 0) {
    return riskDifference;
  }

  const severityDifference =
    severityWeight(right.opportunity.severity) -
    severityWeight(left.opportunity.severity);

  if (severityDifference !== 0) {
    return severityDifference;
  }

  return (
    Date.parse(right.opportunity.detected_at) -
    Date.parse(left.opportunity.detected_at)
  );
}

async function loadCandidates(
  admin: SupabaseClient,
  parsed: ParsedRequest,
): Promise<Candidate[]> {
  if (parsed.opportunityId) {
    const opportunities = await loadOpportunityById(
      admin,
      parsed.opportunityId,
      parsed.userId,
    );
    const settings = await loadSettingsMap(
      admin,
      opportunities.map((opportunity) => opportunity.user_id),
    );

    return opportunities.map((opportunity) => ({
      opportunity,
      source: 'direct' as const,
      previousAttemptStatus: null,
      previousAttemptCount: 0,
      scorePct: scorePct(opportunity),
      riskReward: positive(opportunity.gross_risk_reward),
      settings: settings.get(opportunity.user_id) ?? null,
    }));
  }

  const [fresh, retryAttempts] = await Promise.all([
    loadFreshOpportunities(admin, parsed),
    loadRetryAttempts(admin, parsed),
  ]);

  const retryOpportunities = await loadRetryOpportunities(
    admin,
    retryAttempts,
  );

  const retryByOpportunity = new Map(
    retryAttempts.map((attempt) => [attempt.opportunity_id, attempt]),
  );

  const allOpportunities = [...fresh, ...retryOpportunities];
  const settings = await loadSettingsMap(
    admin,
    allOpportunities.map((opportunity) => opportunity.user_id),
  );
  const candidatesById = new Map<string, Candidate>();

  for (const opportunity of fresh) {
    const userSettings = settings.get(opportunity.user_id);

    if (!passesFastSettingsFilter(opportunity, userSettings)) {
      continue;
    }

    candidatesById.set(opportunity.id, {
      opportunity,
      source: 'fresh',
      previousAttemptStatus: null,
      previousAttemptCount: 0,
      scorePct: scorePct(opportunity),
      riskReward: positive(opportunity.gross_risk_reward),
      settings: userSettings ?? null,
    });
  }

  for (const opportunity of retryOpportunities) {
    const userSettings = settings.get(opportunity.user_id);

    if (!passesFastSettingsFilter(opportunity, userSettings)) {
      continue;
    }

    const attempt = retryByOpportunity.get(opportunity.id);

    candidatesById.set(opportunity.id, {
      opportunity,
      source: 'retry',
      previousAttemptStatus: attempt?.status ?? null,
      previousAttemptCount: attempt?.attempt_count ?? 0,
      scorePct: scorePct(opportunity),
      riskReward: positive(opportunity.gross_risk_reward),
      settings: userSettings ?? null,
    });
  }

  const filtered = [...candidatesById.values()];
  filtered.sort(rankCandidates);

  // Um usuário por execução evita duas entradas simultâneas antes que o
  // cooldown, o saldo e a sequência de risco reflitam a primeira ordem.
  const selected: Candidate[] = [];
  const selectedUsers = new Set<string>();

  for (const candidate of filtered) {
    if (selectedUsers.has(candidate.opportunity.user_id)) {
      continue;
    }

    selected.push(candidate);
    selectedUsers.add(candidate.opportunity.user_id);

    if (selected.length >= parsed.limit) {
      break;
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// RPCs de controle
// ---------------------------------------------------------------------------

async function abandonExpiredLocks(
  admin: SupabaseClient,
): Promise<number> {
  const { data, error } = await admin.rpc(
    'abandon_expired_auto_trade_locks',
    { p_limit: 200 },
  );

  if (error) {
    throw new Error(
      `Falha ao liberar locks expirados: ${error.message}`,
    );
  }

  return Math.max(0, Math.trunc(finite(data) ?? 0));
}

async function claimOpportunity(
  context: RuntimeContext,
  opportunityId: string,
  lockSeconds: number,
): Promise<ClaimPayload> {
  const { data, error } = await context.admin.rpc(
    'claim_auto_trade_opportunity',
    {
      p_opportunity_id: opportunityId,
      p_worker_id: context.workerId,
      p_lock_seconds: lockSeconds,
    },
  );

  if (error) {
    throw new Error(
      `Falha ao reservar a oportunidade: ${error.message}`,
    );
  }

  return isRecord(data) ? data as ClaimPayload : {};
}

async function markDispatching(
  context: RuntimeContext,
  attemptId: string,
  lockSeconds: number,
): Promise<DispatchPayload> {
  const { data, error } = await context.admin.rpc(
    'mark_auto_trade_dispatching',
    {
      p_attempt_id: attemptId,
      p_worker_id: context.workerId,
      p_lock_seconds: lockSeconds,
    },
  );

  if (error) {
    throw new Error(
      `Falha ao marcar a tentativa como dispatching: ${error.message}`,
    );
  }

  return isRecord(data) ? data as DispatchPayload : {};
}

async function finalizeAttempt(
  context: RuntimeContext,
  options: {
    attemptId: string;
    status:
      | 'executed'
      | 'duplicate'
      | 'skipped'
      | 'blocked'
      | 'failed'
      | 'abandoned';
    orderId: string | null;
    httpStatus: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    payload: Record<string, unknown>;
    pauseAutoTrade: boolean;
  },
): Promise<FinalizePayload> {
  const { data, error } = await context.admin.rpc(
    'finalize_auto_trade_attempt',
    {
      p_attempt_id: options.attemptId,
      p_worker_id: context.workerId,
      p_status: options.status,
      p_order_id: options.orderId,
      p_http_status: options.httpStatus,
      p_error_code: options.errorCode,
      p_error_message: options.errorMessage,
      p_response_payload: compactResponsePayload(options.payload),
      p_pause_auto_trade: options.pauseAutoTrade,
    },
  );

  if (error) {
    throw new Error(
      `Falha ao finalizar a tentativa: ${error.message}`,
    );
  }

  return isRecord(data) ? data as FinalizePayload : {};
}

// ---------------------------------------------------------------------------
// Chamada ao motor Binance
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function invokeBinanceTrade(
  context: RuntimeContext,
  claim: ClaimPayload,
  attemptId: string,
): Promise<BinanceInvocationResult> {
  const opportunityId = uuidFrom(claim.opportunity_id);
  const userId = uuidFrom(claim.user_id);
  const requestId = uuidFrom(claim.request_id);
  const provisionalQuoteAmount = positive(claim.quote_amount);
  const environment = claim.environment;

  if (
    !opportunityId ||
    !userId ||
    !requestId ||
    provisionalQuoteAmount === null ||
    (environment !== 'testnet' && environment !== 'real')
  ) {
    return {
      transportOk: false,
      status: null,
      payload: {
        ok: false,
        code: 'INVALID_CLAIM_PAYLOAD',
        error: 'A reserva não retornou os dados necessários para a execução.',
      },
      rawText: '',
      error: 'A reserva retornou um payload inválido.',
    };
  }

  const url = `${context.supabaseUrl}/functions/v1/binance-trade`;

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.serviceRoleKey}`,
          apikey: context.serviceRoleKey,
          'Content-Type': 'application/json',
          'x-cron-secret': context.cronSecret,
          'x-auto-trade-user-id': userId,
          'x-auto-trade-attempt-id': attemptId,
          'x-idempotency-key': requestId,
          'x-request-id': `${context.requestId}:${opportunityId}`,
        },
        body: JSON.stringify({
          action: 'place_entry_oco',
          opportunity_id: opportunityId,
          request_id: requestId,
          // Valor-base provisório. O binance-trade o substitui pelo valor efetivo
          // reservado pela política de position sizing antes de criar a ordem.
          quote_amount: provisionalQuoteAmount,
          confirm_testnet: environment === 'testnet',
        }),
      },
      BINANCE_TIMEOUT_MS,
    );

    const rawText = await response.text();
    let payload: Record<string, unknown>;

    try {
      const parsed = rawText ? JSON.parse(rawText) : {};
      payload = isRecord(parsed)
        ? parsed
        : { value: parsed };
    } catch {
      payload = {
        ok: false,
        code: 'INVALID_BINANCE_TRADE_RESPONSE',
        error: rawText.slice(0, 2_000),
      };
    }

    return {
      transportOk: true,
      status: response.status,
      payload,
      rawText,
      error: null,
    };
  } catch (error) {
    const aborted =
      error instanceof DOMException && error.name === 'AbortError';
    const message = aborted
      ? 'O motor binance-trade não respondeu dentro do tempo limite.'
      : `Falha de rede ao chamar binance-trade: ${errorMessage(error)}`;

    return {
      transportOk: false,
      status: null,
      payload: {
        ok: false,
        code: aborted
          ? 'BINANCE_TRADE_TIMEOUT'
          : 'BINANCE_TRADE_NETWORK_ERROR',
        error: message,
        execution_status_unknown: true,
      },
      rawText: '',
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Classificação do resultado
// ---------------------------------------------------------------------------

function resolveExecutionResult(
  invocation: BinanceInvocationResult,
): ResolvedExecutionResult {
  const payload = invocation.payload;
  const code =
    payloadString(payload, ['code']) ??
    (invocation.transportOk
      ? `HTTP_${invocation.status ?? 0}`
      : 'BINANCE_TRADE_TRANSPORT_ERROR');

  const message =
    payloadString(payload, ['error', 'message', 'detail']) ??
    invocation.error ??
    'O motor binance-trade não concluiu a solicitação.';

  const orderId = extractOrderId(payload);
  const sizing = extractPositionSizing(payload);
  const payloadOk = payload.ok === true;
  const duplicate = payload.duplicate === true;
  const entryExecuted = payload.entrada_executada === true;
  const protectionConfirmed = payload.protecao_confirmada === true;
  const executionUnknown = payload.execution_status_unknown === true;
  const requiresAttention = payload.requires_manual_attention === true;

  if (
    invocation.transportOk &&
    invocation.status !== null &&
    invocation.status >= 200 &&
    invocation.status < 300 &&
    payloadOk
  ) {
    return {
      finalStatus: duplicate ? 'duplicate' : 'executed',
      disposition: duplicate ? 'duplicate' : 'executed',
      code: duplicate ? 'AUTO_TRADE_DUPLICATE' : 'AUTO_TRADE_EXECUTED',
      message: duplicate
        ? 'A oportunidade já havia sido processada pelo motor Binance.'
        : 'Entrada, dimensionamento e proteção foram confirmados pelo motor Binance.',
      orderId,
      pauseAutoTrade: false,
      sizing,
    };
  }

  const pauseAutoTrade =
    PAUSE_CODES.has(code) ||
    executionUnknown ||
    requiresAttention ||
    (entryExecuted && !protectionConfirmed) ||
    !invocation.transportOk;

  if (
    PERMANENT_BLOCK_CODES.has(code) ||
    (
      invocation.status !== null &&
      invocation.status >= 400 &&
      invocation.status < 500 &&
      !executionUnknown &&
      !entryExecuted
    )
  ) {
    return {
      finalStatus: 'blocked',
      disposition: 'blocked',
      code,
      message,
      orderId,
      pauseAutoTrade,
      sizing,
    };
  }

  return {
    finalStatus: 'failed',
    disposition: 'failed',
    code,
    message,
    orderId,
    pauseAutoTrade,
    sizing,
  };
}

function claimFailureMessage(claim: ClaimPayload): {
  code: string;
  message: string;
} {
  return {
    code:
      typeof claim.code === 'string'
        ? claim.code
        : 'AUTO_TRADE_NOT_CLAIMED',
    message:
      typeof claim.message === 'string'
        ? claim.message
        : 'A oportunidade não pôde ser reservada.',
  };
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

async function processCandidate(
  context: RuntimeContext,
  candidate: Candidate,
  parsed: ParsedRequest,
): Promise<ProcessingItem> {
  const startedAt = Date.now();
  const opportunity = candidate.opportunity;
  let attemptId: string | null = null;
  let provisionalQuoteAmount: number | null = null;
  let claimEnvironment: 'testnet' | 'real' | null = null;

  try {
    const claim = await claimOpportunity(
      context,
      opportunity.id,
      parsed.lockSeconds,
    );

    attemptId = uuidFrom(claim.attempt_id);
    provisionalQuoteAmount = positive(claim.quote_amount);
    claimEnvironment = executionEnvironmentOrNull(claim.environment);

    if (claim.claimed !== true || !attemptId) {
      const failure = claimFailureMessage(claim);
      const previewSizing = settingsSizingPreview(candidate.settings);

      if (previewSizing) {
        previewSizing.execution_environment =
          claimEnvironment ?? previewSizing.execution_environment;
        previewSizing.base_quote_amount =
          provisionalQuoteAmount ?? previewSizing.base_quote_amount;
      }

      return {
        ...processingItemBase(candidate),
        disposition: 'skipped',
        code: failure.code,
        message: failure.message,
        attempt_id: attemptId,
        order_id: uuidFrom(claim.order_id),
        http_status: null,
        ...sizingFields(previewSizing, provisionalQuoteAmount),
        auto_trade_paused:
          failure.code === 'AUTO_TRADE_PAUSED' ||
          failure.code === 'UNPROTECTED_POSITION_EXISTS' ||
          failure.code === 'CONSECUTIVE_LOSS_PAUSE_REQUIRED',
        duration_ms: Date.now() - startedAt,
      };
    }

    const dispatch = await markDispatching(
      context,
      attemptId,
      parsed.lockSeconds,
    );

    if (dispatch.updated !== true) {
      const code =
        typeof dispatch.code === 'string'
          ? dispatch.code
          : 'DISPATCH_STATE_UPDATE_FAILED';
      const message =
        'A tentativa foi reservada, mas não pôde ser marcada para envio.';

      try {
        await finalizeAttempt(context, {
          attemptId,
          status: 'failed',
          orderId: null,
          httpStatus: null,
          errorCode: code,
          errorMessage: message,
          payload: dispatch,
          pauseAutoTrade: false,
        });
      } catch (finalizeError) {
        console.error(
          `[${context.requestId}] falha ao finalizar dispatch inválido:`,
          finalizeError,
        );
      }

      const previewSizing = settingsSizingPreview(candidate.settings);

      if (previewSizing) {
        previewSizing.execution_environment = claimEnvironment;
        previewSizing.base_quote_amount = provisionalQuoteAmount;
      }

      return {
        ...processingItemBase(candidate),
        disposition: 'dispatch_error',
        code,
        message,
        attempt_id: attemptId,
        order_id: null,
        http_status: null,
        ...sizingFields(previewSizing, provisionalQuoteAmount),
        auto_trade_paused: false,
        duration_ms: Date.now() - startedAt,
      };
    }

    const invocation = await invokeBinanceTrade(
      context,
      claim,
      attemptId,
    );
    const resolved = resolveExecutionResult(invocation);

    if (resolved.sizing) {
      resolved.sizing.execution_environment =
        resolved.sizing.execution_environment ?? claimEnvironment;
      resolved.sizing.base_quote_amount =
        resolved.sizing.base_quote_amount ?? provisionalQuoteAmount;
    }

    let finalized: FinalizePayload;

    try {
      finalized = await finalizeAttempt(context, {
        attemptId,
        status: resolved.finalStatus,
        orderId: resolved.orderId,
        httpStatus: invocation.status,
        errorCode:
          resolved.finalStatus === 'executed' ||
          resolved.finalStatus === 'duplicate'
            ? null
            : resolved.code,
        errorMessage:
          resolved.finalStatus === 'executed' ||
          resolved.finalStatus === 'duplicate'
            ? null
            : resolved.message,
        payload: invocation.payload,
        pauseAutoTrade: resolved.pauseAutoTrade,
      });
    } catch (error) {
      return {
        ...processingItemBase(candidate),
        disposition: 'finalize_error',
        code: 'FINALIZE_AUTO_TRADE_FAILED',
        message: errorMessage(error),
        attempt_id: attemptId,
        order_id: resolved.orderId,
        http_status: invocation.status,
        ...sizingFields(resolved.sizing, provisionalQuoteAmount),
        auto_trade_paused: resolved.pauseAutoTrade,
        duration_ms: Date.now() - startedAt,
      };
    }

    if (finalized.updated !== true) {
      return {
        ...processingItemBase(candidate),
        disposition: 'finalize_error',
        code:
          typeof finalized.code === 'string'
            ? finalized.code
            : 'FINALIZE_AUTO_TRADE_REJECTED',
        message: 'A RPC recusou a finalização da tentativa.',
        attempt_id: attemptId,
        order_id: resolved.orderId,
        http_status: invocation.status,
        ...sizingFields(resolved.sizing, provisionalQuoteAmount),
        auto_trade_paused: resolved.pauseAutoTrade,
        duration_ms: Date.now() - startedAt,
      };
    }

    return {
      ...processingItemBase(candidate),
      disposition: resolved.disposition,
      code: resolved.code,
      message: resolved.message,
      attempt_id: attemptId,
      order_id: resolved.orderId,
      http_status: invocation.status,
      ...sizingFields(resolved.sizing, provisionalQuoteAmount),
      auto_trade_paused: resolved.pauseAutoTrade,
      duration_ms: Date.now() - startedAt,
    };
  } catch (error) {
    const message = errorMessage(error);

    if (attemptId) {
      try {
        await finalizeAttempt(context, {
          attemptId,
          status: 'failed',
          orderId: null,
          httpStatus: null,
          errorCode: 'AUTO_TRADE_PROCESSING_ERROR',
          errorMessage: message,
          payload: {
            ok: false,
            code: 'AUTO_TRADE_PROCESSING_ERROR',
            error: message,
          },
          pauseAutoTrade: false,
        });
      } catch (finalizeError) {
        console.error(
          `[${context.requestId}] falha ao finalizar erro de processamento:`,
          finalizeError,
        );
      }
    }

    const previewSizing = settingsSizingPreview(candidate.settings);

    if (previewSizing) {
      previewSizing.execution_environment =
        claimEnvironment ?? previewSizing.execution_environment;
      previewSizing.base_quote_amount =
        provisionalQuoteAmount ?? previewSizing.base_quote_amount;
    }

    return {
      ...processingItemBase(candidate),
      disposition: attemptId ? 'failed' : 'claim_error',
      code: attemptId
        ? 'AUTO_TRADE_PROCESSING_ERROR'
        : 'AUTO_TRADE_CLAIM_ERROR',
      message,
      attempt_id: attemptId,
      order_id: null,
      http_status: null,
      ...sizingFields(previewSizing, provisionalQuoteAmount),
      auto_trade_paused: false,
      duration_ms: Date.now() - startedAt,
    };
  }
}

function dryRunItem(candidate: Candidate): ProcessingItem {
  const opportunity = candidate.opportunity;
  const sizing = settingsSizingPreview(candidate.settings);
  const provisionalQuoteAmount =
    finite(candidate.settings?.auto_trade_quote_amount) ??
    finite(opportunity.quote_amount);

  if (sizing) {
    sizing.base_quote_amount = provisionalQuoteAmount;
  }

  return {
    ...processingItemBase(candidate),
    disposition: 'dry_run',
    code: 'AUTO_TRADE_PRESELECTED',
    message:
      'A oportunidade passou pela pré-seleção. A RPC de reserva ainda aplicará limites, saldo atual, sequência de resultados e dimensionamento antes da execução.',
    attempt_id: null,
    order_id: null,
    http_status: null,
    ...sizingFields(sizing, provisionalQuoteAmount),
    auto_trade_paused: false,
    duration_ms: 0,
  };
}

function countDisposition(
  items: readonly ProcessingItem[],
  disposition: ProcessingDisposition,
): number {
  return items.filter((item) => item.disposition === disposition).length;
}

function sumNullable(
  items: readonly ProcessingItem[],
  selector: (item: ProcessingItem) => number | null,
): number {
  return items.reduce(
    (total, item) => total + (selector(item) ?? 0),
    0,
  );
}

function sizingModeCounts(
  items: readonly ProcessingItem[],
): Record<SizingMode, number> {
  return {
    fixed: items.filter((item) => item.sizing_mode === 'fixed').length,
    anti_martingale: items.filter(
      (item) => item.sizing_mode === 'anti_martingale',
    ).length,
    martingale_testnet: items.filter(
      (item) => item.sizing_mode === 'martingale_testnet',
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const requestId =
    req.headers.get('x-request-id')?.trim().slice(0, 120) ||
    crypto.randomUUID();

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        'X-Request-Id': requestId,
      },
    });
  }

  if (req.method !== 'POST') {
    return errorResponse(
      405,
      'Método não permitido.',
      'METHOD_NOT_ALLOWED',
      requestId,
      { allowed: ['POST', 'OPTIONS'] },
    );
  }

  const authentication = authenticateInternal(req, requestId);

  if (authentication instanceof Response) {
    return authentication;
  }

  const context = authentication;
  const startedAt = Date.now();

  try {
    const body = await readBody(req);
    const parsed = parseRequest(body);

    const abandonedLocks = parsed.dryRun
      ? 0
      : await abandonExpiredLocks(context.admin);

    const candidates = await loadCandidates(context.admin, parsed);

    if (parsed.opportunityId && candidates.length === 0) {
      return errorResponse(
        404,
        'Oportunidade não encontrada.',
        'OPPORTUNITY_NOT_FOUND',
        requestId,
      );
    }

    const selected = candidates.slice(0, parsed.limit);
    const items: ProcessingItem[] = [];

    if (parsed.dryRun) {
      items.push(...selected.map(dryRunItem));
    } else {
      // Processamento sequencial: uma operação precisa registrar a ordem,
      // dimensionamento e proteção antes de avançar para outro usuário.
      for (const candidate of selected) {
        items.push(
          await processCandidate(context, candidate, parsed),
        );
      }
    }

    const executed = countDisposition(items, 'executed');
    const duplicate = countDisposition(items, 'duplicate');
    const blocked = countDisposition(items, 'blocked');
    const failed =
      countDisposition(items, 'failed') +
      countDisposition(items, 'claim_error') +
      countDisposition(items, 'dispatch_error') +
      countDisposition(items, 'finalize_error');
    const skipped = countDisposition(items, 'skipped');
    const dryRun = countDisposition(items, 'dry_run');
    const paused = items.filter(
      (item) => item.auto_trade_paused,
    ).length;
    const partial = failed > 0 || blocked > 0;
    const durationMs = Date.now() - startedAt;

    const riskSummary = {
      sizing_modes: sizingModeCounts(items),
      provisional_quote_amount_usdt: sumNullable(
        items,
        (item) => item.provisional_quote_amount_usdt,
      ),
      effective_quote_amount_usdt: sumNullable(
        items,
        (item) => item.effective_quote_amount_usdt,
      ),
      planned_risk_usdt: sumNullable(
        items,
        (item) => item.planned_risk_usdt,
      ),
      actual_risk_usdt: sumNullable(
        items,
        (item) => item.actual_risk_usdt,
      ),
      decisions_created_or_reused: items.filter(
        (item) => item.position_sizing_decision_id !== null,
      ).length,
    };

    console.log(
      JSON.stringify({
        event: 'executar_auto_trade',
        engine_version: '3.0.0-position-sizing',
        request_id: requestId,
        worker_id: context.workerId,
        opportunity_id: parsed.opportunityId,
        user_id: parsed.userId,
        dry_run: parsed.dryRun,
        candidates: candidates.length,
        selected: selected.length,
        executed,
        duplicate,
        blocked,
        failed,
        skipped,
        paused,
        abandoned_locks: abandonedLocks,
        risk_summary: riskSummary,
        duration_ms: durationMs,
      }),
    );

    return jsonResponse(
      {
        ok: failed === 0,
        partial,
        request_id: requestId,
        worker_id: context.workerId,
        engine_version: '3.0.0-position-sizing',
        dry_run: parsed.dryRun,
        filters: {
          opportunity_id: parsed.opportunityId,
          user_id: parsed.userId,
          limit: parsed.limit,
          scan_limit: parsed.scanLimit,
          lock_seconds: parsed.lockSeconds,
        },
        summary: {
          candidates: candidates.length,
          selected: selected.length,
          executed,
          duplicate,
          blocked,
          failed,
          skipped,
          dry_run: dryRun,
          users_paused: paused,
          abandoned_locks: abandonedLocks,
        },
        risk_summary: riskSummary,
        items,
        generated_at: new Date().toISOString(),
        duration_ms: durationMs,
      },
      requestId,
      200,
    );
  } catch (error) {
    const message = errorMessage(error);

    console.error(`[${requestId}] executar-auto-trade:`, error);

    const inputError = [
      'opportunity_id',
      'user_id',
      'limit',
      'scan_limit',
      'lock_seconds',
      'dry_run',
      'Campo não suportado',
      'JSON',
      'Corpo da requisição',
    ].some((fragment) => message.includes(fragment));

    return errorResponse(
      inputError ? 400 : 500,
      inputError
        ? message
        : 'Não foi possível executar o Auto Trade.',
      inputError
        ? 'INVALID_INPUT'
        : 'AUTO_TRADE_EXECUTION_ERROR',
      requestId,
      inputError ? undefined : { message },
    );
  }
});