// ============================================================================
// VigIA Trade — Edge Function: acompanhar-resultados-teoricos
// supabase/functions/acompanhar-resultados-teoricos/index.ts
// ============================================================================
//
// Acompanha, com candles encerrados de 1 minuto da Binance, os resultados
// teóricos das oportunidades registradas na Central de Oportunidades.
//
// O motor:
// - mede alvo, stop, MFE e MAE sem consultar chaves privadas da Binance;
// - mantém o resultado de oportunidades aceitas, recusadas ou ignoradas;
// - resolve alvo/stop na ordem dos candles de 1 minuto;
// - marca como ambíguo quando alvo e stop ocorrem no mesmo candle de 1 minuto
//   e a abertura do candle não permite determinar qual aconteceu primeiro;
// - encerra o cenário pelo preço de fechamento ao atingir o horizonte máximo;
// - usa atualização otimista para evitar que execuções concorrentes sobrescrevam
//   um resultado mais recente;
// - não cria, cancela ou executa ordens.
//
// Segurança:
// - publique esta função com verify_jwt = false;
// - chamadas do aplicativo validam o JWT do usuário dentro da função;
// - chamadas agendadas exigem CRON_SECRET;
// - a service_role permanece somente no ambiente interno da Edge Function;
// - usuário comum acompanha apenas suas próprias oportunidades;
// - todas as gravações são feitas pelo cliente service_role após autenticação.
//
// Uso manual:
//   POST { "opportunity_id": "<uuid>" }
//
// Uso agendado:
//   POST { "limit": 50, "max_candles_per_outcome": 1000 }
//   x-cron-secret: <CRON_SECRET>
// ============================================================================

import {
  createClient,
  type SupabaseClient,
} from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface TrackingRequestBody {
  opportunity_id?: unknown;
  user_id?: unknown;
  limit?: unknown;
  max_candles_per_outcome?: unknown;
  horizon_candles?: unknown;
  dry_run?: unknown;
  as_of?: unknown;
}

interface ParsedRequest {
  opportunityId: string | null;
  requestedUserId: string | null;
  limit: number;
  maxCandlesPerOutcome: number;
  horizonCandlesOverride: number | null;
  dryRun: boolean;
  asOf: string | null;
}

interface AuthenticationContext {
  mode: 'user' | 'internal';
  userId: string | null;
  service: SupabaseClient;
}

interface OutcomeRow {
  id: string;
  opportunity_id: string;
  user_id: string;
  mode: 'theoretical';
  status: string;

  entry_price: number | string | null;
  entry_at: string | null;
  exit_price: number | string | null;
  exit_at: string | null;
  exit_reason: string | null;

  gross_pnl_pct: number | string | null;
  net_pnl_pct: number | string | null;
  gross_pnl_usdt: number | string | null;
  net_pnl_usdt: number | string | null;
  result_r: number | string | null;

  fees_usdt: number | string;
  slippage_usdt: number | string;

  maximum_favorable_excursion_r: number | string | null;
  maximum_adverse_excursion_r: number | string | null;

  target_hit_at: string | null;
  stop_hit_at: string | null;
  resolved_at: string | null;

  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface OpportunityRow {
  id: string;
  user_id: string;
  opportunity_type: string;
  symbol: string;
  timeframe: string;
  direction: string;
  lifecycle_status: string;
  entry_decision: string;
  execution_environment: string;
  quote_amount: number | string | null;

  entry_reference: number | string | null;
  maximum_entry_price: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;

  strategy: string;
  strategy_version: string;
  detected_at: string;
  expires_at: string | null;

  plan_snapshot: Record<string, unknown>;
  market_snapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface BinanceKline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

interface MarketPage {
  candles: BinanceKline[];
  source: string;
  requestedStartTime: number;
  requestedEndTime: number;
}

type ResolutionStatus =
  | 'tracking'
  | 'target_hit'
  | 'stop_hit'
  | 'manual_exit'
  | 'ambiguous'
  | 'error';

type TrackingDisposition =
  | 'tracking_updated'
  | 'target_hit'
  | 'stop_hit'
  | 'horizon_exit'
  | 'ambiguous'
  | 'error'
  | 'dry_run'
  | 'no_new_data'
  | 'conflict'
  | 'skipped';

interface TrackingItem {
  outcome_id: string;
  opportunity_id: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  strategy_version: string;
  disposition: TrackingDisposition;
  status: ResolutionStatus;
  processed_candles: number;
  last_processed_at: string | null;
  horizon_at: string | null;
  mfe_r: number | null;
  mae_r: number | null;
  exit_price: number | null;
  result_r: number | null;
  message?: string;
}

interface TrackingPlan {
  direction: 'long' | 'short';
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPerUnit: number;
  quoteAmount: number | null;
  entryAt: number;
  horizonCandles: number;
  horizonAt: number;
}

interface ExcursionState {
  maximumFavorableR: number | null;
  maximumAdverseR: number | null;
}

interface CandleResolution {
  status: 'target_hit' | 'stop_hit' | 'ambiguous';
  exitPrice: number | null;
  exitReason: string;
  resolvedAt: string;
  targetHitAt: string | null;
  stopHitAt: string | null;
  candle: BinanceKline;
}

interface TrackingComputation {
  disposition: TrackingDisposition;
  status: ResolutionStatus;
  processedCandles: number;
  lastProcessedAt: string | null;
  lastProcessedOpenTime: number | null;
  lastProcessedCloseTime: number | null;
  lastProcessedClosePrice: number | null;
  marketSource: string | null;
  horizonAt: string;
  excursion: ExcursionState;

  exitPrice: number | null;
  exitAt: string | null;
  exitReason: string | null;
  targetHitAt: string | null;
  stopHitAt: string | null;
  grossPnlPct: number | null;
  netPnlPct: number | null;
  grossPnlUsdt: number | null;
  netPnlUsdt: number | null;
  resultR: number | null;
  resolvedAt: string | null;

  message?: string;
}

interface ErrorPayload {
  error: string;
  code: string;
  request_id: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 16_384;

const DEFAULT_USER_LIMIT = 20;
const DEFAULT_INTERNAL_LIMIT = 50;
const MAX_USER_LIMIT = 50;
const MAX_INTERNAL_LIMIT = 200;

const DEFAULT_MAX_CANDLES_PER_OUTCOME = 1_000;
const MAX_CANDLES_PER_OUTCOME = 1_000;
const TRACKING_CONCURRENCY = 4;

const FETCH_TIMEOUT_MS = 9_000;
const BINANCE_INTERVAL = '1m';
const ONE_MINUTE_MS = 60_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TIMEFRAME_DURATION_MS: Readonly<Record<string, number>> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

const DEFAULT_HORIZON_CANDLES: Readonly<Record<string, number>> = {
  '5m': 48,
  '15m': 48,
  '30m': 48,
  '1h': 48,
};

const BINANCE_PUBLIC_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
] as const;

const OUTCOME_SELECT = [
  'id',
  'opportunity_id',
  'user_id',
  'mode',
  'status',
  'entry_price',
  'entry_at',
  'exit_price',
  'exit_at',
  'exit_reason',
  'gross_pnl_pct',
  'net_pnl_pct',
  'gross_pnl_usdt',
  'net_pnl_usdt',
  'result_r',
  'fees_usdt',
  'slippage_usdt',
  'maximum_favorable_excursion_r',
  'maximum_adverse_excursion_r',
  'target_hit_at',
  'stop_hit_at',
  'resolved_at',
  'metadata',
  'created_at',
  'updated_at',
].join(',');

const OPPORTUNITY_SELECT = [
  'id',
  'user_id',
  'opportunity_type',
  'symbol',
  'timeframe',
  'direction',
  'lifecycle_status',
  'entry_decision',
  'execution_environment',
  'quote_amount',
  'entry_reference',
  'maximum_entry_price',
  'stop_reference',
  'target_reference',
  'strategy',
  'strategy_version',
  'detected_at',
  'expires_at',
  'plan_snapshot',
  'market_snapshot',
  'metadata',
].join(',');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---------------------------------------------------------------------------
// Respostas HTTP
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
  const payload: ErrorPayload = {
    error,
    code,
    request_id: requestId,
  };

  if (details !== undefined) {
    payload.details = details;
  }

  return jsonResponse(payload, requestId, status);
}

// ---------------------------------------------------------------------------
// Entrada e validação
// ---------------------------------------------------------------------------

async function readJsonBody(req: Request): Promise<TrackingRequestBody> {
  const declaredLength = Number(req.headers.get('content-length') ?? 0);

  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
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

    return parsed as TrackingRequestBody;
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

function assertAllowedBodyKeys(body: TrackingRequestBody): void {
  const allowed = new Set([
    'opportunity_id',
    'user_id',
    'limit',
    'max_candles_per_outcome',
    'horizon_candles',
    'dry_run',
    'as_of',
  ]);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new Error(`Campo não suportado: ${key}.`);
    }
  }
}

function parseUuid(
  value: unknown,
  name: string,
  optional = true,
): string | null {
  if (value === undefined || value === null || value === '') {
    if (optional) {
      return null;
    }

    throw new Error(`${name} é obrigatório.`);
  }

  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new Error(`${name} deve ser um UUID válido.`);
  }

  return value.trim().toLowerCase();
}

function parseBoolean(
  value: unknown,
  name: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== 'boolean') {
    throw new Error(`${name} deve ser verdadeiro ou falso.`);
  }

  return value;
}

function parseInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${name} deve ser um inteiro entre ${minimum} e ${maximum}.`,
    );
  }

  return parsed;
}

function parseOptionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return parseInteger(value, name, minimum, minimum, maximum);
}

function parseOptionalIsoDate(
  value: unknown,
  name: string,
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} deve ser uma data ISO 8601.`);
  }

  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} deve ser uma data ISO 8601 válida.`);
  }

  return new Date(parsed).toISOString();
}

function parseRequest(
  body: TrackingRequestBody,
  mode: AuthenticationContext['mode'],
): ParsedRequest {
  assertAllowedBodyKeys(body);

  const opportunityId = parseUuid(
    body.opportunity_id,
    'opportunity_id',
  );

  const requestedUserId = parseUuid(body.user_id, 'user_id');

  if (mode !== 'internal' && requestedUserId !== null) {
    throw new Error('user_id só pode ser usado no modo interno.');
  }

  if (mode !== 'internal' && body.as_of !== undefined) {
    throw new Error('as_of só pode ser usado no modo interno.');
  }

  const maxLimit =
    mode === 'internal' ? MAX_INTERNAL_LIMIT : MAX_USER_LIMIT;

  const defaultLimit =
    mode === 'internal' ? DEFAULT_INTERNAL_LIMIT : DEFAULT_USER_LIMIT;

  return {
    opportunityId,
    requestedUserId,
    limit: parseInteger(
      body.limit,
      'limit',
      opportunityId ? 1 : defaultLimit,
      1,
      maxLimit,
    ),
    maxCandlesPerOutcome: parseInteger(
      body.max_candles_per_outcome,
      'max_candles_per_outcome',
      DEFAULT_MAX_CANDLES_PER_OUTCOME,
      1,
      MAX_CANDLES_PER_OUTCOME,
    ),
    horizonCandlesOverride: parseOptionalInteger(
      body.horizon_candles,
      'horizon_candles',
      1,
      10_000,
    ),
    dryRun: parseBoolean(body.dry_run, 'dry_run', false),
    asOf: parseOptionalIsoDate(body.as_of, 'as_of'),
  };
}

// ---------------------------------------------------------------------------
// Autenticação
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
  const authorization = req.headers.get('Authorization');

  if (!authorization?.startsWith('Bearer ')) {
    return null;
  }

  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

async function authenticate(
  req: Request,
  requestId: string,
): Promise<AuthenticationContext | Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const configuredCronSecret = Deno.env.get('CRON_SECRET');

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error(
      `[${requestId}] Configuração Supabase incompleta.`,
    );

    return errorResponse(
      500,
      'Configuração interna indisponível.',
      'SERVER_CONFIG_ERROR',
      requestId,
    );
  }

  const service = createClient(
    supabaseUrl,
    serviceRoleKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );

  /*
   * A chamada agendada é identificada pelo CRON_SECRET.
   * A chave service_role fica somente dentro da Edge Function.
   */
  const suppliedCronSecret =
    req.headers.get('x-cron-secret')?.trim() ?? '';

  if (suppliedCronSecret) {
    if (
      !configuredCronSecret ||
      !timingSafeEqual(
        suppliedCronSecret,
        configuredCronSecret,
      )
    ) {
      return errorResponse(
        403,
        'Credencial interna incompleta ou inválida.',
        'INVALID_INTERNAL_CREDENTIAL',
        requestId,
      );
    }

    return {
      mode: 'internal',
      userId: null,
      service,
    };
  }

  /*
   * Sem x-cron-secret, exige o JWT de uma sessão comum.
   */
  const token = bearerToken(req);

  if (!token) {
    return errorResponse(
      401,
      'Usuário não autenticado.',
      'UNAUTHORIZED',
      requestId,
    );
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
    console.warn(
      `[${requestId}] JWT de usuário recusado:`,
      error?.message ?? 'usuário não encontrado',
    );

    return errorResponse(
      401,
      'Sessão inválida ou expirada.',
      'INVALID_SESSION',
      requestId,
    );
  }

  return {
    mode: 'user',
    userId: user.id,
    service,
  };
}

// ---------------------------------------------------------------------------
// Conversões e snapshots
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  return {};
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function integerFromMetadata(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = finiteNumber(metadata[key]);

  return value !== null && Number.isInteger(value) ? value : null;
}

function timestampFromMetadata(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function mergeMetadata(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...current,
    ...patch,
  };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

// ---------------------------------------------------------------------------
// Plano de acompanhamento
// ---------------------------------------------------------------------------

function resolveDirection(opportunity: OpportunityRow): 'long' | 'short' {
  const snapshotDirection = opportunity.plan_snapshot?.direction;

  if (
    snapshotDirection === 'long' ||
    snapshotDirection === 'short'
  ) {
    return snapshotDirection;
  }

  return opportunity.direction === 'short' ? 'short' : 'long';
}

function resolveHorizonCandles(
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  override: number | null,
): number {
  if (override !== null) {
    return override;
  }

  const outcomeMetadata = asObject(outcome.metadata);
  const opportunityMetadata = asObject(opportunity.metadata);

  const fromOutcome = integerFromMetadata(
    outcomeMetadata,
    'horizonCandles',
  );

  if (fromOutcome !== null && fromOutcome > 0) {
    return Math.min(fromOutcome, 10_000);
  }

  const fromOpportunity = integerFromMetadata(
    opportunityMetadata,
    'horizonCandles',
  );

  if (fromOpportunity !== null && fromOpportunity > 0) {
    return Math.min(fromOpportunity, 10_000);
  }

  return DEFAULT_HORIZON_CANDLES[opportunity.timeframe] ?? 48;
}

function buildTrackingPlan(
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  horizonOverride: number | null,
): TrackingPlan {
  if (opportunity.opportunity_type !== 'entry') {
    throw new Error(
      'Somente oportunidades de entrada possuem resultado teórico neste motor.',
    );
  }

  const direction = resolveDirection(opportunity);

  const entryPrice =
    positiveNumber(outcome.entry_price) ??
    positiveNumber(opportunity.entry_reference);

  const stopPrice = positiveNumber(opportunity.stop_reference);
  const targetPrice = positiveNumber(opportunity.target_reference);

  const entryAtRaw = outcome.entry_at ?? opportunity.detected_at;
  const entryAt = Date.parse(entryAtRaw);

  if (
    entryPrice === null ||
    stopPrice === null ||
    targetPrice === null
  ) {
    throw new Error(
      'Oportunidade sem entrada, stop ou alvo válido.',
    );
  }

  if (!Number.isFinite(entryAt)) {
    throw new Error('Oportunidade sem horário de entrada válido.');
  }

  if (
    direction === 'long' &&
    !(stopPrice < entryPrice && targetPrice > entryPrice)
  ) {
    throw new Error(
      'Plano long inválido: stop deve ficar abaixo e alvo acima da entrada.',
    );
  }

  if (
    direction === 'short' &&
    !(stopPrice > entryPrice && targetPrice < entryPrice)
  ) {
    throw new Error(
      'Plano short inválido: stop deve ficar acima e alvo abaixo da entrada.',
    );
  }

  const timeframeDuration = TIMEFRAME_DURATION_MS[opportunity.timeframe];

  if (!timeframeDuration) {
    throw new Error(
      `Timeframe não suportado para horizonte: ${opportunity.timeframe}.`,
    );
  }

  const horizonCandles = resolveHorizonCandles(
    opportunity,
    outcome,
    horizonOverride,
  );

  const riskPerUnit =
    direction === 'long'
      ? entryPrice - stopPrice
      : stopPrice - entryPrice;

  if (!(riskPerUnit > 0)) {
    throw new Error('Risco por unidade inválido.');
  }

  return {
    direction,
    entryPrice,
    stopPrice,
    targetPrice,
    riskPerUnit,
    quoteAmount: positiveNumber(opportunity.quote_amount),
    entryAt,
    horizonCandles,
    horizonAt: entryAt + timeframeDuration * horizonCandles,
  };
}

// ---------------------------------------------------------------------------
// Binance
// ---------------------------------------------------------------------------

function parseKline(row: unknown): BinanceKline {
  if (!Array.isArray(row) || row.length < 8) {
    throw new Error(
      'A Binance retornou um candle em formato inesperado.',
    );
  }

  const candle: BinanceKline = {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
  };

  if (
    Object.values(candle).some((value) => !Number.isFinite(value)) ||
    candle.openTime <= 0 ||
    candle.closeTime <= candle.openTime ||
    candle.open <= 0 ||
    candle.high <= 0 ||
    candle.low <= 0 ||
    candle.close <= 0
  ) {
    throw new Error(
      'A Binance retornou valores numéricos inválidos.',
    );
  }

  return candle;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS,
  );

  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchMarketPage(
  symbol: string,
  startTime: number,
  endTime: number,
  limit: number,
  asOf: number,
): Promise<MarketPage> {
  const failures: string[] = [];

  for (const baseUrl of BINANCE_PUBLIC_BASE_URLS) {
    const url = new URL('/api/v3/klines', baseUrl);

    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', BINANCE_INTERVAL);
    url.searchParams.set('startTime', String(Math.floor(startTime)));
    url.searchParams.set('endTime', String(Math.floor(endTime)));
    url.searchParams.set('limit', String(limit));

    try {
      const response = await fetchWithTimeout(url.toString());

      if (!response.ok) {
        const responseBody = (await response.text()).slice(0, 300);

        failures.push(
          `${baseUrl}: HTTP ${response.status} ${responseBody}`,
        );

        if (response.status === 429 || response.status === 418) {
          const retryAfter = Number(
            response.headers.get('retry-after') ?? 1,
          );

          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(
                2_000,
                Math.max(250, retryAfter * 1_000),
              ),
            )
          );
        }

        continue;
      }

      const rows = await response.json();

      if (!Array.isArray(rows)) {
        failures.push(`${baseUrl}: resposta não é uma lista`);
        continue;
      }

      const candles = rows
        .map(parseKline)
        .filter(
          (candle) =>
            candle.closeTime < asOf &&
            candle.openTime >= startTime &&
            candle.closeTime <= endTime,
        )
        .sort((left, right) => left.openTime - right.openTime);

      return {
        candles,
        source: baseUrl,
        requestedStartTime: startTime,
        requestedEndTime: endTime,
      };
    } catch (error) {
      failures.push(
        `${baseUrl}: ${
          error instanceof Error
            ? error.message
            : 'falha desconhecida'
        }`,
      );
    }
  }

  throw new Error(
    `Não foi possível consultar candles da Binance. ${failures.join(' | ')}`,
  );
}

// ---------------------------------------------------------------------------
// Regras de resolução
// ---------------------------------------------------------------------------

function calculateCandleExcursion(
  plan: TrackingPlan,
  candle: BinanceKline,
): ExcursionState {
  if (plan.direction === 'long') {
    return {
      maximumFavorableR:
        (candle.high - plan.entryPrice) / plan.riskPerUnit,
      maximumAdverseR:
        (candle.low - plan.entryPrice) / plan.riskPerUnit,
    };
  }

  return {
    maximumFavorableR:
      (plan.entryPrice - candle.low) / plan.riskPerUnit,
    maximumAdverseR:
      (plan.entryPrice - candle.high) / plan.riskPerUnit,
  };
}

function mergeExcursion(
  current: ExcursionState,
  next: ExcursionState,
): ExcursionState {
  const maximumFavorableR =
    current.maximumFavorableR === null
      ? next.maximumFavorableR
      : next.maximumFavorableR === null
        ? current.maximumFavorableR
        : Math.max(
            current.maximumFavorableR,
            next.maximumFavorableR,
          );

  const maximumAdverseR =
    current.maximumAdverseR === null
      ? next.maximumAdverseR
      : next.maximumAdverseR === null
        ? current.maximumAdverseR
        : Math.min(
            current.maximumAdverseR,
            next.maximumAdverseR,
          );

  return {
    maximumFavorableR,
    maximumAdverseR,
  };
}

function resolveCandle(
  plan: TrackingPlan,
  candle: BinanceKline,
): CandleResolution | null {
  const resolvedAt = iso(candle.closeTime);

  if (plan.direction === 'long') {
    // Gaps na abertura determinam a primeira fronteira conhecida.
    if (candle.open <= plan.stopPrice) {
      return {
        status: 'stop_hit',
        exitPrice: plan.stopPrice,
        exitReason: 'stop_gap_or_open',
        resolvedAt,
        targetHitAt: null,
        stopHitAt: resolvedAt,
        candle,
      };
    }

    if (candle.open >= plan.targetPrice) {
      return {
        status: 'target_hit',
        exitPrice: plan.targetPrice,
        exitReason: 'target_gap_or_open',
        resolvedAt,
        targetHitAt: resolvedAt,
        stopHitAt: null,
        candle,
      };
    }

    const stopHit = candle.low <= plan.stopPrice;
    const targetHit = candle.high >= plan.targetPrice;

    if (stopHit && targetHit) {
      return {
        status: 'ambiguous',
        exitPrice: null,
        exitReason: 'target_and_stop_same_1m_candle',
        resolvedAt,
        targetHitAt: resolvedAt,
        stopHitAt: resolvedAt,
        candle,
      };
    }

    if (stopHit) {
      return {
        status: 'stop_hit',
        exitPrice: plan.stopPrice,
        exitReason: 'stop_hit',
        resolvedAt,
        targetHitAt: null,
        stopHitAt: resolvedAt,
        candle,
      };
    }

    if (targetHit) {
      return {
        status: 'target_hit',
        exitPrice: plan.targetPrice,
        exitReason: 'target_hit',
        resolvedAt,
        targetHitAt: resolvedAt,
        stopHitAt: null,
        candle,
      };
    }

    return null;
  }

  if (candle.open >= plan.stopPrice) {
    return {
      status: 'stop_hit',
      exitPrice: plan.stopPrice,
      exitReason: 'stop_gap_or_open',
      resolvedAt,
      targetHitAt: null,
      stopHitAt: resolvedAt,
      candle,
    };
  }

  if (candle.open <= plan.targetPrice) {
    return {
      status: 'target_hit',
      exitPrice: plan.targetPrice,
      exitReason: 'target_gap_or_open',
      resolvedAt,
      targetHitAt: resolvedAt,
      stopHitAt: null,
      candle,
    };
  }

  const stopHit = candle.high >= plan.stopPrice;
  const targetHit = candle.low <= plan.targetPrice;

  if (stopHit && targetHit) {
    return {
      status: 'ambiguous',
      exitPrice: null,
      exitReason: 'target_and_stop_same_1m_candle',
      resolvedAt,
      targetHitAt: resolvedAt,
      stopHitAt: resolvedAt,
      candle,
    };
  }

  if (stopHit) {
    return {
      status: 'stop_hit',
      exitPrice: plan.stopPrice,
      exitReason: 'stop_hit',
      resolvedAt,
      targetHitAt: null,
      stopHitAt: resolvedAt,
      candle,
    };
  }

  if (targetHit) {
    return {
      status: 'target_hit',
      exitPrice: plan.targetPrice,
      exitReason: 'target_hit',
      resolvedAt,
      targetHitAt: resolvedAt,
      stopHitAt: null,
      candle,
    };
  }

  return null;
}

function calculatePnl(
  plan: TrackingPlan,
  exitPrice: number,
): {
  grossPnlPct: number;
  grossPnlUsdt: number | null;
  resultR: number;
} {
  const multiplier = plan.direction === 'long' ? 1 : -1;
  const directionalDifference =
    (exitPrice - plan.entryPrice) * multiplier;

  const grossPnlPct =
    (directionalDifference / plan.entryPrice) * 100;

  const resultR = directionalDifference / plan.riskPerUnit;

  const grossPnlUsdt =
    plan.quoteAmount === null
      ? null
      : plan.quoteAmount * (grossPnlPct / 100);

  return {
    grossPnlPct,
    grossPnlUsdt,
    resultR,
  };
}

function previousExcursion(outcome: OutcomeRow): ExcursionState {
  return {
    maximumFavorableR: finiteNumber(
      outcome.maximum_favorable_excursion_r,
    ),
    maximumAdverseR: finiteNumber(
      outcome.maximum_adverse_excursion_r,
    ),
  };
}

function createTerminalComputation(
  plan: TrackingPlan,
  resolution: CandleResolution,
  processedCandles: number,
  lastCandle: BinanceKline,
  marketSource: string,
  excursion: ExcursionState,
): TrackingComputation {
  if (
    resolution.status === 'ambiguous' ||
    resolution.exitPrice === null
  ) {
    return {
      disposition: 'ambiguous',
      status: 'ambiguous',
      processedCandles,
      lastProcessedAt: iso(lastCandle.closeTime),
      lastProcessedOpenTime: lastCandle.openTime,
      lastProcessedCloseTime: lastCandle.closeTime,
      lastProcessedClosePrice: lastCandle.close,
      marketSource,
      horizonAt: iso(plan.horizonAt),
      excursion,

      exitPrice: null,
      exitAt: resolution.resolvedAt,
      exitReason: resolution.exitReason,
      targetHitAt: resolution.targetHitAt,
      stopHitAt: resolution.stopHitAt,
      grossPnlPct: null,
      netPnlPct: null,
      grossPnlUsdt: null,
      netPnlUsdt: null,
      resultR: null,
      resolvedAt: resolution.resolvedAt,
      message:
        'Alvo e stop ocorreram no mesmo candle de 1 minuto; a ordem não pode ser determinada com segurança.',
    };
  }

  const pnl = calculatePnl(plan, resolution.exitPrice);

  return {
    disposition:
      resolution.status === 'target_hit'
        ? 'target_hit'
        : 'stop_hit',
    status: resolution.status,
    processedCandles,
    lastProcessedAt: iso(lastCandle.closeTime),
    lastProcessedOpenTime: lastCandle.openTime,
    lastProcessedCloseTime: lastCandle.closeTime,
    lastProcessedClosePrice: lastCandle.close,
    marketSource,
    horizonAt: iso(plan.horizonAt),
    excursion,

    exitPrice: resolution.exitPrice,
    exitAt: resolution.resolvedAt,
    exitReason: resolution.exitReason,
    targetHitAt: resolution.targetHitAt,
    stopHitAt: resolution.stopHitAt,
    grossPnlPct: pnl.grossPnlPct,
    netPnlPct: pnl.grossPnlPct,
    grossPnlUsdt: pnl.grossPnlUsdt,
    netPnlUsdt: pnl.grossPnlUsdt,
    resultR: pnl.resultR,
    resolvedAt: resolution.resolvedAt,
  };
}

function createHorizonComputation(
  plan: TrackingPlan,
  processedCandles: number,
  lastCandle: BinanceKline,
  marketSource: string,
  excursion: ExcursionState,
): TrackingComputation {
  const pnl = calculatePnl(plan, lastCandle.close);
  const exitAt = iso(Math.min(lastCandle.closeTime, plan.horizonAt));

  return {
    disposition: 'horizon_exit',
    status: 'manual_exit',
    processedCandles,
    lastProcessedAt: iso(lastCandle.closeTime),
    lastProcessedOpenTime: lastCandle.openTime,
    lastProcessedCloseTime: lastCandle.closeTime,
    lastProcessedClosePrice: lastCandle.close,
    marketSource,
    horizonAt: iso(plan.horizonAt),
    excursion,

    exitPrice: lastCandle.close,
    exitAt,
    exitReason: 'horizon_reached',
    targetHitAt: null,
    stopHitAt: null,
    grossPnlPct: pnl.grossPnlPct,
    netPnlPct: pnl.grossPnlPct,
    grossPnlUsdt: pnl.grossPnlUsdt,
    netPnlUsdt: pnl.grossPnlUsdt,
    resultR: pnl.resultR,
    resolvedAt: exitAt,
    message:
      'O cenário atingiu o horizonte máximo e foi encerrado pelo último fechamento disponível.',
  };
}

function createNoDataComputation(
  plan: TrackingPlan,
  currentExcursion: ExcursionState,
  message: string,
): TrackingComputation {
  return {
    disposition: 'no_new_data',
    status: 'tracking',
    processedCandles: 0,
    lastProcessedAt: null,
    lastProcessedOpenTime: null,
    lastProcessedCloseTime: null,
    lastProcessedClosePrice: null,
    marketSource: null,
    horizonAt: iso(plan.horizonAt),
    excursion: currentExcursion,

    exitPrice: null,
    exitAt: null,
    exitReason: null,
    targetHitAt: null,
    stopHitAt: null,
    grossPnlPct: null,
    netPnlPct: null,
    grossPnlUsdt: null,
    netPnlUsdt: null,
    resultR: null,
    resolvedAt: null,
    message,
  };
}

async function computeTracking(
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  parsed: ParsedRequest,
  asOf: number,
): Promise<TrackingComputation> {
  const plan = buildTrackingPlan(
    opportunity,
    outcome,
    parsed.horizonCandlesOverride,
  );

  const metadata = asObject(outcome.metadata);
  const currentExcursion = previousExcursion(outcome);

  const lastProcessedCloseTime = timestampFromMetadata(
    metadata,
    'lastProcessedCloseTime',
  );

  const startTime =
    lastProcessedCloseTime !== null
      ? lastProcessedCloseTime + 1
      : plan.entryAt + 1;

  // Somente candles encerrados podem alterar o resultado.
  const latestClosedCutoff = asOf - 1;
  const endTime = Math.min(plan.horizonAt, latestClosedCutoff);

  if (endTime < startTime) {
    const previousClosePrice = positiveNumber(
      metadata.lastProcessedClosePrice,
    );

    if (
      asOf >= plan.horizonAt &&
      previousClosePrice !== null &&
      lastProcessedCloseTime !== null
    ) {
      const syntheticLastCandle: BinanceKline = {
        openTime: Math.max(
          plan.entryAt,
          lastProcessedCloseTime - ONE_MINUTE_MS + 1,
        ),
        closeTime: lastProcessedCloseTime,
        open: previousClosePrice,
        high: previousClosePrice,
        low: previousClosePrice,
        close: previousClosePrice,
        volume: 0,
        quoteVolume: 0,
      };

      return createHorizonComputation(
        plan,
        0,
        syntheticLastCandle,
        typeof metadata.marketSource === 'string'
          ? metadata.marketSource
          : 'cached',
        currentExcursion,
      );
    }

    return createNoDataComputation(
      plan,
      currentExcursion,
      'Ainda não existe um novo candle encerrado para processar.',
    );
  }

  const page = await fetchMarketPage(
    opportunity.symbol,
    startTime,
    endTime,
    parsed.maxCandlesPerOutcome,
    asOf,
  );

  if (page.candles.length === 0) {
    return createNoDataComputation(
      plan,
      currentExcursion,
      'A Binance não retornou novos candles encerrados para este intervalo.',
    );
  }

  let excursion = currentExcursion;
  let resolution: CandleResolution | null = null;
  let processedCandles = 0;
  let lastCandle = page.candles[0];

  for (const candle of page.candles) {
    if (candle.closeTime <= plan.entryAt) {
      continue;
    }

    processedCandles += 1;
    lastCandle = candle;

    excursion = mergeExcursion(
      excursion,
      calculateCandleExcursion(plan, candle),
    );

    resolution = resolveCandle(plan, candle);

    if (resolution) {
      break;
    }
  }

  if (processedCandles === 0 || !lastCandle) {
    return createNoDataComputation(
      plan,
      currentExcursion,
      'Os candles recebidos são anteriores à entrada teórica.',
    );
  }

  if (resolution) {
    return createTerminalComputation(
      plan,
      resolution,
      processedCandles,
      lastCandle,
      page.source,
      excursion,
    );
  }

  const reachedHorizon =
    lastCandle.closeTime >= plan.horizonAt ||
    (
      asOf >= plan.horizonAt &&
      page.candles.length < parsed.maxCandlesPerOutcome &&
      page.requestedEndTime === plan.horizonAt
    );

  if (reachedHorizon) {
    return createHorizonComputation(
      plan,
      processedCandles,
      lastCandle,
      page.source,
      excursion,
    );
  }

  return {
    disposition: 'tracking_updated',
    status: 'tracking',
    processedCandles,
    lastProcessedAt: iso(lastCandle.closeTime),
    lastProcessedOpenTime: lastCandle.openTime,
    lastProcessedCloseTime: lastCandle.closeTime,
    lastProcessedClosePrice: lastCandle.close,
    marketSource: page.source,
    horizonAt: iso(plan.horizonAt),
    excursion,

    exitPrice: null,
    exitAt: null,
    exitReason: null,
    targetHitAt: null,
    stopHitAt: null,
    grossPnlPct: null,
    netPnlPct: null,
    grossPnlUsdt: null,
    netPnlUsdt: null,
    resultR: null,
    resolvedAt: null,
    message:
      page.candles.length >= parsed.maxCandlesPerOutcome
        ? 'O limite de candles desta execução foi atingido; o acompanhamento continuará na próxima rodada.'
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------

async function loadTrackingOutcomes(
  auth: AuthenticationContext,
  parsed: ParsedRequest,
): Promise<OutcomeRow[]> {
  let query = auth.service
    .from('opportunity_outcomes')
    .select(OUTCOME_SELECT)
    .eq('mode', 'theoretical')
    .eq('status', 'tracking')
    .order('updated_at', { ascending: true })
    .limit(parsed.limit);

  if (parsed.opportunityId) {
    query = query.eq('opportunity_id', parsed.opportunityId);
  }

  const effectiveUserId =
    auth.mode === 'user'
      ? auth.userId
      : parsed.requestedUserId;

  if (effectiveUserId) {
    query = query.eq('user_id', effectiveUserId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(
      `Falha ao consultar resultados teóricos: ${error.message}`,
    );
  }

  return (data ?? []) as OutcomeRow[];
}

async function loadOpportunities(
  service: SupabaseClient,
  outcomeRows: readonly OutcomeRow[],
): Promise<Map<string, OpportunityRow>> {
  const ids = [
    ...new Set(outcomeRows.map((row) => row.opportunity_id)),
  ];

  const result = new Map<string, OpportunityRow>();

  if (ids.length === 0) {
    return result;
  }

  const { data, error } = await service
    .from('trade_opportunities')
    .select(OPPORTUNITY_SELECT)
    .in('id', ids);

  if (error) {
    throw new Error(
      `Falha ao consultar oportunidades: ${error.message}`,
    );
  }

  for (const row of (data ?? []) as OpportunityRow[]) {
    result.set(row.id, row);
  }

  return result;
}

function buildOutcomeUpdate(
  outcome: OutcomeRow,
  computation: TrackingComputation,
  requestId: string,
): Record<string, unknown> {
  const previousMetadata = asObject(outcome.metadata);

  const previousProcessedCount =
    integerFromMetadata(previousMetadata, 'processedCandleCount') ?? 0;

  const trackingMetadata = mergeMetadata(previousMetadata, {
    trackingEngine: 'binance_closed_1m_v1',
    horizonAt: computation.horizonAt,
    resolutionGranularity: '1m',
    lastTrackingRequestId: requestId,
    lastTrackedAt: new Date().toISOString(),
    processedCandleCount:
      previousProcessedCount + computation.processedCandles,
    lastProcessedOpenTime:
      computation.lastProcessedOpenTime ??
      previousMetadata.lastProcessedOpenTime ??
      null,
    lastProcessedCloseTime:
      computation.lastProcessedCloseTime ??
      previousMetadata.lastProcessedCloseTime ??
      null,
    lastProcessedClosePrice:
      computation.lastProcessedClosePrice ??
      previousMetadata.lastProcessedClosePrice ??
      null,
    marketSource:
      computation.marketSource ??
      previousMetadata.marketSource ??
      null,
  });

  if (computation.status !== 'tracking') {
    trackingMetadata.resolution = {
      status: computation.status,
      exitReason: computation.exitReason,
      resolvedAt: computation.resolvedAt,
      granularity: '1m',
    };
  }

  const update: Record<string, unknown> = {
    maximum_favorable_excursion_r:
      computation.excursion.maximumFavorableR,
    maximum_adverse_excursion_r:
      computation.excursion.maximumAdverseR,
    metadata: trackingMetadata,
  };

  if (computation.status !== 'tracking') {
    update.status = computation.status;
    update.exit_price = computation.exitPrice;
    update.exit_at = computation.exitAt;
    update.exit_reason = computation.exitReason;
    update.gross_pnl_pct = computation.grossPnlPct;
    update.net_pnl_pct = computation.netPnlPct;
    update.gross_pnl_usdt = computation.grossPnlUsdt;
    update.net_pnl_usdt = computation.netPnlUsdt;
    update.result_r = computation.resultR;
    update.target_hit_at = computation.targetHitAt;
    update.stop_hit_at = computation.stopHitAt;
    update.resolved_at = computation.resolvedAt;
  }

  return update;
}

function terminalEventType(status: ResolutionStatus): string {
  if (status === 'target_hit') {
    return 'target_hit';
  }

  if (status === 'stop_hit') {
    return 'stop_hit';
  }

  if (status === 'error') {
    return 'error';
  }

  return 'outcome_resolved';
}

async function persistComputation(
  service: SupabaseClient,
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  computation: TrackingComputation,
  requestId: string,
  dryRun: boolean,
): Promise<'updated' | 'dry_run' | 'conflict'> {
  if (dryRun) {
    return 'dry_run';
  }

  if (computation.disposition === 'no_new_data') {
    return 'updated';
  }

  const update = buildOutcomeUpdate(
    outcome,
    computation,
    requestId,
  );

  const { data, error } = await service
    .from('opportunity_outcomes')
    .update(update)
    .eq('id', outcome.id)
    .eq('status', 'tracking')
    .eq('updated_at', outcome.updated_at)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(
      `Falha ao atualizar resultado ${outcome.id}: ${error.message}`,
    );
  }

  if (!data) {
    return 'conflict';
  }

  if (computation.status !== 'tracking') {
    const { error: eventError } = await service.rpc(
      'log_opportunity_event',
      {
        p_opportunity_id: opportunity.id,
        p_user_id: opportunity.user_id,
        p_event_type: terminalEventType(computation.status),
        p_actor_type: 'edge_function',
        p_event_data: {
          outcomeId: outcome.id,
          mode: 'theoretical',
          status: computation.status,
          exitPrice: computation.exitPrice,
          exitReason: computation.exitReason,
          resultR: computation.resultR,
          resolvedAt: computation.resolvedAt,
          mfeR: computation.excursion.maximumFavorableR,
          maeR: computation.excursion.maximumAdverseR,
          requestId,
        },
      },
    );

    if (eventError) {
      console.error(
        `[${requestId}] Resultado salvo, mas evento não pôde ser registrado:`,
        eventError,
      );
    }
  }

  return 'updated';
}

async function persistOutcomeError(
  service: SupabaseClient,
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  message: string,
  requestId: string,
  dryRun: boolean,
): Promise<'updated' | 'dry_run' | 'conflict'> {
  if (dryRun) {
    return 'dry_run';
  }

  const metadata = mergeMetadata(asObject(outcome.metadata), {
    trackingEngine: 'binance_closed_1m_v1',
    lastTrackingRequestId: requestId,
    lastTrackedAt: new Date().toISOString(),
    trackingError: message,
  });

  const resolvedAt = new Date().toISOString();

  const { data, error } = await service
    .from('opportunity_outcomes')
    .update({
      status: 'error',
      exit_reason: 'tracking_error',
      resolved_at: resolvedAt,
      metadata,
    })
    .eq('id', outcome.id)
    .eq('status', 'tracking')
    .eq('updated_at', outcome.updated_at)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(
      `Falha ao registrar erro do resultado ${outcome.id}: ${error.message}`,
    );
  }

  if (!data) {
    return 'conflict';
  }

  const { error: eventError } = await service.rpc(
    'log_opportunity_event',
    {
      p_opportunity_id: opportunity.id,
      p_user_id: opportunity.user_id,
      p_event_type: 'error',
      p_actor_type: 'edge_function',
      p_event_data: {
        outcomeId: outcome.id,
        mode: 'theoretical',
        stage: 'tracking',
        message,
        requestId,
      },
    },
  );

  if (eventError) {
    console.error(
      `[${requestId}] Erro salvo, mas evento não pôde ser registrado:`,
      eventError,
    );
  }

  return 'updated';
}

// ---------------------------------------------------------------------------
// Processamento individual
// ---------------------------------------------------------------------------

function itemFromComputation(
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  computation: TrackingComputation,
  dispositionOverride?: TrackingDisposition,
): TrackingItem {
  return {
    outcome_id: outcome.id,
    opportunity_id: opportunity.id,
    symbol: opportunity.symbol,
    timeframe: opportunity.timeframe,
    strategy: opportunity.strategy,
    strategy_version: opportunity.strategy_version,
    disposition:
      dispositionOverride ?? computation.disposition,
    status: computation.status,
    processed_candles: computation.processedCandles,
    last_processed_at: computation.lastProcessedAt,
    horizon_at: computation.horizonAt,
    mfe_r: computation.excursion.maximumFavorableR,
    mae_r: computation.excursion.maximumAdverseR,
    exit_price: computation.exitPrice,
    result_r: computation.resultR,
    message: computation.message,
  };
}

async function processOutcome(
  auth: AuthenticationContext,
  parsed: ParsedRequest,
  opportunity: OpportunityRow,
  outcome: OutcomeRow,
  asOf: number,
  requestId: string,
): Promise<TrackingItem> {
  try {
    const computation = await computeTracking(
      opportunity,
      outcome,
      parsed,
      asOf,
    );

    const persistence = await persistComputation(
      auth.service,
      opportunity,
      outcome,
      computation,
      requestId,
      parsed.dryRun,
    );

    if (persistence === 'conflict') {
      return itemFromComputation(
        opportunity,
        outcome,
        computation,
        'conflict',
      );
    }

    if (persistence === 'dry_run') {
      return itemFromComputation(
        opportunity,
        outcome,
        computation,
        'dry_run',
      );
    }

    return itemFromComputation(
      opportunity,
      outcome,
      computation,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Erro desconhecido.';

    console.error(
      `[${requestId}] Falha no resultado ${outcome.id}:`,
      error,
    );

    const persistence = await persistOutcomeError(
      auth.service,
      opportunity,
      outcome,
      message,
      requestId,
      parsed.dryRun,
    );

    return {
      outcome_id: outcome.id,
      opportunity_id: opportunity.id,
      symbol: opportunity.symbol,
      timeframe: opportunity.timeframe,
      strategy: opportunity.strategy,
      strategy_version: opportunity.strategy_version,
      disposition:
        persistence === 'conflict'
          ? 'conflict'
          : parsed.dryRun
            ? 'dry_run'
            : 'error',
      status: 'error',
      processed_candles: 0,
      last_processed_at: null,
      horizon_at: null,
      mfe_r: finiteNumber(
        outcome.maximum_favorable_excursion_r,
      ),
      mae_r: finiteNumber(
        outcome.maximum_adverse_excursion_r,
      ),
      exit_price: null,
      result_r: null,
      message,
    };
  }
}

async function mapInBatches<T, R>(
  values: readonly T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];

  for (let index = 0; index < values.length; index += batchSize) {
    const batch = values.slice(index, index + batchSize);
    result.push(...(await Promise.all(batch.map(mapper))));
  }

  return result;
}

function countDisposition(
  items: readonly TrackingItem[],
  disposition: TrackingDisposition,
): number {
  return items.filter(
    (item) => item.disposition === disposition,
  ).length;
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

  const authentication = await authenticate(req, requestId);

  if (authentication instanceof Response) {
    return authentication;
  }

  const startedAt = Date.now();

  try {
    const body = await readJsonBody(req);
    const parsed = parseRequest(body, authentication.mode);

    const asOf = parsed.asOf
      ? Date.parse(parsed.asOf)
      : Date.now();

    const outcomes = await loadTrackingOutcomes(
      authentication,
      parsed,
    );

    if (parsed.opportunityId && outcomes.length === 0) {
      return errorResponse(
        404,
        'Resultado teórico em acompanhamento não encontrado.',
        'TRACKING_OUTCOME_NOT_FOUND',
        requestId,
      );
    }

    const opportunities = await loadOpportunities(
      authentication.service,
      outcomes,
    );

    const orphaned: TrackingItem[] = [];
    const processable: Array<{
      opportunity: OpportunityRow;
      outcome: OutcomeRow;
    }> = [];

    for (const outcome of outcomes) {
      const opportunity = opportunities.get(
        outcome.opportunity_id,
      );

      if (!opportunity) {
        orphaned.push({
          outcome_id: outcome.id,
          opportunity_id: outcome.opportunity_id,
          symbol: 'UNKNOWN',
          timeframe: 'UNKNOWN',
          strategy: 'unknown',
          strategy_version: '0.0.0',
          disposition: 'skipped',
          status: 'error',
          processed_candles: 0,
          last_processed_at: null,
          horizon_at: null,
          mfe_r: finiteNumber(
            outcome.maximum_favorable_excursion_r,
          ),
          mae_r: finiteNumber(
            outcome.maximum_adverse_excursion_r,
          ),
          exit_price: null,
          result_r: null,
          message:
            'A oportunidade vinculada ao resultado não foi encontrada.',
        });
        continue;
      }

      // Defesa adicional, mesmo com filtro anterior por user_id.
      const effectiveUserId =
        authentication.mode === 'user'
          ? authentication.userId
          : parsed.requestedUserId;

      if (
        effectiveUserId &&
        opportunity.user_id !== effectiveUserId
      ) {
        orphaned.push({
          outcome_id: outcome.id,
          opportunity_id: opportunity.id,
          symbol: opportunity.symbol,
          timeframe: opportunity.timeframe,
          strategy: opportunity.strategy,
          strategy_version: opportunity.strategy_version,
          disposition: 'skipped',
          status: 'error',
          processed_candles: 0,
          last_processed_at: null,
          horizon_at: null,
          mfe_r: finiteNumber(
            outcome.maximum_favorable_excursion_r,
          ),
          mae_r: finiteNumber(
            outcome.maximum_adverse_excursion_r,
          ),
          exit_price: null,
          result_r: null,
          message: 'O resultado não pertence ao usuário autorizado.',
        });
        continue;
      }

      processable.push({
        opportunity,
        outcome,
      });
    }

    const processed = await mapInBatches(
      processable,
      TRACKING_CONCURRENCY,
      ({ opportunity, outcome }) =>
        processOutcome(
          authentication,
          parsed,
          opportunity,
          outcome,
          asOf,
          requestId,
        ),
    );

    const items = [...processed, ...orphaned];

    const summary = {
      scanned: outcomes.length,
      processed: processed.length,
      tracking_updated: countDisposition(
        items,
        'tracking_updated',
      ),
      target_hit: countDisposition(items, 'target_hit'),
      stop_hit: countDisposition(items, 'stop_hit'),
      horizon_exit: countDisposition(items, 'horizon_exit'),
      ambiguous: countDisposition(items, 'ambiguous'),
      no_new_data: countDisposition(items, 'no_new_data'),
      dry_run: countDisposition(items, 'dry_run'),
      conflicts: countDisposition(items, 'conflict'),
      errors: countDisposition(items, 'error'),
      skipped: countDisposition(items, 'skipped'),
      candles_processed: items.reduce(
        (total, item) => total + item.processed_candles,
        0,
      ),
    };

    const partial =
      summary.errors > 0 ||
      summary.conflicts > 0 ||
      summary.skipped > 0;

    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify({
        event: 'acompanhar_resultados_teoricos',
        request_id: requestId,
        mode: authentication.mode,
        user_id:
          authentication.mode === 'user'
            ? authentication.userId
            : parsed.requestedUserId,
        ...summary,
        duration_ms: durationMs,
      }),
    );

    return jsonResponse(
      {
        ok: !partial,
        partial,
        request_id: requestId,
        mode: authentication.mode,
        dry_run: parsed.dryRun,
        as_of: new Date(asOf).toISOString(),
        filters: {
          opportunity_id: parsed.opportunityId,
          user_id:
            authentication.mode === 'user'
              ? authentication.userId
              : parsed.requestedUserId,
          limit: parsed.limit,
          max_candles_per_outcome:
            parsed.maxCandlesPerOutcome,
          horizon_candles_override:
            parsed.horizonCandlesOverride,
        },
        summary,
        items,
        generated_at: new Date().toISOString(),
        duration_ms: durationMs,
      },
      requestId,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Erro desconhecido.';

    console.error(
      `[${requestId}] acompanhar-resultados-teoricos:`,
      error,
    );

    const inputFragments = [
      'opportunity_id',
      'user_id',
      'limit',
      'max_candles_per_outcome',
      'horizon_candles',
      'dry_run',
      'as_of',
      'Campo não suportado',
      'JSON',
      'Corpo da requisição',
    ];

    const isInputError = inputFragments.some((fragment) =>
      message.includes(fragment)
    );

    const isDatabaseError =
      message.startsWith('Falha ao consultar');

    return errorResponse(
      isInputError ? 400 : 500,
      isInputError
        ? message
        : 'Não foi possível acompanhar os resultados teóricos.',
      isInputError
        ? 'INVALID_INPUT'
        : isDatabaseError
          ? 'DATABASE_ERROR'
          : 'TRACKING_ERROR',
      requestId,
      isInputError ? undefined : { message },
    );
  }
});