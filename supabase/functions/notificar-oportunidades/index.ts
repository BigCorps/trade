// ============================================================================
// VigIA Trade — Edge Function: notificar-oportunidades
// supabase/functions/notificar-oportunidades/index.ts
// ============================================================================
//
// Envia emails transacionais da Central de Oportunidades a partir da linha do
// tempo auditável em opportunity_events.
//
// Eventos notificados nesta versão:
// - opportunity_created: nova oportunidade acionável;
// - entry_filled: entrada executada;
// - protection_failed / protection_lost: posição sem proteção confirmada;
// - exit_requested / exit_pending: saída aguardando decisão;
// - target_hit / stop_hit / position_closed: encerramento executado.
//
// Segurança e confiabilidade:
// - publique com verify_jwt = false, pois a chamada normal vem do cron;
// - toda chamada exige x-cron-secret igual a CRON_SECRET;
// - usa SERVICE_ROLE somente no servidor;
// - respeita user_settings.email_notif, com padrão true quando a configuração
//   ainda não existe;
// - não coloca email, token ou qualquer dado de autenticação no deep link;
// - usa Idempotency-Key estável no Resend e registra notification_sent,
//   notification_failed ou notification_skipped na própria linha do tempo;
// - nunca executa, altera ou cancela ordens.
// ============================================================================

import {
  createClient,
  type SupabaseClient,
} from 'jsr:@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

type OpportunityEventType =
  | 'opportunity_created'
  | 'entry_filled'
  | 'protection_failed'
  | 'protection_lost'
  | 'exit_requested'
  | 'exit_pending'
  | 'target_hit'
  | 'stop_hit'
  | 'position_closed';

type NotificationAuditType =
  | 'notification_sent'
  | 'notification_failed'
  | 'notification_skipped';

type NotificationCategory =
  | 'new_opportunity'
  | 'entry_executed'
  | 'unprotected_position'
  | 'exit_pending'
  | 'position_closed';

type NotificationPriority = 'normal' | 'high' | 'critical';

type ProcessingDisposition =
  | 'sent'
  | 'skipped'
  | 'failed'
  | 'already_processed'
  | 'dry_run';

interface RequestBody {
  event_id?: unknown;
  opportunity_id?: unknown;
  limit?: unknown;
  max_age_hours?: unknown;
  dry_run?: unknown;
}

interface ParsedRequest {
  eventId: string | null;
  opportunityId: string | null;
  limit: number;
  maxAgeHours: number;
  dryRun: boolean;
}

interface OpportunityEventRow {
  id: string;
  opportunity_id: string;
  user_id: string;
  event_type: string;
  actor_type: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}

interface TradeOpportunityRow {
  id: string;
  user_id: string;
  opportunity_type: string;
  symbol: string;
  timeframe: string;
  direction: string;
  lifecycle_status: string;
  entry_decision: string;
  exit_decision: string;
  execution_environment: string;
  detected_at: string;
  expires_at: string | null;
  accepted_at: string | null;
  opened_at: string | null;
  exit_requested_at: string | null;
  closed_at: string | null;
  entry_reference: number | string | null;
  maximum_entry_price: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  gross_risk_reward: number | string | null;
  estimated_net_risk_reward: number | string | null;
  quote_amount: number | string | null;
  score: number | string | null;
  total_conditions: number | string | null;
  strategy: string;
  strategy_version: string;
  severity: string;
  warnings: unknown;
  metadata: Record<string, unknown> | null;
  plan_snapshot: Record<string, unknown> | null;
  updated_at: string;
}

interface UserNotificationState {
  userId: string;
  email: string | null;
  enabled: boolean;
}

interface PriorNotificationState {
  sent: Set<string>;
  skipped: Set<string>;
  failureCount: Map<string, number>;
}

interface EmailContent {
  category: NotificationCategory;
  priority: NotificationPriority;
  subject: string;
  preheader: string;
  title: string;
  lead: string;
  statusLabel: string;
  statusTone: 'neutral' | 'positive' | 'warning' | 'critical';
  details: Array<{ label: string; value: string }>;
  actionLabel: string;
  actionUrl: string;
  footnote: string;
  text: string;
  html: string;
}

interface ResendSuccess {
  ok: true;
  messageId: string | null;
  responseStatus: number;
}

interface ResendFailure {
  ok: false;
  error: string;
  code: string | null;
  retryable: boolean;
  responseStatus: number | null;
}

type ResendResult = ResendSuccess | ResendFailure;

interface ProcessingResult {
  event_id: string;
  opportunity_id: string;
  event_type: string;
  disposition: ProcessingDisposition;
  category?: NotificationCategory;
  recipient?: string;
  subject?: string;
  provider_message_id?: string | null;
  message?: string;
}

interface RunSummary {
  request_id: string;
  selected: number;
  sent: number;
  skipped: number;
  failed: number;
  already_processed: number;
  dry_run: number;
  results: ProcessingResult[];
}

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  headers?: Record<string, string>;
}

class RequestError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ELIGIBLE_EVENT_TYPES: readonly OpportunityEventType[] = [
  'opportunity_created',
  'entry_filled',
  'protection_failed',
  'protection_lost',
  'exit_requested',
  'exit_pending',
  'target_hit',
  'stop_hit',
  'position_closed',
] as const;

const AUDIT_EVENT_TYPES: readonly NotificationAuditType[] = [
  'notification_sent',
  'notification_failed',
  'notification_skipped',
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DEFAULT_MAX_AGE_HOURS = 72;
const MAX_MAX_AGE_HOURS = 30 * 24;
const MAX_BODY_BYTES = 16_384;
const MAX_FAILURE_ATTEMPTS = 5;
const SEND_CONCURRENCY = 5;
const AUTH_CONCURRENCY = 8;
const RESEND_TIMEOUT_MS = 12_000;
const CONTENT_VERSION = 'opportunity-email-v1';
const DEFAULT_APP_ORIGIN = 'https://vigiatrade.com';
const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-cron-secret, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const OPPORTUNITY_SELECT = [
  'id',
  'user_id',
  'opportunity_type',
  'symbol',
  'timeframe',
  'direction',
  'lifecycle_status',
  'entry_decision',
  'exit_decision',
  'execution_environment',
  'detected_at',
  'expires_at',
  'accepted_at',
  'opened_at',
  'exit_requested_at',
  'closed_at',
  'entry_reference',
  'maximum_entry_price',
  'stop_reference',
  'target_reference',
  'gross_risk_reward',
  'estimated_net_risk_reward',
  'quote_amount',
  'score',
  'total_conditions',
  'strategy',
  'strategy_version',
  'severity',
  'warnings',
  'metadata',
  'plan_snapshot',
  'updated_at',
].join(',');

// ---------------------------------------------------------------------------
// Respostas e validação básica
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
  requestId: string,
  error: unknown,
): Response {
  if (error instanceof RequestError) {
    return jsonResponse(
      {
        error: error.message,
        code: error.code,
        details: error.details,
        request_id: requestId,
      },
      requestId,
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse(
    {
      error: 'Falha interna ao processar notificações.',
      code: 'INTERNAL_ERROR',
      details: truncate(message, 500),
      request_id: requestId,
    },
    requestId,
    500,
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

function truncate(value: unknown, maximum = 500): string {
  return String(value ?? '').slice(0, maximum);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

function parseOptionalUuid(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null || value === '') return null;

  if (!isUuid(value)) {
    throw new RequestError(
      400,
      'INVALID_UUID',
      `${fieldName} deve ser um UUID válido.`,
    );
  }

  return value.trim().toLowerCase();
}

function parseInteger(
  value: unknown,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RequestError(
      400,
      'INVALID_NUMBER',
      `${fieldName} deve ser um inteiro entre ${minimum} e ${maximum}.`,
    );
  }

  return parsed;
}

function parseBoolean(value: unknown, fieldName: string, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }

  throw new RequestError(
    400,
    'INVALID_BOOLEAN',
    `${fieldName} deve ser true ou false.`,
  );
}

async function readRequestBody(request: Request): Promise<RequestBody> {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RequestError(413, 'BODY_TOO_LARGE', 'Corpo da requisição muito grande.');
  }

  const raw = await request.text();
  if (!raw.trim()) return {};
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    throw new RequestError(413, 'BODY_TOO_LARGE', 'Corpo da requisição muito grande.');
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('objeto JSON esperado');
    }
    return parsed as RequestBody;
  } catch (error) {
    throw new RequestError(
      400,
      'INVALID_JSON',
      'O corpo deve conter um objeto JSON válido.',
      truncate(error instanceof Error ? error.message : error, 200),
    );
  }
}

function parseRequest(body: RequestBody): ParsedRequest {
  return {
    eventId: parseOptionalUuid(body.event_id, 'event_id'),
    opportunityId: parseOptionalUuid(body.opportunity_id, 'opportunity_id'),
    limit: parseInteger(body.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT),
    maxAgeHours: parseInteger(
      body.max_age_hours,
      'max_age_hours',
      DEFAULT_MAX_AGE_HOURS,
      1,
      MAX_MAX_AGE_HOURS,
    ),
    dryRun: parseBoolean(body.dry_run, 'dry_run', false),
  };
}

// ---------------------------------------------------------------------------
// Ambiente, URLs e formatação
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new RequestError(
      500,
      'MISSING_CONFIGURATION',
      `${name} não está configurado.`,
    );
  }
  return value;
}

function resolveAppOrigin(): string {
  const candidates = [
    Deno.env.get('APP_ORIGIN'),
    Deno.env.get('SITE_URL'),
    Deno.env.get('NEXT_PUBLIC_SITE_URL'),
    DEFAULT_APP_ORIGIN,
  ];

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;

    try {
      const url = new URL(candidate.trim());
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (url.username || url.password) continue;
      if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) continue;
      return url.origin;
    } catch {
      // Tenta o próximo candidato.
    }
  }

  return DEFAULT_APP_ORIGIN;
}

function opportunityUrl(origin: string, opportunityId: string): string {
  const url = new URL('/oportunidades', origin);
  url.searchParams.set('focus', opportunityId);
  return url.toString();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const timeZone = Deno.env.get('EMAIL_TIME_ZONE')?.trim() || DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleString('pt-BR');
  }
}

function formatPrice(value: unknown, maximumFractionDigits = 8): string {
  const parsed = positive(value);
  if (parsed === null) return '—';

  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(parsed);
}

function formatNumber(value: unknown, digits = 2): string {
  const parsed = finite(value);
  if (parsed === null) return '—';
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(parsed);
}

function formatSignedUsdt(value: unknown): string {
  const parsed = finite(value);
  if (parsed === null) return '—';
  const sign = parsed > 0 ? '+' : '';
  return `${sign}${formatNumber(parsed, 2)} USDT`;
}

function formatResultR(value: unknown): string {
  const parsed = finite(value);
  if (parsed === null) return '—';
  const sign = parsed > 0 ? '+' : '';
  return `${sign}${formatNumber(parsed, 2)}R`;
}

function formatEnvironment(value: string): string {
  if (value === 'real') return 'Conta real';
  if (value === 'testnet') return 'Binance Testnet';
  return 'Acompanhamento teórico';
}

function formatDirection(value: string): string {
  return value === 'short' ? 'Venda / short' : 'Compra / long';
}

function maskEmail(email: string | null): string {
  if (!email) return 'email indisponível';
  const [local, domain] = email.split('@');
  if (!domain) return 'email inválido';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function firstNumber(
  eventData: Record<string, unknown>,
  keys: readonly string[],
  fallback: unknown,
): number | null {
  for (const key of keys) {
    const parsed = finite(eventData[key]);
    if (parsed !== null) return parsed;
  }
  return finite(fallback);
}

function warningCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function scoreLabel(opportunity: TradeOpportunityRow): string {
  const score = finite(opportunity.score);
  const total = finite(opportunity.total_conditions);
  if (score === null || total === null || total <= 0) return '—';
  return `${Math.round(score)}/${Math.round(total)}`;
}

// ---------------------------------------------------------------------------
// Classificação dos eventos
// ---------------------------------------------------------------------------

function isEligibleEventType(value: string): value is OpportunityEventType {
  return (ELIGIBLE_EVENT_TYPES as readonly string[]).includes(value);
}

function isExecutedClosingEvent(
  event: OpportunityEventRow,
  eventData: Record<string, unknown>,
): boolean {
  if (!['target_hit', 'stop_hit', 'position_closed'].includes(event.event_type)) {
    return true;
  }

  const mode = String(eventData.mode ?? '').toLowerCase();
  if (mode === 'theoretical') return false;

  return (
    typeof eventData.orderId === 'string' ||
    typeof eventData.order_id === 'string' ||
    mode === 'executed' ||
    event.event_type === 'position_closed'
  );
}

function notificationCategory(eventType: OpportunityEventType): NotificationCategory {
  if (eventType === 'opportunity_created') return 'new_opportunity';
  if (eventType === 'entry_filled') return 'entry_executed';
  if (eventType === 'protection_failed' || eventType === 'protection_lost') {
    return 'unprotected_position';
  }
  if (eventType === 'exit_requested' || eventType === 'exit_pending') {
    return 'exit_pending';
  }
  return 'position_closed';
}

function notificationPriority(eventType: OpportunityEventType): NotificationPriority {
  if (eventType === 'protection_failed' || eventType === 'protection_lost') {
    return 'critical';
  }
  if (eventType === 'exit_requested' || eventType === 'exit_pending') {
    return 'high';
  }
  return 'normal';
}

function shouldNotifyCurrentOpportunity(
  eventType: OpportunityEventType,
  opportunity: TradeOpportunityRow,
): { notify: boolean; reason?: string } {
  if (eventType === 'opportunity_created') {
    if (opportunity.opportunity_type !== 'entry') {
      return { notify: false, reason: 'not_entry_opportunity' };
    }

    if (['expired', 'invalidated', 'rejected', 'closed', 'error'].includes(opportunity.lifecycle_status)) {
      return { notify: false, reason: `lifecycle_${opportunity.lifecycle_status}` };
    }

    if (opportunity.expires_at) {
      const expiresAt = new Date(opportunity.expires_at).getTime();
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return { notify: false, reason: 'already_expired' };
      }
    }
  }

  return { notify: true };
}

// ---------------------------------------------------------------------------
// Conteúdo do email
// ---------------------------------------------------------------------------

function toneColors(tone: EmailContent['statusTone']): {
  foreground: string;
  background: string;
  border: string;
} {
  if (tone === 'positive') {
    return { foreground: '#166534', background: '#dcfce7', border: '#86efac' };
  }
  if (tone === 'warning') {
    return { foreground: '#92400e', background: '#fef3c7', border: '#fcd34d' };
  }
  if (tone === 'critical') {
    return { foreground: '#991b1b', background: '#fee2e2', border: '#fca5a5' };
  }
  return { foreground: '#334155', background: '#e2e8f0', border: '#cbd5e1' };
}

function buildTextEmail(options: {
  title: string;
  lead: string;
  statusLabel: string;
  details: Array<{ label: string; value: string }>;
  actionLabel: string;
  actionUrl: string;
  footnote: string;
}): string {
  const detailLines = options.details.map((item) => `${item.label}: ${item.value}`);
  return [
    options.title,
    '',
    options.lead,
    '',
    `Status: ${options.statusLabel}`,
    ...detailLines,
    '',
    `${options.actionLabel}: ${options.actionUrl}`,
    '',
    options.footnote,
    '',
    'VigIA Trade',
  ].join('\n');
}

function buildHtmlEmail(options: {
  preheader: string;
  title: string;
  lead: string;
  statusLabel: string;
  statusTone: EmailContent['statusTone'];
  details: Array<{ label: string; value: string }>;
  actionLabel: string;
  actionUrl: string;
  footnote: string;
  priority: NotificationPriority;
}): string {
  const tone = toneColors(options.statusTone);
  const detailRows = options.details
    .map((item) => `
      <tr>
        <td style="padding:9px 12px;color:#64748b;font-size:13px;border-bottom:1px solid #e2e8f0;width:42%;">
          ${escapeHtml(item.label)}
        </td>
        <td style="padding:9px 12px;color:#0f172a;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0;text-align:right;">
          ${escapeHtml(item.value)}
        </td>
      </tr>`)
    .join('');

  const urgentBlock = options.priority === 'critical'
    ? `
      <div style="margin:20px 0 0;padding:14px 16px;border-radius:10px;background:#fff1f2;border:1px solid #fda4af;color:#9f1239;font-size:13px;line-height:1.55;">
        <strong>Ação necessária:</strong> confira imediatamente a posição e as ordens diretamente na Binance. Não presuma que existe stop ou alvo ativo.
      </div>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(options.preheader)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 8px 28px rgba(15,23,42,.08);">
            <tr>
              <td style="padding:20px 24px;background:#101418;border-bottom:3px solid #e8a13c;">
                <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.2px;">VigIA Trade</div>
                <div style="color:#94a3b8;font-size:12px;margin-top:4px;">Central de Oportunidades</div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 24px 24px;">
                <div style="display:inline-block;padding:5px 10px;border-radius:999px;background:${tone.background};border:1px solid ${tone.border};color:${tone.foreground};font-size:12px;font-weight:700;margin-bottom:16px;">
                  ${escapeHtml(options.statusLabel)}
                </div>
                <h1 style="margin:0 0 12px;font-size:24px;line-height:1.25;color:#0f172a;">${escapeHtml(options.title)}</h1>
                <p style="margin:0;color:#475569;font-size:15px;line-height:1.65;">${escapeHtml(options.lead)}</p>
                ${urgentBlock}
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:22px;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;overflow:hidden;">
                  ${detailRows}
                </table>
                <div style="text-align:center;margin:26px 0 8px;">
                  <a href="${escapeHtml(options.actionUrl)}" style="display:inline-block;background:#e8a13c;color:#101418;text-decoration:none;font-size:14px;font-weight:700;padding:12px 20px;border-radius:9px;">
                    ${escapeHtml(options.actionLabel)}
                  </a>
                </div>
                <p style="margin:20px 0 0;color:#64748b;font-size:12px;line-height:1.55;">${escapeHtml(options.footnote)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;line-height:1.5;text-align:center;">
                Este email foi gerado automaticamente a partir de um evento auditável da sua conta VigIA.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildEmailContent(
  event: OpportunityEventRow,
  opportunity: TradeOpportunityRow,
  appOrigin: string,
): EmailContent {
  if (!isEligibleEventType(event.event_type)) {
    throw new Error(`Evento não suportado: ${event.event_type}`);
  }

  const eventData = asRecord(event.event_data);
  const category = notificationCategory(event.event_type);
  const priority = notificationPriority(event.event_type);
  const actionUrl = opportunityUrl(appOrigin, opportunity.id);
  const entryPrice = firstNumber(
    eventData,
    ['averagePrice', 'entryPrice', 'entry_price'],
    opportunity.entry_reference,
  );
  const exitPrice = firstNumber(
    eventData,
    ['exitPrice', 'exit_price'],
    null,
  );
  const stopPrice = firstNumber(
    eventData,
    ['stopPrice', 'stopTrigger', 'stop_price'],
    opportunity.stop_reference,
  );
  const targetPrice = firstNumber(
    eventData,
    ['targetPrice', 'target_price'],
    opportunity.target_reference,
  );
  const quantity = firstNumber(eventData, ['quantity', 'qty'], null);
  const netPnlUsdt = firstNumber(
    eventData,
    ['netPnlUsdt', 'pnlUsdt', 'pnl_usdt'],
    null,
  );
  const resultR = firstNumber(eventData, ['resultR', 'result_r'], null);
  const feesUsdt = firstNumber(eventData, ['feesUsdt', 'fees_usdt'], null);
  const environment = formatEnvironment(opportunity.execution_environment);
  const baseDetails: Array<{ label: string; value: string }> = [
    { label: 'Ativo', value: opportunity.symbol },
    { label: 'Timeframe', value: opportunity.timeframe },
    { label: 'Direção', value: formatDirection(opportunity.direction) },
    { label: 'Ambiente', value: environment },
  ];

  let subject: string;
  let preheader: string;
  let title: string;
  let lead: string;
  let statusLabel: string;
  let statusTone: EmailContent['statusTone'];
  let details: Array<{ label: string; value: string }>;
  let actionLabel = 'Abrir na Central';
  let footnote =
    'O VigIA organiza cenários e dados de execução, mas não garante resultados. Revise o plano e acompanhe a Binance antes de tomar qualquer decisão.';

  if (event.event_type === 'opportunity_created') {
    subject = `Nova oportunidade ${opportunity.symbol} · ${opportunity.timeframe}`;
    preheader = `Setup identificado para ${opportunity.symbol} com entrada, stop e alvo definidos.`;
    title = 'Nova oportunidade identificada';
    lead =
      `Um setup de ${opportunity.symbol} passou pelos critérios configurados e foi adicionado à Central para sua revisão.`;
    statusLabel = 'AGUARDANDO REVISÃO';
    statusTone = 'warning';
    details = [
      ...baseDetails,
      { label: 'Entrada de referência', value: `${formatPrice(opportunity.entry_reference)} USDT` },
      { label: 'Entrada máxima', value: `${formatPrice(opportunity.maximum_entry_price)} USDT` },
      { label: 'Stop', value: `${formatPrice(opportunity.stop_reference)} USDT` },
      { label: 'Alvo', value: `${formatPrice(opportunity.target_reference)} USDT` },
      { label: 'Risco/retorno', value: `${formatNumber(opportunity.gross_risk_reward, 2)}R` },
      { label: 'Condições atendidas', value: scoreLabel(opportunity) },
      { label: 'Expira em', value: formatDate(opportunity.expires_at) },
    ];
    actionLabel = 'Revisar oportunidade';
  } else if (event.event_type === 'entry_filled') {
    subject = `Entrada executada · ${opportunity.symbol} · ${environment}`;
    preheader = `A entrada de ${opportunity.symbol} foi executada e a proteção está sendo confirmada.`;
    title = 'Entrada executada';
    lead =
      `A Binance confirmou execução da entrada. O fluxo ainda deve confirmar a proteção por OCO antes de considerar a posição protegida.`;
    statusLabel = 'ENTRADA EXECUTADA';
    statusTone = 'positive';
    details = [
      ...baseDetails,
      { label: 'Preço médio', value: `${formatPrice(entryPrice)} USDT` },
      { label: 'Quantidade', value: formatPrice(quantity) },
      { label: 'Valor utilizado', value: `${formatNumber(eventData.quoteSpent ?? opportunity.quote_amount, 2)} USDT` },
      { label: 'Taxas identificadas', value: feesUsdt === null ? '—' : `${formatNumber(feesUsdt, 4)} USDT` },
      { label: 'Stop planejado', value: `${formatPrice(stopPrice)} USDT` },
      { label: 'Alvo planejado', value: `${formatPrice(targetPrice)} USDT` },
      { label: 'Executada em', value: formatDate(event.created_at) },
    ];
    actionLabel = 'Acompanhar posição';
    footnote =
      'Uma entrada executada ainda pode estar sem proteção durante a criação da OCO. Confira o card e a Binance até o status indicar proteção ativa.';
  } else if (
    event.event_type === 'protection_failed' ||
    event.event_type === 'protection_lost'
  ) {
    subject = `AÇÃO URGENTE: posição sem proteção · ${opportunity.symbol}`;
    preheader = `A posição de ${opportunity.symbol} pode estar sem stop e alvo ativos.`;
    title = 'Posição sem proteção confirmada';
    lead =
      'A entrada foi identificada, mas o sistema não conseguiu confirmar uma proteção ativa. Esta situação exige conferência manual imediata.';
    statusLabel = 'ATENÇÃO IMEDIATA';
    statusTone = 'critical';
    details = [
      ...baseDetails,
      { label: 'Preço de entrada', value: `${formatPrice(entryPrice)} USDT` },
      { label: 'Quantidade', value: formatPrice(quantity) },
      { label: 'Stop planejado', value: `${formatPrice(stopPrice)} USDT` },
      { label: 'Alvo planejado', value: `${formatPrice(targetPrice)} USDT` },
      {
        label: 'Motivo registrado',
        value: truncate(eventData.reason ?? eventData.message ?? 'Proteção não confirmada', 180),
      },
      { label: 'Detectado em', value: formatDate(event.created_at) },
    ];
    actionLabel = 'Ver detalhes agora';
    footnote =
      'Confira diretamente na Binance se há posição aberta e se existem ordens de stop e alvo. Não crie uma nova entrada para tentar corrigir esta situação.';
  } else if (
    event.event_type === 'exit_requested' ||
    event.event_type === 'exit_pending'
  ) {
    subject = `Saída pendente de confirmação · ${opportunity.symbol}`;
    preheader = `Existe uma saída pendente para a posição de ${opportunity.symbol}.`;
    title = 'Saída pendente';
    lead =
      'O cenário registrou uma condição de saída que precisa ser revisada. Nenhuma saída discricionária é executada automaticamente por este email.';
    statusLabel = 'REVISÃO NECESSÁRIA';
    statusTone = 'warning';
    details = [
      ...baseDetails,
      { label: 'Preço de entrada', value: `${formatPrice(entryPrice)} USDT` },
      { label: 'Preço observado', value: `${formatPrice(eventData.marketPrice ?? eventData.currentPrice)} USDT` },
      {
        label: 'Motivo',
        value: truncate(eventData.reason ?? eventData.trigger ?? 'Condição de saída identificada', 180),
      },
      { label: 'Solicitada em', value: formatDate(opportunity.exit_requested_at ?? event.created_at) },
    ];
    actionLabel = 'Revisar saída';
  } else {
    const target = event.event_type === 'target_hit';
    const stop = event.event_type === 'stop_hit';
    subject = target
      ? `Alvo atingido · ${opportunity.symbol}`
      : stop
        ? `Stop atingido · ${opportunity.symbol}`
        : `Posição encerrada · ${opportunity.symbol}`;
    preheader = target
      ? `A posição de ${opportunity.symbol} foi encerrada pelo alvo.`
      : stop
        ? `A posição de ${opportunity.symbol} foi encerrada pelo stop.`
        : `A posição de ${opportunity.symbol} foi encerrada.`;
    title = target
      ? 'Alvo executado'
      : stop
        ? 'Stop executado'
        : 'Posição encerrada';
    lead = target
      ? 'O monitor confirmou o encerramento executado no alvo e registrou o resultado na Central.'
      : stop
        ? 'O monitor confirmou o encerramento executado no stop e registrou o resultado na Central.'
        : 'O monitor confirmou o encerramento da posição e atualizou o histórico executado.';
    statusLabel = target ? 'RESULTADO POSITIVO' : stop ? 'RISCO REALIZADO' : 'ENCERRADA';
    statusTone = target ? 'positive' : stop ? 'critical' : 'neutral';
    details = [
      ...baseDetails,
      { label: 'Preço de entrada', value: `${formatPrice(entryPrice)} USDT` },
      { label: 'Preço de saída', value: `${formatPrice(exitPrice)} USDT` },
      { label: 'Quantidade', value: formatPrice(quantity) },
      { label: 'Resultado líquido', value: formatSignedUsdt(netPnlUsdt) },
      { label: 'Resultado em R', value: formatResultR(resultR) },
      { label: 'Taxas', value: feesUsdt === null ? '—' : `${formatNumber(feesUsdt, 4)} USDT` },
      { label: 'Encerrada em', value: formatDate(eventData.closedAt as string ?? opportunity.closed_at ?? event.created_at) },
    ];
    actionLabel = 'Abrir histórico completo';
  }

  if (warningCount(opportunity.warnings) > 0 && category === 'new_opportunity') {
    details.push({
      label: 'Avisos do plano',
      value: `${warningCount(opportunity.warnings)} aviso(s) para revisar`,
    });
  }

  const text = buildTextEmail({
    title,
    lead,
    statusLabel,
    details,
    actionLabel,
    actionUrl,
    footnote,
  });

  const html = buildHtmlEmail({
    preheader,
    title,
    lead,
    statusLabel,
    statusTone,
    details,
    actionLabel,
    actionUrl,
    footnote,
    priority,
  });

  return {
    category,
    priority,
    subject: safeHeaderValue(subject),
    preheader,
    title,
    lead,
    statusLabel,
    statusTone,
    details,
    actionLabel,
    actionUrl,
    footnote,
    text,
    html,
  };
}

// ---------------------------------------------------------------------------
// Consultas ao Supabase
// ---------------------------------------------------------------------------

function createServiceClient(): SupabaseClient {
  const supabaseUrl = requiredEnv('SUPABASE_URL');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function loadCandidateEvents(
  service: SupabaseClient,
  parsed: ParsedRequest,
): Promise<OpportunityEventRow[]> {
  let query = service
    .from('opportunity_events')
    .select('id,opportunity_id,user_id,event_type,actor_type,event_data,created_at')
    .in('event_type', [...ELIGIBLE_EVENT_TYPES])
    .order('created_at', { ascending: false })
    .limit(Math.min(1_000, parsed.limit * 5));

  if (parsed.eventId) {
    query = query.eq('id', parsed.eventId);
  } else {
    const minimumDate = new Date(
      Date.now() - parsed.maxAgeHours * 60 * 60 * 1_000,
    ).toISOString();
    query = query.gte('created_at', minimumDate);
  }

  if (parsed.opportunityId) {
    query = query.eq('opportunity_id', parsed.opportunityId);
  }

  const { data, error } = await query;
  if (error) {
    throw new RequestError(
      500,
      'EVENT_QUERY_FAILED',
      `Não foi possível consultar os eventos: ${error.message}`,
    );
  }

  const rows: OpportunityEventRow[] = Array.isArray(data)
    ? data.map((row) => ({
      id: String(row.id),
      opportunity_id: String(row.opportunity_id),
      user_id: String(row.user_id),
      event_type: String(row.event_type),
      actor_type: String(row.actor_type),
      event_data: asRecord(row.event_data),
      created_at: String(row.created_at),
    }))
    : [];

  return rows.sort(
    (left, right) =>
      new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );
}

async function loadOpportunities(
  service: SupabaseClient,
  events: OpportunityEventRow[],
): Promise<Map<string, TradeOpportunityRow>> {
  const ids = [...new Set(events.map((event) => event.opportunity_id))];
  if (ids.length === 0) return new Map();

  const { data, error } = await service
    .from('trade_opportunities')
    .select(OPPORTUNITY_SELECT)
    .in('id', ids);

  if (error) {
    throw new RequestError(
      500,
      'OPPORTUNITY_QUERY_FAILED',
      `Não foi possível consultar as oportunidades: ${error.message}`,
    );
  }

  const map = new Map<string, TradeOpportunityRow>();
  for (const value of Array.isArray(data) ? data : []) {
    const row = value as TradeOpportunityRow;
    map.set(row.id, row);
  }
  return map;
}

async function loadPriorNotificationState(
  service: SupabaseClient,
  events: OpportunityEventRow[],
): Promise<PriorNotificationState> {
  const empty: PriorNotificationState = {
    sent: new Set(),
    skipped: new Set(),
    failureCount: new Map(),
  };

  if (events.length === 0) return empty;

  const opportunityIds = [...new Set(events.map((event) => event.opportunity_id))];
  const oldest = events.reduce((minimum, event) => {
    const time = new Date(event.created_at).getTime();
    return Number.isFinite(time) ? Math.min(minimum, time) : minimum;
  }, Date.now());
  const minimumDate = new Date(oldest - 60 * 60 * 1_000).toISOString();

  const { data, error } = await service
    .from('opportunity_events')
    .select('event_type,event_data,created_at')
    .in('opportunity_id', opportunityIds)
    .in('event_type', [...AUDIT_EVENT_TYPES])
    .gte('created_at', minimumDate)
    .order('created_at', { ascending: true })
    .limit(Math.min(2_000, events.length * (MAX_FAILURE_ATTEMPTS + 3)));

  if (error) {
    throw new RequestError(
      500,
      'AUDIT_QUERY_FAILED',
      `Não foi possível consultar o histórico das notificações: ${error.message}`,
    );
  }

  for (const row of Array.isArray(data) ? data : []) {
    const eventType = String(row.event_type);
    const eventData = asRecord(row.event_data);
    const sourceEventId = String(eventData.sourceEventId ?? '');
    if (!UUID_PATTERN.test(sourceEventId)) continue;

    if (eventType === 'notification_sent') {
      empty.sent.add(sourceEventId);
    } else if (eventType === 'notification_skipped') {
      empty.skipped.add(sourceEventId);
    } else if (eventType === 'notification_failed') {
      empty.failureCount.set(
        sourceEventId,
        (empty.failureCount.get(sourceEventId) ?? 0) + 1,
      );
    }
  }

  return empty;
}

async function loadUserNotificationStates(
  service: SupabaseClient,
  events: OpportunityEventRow[],
): Promise<Map<string, UserNotificationState>> {
  const userIds = [...new Set(events.map((event) => event.user_id))];
  const states = new Map<string, UserNotificationState>();
  if (userIds.length === 0) return states;

  const { data: settingsRows, error: settingsError } = await service
    .from('user_settings')
    .select('user_id,email_notif')
    .in('user_id', userIds);

  if (settingsError) {
    throw new RequestError(
      500,
      'SETTINGS_QUERY_FAILED',
      `Não foi possível consultar as preferências de email: ${settingsError.message}`,
    );
  }

  const enabledByUser = new Map<string, boolean>();
  for (const row of Array.isArray(settingsRows) ? settingsRows : []) {
    enabledByUser.set(String(row.user_id), row.email_notif !== false);
  }

  const loaded = await mapConcurrent(userIds, AUTH_CONCURRENCY, async (userId) => {
    const { data, error } = await service.auth.admin.getUserById(userId);
    if (error) {
      console.error(`Falha ao consultar email do usuário ${userId}:`, error.message);
    }

    return {
      userId,
      email: data?.user?.email ?? null,
      enabled: enabledByUser.get(userId) ?? true,
    } satisfies UserNotificationState;
  });

  for (const state of loaded) {
    states.set(state.userId, state);
  }

  return states;
}

async function logNotificationAudit(
  service: SupabaseClient,
  options: {
    event: OpportunityEventRow;
    auditType: NotificationAuditType;
    content?: EmailContent;
    recipient?: string | null;
    providerMessageId?: string | null;
    error?: string | null;
    reason?: string | null;
    attempt?: number;
    requestId: string;
    idempotencyKey?: string;
  },
): Promise<void> {
  const eventData: Record<string, unknown> = {
    sourceEventId: options.event.id,
    sourceEventType: options.event.event_type,
    channel: 'email',
    provider: 'resend',
    contentVersion: CONTENT_VERSION,
    requestId: options.requestId,
  };

  if (options.content) {
    eventData.category = options.content.category;
    eventData.priority = options.content.priority;
    eventData.subject = options.content.subject;
  }
  if (options.recipient) eventData.recipient = maskEmail(options.recipient);
  if (options.providerMessageId) eventData.providerMessageId = options.providerMessageId;
  if (options.error) eventData.error = truncate(options.error, 500);
  if (options.reason) eventData.reason = truncate(options.reason, 200);
  if (options.attempt !== undefined) eventData.attempt = options.attempt;
  if (options.idempotencyKey) eventData.idempotencyKey = options.idempotencyKey;

  const { error } = await service.rpc('log_opportunity_event', {
    p_opportunity_id: options.event.opportunity_id,
    p_user_id: options.event.user_id,
    p_event_type: options.auditType,
    p_actor_type: 'edge_function',
    p_event_data: eventData,
  });

  if (error) {
    console.error(
      `Falha ao registrar ${options.auditType} para ${options.event.id}:`,
      error.message,
    );
  }
}

// ---------------------------------------------------------------------------
// Envio pelo Resend
// ---------------------------------------------------------------------------

function buildFromHeader(): string {
  const fromEmail = requiredEnv('FROM_EMAIL');
  if (fromEmail.includes('<') && fromEmail.includes('>')) {
    return safeHeaderValue(fromEmail);
  }

  const fromName = Deno.env.get('FROM_NAME')?.trim() || 'VigIA Trade';
  return `${safeHeaderValue(fromName)} <${safeHeaderValue(fromEmail)}>`;
}

async function sendWithResend(
  options: {
    to: string;
    content: EmailContent;
    idempotencyKey: string;
  },
): Promise<ResendResult> {
  const apiKey = requiredEnv('RESEND_API_KEY');
  const payload: ResendPayload = {
    from: buildFromHeader(),
    to: [options.to],
    subject: options.content.subject,
    html: options.content.html,
    text: options.content.text,
    headers: {
      'X-Entity-Ref-ID': options.idempotencyKey,
    },
  };

  const replyTo = Deno.env.get('REPLY_TO_EMAIL')?.trim();
  if (replyTo) payload.reply_to = safeHeaderValue(replyTo);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? asRecord(JSON.parse(raw)) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const code = typeof parsed.name === 'string'
        ? parsed.name
        : typeof parsed.code === 'string'
          ? parsed.code
          : null;
      const message =
        typeof parsed.message === 'string'
          ? parsed.message
          : raw || `Resend respondeu ${response.status}`;
      const retryable =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500;

      return {
        ok: false,
        error: `Resend ${response.status}: ${truncate(message, 400)}`,
        code,
        retryable,
        responseStatus: response.status,
      };
    }

    return {
      ok: true,
      messageId: typeof parsed.id === 'string' ? parsed.id : null,
      responseStatus: response.status,
    };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    return {
      ok: false,
      error: aborted
        ? 'Tempo limite excedido ao enviar email pelo Resend.'
        : `Falha de comunicação com o Resend: ${truncate(error instanceof Error ? error.message : error, 300)}`,
      code: aborted ? 'RESEND_TIMEOUT' : 'RESEND_FETCH_ERROR',
      retryable: true,
      responseStatus: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Processamento
// ---------------------------------------------------------------------------

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

async function processEvent(
  service: SupabaseClient,
  options: {
    event: OpportunityEventRow;
    opportunity: TradeOpportunityRow | undefined;
    userState: UserNotificationState | undefined;
    prior: PriorNotificationState;
    appOrigin: string;
    requestId: string;
    dryRun: boolean;
  },
): Promise<ProcessingResult> {
  const { event, opportunity, userState, prior } = options;

  if (prior.sent.has(event.id) || prior.skipped.has(event.id)) {
    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: 'already_processed',
      message: prior.sent.has(event.id)
        ? 'Notificação já enviada.'
        : 'Evento já marcado como ignorado.',
    };
  }

  const previousFailures = prior.failureCount.get(event.id) ?? 0;
  if (previousFailures >= MAX_FAILURE_ATTEMPTS) {
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_skipped',
        reason: 'max_attempts_reached',
        attempt: previousFailures,
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'skipped',
      message: `Limite de ${MAX_FAILURE_ATTEMPTS} tentativas atingido.`,
    };
  }

  if (!isEligibleEventType(event.event_type)) {
    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: 'skipped',
      message: 'Evento não elegível.',
    };
  }

  const eventData = asRecord(event.event_data);
  if (!isExecutedClosingEvent(event, eventData)) {
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_skipped',
        reason: 'theoretical_outcome_not_emailed',
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'skipped',
      message: 'Resultado teórico mantido apenas na Central.',
    };
  }

  if (!opportunity) {
    const message = 'Oportunidade não encontrada para o evento.';
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_failed',
        error: message,
        attempt: previousFailures + 1,
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'failed',
      message,
    };
  }

  const currentDecision = shouldNotifyCurrentOpportunity(event.event_type, opportunity);
  if (!currentDecision.notify) {
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_skipped',
        reason: currentDecision.reason ?? 'current_state_not_eligible',
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'skipped',
      message: `Estado atual não elegível: ${currentDecision.reason ?? 'desconhecido'}.`,
    };
  }

  if (!userState) {
    const message = 'Preferências do usuário não foram carregadas.';
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_failed',
        error: message,
        attempt: previousFailures + 1,
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'failed',
      message,
    };
  }

  if (!userState.enabled) {
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_skipped',
        recipient: userState.email,
        reason: 'email_notifications_disabled',
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'skipped',
      recipient: maskEmail(userState.email),
      message: 'Notificações por email desativadas pelo usuário.',
    };
  }

  if (!userState.email) {
    if (!options.dryRun) {
      await logNotificationAudit(service, {
        event,
        auditType: 'notification_skipped',
        reason: 'user_without_email',
        requestId: options.requestId,
      });
    }

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: options.dryRun ? 'dry_run' : 'skipped',
      message: 'Usuário sem email disponível.',
    };
  }

  const content = buildEmailContent(event, opportunity, options.appOrigin);
  const idempotencyKey = `vigia-opportunity/${event.id}`;

  if (options.dryRun) {
    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: 'dry_run',
      category: content.category,
      recipient: maskEmail(userState.email),
      subject: content.subject,
      message: 'Email validado sem envio.',
    };
  }

  const sendResult = await sendWithResend({
    to: userState.email,
    content,
    idempotencyKey,
  });

  if (sendResult.ok) {
    await logNotificationAudit(service, {
      event,
      auditType: 'notification_sent',
      content,
      recipient: userState.email,
      providerMessageId: sendResult.messageId,
      attempt: previousFailures + 1,
      requestId: options.requestId,
      idempotencyKey,
    });

    return {
      event_id: event.id,
      opportunity_id: event.opportunity_id,
      event_type: event.event_type,
      disposition: 'sent',
      category: content.category,
      recipient: maskEmail(userState.email),
      subject: content.subject,
      provider_message_id: sendResult.messageId,
      message: 'Email enviado.',
    };
  }

  await logNotificationAudit(service, {
    event,
    auditType: 'notification_failed',
    content,
    recipient: userState.email,
    error: sendResult.error,
    reason: sendResult.code ?? 'resend_error',
    attempt: previousFailures + 1,
    requestId: options.requestId,
    idempotencyKey,
  });

  return {
    event_id: event.id,
    opportunity_id: event.opportunity_id,
    event_type: event.event_type,
    disposition: 'failed',
    category: content.category,
    recipient: maskEmail(userState.email),
    subject: content.subject,
    message: sendResult.error,
  };
}

function summarize(requestId: string, results: ProcessingResult[]): RunSummary {
  const summary: RunSummary = {
    request_id: requestId,
    selected: results.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    already_processed: 0,
    dry_run: 0,
    results,
  };

  for (const result of results) {
    if (result.disposition === 'sent') summary.sent += 1;
    else if (result.disposition === 'skipped') summary.skipped += 1;
    else if (result.disposition === 'failed') summary.failed += 1;
    else if (result.disposition === 'already_processed') summary.already_processed += 1;
    else if (result.disposition === 'dry_run') summary.dry_run += 1;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (request: Request): Promise<Response> => {
  const requestId =
    request.headers.get('x-request-id')?.trim() || crypto.randomUUID();

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return jsonResponse(
      {
        error: 'Método não permitido.',
        code: 'METHOD_NOT_ALLOWED',
        request_id: requestId,
      },
      requestId,
      405,
      { Allow: 'POST, OPTIONS' },
    );
  }

  try {
    const configuredSecret = requiredEnv('CRON_SECRET');
    const suppliedSecret = request.headers.get('x-cron-secret') ?? '';

    if (!suppliedSecret || !constantTimeEqual(suppliedSecret, configuredSecret)) {
      throw new RequestError(
        401,
        'INVALID_CRON_SECRET',
        'Credencial do cron inválida.',
      );
    }

    const parsed = parseRequest(await readRequestBody(request));
    const service = createServiceClient();
    const appOrigin = resolveAppOrigin();

    if (!parsed.dryRun) {
      requiredEnv('RESEND_API_KEY');
      requiredEnv('FROM_EMAIL');
    }

    const events = await loadCandidateEvents(service, parsed);
    if (events.length === 0) {
      return jsonResponse(
        summarize(requestId, []),
        requestId,
        200,
      );
    }

    const prior = await loadPriorNotificationState(service, events);
    const processableEvents = parsed.eventId
      ? events
      : events
        .filter((event) => !prior.sent.has(event.id) && !prior.skipped.has(event.id))
        .slice(0, parsed.limit);

    if (processableEvents.length === 0) {
      return jsonResponse(
        summarize(requestId, []),
        requestId,
        200,
      );
    }

    const [opportunities, userStates] = await Promise.all([
      loadOpportunities(service, processableEvents),
      loadUserNotificationStates(service, processableEvents),
    ]);

    const results = await mapConcurrent(
      processableEvents,
      SEND_CONCURRENCY,
      async (event) => processEvent(service, {
        event,
        opportunity: opportunities.get(event.opportunity_id),
        userState: userStates.get(event.user_id),
        prior,
        appOrigin,
        requestId,
        dryRun: parsed.dryRun,
      }),
    );

    const summary = summarize(requestId, results);
    const status = summary.failed > 0 && summary.sent === 0 ? 502 : 200;
    return jsonResponse(summary, requestId, status);
  } catch (error) {
    console.error(`[${requestId}] notificar-oportunidades:`, error);
    return errorResponse(requestId, error);
  }
});