'use client';

/**
 * app/oportunidades/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Central autenticada e em tempo real para acompanhar oportunidades.
 *
 * Recursos desta primeira versão:
 * - login por magic link sem senha;
 * - carregamento de oportunidades, resultados, decisões, eventos e ordens;
 * - seções Pendentes, Posições, Saídas, Histórico e Desempenho;
 * - atualização por Supabase Realtime, sem polling contínuo;
 * - abertura de card com marcação de leitura e início de revisão;
 * - segundo clique explícito para aceitar ou recusar uma entrada;
 * - sincronização manual de setups e atualização de resultados teóricos;
 * - deep link seguro no formato /oportunidades?focus=<uuid>;
 * - métricas teóricas separadas das métricas realmente executadas.
 *
 * Limites intencionais:
 * - aceitar uma oportunidade coloca o registro em revalidação;
 * - esta página não executa compra, venda, OCO ou saída diretamente;
 * - o servidor, as RPCs e as Edge Functions continuam sendo a fonte de verdade.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';

import { getSupabase } from '../../lib/supabaseClient';
import {
  calculateMetricBreakdown,
  calculateOpportunityDashboardMetrics,
  removeOutcomeFromCollection,
  upsertOutcomeCollection,
  type OpportunityDashboardMetrics,
  type OpportunityMetricBreakdownItem,
} from '../../lib/opportunities/metrics';
import {
  compareOpportunitiesForDashboard,
  getEntryDecisionPresentation,
  getExecutionEnvironmentLabel,
  getLifecyclePresentation,
  getOpportunityCardState,
  getOpportunitySourceLabel,
  getOrderStatusPresentation,
  getOutcomeModeLabel,
  getOutcomeStatusPresentation,
  getOutcomeTone,
  type OpportunitySection,
  type StatusTone,
} from '../../lib/opportunities/status';
import type {
  ISODateString,
  JsonArray,
  JsonObject,
  OpportunityConditionSnapshot,
  OpportunityDecision,
  OpportunityEvent,
  OpportunityLifecycleStatus,
  OpportunityListItem,
  OpportunityOrder,
  OpportunityOutcome,
  OpportunityOutcomeMode,
  OpportunityRealtimeEventType,
  TradeOpportunity,
  UUID,
} from '../../lib/opportunities/types';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

type MainTab =
  | 'pending'
  | 'positions'
  | 'exits'
  | 'history'
  | 'performance';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type RealtimeState =
  | 'disconnected'
  | 'connecting'
  | 'live'
  | 'error';

type RemoteActionState =
  | 'idle'
  | 'loading'
  | 'success'
  | 'error';

interface ActionFeedback {
  state: RemoteActionState;
  message: string;
}

interface ConditionView {
  id: string;
  label: string;
  passed: boolean | null;
  available: boolean;
  currentValue: string;
  requiredValue: string;
  explanation: string;
}

interface RealtimePayloadLike {
  eventType: OpportunityRealtimeEventType;
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

type PositionSizingMode =
  | 'fixed'
  | 'anti_martingale'
  | 'martingale_testnet';

type PositionSizingScope =
  | 'account'
  | 'strategy'
  | 'symbol'
  | 'symbol_timeframe';

interface PositionSizingDecision {
  id: UUID;
  opportunity_id: UUID;
  order_id: UUID | null;

  source: string;
  status: string;
  execution_environment: 'testnet' | 'real';

  sizing_mode: PositionSizingMode;
  sizing_scope: PositionSizingScope;
  policy_version: string;

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

  limiting_rules: string[];

  calculation_input: JsonObject;
  policy_snapshot: JsonObject;
  result_snapshot: JsonObject;

  applied_at: ISODateString | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OPPORTUNITY_LIMIT = 200;
const RELATED_LIMIT = 1_000;

const S = {
  bg: '#101418',
  panel: '#181f26',
  panelRaised: '#1d252e',
  border: '#2a343f',
  borderStrong: '#3a4653',
  text: '#d7dee6',
  textStrong: '#f2f5f8',
  dim: '#7d8a97',
  dimStrong: '#9ba7b3',
  a: '#e8a13c',
  aDark: '#1a1206',
  blue: '#4f8fd0',
  green: '#3fb26f',
  red: '#d05555',
  purple: '#9a79d0',
  cyan: '#42aeb8',
};

const TONE_COLOR: Readonly<Record<StatusTone, string>> = {
  neutral: S.dimStrong,
  info: S.blue,
  positive: S.green,
  warning: S.a,
  danger: S.red,
  critical: '#ff6b6b',
  muted: S.dim,
};

const TAB_LABELS: Readonly<Record<MainTab, string>> = {
  pending: 'Pendentes',
  positions: 'Em andamento',
  exits: 'Saídas',
  history: 'Histórico',
  performance: 'Desempenho',
};

const POSITION_SIZING_MODE_LABEL: Readonly<
  Record<PositionSizingMode, string>
> = {
  fixed: 'Valor fixo',
  anti_martingale: 'Anti-martingale',
  martingale_testnet: 'Martingale experimental',
};

const POSITION_SIZING_SCOPE_LABEL: Readonly<
  Record<PositionSizingScope, string>
> = {
  account: 'Conta inteira',
  strategy: 'Estratégia',
  symbol: 'Ativo',
  symbol_timeframe: 'Ativo + timeframe',
};

function getPositionSizingModeTone(
  mode: PositionSizingMode,
): StatusTone {
  if (mode === 'anti_martingale') {
    return 'positive';
  }

  if (mode === 'martingale_testnet') {
    return 'danger';
  }

  return 'neutral';
}

function getPositionSizingStatusPresentation(
  status: string,
): {
  label: string;
  tone: StatusTone;
} {
  if (status === 'applied') {
    return {
      label: 'Aplicado',
      tone: 'positive',
    };
  }

  if (status === 'reserved') {
    return {
      label: 'Reservado',
      tone: 'warning',
    };
  }

  if (status === 'cancelled') {
    return {
      label: 'Cancelado',
      tone: 'muted',
    };
  }

  if (status === 'failed') {
    return {
      label: 'Falhou',
      tone: 'danger',
    };
  }

  return {
    label: status || 'Desconhecido',
    tone: 'neutral',
  };
}

function displayLimitingRule(rule: string): string {
  const labels: Readonly<Record<string, string>> = {
    risk: 'limite de risco',
    risk_limit: 'limite de risco',
    available_balance: 'saldo disponível',
    balance_usage_limit: 'percentual máximo do saldo',
    max_order_usdt: 'máximo por ordem',
    configured_order_limit: 'máximo configurado por ordem',
    exchange_min_notional: 'mínimo da Binance',
    exchange_max_notional: 'máximo da Binance',
    exchange_notional_limit: 'limite de valor da Binance',
    minimum_risk: 'risco mínimo',
    maximum_risk: 'risco máximo',
    maximum_multiplier: 'multiplicador máximo',
    maximum_sequence_steps: 'máximo de etapas',
    consecutive_loss_pause: 'pausa por perdas consecutivas',
  };

  if (labels[rule]) {
    return labels[rule];
  }

  return rule
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) =>
      letter.toLocaleUpperCase('pt-BR'),
    );
}

const inputStyle: CSSProperties = {
  width: '100%',
  minHeight: 40,
  background: S.bg,
  border: `1px solid ${S.border}`,
  borderRadius: 8,
  color: S.text,
  padding: '9px 11px',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'inherit',
};

const subtleButtonStyle: CSSProperties = {
  background: 'transparent',
  color: S.dimStrong,
  border: `1px solid ${S.border}`,
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const primaryButtonStyle: CSSProperties = {
  background: S.a,
  color: S.aDark,
  border: 'none',
  borderRadius: 8,
  padding: '10px 16px',
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const dangerButtonStyle: CSSProperties = {
  background: 'transparent',
  color: S.red,
  border: `1px solid ${S.red}88`,
  borderRadius: 8,
  padding: '10px 16px',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

// ---------------------------------------------------------------------------
// Componentes visuais básicos
// ---------------------------------------------------------------------------

function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        background: S.panel,
        border: `1px solid ${S.border}`,
        borderRadius: 12,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function Pill({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: StatusTone;
  title?: string;
}) {
  const color = TONE_COLOR[tone];

  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        border: `1px solid ${color}66`,
        background: `${color}14`,
        color,
        borderRadius: 999,
        padding: '4px 8px',
        fontSize: 10,
        fontWeight: 800,
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        marginBottom: 12,
      }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            color: S.textStrong,
            fontSize: 16,
            lineHeight: 1.25,
          }}
        >
          {title}
        </h2>
        {subtitle && (
          <div
            style={{
              color: S.dim,
              fontSize: 11,
              marginTop: 4,
              lineHeight: 1.45,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: StatusTone;
}) {
  const color = TONE_COLOR[tone];

  return (
    <div
      style={{
        minWidth: 0,
        border: `1px solid ${S.border}`,
        background: S.panelRaised,
        borderRadius: 10,
        padding: '12px 13px',
      }}
    >
      <div
        style={{
          color: S.dim,
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          fontWeight: 800,
        }}
      >
        {label}
      </div>
      <div
        style={{
          color,
          fontSize: 22,
          fontWeight: 800,
          marginTop: 5,
          lineHeight: 1.05,
          overflowWrap: 'anywhere',
        }}
      >
        {value}
      </div>
      {detail && (
        <div
          style={{
            color: S.dimStrong,
            fontSize: 10,
            marginTop: 6,
            lineHeight: 1.35,
          }}
        >
          {detail}
        </div>
      )}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        border: `1px dashed ${S.borderStrong}`,
        borderRadius: 10,
        padding: '26px 18px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          color: S.text,
          fontSize: 14,
          fontWeight: 700,
        }}
      >
        {title}
      </div>
      <div
        style={{
          color: S.dim,
          fontSize: 12,
          lineHeight: 1.5,
          maxWidth: 520,
          margin: '6px auto 0',
        }}
      >
        {description}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatação e normalização
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }

  return null;
}

function fmtNumber(
  value: number | null | undefined,
  maximumFractionDigits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  const decimals =
    value >= 1_000 ? 2 : value >= 1 ? 4 : 8;

  return `${fmtNumber(value, decimals)} USDT`;
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  const sign = value > 0 ? '+' : '';
  return `${sign}${fmtNumber(value, 2)}%`;
}

function fmtR(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  const sign = value > 0 ? '+' : '';
  return `${sign}${fmtNumber(value, 2)}R`;
}

function fmtDate(
  value: ISODateString | null | undefined,
  includeYear = false,
): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return '—';
  }

  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: includeYear ? '2-digit' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtTimeframe(timeframe: string): string {
  const labels: Readonly<Record<string, string>> = {
    '5m': '5 minutos',
    '15m': '15 minutos',
    '30m': '30 minutos',
    '1h': '1 hora',
    '4h': '4 horas',
    '1d': 'Diário',
    '1w': 'Semanal',
  };

  return labels[timeframe] ?? timeframe;
}

function displayStrategy(strategy: string): string {
  if (strategy === 'trend_breakout') {
    return 'Tendência com rompimento';
  }

  return strategy
    .split('_')
    .filter(Boolean)
    .map(
      (part) =>
        part.charAt(0).toLocaleUpperCase('pt-BR') +
        part.slice(1),
    )
    .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function jsonDisplayValue(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }

  if (value === null || value === undefined) {
    return '—';
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '—';
  }
}

function normalizeConditions(
  value: OpportunityConditionSnapshot[] | JsonArray,
): ConditionView[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const records = (value as unknown[]).filter(isRecord);

  return records.map((condition, index) => ({
      id:
        typeof condition.id === 'string'
          ? condition.id
          : `condition-${index}`,
      label:
        typeof condition.label === 'string'
          ? condition.label
          : `Condição ${index + 1}`,
      passed:
        typeof condition.passed === 'boolean'
          ? condition.passed
          : null,
      available:
        typeof condition.available === 'boolean'
          ? condition.available
          : true,
      currentValue: jsonDisplayValue(condition.currentValue),
      requiredValue:
        typeof condition.requiredValue === 'string'
          ? condition.requiredValue
          : '—',
      explanation:
        typeof condition.explanation === 'string'
          ? condition.explanation
          : '',
    }));
}

function normalizeWarnings(value: string[] | JsonArray): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(
    (warning): warning is string => typeof warning === 'string',
  );
}

function normalizePositionSizingMode(
  value: unknown,
): PositionSizingMode {
  return value === 'anti_martingale' ||
      value === 'martingale_testnet'
    ? value
    : 'fixed';
}

function normalizePositionSizingScope(
  value: unknown,
): PositionSizingScope {
  return value === 'account' ||
      value === 'symbol' ||
      value === 'symbol_timeframe'
    ? value
    : 'strategy';
}

function normalizeJsonObject(value: unknown): JsonObject {
  return isRecord(value)
    ? value as JsonObject
    : {};
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string =>
      typeof item === 'string' && item.trim() !== '',
  );
}

function normalizePositionSizingDecision(
  value: unknown,
): PositionSizingDecision | null {
  if (!isRecord(value)) {
    return null;
  }

  const id =
    typeof value.id === 'string'
      ? value.id
      : null;

  const opportunityId =
    typeof value.opportunity_id === 'string'
      ? value.opportunity_id
      : null;

  if (
    !id ||
    !opportunityId ||
    !UUID_PATTERN.test(id) ||
    !UUID_PATTERN.test(opportunityId)
  ) {
    return null;
  }

  const environment =
    value.execution_environment === 'real'
      ? 'real'
      : 'testnet';

  const createdAt =
    typeof value.created_at === 'string'
      ? value.created_at
      : new Date(0).toISOString();

  const updatedAt =
    typeof value.updated_at === 'string'
      ? value.updated_at
      : createdAt;

  return {
    id: id as UUID,
    opportunity_id: opportunityId as UUID,

    order_id:
      typeof value.order_id === 'string' &&
      UUID_PATTERN.test(value.order_id)
        ? value.order_id as UUID
        : null,

    source:
      typeof value.source === 'string'
        ? value.source
        : 'unknown',

    status:
      typeof value.status === 'string'
        ? value.status
        : 'reserved',

    execution_environment: environment,

    sizing_mode:
      normalizePositionSizingMode(value.sizing_mode),

    sizing_scope:
      normalizePositionSizingScope(value.sizing_scope),

    policy_version:
      typeof value.policy_version === 'string'
        ? value.policy_version
        : '1.0.0',

    available_balance_usdt:
      finiteNumber(value.available_balance_usdt),

    balance_usage_limit_pct:
      finiteNumber(value.balance_usage_limit_pct) ?? 100,

    base_risk_percent:
      finiteNumber(value.base_risk_percent) ?? 0,

    target_risk_percent:
      finiteNumber(value.target_risk_percent),

    applied_risk_percent:
      finiteNumber(value.applied_risk_percent),

    risk_multiplier:
      finiteNumber(value.risk_multiplier) ?? 1,

    sequence_step:
      finiteNumber(value.sequence_step) ?? 0,

    consecutive_wins:
      finiteNumber(value.consecutive_wins) ?? 0,

    consecutive_losses:
      finiteNumber(value.consecutive_losses) ?? 0,

    account_consecutive_wins:
      finiteNumber(value.account_consecutive_wins) ?? 0,

    account_consecutive_losses:
      finiteNumber(value.account_consecutive_losses) ?? 0,

    stop_distance_pct:
      finiteNumber(value.stop_distance_pct) ?? 0,

    estimated_fee_rate_pct:
      finiteNumber(value.estimated_fee_rate_pct) ?? 0,

    estimated_slippage_pct:
      finiteNumber(value.estimated_slippage_pct) ?? 0,

    estimated_total_cost_pct:
      finiteNumber(value.estimated_total_cost_pct) ?? 0,

    estimated_loss_rate_pct:
      finiteNumber(value.estimated_loss_rate_pct) ?? 0,

    planned_risk_usdt:
      finiteNumber(value.planned_risk_usdt),

    actual_risk_usdt:
      finiteNumber(value.actual_risk_usdt),

    requested_quote_amount:
      finiteNumber(value.requested_quote_amount),

    effective_quote_amount:
      finiteNumber(value.effective_quote_amount),

    max_order_usdt:
      finiteNumber(value.max_order_usdt) ?? 0,

    limiting_rules:
      normalizeStringArray(value.limiting_rules),

    calculation_input:
      normalizeJsonObject(value.calculation_input),

    policy_snapshot:
      normalizeJsonObject(value.policy_snapshot),

    result_snapshot:
      normalizeJsonObject(value.result_snapshot),

    applied_at:
      typeof value.applied_at === 'string'
        ? value.applied_at
        : null,

    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function marketSnapshotNumber(
  opportunity: TradeOpportunity,
  key: 'lastLivePrice' | 'lastClosedPrice',
): number | null {
  const snapshot = opportunity.market_snapshot;

  if (!isRecord(snapshot)) {
    return null;
  }

  return finiteNumber(snapshot[key]);
}

function planSnapshotNumber(
  opportunity: TradeOpportunity,
  key:
    | 'latestAcceptableEntry'
    | 'stopDistancePct'
    | 'targetDistancePct',
): number | null {
  const snapshot = opportunity.plan_snapshot;

  if (!isRecord(snapshot)) {
    return null;
  }

  return finiteNumber(snapshot[key]);
}

function friendlyError(
  error: unknown,
  fallback = 'Não foi possível concluir a operação.',
): string {
  let message = fallback;

  if (error instanceof Error && error.message) {
    message = error.message;
  } else if (
    isRecord(error) &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    message = error.message;
  }

  const normalized = message.toLocaleLowerCase('pt-BR');

  if (
    normalized.includes('jwt') ||
    normalized.includes('token') ||
    normalized.includes('sessão')
  ) {
    return 'Sua sessão expirou. Entre novamente para continuar.';
  }

  if (
    normalized.includes('row-level security') ||
    normalized.includes('rls') ||
    normalized.includes('permission')
  ) {
    return 'Sua sessão não autorizou esta ação. Entre novamente e repita a operação.';
  }

  if (normalized.includes('expired')) {
    return 'A oportunidade expirou antes da conclusão da ação.';
  }

  if (normalized.includes('not found')) {
    return 'A oportunidade não foi encontrada ou já foi atualizada.';
  }

  return message;
}

function createRequestId(): UUID {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return '00000000-0000-4000-8000-000000000000';
}

function safeFocusFromLocation(): UUID | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const focus = new URLSearchParams(window.location.search).get(
    'focus',
  );

  return focus && UUID_PATTERN.test(focus) ? focus : null;
}

function magicLinkRedirect(): string | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const url = new URL('/oportunidades', window.location.origin);
  const focus = safeFocusFromLocation();

  if (focus) {
    url.searchParams.set('focus', focus);
  }

  return url.toString();
}

function upsertById<T extends { id: string }>(
  rows: readonly T[],
  next: T,
): T[] {
  const index = rows.findIndex((row) => row.id === next.id);

  if (index < 0) {
    return [next, ...rows];
  }

  const copy = [...rows];
  copy[index] = next;
  return copy;
}

function removeById<T extends { id: string }>(
  rows: readonly T[],
  id: string,
): T[] {
  return rows.filter((row) => row.id !== id);
}

// ---------------------------------------------------------------------------
// Cards de oportunidade
// ---------------------------------------------------------------------------

function OutcomeBadge({
  outcome,
}: {
  outcome: OpportunityOutcome | null;
}) {
  if (!outcome) {
    return null;
  }

  const presentation = getOutcomeStatusPresentation(outcome.status);
  const resultTone = getOutcomeTone(outcome);

  return (
    <Pill
      tone={resultTone}
      title={`${getOutcomeModeLabel(outcome.mode)}: ${presentation.description}`}
    >
      {outcome.mode === 'theoretical' ? 'Teórico' : 'Executado'}
      {' · '}
      {presentation.shortLabel}
      {outcome.result_r !== null
        ? ` · ${fmtR(outcome.result_r)}`
        : ''}
    </Pill>
  );
}

function PositionSizingBadge({
  decision,
}: {
  decision: PositionSizingDecision | null;
}) {
  if (!decision) {
    return null;
  }

  const effectiveRisk =
    decision.applied_risk_percent ??
    decision.target_risk_percent ??
    decision.base_risk_percent;

  const status =
    getPositionSizingStatusPresentation(decision.status);

  return (
    <Pill
      tone={
        decision.status === 'failed'
          ? 'danger'
          : getPositionSizingModeTone(decision.sizing_mode)
      }
      title={[
        POSITION_SIZING_MODE_LABEL[decision.sizing_mode],
        `Status: ${status.label}`,
        `Risco: ${fmtNumber(effectiveRisk, 4)}%`,
        `Multiplicador: ${fmtNumber(
          decision.risk_multiplier,
          4,
        )}×`,
      ].join(' · ')}
    >
      {POSITION_SIZING_MODE_LABEL[decision.sizing_mode]}
      {' · '}
      {fmtNumber(effectiveRisk, 2)}%
      {' · '}
      {fmtNumber(decision.risk_multiplier, 2)}×
    </Pill>
  );
}

function OpportunityCard({
  opportunity,
  theoreticalOutcome,
  executedOutcome,
  sizingDecision,
  onOpen,
}: {
  opportunity: TradeOpportunity;
  theoreticalOutcome: OpportunityOutcome | null;
  executedOutcome: OpportunityOutcome | null;
  sizingDecision: PositionSizingDecision | null;
  onOpen: (opportunity: TradeOpportunity) => void;
}) {
  const state = getOpportunityCardState(opportunity);
  const lifecycle = getLifecyclePresentation(state.effectiveStatus);
  const sourceLabel = getOpportunitySourceLabel(
    opportunity.source_type,
  );

  const keyboardOpen = (
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(opportunity);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(opportunity)}
      onKeyDown={keyboardOpen}
      aria-label={`Abrir oportunidade ${opportunity.symbol} ${opportunity.timeframe}`}
      style={{
        position: 'relative',
        minWidth: 0,
        border: `1px solid ${
          state.isUnread ? `${TONE_COLOR[state.tone]}99` : S.border
        }`,
        background: S.panelRaised,
        borderRadius: 12,
        padding: 14,
        cursor: 'pointer',
        outline: 'none',
        boxShadow: state.isUnread
          ? `0 0 0 1px ${TONE_COLOR[state.tone]}22`
          : 'none',
      }}
    >
      {state.isUnread && (
        <span
          title="Nova oportunidade"
          style={{
            position: 'absolute',
            top: 11,
            right: 11,
            width: 8,
            height: 8,
            borderRadius: 999,
            background: TONE_COLOR[state.tone],
            boxShadow: `0 0 0 4px ${TONE_COLOR[state.tone]}22`,
          }}
        />
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 10,
          paddingRight: state.isUnread ? 16 : 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: S.textStrong,
              fontSize: 18,
              fontWeight: 850,
              lineHeight: 1.05,
            }}
          >
            {opportunity.symbol}
          </div>
          <div
            style={{
              color: S.dim,
              fontSize: 11,
              marginTop: 4,
            }}
          >
            {fmtTimeframe(opportunity.timeframe)}
            {' · '}
            {sourceLabel}
          </div>
        </div>

        <Pill tone={state.tone} title={lifecycle.description}>
          {lifecycle.shortLabel}
        </Pill>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(3, minmax(0, 1fr))',
          gap: 8,
          marginTop: 14,
        }}
      >
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>ENTRADA</div>
          <div
            style={{
              color: S.text,
              fontSize: 12,
              fontWeight: 700,
              marginTop: 3,
            }}
          >
            {fmtPrice(opportunity.entry_reference)}
          </div>
        </div>
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>STOP</div>
          <div
            style={{
              color: S.red,
              fontSize: 12,
              fontWeight: 700,
              marginTop: 3,
            }}
          >
            {fmtPrice(opportunity.stop_reference)}
          </div>
        </div>
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>ALVO</div>
          <div
            style={{
              color: S.green,
              fontSize: 12,
              fontWeight: 700,
              marginTop: 3,
            }}
          >
            {fmtPrice(opportunity.target_reference)}
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
          marginTop: 13,
        }}
      >
        <Pill tone="neutral">
          {opportunity.score ?? 0}/{opportunity.total_conditions ?? 0}
          {' condições'}
        </Pill>
        <Pill
          tone={
            opportunity.execution_environment === 'real'
              ? 'danger'
              : opportunity.execution_environment === 'testnet'
                ? 'info'
                : 'muted'
          }
        >
          {getExecutionEnvironmentLabel(
            opportunity.execution_environment,
          )}
        </Pill>
        <OutcomeBadge outcome={theoreticalOutcome} />
        <OutcomeBadge outcome={executedOutcome} />
        <PositionSizingBadge decision={sizingDecision} />
      </div>

      <div
        style={{
          borderTop: `1px solid ${S.border}`,
          marginTop: 13,
          paddingTop: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            color:
              state.countdown.state === 'urgent'
                ? S.red
                : state.countdown.state === 'expired'
                  ? S.dim
                  : S.dimStrong,
            fontSize: 10,
            fontWeight:
              state.countdown.state === 'urgent' ? 800 : 500,
          }}
        >
          {state.countdown.label}
        </span>

        <span
          style={{
            color: S.a,
            fontSize: 11,
            fontWeight: 750,
          }}
        >
          Abrir detalhes →
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhamento
// ---------------------------------------------------------------------------

function PlanGrid({
  opportunity,
}: {
  opportunity: TradeOpportunity;
}) {
  const latestAcceptableEntry = planSnapshotNumber(
    opportunity,
    'latestAcceptableEntry',
  );

  const items = [
    {
      label: 'Entrada de referência',
      value: fmtPrice(opportunity.entry_reference),
      color: S.textStrong,
    },
    {
      label: 'Entrada máxima',
      value: fmtPrice(
        opportunity.maximum_entry_price ??
          latestAcceptableEntry,
      ),
      color: S.a,
    },
    {
      label: 'Stop',
      value: fmtPrice(opportunity.stop_reference),
      color: S.red,
    },
    {
      label: 'Alvo',
      value: fmtPrice(opportunity.target_reference),
      color: S.green,
    },
    {
      label: 'Risco/retorno bruto',
      value:
        opportunity.gross_risk_reward === null
          ? '—'
          : `${fmtNumber(opportunity.gross_risk_reward, 2)}R`,
      color: S.blue,
    },
    {
      label: 'Valor definido',
      value:
        opportunity.quote_amount === null
          ? 'Ainda não definido'
          : fmtPrice(opportunity.quote_amount),
      color: S.text,
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns:
          'repeat(auto-fit, minmax(145px, 1fr))',
        gap: 8,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            border: `1px solid ${S.border}`,
            borderRadius: 9,
            padding: '10px 11px',
            background: S.bg,
            minWidth: 0,
          }}
        >
          <div
            style={{
              color: S.dim,
              fontSize: 9,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              color: item.color,
              fontSize: 13,
              fontWeight: 750,
              marginTop: 4,
              overflowWrap: 'anywhere',
            }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function PositionSizingPanel({
  decisions,
}: {
  decisions: readonly PositionSizingDecision[];
}) {
  if (decisions.length === 0) {
    return (
      <div
        style={{
          color: S.dim,
          fontSize: 12,
          border: `1px dashed ${S.borderStrong}`,
          borderRadius: 9,
          padding: 12,
          lineHeight: 1.5,
        }}
      >
        O valor da posição ainda não foi calculado. A decisão de risco
        é criada no servidor imediatamente antes da execução, depois
        da conferência do saldo, stop, custos e limites da conta.
      </div>
    );
  }

  const decision = decisions[0];
  const status =
    getPositionSizingStatusPresentation(decision.status);

  const effectiveRisk =
    decision.applied_risk_percent ??
    decision.target_risk_percent ??
    decision.base_risk_percent;

  const quoteAmount =
    decision.effective_quote_amount ??
    decision.requested_quote_amount;

  return (
    <div
      style={{
        border: `1px solid ${
          decision.sizing_mode === 'martingale_testnet'
            ? `${S.red}66`
            : `${TONE_COLOR[
                getPositionSizingModeTone(
                  decision.sizing_mode,
                )
              ]}55`
        }`,
        borderRadius: 10,
        padding: 13,
        background:
          decision.sizing_mode === 'martingale_testnet'
            ? `${S.red}08`
            : S.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div
            style={{
              color: S.textStrong,
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {
              POSITION_SIZING_MODE_LABEL[
                decision.sizing_mode
              ]
            }
          </div>

          <div
            style={{
              color: S.dim,
              fontSize: 10,
              marginTop: 3,
            }}
          >
            Sequência por{' '}
            {
              POSITION_SIZING_SCOPE_LABEL[
                decision.sizing_scope
              ]
            }
            {' · '}política v{decision.policy_version}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <Pill tone={status.tone}>
            {status.label}
          </Pill>

          <Pill
            tone={
              decision.execution_environment === 'real'
                ? 'danger'
                : 'info'
            }
          >
            {decision.execution_environment === 'real'
              ? 'CONTA REAL'
              : 'TESTNET'}
          </Pill>
        </div>
      </div>

      {decision.sizing_mode === 'martingale_testnet' && (
        <div
          style={{
            color: S.red,
            fontSize: 11,
            fontWeight: 800,
            lineHeight: 1.5,
            border: `1px solid ${S.red}55`,
            borderRadius: 8,
            padding: 9,
            marginTop: 11,
          }}
        >
          ⚠️ Martingale experimental. Este método permanece restrito
          à Testnet e aumenta o risco depois de perdas.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 8,
          marginTop: 12,
        }}
      >
        <MetricCard
          label="Valor efetivo"
          value={
            quoteAmount === null
              ? '—'
              : `${fmtNumber(quoteAmount, 4)} USDT`
          }
          detail={
            decision.requested_quote_amount !== null
              ? `Solicitado: ${fmtNumber(
                  decision.requested_quote_amount,
                  4,
                )} USDT`
              : undefined
          }
          tone="info"
        />

        <MetricCard
          label="Risco aplicado"
          value={`${fmtNumber(effectiveRisk, 4)}%`}
          detail={`Base: ${fmtNumber(
            decision.base_risk_percent,
            4,
          )}%`}
          tone={
            effectiveRisk >
            decision.base_risk_percent
              ? 'warning'
              : 'neutral'
          }
        />

        <MetricCard
          label="Multiplicador"
          value={`${fmtNumber(
            decision.risk_multiplier,
            4,
          )}×`}
          detail={`Etapa ${fmtNumber(
            decision.sequence_step,
            0,
          )}`}
          tone={getPositionSizingModeTone(
            decision.sizing_mode,
          )}
        />

        <MetricCard
          label="Risco planejado"
          value={
            decision.planned_risk_usdt === null
              ? '—'
              : `${fmtNumber(
                  decision.planned_risk_usdt,
                  4,
                )} USDT`
          }
          detail={
            decision.actual_risk_usdt !== null
              ? `Real: ${fmtNumber(
                  decision.actual_risk_usdt,
                  4,
                )} USDT`
              : 'Aguardando risco real'
          }
          tone="danger"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(185px, 1fr))',
          gap: 8,
          marginTop: 10,
        }}
      >
        <div
          style={{
            border: `1px solid ${S.border}`,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div
            style={{
              color: S.dim,
              fontSize: 9,
              fontWeight: 800,
              textTransform: 'uppercase',
            }}
          >
            Sequência do escopo
          </div>

          <div
            style={{
              color: S.text,
              fontSize: 11,
              marginTop: 5,
              lineHeight: 1.5,
            }}
          >
            {fmtNumber(decision.consecutive_wins, 0)} vitória(s)
            {' · '}
            {fmtNumber(decision.consecutive_losses, 0)} perda(s)
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${S.border}`,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div
            style={{
              color: S.dim,
              fontSize: 9,
              fontWeight: 800,
              textTransform: 'uppercase',
            }}
          >
            Sequência da conta
          </div>

          <div
            style={{
              color: S.text,
              fontSize: 11,
              marginTop: 5,
              lineHeight: 1.5,
            }}
          >
            {fmtNumber(
              decision.account_consecutive_wins,
              0,
            )}{' '}
            vitória(s)
            {' · '}
            {fmtNumber(
              decision.account_consecutive_losses,
              0,
            )}{' '}
            perda(s)
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${S.border}`,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div
            style={{
              color: S.dim,
              fontSize: 9,
              fontWeight: 800,
              textTransform: 'uppercase',
            }}
          >
            Saldo considerado
          </div>

          <div
            style={{
              color: S.text,
              fontSize: 11,
              marginTop: 5,
              lineHeight: 1.5,
            }}
          >
            {decision.available_balance_usdt === null
              ? '—'
              : `${fmtNumber(
                  decision.available_balance_usdt,
                  4,
                )} USDT`}
            {' · '}
            uso máximo{' '}
            {fmtNumber(
              decision.balance_usage_limit_pct,
              2,
            )}
            %
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${S.border}`,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div
            style={{
              color: S.dim,
              fontSize: 9,
              fontWeight: 800,
              textTransform: 'uppercase',
            }}
          >
            Perda estimada no stop
          </div>

          <div
            style={{
              color: S.text,
              fontSize: 11,
              marginTop: 5,
              lineHeight: 1.5,
            }}
          >
            {fmtNumber(
              decision.estimated_loss_rate_pct,
              4,
            )}
            %
            {' · '}stop{' '}
            {fmtNumber(
              decision.stop_distance_pct,
              4,
            )}
            %
          </div>
        </div>
      </div>

      <div
        style={{
          color: S.dim,
          fontSize: 10,
          lineHeight: 1.55,
          marginTop: 10,
        }}
      >
        Custos estimados de ida e volta:{' '}
        {fmtNumber(
          decision.estimated_total_cost_pct,
          4,
        )}
        %
        {' · '}taxa por execução{' '}
        {fmtNumber(
          decision.estimated_fee_rate_pct,
          4,
        )}
        %
        {' · '}slippage por execução{' '}
        {fmtNumber(
          decision.estimated_slippage_pct,
          4,
        )}
        %
      </div>

      {decision.limiting_rules.length > 0 && (
        <div
          style={{
            border: `1px solid ${S.a}55`,
            background: `${S.a}08`,
            borderRadius: 8,
            padding: 10,
            marginTop: 10,
          }}
        >
          <div
            style={{
              color: S.a,
              fontSize: 10,
              fontWeight: 800,
            }}
          >
            O valor foi limitado por
          </div>

          <div
            style={{
              color: S.dimStrong,
              fontSize: 10,
              lineHeight: 1.5,
              marginTop: 4,
            }}
          >
            {decision.limiting_rules
              .map(displayLimitingRule)
              .join(' · ')}
          </div>
        </div>
      )}

      <div
        style={{
          color: S.dim,
          fontSize: 9,
          marginTop: 10,
          lineHeight: 1.45,
        }}
      >
        Criado em {fmtDate(decision.created_at, true)}
        {decision.applied_at
          ? ` · aplicado em ${fmtDate(
              decision.applied_at,
              true,
            )}`
          : ''}
        {' · '}origem {decision.source}
        {' · '}ID {decision.id.slice(0, 8)}…
        {decisions.length > 1
          ? ` · ${decisions.length} versões registradas`
          : ''}
      </div>
    </div>
  );
}

function ConditionsList({
  opportunity,
}: {
  opportunity: TradeOpportunity;
}) {
  const conditions = normalizeConditions(
    opportunity.conditions_snapshot,
  );

  if (conditions.length === 0) {
    return (
      <div style={{ color: S.dim, fontSize: 12 }}>
        Nenhum checklist foi preservado neste snapshot.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      {conditions.map((condition) => {
        const color =
          !condition.available || condition.passed === null
            ? S.dim
            : condition.passed
              ? S.green
              : S.red;

        return (
          <div
            key={condition.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '20px minmax(0, 1fr)',
              gap: 8,
              border: `1px solid ${S.border}`,
              borderRadius: 8,
              padding: '9px 10px',
              background: S.bg,
            }}
          >
            <div
              aria-hidden="true"
              style={{
                color,
                fontSize: 14,
                fontWeight: 900,
                lineHeight: 1.2,
              }}
            >
              {!condition.available || condition.passed === null
                ? '○'
                : condition.passed
                  ? '✓'
                  : '×'}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  color: S.text,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {condition.label}
              </div>
              <div
                style={{
                  color: S.dimStrong,
                  fontSize: 10,
                  marginTop: 3,
                  lineHeight: 1.4,
                }}
              >
                Atual: {condition.currentValue}
                {' · '}
                Exigência: {condition.requiredValue}
              </div>
              {condition.explanation && (
                <div
                  style={{
                    color: S.dim,
                    fontSize: 10,
                    marginTop: 3,
                    lineHeight: 1.4,
                  }}
                >
                  {condition.explanation}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function OutcomePanel({
  outcome,
}: {
  outcome: OpportunityOutcome | null;
}) {
  if (!outcome) {
    return (
      <div
        style={{
          color: S.dim,
          fontSize: 12,
          border: `1px dashed ${S.borderStrong}`,
          borderRadius: 8,
          padding: 12,
        }}
      >
        Resultado ainda não registrado.
      </div>
    );
  }

  const presentation = getOutcomeStatusPresentation(outcome.status);
  const tone = getOutcomeTone(outcome);

  return (
    <div
      style={{
        border: `1px solid ${TONE_COLOR[tone]}55`,
        borderRadius: 9,
        padding: 12,
        background: `${TONE_COLOR[tone]}08`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div
            style={{
              color: S.textStrong,
              fontSize: 13,
              fontWeight: 800,
            }}
          >
            {getOutcomeModeLabel(outcome.mode)}
          </div>
          <div
            style={{
              color: S.dim,
              fontSize: 10,
              marginTop: 3,
            }}
          >
            {presentation.description}
          </div>
        </div>
        <Pill tone={tone}>{presentation.label}</Pill>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(115px, 1fr))',
          gap: 8,
          marginTop: 11,
        }}
      >
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>RESULTADO</div>
          <div
            style={{
              color: TONE_COLOR[tone],
              fontSize: 14,
              fontWeight: 800,
              marginTop: 3,
            }}
          >
            {fmtR(outcome.result_r)}
          </div>
        </div>
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>PNL LÍQUIDO</div>
          <div
            style={{
              color:
                (outcome.net_pnl_usdt ?? 0) >= 0
                  ? S.green
                  : S.red,
              fontSize: 14,
              fontWeight: 800,
              marginTop: 3,
            }}
          >
            {outcome.net_pnl_usdt === null
              ? '—'
              : `${fmtNumber(outcome.net_pnl_usdt, 4)} USDT`}
          </div>
        </div>
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>MFE</div>
          <div
            style={{
              color: S.green,
              fontSize: 14,
              fontWeight: 800,
              marginTop: 3,
            }}
          >
            {fmtR(outcome.maximum_favorable_excursion_r)}
          </div>
        </div>
        <div>
          <div style={{ color: S.dim, fontSize: 9 }}>MAE</div>
          <div
            style={{
              color: S.red,
              fontSize: 14,
              fontWeight: 800,
              marginTop: 3,
            }}
          >
            {fmtR(outcome.maximum_adverse_excursion_r)}
          </div>
        </div>
      </div>

      <div
        style={{
          color: S.dim,
          fontSize: 10,
          marginTop: 9,
          lineHeight: 1.45,
        }}
      >
        Entrada {fmtPrice(outcome.entry_price)}
        {' · '}
        Saída {fmtPrice(outcome.exit_price)}
        {' · '}
        {outcome.resolved_at
          ? `resolvido em ${fmtDate(outcome.resolved_at, true)}`
          : 'em acompanhamento'}
      </div>
    </div>
  );
}

function OrdersPanel({
  orders,
}: {
  orders: readonly OpportunityOrder[];
}) {
  if (orders.length === 0) {
    return (
      <div
        style={{
          color: S.dim,
          fontSize: 12,
          border: `1px dashed ${S.borderStrong}`,
          borderRadius: 8,
          padding: 12,
        }}
      >
        Nenhuma ordem Binance vinculada.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
      }}
    >
      {orders.map((order) => {
        const presentation = getOrderStatusPresentation(
          order.status,
        );

        return (
          <div
            key={order.id}
            style={{
              border: `1px solid ${S.border}`,
              borderRadius: 8,
              padding: '10px 11px',
              background: S.bg,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <div
                style={{
                  color: S.text,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {order.is_testnet ? 'Testnet' : 'Conta real'}
                {' · '}
                {fmtPrice(order.quote_amount)}
              </div>
              <Pill
                tone={presentation.tone}
                title={presentation.description}
              >
                {presentation.label}
              </Pill>
            </div>

            <div
              style={{
                color: S.dim,
                fontSize: 10,
                marginTop: 5,
                lineHeight: 1.45,
              }}
            >
              Entrada {fmtPrice(order.entry_price)}
              {' · '}
              Stop {fmtPrice(order.stop_price)}
              {' · '}
              Alvo {fmtPrice(order.target_price)}
              {order.pnl_usdt !== null
                ? ` · PnL ${fmtNumber(order.pnl_usdt, 4)} USDT`
                : ''}
            </div>

            {order.erro && (
              <div
                style={{
                  color: S.red,
                  fontSize: 10,
                  marginTop: 5,
                  overflowWrap: 'anywhere',
                }}
              >
                {order.erro}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Timeline({
  events,
}: {
  events: readonly OpportunityEvent[];
}) {
  if (events.length === 0) {
    return (
      <div style={{ color: S.dim, fontSize: 12 }}>
        Nenhum evento registrado.
      </div>
    );
  }

  const eventLabels: Readonly<Record<string, string>> = {
    opportunity_created: 'Oportunidade criada',
    opportunity_seen: 'Oportunidade visualizada',
    review_started: 'Revisão iniciada',
    opportunity_expired: 'Oportunidade expirada',
    opportunity_invalidated: 'Oportunidade invalidada',
    entry_accepted: 'Entrada aceita para revalidação',
    entry_rejected: 'Entrada recusada',
    entry_revalidation_started: 'Revalidação iniciada',
    entry_revalidation_passed: 'Revalidação aprovada',
    entry_revalidation_failed: 'Revalidação bloqueada',
    order_created: 'Ordem criada',
    order_sent: 'Ordem enviada',
    entry_filled: 'Entrada executada',
    protection_pending: 'Proteção pendente',
    protection_created: 'Proteção OCO criada',
    protection_failed: 'Falha ao criar proteção',
    exit_opportunity_created: 'Saída identificada',
    exit_accepted: 'Saída aceita',
    position_kept: 'Posição mantida',
    exit_started: 'Encerramento iniciado',
    exit_completed: 'Encerramento concluído',
    target_hit: 'Alvo atingido',
    stop_hit: 'Stop atingido',
    outcome_resolved: 'Resultado apurado',
    error: 'Erro registrado',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {events.map((event, index) => (
        <div
          key={event.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '16px minmax(0, 1fr)',
            gap: 8,
            paddingBottom:
              index === events.length - 1 ? 0 : 12,
          }}
        >
          <div
            style={{
              position: 'relative',
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                marginTop: 5,
                borderRadius: 999,
                background:
                  event.event_type === 'error'
                    ? S.red
                    : event.actor_type === 'user'
                      ? S.a
                      : event.actor_type === 'exchange'
                        ? S.blue
                        : S.dimStrong,
                zIndex: 1,
              }}
            />
            {index !== events.length - 1 && (
              <span
                style={{
                  position: 'absolute',
                  top: 12,
                  bottom: -5,
                  width: 1,
                  background: S.border,
                }}
              />
            )}
          </div>

          <div>
            <div
              style={{
                color: S.text,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {eventLabels[event.event_type] ??
                event.event_type}
            </div>
            <div
              style={{
                color: S.dim,
                fontSize: 9,
                marginTop: 3,
              }}
            >
              {fmtDate(event.created_at, true)}
              {' · '}
              {event.actor_type}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desempenho
// ---------------------------------------------------------------------------

function PerformanceModeSection({
  title,
  subtitle,
  metrics,
}: {
  title: string;
  subtitle: string;
  metrics: OpportunityDashboardMetrics['theoretical'];
}) {
  return (
    <Card>
      <SectionTitle title={title} subtitle={subtitle} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(135px, 1fr))',
          gap: 8,
        }}
      >
        <MetricCard
          label="Encerradas"
          value={String(metrics.conclusive)}
          detail={`${metrics.tracking} em acompanhamento`}
          tone="info"
        />
        <MetricCard
          label="Taxa de acerto"
          value={
            metrics.winRatePct === null
              ? '—'
              : `${fmtNumber(metrics.winRatePct, 1)}%`
          }
          detail={`${metrics.wins} ganhos · ${metrics.losses} perdas`}
          tone={
            metrics.winRatePct === null
              ? 'muted'
              : metrics.winRatePct >= 50
                ? 'positive'
                : 'warning'
          }
        />
        <MetricCard
          label="Resultado acumulado"
          value={fmtR(metrics.totalResultR)}
          detail="Soma dos resultados conclusivos"
          tone={
            metrics.totalResultR > 0
              ? 'positive'
              : metrics.totalResultR < 0
                ? 'danger'
                : 'neutral'
          }
        />
        <MetricCard
          label="Expectativa"
          value={fmtR(metrics.expectancyR)}
          detail="Média por oportunidade conclusiva"
          tone={
            (metrics.expectancyR ?? 0) > 0
              ? 'positive'
              : (metrics.expectancyR ?? 0) < 0
                ? 'danger'
                : 'neutral'
          }
        />
        <MetricCard
          label="Profit factor"
          value={fmtNumber(metrics.profitFactor, 2)}
          detail="Ganhos brutos ÷ perdas brutas"
          tone={
            (metrics.profitFactor ?? 0) >= 1
              ? 'positive'
              : metrics.profitFactor === null
                ? 'muted'
                : 'danger'
          }
        />
        <MetricCard
          label="Drawdown máximo"
          value={fmtR(metrics.maximumDrawdownR)}
          detail="Queda da curva acumulada em R"
          tone="danger"
        />
        <MetricCard
          label="MFE médio"
          value={fmtR(metrics.averageMfeR)}
          detail="Máxima excursão favorável"
          tone="positive"
        />
        <MetricCard
          label="MAE médio"
          value={fmtR(metrics.averageMaeR)}
          detail="Máxima excursão adversa"
          tone="danger"
        />
      </div>
    </Card>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: readonly OpportunityMetricBreakdownItem[];
}) {
  return (
    <Card>
      <SectionTitle
        title={title}
        subtitle="Resultados teóricos separados por contexto."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Sem dados para comparar"
          description="Os recortes aparecerão após as primeiras oportunidades serem registradas."
        />
      ) : (
        <div
          style={{
            overflowX: 'auto',
            border: `1px solid ${S.border}`,
            borderRadius: 9,
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              minWidth: 620,
              fontSize: 11,
            }}
          >
            <thead>
              <tr style={{ background: S.bg }}>
                {[
                  'Grupo',
                  'Oportunidades',
                  'Concluídas',
                  'Acerto',
                  'Resultado',
                  'Expectativa',
                  'Profit factor',
                ].map((header) => (
                  <th
                    key={header}
                    style={{
                      color: S.dimStrong,
                      textAlign:
                        header === 'Grupo' ? 'left' : 'right',
                      padding: '9px 10px',
                      borderBottom: `1px solid ${S.border}`,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.dimension}:${row.key}`}>
                  <td
                    style={{
                      color: S.text,
                      padding: '9px 10px',
                      borderBottom: `1px solid ${S.border}`,
                      fontWeight: 700,
                    }}
                  >
                    {row.label}
                  </td>
                  <td style={tableNumberStyle}>
                    {row.totalOpportunities}
                  </td>
                  <td style={tableNumberStyle}>
                    {row.theoretical.conclusive}
                  </td>
                  <td style={tableNumberStyle}>
                    {row.theoretical.winRatePct === null
                      ? '—'
                      : `${fmtNumber(
                          row.theoretical.winRatePct,
                          1,
                        )}%`}
                  </td>
                  <td
                    style={{
                      ...tableNumberStyle,
                      color:
                        row.theoretical.totalResultR > 0
                          ? S.green
                          : row.theoretical.totalResultR < 0
                            ? S.red
                            : S.text,
                    }}
                  >
                    {fmtR(row.theoretical.totalResultR)}
                  </td>
                  <td style={tableNumberStyle}>
                    {fmtR(row.theoretical.expectancyR)}
                  </td>
                  <td style={tableNumberStyle}>
                    {fmtNumber(
                      row.theoretical.profitFactor,
                      2,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const tableNumberStyle: CSSProperties = {
  color: S.text,
  textAlign: 'right',
  padding: '9px 10px',
  borderBottom: `1px solid ${S.border}`,
  whiteSpace: 'nowrap',
};

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function OportunidadesPage() {
  const supabase = useMemo(() => getSupabase(), []);

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [magicSent, setMagicSent] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const [loadState, setLoadState] =
    useState<LoadState>('idle');
  const [loadError, setLoadError] = useState('');

  const [opportunities, setOpportunities] = useState<
    TradeOpportunity[]
  >([]);
  const [outcomes, setOutcomes] = useState<
    OpportunityOutcome[]
  >([]);
  const [decisions, setDecisions] = useState<
    OpportunityDecision[]
  >([]);
  const [events, setEvents] = useState<
    OpportunityEvent[]
  >([]);
  const [orders, setOrders] = useState<
    OpportunityOrder[]
  >([]);

  const [
    sizingDecisions,
    setSizingDecisions,
  ] = useState<PositionSizingDecision[]>([]);

  const [activeTab, setActiveTab] =
    useState<MainTab>('pending');
  const [selectedId, setSelectedId] =
    useState<UUID | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [realtimeState, setRealtimeState] =
    useState<RealtimeState>('disconnected');

  const [actionId, setActionId] =
    useState<UUID | null>(null);
  const [actionFeedback, setActionFeedback] =
    useState<ActionFeedback>({
      state: 'idle',
      message: '',
    });

  const [syncFeedback, setSyncFeedback] =
    useState<ActionFeedback>({
      state: 'idle',
      message: '',
    });

  const [trackingFeedback, setTrackingFeedback] =
    useState<ActionFeedback>({
      state: 'idle',
      message: '',
    });

  // Sessão -------------------------------------------------------------------

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) {
        return;
      }

      if (error) {
        setAuthError(error.message);
      }

      setSession(data.session);
      setAuthReady(true);
    });

    const { data: subscription } =
      supabase.auth.onAuthStateChange(
        (_event, nextSession) => {
          setSession(nextSession);
          setAuthReady(true);

          if (!nextSession) {
            setOpportunities([]);
            setOutcomes([]);
            setDecisions([]);
            setEvents([]);
            setOrders([]);
            setSizingDecisions([]);
            setSelectedId(null);
            setLoadState('idle');
            setRealtimeState('disconnected');
          }
        },
      );

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [supabase]);

  // Carregamento -------------------------------------------------------------

  const load = useCallback(async () => {
    if (!session) {
      return;
    }

    setLoadState('loading');
    setLoadError('');

    try {
      const opportunityResult = await supabase
        .from('trade_opportunities')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(OPPORTUNITY_LIMIT);

      if (opportunityResult.error) {
        throw opportunityResult.error;
      }

      const loadedOpportunities =
        (opportunityResult.data as TradeOpportunity[] | null) ??
        [];

      const ids = loadedOpportunities.map(
        (opportunity) => opportunity.id,
      );

      let loadedOutcomes: OpportunityOutcome[] = [];
      let loadedDecisions: OpportunityDecision[] = [];
      let loadedEvents: OpportunityEvent[] = [];
      let loadedOrders: OpportunityOrder[] = [];
      let loadedSizingDecisions: PositionSizingDecision[] = [];

      if (ids.length > 0) {
        const [
          outcomeResult,
          decisionResult,
          eventResult,
          orderResult,
          positionSizingResult,
        ] = await Promise.all([
          supabase
            .from('opportunity_outcomes')
            .select('*')
            .in('opportunity_id', ids)
            .order('updated_at', { ascending: false })
            .limit(RELATED_LIMIT),
          supabase
            .from('opportunity_decisions')
            .select('*')
            .in('opportunity_id', ids)
            .order('created_at', { ascending: false })
            .limit(RELATED_LIMIT),
          supabase
            .from('opportunity_events')
            .select('*')
            .in('opportunity_id', ids)
            .order('created_at', { ascending: false })
            .limit(RELATED_LIMIT),
          supabase
            .from('orders')
            .select('*')
            .in('opportunity_id', ids)
            .order('criado_em', { ascending: false })
            .limit(RELATED_LIMIT),
          supabase
            .from('position_sizing_decisions')
            .select('*')
            .in('opportunity_id', ids)
            .order('created_at', { ascending: false })
            .limit(RELATED_LIMIT),
        ]);

        const relatedError =
          outcomeResult.error ??
          decisionResult.error ??
          eventResult.error ??
          orderResult.error ??
          positionSizingResult.error;

        if (relatedError) {
          throw relatedError;
        }

        loadedOutcomes =
          (outcomeResult.data as OpportunityOutcome[] | null) ??
          [];
        loadedDecisions =
          (decisionResult.data as OpportunityDecision[] | null) ??
          [];
        loadedEvents =
          (eventResult.data as OpportunityEvent[] | null) ?? [];
        loadedOrders =
          (orderResult.data as OpportunityOrder[] | null) ?? [];

        loadedSizingDecisions = (
          positionSizingResult.data ?? []
        )
          .map(normalizePositionSizingDecision)
          .filter(
            (
              decision,
            ): decision is PositionSizingDecision =>
              decision !== null,
          )
          .sort(
            (left, right) =>
              Date.parse(right.created_at) -
              Date.parse(left.created_at),
          );
      }

      setOpportunities(
        [...loadedOpportunities].sort(
          compareOpportunitiesForDashboard,
        ),
      );
      setOutcomes(loadedOutcomes);
      setDecisions(loadedDecisions);
      setEvents(loadedEvents);
      setOrders(loadedOrders);
      setSizingDecisions(loadedSizingDecisions);
      setLoadState('ready');

      const focus = safeFocusFromLocation();

      if (
        focus &&
        loadedOpportunities.some(
          (opportunity) => opportunity.id === focus,
        )
      ) {
        setSelectedId(focus);

        const focused = loadedOpportunities.find(
          (opportunity) => opportunity.id === focus,
        );

        if (focused) {
          const section =
            getOpportunityCardState(focused).section;

          if (section !== 'attention') {
            setActiveTab(
              section === 'positions'
                ? 'positions'
                : section === 'exits'
                  ? 'exits'
                  : section === 'history'
                    ? 'history'
                    : 'pending',
            );
          }
        }
      }
    } catch (error) {
      setLoadError(friendlyError(error));
      setLoadState('error');
    }
  }, [session, supabase]);

  useEffect(() => {
    if (session) {
      void load();
    }
  }, [session, load]);

  useEffect(() => {
    if (!session) {
      return;
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    document.addEventListener(
      'visibilitychange',
      onVisibilityChange,
    );

    return () =>
      document.removeEventListener(
        'visibilitychange',
        onVisibilityChange,
      );
  }, [session, load]);

  // Realtime -----------------------------------------------------------------

  useEffect(() => {
    if (!session) {
      return;
    }

    const userFilter = `user_id=eq.${session.user.id}`;
    setRealtimeState('connecting');

    const channel = supabase
      .channel(`opportunities:${session.user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trade_opportunities',
          filter: userFilter,
        },
        (payload) => {
          const change = payload as unknown as RealtimePayloadLike;
          const row =
            change.eventType === 'DELETE'
              ? change.old
              : change.new;
          const id =
            typeof row.id === 'string' ? row.id : null;

          if (!id) {
            return;
          }

          if (change.eventType === 'DELETE') {
            setOpportunities((current) =>
              removeById(current, id),
            );
            setSelectedId((current) =>
              current === id ? null : current,
            );
            return;
          }

          setOpportunities((current) =>
            upsertById(
              current,
              row as unknown as TradeOpportunity,
            ).sort(compareOpportunitiesForDashboard),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'opportunity_outcomes',
          filter: userFilter,
        },
        (payload) => {
          const change = payload as unknown as RealtimePayloadLike;
          const row =
            change.eventType === 'DELETE'
              ? change.old
              : change.new;
          const id =
            typeof row.id === 'string' ? row.id : null;

          if (!id) {
            return;
          }

          if (change.eventType === 'DELETE') {
            setOutcomes((current) =>
              removeOutcomeFromCollection(current, id),
            );
            return;
          }

          setOutcomes((current) =>
            upsertOutcomeCollection(
              current,
              row as unknown as OpportunityOutcome,
            ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'opportunity_decisions',
          filter: userFilter,
        },
        (payload) => {
          const change = payload as unknown as RealtimePayloadLike;
          const row =
            change.eventType === 'DELETE'
              ? change.old
              : change.new;
          const id =
            typeof row.id === 'string' ? row.id : null;

          if (!id) {
            return;
          }

          setDecisions((current) =>
            change.eventType === 'DELETE'
              ? removeById(current, id)
              : upsertById(
                  current,
                  row as unknown as OpportunityDecision,
                ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'opportunity_events',
          filter: userFilter,
        },
        (payload) => {
          const change = payload as unknown as RealtimePayloadLike;
          const row =
            change.eventType === 'DELETE'
              ? change.old
              : change.new;
          const id =
            typeof row.id === 'string' ? row.id : null;

          if (!id) {
            return;
          }

          setEvents((current) =>
            change.eventType === 'DELETE'
              ? removeById(current, id)
              : upsertById(
                  current,
                  row as unknown as OpportunityEvent,
                ).sort(
                  (left, right) =>
                    Date.parse(right.created_at) -
                    Date.parse(left.created_at),
                ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: userFilter,
        },
        (payload) => {
          const change = payload as unknown as RealtimePayloadLike;
          const row =
            change.eventType === 'DELETE'
              ? change.old
              : change.new;
          const id =
            typeof row.id === 'string' ? row.id : null;

          if (!id) {
            return;
          }

          setOrders((current) =>
            change.eventType === 'DELETE'
              ? removeById(current, id)
              : upsertById(
                  current,
                  row as unknown as OpportunityOrder,
                ),
          );
        },
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'position_sizing_decisions',
          filter: userFilter,
        },
        (payload) => {
          const change =
            payload as unknown as RealtimePayloadLike;

          const row =
            change.eventType === 'DELETE'
              ? change.old
              : change.new;

          const id =
            typeof row.id === 'string'
              ? row.id
              : null;

          if (!id) {
            return;
          }

          if (change.eventType === 'DELETE') {
            setSizingDecisions((current) =>
              removeById(current, id),
            );
            return;
          }

          const decision =
            normalizePositionSizingDecision(row);

          if (!decision) {
            return;
          }

          setSizingDecisions((current) =>
            upsertById(current, decision).sort(
              (left, right) =>
                Date.parse(right.created_at) -
                Date.parse(left.created_at),
            ),
          );
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeState('live');
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT'
        ) {
          setRealtimeState('error');
        } else if (status === 'CLOSED') {
          setRealtimeState('disconnected');
        }
      });

    return () => {
      setRealtimeState('disconnected');
      void supabase.removeChannel(channel);
    };
  }, [session, supabase]);

  // Derivados ---------------------------------------------------------------

  const outcomeIndex = useMemo(() => {
    const index = new Map<
      string,
      OpportunityOutcome
    >();

    for (const outcome of outcomes) {
      index.set(
        `${outcome.opportunity_id}:${outcome.mode}`,
        outcome,
      );
    }

    return index;
  }, [outcomes]);

  const latestSizingDecisionByOpportunity = useMemo(() => {
    const index = new Map<
      UUID,
      PositionSizingDecision
    >();

    const sorted = [...sizingDecisions].sort(
      (left, right) =>
        Date.parse(right.created_at) -
        Date.parse(left.created_at),
    );

    for (const decision of sorted) {
      if (!index.has(decision.opportunity_id)) {
        index.set(
          decision.opportunity_id,
          decision,
        );
      }
    }

    return index;
  }, [sizingDecisions]);

  const metrics = useMemo(
    () =>
      calculateOpportunityDashboardMetrics({
        opportunities,
        outcomes,
      }),
    [opportunities, outcomes],
  );

  const symbolBreakdown = useMemo(
    () =>
      calculateMetricBreakdown(
        { opportunities, outcomes },
        'symbol',
      ),
    [opportunities, outcomes],
  );

  const versionBreakdown = useMemo(
    () =>
      calculateMetricBreakdown(
        { opportunities, outcomes },
        'strategy_version',
      ),
    [opportunities, outcomes],
  );

  const sectioned = useMemo(() => {
    const result: Record<
      OpportunitySection,
      TradeOpportunity[]
    > = {
      pending: [],
      positions: [],
      exits: [],
      history: [],
      attention: [],
    };

    for (const opportunity of opportunities) {
      const section =
        getOpportunityCardState(opportunity).section;

      result[section].push(opportunity);
    }

    for (const section of Object.keys(
      result,
    ) as OpportunitySection[]) {
      result[section].sort(
        compareOpportunitiesForDashboard,
      );
    }

    return result;
  }, [opportunities]);

  const selectedOpportunity = useMemo(
    () =>
      selectedId
        ? opportunities.find(
            (opportunity) =>
              opportunity.id === selectedId,
          ) ?? null
        : null,
    [opportunities, selectedId],
  );

  const selectedTheoreticalOutcome =
    selectedOpportunity
      ? outcomeIndex.get(
          `${selectedOpportunity.id}:theoretical`,
        ) ?? null
      : null;

  const selectedExecutedOutcome =
    selectedOpportunity
      ? outcomeIndex.get(
          `${selectedOpportunity.id}:executed`,
        ) ?? null
      : null;

  const selectedOrders = useMemo(
    () =>
      selectedOpportunity
        ? orders.filter(
            (order) =>
              order.opportunity_id ===
              selectedOpportunity.id,
          )
        : [],
    [orders, selectedOpportunity],
  );

  const selectedEvents = useMemo(
    () =>
      selectedOpportunity
        ? events.filter(
            (event) =>
              event.opportunity_id ===
              selectedOpportunity.id,
          )
        : [],
    [events, selectedOpportunity],
  );

  const selectedDecisions = useMemo(
    () =>
      selectedOpportunity
        ? decisions.filter(
            (decision) =>
              decision.opportunity_id ===
              selectedOpportunity.id,
          )
        : [],
    [decisions, selectedOpportunity],
  );

  const selectedSizingDecisions = useMemo(
    () =>
      selectedOpportunity
        ? sizingDecisions
            .filter(
              (decision) =>
                decision.opportunity_id ===
                selectedOpportunity.id,
            )
            .sort(
              (left, right) =>
                Date.parse(right.created_at) -
                Date.parse(left.created_at),
            )
        : [],
    [selectedOpportunity, sizingDecisions],
  );

  // Autenticação ------------------------------------------------------------

  const sendMagicLink = useCallback(async () => {
    const normalizedEmail = email
      .trim()
      .toLocaleLowerCase('pt-BR');

    setAuthError('');

    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      setAuthError('Informe um email válido.');
      return;
    }

    setAuthBusy(true);

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          emailRedirectTo: magicLinkRedirect(),
        },
      });

      if (error) {
        throw error;
      }

      setEmail(normalizedEmail);
      setMagicSent(true);
    } catch (error) {
      setAuthError(
        friendlyError(
          error,
          'Não foi possível enviar o link de acesso.',
        ),
      );
    } finally {
      setAuthBusy(false);
    }
  }, [email, supabase]);

  const signOut = useCallback(async () => {
    setAuthError('');
    const { error } = await supabase.auth.signOut();

    if (error) {
      setAuthError(error.message);
    }
  }, [supabase]);

  // Abertura e RPCs ---------------------------------------------------------

  const patchLifecycle = useCallback(
    (
      opportunityId: UUID,
      lifecycleStatus: OpportunityLifecycleStatus,
      extras: Partial<TradeOpportunity> = {},
    ) => {
      setOpportunities((current) =>
        current
          .map((opportunity) =>
            opportunity.id === opportunityId
              ? {
                  ...opportunity,
                  ...extras,
                  lifecycle_status: lifecycleStatus,
                  updated_at: new Date().toISOString(),
                }
              : opportunity,
          )
          .sort(compareOpportunitiesForDashboard),
      );
    },
    [],
  );

  const updateFocusInUrl = useCallback(
    (id: UUID | null) => {
      if (typeof window === 'undefined') {
        return;
      }

      const url = new URL(window.location.href);

      if (id) {
        url.searchParams.set('focus', id);
      } else {
        url.searchParams.delete('focus');
      }

      window.history.replaceState(
        null,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
    },
    [],
  );

  const openOpportunity = useCallback(
    async (opportunity: TradeOpportunity) => {
      setSelectedId(opportunity.id);
      setRejectReason('');
      setActionFeedback({
        state: 'idle',
        message: '',
      });
      updateFocusInUrl(opportunity.id);

      const cardState =
        getOpportunityCardState(opportunity);

      try {
        if (cardState.actions.canBeginReview) {
          const { data, error } = await supabase.rpc(
            'begin_opportunity_review',
            {
              p_opportunity_id: opportunity.id,
            },
          );

          if (error) {
            throw error;
          }

          if (typeof data === 'string') {
            patchLifecycle(
              opportunity.id,
              data as OpportunityLifecycleStatus,
              {
                seen_at:
                  opportunity.seen_at ??
                  new Date().toISOString(),
                review_started_at:
                  opportunity.review_started_at ??
                  new Date().toISOString(),
              },
            );
          }
        } else if (cardState.actions.canMarkSeen) {
          const { error } = await supabase.rpc(
            'mark_opportunity_seen',
            {
              p_opportunity_id: opportunity.id,
            },
          );

          if (error) {
            throw error;
          }

          setOpportunities((current) =>
            current.map((item) =>
              item.id === opportunity.id
                ? {
                    ...item,
                    seen_at: new Date().toISOString(),
                  }
                : item,
            ),
          );
        }
      } catch (error) {
        setActionFeedback({
          state: 'error',
          message: friendlyError(
            error,
            'Os detalhes foram abertos, mas o status de leitura não pôde ser atualizado.',
          ),
        });
      }
    },
    [
      patchLifecycle,
      supabase,
      updateFocusInUrl,
    ],
  );

  const closeDetails = useCallback(() => {
    setSelectedId(null);
    setRejectReason('');
    setActionFeedback({
      state: 'idle',
      message: '',
    });
    updateFocusInUrl(null);
  }, [updateFocusInUrl]);

  const acceptOpportunity = useCallback(async () => {
    if (!selectedOpportunity || actionId) {
      return;
    }

    const cardState =
      getOpportunityCardState(selectedOpportunity);

    if (!cardState.actions.canAcceptEntry) {
      setActionFeedback({
        state: 'error',
        message:
          cardState.actions.reason ??
          'Esta entrada não pode mais ser aceita.',
      });
      return;
    }

    setActionId(selectedOpportunity.id);
    setActionFeedback({
      state: 'loading',
      message:
        'Registrando a decisão e enviando para revalidação...',
    });

    try {
      const marketPrice =
        marketSnapshotNumber(
          selectedOpportunity,
          'lastLivePrice',
        ) ??
        marketSnapshotNumber(
          selectedOpportunity,
          'lastClosedPrice',
        );

      const { data, error } = await supabase.rpc(
        'accept_opportunity',
        {
          p_opportunity_id: selectedOpportunity.id,
          p_market_price: marketPrice,
          p_request_id: createRequestId(),
        },
      );

      if (error) {
        throw error;
      }

      const nextStatus =
        typeof data === 'string'
          ? (data as OpportunityLifecycleStatus)
          : 'revalidating';

      patchLifecycle(
        selectedOpportunity.id,
        nextStatus,
        {
          entry_decision: 'accepted',
          accepted_at: new Date().toISOString(),
          seen_at:
            selectedOpportunity.seen_at ??
            new Date().toISOString(),
        },
      );

      setActionFeedback({
        state: 'success',
        message:
          nextStatus === 'revalidating'
            ? 'Entrada aceita. O servidor marcou a oportunidade para revalidação. Nenhuma ordem foi executada por esta página.'
            : `A oportunidade agora está em “${getLifecyclePresentation(nextStatus).label}”.`,
      });

      await load();
    } catch (error) {
      setActionFeedback({
        state: 'error',
        message: friendlyError(
          error,
          'Não foi possível aceitar a oportunidade.',
        ),
      });
    } finally {
      setActionId(null);
    }
  }, [
    actionId,
    load,
    patchLifecycle,
    selectedOpportunity,
    supabase,
  ]);

  const rejectOpportunity = useCallback(async () => {
    if (!selectedOpportunity || actionId) {
      return;
    }

    const cardState =
      getOpportunityCardState(selectedOpportunity);

    if (!cardState.actions.canRejectEntry) {
      setActionFeedback({
        state: 'error',
        message:
          cardState.actions.reason ??
          'Esta entrada não pode mais ser recusada.',
      });
      return;
    }

    setActionId(selectedOpportunity.id);
    setActionFeedback({
      state: 'loading',
      message: 'Registrando a recusa...',
    });

    try {
      const marketPrice =
        marketSnapshotNumber(
          selectedOpportunity,
          'lastLivePrice',
        ) ??
        marketSnapshotNumber(
          selectedOpportunity,
          'lastClosedPrice',
        );

      const { data, error } = await supabase.rpc(
        'reject_opportunity',
        {
          p_opportunity_id: selectedOpportunity.id,
          p_reason: rejectReason.trim() || null,
          p_market_price: marketPrice,
          p_request_id: createRequestId(),
        },
      );

      if (error) {
        throw error;
      }

      const nextStatus =
        typeof data === 'string'
          ? (data as OpportunityLifecycleStatus)
          : 'rejected';

      patchLifecycle(
        selectedOpportunity.id,
        nextStatus,
        {
          entry_decision: 'rejected',
          rejected_at: new Date().toISOString(),
          seen_at:
            selectedOpportunity.seen_at ??
            new Date().toISOString(),
        },
      );

      setActionFeedback({
        state: 'success',
        message:
          'Entrada recusada. O resultado teórico continuará sendo acompanhado para medir a qualidade da decisão.',
      });
      setRejectReason('');

      await load();
    } catch (error) {
      setActionFeedback({
        state: 'error',
        message: friendlyError(
          error,
          'Não foi possível recusar a oportunidade.',
        ),
      });
    } finally {
      setActionId(null);
    }
  }, [
    actionId,
    load,
    patchLifecycle,
    rejectReason,
    selectedOpportunity,
    supabase,
  ]);

  // Edge Functions ----------------------------------------------------------

  const synchronizeSetups = useCallback(async () => {
    if (!session || syncFeedback.state === 'loading') {
      return;
    }

    setSyncFeedback({
      state: 'loading',
      message: 'Procurando novos setups confirmados...',
    });

    try {
      const { data, error } = await supabase.functions.invoke(
        'sincronizar-oportunidades',
        {
          body: {
            limit: 100,
            include_expired: true,
          },
        },
      );

      if (error) {
        throw error;
      }

      const summary = isRecord(data)
        ? data.summary
        : null;

      const created = isRecord(summary)
        ? finiteNumber(summary.created) ?? 0
        : 0;

      const existing = isRecord(summary)
        ? finiteNumber(summary.existing) ?? 0
        : 0;

      setSyncFeedback({
        state: 'success',
        message:
          created > 0
            ? `${created} nova(s) oportunidade(s) criada(s). ${existing} já existia(m).`
            : `Nenhuma oportunidade nova. ${existing} setup(s) já estava(m) sincronizado(s).`,
      });

      await load();
    } catch (error) {
      setSyncFeedback({
        state: 'error',
        message: friendlyError(
          error,
          'Não foi possível sincronizar os setups.',
        ),
      });
    }
  }, [
    load,
    session,
    supabase,
    syncFeedback.state,
  ]);

  const updateTheoreticalResults =
    useCallback(async () => {
      if (
        !session ||
        trackingFeedback.state === 'loading'
      ) {
        return;
      }

      setTrackingFeedback({
        state: 'loading',
        message:
          'Consultando candles encerrados e atualizando resultados...',
      });

      try {
        const { data, error } =
          await supabase.functions.invoke(
            'acompanhar-resultados-teoricos',
            {
              body: {
                limit: 50,
                max_candles_per_outcome: 1_000,
              },
            },
          );

        if (error) {
          throw error;
        }

        const summary = isRecord(data)
          ? data.summary
          : null;

        const processed = isRecord(summary)
          ? finiteNumber(summary.processed) ?? 0
          : 0;
        const targetHit = isRecord(summary)
          ? finiteNumber(summary.target_hit) ?? 0
          : 0;
        const stopHit = isRecord(summary)
          ? finiteNumber(summary.stop_hit) ?? 0
          : 0;
        const horizonExit = isRecord(summary)
          ? finiteNumber(summary.horizon_exit) ?? 0
          : 0;

        setTrackingFeedback({
          state: 'success',
          message: `${processed} resultado(s) verificado(s): ${targetHit} alvo(s), ${stopHit} stop(s) e ${horizonExit} encerramento(s) por horizonte.`,
        });

        await load();
      } catch (error) {
        setTrackingFeedback({
          state: 'error',
          message: friendlyError(
            error,
            'Não foi possível atualizar os resultados teóricos.',
          ),
        });
      }
    }, [
      load,
      session,
      supabase,
      trackingFeedback.state,
    ]);

  // Renderizadores ----------------------------------------------------------

  const renderOpportunityGrid = (
    rows: readonly TradeOpportunity[],
    emptyTitle: string,
    emptyDescription: string,
  ) => {
    if (rows.length === 0) {
      return (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
        />
      );
    }

    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 310px), 1fr))',
          gap: 10,
        }}
      >
        {rows.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            theoreticalOutcome={
              outcomeIndex.get(
                `${opportunity.id}:theoretical`,
              ) ?? null
            }
            executedOutcome={
              outcomeIndex.get(
                `${opportunity.id}:executed`,
              ) ?? null
            }
            sizingDecision={
              latestSizingDecisionByOpportunity.get(
                opportunity.id,
              ) ?? null
            }
            onOpen={openOpportunity}
          />
        ))}
      </div>
    );
  };

  const activeRows =
    activeTab === 'pending'
      ? sectioned.pending
      : activeTab === 'positions'
        ? sectioned.positions
        : activeTab === 'exits'
          ? sectioned.exits
          : activeTab === 'history'
            ? sectioned.history
            : [];

  const realtimePresentation =
    realtimeState === 'live'
      ? {
          label: '● AO VIVO',
          color: S.green,
          detail: 'Atualizações do Supabase Realtime',
        }
      : realtimeState === 'connecting'
        ? {
            label: 'CONECTANDO',
            color: S.a,
            detail: 'Abrindo canal em tempo real',
          }
        : realtimeState === 'error'
          ? {
              label: 'REALTIME COM ERRO',
              color: S.red,
              detail:
                'Use Atualizar enquanto o canal reconecta',
            }
          : {
              label: 'OFFLINE',
              color: S.dim,
              detail: 'Canal em tempo real desconectado',
            };

  // Render ------------------------------------------------------------------

  return (
    <main
      style={{
        minHeight: '100vh',
        background: S.bg,
        color: S.text,
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <header
        style={{
          borderBottom: `1px solid ${S.border}`,
          background: S.panel,
          padding: '12px 20px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
          }}
        >
          <a
            href="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              textDecoration: 'none',
              color: S.text,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt="VigIA Trade"
              style={{
                height: 32,
                width: 'auto',
                display: 'block',
              }}
            />
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 750,
                  lineHeight: 1.1,
                }}
              >
                Central de Oportunidades
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: S.dim,
                }}
              >
                setups identificados · decisão sua · acompanhamento auditável
              </div>
            </div>
          </a>
        </div>

        <nav
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 18,
            marginTop: 8,
            fontSize: 13,
          }}
        >
          <a
            href="/"
            style={{
              color: S.dim,
              textDecoration: 'none',
            }}
          >
            Análise
          </a>
          <a
            href="/daytrade"
            style={{
              color: S.dim,
              textDecoration: 'none',
            }}
          >
            Day Trade
          </a>
          <span
            style={{
              color: S.a,
              fontWeight: 700,
            }}
          >
            Oportunidades
          </span>
          <a
            href="/alertas"
            style={{
              color: S.dim,
              textDecoration: 'none',
            }}
          >
            Alertas
          </a>
          <a
            href="/conta"
            style={{
              color: S.dim,
              textDecoration: 'none',
            }}
          >
            Conta Binance
          </a>
          {session && (
            <button
              type="button"
              onClick={signOut}
              style={{
                background: 'transparent',
                border: 'none',
                color: S.red,
                fontSize: 13,
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
              }}
            >
              Sair
            </button>
          )}
        </nav>
      </header>

      <div
        style={{
          maxWidth: 1180,
          margin: '0 auto',
          padding: '22px 16px 42px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {!authReady ? (
          <Card
            style={{
              minHeight: 160,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div
              style={{
                color: S.dim,
                fontSize: 13,
              }}
            >
              Verificando sua sessão...
            </div>
          </Card>
        ) : !session ? (
          <Card
            style={{
              maxWidth: 620,
              width: '100%',
              alignSelf: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
              textAlign: 'center',
              padding: '24px 18px',
            }}
          >
            <div
              style={{
                color: S.textStrong,
                fontSize: 17,
                fontWeight: 800,
              }}
            >
              Entre para acessar suas oportunidades
            </div>
            <div
              style={{
                color: S.dim,
                fontSize: 12,
                lineHeight: 1.55,
                maxWidth: 480,
              }}
            >
              Enviaremos um link de acesso para o seu email. A
              página mostra somente os seus registros protegidos
              por RLS e continua recebendo atualizações em tempo
              real enquanto estiver aberta.
            </div>

            {magicSent ? (
              <>
                <div
                  style={{
                    color: S.green,
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  Link enviado para <strong>{email}</strong>.
                  Abra o email e toque no link para continuar.
                </div>
                <button
                  type="button"
                  onClick={() => setMagicSent(false)}
                  disabled={authBusy}
                  style={{
                    ...subtleButtonStyle,
                    color: S.a,
                    borderColor: `${S.a}88`,
                  }}
                >
                  Enviar novamente
                </button>
              </>
            ) : (
              <>
                <div
                  style={{
                    width: 'min(100%, 320px)',
                  }}
                >
                  <input
                    type="email"
                    value={email}
                    placeholder="seu@email.com"
                    autoComplete="email"
                    disabled={authBusy}
                    onChange={(event) =>
                      setEmail(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !authBusy
                      ) {
                        void sendMagicLink();
                      }
                    }}
                    style={inputStyle}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void sendMagicLink()}
                  disabled={authBusy}
                  style={{
                    ...primaryButtonStyle,
                    opacity: authBusy ? 0.6 : 1,
                  }}
                >
                  {authBusy
                    ? 'Enviando...'
                    : 'Enviar link de acesso'}
                </button>
              </>
            )}

            {authError && (
              <div
                style={{
                  color: S.red,
                  fontSize: 12,
                }}
              >
                {authError}
              </div>
            )}
          </Card>
        ) : (
          <>
            <Card
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div
                  style={{
                    color: S.textStrong,
                    fontSize: 15,
                    fontWeight: 800,
                  }}
                >
                  Suas oportunidades monitoradas
                </div>
                <div
                  style={{
                    color: S.dim,
                    fontSize: 11,
                    marginTop: 4,
                    lineHeight: 1.45,
                  }}
                >
                  O VigIA identifica e acompanha cenários. Você
                  revisa cada entrada antes de qualquer etapa de
                  execução.
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  title={realtimePresentation.detail}
                  style={{
                    color: realtimePresentation.color,
                    fontSize: 10,
                    fontWeight: 850,
                    letterSpacing: 0.4,
                  }}
                >
                  {realtimePresentation.label}
                </span>

                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loadState === 'loading'}
                  style={{
                    ...subtleButtonStyle,
                    opacity:
                      loadState === 'loading' ? 0.6 : 1,
                  }}
                >
                  {loadState === 'loading'
                    ? 'Atualizando...'
                    : 'Atualizar'}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    void synchronizeSetups()
                  }
                  disabled={
                    syncFeedback.state === 'loading'
                  }
                  style={{
                    ...subtleButtonStyle,
                    color: S.blue,
                    borderColor: `${S.blue}77`,
                    opacity:
                      syncFeedback.state === 'loading'
                        ? 0.6
                        : 1,
                  }}
                >
                  {syncFeedback.state === 'loading'
                    ? 'Sincronizando...'
                    : 'Sincronizar setups'}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    void updateTheoreticalResults()
                  }
                  disabled={
                    trackingFeedback.state === 'loading'
                  }
                  style={{
                    ...subtleButtonStyle,
                    color: S.green,
                    borderColor: `${S.green}77`,
                    opacity:
                      trackingFeedback.state === 'loading'
                        ? 0.6
                        : 1,
                  }}
                >
                  {trackingFeedback.state === 'loading'
                    ? 'Calculando...'
                    : 'Atualizar resultados'}
                </button>
              </div>
            </Card>

            {loadError && (
              <Card
                style={{
                  borderColor: `${S.red}88`,
                  background: `${S.red}08`,
                }}
              >
                <div
                  style={{
                    color: S.red,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  {loadError}
                </div>
              </Card>
            )}

            {syncFeedback.message && (
              <Card
                style={{
                  padding: '10px 13px',
                  borderColor:
                    syncFeedback.state === 'error'
                      ? `${S.red}88`
                      : `${S.blue}66`,
                }}
              >
                <div
                  style={{
                    color:
                      syncFeedback.state === 'error'
                        ? S.red
                        : S.blue,
                    fontSize: 11,
                  }}
                >
                  {syncFeedback.message}
                </div>
              </Card>
            )}

            {trackingFeedback.message && (
              <Card
                style={{
                  padding: '10px 13px',
                  borderColor:
                    trackingFeedback.state === 'error'
                      ? `${S.red}88`
                      : `${S.green}66`,
                }}
              >
                <div
                  style={{
                    color:
                      trackingFeedback.state === 'error'
                        ? S.red
                        : S.green,
                    fontSize: 11,
                  }}
                >
                  {trackingFeedback.message}
                </div>
              </Card>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'repeat(auto-fit, minmax(130px, 1fr))',
                gap: 8,
              }}
            >
              <MetricCard
                label="Novas"
                value={String(metrics.unreadOpportunities)}
                detail="Ainda não visualizadas"
                tone={
                  metrics.unreadOpportunities > 0
                    ? 'warning'
                    : 'muted'
                }
              />
              <MetricCard
                label="Pendentes"
                value={String(metrics.pendingOpportunities)}
                detail="Análise ou revalidação"
                tone="info"
              />
              <MetricCard
                label="Posições"
                value={String(metrics.openPositions)}
                detail="Abrindo ou abertas"
                tone="positive"
              />
              <MetricCard
                label="Saídas"
                value={String(metrics.pendingExits)}
                detail="Aguardando tratamento"
                tone={
                  metrics.pendingExits > 0
                    ? 'danger'
                    : 'muted'
                }
              />
              <MetricCard
                label="Atenção"
                value={String(metrics.attentionRequired)}
                detail="Erros ou prioridade crítica"
                tone={
                  metrics.attentionRequired > 0
                    ? 'critical'
                    : 'muted'
                }
              />
              <MetricCard
                label="Teórico"
                value={fmtR(metrics.theoreticalResultR)}
                detail={`${metrics.theoreticalWins} ganhos · ${metrics.theoreticalLosses} perdas`}
                tone={
                  metrics.theoreticalResultR > 0
                    ? 'positive'
                    : metrics.theoreticalResultR < 0
                      ? 'danger'
                      : 'neutral'
                }
              />
            </div>

            {sectioned.attention.length > 0 && (
              <Card
                style={{
                  borderColor: `${S.red}88`,
                  background: `${S.red}06`,
                }}
              >
                <SectionTitle
                  title="Requer atenção"
                  subtitle="Falhas, estados críticos ou situações que não devem ficar escondidas no histórico."
                />
                {renderOpportunityGrid(
                  sectioned.attention,
                  'Nenhum alerta crítico',
                  'As situações críticas aparecerão aqui.',
                )}
              </Card>
            )}

            <Card style={{ padding: 8 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(5, minmax(120px, 1fr))',
                  gap: 5,
                  overflowX: 'auto',
                }}
              >
                {(
                  Object.keys(
                    TAB_LABELS,
                  ) as MainTab[]
                ).map((tab) => {
                  const count =
                    tab === 'pending'
                      ? sectioned.pending.length
                      : tab === 'positions'
                        ? sectioned.positions.length
                        : tab === 'exits'
                          ? sectioned.exits.length
                          : tab === 'history'
                            ? sectioned.history.length
                            : metrics.resolvedOpportunities;

                  const active = activeTab === tab;

                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      style={{
                        minWidth: 118,
                        background: active
                          ? `${S.a}18`
                          : 'transparent',
                        color: active ? S.a : S.dimStrong,
                        border: `1px solid ${
                          active
                            ? `${S.a}88`
                            : 'transparent'
                        }`,
                        borderRadius: 8,
                        padding: '9px 10px',
                        fontSize: 11,
                        fontWeight: active ? 800 : 650,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {TAB_LABELS[tab]}
                      {' · '}
                      {count}
                    </button>
                  );
                })}
              </div>
            </Card>

            {selectedOpportunity && (
              <Card
                style={{
                  borderColor: `${S.a}77`,
                  background: S.panelRaised,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                    marginBottom: 14,
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        flexWrap: 'wrap',
                      }}
                    >
                      <h2
                        style={{
                          color: S.textStrong,
                          fontSize: 20,
                          margin: 0,
                        }}
                      >
                        {selectedOpportunity.symbol}
                        {' · '}
                        {fmtTimeframe(
                          selectedOpportunity.timeframe,
                        )}
                      </h2>
                      <Pill
                        tone={
                          getOpportunityCardState(
                            selectedOpportunity,
                          ).tone
                        }
                      >
                        {
                          getLifecyclePresentation(
                            getOpportunityCardState(
                              selectedOpportunity,
                            ).effectiveStatus,
                          ).label
                        }
                      </Pill>
                      <Pill tone="neutral">
                        {displayStrategy(
                          selectedOpportunity.strategy,
                        )}
                        {' v'}
                        {
                          selectedOpportunity.strategy_version
                        }
                      </Pill>
                    </div>

                    <div
                      style={{
                        color: S.dim,
                        fontSize: 11,
                        marginTop: 6,
                        lineHeight: 1.45,
                      }}
                    >
                      Detectada em{' '}
                      {fmtDate(
                        selectedOpportunity.detected_at,
                        true,
                      )}
                      {' · '}
                      {getOpportunitySourceLabel(
                        selectedOpportunity.source_type,
                      )}
                      {' · '}
                      {getExecutionEnvironmentLabel(
                        selectedOpportunity.execution_environment,
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={closeDetails}
                    style={subtleButtonStyle}
                  >
                    Fechar detalhes
                  </button>
                </div>

                <PlanGrid
                  opportunity={selectedOpportunity}
                />

                <div style={{ marginTop: 14 }}>
                  <SectionTitle
                    title="Gerenciamento da posição"
                    subtitle="Valor calculado pelo servidor com base no saldo, stop, custos, sequência de resultados e limites configurados."
                  />

                  <PositionSizingPanel
                    decisions={selectedSizingDecisions}
                  />
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fit, minmax(min(100%, 310px), 1fr))',
                    gap: 12,
                    marginTop: 14,
                  }}
                >
                  <div>
                    <SectionTitle
                      title="Checklist preservado"
                      subtitle={`${selectedOpportunity.score ?? 0} de ${selectedOpportunity.total_conditions ?? 0} condições atendidas.`}
                    />
                    <ConditionsList
                      opportunity={selectedOpportunity}
                    />
                  </div>

                  <div>
                    <SectionTitle
                      title="Resultados"
                      subtitle="A qualidade teórica permanece separada da execução real."
                    />
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <OutcomePanel
                        outcome={
                          selectedTheoreticalOutcome
                        }
                      />
                      <OutcomePanel
                        outcome={selectedExecutedOutcome}
                      />
                    </div>
                  </div>
                </div>

                {normalizeWarnings(
                  selectedOpportunity.warnings,
                ).length > 0 && (
                  <div
                    style={{
                      marginTop: 14,
                      border: `1px solid ${S.a}55`,
                      background: `${S.a}08`,
                      borderRadius: 9,
                      padding: 12,
                    }}
                  >
                    <div
                      style={{
                        color: S.a,
                        fontSize: 11,
                        fontWeight: 800,
                      }}
                    >
                      Avisos do setup
                    </div>
                    <ul
                      style={{
                        color: S.dimStrong,
                        fontSize: 11,
                        lineHeight: 1.5,
                        margin: '7px 0 0',
                        paddingLeft: 18,
                      }}
                    >
                      {normalizeWarnings(
                        selectedOpportunity.warnings,
                      ).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
                    gap: 12,
                    marginTop: 14,
                  }}
                >
                  <div>
                    <SectionTitle
                      title="Ordens vinculadas"
                      subtitle="Status confirmado pelo monitor da Binance."
                    />
                    <OrdersPanel orders={selectedOrders} />
                  </div>

                  <div>
                    <SectionTitle
                      title="Linha do tempo"
                      subtitle={[
                        `${selectedEvents.length} evento(s)`,
                        `${selectedDecisions.length} decisão(ões) do usuário`,
                        `${selectedSizingDecisions.length} cálculo(s) de risco`,
                      ].join(' · ')}
                    />
                    <Timeline events={selectedEvents} />
                  </div>
                </div>

                {selectedOpportunity.opportunity_type ===
                  'entry' && (
                  <div
                    style={{
                      marginTop: 16,
                      borderTop: `1px solid ${S.border}`,
                      paddingTop: 14,
                    }}
                  >
                    <SectionTitle
                      title="Sua decisão"
                      subtitle="Abrir o card foi o primeiro passo. Aceitar abaixo apenas registra a decisão e solicita revalidação ao servidor."
                    />

                    {getOpportunityCardState(
                      selectedOpportunity,
                    ).actions.canAcceptEntry ? (
                      <>
                        <label
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 5,
                            color: S.dim,
                            fontSize: 10,
                            marginBottom: 10,
                          }}
                        >
                          Motivo da recusa, opcional
                          <textarea
                            value={rejectReason}
                            maxLength={1_000}
                            placeholder="Ex.: já estou exposto ao ativo, horário inadequado ou risco acima do que desejo."
                            onChange={(event) =>
                              setRejectReason(
                                event.target.value,
                              )
                            }
                            style={{
                              ...inputStyle,
                              minHeight: 72,
                              resize: 'vertical',
                              textAlign: 'left',
                            }}
                          />
                        </label>

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              void acceptOpportunity()
                            }
                            disabled={
                              actionId ===
                              selectedOpportunity.id
                            }
                            style={{
                              ...primaryButtonStyle,
                              opacity:
                                actionId ===
                                selectedOpportunity.id
                                  ? 0.6
                                  : 1,
                            }}
                          >
                            {actionId ===
                            selectedOpportunity.id
                              ? 'Processando...'
                              : 'Aceitar e revalidar'}
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              void rejectOpportunity()
                            }
                            disabled={
                              actionId ===
                              selectedOpportunity.id
                            }
                            style={{
                              ...dangerButtonStyle,
                              opacity:
                                actionId ===
                                selectedOpportunity.id
                                  ? 0.6
                                  : 1,
                            }}
                          >
                            Recusar entrada
                          </button>
                        </div>
                      </>
                    ) : (
                      <div
                        style={{
                          border: `1px solid ${S.border}`,
                          background: S.bg,
                          borderRadius: 9,
                          padding: 12,
                        }}
                      >
                        <div
                          style={{
                            color: S.text,
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          {
                            getEntryDecisionPresentation(
                              selectedOpportunity.entry_decision,
                            ).label
                          }
                        </div>
                        <div
                          style={{
                            color: S.dim,
                            fontSize: 10,
                            marginTop: 4,
                            lineHeight: 1.45,
                          }}
                        >
                          {getOpportunityCardState(
                            selectedOpportunity,
                          ).actions.reason ??
                            getLifecyclePresentation(
                              getOpportunityCardState(
                                selectedOpportunity,
                              ).effectiveStatus,
                            ).description}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedOpportunity.opportunity_type ===
                  'exit' && (
                  <div
                    style={{
                      marginTop: 16,
                      borderTop: `1px solid ${S.border}`,
                      paddingTop: 14,
                    }}
                  >
                    <SectionTitle
                      title="Tratamento da saída"
                      subtitle="A saída segura exige consultar a Binance, cancelar a OCO, confirmar o cancelamento e vender somente o saldo remanescente."
                    />
                    <div
                      style={{
                        color: S.a,
                        fontSize: 11,
                        lineHeight: 1.5,
                        border: `1px solid ${S.a}55`,
                        background: `${S.a}08`,
                        borderRadius: 9,
                        padding: 12,
                      }}
                    >
                      Os botões de saída permanecem bloqueados nesta
                      etapa. Eles serão liberados somente quando o
                      motor transacional idempotente estiver
                      conectado.
                    </div>
                  </div>
                )}

                {actionFeedback.message && (
                  <div
                    style={{
                      marginTop: 12,
                      color:
                        actionFeedback.state === 'error'
                          ? S.red
                          : actionFeedback.state ===
                              'success'
                            ? S.green
                            : S.a,
                      fontSize: 11,
                      lineHeight: 1.45,
                    }}
                  >
                    {actionFeedback.message}
                  </div>
                )}
              </Card>
            )}

            {loadState === 'loading' &&
            opportunities.length === 0 ? (
              <Card
                style={{
                  minHeight: 180,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <div
                  style={{
                    color: S.dim,
                    fontSize: 13,
                  }}
                >
                  Carregando oportunidades...
                </div>
              </Card>
            ) : activeTab === 'performance' ? (
              <>
                <Card
                  style={{
                    borderColor:
                      metrics.resolvedOpportunities < 30
                        ? `${S.a}66`
                        : S.border,
                  }}
                >
                  <SectionTitle
                    title="Amostra e decisões"
                    subtitle="A estratégia deve ser avaliada por versão, sem misturar resultados de regras diferentes."
                  />

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fit, minmax(135px, 1fr))',
                      gap: 8,
                    }}
                  >
                    <MetricCard
                      label="Oportunidades"
                      value={String(
                        metrics.totalOpportunities,
                      )}
                      detail={`${metrics.resolvedOpportunities} com resultado final`}
                      tone="info"
                    />
                    <MetricCard
                      label="Aceitação"
                      value={
                        metrics.acceptanceRatePct === null
                          ? '—'
                          : `${fmtNumber(
                              metrics.acceptanceRatePct,
                              1,
                            )}%`
                      }
                      detail={`${metrics.acceptedEntries} aceitas · ${metrics.rejectedEntries} recusadas`}
                      tone="warning"
                    />
                    <MetricCard
                      label="Perdas evitadas"
                      value={String(metrics.avoidedLosses)}
                      detail="Recusadas que atingiram o stop teórico"
                      tone="positive"
                    />
                    <MetricCard
                      label="Ganhos perdidos"
                      value={String(metrics.missedWins)}
                      detail="Recusadas que atingiram o alvo teórico"
                      tone="warning"
                    />
                    <MetricCard
                      label="PnL executado"
                      value={`${fmtNumber(
                        metrics.executedNetPnlUsdt,
                        4,
                      )} USDT`}
                      detail="Somente ordens realmente executadas"
                      tone={
                        metrics.executedNetPnlUsdt > 0
                          ? 'positive'
                          : metrics.executedNetPnlUsdt < 0
                            ? 'danger'
                            : 'neutral'
                      }
                    />
                  </div>

                  {metrics.resolvedOpportunities < 30 && (
                    <div
                      style={{
                        color: S.a,
                        fontSize: 11,
                        lineHeight: 1.5,
                        marginTop: 12,
                      }}
                    >
                      A amostra ainda é pequena. Evite conclusões
                      amplas antes de aproximadamente 30 a 50
                      oportunidades encerradas da mesma estratégia e
                      versão.
                    </div>
                  )}
                </Card>

                <PerformanceModeSection
                  title="Qualidade teórica dos setups"
                  subtitle="Inclui oportunidades aceitas, recusadas, ignoradas ou expiradas que tiveram um plano válido."
                  metrics={metrics.theoretical}
                />

                <PerformanceModeSection
                  title="Qualidade da execução"
                  subtitle="Considera somente operações realmente executadas, incluindo taxas, slippage e saídas antecipadas."
                  metrics={metrics.executed}
                />

                <BreakdownTable
                  title="Desempenho por ativo"
                  rows={symbolBreakdown}
                />

                <BreakdownTable
                  title="Desempenho por versão"
                  rows={versionBreakdown}
                />
              </>
            ) : (
              <Card>
                <SectionTitle
                  title={TAB_LABELS[activeTab]}
                  subtitle={
                    activeTab === 'pending'
                      ? 'Oportunidades válidas que aguardam revisão, decisão ou revalidação.'
                      : activeTab === 'positions'
                        ? 'Entradas em processamento e posições abertas.'
                        : activeTab === 'exits'
                          ? 'Sinais de saída que precisam de tratamento seguro.'
                          : 'Oportunidades encerradas, recusadas, invalidadas ou expiradas.'
                  }
                />

                {renderOpportunityGrid(
                  activeRows,
                  activeTab === 'pending'
                    ? 'Nenhuma oportunidade pendente'
                    : activeTab === 'positions'
                      ? 'Nenhuma posição em andamento'
                      : activeTab === 'exits'
                        ? 'Nenhuma saída pendente'
                        : 'Histórico vazio',
                  activeTab === 'pending'
                    ? 'Use “Sincronizar setups” depois de salvar um setup com condições atendidas no Day Trade.'
                    : activeTab === 'positions'
                      ? 'As posições aparecerão aqui quando uma oportunidade avançar para abertura ou acompanhamento.'
                      : activeTab === 'exits'
                        ? 'As recomendações de saída aparecerão aqui quando o motor seguro estiver conectado.'
                        : 'As oportunidades concluídas aparecerão conforme o acompanhamento resolver os cenários.',
                )}
              </Card>
            )}

            <div
              style={{
                color: S.dim,
                fontSize: 10,
                lineHeight: 1.5,
                textAlign: 'center',
                maxWidth: 820,
                margin: '4px auto 0',
              }}
            >
              A Central de Oportunidades organiza cenários
              determinísticos e resultados auditáveis. Ela não
              promete lucro e não substitui sua decisão, sua gestão
              de risco nem a conferência da conta Binance.
            </div>
          </>
        )}
      </div>
    </main>
  );
}
