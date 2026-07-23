// ============================================================================
// VigIA Trade — Edge Function: binance-trade v10
// supabase/functions/binance-trade/index.ts
// ============================================================================
//
// Ações autenticadas:
//   save_keys       { api_key, api_secret, is_testnet }
//   delete_keys     {}
//   test_connection {}
//   open_orders     { symbol }
//   place_entry_oco {
//     symbol?, quote_amount, stop_pct?, target_pct?, request_id?,
//     opportunity_id?, confirm_testnet?
//   }
//
// Integração com a Central de Oportunidades:
// - opportunity_id é opcional para manter compatibilidade com a tela Conta
//   Binance e com executar-daytrade-testnet;
// - quando informado, símbolo, stop, alvo, validade, ambiente e limite máximo de
//   entrada são revalidados no servidor a partir do snapshot imutável;
// - a oportunidade precisa ter sido aceita e estar em revalidação;
// - a ordem recebe opportunity_id e request_id idempotente;
// - o lifecycle é atualizado para opening/open/error e os eventos são auditados;
// - o resultado executado é criado separadamente do resultado teórico.
//
// Segurança operacional:
// - publique com verify_jwt = true;
// - chamadas comuns usam o JWT do usuário;
// - chamadas do Auto Trade exigem simultaneamente service_role, CRON_SECRET,
//   user_id e attempt_id válidos;
// - api_secret fica cifrado em AES-256-GCM no banco;
// - limites de user_settings são validados novamente no servidor;
// - operações reais continuam bloqueadas quando trading_real_enabled=false;
// - a execução real automática só é aceita após a reserva atômica do Auto Trade
//   e continua sujeita a trading_real_enabled e aos demais limites de risco;
// - oportunidades usam position_sizing_decisions antes da reserva da ordem;
// - o valor efetivo pode permanecer fixo, seguir anti-martingale conservador
//   ou martingale exclusivamente na Testnet, conforme user_settings;
// - a decisão é vinculada à oportunidade, tentativa automática, ordem e outcome;
// - toda compra é registrada localmente antes do envio;
// - timeout/5xx da Binance é tratado como estado desconhecido e reconciliado
//   pelo newClientOrderId, nunca como falha definitiva automática;
// - compra executada sem OCO confirmada vira entrada_sem_protecao e exige ação
//   manual imediata, sem permitir uma nova compra silenciosa.
//
// Secrets:
//   ENCRYPTION_KEY — 64 caracteres hexadecimais.
//   CRON_SECRET — segredo compartilhado com executar-auto-trade.
//   SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY são injetados.
// ============================================================================

import {
  createClient,
  type SupabaseClient,
} from 'jsr:@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type Action =
  | 'save_keys'
  | 'delete_keys'
  | 'test_connection'
  | 'open_orders'
  | 'place_entry_oco';

type OrderStatus =
  | 'pendente'
  | 'entrada_enviada'
  | 'entrada_executada'
  | 'protecao_pendente'
  | 'oco_ativa'
  | 'entrada_sem_protecao'
  | 'alvo_executado'
  | 'stop_executado'
  | 'cancelada'
  | 'erro_pre_entrada'
  | 'erro';

interface RequestBody {
  action?: unknown;
  api_key?: unknown;
  api_secret?: unknown;
  is_testnet?: unknown;
  symbol?: unknown;
  quote_amount?: unknown;
  stop_pct?: unknown;
  target_pct?: unknown;
  request_id?: unknown;
  opportunity_id?: unknown;
  confirm_testnet?: unknown;
}

interface ExchangeKeysRow {
  user_id: string;
  api_key: string;
  api_secret_enc: string;
  is_testnet: boolean;
}

interface UserSettingsRow {
  trading_real_enabled: boolean | null;
  max_order_usdt: number | string | null;
  max_open_orders: number | string | null;
  max_daily_loss_usdt: number | string | null;
  min_stop_pct: number | string | null;
  max_stop_pct: number | string | null;
  min_target_pct: number | string | null;
  max_target_pct: number | string | null;
}

interface ResolvedRiskSettings {
  tradingRealEnabled: boolean;
  maxOrderUsdt: number;
  maxOpenOrders: number;
  maxDailyLossUsdt: number;
  minStopPct: number;
  maxStopPct: number;
  minTargetPct: number;
  maxTargetPct: number;
}

interface TradeOpportunityRow {
  id: string;
  user_id: string;
  source_type: string;
  source_id: string;
  opportunity_type: string;
  provider: string;
  symbol: string;
  timeframe: string;
  direction: string;
  quote_asset: string;
  strategy: string;
  strategy_version: string;
  lifecycle_status: string;
  entry_decision: string;
  execution_environment: string;
  quote_amount: number | string | null;
  detected_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  opened_at: string | null;
  entry_reference: number | string | null;
  maximum_entry_price: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  gross_risk_reward: number | string | null;
  source_snapshot: Record<string, unknown> | null;
  market_snapshot: Record<string, unknown> | null;
  plan_snapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  position_sizing_decision_id: string | null;
  sizing_snapshot: Record<string, unknown> | null;
}

interface OrderRow {
  id: string;
  user_id: string;
  opportunity_id: string | null;
  is_testnet: boolean;
  symbol: string;
  quote_amount: number | string;
  qty: number | string | null;
  entry_price: number | string | null;
  stop_price: number | string | null;
  target_price: number | string | null;
  entry_order_id: number | string | null;
  oco_list_id: number | string | null;
  status: OrderStatus;
  erro: string | null;
  raw: Record<string, unknown> | null;
  criado_em: string;
  exit_price: number | string | null;
  pnl_usdt: number | string | null;
  fechado_em: string | null;
  request_id: string;
  client_order_id: string | null;
  list_client_order_id: string | null;
  protected_at: string | null;
  last_checked_at: string | null;
  binance_status: string | null;
  unprotected_reason: string | null;
  position_sizing_decision_id: string | null;
  sizing_mode: 'fixed' | 'anti_martingale' | 'martingale_testnet';
  base_risk_percent: number | string | null;
  target_risk_percent: number | string | null;
  applied_risk_percent: number | string | null;
  risk_multiplier: number | string;
  planned_risk_usdt: number | string | null;
  actual_risk_usdt: number | string | null;
  sizing_snapshot: Record<string, unknown> | null;
}

interface BinanceContext {
  base: string;
  apiKey: string;
  secret: string;
  offset: number;
  isTestnet: boolean;
}

interface BinanceBalance {
  asset?: string;
  free?: string;
  locked?: string;
}

interface BinanceAccount {
  canTrade?: boolean;
  balances?: BinanceBalance[];
}

interface BinanceFill {
  price?: string;
  qty?: string;
  commission?: string;
  commissionAsset?: string;
  tradeId?: number;
}

interface BinanceOrder {
  symbol?: string;
  orderId?: number;
  orderListId?: number;
  clientOrderId?: string;
  transactTime?: number;
  price?: string;
  origQty?: string;
  executedQty?: string;
  origQuoteOrderQty?: string;
  cummulativeQuoteQty?: string;
  status?: string;
  timeInForce?: string;
  type?: string;
  side?: string;
  fills?: BinanceFill[];
}

interface BinanceOrderList {
  orderListId?: number;
  contingencyType?: string;
  listStatusType?: string;
  listOrderStatus?: string;
  listClientOrderId?: string;
  transactionTime?: number;
  symbol?: string;
  orders?: Array<{
    symbol?: string;
    orderId?: number;
    clientOrderId?: string;
  }>;
  orderReports?: BinanceOrder[];
}

interface SymbolRules {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  spotAllowed: boolean;
  quoteOrderQtyMarketAllowed: boolean;
  tickSize: number;
  tickSizeText: string;
  stepSize: number;
  stepSizeText: string;
  minQty: number;
  maxQty: number;
  minNotional: number;
  maxNotional: number | null;
}

interface ResolvedTradeRequest {
  opportunity: TradeOpportunityRow | null;
  opportunityId: string | null;
  requestId: string;
  symbol: string;
  quoteAmount: number;
  stopPct: number;
  targetPct: number;
  referenceEntry: number | null;
  referenceStop: number | null;
  referenceTarget: number | null;
  maximumEntryPrice: number | null;
  breakoutLevel: number | null;
  confirmTestnet: boolean;
}

interface EntrySummary {
  quantity: number;
  quoteSpent: number;
  averagePrice: number;
  entryOrderId: number;
  entryClientOrderId: string;
  entryAt: string;
  feesUsdt: number;
  unresolvedFees: Array<{
    asset: string;
    amount: number;
  }>;
}

interface ProtectionSummary {
  quantity: number;
  targetPrice: number;
  stopTrigger: number;
  stopLimit: number;
  ocoListId: number;
  listClientOrderId: string;
  protectedAt: string;
}

interface ReservedOrderResult {
  order: OrderRow;
  duplicate: boolean;
}

interface JsonErrorPayload {
  ok: false;
  error: string;
  code: string;
  detail?: string;
  request_id?: string;
  order_id?: string;
  opportunity_id?: string;
  status?: string;
  entrada_executada?: boolean;
  protecao_confirmada?: boolean;
  execution_status_unknown?: boolean;
  requires_manual_attention?: boolean;
  position_sizing?: Record<string, unknown> | null;
  order?: OrderRow | null;
  details?: unknown;
}

type AuthenticationMode = 'user' | 'auto_trade';

interface AutoTradeAttemptRow {
  id: string;
  user_id: string;
  opportunity_id: string;
  request_id: string;
  status: string;
  execution_environment: 'testnet' | 'real';
  quote_amount: number | string;
  lock_expires_at: string;
  position_sizing_decision_id: string | null;
  sizing_mode: 'fixed' | 'anti_martingale' | 'martingale_testnet';
  effective_quote_amount: number | string | null;
  planned_risk_usdt: number | string | null;
  sizing_snapshot: Record<string, unknown> | null;
}

interface PositionSizingDecisionRow {
  id: string;
  user_id: string;
  opportunity_id: string | null;
  auto_trade_attempt_id: string | null;
  order_id: string | null;
  request_id: string;
  source:
    | 'manual_opportunity'
    | 'manual_daytrade_testnet'
    | 'manual_order'
    | 'auto_trade'
    | 'system_recovery';
  status: 'reserved' | 'applied' | 'cancelled' | 'failed';
  execution_environment: 'testnet' | 'real';
  sizing_mode: 'fixed' | 'anti_martingale' | 'martingale_testnet';
  sizing_scope: 'account' | 'strategy' | 'symbol' | 'symbol_timeframe';
  policy_version: string;
  base_quote_amount: number | string | null;
  available_balance_usdt: number | string | null;
  balance_usage_limit_pct: number | string;
  base_risk_percent: number | string;
  target_risk_percent: number | string | null;
  applied_risk_percent: number | string | null;
  risk_multiplier: number | string;
  sequence_step: number;
  consecutive_wins: number;
  consecutive_losses: number;
  account_consecutive_wins: number;
  account_consecutive_losses: number;
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
  policy_snapshot: Record<string, unknown> | null;
  result_snapshot: Record<string, unknown> | null;
  applied_at: string | null;
}

interface PositionSizingContext {
  decision: PositionSizingDecisionRow;
  effectiveQuoteAmount: number;
  plannedRiskUsdt: number | null;
  summary: Record<string, unknown>;
}

interface AuthenticationContext {
  mode: AuthenticationMode;
  userId: string;
  autoTradeAttempt: AutoTradeAttemptRow | null;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const REAL_BASE = 'https://api.binance.com';
const TESTNET_BASE = 'https://testnet.binance.vision';

const PUBLIC_MARKET_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const MAX_BODY_BYTES = 24_576;
const FETCH_TIMEOUT_MS = 12_000;
const TRADE_TIMEOUT_MS = 15_000;
const RECV_WINDOW_MS = 5_000;
const RECONCILIATION_ATTEMPTS = 4;
const RECONCILIATION_DELAY_MS = 600;
const STOP_LIMIT_BUFFER_PCT = 0.1;

const DEFAULT_RISK_SETTINGS: ResolvedRiskSettings = {
  tradingRealEnabled: false,
  maxOrderUsdt: 100,
  maxOpenOrders: 3,
  maxDailyLossUsdt: 50,
  minStopPct: 0.2,
  maxStopPct: 15,
  minTargetPct: 0.2,
  maxTargetPct: 50,
};

const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  'pendente',
  'entrada_enviada',
  'entrada_executada',
  'protecao_pendente',
  'entrada_sem_protecao',
  'oco_ativa',
];

const TERMINAL_BINANCE_ORDER_STATUSES = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;

const ORDER_SELECT = [
  'id',
  'user_id',
  'opportunity_id',
  'is_testnet',
  'symbol',
  'quote_amount',
  'qty',
  'entry_price',
  'stop_price',
  'target_price',
  'entry_order_id',
  'oco_list_id',
  'status',
  'erro',
  'raw',
  'criado_em',
  'exit_price',
  'pnl_usdt',
  'fechado_em',
  'request_id',
  'client_order_id',
  'list_client_order_id',
  'protected_at',
  'last_checked_at',
  'binance_status',
  'unprotected_reason',
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

const OPPORTUNITY_SELECT = [
  'id',
  'user_id',
  'source_type',
  'source_id',
  'opportunity_type',
  'provider',
  'symbol',
  'timeframe',
  'direction',
  'quote_asset',
  'strategy',
  'strategy_version',
  'lifecycle_status',
  'entry_decision',
  'execution_environment',
  'quote_amount',
  'detected_at',
  'expires_at',
  'accepted_at',
  'opened_at',
  'entry_reference',
  'maximum_entry_price',
  'stop_reference',
  'target_reference',
  'gross_risk_reward',
  'source_snapshot',
  'market_snapshot',
  'plan_snapshot',
  'metadata',
  'position_sizing_decision_id',
  'sizing_snapshot',
].join(',');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-idempotency-key, x-request-id, x-cron-secret, x-auto-trade-user-id, x-auto-trade-attempt-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// Erros e respostas
// ---------------------------------------------------------------------------

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

class BinanceRequestError extends Error {
  readonly status: number | null;
  readonly code: number | null;
  readonly payload: unknown;
  readonly uncertain: boolean;

  constructor(options: {
    message: string;
    status?: number | null;
    code?: number | null;
    payload?: unknown;
    uncertain?: boolean;
  }) {
    super(options.message);
    this.name = 'BinanceRequestError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.payload = options.payload ?? null;
    this.uncertain = options.uncertain ?? false;
  }
}

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
  requestId: string,
  status: number,
  error: string,
  code: string,
  extras: Omit<JsonErrorPayload, 'ok' | 'error' | 'code'> = {},
): Response {
  return jsonResponse(
    {
      ok: false,
      error,
      code,
      ...extras,
    } satisfies JsonErrorPayload,
    requestId,
    status,
  );
}

function truncate(value: unknown, max = 1_000): string {
  return String(value ?? '').slice(0, max);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Erro desconhecido.';
}

// ---------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------

async function readBody(req: Request): Promise<RequestBody> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BODY_BYTES
  ) {
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

  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);

    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('not-object');
    }

    return parsed as RequestBody;
  } catch {
    throw new RequestError(
      400,
      'INVALID_JSON',
      'JSON inválido.',
    );
  }
}

function parseAction(value: unknown): Action {
  const action = String(value ?? '').trim() as Action;

  if (
    action === 'save_keys' ||
    action === 'delete_keys' ||
    action === 'test_connection' ||
    action === 'open_orders' ||
    action === 'place_entry_oco'
  ) {
    return action;
  }

  throw new RequestError(
    400,
    'UNKNOWN_ACTION',
    `Ação desconhecida: ${truncate(value, 80) || 'vazia'}.`,
  );
}

function parseUuid(
  value: unknown,
  field: string,
  optional = false,
): string | null {
  if (value === undefined || value === null || value === '') {
    if (optional) {
      return null;
    }

    throw new RequestError(
      400,
      'INVALID_UUID',
      `${field} é obrigatório.`,
    );
  }

  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new RequestError(
      400,
      'INVALID_UUID',
      `${field} deve ser um UUID válido.`,
    );
  }

  return value.trim().toLowerCase();
}

function parseSymbol(value: unknown, fallback?: string): string {
  const symbol = String(value ?? fallback ?? '')
    .trim()
    .toUpperCase();

  if (!SYMBOL_PATTERN.test(symbol) || !symbol.endsWith('USDT')) {
    throw new RequestError(
      400,
      'INVALID_SYMBOL',
      'symbol deve ser um par Spot válido cotado em USDT.',
    );
  }

  return symbol;
}

function parsePositiveNumber(
  value: unknown,
  field: string,
): number {
  const number = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    throw new RequestError(
      400,
      'INVALID_NUMBER',
      `${field} deve ser maior que zero.`,
    );
  }

  return number;
}

function optionalPositiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseApiCredential(
  value: unknown,
  field: 'api_key' | 'api_secret',
): string {
  if (typeof value !== 'string') {
    throw new RequestError(
      400,
      'INVALID_CREDENTIAL',
      `${field} deve ser uma string.`,
    );
  }

  const credential = value.trim();

  if (
    credential.length < 10 ||
    credential.length > 256 ||
    /\s/.test(credential)
  ) {
    throw new RequestError(
      400,
      'INVALID_CREDENTIAL',
      `${field} possui formato inválido.`,
    );
  }

  return credential;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value: unknown): number | null {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

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

function safeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Autenticação de usuário e Auto Trade
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

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get('Authorization') ?? '';

  if (!authorization.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

async function authenticateInvocation(options: {
  req: Request;
  requestId: string;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  admin: SupabaseClient;
}): Promise<AuthenticationContext> {
  const {
    req,
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    admin,
  } = options;

  const token = bearerToken(req);

  if (!token) {
    throw new RequestError(
      401,
      'UNAUTHORIZED',
      'Usuário não autenticado.',
    );
  }

  const suppliedCronSecret =
    req.headers.get('x-cron-secret')?.trim() ?? '';
  const suppliedUserId =
    req.headers.get('x-auto-trade-user-id')?.trim() ?? '';
  const suppliedAttemptId =
    req.headers.get('x-auto-trade-attempt-id')?.trim() ?? '';

  const internalRequested = Boolean(
    suppliedCronSecret || suppliedUserId || suppliedAttemptId,
  );

  if (internalRequested) {
    const configuredCronSecret = Deno.env.get('CRON_SECRET') ?? '';

    if (
      !configuredCronSecret ||
      !suppliedCronSecret ||
      !suppliedUserId ||
      !suppliedAttemptId ||
      !timingSafeEqual(token, serviceRoleKey) ||
      !timingSafeEqual(suppliedCronSecret, configuredCronSecret)
    ) {
      throw new RequestError(
        403,
        'INVALID_AUTO_TRADE_CREDENTIAL',
        'Credencial interna do Auto Trade inválida ou incompleta.',
      );
    }

    const userId = parseUuid(
      suppliedUserId,
      'x-auto-trade-user-id',
    ) as string;
    const attemptId = parseUuid(
      suppliedAttemptId,
      'x-auto-trade-attempt-id',
    ) as string;

    const { data, error } = await admin
      .from('auto_trade_attempts')
      .select(
        'id,user_id,opportunity_id,request_id,status,execution_environment,quote_amount,lock_expires_at,position_sizing_decision_id,sizing_mode,effective_quote_amount,planned_risk_usdt,sizing_snapshot',
      )
      .eq('id', attemptId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      throw new RequestError(
        500,
        'AUTO_TRADE_ATTEMPT_QUERY_FAILED',
        `Não foi possível validar a tentativa automática: ${error.message}`,
      );
    }

    if (!data) {
      throw new RequestError(
        403,
        'AUTO_TRADE_ATTEMPT_NOT_FOUND',
        'Tentativa automática não encontrada para o usuário informado.',
      );
    }

    const attempt = data as AutoTradeAttemptRow;

    if (attempt.status !== 'dispatching') {
      throw new RequestError(
        409,
        'AUTO_TRADE_ATTEMPT_NOT_DISPATCHING',
        'A tentativa automática não está autorizada para envio.',
        { status: attempt.status },
      );
    }

    if (Date.parse(attempt.lock_expires_at) <= Date.now()) {
      throw new RequestError(
        409,
        'AUTO_TRADE_LOCK_EXPIRED',
        'O bloqueio da tentativa automática expirou antes da execução.',
        { lock_expires_at: attempt.lock_expires_at },
      );
    }

    if (attempt.request_id !== attempt.opportunity_id) {
      throw new RequestError(
        409,
        'AUTO_TRADE_IDEMPOTENCY_INVALID',
        'A tentativa automática possui uma chave idempotente inválida.',
      );
    }

    return {
      mode: 'auto_trade',
      userId,
      autoTradeAttempt: attempt,
    };
  }

  const authorization = `Bearer ${token}`;
  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: { Authorization: authorization },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error,
  } = await userClient.auth.getUser(token);

  if (error || !user) {
    throw new RequestError(
      401,
      'INVALID_SESSION',
      'Sessão inválida ou expirada.',
    );
  }

  return {
    mode: 'user',
    userId: user.id,
    autoTradeAttempt: null,
  };
}

function assertAutoTradeInvocation(options: {
  req: Request;
  auth: AuthenticationContext;
  action: Action;
  body: RequestBody;
}): void {
  const { req, auth, action, body } = options;

  if (auth.mode !== 'auto_trade') {
    return;
  }

  const attempt = auth.autoTradeAttempt;

  if (!attempt) {
    throw new RequestError(
      500,
      'AUTO_TRADE_CONTEXT_MISSING',
      'Contexto interno do Auto Trade ausente.',
    );
  }

  if (action !== 'place_entry_oco') {
    throw new RequestError(
      403,
      'AUTO_TRADE_ACTION_NOT_ALLOWED',
      'O Auto Trade só pode executar a ação place_entry_oco.',
    );
  }

  const opportunityId = parseUuid(
    body.opportunity_id,
    'opportunity_id',
  ) as string;
  const requestId = parseUuid(
    body.request_id,
    'request_id',
  ) as string;
  const headerRequestId = parseUuid(
    req.headers.get('x-idempotency-key'),
    'x-idempotency-key',
  ) as string;
  const quoteAmount = parsePositiveNumber(
    body.quote_amount,
    'quote_amount',
  );
  const expectedAmount = parsePositiveNumber(
    attempt.quote_amount,
    'auto_trade_attempts.quote_amount',
  );

  if (
    opportunityId !== attempt.opportunity_id ||
    requestId !== attempt.request_id ||
    headerRequestId !== attempt.request_id
  ) {
    throw new RequestError(
      409,
      'AUTO_TRADE_REQUEST_MISMATCH',
      'A solicitação não corresponde à oportunidade reservada.',
      {
        attempt_id: attempt.id,
        expected_opportunity_id: attempt.opportunity_id,
        expected_request_id: attempt.request_id,
      },
    );
  }

  if (Math.abs(quoteAmount - expectedAmount) > 0.00000001) {
    throw new RequestError(
      409,
      'AUTO_TRADE_AMOUNT_MISMATCH',
      'O valor da solicitação não corresponde ao valor reservado.',
      {
        supplied_quote_amount: quoteAmount,
        expected_quote_amount: expectedAmount,
      },
    );
  }

  if (
    attempt.execution_environment === 'testnet' &&
    body.confirm_testnet !== true
  ) {
    throw new RequestError(
      409,
      'AUTO_TRADE_ENVIRONMENT_MISMATCH',
      'A tentativa reservada exige confirmação da Testnet.',
    );
  }

  if (
    attempt.execution_environment === 'real' &&
    body.confirm_testnet === true
  ) {
    throw new RequestError(
      409,
      'AUTO_TRADE_ENVIRONMENT_MISMATCH',
      'A tentativa reservada pertence ao ambiente real.',
    );
  }
}

// ---------------------------------------------------------------------------
// Cifra AES-256-GCM
// ---------------------------------------------------------------------------

async function getAesKey(): Promise<CryptoKey> {
  const hex = Deno.env.get('ENCRYPTION_KEY');

  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new RequestError(
      500,
      'ENCRYPTION_CONFIG_ERROR',
      'ENCRYPTION_KEY ausente ou inválida.',
    );
  }

  const pairs = hex.match(/.{2}/g);

  if (!pairs) {
    throw new RequestError(
      500,
      'ENCRYPTION_CONFIG_ERROR',
      'ENCRYPTION_KEY inválida.',
    );
  }

  const raw = new Uint8Array(
    pairs.map((byte) => Number.parseInt(byte, 16)),
  );

  return crypto.subtle.importKey(
    'raw',
    raw,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encrypt(plain: string): Promise<string> {
  const key = await getAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );

  const output = new Uint8Array(iv.length + encrypted.length);
  output.set(iv, 0);
  output.set(encrypted, iv.length);

  let binary = '';
  for (const byte of output) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function decrypt(ciphertext: string): Promise<string> {
  let bytes: Uint8Array;

  try {
    bytes = Uint8Array.from(
      atob(ciphertext),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new RequestError(
      500,
      'DECRYPTION_ERROR',
      'Credencial criptografada inválida.',
    );
  }

  if (bytes.length <= 12) {
    throw new RequestError(
      500,
      'DECRYPTION_ERROR',
      'Credencial criptografada inválida.',
    );
  }

  const key = await getAesKey();

  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes.slice(0, 12),
      },
      key,
      bytes.slice(12),
    );

    return new TextDecoder().decode(plain);
  } catch {
    throw new RequestError(
      500,
      'DECRYPTION_ERROR',
      'Não foi possível descriptografar a credencial Binance.',
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP e assinatura Binance
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
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

async function hmacSign(
  secret: string,
  query: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(query),
  );

  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getTimeOffset(base: string): Promise<number> {
  try {
    const response = await fetchWithTimeout(
      `${base}/api/v3/time`,
      { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const serverTime = finite(payload?.serverTime);

    if (serverTime === null) {
      throw new Error('serverTime ausente');
    }

    return serverTime - Date.now();
  } catch (error) {
    throw new BinanceRequestError({
      message: `Não foi possível sincronizar o horário da Binance: ${errorMessage(error)}`,
      uncertain: false,
    });
  }
}

function encodedParams(
  params: Record<string, string | number | boolean>,
): URLSearchParams {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }

  return search;
}

async function signedRequest<T = Record<string, unknown>>(
  context: BinanceContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean>,
  timeoutMs = method === 'GET' ? FETCH_TIMEOUT_MS : TRADE_TIMEOUT_MS,
): Promise<T> {
  const search = encodedParams({
    ...params,
    timestamp: Date.now() + context.offset,
    recvWindow: RECV_WINDOW_MS,
  });

  search.append(
    'signature',
    await hmacSign(context.secret, search.toString()),
  );

  const url = `${context.base}${path}?${search.toString()}`;
  let response: Response;

  try {
    response = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          'X-MBX-APIKEY': context.apiKey,
          Accept: 'application/json',
        },
      },
      timeoutMs,
    );
  } catch (error) {
    const aborted =
      error instanceof DOMException && error.name === 'AbortError';

    throw new BinanceRequestError({
      message: aborted
        ? `A Binance não respondeu a tempo em ${path}.`
        : `Falha de rede ao acessar a Binance em ${path}: ${errorMessage(error)}`,
      uncertain: method !== 'GET',
      payload: {
        path,
        network_error: errorMessage(error),
      },
    });
  }

  const text = await response.text();
  let payload: Record<string, unknown>;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {
      msg: text.slice(0, 500),
    };
  }

  if (!response.ok) {
    const code = finite(payload.code);
    const message = truncate(
      payload.msg ?? payload.message ?? text,
      500,
    );
    const uncertain =
      method !== 'GET' &&
      (
        response.status >= 500 ||
        code === -1007
      );

    throw new BinanceRequestError({
      status: response.status,
      code,
      payload,
      uncertain,
      message: `Binance ${response.status} em ${path}: ${message}`,
    });
  }

  return payload as T;
}

async function publicJson(
  url: string,
): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
      },
    });
  } catch (error) {
    throw new BinanceRequestError({
      message: `Falha de rede ao consultar dados públicos da Binance: ${errorMessage(error)}`,
      uncertain: false,
    });
  }

  const text = await response.text();
  let payload: Record<string, unknown>;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { msg: text.slice(0, 500) };
  }

  if (!response.ok) {
    throw new BinanceRequestError({
      status: response.status,
      code: finite(payload.code),
      payload,
      uncertain: false,
      message: `Binance pública ${response.status}: ${truncate(payload.msg ?? text, 500)}`,
    });
  }

  return payload;
}

async function getPublicPrice(symbol: string): Promise<{
  price: number;
  source: string;
}> {
  const failures: string[] = [];

  for (const base of PUBLIC_MARKET_BASES) {
    const url = new URL('/api/v3/ticker/price', base);
    url.searchParams.set('symbol', symbol);

    try {
      const payload = await publicJson(url.toString());
      const price = positive(payload.price);

      if (price === null) {
        throw new Error('preço inválido');
      }

      return { price, source: base };
    } catch (error) {
      failures.push(`${base}: ${errorMessage(error)}`);
    }
  }

  throw new RequestError(
    502,
    'PUBLIC_PRICE_UNAVAILABLE',
    'Não foi possível consultar o preço público atual.',
    failures,
  );
}

async function getSymbolRules(
  base: string,
  symbol: string,
): Promise<SymbolRules> {
  const url = new URL('/api/v3/exchangeInfo', base);
  url.searchParams.set('symbol', symbol);

  const payload = await publicJson(url.toString());
  const symbols = Array.isArray(payload.symbols)
    ? payload.symbols
    : [];
  const market = symbols[0];

  if (!isRecord(market)) {
    throw new RequestError(
      409,
      'SYMBOL_NOT_FOUND',
      `O par ${symbol} não existe neste ambiente da Binance.`,
    );
  }

  const filters = Array.isArray(market.filters)
    ? market.filters.filter(isRecord)
    : [];

  const priceFilter = filters.find(
    (filter) => filter.filterType === 'PRICE_FILTER',
  );

  const marketLot = filters.find(
    (filter) => filter.filterType === 'MARKET_LOT_SIZE',
  );

  const lot = filters.find(
    (filter) => filter.filterType === 'LOT_SIZE',
  );

  const selectedLot =
    positive(marketLot?.stepSize) !== null
      ? marketLot
      : lot;

  const notional = filters.find(
    (filter) =>
      filter.filterType === 'NOTIONAL' ||
      filter.filterType === 'MIN_NOTIONAL',
  );

  const tickSizeText = String(priceFilter?.tickSize ?? '0');
  const stepSizeText = String(selectedLot?.stepSize ?? '0');
  const tickSize = positive(tickSizeText);
  const stepSize = positive(stepSizeText);

  if (tickSize === null || stepSize === null) {
    throw new RequestError(
      502,
      'INVALID_EXCHANGE_FILTERS',
      'A Binance não retornou filtros válidos de preço e quantidade.',
    );
  }

  return {
    symbol: String(market.symbol ?? symbol),
    baseAsset: String(market.baseAsset ?? ''),
    quoteAsset: String(market.quoteAsset ?? ''),
    status: String(market.status ?? ''),
    spotAllowed: market.isSpotTradingAllowed !== false,
    quoteOrderQtyMarketAllowed:
      market.quoteOrderQtyMarketAllowed !== false,
    tickSize,
    tickSizeText,
    stepSize,
    stepSizeText,
    minQty: positive(selectedLot?.minQty) ?? stepSize,
    maxQty:
      positive(selectedLot?.maxQty) ?? Number.MAX_SAFE_INTEGER,
    minNotional: positive(notional?.minNotional) ?? 0,
    maxNotional: positive(notional?.maxNotional),
  };
}

async function getOrderByClientId(
  context: BinanceContext,
  symbol: string,
  clientOrderId: string,
): Promise<BinanceOrder | null> {
  try {
    return await signedRequest<BinanceOrder>(
      context,
      'GET',
      '/api/v3/order',
      {
        symbol,
        origClientOrderId: clientOrderId,
      },
    );
  } catch (error) {
    if (
      error instanceof BinanceRequestError &&
      (error.code === -2011 || error.code === -2013)
    ) {
      return null;
    }

    throw error;
  }
}

async function getOrderListByClientId(
  context: BinanceContext,
  listClientOrderId: string,
): Promise<BinanceOrderList | null> {
  try {
    return await signedRequest<BinanceOrderList>(
      context,
      'GET',
      '/api/v3/orderList',
      {
        origClientOrderId: listClientOrderId,
      },
    );
  } catch (error) {
    if (
      error instanceof BinanceRequestError &&
      (error.code === -2011 || error.code === -2013)
    ) {
      return null;
    }

    throw error;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendEntryWithReconciliation(
  context: BinanceContext,
  params: Record<string, string | number | boolean>,
  symbol: string,
  clientOrderId: string,
): Promise<{
  order: BinanceOrder | null;
  initialError: BinanceRequestError | null;
  reconciled: boolean;
}> {
  try {
    const order = await signedRequest<BinanceOrder>(
      context,
      'POST',
      '/api/v3/order',
      params,
    );

    return {
      order,
      initialError: null,
      reconciled: false,
    };
  } catch (error) {
    if (
      !(error instanceof BinanceRequestError) ||
      !error.uncertain
    ) {
      throw error;
    }

    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      await wait(RECONCILIATION_DELAY_MS * (attempt + 1));

      try {
        const order = await getOrderByClientId(
          context,
          symbol,
          clientOrderId,
        );

        if (order) {
          return {
            order,
            initialError: error,
            reconciled: true,
          };
        }
      } catch (queryError) {
        console.error(
          'Falha ao reconciliar entrada por clientOrderId:',
          queryError,
        );
      }
    }

    return {
      order: null,
      initialError: error,
      reconciled: false,
    };
  }
}

async function sendOcoWithReconciliation(
  context: BinanceContext,
  params: Record<string, string | number | boolean>,
  listClientOrderId: string,
): Promise<{
  list: BinanceOrderList | null;
  initialError: BinanceRequestError | null;
  reconciled: boolean;
}> {
  try {
    const list = await signedRequest<BinanceOrderList>(
      context,
      'POST',
      '/api/v3/orderList/oco',
      params,
    );

    return {
      list,
      initialError: null,
      reconciled: false,
    };
  } catch (error) {
    if (
      !(error instanceof BinanceRequestError) ||
      !error.uncertain
    ) {
      throw error;
    }

    for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
      await wait(RECONCILIATION_DELAY_MS * (attempt + 1));

      try {
        const list = await getOrderListByClientId(
          context,
          listClientOrderId,
        );

        if (list) {
          return {
            list,
            initialError: error,
            reconciled: true,
          };
        }
      } catch (queryError) {
        console.error(
          'Falha ao reconciliar OCO por listClientOrderId:',
          queryError,
        );
      }
    }

    return {
      list: null,
      initialError: error,
      reconciled: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Precisão e identificadores
// ---------------------------------------------------------------------------

function decimalPlaces(stepText: string): number {
  const normalized = stepText.toLowerCase();

  if (normalized.includes('e-')) {
    const exponent = Number(normalized.split('e-')[1]);
    return Number.isInteger(exponent) ? exponent : 8;
  }

  const dot = normalized.indexOf('.');

  if (dot < 0) {
    return 0;
  }

  return normalized.slice(dot + 1).replace(/0+$/, '').length;
}

function floorToStep(value: number, step: number): number {
  const factor = Math.floor((value + Number.EPSILON) / step);
  return factor * step;
}

function roundToStep(value: number, step: number): number {
  return Math.round((value + Number.EPSILON) / step) * step;
}

function decimalString(
  value: number,
  stepText: string,
): string {
  const places = Math.min(16, decimalPlaces(stepText));
  return value.toFixed(places);
}

function deterministicClientIds(requestId: string): {
  entry: string;
  list: string;
  target: string;
  stop: string;
} {
  const compact = requestId.replaceAll('-', '').toLowerCase();
  const suffix = compact.slice(0, 28);

  return {
    entry: `vigiaE${suffix}`,
    list: `vigiaL${suffix}`,
    target: `vigiaT${suffix}`,
    stop: `vigiaS${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// Banco e configurações
// ---------------------------------------------------------------------------

async function loadKeys(
  admin: SupabaseClient,
  userId: string,
): Promise<ExchangeKeysRow> {
  const { data, error } = await admin
    .from('exchange_keys')
    .select('user_id,api_key,api_secret_enc,is_testnet')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'KEY_QUERY_FAILED',
      `Não foi possível consultar a chave Binance: ${error.message}`,
    );
  }

  if (!data) {
    throw new RequestError(
      400,
      'KEY_NOT_CONFIGURED',
      'Nenhuma chave Binance está configurada.',
    );
  }

  return data as ExchangeKeysRow;
}

function resolvedPositive(
  value: unknown,
  fallback: number,
): number {
  const number = positive(value);
  return number ?? fallback;
}

function resolvedNonNegative(
  value: unknown,
  fallback: number,
): number {
  const number = finite(value);
  return number !== null && number >= 0 ? number : fallback;
}

async function loadRiskSettings(
  admin: SupabaseClient,
  userId: string,
): Promise<ResolvedRiskSettings> {
  const { data, error } = await admin
    .from('user_settings')
    .select(
      'trading_real_enabled,max_order_usdt,max_open_orders,max_daily_loss_usdt,min_stop_pct,max_stop_pct,min_target_pct,max_target_pct',
    )
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'RISK_SETTINGS_QUERY_FAILED',
      `Não foi possível consultar os limites de risco: ${error.message}`,
    );
  }

  const row = (data ?? {}) as Partial<UserSettingsRow>;

  return {
    tradingRealEnabled: row.trading_real_enabled === true,
    maxOrderUsdt: resolvedPositive(
      row.max_order_usdt,
      DEFAULT_RISK_SETTINGS.maxOrderUsdt,
    ),
    maxOpenOrders: Math.max(
      1,
      Math.min(
        20,
        Math.trunc(
          resolvedPositive(
            row.max_open_orders,
            DEFAULT_RISK_SETTINGS.maxOpenOrders,
          ),
        ),
      ),
    ),
    maxDailyLossUsdt: resolvedNonNegative(
      row.max_daily_loss_usdt,
      DEFAULT_RISK_SETTINGS.maxDailyLossUsdt,
    ),
    minStopPct: resolvedPositive(
      row.min_stop_pct,
      DEFAULT_RISK_SETTINGS.minStopPct,
    ),
    maxStopPct: resolvedPositive(
      row.max_stop_pct,
      DEFAULT_RISK_SETTINGS.maxStopPct,
    ),
    minTargetPct: resolvedPositive(
      row.min_target_pct,
      DEFAULT_RISK_SETTINGS.minTargetPct,
    ),
    maxTargetPct: resolvedPositive(
      row.max_target_pct,
      DEFAULT_RISK_SETTINGS.maxTargetPct,
    ),
  };
}


// ---------------------------------------------------------------------------
// Dimensionamento auditável de posição
// ---------------------------------------------------------------------------

const POSITION_SIZING_SELECT = [
  'id',
  'user_id',
  'opportunity_id',
  'auto_trade_attempt_id',
  'order_id',
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
  'policy_snapshot',
  'result_snapshot',
  'applied_at',
].join(',');

function positionSizingSummary(
  decision: PositionSizingDecisionRow,
): Record<string, unknown> {
  return {
    decision_id: decision.id,
    source: decision.source,
    status: decision.status,
    execution_environment: decision.execution_environment,
    mode: decision.sizing_mode,
    scope: decision.sizing_scope,
    policy_version: decision.policy_version,
    base_quote_amount: finite(decision.base_quote_amount),
    requested_quote_amount: finite(decision.requested_quote_amount),
    effective_quote_amount: finite(decision.effective_quote_amount),
    available_balance_usdt: finite(decision.available_balance_usdt),
    balance_usage_limit_pct: finite(decision.balance_usage_limit_pct),
    base_risk_percent: finite(decision.base_risk_percent),
    target_risk_percent: finite(decision.target_risk_percent),
    applied_risk_percent: finite(decision.applied_risk_percent),
    risk_multiplier: finite(decision.risk_multiplier),
    sequence_step: decision.sequence_step,
    consecutive_wins: decision.consecutive_wins,
    consecutive_losses: decision.consecutive_losses,
    account_consecutive_wins: decision.account_consecutive_wins,
    account_consecutive_losses: decision.account_consecutive_losses,
    planned_risk_usdt: finite(decision.planned_risk_usdt),
    actual_risk_usdt: finite(decision.actual_risk_usdt),
    stop_distance_pct: finite(decision.stop_distance_pct),
    estimated_total_cost_pct: finite(
      decision.estimated_total_cost_pct,
    ),
    estimated_loss_rate_pct: finite(
      decision.estimated_loss_rate_pct,
    ),
    limiting_rules: Array.isArray(decision.limiting_rules)
      ? decision.limiting_rules
      : [],
  };
}

function positionSizingContextFromDecision(
  decision: PositionSizingDecisionRow,
): PositionSizingContext {
  const effectiveQuoteAmount = positive(
    decision.effective_quote_amount,
  );

  if (effectiveQuoteAmount === null) {
    throw new RequestError(
      500,
      'POSITION_SIZING_AMOUNT_INVALID',
      'A decisão de dimensionamento não possui valor efetivo válido.',
      { decision_id: decision.id },
    );
  }

  return {
    decision,
    effectiveQuoteAmount,
    plannedRiskUsdt: finite(decision.planned_risk_usdt),
    summary: positionSizingSummary(decision),
  };
}

async function findPositionSizingDecision(
  admin: SupabaseClient,
  userId: string,
  opportunityId: string,
): Promise<PositionSizingDecisionRow | null> {
  const { data, error } = await admin
    .from('position_sizing_decisions')
    .select(POSITION_SIZING_SELECT)
    .eq('user_id', userId)
    .eq('opportunity_id', opportunityId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'POSITION_SIZING_QUERY_FAILED',
      `Não foi possível consultar a decisão de dimensionamento: ${error.message}`,
    );
  }

  return data as PositionSizingDecisionRow | null;
}

async function pauseAutoTradeForSizing(
  admin: SupabaseClient,
  userId: string,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin
    .from('user_settings')
    .update({
      auto_trade_paused_at: now,
      auto_trade_pause_reason: truncate(reason, 1_000),
      auto_trade_last_error: truncate(reason, 1_000),
    })
    .eq('user_id', userId);

  if (error) {
    console.error(
      'Falha ao pausar Auto Trade por dimensionamento:',
      error,
    );
    return;
  }

  console.warn(
    JSON.stringify({
      event: 'auto_trade_paused_by_position_sizing',
      user_id: userId,
      reason,
      details,
      paused_at: now,
    }),
  );
}

async function synchronizePositionSizingReservation(
  admin: SupabaseClient,
  options: {
    userId: string;
    opportunityId: string;
    attemptId: string | null;
    context: PositionSizingContext;
  },
): Promise<void> {
  const { decision, effectiveQuoteAmount } = options.context;
  const sizingSnapshot = asRecord(decision.policy_snapshot);

  const opportunityUpdate = await admin
    .from('trade_opportunities')
    .update({
      position_sizing_decision_id: decision.id,
      quote_amount: effectiveQuoteAmount,
      sizing_snapshot: sizingSnapshot,
    })
    .eq('id', options.opportunityId)
    .eq('user_id', options.userId);

  if (opportunityUpdate.error) {
    throw new RequestError(
      500,
      'POSITION_SIZING_OPPORTUNITY_SYNC_FAILED',
      `Não foi possível vincular o dimensionamento à oportunidade: ${opportunityUpdate.error.message}`,
    );
  }

  if (!options.attemptId) {
    return;
  }

  const attemptUpdate = await admin
    .from('auto_trade_attempts')
    .update({
      position_sizing_decision_id: decision.id,
      sizing_mode: decision.sizing_mode,
      sizing_scope: decision.sizing_scope,
      sizing_policy_version: decision.policy_version,
      base_risk_percent: finite(decision.base_risk_percent),
      target_risk_percent: finite(decision.target_risk_percent),
      applied_risk_percent: finite(decision.applied_risk_percent),
      risk_multiplier: finite(decision.risk_multiplier) ?? 1,
      sequence_step: decision.sequence_step,
      consecutive_wins: decision.consecutive_wins,
      consecutive_losses: decision.consecutive_losses,
      account_consecutive_wins:
        decision.account_consecutive_wins,
      account_consecutive_losses:
        decision.account_consecutive_losses,
      planned_risk_usdt: finite(decision.planned_risk_usdt),
      effective_quote_amount: effectiveQuoteAmount,
      quote_amount: effectiveQuoteAmount,
      sizing_snapshot: sizingSnapshot,
    })
    .eq('id', options.attemptId)
    .eq('user_id', options.userId)
    .eq('opportunity_id', options.opportunityId);

  if (attemptUpdate.error) {
    throw new RequestError(
      500,
      'POSITION_SIZING_ATTEMPT_SYNC_FAILED',
      `Não foi possível vincular o dimensionamento à tentativa automática: ${attemptUpdate.error.message}`,
    );
  }
}

function sizingBlockedMessage(code: string): string {
  if (code === 'CONSECUTIVE_LOSS_PAUSE_REQUIRED') {
    return 'O limite de perdas consecutivas foi atingido. O Auto Trade foi pausado por segurança.';
  }

  if (code === 'MARTINGALE_REAL_FORBIDDEN') {
    return 'Martingale é permitido exclusivamente na Binance Spot Testnet.';
  }

  if (code === 'BALANCE_REQUIRED') {
    return 'O saldo livre atual é obrigatório para calcular o risco dinâmico.';
  }

  return 'A política de risco bloqueou o dimensionamento desta operação.';
}

async function reservePositionSizing(
  admin: SupabaseClient,
  options: {
    auth: AuthenticationContext;
    userId: string;
    opportunityId: string;
    availableBalanceUsdt: number;
    executionEnvironment: 'testnet' | 'real';
  },
): Promise<PositionSizingContext> {
  const existing = await findPositionSizingDecision(
    admin,
    options.userId,
    options.opportunityId,
  );

  if (existing) {
    if (existing.execution_environment !== options.executionEnvironment) {
      throw new RequestError(
        409,
        'POSITION_SIZING_ENVIRONMENT_MISMATCH',
        'A decisão já existente pertence a outro ambiente de execução.',
        {
          decision_id: existing.id,
          decision_environment: existing.execution_environment,
          requested_environment: options.executionEnvironment,
        },
      );
    }

    if (
      existing.status === 'cancelled' ||
      existing.status === 'failed'
    ) {
      throw new RequestError(
        409,
        'POSITION_SIZING_DECISION_NOT_REUSABLE',
        'A decisão de dimensionamento já foi encerrada e não pode ser reutilizada.',
        {
          decision_id: existing.id,
          status: existing.status,
        },
      );
    }

    const context = positionSizingContextFromDecision(existing);

    await synchronizePositionSizingReservation(admin, {
      userId: options.userId,
      opportunityId: options.opportunityId,
      attemptId:
        options.auth.mode === 'auto_trade'
          ? options.auth.autoTradeAttempt?.id ?? null
          : null,
      context,
    });

    return context;
  }

  const source =
    options.auth.mode === 'auto_trade'
      ? 'auto_trade'
      : 'manual_opportunity';
  const attemptId =
    options.auth.mode === 'auto_trade'
      ? options.auth.autoTradeAttempt?.id ?? null
      : null;

  const previewResult = await admin.rpc(
    'preview_position_sizing',
    {
      p_opportunity_id: options.opportunityId,
      p_available_balance_usdt: options.availableBalanceUsdt,
      p_user_id: options.userId,
      p_execution_environment: options.executionEnvironment,
      p_source: source,
    },
  );

  if (previewResult.error) {
    throw new RequestError(
      500,
      'POSITION_SIZING_PREVIEW_FAILED',
      `Não foi possível calcular o dimensionamento: ${previewResult.error.message}`,
    );
  }

  const preview = asRecord(previewResult.data);
  const executable = preview.executable === true;
  const blockedReason =
    typeof preview.blocked_reason === 'string' &&
      preview.blocked_reason
      ? preview.blocked_reason
      : 'POSITION_SIZING_BLOCKED';

  if (!executable) {
    if (
      options.auth.mode === 'auto_trade' &&
      (
        preview.should_pause === true ||
        blockedReason === 'CONSECUTIVE_LOSS_PAUSE_REQUIRED'
      )
    ) {
      await pauseAutoTradeForSizing(
        admin,
        options.userId,
        sizingBlockedMessage(blockedReason),
        preview,
      );
    }

    throw new RequestError(
      409,
      blockedReason,
      sizingBlockedMessage(blockedReason),
      preview,
    );
  }

  const reservation = await admin.rpc(
    'reserve_position_sizing_decision',
    {
      p_opportunity_id: options.opportunityId,
      p_available_balance_usdt: options.availableBalanceUsdt,
      p_auto_trade_attempt_id: attemptId,
      p_source: source,
      p_user_id: options.userId,
      p_execution_environment: options.executionEnvironment,
    },
  );

  if (reservation.error) {
    const match = reservation.error.message.match(
      /Dimensionamento bloqueado:\s*([A-Z0-9_]+)/,
    );
    const code = match?.[1] ?? 'POSITION_SIZING_RESERVATION_FAILED';

    if (
      options.auth.mode === 'auto_trade' &&
      code === 'CONSECUTIVE_LOSS_PAUSE_REQUIRED'
    ) {
      await pauseAutoTradeForSizing(
        admin,
        options.userId,
        sizingBlockedMessage(code),
        { rpc_error: reservation.error.message },
      );
    }

    throw new RequestError(
      code === 'POSITION_SIZING_RESERVATION_FAILED' ? 500 : 409,
      code,
      code === 'POSITION_SIZING_RESERVATION_FAILED'
        ? `Não foi possível reservar o dimensionamento: ${reservation.error.message}`
        : sizingBlockedMessage(code),
      { rpc_error: reservation.error.message },
    );
  }

  const payload = asRecord(reservation.data);
  const decisionValue = payload.decision;

  if (!isRecord(decisionValue)) {
    throw new RequestError(
      500,
      'POSITION_SIZING_RESPONSE_INVALID',
      'A reserva de dimensionamento retornou um payload inválido.',
    );
  }

  const context = positionSizingContextFromDecision(
    decisionValue as unknown as PositionSizingDecisionRow,
  );

  await synchronizePositionSizingReservation(admin, {
    userId: options.userId,
    opportunityId: options.opportunityId,
    attemptId,
    context,
  });

  return context;
}

async function applyPositionSizingToOrder(
  admin: SupabaseClient,
  options: {
    context: PositionSizingContext;
    orderId: string;
    effectiveQuoteAmount: number;
    actualRiskUsdt?: number | null;
    resultSnapshot?: Record<string, unknown>;
    required?: boolean;
  },
): Promise<void> {
  const { data, error } = await admin.rpc(
    'apply_position_sizing_decision',
    {
      p_decision_id: options.context.decision.id,
      p_order_id: options.orderId,
      p_effective_quote_amount: options.effectiveQuoteAmount,
      p_actual_risk_usdt: options.actualRiskUsdt ?? null,
      p_result_snapshot: options.resultSnapshot ?? {},
    },
  );

  if (error) {
    if (options.required !== false) {
      throw new RequestError(
        500,
        'POSITION_SIZING_APPLY_FAILED',
        `Não foi possível aplicar o dimensionamento à ordem: ${error.message}`,
        {
          decision_id: options.context.decision.id,
          order_id: options.orderId,
        },
      );
    }

    console.error(
      'Falha não bloqueante ao atualizar dimensionamento:',
      error,
    );
    return;
  }

  const payload = asRecord(data);
  const updated = payload.decision;

  if (isRecord(updated)) {
    options.context.decision =
      updated as unknown as PositionSizingDecisionRow;
    options.context.plannedRiskUsdt = finite(
      options.context.decision.planned_risk_usdt,
    );
    options.context.summary = positionSizingSummary(
      options.context.decision,
    );
  }
}

function estimateActualRiskAtStop(
  context: PositionSizingContext,
  entry: EntrySummary,
  stopPrice: number,
): number {
  const priceRisk = Math.max(
    0,
    entry.averagePrice - stopPrice,
  ) * entry.quantity;
  const estimatedCosts =
    entry.quoteSpent *
    (
      (finite(
        context.decision.estimated_total_cost_pct,
      ) ?? 0) / 100
    );

  return Math.max(
    0,
    Math.round(
      (priceRisk + estimatedCosts + Number.EPSILON) * 100_000_000,
    ) / 100_000_000,
  );
}

async function findOrderByRequestId(
  admin: SupabaseClient,
  userId: string,
  requestId: string,
): Promise<OrderRow | null> {
  const { data, error } = await admin
    .from('orders')
    .select(ORDER_SELECT)
    .eq('user_id', userId)
    .eq('request_id', requestId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'ORDER_QUERY_FAILED',
      `Não foi possível consultar a solicitação existente: ${error.message}`,
    );
  }

  return data as OrderRow | null;
}

async function findOrderByOpportunity(
  admin: SupabaseClient,
  userId: string,
  opportunityId: string,
): Promise<OrderRow | null> {
  const { data, error } = await admin
    .from('orders')
    .select(ORDER_SELECT)
    .eq('user_id', userId)
    .eq('opportunity_id', opportunityId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'ORDER_QUERY_FAILED',
      `Não foi possível consultar a ordem da oportunidade: ${error.message}`,
    );
  }

  return data as OrderRow | null;
}

async function reserveOrder(
  admin: SupabaseClient,
  options: {
    userId: string;
    opportunityId: string | null;
    isTestnet: boolean;
    symbol: string;
    quoteAmount: number;
    requestId: string;
    clientOrderId: string;
    listClientOrderId: string;
    raw: Record<string, unknown>;
    positionSizing?: PositionSizingContext | null;
  },
): Promise<ReservedOrderResult> {
  const existing = await findOrderByRequestId(
    admin,
    options.userId,
    options.requestId,
  );

  if (existing) {
    return {
      order: existing,
      duplicate: true,
    };
  }

  if (options.opportunityId) {
    const byOpportunity = await findOrderByOpportunity(
      admin,
      options.userId,
      options.opportunityId,
    );

    if (byOpportunity) {
      return {
        order: byOpportunity,
        duplicate: true,
      };
    }
  }

  const sizing = options.positionSizing ?? null;
  const decision = sizing?.decision ?? null;
  const sizingSnapshot = sizing?.summary ?? {};

  const insertPayload: Record<string, unknown> = {
    user_id: options.userId,
    is_testnet: options.isTestnet,
    symbol: options.symbol,
    quote_amount: options.quoteAmount,
    status: 'pendente',
    request_id: options.requestId,
    client_order_id: options.clientOrderId,
    list_client_order_id: options.listClientOrderId,
    position_sizing_decision_id: decision?.id ?? null,
    sizing_mode: decision?.sizing_mode ?? 'fixed',
    base_risk_percent: finite(decision?.base_risk_percent),
    target_risk_percent: finite(decision?.target_risk_percent),
    applied_risk_percent: finite(decision?.applied_risk_percent),
    risk_multiplier: finite(decision?.risk_multiplier) ?? 1,
    planned_risk_usdt: finite(decision?.planned_risk_usdt),
    actual_risk_usdt: null,
    sizing_snapshot: sizingSnapshot,
    raw: {
      ...options.raw,
      position_sizing: sizing ? sizingSnapshot : null,
    },
  };

  if (options.opportunityId) {
    insertPayload.opportunity_id = options.opportunityId;
  }

  const { data, error } = await admin
    .from('orders')
    .insert(insertPayload)
    .select(ORDER_SELECT)
    .single();

  if (error) {
    if (error.code === '23505') {
      const concurrent = await findOrderByRequestId(
        admin,
        options.userId,
        options.requestId,
      );

      if (concurrent) {
        return {
          order: concurrent,
          duplicate: true,
        };
      }
    }

    throw new RequestError(
      500,
      'ORDER_RESERVATION_FAILED',
      `Não foi possível registrar a ordem antes do envio: ${error.message}`,
    );
  }

  return {
    order: data as OrderRow,
    duplicate: false,
  };
}

async function updateOrder(
  admin: SupabaseClient,
  orderId: string,
  patch: Record<string, unknown>,
): Promise<OrderRow> {
  const { data, error } = await admin
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .select(ORDER_SELECT)
    .single();

  if (error) {
    throw new RequestError(
      500,
      'ORDER_UPDATE_FAILED',
      `Não foi possível atualizar a auditoria da ordem: ${error.message}`,
    );
  }

  return data as OrderRow;
}

async function loadOpportunity(
  admin: SupabaseClient,
  userId: string,
  opportunityId: string,
): Promise<TradeOpportunityRow> {
  const { data, error } = await admin
    .from('trade_opportunities')
    .select(OPPORTUNITY_SELECT)
    .eq('id', opportunityId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new RequestError(
      500,
      'OPPORTUNITY_QUERY_FAILED',
      `Não foi possível consultar a oportunidade: ${error.message}`,
    );
  }

  if (!data) {
    throw new RequestError(
      404,
      'OPPORTUNITY_NOT_FOUND',
      'Oportunidade não encontrada.',
    );
  }

  return data as TradeOpportunityRow;
}

async function updateOpportunity(
  admin: SupabaseClient,
  userId: string,
  opportunityId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from('trade_opportunities')
    .update(patch)
    .eq('id', opportunityId)
    .eq('user_id', userId);

  if (error) {
    throw new RequestError(
      500,
      'OPPORTUNITY_UPDATE_FAILED',
      `Não foi possível atualizar a oportunidade: ${error.message}`,
    );
  }
}

async function logOpportunityEvent(
  admin: SupabaseClient,
  options: {
    opportunityId: string | null;
    userId: string;
    eventType: string;
    actorType?: 'system' | 'user' | 'edge_function' | 'exchange';
    data?: Record<string, unknown>;
  },
): Promise<void> {
  if (!options.opportunityId) {
    return;
  }

  const { error } = await admin.rpc('log_opportunity_event', {
    p_opportunity_id: options.opportunityId,
    p_user_id: options.userId,
    p_event_type: options.eventType,
    p_actor_type: options.actorType ?? 'edge_function',
    p_event_data: options.data ?? {},
  });

  if (error) {
    console.error(
      `Falha ao registrar evento ${options.eventType}:`,
      error,
    );
  }
}

async function upsertExecutedOutcome(
  admin: SupabaseClient,
  options: {
    opportunity: TradeOpportunityRow | null;
    entry: EntrySummary;
    orderId: string;
  },
): Promise<void> {
  if (!options.opportunity) {
    return;
  }

  const opportunity = options.opportunity;
  const { data: existing, error: queryError } = await admin
    .from('opportunity_outcomes')
    .select('id,status,metadata')
    .eq('opportunity_id', opportunity.id)
    .eq('mode', 'executed')
    .maybeSingle();

  if (queryError) {
    console.error('Falha ao consultar resultado executado:', queryError);
    return;
  }

  const referenceEntry = positive(opportunity.entry_reference);
  const slippageUsdt =
    referenceEntry === null
      ? 0
      : Math.max(
          0,
          options.entry.averagePrice - referenceEntry,
        ) * options.entry.quantity;

  const metadata = {
    ...asRecord(existing?.metadata),
    orderId: options.orderId,
    requestSource: 'binance-trade',
    strategy: opportunity.strategy,
    strategyVersion: opportunity.strategy_version,
    entryClientOrderId: options.entry.entryClientOrderId,
    quoteSpent: options.entry.quoteSpent,
    unresolvedEntryFees: options.entry.unresolvedFees,
  };

  if (existing) {
    if (existing.status !== 'tracking') {
      return;
    }

    const { error } = await admin
      .from('opportunity_outcomes')
      .update({
        entry_price: options.entry.averagePrice,
        entry_at: options.entry.entryAt,
        fees_usdt: options.entry.feesUsdt,
        slippage_usdt: slippageUsdt,
        metadata,
      })
      .eq('id', existing.id)
      .eq('status', 'tracking');

    if (error) {
      console.error('Falha ao atualizar resultado executado:', error);
    }

    return;
  }

  const { error } = await admin
    .from('opportunity_outcomes')
    .insert({
      opportunity_id: opportunity.id,
      user_id: opportunity.user_id,
      mode: 'executed',
      status: 'tracking',
      entry_price: options.entry.averagePrice,
      entry_at: options.entry.entryAt,
      fees_usdt: options.entry.feesUsdt,
      slippage_usdt: slippageUsdt,
      metadata,
    });

  if (error && error.code !== '23505') {
    console.error('Falha ao criar resultado executado:', error);
  }
}

// ---------------------------------------------------------------------------
// Limites de risco
// ---------------------------------------------------------------------------

async function assertOperationalLimits(
  admin: SupabaseClient,
  options: {
    userId: string;
    quoteAmount: number;
    stopPct: number;
    targetPct: number;
    isTestnet: boolean;
    settings: ResolvedRiskSettings;
    excludeOrderId?: string | null;
  },
): Promise<void> {
  const { settings } = options;

  if (!options.isTestnet && !settings.tradingRealEnabled) {
    throw new RequestError(
      403,
      'REAL_TRADING_DISABLED',
      'As operações reais estão bloqueadas nas configurações de risco.',
    );
  }

  if (options.quoteAmount > settings.maxOrderUsdt) {
    throw new RequestError(
      409,
      'MAX_ORDER_EXCEEDED',
      `O valor da ordem excede o limite de ${settings.maxOrderUsdt} USDT.`,
      {
        quote_amount: options.quoteAmount,
        max_order_usdt: settings.maxOrderUsdt,
      },
    );
  }

  if (
    options.stopPct < settings.minStopPct ||
    options.stopPct > settings.maxStopPct
  ) {
    throw new RequestError(
      409,
      'STOP_OUTSIDE_LIMITS',
      'O stop está fora dos limites configurados.',
      {
        stop_pct: options.stopPct,
        allowed: [settings.minStopPct, settings.maxStopPct],
      },
    );
  }

  if (
    options.targetPct < settings.minTargetPct ||
    options.targetPct > settings.maxTargetPct
  ) {
    throw new RequestError(
      409,
      'TARGET_OUTSIDE_LIMITS',
      'O alvo está fora dos limites configurados.',
      {
        target_pct: options.targetPct,
        allowed: [settings.minTargetPct, settings.maxTargetPct],
      },
    );
  }

  let openQuery = admin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', options.userId)
    .in('status', [...OPEN_ORDER_STATUSES]);

  let unprotectedQuery = admin
    .from('orders')
    .select('id')
    .eq('user_id', options.userId)
    .eq('status', 'entrada_sem_protecao');

  if (options.excludeOrderId) {
    openQuery = openQuery.neq('id', options.excludeOrderId);
    unprotectedQuery = unprotectedQuery.neq(
      'id',
      options.excludeOrderId,
    );
  }

  const [openResult, unprotectedResult, dailyResult] = await Promise.all([
    openQuery,
    unprotectedQuery.limit(1).maybeSingle(),
    admin
      .from('orders')
      .select('pnl_usdt')
      .eq('user_id', options.userId)
      .gte(
        'fechado_em',
        new Date(
          new Date().setUTCHours(0, 0, 0, 0),
        ).toISOString(),
      )
      .not('pnl_usdt', 'is', null),
  ]);

  if (openResult.error) {
    throw new RequestError(
      500,
      'OPEN_ORDER_COUNT_FAILED',
      `Não foi possível contar ordens abertas: ${openResult.error.message}`,
    );
  }

  if (unprotectedResult.error) {
    throw new RequestError(
      500,
      'UNPROTECTED_QUERY_FAILED',
      `Não foi possível verificar posições sem proteção: ${unprotectedResult.error.message}`,
    );
  }

  if (dailyResult.error) {
    throw new RequestError(
      500,
      'DAILY_LOSS_QUERY_FAILED',
      `Não foi possível calcular a perda diária: ${dailyResult.error.message}`,
    );
  }

  if (unprotectedResult.data) {
    throw new RequestError(
      409,
      'UNPROTECTED_POSITION_EXISTS',
      'Existe uma compra sem proteção. Confira diretamente na Binance antes de criar outra ordem.',
    );
  }

  const openCount = openResult.count ?? 0;

  if (openCount >= settings.maxOpenOrders) {
    throw new RequestError(
      409,
      'MAX_OPEN_ORDERS_REACHED',
      `O limite de ${settings.maxOpenOrders} ordens abertas foi atingido.`,
      {
        open_orders: openCount,
        max_open_orders: settings.maxOpenOrders,
      },
    );
  }

  const dailyLoss = ((dailyResult.data ?? []) as Array<{
    pnl_usdt: number | string | null;
  }>).reduce((total, row) => {
    const pnl = finite(row.pnl_usdt) ?? 0;
    return pnl < 0 ? total + Math.abs(pnl) : total;
  }, 0);

  if (
    settings.maxDailyLossUsdt > 0 &&
    dailyLoss >= settings.maxDailyLossUsdt
  ) {
    throw new RequestError(
      409,
      'DAILY_LOSS_LIMIT_REACHED',
      'O limite diário de perdas foi atingido.',
      {
        daily_loss_usdt: dailyLoss,
        max_daily_loss_usdt: settings.maxDailyLossUsdt,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Oportunidades e revalidação
// ---------------------------------------------------------------------------

function planNumber(
  opportunity: TradeOpportunityRow,
  key: string,
): number | null {
  return positive(asRecord(opportunity.plan_snapshot)[key]);
}

function marketIndicatorNumber(
  opportunity: TradeOpportunityRow,
  key: string,
): number | null {
  const market = asRecord(opportunity.market_snapshot);
  const indicators = asRecord(market.indicators);
  return positive(indicators[key]);
}

async function markOpportunityBlocked(
  admin: SupabaseClient,
  options: {
    opportunity: TradeOpportunityRow;
    status: 'expired' | 'invalidated' | 'error';
    reason: string;
    code: string;
    marketPrice?: number | null;
    orderId?: string | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    lifecycle_status: options.status,
  };

  if (options.status === 'invalidated') {
    patch.invalidated_at = new Date().toISOString();
  }

  await updateOpportunity(
    admin,
    options.opportunity.user_id,
    options.opportunity.id,
    patch,
  );

  await logOpportunityEvent(admin, {
    opportunityId: options.opportunity.id,
    userId: options.opportunity.user_id,
    eventType:
      options.status === 'expired'
        ? 'opportunity_expired'
        : options.status === 'invalidated'
          ? 'entry_revalidation_failed'
          : 'error',
    data: {
      reason: options.reason,
      code: options.code,
      marketPrice: options.marketPrice ?? null,
      orderId: options.orderId ?? null,
    },
  });
}

async function resolveTradeRequest(
  admin: SupabaseClient,
  userId: string,
  keys: ExchangeKeysRow,
  body: RequestBody,
  headerRequestId: string | null,
  authenticationMode: AuthenticationMode,
): Promise<ResolvedTradeRequest> {
  const opportunityId = parseUuid(
    body.opportunity_id,
    'opportunity_id',
    true,
  );

  const bodyRequestId = parseUuid(
    body.request_id,
    'request_id',
    true,
  );

  const normalizedHeaderId = headerRequestId
    ? parseUuid(headerRequestId, 'x-idempotency-key', true)
    : null;

  if (
    bodyRequestId &&
    normalizedHeaderId &&
    bodyRequestId !== normalizedHeaderId
  ) {
    throw new RequestError(
      400,
      'IDEMPOTENCY_KEY_MISMATCH',
      'request_id e x-idempotency-key precisam ser iguais.',
    );
  }

  if (!opportunityId) {
    if (authenticationMode === 'auto_trade') {
      throw new RequestError(
        400,
        'AUTO_TRADE_OPPORTUNITY_REQUIRED',
        'O Auto Trade exige uma oportunidade reservada.',
      );
    }

    return {
      opportunity: null,
      opportunityId: null,
      requestId:
        bodyRequestId ??
        normalizedHeaderId ??
        crypto.randomUUID(),
      symbol: parseSymbol(body.symbol),
      quoteAmount: parsePositiveNumber(
        body.quote_amount,
        'quote_amount',
      ),
      stopPct: parsePositiveNumber(body.stop_pct, 'stop_pct'),
      targetPct: parsePositiveNumber(
        body.target_pct,
        'target_pct',
      ),
      referenceEntry: null,
      referenceStop: null,
      referenceTarget: null,
      maximumEntryPrice: null,
      breakoutLevel: null,
      confirmTestnet: body.confirm_testnet === true,
    };
  }

  const opportunity = await loadOpportunity(
    admin,
    userId,
    opportunityId,
  );

  if (opportunity.opportunity_type !== 'entry') {
    throw new RequestError(
      409,
      'NOT_AN_ENTRY_OPPORTUNITY',
      'Esta oportunidade não representa uma entrada.',
    );
  }

  if (opportunity.direction !== 'long') {
    throw new RequestError(
      409,
      'UNSUPPORTED_DIRECTION',
      'Esta versão executa somente oportunidades long em Spot.',
    );
  }

  if (opportunity.provider !== 'binance') {
    throw new RequestError(
      409,
      'UNSUPPORTED_PROVIDER',
      'A oportunidade não pertence à Binance.',
    );
  }

  if (opportunity.quote_asset !== 'USDT') {
    throw new RequestError(
      409,
      'UNSUPPORTED_QUOTE_ASSET',
      'A Central executa somente oportunidades cotadas em USDT.',
    );
  }

  if (opportunity.entry_decision !== 'accepted') {
    throw new RequestError(
      409,
      'OPPORTUNITY_NOT_ACCEPTED',
      'A oportunidade precisa ser aceita antes da execução.',
      {
        entry_decision: opportunity.entry_decision,
      },
    );
  }

  if (
    ![
      'revalidating',
      'opening',
      'open',
    ].includes(opportunity.lifecycle_status)
  ) {
    throw new RequestError(
      409,
      'OPPORTUNITY_NOT_EXECUTABLE',
      'A oportunidade não está em um estado executável.',
      {
        lifecycle_status: opportunity.lifecycle_status,
      },
    );
  }

  if (
    opportunity.expires_at &&
    Date.parse(opportunity.expires_at) <= Date.now()
  ) {
    await markOpportunityBlocked(admin, {
      opportunity,
      status: 'expired',
      reason: 'expired_before_server_revalidation',
      code: 'OPPORTUNITY_EXPIRED',
    });

    throw new RequestError(
      409,
      'OPPORTUNITY_EXPIRED',
      'A oportunidade expirou antes da execução.',
    );
  }

  const executionEnvironment = opportunity.execution_environment;

  if (
    executionEnvironment !== 'testnet' &&
    executionEnvironment !== 'real'
  ) {
    throw new RequestError(
      409,
      'INVALID_EXECUTION_ENVIRONMENT',
      'A oportunidade possui um ambiente de execução inválido.',
      { execution_environment: executionEnvironment },
    );
  }

  if (
    authenticationMode !== 'auto_trade' &&
    executionEnvironment !== 'testnet'
  ) {
    throw new RequestError(
      403,
      'CENTRAL_REAL_EXECUTION_DISABLED',
      'A execução real de oportunidades só é permitida pelo Auto Trade reservado.',
      { execution_environment: executionEnvironment },
    );
  }

  if (executionEnvironment === 'testnet') {
    if (!keys.is_testnet) {
      throw new RequestError(
        403,
        'TESTNET_KEY_REQUIRED',
        'A oportunidade exige uma chave da Binance Spot Testnet.',
      );
    }

    if (body.confirm_testnet !== true) {
      throw new RequestError(
        400,
        'TESTNET_CONFIRMATION_REQUIRED',
        'Confirme explicitamente a execução na Testnet.',
        {
          required: {
            opportunity_id: opportunity.id,
            confirm_testnet: true,
          },
        },
      );
    }
  } else {
    if (authenticationMode !== 'auto_trade') {
      throw new RequestError(
        403,
        'CENTRAL_REAL_EXECUTION_DISABLED',
        'A execução real de oportunidades exige uma tentativa do Auto Trade.',
      );
    }

    if (keys.is_testnet) {
      throw new RequestError(
        403,
        'REAL_KEY_REQUIRED',
        'A oportunidade real exige uma chave da Binance Spot real.',
      );
    }

    if (body.confirm_testnet === true) {
      throw new RequestError(
        409,
        'EXECUTION_ENVIRONMENT_MISMATCH',
        'A oportunidade está configurada para execução real.',
      );
    }
  }

  const entry = positive(opportunity.entry_reference);
  const stop = positive(opportunity.stop_reference);
  const target = positive(opportunity.target_reference);

  if (
    entry === null ||
    stop === null ||
    target === null ||
    !(stop < entry && target > entry)
  ) {
    await markOpportunityBlocked(admin, {
      opportunity,
      status: 'error',
      reason: 'invalid_immutable_plan',
      code: 'INVALID_OPPORTUNITY_PLAN',
    });

    throw new RequestError(
      409,
      'INVALID_OPPORTUNITY_PLAN',
      'O snapshot da oportunidade não possui entrada, stop e alvo coerentes.',
    );
  }

  const storedAmount = positive(opportunity.quote_amount);
  const suppliedAmount = optionalPositiveNumber(body.quote_amount);

  if (
    storedAmount !== null &&
    suppliedAmount !== null &&
    Math.abs(storedAmount - suppliedAmount) > 0.00000001
  ) {
    throw new RequestError(
      409,
      'QUOTE_AMOUNT_MISMATCH',
      'O valor informado não corresponde ao valor já registrado na oportunidade.',
      {
        stored_quote_amount: storedAmount,
        supplied_quote_amount: suppliedAmount,
      },
    );
  }

  const quoteAmount = storedAmount ?? suppliedAmount;

  if (quoteAmount === null) {
    throw new RequestError(
      400,
      'QUOTE_AMOUNT_REQUIRED',
      'Informe quote_amount para executar a oportunidade.',
    );
  }

  const requestId = opportunity.id;

  if (
    bodyRequestId &&
    bodyRequestId !== requestId
  ) {
    throw new RequestError(
      409,
      'OPPORTUNITY_REQUEST_ID_MISMATCH',
      'Para uma oportunidade, request_id deve ser igual ao opportunity_id.',
    );
  }

  if (
    normalizedHeaderId &&
    normalizedHeaderId !== requestId
  ) {
    throw new RequestError(
      409,
      'OPPORTUNITY_REQUEST_ID_MISMATCH',
      'Para uma oportunidade, x-idempotency-key deve ser igual ao opportunity_id.',
    );
  }

  return {
    opportunity,
    opportunityId: opportunity.id,
    requestId,
    symbol: parseSymbol(opportunity.symbol),
    quoteAmount,
    stopPct: ((entry - stop) / entry) * 100,
    targetPct: ((target - entry) / entry) * 100,
    referenceEntry: entry,
    referenceStop: stop,
    referenceTarget: target,
    maximumEntryPrice:
      positive(opportunity.maximum_entry_price) ??
      planNumber(opportunity, 'latestAcceptableEntry'),
    breakoutLevel:
      planNumber(opportunity, 'breakoutLevel') ??
      marketIndicatorNumber(opportunity, 'breakout_level'),
    confirmTestnet: executionEnvironment === 'testnet',
  };
}

async function revalidateOpportunityMarket(
  admin: SupabaseClient,
  request: ResolvedTradeRequest,
): Promise<{
  price: number;
  source: string;
}> {
  if (!request.opportunity) {
    return getPublicPrice(request.symbol);
  }

  const market = await getPublicPrice(request.symbol);
  const opportunity = request.opportunity;
  const stop = request.referenceStop as number;
  const target = request.referenceTarget as number;

  let reason: string | null = null;
  let code: string | null = null;

  if (market.price <= stop) {
    reason = 'market_price_reached_stop';
    code = 'OPPORTUNITY_INVALIDATED_BY_STOP';
  } else if (market.price >= target) {
    reason = 'market_price_reached_target';
    code = 'OPPORTUNITY_TARGET_ALREADY_REACHED';
  } else if (
    request.breakoutLevel !== null &&
    market.price <= request.breakoutLevel
  ) {
    reason = 'market_price_below_breakout';
    code = 'OPPORTUNITY_LOST_BREAKOUT';
  } else if (
    request.maximumEntryPrice !== null &&
    market.price > request.maximumEntryPrice
  ) {
    reason = 'market_price_above_maximum_entry';
    code = 'OPPORTUNITY_ENTRY_TOO_LATE';
  }

  if (reason && code) {
    await markOpportunityBlocked(admin, {
      opportunity,
      status: 'invalidated',
      reason,
      code,
      marketPrice: market.price,
    });

    throw new RequestError(
      409,
      code,
      'A oportunidade não passou pela revalidação do preço atual.',
      {
        market_price: market.price,
        stop_reference: stop,
        target_reference: target,
        breakout_level: request.breakoutLevel,
        maximum_entry_price: request.maximumEntryPrice,
        reason,
      },
    );
  }

  return market;
}

// ---------------------------------------------------------------------------
// Execução e reconciliação
// ---------------------------------------------------------------------------

function summarizeEntry(
  order: BinanceOrder,
  rules: SymbolRules,
  clientOrderId: string,
): EntrySummary {
  const quantity = positive(order.executedQty);
  const quoteSpent = positive(order.cummulativeQuoteQty);

  if (quantity === null || quoteSpent === null) {
    throw new RequestError(
      502,
      'ENTRY_RESPONSE_INCOMPLETE',
      'A Binance confirmou a ordem, mas não retornou quantidade e valor executados.',
      {
        status: order.status ?? null,
        order_id: order.orderId ?? null,
      },
    );
  }

  const averagePrice = quoteSpent / quantity;
  const entryOrderId = finite(order.orderId);

  if (
    !Number.isFinite(averagePrice) ||
    averagePrice <= 0 ||
    entryOrderId === null
  ) {
    throw new RequestError(
      502,
      'ENTRY_RESPONSE_INVALID',
      'A resposta da entrada possui valores inválidos.',
    );
  }

  let feesUsdt = 0;
  const unresolvedFees: Array<{
    asset: string;
    amount: number;
  }> = [];

  const fills = Array.isArray(order.fills) ? order.fills : [];

  for (const fill of fills) {
    const commission = positive(fill.commission);
    const commissionAsset = String(fill.commissionAsset ?? '');
    const fillPrice = positive(fill.price) ?? averagePrice;

    if (commission === null || !commissionAsset) {
      continue;
    }

    if (commissionAsset === rules.quoteAsset) {
      feesUsdt += commission;
    } else if (commissionAsset === rules.baseAsset) {
      feesUsdt += commission * fillPrice;
    } else {
      unresolvedFees.push({
        asset: commissionAsset,
        amount: commission,
      });
    }
  }

  const entryAtTimestamp =
    finite(order.transactTime) ?? Date.now();

  return {
    quantity,
    quoteSpent,
    averagePrice,
    entryOrderId,
    entryClientOrderId:
      order.clientOrderId || clientOrderId,
    entryAt: new Date(entryAtTimestamp).toISOString(),
    feesUsdt,
    unresolvedFees,
  };
}

async function availableBaseQuantity(
  context: BinanceContext,
  baseAsset: string,
  executedQuantity: number,
  rules: SymbolRules,
): Promise<number> {
  try {
    const account = await signedRequest<BinanceAccount>(
      context,
      'GET',
      '/api/v3/account',
      {
        omitZeroBalances: false,
      },
    );

    const balances = Array.isArray(account.balances)
      ? account.balances
      : [];
    const balance = balances.find(
      (item) => item.asset === baseAsset,
    );
    const free = positive(balance?.free);
    const maximumSellable =
      free === null
        ? executedQuantity
        : Math.min(executedQuantity, free);

    return floorToStep(maximumSellable, rules.stepSize);
  } catch (error) {
    console.error(
      'Falha ao consultar saldo-base após entrada; usando executedQty:',
      error,
    );

    return floorToStep(executedQuantity, rules.stepSize);
  }
}

function buildProtection(
  entry: EntrySummary,
  request: ResolvedTradeRequest,
  rules: SymbolRules,
  sellableQuantity: number,
): {
  quantity: number;
  targetPrice: number;
  stopTrigger: number;
  stopLimit: number;
} {
  let targetPrice = roundToStep(
    entry.averagePrice * (1 + request.targetPct / 100),
    rules.tickSize,
  );

  let stopTrigger = floorToStep(
    entry.averagePrice * (1 - request.stopPct / 100),
    rules.tickSize,
  );

  let stopLimit = floorToStep(
    stopTrigger * (1 - STOP_LIMIT_BUFFER_PCT / 100),
    rules.tickSize,
  );

  if (targetPrice <= entry.averagePrice) {
    targetPrice = entry.averagePrice + rules.tickSize;
  }

  if (stopTrigger >= entry.averagePrice) {
    stopTrigger = entry.averagePrice - rules.tickSize;
  }

  if (stopLimit >= stopTrigger) {
    stopLimit = stopTrigger - rules.tickSize;
  }

  const quantity = floorToStep(
    sellableQuantity,
    rules.stepSize,
  );

  if (
    quantity < rules.minQty ||
    quantity > rules.maxQty
  ) {
    throw new RequestError(
      409,
      'OCO_QUANTITY_OUTSIDE_FILTER',
      'A quantidade disponível não atende ao filtro LOT_SIZE para criar a OCO.',
      {
        quantity,
        min_qty: rules.minQty,
        max_qty: rules.maxQty,
      },
    );
  }

  if (
    targetPrice <= 0 ||
    stopTrigger <= 0 ||
    stopLimit <= 0 ||
    !(stopLimit < stopTrigger && stopTrigger < entry.averagePrice) ||
    !(targetPrice > entry.averagePrice)
  ) {
    throw new RequestError(
      409,
      'INVALID_OCO_PRICES',
      'Os preços calculados para a proteção OCO são inválidos.',
      {
        average_price: entry.averagePrice,
        target_price: targetPrice,
        stop_trigger: stopTrigger,
        stop_limit: stopLimit,
      },
    );
  }

  return {
    quantity,
    targetPrice,
    stopTrigger,
    stopLimit,
  };
}

async function markPreEntryFailure(
  admin: SupabaseClient,
  options: {
    order: OrderRow;
    opportunity: TradeOpportunityRow | null;
    code: string;
    message: string;
    details?: unknown;
  },
): Promise<OrderRow> {
  const order = await updateOrder(admin, options.order.id, {
    status: 'erro_pre_entrada',
    erro: truncate(options.message, 5_000),
    binance_status: options.code,
    last_checked_at: new Date().toISOString(),
    raw: {
      ...asRecord(options.order.raw),
      pre_entry_failure: {
        code: options.code,
        message: options.message,
        details: options.details ?? null,
        at: new Date().toISOString(),
      },
    },
  });

  // Erros de mercado OPPORTUNITY_* já classificaram o card como expirado ou
  // invalidado em revalidateOpportunityMarket. Não sobrescreva essa decisão
  // auditável com um status genérico de erro.
  if (
    options.opportunity &&
    !options.code.startsWith('OPPORTUNITY_')
  ) {
    await markOpportunityBlocked(admin, {
      opportunity: options.opportunity,
      status: 'error',
      reason: options.message,
      code: options.code,
      orderId: order.id,
    });
  }

  return order;
}

async function markUnprotected(
  admin: SupabaseClient,
  options: {
    order: OrderRow;
    opportunity: TradeOpportunityRow | null;
    entry: EntrySummary;
    reason: string;
    details?: unknown;
    raw: Record<string, unknown>;
  },
): Promise<OrderRow> {
  const now = new Date().toISOString();

  const order = await updateOrder(admin, options.order.id, {
    status: 'entrada_sem_protecao',
    erro: truncate(options.reason, 5_000),
    unprotected_reason: truncate(options.reason, 5_000),
    binance_status: 'ENTRY_FILLED_OCO_NOT_CONFIRMED',
    last_checked_at: now,
    raw: {
      ...options.raw,
      protection_failure: {
        reason: options.reason,
        details: options.details ?? null,
        at: now,
      },
    },
  });

  if (options.opportunity) {
    await updateOpportunity(
      admin,
      options.opportunity.user_id,
      options.opportunity.id,
      {
        lifecycle_status: 'error',
        opened_at:
          options.opportunity.opened_at ?? options.entry.entryAt,
      },
    );

    await logOpportunityEvent(admin, {
      opportunityId: options.opportunity.id,
      userId: options.opportunity.user_id,
      eventType: 'protection_failed',
      actorType: 'exchange',
      data: {
        orderId: order.id,
        entryOrderId: options.entry.entryOrderId,
        entryPrice: options.entry.averagePrice,
        quantity: options.entry.quantity,
        reason: options.reason,
        requiresManualAttention: true,
      },
    });
  }

  return order;
}

function duplicateResponse(
  requestId: string,
  order: OrderRow,
  positionSizing?: Record<string, unknown> | null,
): Response {
  const entryExecuted = [
    'entrada_executada',
    'protecao_pendente',
    'oco_ativa',
    'entrada_sem_protecao',
    'alvo_executado',
    'stop_executado',
  ].includes(order.status);

  if (order.status === 'entrada_sem_protecao') {
    return errorResponse(
      requestId,
      409,
      'A compra já foi executada, mas a proteção OCO não está confirmada.',
      'ENTRY_UNPROTECTED',
      {
        detail:
          order.unprotected_reason ??
          order.erro ??
          'Confira a posição diretamente na Binance.',
        request_id: order.request_id,
        order_id: order.id,
        opportunity_id: order.opportunity_id ?? undefined,
        status: order.status,
        entrada_executada: true,
        protecao_confirmada: false,
        requires_manual_attention: true,
        position_sizing:
          positionSizing ?? asRecord(order.sizing_snapshot),
        order,
      },
    );
  }

  return jsonResponse(
    {
      ok: true,
      duplicate: true,
      message: 'Esta solicitação já havia sido processada.',
      request_id: order.request_id,
      order_id: order.id,
      opportunity_id: order.opportunity_id,
      is_testnet: order.is_testnet,
      entrada_executada: entryExecuted,
      protecao_confirmada: order.status === 'oco_ativa',
      position_sizing:
        positionSizing ?? asRecord(order.sizing_snapshot),
      order,
    },
    requestId,
  );
}

// ---------------------------------------------------------------------------
// Ações simples
// ---------------------------------------------------------------------------

async function handleSaveKeys(
  admin: SupabaseClient,
  userId: string,
  body: RequestBody,
  requestId: string,
): Promise<Response> {
  const apiKey = parseApiCredential(body.api_key, 'api_key');
  const apiSecret = parseApiCredential(
    body.api_secret,
    'api_secret',
  );
  const isTestnet = body.is_testnet !== false;
  const base = isTestnet ? TESTNET_BASE : REAL_BASE;

  const context: BinanceContext = {
    base,
    apiKey,
    secret: apiSecret,
    offset: await getTimeOffset(base),
    isTestnet,
  };

  // Testa antes de persistir. A credencial inválida nunca substitui uma chave
  // que já esteja funcionando.
  const account = await signedRequest<BinanceAccount>(
    context,
    'GET',
    '/api/v3/account',
    {
      omitZeroBalances: true,
    },
  );

  const encrypted = await encrypt(apiSecret);

  const { error } = await admin
    .from('exchange_keys')
    .upsert(
      {
        user_id: userId,
        api_key: apiKey,
        api_secret_enc: encrypted,
        is_testnet: isTestnet,
        atualizado_em: new Date().toISOString(),
      },
      {
        onConflict: 'user_id',
      },
    );

  if (error) {
    throw new RequestError(
      500,
      'KEY_SAVE_FAILED',
      `A chave foi validada, mas não pôde ser salva: ${error.message}`,
    );
  }

  const balances = (account.balances ?? [])
    .filter(
      (balance) =>
        (finite(balance.free) ?? 0) > 0 ||
        (finite(balance.locked) ?? 0) > 0,
    )
    .slice(0, 20);

  return jsonResponse(
    {
      ok: true,
      is_testnet: isTestnet,
      can_trade: account.canTrade !== false,
      balances,
    },
    requestId,
  );
}

async function handleDeleteKeys(
  admin: SupabaseClient,
  userId: string,
  requestId: string,
): Promise<Response> {
  const { error } = await admin
    .from('exchange_keys')
    .delete()
    .eq('user_id', userId);

  if (error) {
    throw new RequestError(
      500,
      'KEY_DELETE_FAILED',
      `Não foi possível remover a chave: ${error.message}`,
    );
  }

  return jsonResponse({ ok: true }, requestId);
}

async function buildBinanceContext(
  keys: ExchangeKeysRow,
): Promise<BinanceContext> {
  const base = keys.is_testnet ? TESTNET_BASE : REAL_BASE;

  return {
    base,
    apiKey: keys.api_key,
    secret: await decrypt(keys.api_secret_enc),
    offset: await getTimeOffset(base),
    isTestnet: keys.is_testnet,
  };
}

async function handleTestConnection(
  context: BinanceContext,
  requestId: string,
): Promise<Response> {
  const account = await signedRequest<BinanceAccount>(
    context,
    'GET',
    '/api/v3/account',
    {
      omitZeroBalances: true,
    },
  );

  const balances = (account.balances ?? [])
    .filter(
      (balance) =>
        (finite(balance.free) ?? 0) > 0 ||
        (finite(balance.locked) ?? 0) > 0,
    )
    .slice(0, 20);

  return jsonResponse(
    {
      ok: true,
      is_testnet: context.isTestnet,
      can_trade: account.canTrade !== false,
      balances,
    },
    requestId,
  );
}

async function handleOpenOrders(
  context: BinanceContext,
  body: RequestBody,
  requestId: string,
): Promise<Response> {
  const symbol = parseSymbol(body.symbol, 'BTCUSDT');
  const orders = await signedRequest<Record<string, unknown>>(
    context,
    'GET',
    '/api/v3/openOrders',
    { symbol },
  );

  return jsonResponse(
    {
      ok: true,
      is_testnet: context.isTestnet,
      symbol,
      orders,
    },
    requestId,
  );
}

// ---------------------------------------------------------------------------
// Compra + OCO
// ---------------------------------------------------------------------------

async function handlePlaceEntryOco(options: {
  req: Request;
  body: RequestBody;
  admin: SupabaseClient;
  auth: AuthenticationContext;
  userId: string;
  keys: ExchangeKeysRow;
  context: BinanceContext;
  requestId: string;
}): Promise<Response> {
  const {
    req,
    body,
    admin,
    auth,
    userId,
    keys,
    context,
    requestId: transportRequestId,
  } = options;

  const trade = await resolveTradeRequest(
    admin,
    userId,
    keys,
    body,
    req.headers.get('x-idempotency-key'),
    auth.mode,
  );

  const settings = await loadRiskSettings(admin, userId);
  const ids = deterministicClientIds(trade.requestId);

  // Idempotência antes de consultar a Binance ou criar uma nova decisão.
  // Uma repetição legítima sempre retorna a ordem já registrada.
  let existingOrder = await findOrderByRequestId(
    admin,
    userId,
    trade.requestId,
  );

  if (!existingOrder && trade.opportunityId) {
    existingOrder = await findOrderByOpportunity(
      admin,
      userId,
      trade.opportunityId,
    );
  }

  if (existingOrder) {
    let existingSizing: PositionSizingContext | null = null;

    if (trade.opportunityId) {
      const decision = await findPositionSizingDecision(
        admin,
        userId,
        trade.opportunityId,
      );

      if (decision) {
        existingSizing = positionSizingContextFromDecision(decision);

        await synchronizePositionSizingReservation(admin, {
          userId,
          opportunityId: trade.opportunityId,
          attemptId:
            auth.mode === 'auto_trade'
              ? auth.autoTradeAttempt?.id ?? null
              : null,
          context: existingSizing,
        });

        await applyPositionSizingToOrder(admin, {
          context: existingSizing,
          orderId: existingOrder.id,
          effectiveQuoteAmount:
            existingSizing.effectiveQuoteAmount,
          actualRiskUsdt:
            finite(existingOrder.actual_risk_usdt) ??
            existingSizing.plannedRiskUsdt,
          resultSnapshot: {
            stage: 'duplicate_reconciled',
            reconciled_at: new Date().toISOString(),
            order_status: existingOrder.status,
          },
          required: false,
        });
      }
    }

    return duplicateResponse(
      transportRequestId,
      existingOrder,
      existingSizing?.summary ?? null,
    );
  }

  // O saldo livre da própria conta Binance é uma entrada obrigatória para o
  // cálculo dinâmico. Ele nunca é aceito do navegador ou do worker cron.
  let account: BinanceAccount;

  try {
    account = await signedRequest<BinanceAccount>(
      context,
      'GET',
      '/api/v3/account',
      { omitZeroBalances: false },
    );
  } catch (error) {
    if (error instanceof BinanceRequestError) {
      throw error;
    }

    throw new RequestError(
      502,
      'BINANCE_ACCOUNT_QUERY_FAILED',
      `Não foi possível consultar a conta Binance: ${errorMessage(error)}`,
    );
  }

  const balances = Array.isArray(account.balances)
    ? account.balances
    : [];
  const usdt = balances.find(
    (balance) => balance.asset === 'USDT',
  );
  const freeUsdt = finite(usdt?.free) ?? 0;

  if (freeUsdt <= 0) {
    throw new RequestError(
      409,
      'INSUFFICIENT_USDT_BALANCE',
      'A conta não possui saldo livre em USDT para dimensionar a operação.',
      { free_usdt: freeUsdt },
    );
  }

  let positionSizing: PositionSizingContext | null = null;

  if (trade.opportunityId) {
    positionSizing = await reservePositionSizing(admin, {
      auth,
      userId,
      opportunityId: trade.opportunityId,
      availableBalanceUsdt: freeUsdt,
      executionEnvironment: keys.is_testnet
        ? 'testnet'
        : 'real',
    });

    // O valor que veio do claim é apenas a base provisória. A partir deste
    // ponto, somente o valor efetivo reservado pela política pode ser enviado.
    trade.quoteAmount = positionSizing.effectiveQuoteAmount;

    if (trade.opportunity) {
      trade.opportunity.quote_amount = trade.quoteAmount;
      trade.opportunity.position_sizing_decision_id =
        positionSizing.decision.id;
      trade.opportunity.sizing_snapshot =
        positionSizing.summary;
    }
  }

  const reservation = await reserveOrder(admin, {
    userId,
    opportunityId: trade.opportunityId,
    isTestnet: keys.is_testnet,
    symbol: trade.symbol,
    quoteAmount: trade.quoteAmount,
    requestId: trade.requestId,
    clientOrderId: ids.entry,
    listClientOrderId: ids.list,
    positionSizing,
    raw: {
      engine: 'binance-trade-v10',
      reserved_at: new Date().toISOString(),
      invocation: {
        mode: auth.mode,
        auto_trade_attempt_id:
          auth.autoTradeAttempt?.id ?? null,
      },
      request: {
        request_id: trade.requestId,
        opportunity_id: trade.opportunityId,
        symbol: trade.symbol,
        provisional_quote_amount:
          optionalPositiveNumber(body.quote_amount),
        effective_quote_amount: trade.quoteAmount,
        stop_pct: trade.stopPct,
        target_pct: trade.targetPct,
        is_testnet: keys.is_testnet,
      },
    },
  });

  if (reservation.duplicate) {
    if (positionSizing) {
      await applyPositionSizingToOrder(admin, {
        context: positionSizing,
        orderId: reservation.order.id,
        effectiveQuoteAmount:
          positionSizing.effectiveQuoteAmount,
        actualRiskUsdt:
          finite(reservation.order.actual_risk_usdt) ??
          positionSizing.plannedRiskUsdt,
        resultSnapshot: {
          stage: 'concurrent_duplicate_reconciled',
          reconciled_at: new Date().toISOString(),
          order_status: reservation.order.status,
        },
        required: false,
      });
    }

    return duplicateResponse(
      transportRequestId,
      reservation.order,
      positionSizing?.summary ?? null,
    );
  }

  let order = reservation.order;
  let market: { price: number; source: string };
  let rules: SymbolRules;

  try {
    // O vínculo é obrigatório antes de qualquer POST na Binance. Assim, toda
    // compra dinâmica possui decisão, tentativa e ordem local correlacionadas.
    if (positionSizing) {
      await applyPositionSizingToOrder(admin, {
        context: positionSizing,
        orderId: order.id,
        effectiveQuoteAmount: trade.quoteAmount,
        actualRiskUsdt: positionSizing.plannedRiskUsdt,
        resultSnapshot: {
          stage: 'order_reserved',
          reserved_at: new Date().toISOString(),
          transport_request_id: transportRequestId,
        },
        required: true,
      });
    }

    await assertOperationalLimits(admin, {
      userId,
      quoteAmount: trade.quoteAmount,
      stopPct: trade.stopPct,
      targetPct: trade.targetPct,
      isTestnet: keys.is_testnet,
      settings,
      excludeOrderId: order.id,
    });

    [market, rules] = await Promise.all([
      revalidateOpportunityMarket(admin, trade),
      getSymbolRules(context.base, trade.symbol),
    ]);

    if (rules.status !== 'TRADING' || !rules.spotAllowed) {
      throw new RequestError(
        409,
        'SYMBOL_NOT_TRADING',
        'O par não está disponível para negociação Spot.',
        {
          symbol_status: rules.status,
          spot_allowed: rules.spotAllowed,
        },
      );
    }

    if (rules.quoteAsset !== 'USDT') {
      throw new RequestError(
        409,
        'QUOTE_ASSET_NOT_USDT',
        'O ativo não é cotado em USDT neste ambiente.',
      );
    }

    if (!rules.quoteOrderQtyMarketAllowed) {
      throw new RequestError(
        409,
        'QUOTE_ORDER_QTY_UNAVAILABLE',
        'A Binance não permite MARKET por valor em USDT para este ativo.',
      );
    }

    if (trade.quoteAmount < rules.minNotional) {
      throw new RequestError(
        409,
        'BELOW_MIN_NOTIONAL',
        `O valor mínimo para ${trade.symbol} é ${rules.minNotional} USDT.`,
        {
          quote_amount: trade.quoteAmount,
          min_notional: rules.minNotional,
        },
      );
    }

    if (
      rules.maxNotional !== null &&
      trade.quoteAmount > rules.maxNotional
    ) {
      throw new RequestError(
        409,
        'ABOVE_MAX_NOTIONAL',
        `O valor máximo aceito pela Binance para ${trade.symbol} é ${rules.maxNotional} USDT.`,
      );
    }

    if (account.canTrade === false) {
      throw new RequestError(
        403,
        'BINANCE_TRADING_DISABLED',
        'A chave Binance não possui permissão de negociação.',
      );
    }

    if (freeUsdt < trade.quoteAmount) {
      throw new RequestError(
        409,
        'INSUFFICIENT_USDT_BALANCE',
        'Saldo livre em USDT insuficiente para a compra.',
        {
          free_usdt: freeUsdt,
          quote_amount: trade.quoteAmount,
        },
      );
    }
  } catch (error) {
    const message = errorMessage(error);
    const code =
      error instanceof RequestError
        ? error.code
        : error instanceof BinanceRequestError
          ? 'BINANCE_PREFLIGHT_FAILED'
          : 'PREFLIGHT_FAILED';
    const details =
      error instanceof RequestError
        ? error.details
        : error instanceof BinanceRequestError
          ? error.payload
          : null;

    order = await markPreEntryFailure(admin, {
      order,
      opportunity: trade.opportunity,
      code,
      message,
      details,
    });

    const status =
      error instanceof RequestError
        ? error.status
        : error instanceof BinanceRequestError && error.status
          ? Math.max(400, Math.min(599, error.status))
          : 502;

    return errorResponse(
      transportRequestId,
      status,
      message,
      code,
      {
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: false,
        protecao_confirmada: false,
        position_sizing: positionSizing?.summary ?? null,
        order,
        details,
      },
    );
  }

  if (trade.opportunity) {
    await updateOpportunity(
      admin,
      userId,
      trade.opportunity.id,
      {
        lifecycle_status: 'opening',
        quote_amount: trade.quoteAmount,
      },
    );

    await logOpportunityEvent(admin, {
      opportunityId: trade.opportunity.id,
      userId,
      eventType: 'entry_revalidation_passed',
      data: {
        orderId: order.id,
        marketPrice: market.price,
        marketSource: market.source,
        maximumEntryPrice: trade.maximumEntryPrice,
        quoteAmount: trade.quoteAmount,
        positionSizingDecisionId:
          positionSizing?.decision.id ?? null,
        sizingMode:
          positionSizing?.decision.sizing_mode ?? 'fixed',
        riskMultiplier:
          finite(positionSizing?.decision.risk_multiplier) ?? 1,
        environment: keys.is_testnet ? 'testnet' : 'real',
      },
    });

    await logOpportunityEvent(admin, {
      opportunityId: trade.opportunity.id,
      userId,
      eventType: 'order_created',
      data: {
        orderId: order.id,
        requestId: trade.requestId,
        clientOrderId: ids.entry,
      },
    });
  }

  order = await updateOrder(admin, order.id, {
    status: 'entrada_enviada',
    erro: null,
    binance_status: 'ENTRY_REQUEST_SENT',
    last_checked_at: new Date().toISOString(),
    raw: {
      ...asRecord(order.raw),
      preflight: {
        market_price: market.price,
        market_source: market.source,
        symbol_rules: rules,
        account_free_usdt: freeUsdt,
        effective_quote_amount: trade.quoteAmount,
        position_sizing: positionSizing?.summary ?? null,
        completed_at: new Date().toISOString(),
      },
    },
  });

  await logOpportunityEvent(admin, {
    opportunityId: trade.opportunityId,
    userId,
    eventType: 'order_sent',
    actorType: 'exchange',
    data: {
      orderId: order.id,
      clientOrderId: ids.entry,
      quoteAmount: trade.quoteAmount,
    },
  });

  let entryResult: Awaited<
    ReturnType<typeof sendEntryWithReconciliation>
  >;

  try {
    entryResult = await sendEntryWithReconciliation(
      context,
      {
        symbol: trade.symbol,
        side: 'BUY',
        type: 'MARKET',
        quoteOrderQty: trade.quoteAmount,
        newClientOrderId: ids.entry,
        newOrderRespType: 'FULL',
      },
      trade.symbol,
      ids.entry,
    );
  } catch (error) {
    const message = errorMessage(error);
    const code =
      error instanceof BinanceRequestError
        ? `BINANCE_ENTRY_${error.code ?? error.status ?? 'FAILED'}`
        : 'ENTRY_REQUEST_FAILED';

    order = await markPreEntryFailure(admin, {
      order,
      opportunity: trade.opportunity,
      code,
      message,
      details:
        error instanceof BinanceRequestError
          ? error.payload
          : null,
    });

    return errorResponse(
      transportRequestId,
      error instanceof BinanceRequestError && error.status
        ? Math.max(400, Math.min(599, error.status))
        : 502,
      message,
      'ENTRY_REJECTED',
      {
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: false,
        protecao_confirmada: false,
        order,
      },
    );
  }

  if (!entryResult.order) {
    order = await updateOrder(admin, order.id, {
      status: 'entrada_enviada',
      erro:
        'O resultado da compra não pôde ser confirmado. Não repita a solicitação com outro request_id.',
      binance_status: 'ENTRY_STATUS_UNKNOWN',
      last_checked_at: new Date().toISOString(),
      raw: {
        ...asRecord(order.raw),
        entry_unknown: {
          initial_error:
            entryResult.initialError?.payload ??
            entryResult.initialError?.message ??
            null,
          at: new Date().toISOString(),
        },
      },
    });

    await logOpportunityEvent(admin, {
      opportunityId: trade.opportunityId,
      userId,
      eventType: 'error',
      actorType: 'exchange',
      data: {
        stage: 'entry_status_unknown',
        orderId: order.id,
        clientOrderId: ids.entry,
        retryWithSameRequestId: true,
      },
    });

    return errorResponse(
      transportRequestId,
      502,
      'A Binance não confirmou se a compra foi executada. O monitor continuará a reconciliação.',
      'ENTRY_STATUS_UNKNOWN',
      {
        detail:
          'Não envie outra ordem. A próxima tentativa deve reutilizar o mesmo request_id.',
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: false,
        protecao_confirmada: false,
        execution_status_unknown: true,
        order,
      },
    );
  }

  const entryOrder = entryResult.order;
  const entryStatus = String(entryOrder.status ?? 'UNKNOWN');
  const executedQty = positive(entryOrder.executedQty) ?? 0;

  if (
    executedQty <= 0 &&
    TERMINAL_BINANCE_ORDER_STATUSES.has(entryStatus)
  ) {
    order = await markPreEntryFailure(admin, {
      order,
      opportunity: trade.opportunity,
      code: `ENTRY_${entryStatus}`,
      message: `A ordem de entrada terminou como ${entryStatus} sem execução.`,
      details: entryOrder,
    });

    return errorResponse(
      transportRequestId,
      409,
      'A compra não foi executada pela Binance.',
      'ENTRY_NOT_FILLED',
      {
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: false,
        protecao_confirmada: false,
        order,
        details: {
          binance_status: entryStatus,
        },
      },
    );
  }

  if (executedQty <= 0) {
    order = await updateOrder(admin, order.id, {
      status: 'entrada_enviada',
      erro:
        'A entrada existe na Binance, mas ainda não possui quantidade executada confirmada.',
      binance_status: entryStatus,
      entry_order_id: entryOrder.orderId ?? null,
      last_checked_at: new Date().toISOString(),
      raw: {
        ...asRecord(order.raw),
        entry: entryOrder,
        entry_reconciled: entryResult.reconciled,
      },
    });

    return errorResponse(
      transportRequestId,
      409,
      'A entrada ainda não possui execução confirmada.',
      'ENTRY_PENDING_CONFIRMATION',
      {
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: false,
        protecao_confirmada: false,
        execution_status_unknown: true,
        order,
      },
    );
  }

  let entry: EntrySummary;

  try {
    entry = summarizeEntry(entryOrder, rules, ids.entry);
  } catch (error) {
    const message = errorMessage(error);

    order = await updateOrder(admin, order.id, {
      status: 'entrada_sem_protecao',
      erro: truncate(message, 5_000),
      unprotected_reason: truncate(message, 5_000),
      binance_status: entryStatus,
      entry_order_id: entryOrder.orderId ?? null,
      qty: executedQty,
      last_checked_at: new Date().toISOString(),
      raw: {
        ...asRecord(order.raw),
        entry: entryOrder,
        summary_error: message,
      },
    });

    if (trade.opportunity) {
      await updateOpportunity(admin, userId, trade.opportunity.id, {
        lifecycle_status: 'error',
      });
    }

    return errorResponse(
      transportRequestId,
      409,
      'A compra foi executada, mas os dados necessários para criar a proteção não puderam ser confirmados.',
      'ENTRY_FILLED_SUMMARY_FAILED',
      {
        detail: message,
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: true,
        protecao_confirmada: false,
        requires_manual_attention: true,
        order,
      },
    );
  }

  order = await updateOrder(admin, order.id, {
    status: 'entrada_executada',
    qty: entry.quantity,
    entry_price: entry.averagePrice,
    entry_order_id: entry.entryOrderId,
    erro: null,
    binance_status: entryStatus,
    last_checked_at: new Date().toISOString(),
    raw: {
      ...asRecord(order.raw),
      entry: entryOrder,
      entry_reconciled: entryResult.reconciled,
      entry_initial_error:
        entryResult.initialError?.payload ?? null,
      entry_summary: entry,
    },
  });

  await upsertExecutedOutcome(admin, {
    opportunity: trade.opportunity,
    entry,
    orderId: order.id,
  });

  await logOpportunityEvent(admin, {
    opportunityId: trade.opportunityId,
    userId,
    eventType: 'entry_filled',
    actorType: 'exchange',
    data: {
      orderId: order.id,
      entryOrderId: entry.entryOrderId,
      clientOrderId: entry.entryClientOrderId,
      quantity: entry.quantity,
      averagePrice: entry.averagePrice,
      quoteSpent: entry.quoteSpent,
      feesUsdt: entry.feesUsdt,
    },
  });

  order = await updateOrder(admin, order.id, {
    status: 'protecao_pendente',
    binance_status: 'ENTRY_FILLED_PROTECTION_PENDING',
    last_checked_at: new Date().toISOString(),
  });

  await logOpportunityEvent(admin, {
    opportunityId: trade.opportunityId,
    userId,
    eventType: 'protection_pending',
    actorType: 'edge_function',
    data: {
      orderId: order.id,
      listClientOrderId: ids.list,
    },
  });

  let protectionPlan: ReturnType<typeof buildProtection>;

  try {
    const sellableQuantity = await availableBaseQuantity(
      context,
      rules.baseAsset,
      entry.quantity,
      rules,
    );

    protectionPlan = buildProtection(
      entry,
      trade,
      rules,
      sellableQuantity,
    );
  } catch (error) {
    const message = errorMessage(error);
    const raw = {
      ...asRecord(order.raw),
      entry: entryOrder,
      entry_summary: entry,
    };

    order = await markUnprotected(admin, {
      order,
      opportunity: trade.opportunity,
      entry,
      reason: message,
      details:
        error instanceof RequestError
          ? error.details
          : null,
      raw,
    });

    return errorResponse(
      transportRequestId,
      409,
      'A compra foi executada, mas a proteção OCO não pôde ser preparada.',
      'ENTRY_UNPROTECTED',
      {
        detail: message,
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: true,
        protecao_confirmada: false,
        requires_manual_attention: true,
        order,
      },
    );
  }

  let ocoResult: Awaited<
    ReturnType<typeof sendOcoWithReconciliation>
  >;

  try {
    ocoResult = await sendOcoWithReconciliation(
      context,
      {
        symbol: trade.symbol,
        side: 'SELL',
        quantity: decimalString(
          protectionPlan.quantity,
          rules.stepSizeText,
        ),
        listClientOrderId: ids.list,
        aboveType: 'LIMIT_MAKER',
        aboveClientOrderId: ids.target,
        abovePrice: decimalString(
          protectionPlan.targetPrice,
          rules.tickSizeText,
        ),
        belowType: 'STOP_LOSS_LIMIT',
        belowClientOrderId: ids.stop,
        belowStopPrice: decimalString(
          protectionPlan.stopTrigger,
          rules.tickSizeText,
        ),
        belowPrice: decimalString(
          protectionPlan.stopLimit,
          rules.tickSizeText,
        ),
        belowTimeInForce: 'GTC',
        newOrderRespType: 'RESULT',
      },
      ids.list,
    );
  } catch (error) {
    const message = errorMessage(error);
    const raw = {
      ...asRecord(order.raw),
      entry: entryOrder,
      entry_summary: entry,
      protection_plan: protectionPlan,
    };

    order = await markUnprotected(admin, {
      order,
      opportunity: trade.opportunity,
      entry,
      reason: message,
      details:
        error instanceof BinanceRequestError
          ? error.payload
          : null,
      raw,
    });

    return errorResponse(
      transportRequestId,
      409,
      'A compra foi executada, mas a Binance recusou a proteção OCO.',
      'ENTRY_UNPROTECTED',
      {
        detail: message,
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: true,
        protecao_confirmada: false,
        requires_manual_attention: true,
        order,
      },
    );
  }

  if (!ocoResult.list) {
    const message =
      'A compra foi executada, mas o resultado da OCO permaneceu desconhecido após a reconciliação.';
    const raw = {
      ...asRecord(order.raw),
      entry: entryOrder,
      entry_summary: entry,
      protection_plan: protectionPlan,
      oco_unknown: {
        initial_error:
          ocoResult.initialError?.payload ??
          ocoResult.initialError?.message ??
          null,
        at: new Date().toISOString(),
      },
    };

    order = await markUnprotected(admin, {
      order,
      opportunity: trade.opportunity,
      entry,
      reason: message,
      raw,
    });

    return errorResponse(
      transportRequestId,
      409,
      message,
      'ENTRY_UNPROTECTED',
      {
        detail:
          'Não envie outra ordem. Abra a Binance agora e confirme se a OCO existe; proteja ou encerre manualmente se necessário.',
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: true,
        protecao_confirmada: false,
        execution_status_unknown: true,
        requires_manual_attention: true,
        order,
      },
    );
  }

  const oco = ocoResult.list;
  const ocoListId = finite(oco.orderListId);

  if (ocoListId === null) {
    const message =
      'A Binance retornou a OCO sem orderListId confirmado.';

    order = await markUnprotected(admin, {
      order,
      opportunity: trade.opportunity,
      entry,
      reason: message,
      details: oco,
      raw: {
        ...asRecord(order.raw),
        entry: entryOrder,
        entry_summary: entry,
        protection_plan: protectionPlan,
        oco,
      },
    });

    return errorResponse(
      transportRequestId,
      409,
      message,
      'ENTRY_UNPROTECTED',
      {
        request_id: trade.requestId,
        order_id: order.id,
        opportunity_id: trade.opportunityId ?? undefined,
        status: order.status,
        entrada_executada: true,
        protecao_confirmada: false,
        requires_manual_attention: true,
        order,
      },
    );
  }

  const protectedAt = new Date(
    finite(oco.transactionTime) ?? Date.now(),
  ).toISOString();

  const protection: ProtectionSummary = {
    quantity: protectionPlan.quantity,
    targetPrice: protectionPlan.targetPrice,
    stopTrigger: protectionPlan.stopTrigger,
    stopLimit: protectionPlan.stopLimit,
    ocoListId,
    listClientOrderId:
      oco.listClientOrderId || ids.list,
    protectedAt,
  };

  order = await updateOrder(admin, order.id, {
    status: 'oco_ativa',
    qty: protection.quantity,
    stop_price: protection.stopTrigger,
    target_price: protection.targetPrice,
    oco_list_id: protection.ocoListId,
    protected_at: protection.protectedAt,
    last_checked_at: protection.protectedAt,
    binance_status:
      truncate(
        [
          oco.listStatusType,
          oco.listOrderStatus,
        ].filter(Boolean).join(' / '),
        250,
      ) || 'OCO_ACTIVE',
    erro: null,
    unprotected_reason: null,
    raw: {
      ...asRecord(order.raw),
      entry: entryOrder,
      entry_reconciled: entryResult.reconciled,
      entry_summary: entry,
      protection_plan: protectionPlan,
      oco,
      oco_reconciled: ocoResult.reconciled,
      oco_initial_error:
        ocoResult.initialError?.payload ?? null,
      protection,
      position_sizing: positionSizing?.summary ?? null,
    },
  });

  if (positionSizing) {
    const actualRiskUsdt = estimateActualRiskAtStop(
      positionSizing,
      entry,
      protection.stopTrigger,
    );

    await applyPositionSizingToOrder(admin, {
      context: positionSizing,
      orderId: order.id,
      effectiveQuoteAmount: trade.quoteAmount,
      actualRiskUsdt,
      resultSnapshot: {
        stage: 'protection_confirmed',
        confirmed_at: protection.protectedAt,
        entry_price: entry.averagePrice,
        entry_quantity: entry.quantity,
        quote_spent: entry.quoteSpent,
        stop_price: protection.stopTrigger,
        target_price: protection.targetPrice,
        actual_risk_usdt: actualRiskUsdt,
        oco_list_id: protection.ocoListId,
      },
      required: false,
    });

    const refreshedOrder = await findOrderByRequestId(
      admin,
      userId,
      trade.requestId,
    );

    if (refreshedOrder) {
      order = refreshedOrder;
    }
  }

  if (trade.opportunity) {
    await updateOpportunity(
      admin,
      userId,
      trade.opportunity.id,
      {
        lifecycle_status: 'open',
        opened_at:
          trade.opportunity.opened_at ?? entry.entryAt,
        quote_amount: trade.quoteAmount,
      },
    );

    await logOpportunityEvent(admin, {
      opportunityId: trade.opportunity.id,
      userId,
      eventType: 'protection_created',
      actorType: 'exchange',
      data: {
        orderId: order.id,
        ocoListId: protection.ocoListId,
        listClientOrderId: protection.listClientOrderId,
        targetPrice: protection.targetPrice,
        stopTrigger: protection.stopTrigger,
        stopLimit: protection.stopLimit,
        quantity: protection.quantity,
      },
    });
  }

  return jsonResponse(
    {
      ok: true,
      duplicate: false,
      is_testnet: keys.is_testnet,
      request_id: trade.requestId,
      order_id: order.id,
      opportunity_id: trade.opportunityId,
      entrada_executada: true,
      protecao_confirmada: true,
      position_sizing: positionSizing?.summary ?? null,
      entrada: {
        qty: entry.quantity,
        preco_medio: entry.averagePrice,
        gasto_usdt: entry.quoteSpent,
        order_id: entry.entryOrderId,
        client_order_id: entry.entryClientOrderId,
        taxas_usdt: entry.feesUsdt,
      },
      saida: {
        alvo: protection.targetPrice,
        stop: protection.stopTrigger,
        stop_limit: protection.stopLimit,
        oco_list_id: protection.ocoListId,
        list_client_order_id:
          protection.listClientOrderId,
      },
      order,
      educational_notice:
        keys.is_testnet
          ? 'A operação foi enviada à Binance Spot Testnet. Resultados simulados não garantem desempenho em conta real.'
          : 'A operação foi enviada à conta real após validação dos limites configurados. Confira a posição diretamente na Binance.',
    },
    transportRequestId,
  );
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
      requestId,
      405,
      'Método não permitido.',
      'METHOD_NOT_ALLOWED',
      {
        details: {
          allowed: ['POST', 'OPTIONS'],
        },
      },
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get(
    'SUPABASE_SERVICE_ROLE_KEY',
  );

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse(
      requestId,
      500,
      'Configuração interna indisponível.',
      'SERVER_CONFIG_ERROR',
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  try {
    const auth = await authenticateInvocation({
      req,
      requestId,
      supabaseUrl,
      anonKey,
      serviceRoleKey,
      admin,
    });

    const body = await readBody(req);
    const action = parseAction(body.action);

    assertAutoTradeInvocation({
      req,
      auth,
      action,
      body,
    });

    if (action === 'save_keys') {
      return await handleSaveKeys(
        admin,
        auth.userId,
        body,
        requestId,
      );
    }

    if (action === 'delete_keys') {
      return await handleDeleteKeys(
        admin,
        auth.userId,
        requestId,
      );
    }

    const keys = await loadKeys(admin, auth.userId);
    const context = await buildBinanceContext(keys);

    if (action === 'test_connection') {
      return await handleTestConnection(context, requestId);
    }

    if (action === 'open_orders') {
      return await handleOpenOrders(
        context,
        body,
        requestId,
      );
    }

    return await handlePlaceEntryOco({
      req,
      body,
      admin,
      auth,
      userId: auth.userId,
      keys,
      context,
      requestId,
    });
  } catch (error) {
    console.error(`[${requestId}] binance-trade:`, error);

    if (error instanceof RequestError) {
      return errorResponse(
        requestId,
        error.status,
        error.message,
        error.code,
        {
          details: error.details,
        },
      );
    }

    if (error instanceof BinanceRequestError) {
      const status =
        error.status && error.status >= 400
          ? Math.min(599, error.status)
          : 502;

      return errorResponse(
        requestId,
        status,
        error.message,
        'BINANCE_ERROR',
        {
          execution_status_unknown: error.uncertain,
          details: {
            binance_code: error.code,
            payload: error.payload,
          },
        },
      );
    }

    return errorResponse(
      requestId,
      500,
      'Não foi possível concluir a operação.',
      'INTERNAL_ERROR',
      {
        detail: errorMessage(error),
      },
    );
  }
});