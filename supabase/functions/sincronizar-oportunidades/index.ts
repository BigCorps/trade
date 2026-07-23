// ============================================================================
// VigIA Trade — Edge Function: sincronizar-oportunidades
// supabase/functions/sincronizar-oportunidades/index.ts
// ============================================================================
//
// Transforma setups de Day Trade com `condicoes_atendidas` em registros
// idempotentes da Central de Oportunidades.
//
// Segurança:
// - publique esta função com verify_jwt = true;
// - no modo usuário, o JWT determina quais setups podem ser consultados;
// - no modo interno, exige simultaneamente service_role e CRON_SECRET;
// - nenhuma ordem é criada ou executada;
// - a criação usa a RPC create_opportunity_from_daytrade_setup, que concentra
//   validações, snapshots, resultado teórico inicial e auditoria.
//
// Uso normal após avaliar-daytrade:
//   POST { "setup_id": "<uuid>" }
//
// Uso agendado:
//   POST { "limit": 200, "include_expired": false }
//   x-cron-secret: <CRON_SECRET>
// ============================================================================

import {
  createClient,
  type SupabaseClient,
} from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface SynchronizeRequestBody {
  setup_id?: unknown;
  user_id?: unknown;
  limit?: unknown;
  include_expired?: unknown;
  dry_run?: unknown;
  max_age_minutes?: unknown;
  before?: unknown;
}

interface DayTradeSetupRow {
  id: string;
  user_id: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  strategy_version: string;
  status: string;
  score: number;
  total_conditions: number;
  entry_reference: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  risk_reward_ratio: number | string | null;
  candle_open_time: string;
  candle_close_time: string;
  criado_em: string;
  atualizado_em: string;
  strategy_options: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
}

interface ExistingOpportunityRow {
  id: string;
  source_id: string;
  lifecycle_status: string;
  entry_decision: string;
  expires_at: string | null;
}

type SynchronizationDisposition =
  | 'created'
  | 'existing'
  | 'dry_run'
  | 'skipped_expired'
  | 'skipped_invalid_plan'
  | 'error';

interface SynchronizationItem {
  setup_id: string;
  opportunity_id: string | null;
  symbol: string;
  timeframe: string;
  strategy: string;
  strategy_version: string;
  expires_at: string | null;
  disposition: SynchronizationDisposition;
  lifecycle_status?: string;
  message?: string;
}

interface ErrorPayload {
  error: string;
  code?: string;
  details?: unknown;
  request_id: string;
}

interface ParsedRequest {
  setupId: string | null;
  requestedUserId: string | null;
  limit: number;
  includeExpired: boolean;
  dryRun: boolean;
  maxAgeMinutes: number;
  before: string | null;
}

interface AuthenticationContext {
  mode: 'user' | 'internal';
  userId: string | null;
  supabase: SupabaseClient;
}

interface CandidateDecision {
  eligible: boolean;
  expiresAt: string | null;
  disposition?: 'skipped_expired' | 'skipped_invalid_plan';
  message?: string;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 16_384;
const DEFAULT_USER_LIMIT = 50;
const DEFAULT_INTERNAL_LIMIT = 200;
const MAX_USER_LIMIT = 100;
const MAX_INTERNAL_LIMIT = 500;
const DEFAULT_MAX_AGE_MINUTES = 24 * 60;
const MAX_MAX_AGE_MINUTES = 30 * 24 * 60;
const RPC_CONCURRENCY = 8;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TIMEFRAME_DURATION_MS: Readonly<Record<string, number>> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
};

const SETUP_SELECT = [
  'id',
  'user_id',
  'symbol',
  'timeframe',
  'strategy',
  'strategy_version',
  'status',
  'score',
  'total_conditions',
  'entry_reference',
  'stop_reference',
  'target_reference',
  'risk_reward_ratio',
  'candle_open_time',
  'candle_close_time',
  'criado_em',
  'atualizado_em',
  'strategy_options',
  'plan',
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
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders,
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
// Validação de entrada
// ---------------------------------------------------------------------------

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

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    throw new Error(`${name} deve ser uma data ISO 8601 válida.`);
  }

  return new Date(timestamp).toISOString();
}

async function readJsonBody(req: Request): Promise<SynchronizeRequestBody> {
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

    return parsed as SynchronizeRequestBody;
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

function assertAllowedBodyKeys(body: SynchronizeRequestBody): void {
  const allowed = new Set([
    'setup_id',
    'user_id',
    'limit',
    'include_expired',
    'dry_run',
    'max_age_minutes',
    'before',
  ]);

  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new Error(`Campo não suportado: ${key}.`);
    }
  }
}

function parseRequest(
  body: SynchronizeRequestBody,
  mode: AuthenticationContext['mode'],
): ParsedRequest {
  assertAllowedBodyKeys(body);

  const maximumLimit =
    mode === 'internal' ? MAX_INTERNAL_LIMIT : MAX_USER_LIMIT;

  const defaultLimit =
    mode === 'internal' ? DEFAULT_INTERNAL_LIMIT : DEFAULT_USER_LIMIT;

  const setupId = parseUuid(body.setup_id, 'setup_id');
  const requestedUserId = parseUuid(body.user_id, 'user_id');

  if (mode !== 'internal' && requestedUserId !== null) {
    throw new Error('user_id só pode ser usado no modo interno.');
  }

  return {
    setupId,
    requestedUserId,
    limit: parseInteger(
      body.limit,
      'limit',
      setupId ? 1 : defaultLimit,
      1,
      maximumLimit,
    ),
    includeExpired: parseBoolean(
      body.include_expired,
      'include_expired',
      setupId !== null,
    ),
    dryRun: parseBoolean(body.dry_run, 'dry_run', false),
    maxAgeMinutes: parseInteger(
      body.max_age_minutes,
      'max_age_minutes',
      DEFAULT_MAX_AGE_MINUTES,
      1,
      MAX_MAX_AGE_MINUTES,
    ),
    before: parseOptionalIsoDate(body.before, 'before'),
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
      `[${requestId}] SUPABASE_URL, SUPABASE_ANON_KEY ou SUPABASE_SERVICE_ROLE_KEY ausente.`,
    );

    return errorResponse(
      500,
      'Configuração interna indisponível.',
      'SERVER_CONFIG_ERROR',
      requestId,
    );
  }

  /*
   * O cron é autenticado exclusivamente pelo CRON_SECRET.
   *
   * A service_role não precisa ser enviada no Authorization.
   * Ela permanece somente dentro da Edge Function.
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
      supabase: createClient(
        supabaseUrl,
        serviceRoleKey,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        },
      ),
    };
  }

  /*
   * Sem x-cron-secret, a chamada precisa possuir uma sessão comum
   * de usuário.
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

  const supabase = createClient(supabaseUrl, anonKey, {
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
  } = await supabase.auth.getUser(token);

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
    supabase,
  };
}

// ---------------------------------------------------------------------------
// Regras de elegibilidade
// ---------------------------------------------------------------------------

function positiveNumber(
  value: number | string | null,
): number | null {
  if (value === null || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function calculateExpiration(setup: DayTradeSetupRow): string | null {
  const closeTime = Date.parse(setup.candle_close_time);
  const duration = TIMEFRAME_DURATION_MS[setup.timeframe];

  if (!Number.isFinite(closeTime) || !duration) {
    return null;
  }

  return new Date(closeTime + duration).toISOString();
}

function validatePlan(setup: DayTradeSetupRow): string | null {
  const entry = positiveNumber(setup.entry_reference);
  const stop = positiveNumber(setup.stop_reference);
  const target = positiveNumber(setup.target_reference);
  const riskReward = positiveNumber(setup.risk_reward_ratio);

  if (
    entry === null ||
    stop === null ||
    target === null ||
    riskReward === null
  ) {
    return 'O setup não possui entrada, stop, alvo e risco/retorno completos.';
  }

  const direction =
    typeof setup.plan?.direction === 'string'
      ? setup.plan.direction
      : 'long';

  if (direction === 'short') {
    if (!(stop > entry && target < entry)) {
      return 'O plano short possui relação inválida entre entrada, stop e alvo.';
    }

    return null;
  }

  if (!(stop < entry && target > entry)) {
    return 'O plano long possui relação inválida entre entrada, stop e alvo.';
  }

  return null;
}

function evaluateCandidate(
  setup: DayTradeSetupRow,
  includeExpired: boolean,
  now: number,
): CandidateDecision {
  const invalidPlan = validatePlan(setup);

  if (invalidPlan) {
    return {
      eligible: false,
      expiresAt: calculateExpiration(setup),
      disposition: 'skipped_invalid_plan',
      message: invalidPlan,
    };
  }

  const expiresAt = calculateExpiration(setup);

  if (!expiresAt) {
    return {
      eligible: false,
      expiresAt: null,
      disposition: 'skipped_invalid_plan',
      message: `Timeframe ou candle_close_time inválido: ${setup.timeframe}.`,
    };
  }

  if (!includeExpired && Date.parse(expiresAt) <= now) {
    return {
      eligible: false,
      expiresAt,
      disposition: 'skipped_expired',
      message: 'A oportunidade já estava expirada quando foi sincronizada.',
    };
  }

  return {
    eligible: true,
    expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

async function loadCandidateSetups(
  auth: AuthenticationContext,
  parsed: ParsedRequest,
  now: number,
): Promise<DayTradeSetupRow[]> {
  let query = auth.supabase
    .from('daytrade_setups')
    .select(SETUP_SELECT)
    .eq('status', 'condicoes_atendidas')
    .order('candle_close_time', { ascending: false })
    .limit(parsed.limit);

  if (parsed.setupId) {
    query = query.eq('id', parsed.setupId);
  } else {
    const minimumCloseTime = new Date(
      now - parsed.maxAgeMinutes * 60_000,
    ).toISOString();

    query = query.gte('candle_close_time', minimumCloseTime);
  }

  if (parsed.before) {
    query = query.lt('candle_close_time', parsed.before);
  }

  if (auth.mode === 'internal' && parsed.requestedUserId) {
    query = query.eq('user_id', parsed.requestedUserId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Falha ao consultar daytrade_setups: ${error.message}`);
  }

  return (data ?? []) as DayTradeSetupRow[];
}

async function loadExistingOpportunities(
  supabase: SupabaseClient,
  sourceIds: readonly string[],
): Promise<Map<string, ExistingOpportunityRow>> {
  const bySourceId = new Map<string, ExistingOpportunityRow>();

  if (sourceIds.length === 0) {
    return bySourceId;
  }

  const { data, error } = await supabase
    .from('trade_opportunities')
    .select(
      'id,source_id,lifecycle_status,entry_decision,expires_at',
    )
    .eq('source_type', 'daytrade_setup')
    .eq('opportunity_type', 'entry')
    .in('source_id', [...sourceIds]);

  if (error) {
    throw new Error(
      `Falha ao consultar oportunidades existentes: ${error.message}`,
    );
  }

  for (const row of (data ?? []) as ExistingOpportunityRow[]) {
    bySourceId.set(row.source_id, row);
  }

  return bySourceId;
}

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------

function baseItem(
  setup: DayTradeSetupRow,
  expiresAt: string | null,
): Omit<
  SynchronizationItem,
  'opportunity_id' | 'disposition'
> {
  return {
    setup_id: setup.id,
    symbol: setup.symbol,
    timeframe: setup.timeframe,
    strategy: setup.strategy,
    strategy_version: setup.strategy_version,
    expires_at: expiresAt,
  };
}

async function createOpportunity(
  supabase: SupabaseClient,
  setup: DayTradeSetupRow,
  expiresAt: string,
): Promise<SynchronizationItem> {
  const { data, error } = await supabase.rpc(
    'create_opportunity_from_daytrade_setup',
    {
      p_setup_id: setup.id,
      p_expires_at: expiresAt,
    },
  );

  if (error) {
    return {
      ...baseItem(setup, expiresAt),
      opportunity_id: null,
      disposition: 'error',
      message: error.message,
    };
  }

  if (typeof data !== 'string' || !UUID_PATTERN.test(data)) {
    return {
      ...baseItem(setup, expiresAt),
      opportunity_id: null,
      disposition: 'error',
      message: 'A RPC retornou um identificador de oportunidade inválido.',
    };
  }

  return {
    ...baseItem(setup, expiresAt),
    opportunity_id: data,
    disposition: 'created',
  };
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
  items: readonly SynchronizationItem[],
  disposition: SynchronizationDisposition,
): number {
  return items.filter((item) => item.disposition === disposition).length;
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
    const now = Date.now();

    const setups = await loadCandidateSetups(
      authentication,
      parsed,
      now,
    );

    if (parsed.setupId && setups.length === 0) {
      return errorResponse(
        404,
        'Setup elegível não encontrado.',
        'SETUP_NOT_FOUND_OR_NOT_ELIGIBLE',
        requestId,
      );
    }

    const existingBySourceId = await loadExistingOpportunities(
      authentication.supabase,
      setups.map((setup) => setup.id),
    );

    const results: SynchronizationItem[] = [];
    const toCreate: Array<{
      setup: DayTradeSetupRow;
      expiresAt: string;
    }> = [];

    for (const setup of setups) {
      const expiration = calculateExpiration(setup);
      const existing = existingBySourceId.get(setup.id);

      if (existing) {
        results.push({
          ...baseItem(setup, existing.expires_at ?? expiration),
          opportunity_id: existing.id,
          disposition: 'existing',
          lifecycle_status: existing.lifecycle_status,
        });
        continue;
      }

      const decision = evaluateCandidate(
        setup,
        parsed.includeExpired,
        now,
      );

      if (
        !decision.eligible ||
        !decision.expiresAt ||
        decision.disposition
      ) {
        results.push({
          ...baseItem(setup, decision.expiresAt),
          opportunity_id: null,
          disposition:
            decision.disposition ?? 'skipped_invalid_plan',
          message:
            decision.message ??
            'O setup não pôde ser convertido em oportunidade.',
        });
        continue;
      }

      if (parsed.dryRun) {
        results.push({
          ...baseItem(setup, decision.expiresAt),
          opportunity_id: null,
          disposition: 'dry_run',
          message: 'Oportunidade elegível; nenhuma gravação foi realizada.',
        });
        continue;
      }

      toCreate.push({
        setup,
        expiresAt: decision.expiresAt,
      });
    }

    if (!parsed.dryRun && toCreate.length > 0) {
      const createdItems = await mapInBatches(
        toCreate,
        RPC_CONCURRENCY,
        ({ setup, expiresAt }) =>
          createOpportunity(
            authentication.supabase,
            setup,
            expiresAt,
          ),
      );

      results.push(...createdItems);
    }

    const orderByCloseTime = new Map(
      setups.map((setup, index) => [setup.id, index]),
    );

    results.sort(
      (left, right) =>
        (orderByCloseTime.get(left.setup_id) ?? Number.MAX_SAFE_INTEGER) -
        (orderByCloseTime.get(right.setup_id) ?? Number.MAX_SAFE_INTEGER),
    );

    const created = countDisposition(results, 'created');
    const existing = countDisposition(results, 'existing');
    const errors = countDisposition(results, 'error');
    const dryRunEligible = countDisposition(results, 'dry_run');
    const skippedExpired = countDisposition(
      results,
      'skipped_expired',
    );
    const skippedInvalidPlan = countDisposition(
      results,
      'skipped_invalid_plan',
    );

    const nextBefore =
      setups.length === parsed.limit
        ? setups.at(-1)?.candle_close_time ?? null
        : null;

    const partial = errors > 0;
    const durationMs = Date.now() - startedAt;

    console.log(
      JSON.stringify({
        event: 'sincronizar_oportunidades',
        request_id: requestId,
        mode: authentication.mode,
        user_id:
          authentication.mode === 'user'
            ? authentication.userId
            : parsed.requestedUserId,
        scanned: setups.length,
        created,
        existing,
        errors,
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
        filters: {
          setup_id: parsed.setupId,
          user_id:
            authentication.mode === 'internal'
              ? parsed.requestedUserId
              : authentication.userId,
          include_expired: parsed.includeExpired,
          max_age_minutes: parsed.maxAgeMinutes,
          before: parsed.before,
          limit: parsed.limit,
        },
        summary: {
          scanned: setups.length,
          eligible:
            created + existing + dryRunEligible,
          created,
          existing,
          dry_run_eligible: dryRunEligible,
          skipped_expired: skippedExpired,
          skipped_invalid_plan: skippedInvalidPlan,
          errors,
        },
        items: results,
        pagination: {
          next_before: nextBefore,
          has_more: nextBefore !== null,
        },
        generated_at: new Date().toISOString(),
        duration_ms: durationMs,
      },
      requestId,
      200,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Erro desconhecido.';

    console.error(`[${requestId}] sincronizar-oportunidades:`, error);

    const isInputError = [
      'setup_id',
      'user_id',
      'limit',
      'include_expired',
      'dry_run',
      'max_age_minutes',
      'before',
      'Campo não suportado',
      'JSON',
      'Corpo da requisição',
    ].some((fragment) => message.includes(fragment));

    const isDatabaseError =
      message.startsWith('Falha ao consultar');

    return errorResponse(
      isInputError ? 400 : 500,
      isInputError
        ? message
        : 'Não foi possível sincronizar as oportunidades.',
      isInputError
        ? 'INVALID_INPUT'
        : isDatabaseError
          ? 'DATABASE_ERROR'
          : 'SYNCHRONIZATION_ERROR',
      requestId,
      isInputError ? undefined : { message },
    );
  }
});