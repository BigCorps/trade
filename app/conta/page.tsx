'use client';

/**
 * app/conta/page.tsx — VigIA Trade v3
 * ----------------------------------------------------------------------------
 * Correções de segurança e compatibilidade com binance-trade v7:
 * - Status da chave lido por RPC mascarada, sem consultar exchange_keys.
 * - Limites de risco carregados e editados em user_settings.
 * - Operações reais permanecem bloqueadas até ativação explícita.
 * - Toda ordem recebe request_id idempotente, reutilizado em falhas de rede.
 * - HTTP 409 diferencia limite operacional de compra executada sem proteção.
 * - Novos estados de execução/proteção aparecem no histórico.
 * - Ordens vinculadas à Central exibem a oportunidade correspondente.
 * - Compatibilidade preservada antes e depois da migration de oportunidades.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  type Session,
} from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabaseClient';
import { isSafeUuid } from '../../lib/auth/safeRedirect';

const S = {
  bg: '#101418', panel: '#181f26', border: '#2a343f',
  text: '#d7dee6', dim: '#7d8a97',
  a: '#e8a13c', blue: '#4f8fd0', green: '#3fb26f', red: '#d05555',
};

const inputStyle: CSSProperties = {
  background: S.bg,
  border: `1px solid ${S.border}`,
  borderRadius: 6,
  color: S.text,
  padding: '8px 10px',
  fontSize: 14,
  textAlign: 'center',
};

const fmt = (n: number, d = 2) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtData = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

// Garante que a máscara da chave nunca estoure o card, qualquer que seja o
// formato devolvido pelo backend. Mostra no máximo os primeiros 4 e os
// últimos 4 caracteres visíveis, sempre com largura previsível.
function shortMask(value: string | null): string {
  if (!value) return '••••';

  // Se o backend já mandou pontos de máscara, reduz a uma forma curta fixa.
  const visible = value.replace(/[•*]/g, '').trim();

  if (visible.length === 0) return '••••';
  if (visible.length <= 8) return `${visible}`;

  return `${visible.slice(0, 4)}…${visible.slice(-4)}`;
}

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pendente: { label: 'pendente', color: S.dim },
  entrada_enviada: { label: 'entrada enviada', color: S.a },
  entrada_executada: { label: 'entrada feita', color: S.a },
  protecao_pendente: { label: 'criando proteção', color: S.a },
  entrada_sem_protecao: { label: 'SEM PROTEÇÃO ⚠️', color: S.red },
  oco_ativa: { label: 'OCO ativa', color: S.blue },
  alvo_executado: { label: 'alvo ✅', color: S.green },
  stop_executado: { label: 'stop 🛑', color: S.red },
  cancelada: { label: 'cancelada', color: S.dim },
  erro_pre_entrada: { label: 'falhou antes da compra', color: S.red },
  erro: { label: 'erro', color: S.red },
};

const OPEN_STATUSES = new Set([
  'pendente',
  'entrada_enviada',
  'entrada_executada',
  'protecao_pendente',
  'entrada_sem_protecao',
  'oco_ativa',
]);

const ORDER_SELECT_BASE =
  'id, symbol, status, is_testnet, quote_amount, qty, entry_price, exit_price, stop_price, target_price, pnl_usdt, erro, criado_em, request_id, protected_at, last_checked_at, binance_status, unprotected_reason';

const ORDER_SELECT_WITH_OPPORTUNITY =
  'id, symbol, status, is_testnet, quote_amount, qty, entry_price, exit_price, stop_price, target_price, pnl_usdt, erro, criado_em, request_id, protected_at, last_checked_at, binance_status, unprotected_reason, opportunity_id';

const OPPORTUNITY_STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending: { label: 'pendente', color: S.a },
  under_review: { label: 'em revisão', color: S.a },
  revalidating: { label: 'revalidando', color: S.a },
  invalidated: { label: 'invalidada', color: S.dim },
  expired: { label: 'expirada', color: S.dim },
  rejected: { label: 'recusada', color: S.dim },
  opening: { label: 'abrindo posição', color: S.a },
  open: { label: 'posição aberta', color: S.blue },
  exit_pending: { label: 'saída pendente', color: S.a },
  closing: { label: 'encerrando', color: S.a },
  closed: { label: 'encerrada', color: S.green },
  error: { label: 'erro', color: S.red },
};

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      style={{
        background: S.panel,
        border: `1px solid ${S.border}`,
        borderRadius: 10,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

interface ChipOption {
  value: string;
  label: string;
}

function MultiChipSelect({
  label,
  options,
  selected,
  disabled,
  onChange,
  emptyHint,
}: {
  label: string;
  options: readonly ChipOption[];
  selected: string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
  emptyHint?: string;
}) {
  const selectedSet = new Set(selected);
  const allSelected = options.length > 0 && options.every((option) => selectedSet.has(option.value));

  const toggle = (value: string) => {
    if (disabled) return;
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value));
  };

  const toggleAll = () => {
    if (disabled) return;
    onChange(allSelected ? [] : options.map((option) => option.value));
  };

  return (
    <div style={{ width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12, color: S.dim }}>{label}</span>
        <button
          type="button"
          onClick={toggleAll}
          disabled={disabled}
          style={{
            background: 'transparent',
            color: allSelected ? S.dim : S.a,
            border: `1px solid ${allSelected ? S.border : `${S.a}66`}`,
            borderRadius: 999,
            padding: '2px 10px',
            fontSize: 11,
            fontWeight: 700,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          {allSelected ? 'Limpar' : 'Selecionar todos'}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {options.map((option) => {
          const active = selectedSet.has(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              disabled={disabled}
              style={{
                background: active ? `${S.a}22` : 'transparent',
                color: active ? S.a : S.dim,
                border: `1px solid ${active ? `${S.a}88` : S.border}`,
                borderRadius: 8,
                padding: '7px 12px',
                fontSize: 13,
                fontWeight: active ? 700 : 400,
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.6 : 1,
              }}
            >
              {active ? '✓ ' : ''}{option.label}
            </button>
          );
        })}
      </div>

      {selected.length === 0 && emptyHint && (
        <span style={{ fontSize: 11, color: S.dim, textAlign: 'center' }}>{emptyHint}</span>
      )}
    </div>
  );
}

interface KeyInfo {
  configured: boolean;
  api_key_masked: string | null;
  is_testnet: boolean;
  atualizado_em: string | null;
}

interface Balance {
  asset: string;
  free: string;
  locked: string;
}

interface OrderRow {
  id: string;
  symbol: string;
  status: string;
  is_testnet: boolean;
  quote_amount: number;
  qty: number | null;
  entry_price: number | null;
  exit_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  pnl_usdt: number | null;
  erro: string | null;
  criado_em: string;
  request_id: string | null;
  protected_at: string | null;
  last_checked_at: string | null;
  binance_status: string | null;
  unprotected_reason: string | null;
  opportunity_id: string | null;
}

interface OpportunitySummary {
  id: string;
  symbol: string;
  timeframe: string;
  lifecycle_status: string;
  strategy: string;
  strategy_version: string;
  entry_decision: string;
  execution_environment: string;
  detected_at: string;
  closed_at: string | null;
}

interface RiskSettings {
  trading_real_enabled: boolean;
  max_order_usdt: number;
  max_open_orders: number;
  max_daily_loss_usdt: number;
  min_stop_pct: number;
  max_stop_pct: number;
  min_target_pct: number;
  max_target_pct: number;
}

interface RiskForm {
  trading_real_enabled: boolean;
  max_order_usdt: string;
  max_open_orders: string;
  max_daily_loss_usdt: string;
  min_stop_pct: string;
  max_stop_pct: string;
  min_target_pct: string;
  max_target_pct: string;
}

interface AutoTradeSettings {
  auto_trade_enabled: boolean;
  auto_trade_environment: 'testnet' | 'real';
  auto_trade_quote_amount: number;
  auto_trade_symbols: string[];
  auto_trade_timeframes: string[];
  auto_trade_strategies: string[];
  auto_trade_min_score_pct: number;
  auto_trade_min_risk_reward: number;
  auto_trade_require_no_warnings: boolean;
  auto_trade_max_orders_per_day: number;
  auto_trade_cooldown_minutes: number;
  auto_trade_max_attempts: number;
  auto_trade_paused_at: string | null;
  auto_trade_pause_reason: string | null;
  auto_trade_last_run_at: string | null;
  auto_trade_last_success_at: string | null;
  auto_trade_last_error: string | null;
}

interface AutoTradeForm {
  auto_trade_enabled: boolean;
  auto_trade_environment: 'testnet' | 'real';
  auto_trade_quote_amount: string;
  auto_trade_symbols: string[];
  auto_trade_timeframes: string[];
  auto_trade_strategies: string[];
  auto_trade_min_score_pct: string;
  auto_trade_min_risk_reward: string;
  auto_trade_require_no_warnings: boolean;
  auto_trade_max_orders_per_day: string;
  auto_trade_cooldown_minutes: string;
  auto_trade_max_attempts: string;
}

const AUTO_TRADE_TIMEFRAMES = new Set(['5m', '15m', '30m', '1h']);

const AUTO_TRADE_SYMBOL_OPTIONS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'LINKUSDT',
] as const;

const AUTO_TRADE_TIMEFRAME_OPTIONS = ['5m', '15m', '30m', '1h'] as const;

const AUTO_TRADE_STRATEGY_OPTIONS = [
  { value: 'trend_breakout', label: 'Tendência com Rompimento' },
] as const;

const AUTO_TRADE_SYMBOL_SET = new Set<string>(AUTO_TRADE_SYMBOL_OPTIONS);
const AUTO_TRADE_STRATEGY_SET = new Set<string>(
  AUTO_TRADE_STRATEGY_OPTIONS.map((strategy) => strategy.value),
);

// Mantém apenas os itens reconhecidos e preserva a ordem das opções.
function keepKnown(values: string[], allowed: readonly string[]): string[] {
  const chosen = new Set(values);
  return allowed.filter((option) => chosen.has(option));
}

const DEFAULT_AUTO_TRADE: AutoTradeSettings = {
  auto_trade_enabled: false,
  auto_trade_environment: 'testnet',
  auto_trade_quote_amount: 25,
  auto_trade_symbols: [],
  auto_trade_timeframes: [],
  auto_trade_strategies: ['trend_breakout'],
  auto_trade_min_score_pct: 100,
  auto_trade_min_risk_reward: 2,
  auto_trade_require_no_warnings: false,
  auto_trade_max_orders_per_day: 3,
  auto_trade_cooldown_minutes: 60,
  auto_trade_max_attempts: 3,
  auto_trade_paused_at: null,
  auto_trade_pause_reason: null,
  auto_trade_last_run_at: null,
  auto_trade_last_success_at: null,
  auto_trade_last_error: null,
};

function normalizeTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

function normalizeAutoTradeSettings(value: unknown): AutoTradeSettings {
  const row = recordValue(value);
  const environment = row.auto_trade_environment === 'real' ? 'real' : 'testnet';

  return {
    auto_trade_enabled: row.auto_trade_enabled === true,
    auto_trade_environment: environment,
    auto_trade_quote_amount:
      numberValue(row.auto_trade_quote_amount) ?? DEFAULT_AUTO_TRADE.auto_trade_quote_amount,
    auto_trade_symbols: keepKnown(
      normalizeTextArray(row.auto_trade_symbols).map((item) => item.toUpperCase()),
      AUTO_TRADE_SYMBOL_OPTIONS,
    ),
    auto_trade_timeframes: keepKnown(
      normalizeTextArray(row.auto_trade_timeframes),
      AUTO_TRADE_TIMEFRAME_OPTIONS,
    ),
    auto_trade_strategies: keepKnown(
      normalizeTextArray(row.auto_trade_strategies),
      AUTO_TRADE_STRATEGY_OPTIONS.map((strategy) => strategy.value),
    ),
    auto_trade_min_score_pct:
      numberValue(row.auto_trade_min_score_pct) ?? DEFAULT_AUTO_TRADE.auto_trade_min_score_pct,
    auto_trade_min_risk_reward:
      numberValue(row.auto_trade_min_risk_reward) ?? DEFAULT_AUTO_TRADE.auto_trade_min_risk_reward,
    auto_trade_require_no_warnings: row.auto_trade_require_no_warnings === true,
    auto_trade_max_orders_per_day:
      numberValue(row.auto_trade_max_orders_per_day) ?? DEFAULT_AUTO_TRADE.auto_trade_max_orders_per_day,
    auto_trade_cooldown_minutes:
      numberValue(row.auto_trade_cooldown_minutes) ?? DEFAULT_AUTO_TRADE.auto_trade_cooldown_minutes,
    auto_trade_max_attempts:
      numberValue(row.auto_trade_max_attempts) ?? DEFAULT_AUTO_TRADE.auto_trade_max_attempts,
    auto_trade_paused_at:
      typeof row.auto_trade_paused_at === 'string' ? row.auto_trade_paused_at : null,
    auto_trade_pause_reason:
      typeof row.auto_trade_pause_reason === 'string' ? row.auto_trade_pause_reason : null,
    auto_trade_last_run_at:
      typeof row.auto_trade_last_run_at === 'string' ? row.auto_trade_last_run_at : null,
    auto_trade_last_success_at:
      typeof row.auto_trade_last_success_at === 'string' ? row.auto_trade_last_success_at : null,
    auto_trade_last_error:
      typeof row.auto_trade_last_error === 'string' ? row.auto_trade_last_error : null,
  };
}

function autoTradeToForm(settings: AutoTradeSettings): AutoTradeForm {
  return {
    auto_trade_enabled: settings.auto_trade_enabled,
    auto_trade_environment: settings.auto_trade_environment,
    auto_trade_quote_amount: String(settings.auto_trade_quote_amount),
    auto_trade_symbols: [...settings.auto_trade_symbols],
    auto_trade_timeframes: [...settings.auto_trade_timeframes],
    auto_trade_strategies: [...settings.auto_trade_strategies],
    auto_trade_min_score_pct: String(settings.auto_trade_min_score_pct),
    auto_trade_min_risk_reward: String(settings.auto_trade_min_risk_reward),
    auto_trade_require_no_warnings: settings.auto_trade_require_no_warnings,
    auto_trade_max_orders_per_day: String(settings.auto_trade_max_orders_per_day),
    auto_trade_cooldown_minutes: String(settings.auto_trade_cooldown_minutes),
    auto_trade_max_attempts: String(settings.auto_trade_max_attempts),
  };
}

function parseAutoTradeForm(form: AutoTradeForm): {
  values: Omit<
    AutoTradeSettings,
    | 'auto_trade_paused_at'
    | 'auto_trade_pause_reason'
    | 'auto_trade_last_run_at'
    | 'auto_trade_last_success_at'
    | 'auto_trade_last_error'
  > | null;
  error: string | null;
} {
  const symbols = keepKnown(form.auto_trade_symbols, AUTO_TRADE_SYMBOL_OPTIONS);
  const timeframes = keepKnown(form.auto_trade_timeframes, AUTO_TRADE_TIMEFRAME_OPTIONS);
  const strategies = keepKnown(
    form.auto_trade_strategies,
    AUTO_TRADE_STRATEGY_OPTIONS.map((strategy) => strategy.value),
  );

  const values = {
    auto_trade_enabled: form.auto_trade_enabled,
    auto_trade_environment: form.auto_trade_environment,
    auto_trade_quote_amount: Number(form.auto_trade_quote_amount),
    auto_trade_symbols: symbols,
    auto_trade_timeframes: timeframes,
    auto_trade_strategies: strategies,
    auto_trade_min_score_pct: Number(form.auto_trade_min_score_pct),
    auto_trade_min_risk_reward: Number(form.auto_trade_min_risk_reward),
    auto_trade_require_no_warnings: form.auto_trade_require_no_warnings,
    auto_trade_max_orders_per_day: Number(form.auto_trade_max_orders_per_day),
    auto_trade_cooldown_minutes: Number(form.auto_trade_cooldown_minutes),
    auto_trade_max_attempts: Number(form.auto_trade_max_attempts),
  };

  if (!Number.isFinite(values.auto_trade_quote_amount) || values.auto_trade_quote_amount <= 0) {
    return { values: null, error: 'O valor por operação precisa ser maior que zero.' };
  }

  const invalidSymbol = symbols.find(
    (symbol) => !/^[A-Z0-9]{5,20}$/.test(symbol) || !symbol.endsWith('USDT'),
  );
  if (invalidSymbol) {
    return { values: null, error: `Símbolo inválido: ${invalidSymbol}. Use pares Spot em USDT.` };
  }

  const invalidTimeframe = timeframes.find((timeframe) => !AUTO_TRADE_TIMEFRAMES.has(timeframe));
  if (invalidTimeframe) {
    return { values: null, error: `Timeframe inválido: ${invalidTimeframe}. Use 5m, 15m, 30m ou 1h.` };
  }

  if (strategies.length === 0) {
    return { values: null, error: 'Informe pelo menos uma estratégia.' };
  }

  if (
    !Number.isFinite(values.auto_trade_min_score_pct) ||
    values.auto_trade_min_score_pct < 0 ||
    values.auto_trade_min_score_pct > 100
  ) {
    return { values: null, error: 'A pontuação mínima deve ficar entre 0% e 100%.' };
  }

  if (
    !Number.isFinite(values.auto_trade_min_risk_reward) ||
    values.auto_trade_min_risk_reward <= 0 ||
    values.auto_trade_min_risk_reward > 100
  ) {
    return { values: null, error: 'A relação risco-retorno mínima deve ficar entre 0 e 100.' };
  }

  if (
    !Number.isInteger(values.auto_trade_max_orders_per_day) ||
    values.auto_trade_max_orders_per_day < 1 ||
    values.auto_trade_max_orders_per_day > 100
  ) {
    return { values: null, error: 'O limite diário deve ser um número inteiro entre 1 e 100.' };
  }

  if (
    !Number.isInteger(values.auto_trade_cooldown_minutes) ||
    values.auto_trade_cooldown_minutes < 0 ||
    values.auto_trade_cooldown_minutes > 10080
  ) {
    return { values: null, error: 'O intervalo deve ficar entre 0 e 10.080 minutos.' };
  }

  if (
    !Number.isInteger(values.auto_trade_max_attempts) ||
    values.auto_trade_max_attempts < 1 ||
    values.auto_trade_max_attempts > 10
  ) {
    return { values: null, error: 'As tentativas devem ser um número inteiro entre 1 e 10.' };
  }

  if (values.auto_trade_enabled && symbols.length === 0) {
    return { values: null, error: 'Selecione pelo menos um símbolo antes de ativar.' };
  }

  if (values.auto_trade_enabled && timeframes.length === 0) {
    return { values: null, error: 'Selecione pelo menos um timeframe antes de ativar.' };
  }

  return { values, error: null };
}

interface EdgeErrorPayload {
  error?: string;
  detail?: string;
  order_id?: string;
  request_id?: string;
  entrada_executada?: boolean;
  duplicate?: boolean;
  order?: Partial<OrderRow>;
}

type OrderResultKind = 'success' | 'warning' | 'critical' | 'error';

interface OrderResult {
  text: string;
  kind: OrderResultKind;
}

class EdgeInvokeError extends Error {
  status?: number;
  payload: EdgeErrorPayload;

  constructor(message: string, status?: number, payload: EdgeErrorPayload = {}) {
    super(message);
    this.name = 'EdgeInvokeError';
    this.status = status;
    this.payload = payload;
  }
}

const DEFAULT_RISK: RiskSettings = {
  trading_real_enabled: false,
  max_order_usdt: 100,
  max_open_orders: 3,
  max_daily_loss_usdt: 50,
  min_stop_pct: 0.2,
  max_stop_pct: 15,
  min_target_pct: 0.2,
  max_target_pct: 50,
};

function riskToForm(settings: RiskSettings): RiskForm {
  return {
    trading_real_enabled: settings.trading_real_enabled,
    max_order_usdt: String(settings.max_order_usdt),
    max_open_orders: String(settings.max_open_orders),
    max_daily_loss_usdt: String(settings.max_daily_loss_usdt),
    min_stop_pct: String(settings.min_stop_pct),
    max_stop_pct: String(settings.max_stop_pct),
    min_target_pct: String(settings.min_target_pct),
    max_target_pct: String(settings.max_target_pct),
  };
}

function parseRiskForm(form: RiskForm): { values: RiskSettings | null; error: string | null } {
  const values: RiskSettings = {
    trading_real_enabled: form.trading_real_enabled,
    max_order_usdt: Number(form.max_order_usdt),
    max_open_orders: Number(form.max_open_orders),
    max_daily_loss_usdt: Number(form.max_daily_loss_usdt),
    min_stop_pct: Number(form.min_stop_pct),
    max_stop_pct: Number(form.max_stop_pct),
    min_target_pct: Number(form.min_target_pct),
    max_target_pct: Number(form.max_target_pct),
  };

  if (!Number.isFinite(values.max_order_usdt) || values.max_order_usdt <= 0) {
    return { values: null, error: 'O limite por ordem precisa ser maior que zero.' };
  }
  if (!Number.isInteger(values.max_open_orders) || values.max_open_orders < 1 || values.max_open_orders > 20) {
    return { values: null, error: 'Ordens abertas deve ser um número inteiro entre 1 e 20.' };
  }
  if (!Number.isFinite(values.max_daily_loss_usdt) || values.max_daily_loss_usdt < 0) {
    return { values: null, error: 'A perda diária não pode ser negativa.' };
  }
  if (!Number.isFinite(values.min_stop_pct) || values.min_stop_pct <= 0) {
    return { values: null, error: 'O stop mínimo precisa ser maior que zero.' };
  }
  if (!Number.isFinite(values.max_stop_pct) || values.max_stop_pct < values.min_stop_pct) {
    return { values: null, error: 'O stop máximo não pode ser menor que o stop mínimo.' };
  }
  if (!Number.isFinite(values.min_target_pct) || values.min_target_pct <= 0) {
    return { values: null, error: 'O alvo mínimo precisa ser maior que zero.' };
  }
  if (!Number.isFinite(values.max_target_pct) || values.max_target_pct < values.min_target_pct) {
    return { values: null, error: 'O alvo máximo não pode ser menor que o alvo mínimo.' };
  }

  return { values, error: null };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function errorMessage(error: unknown, fallback = 'erro desconhecido'): string {
  const value = recordValue(error);
  return typeof value.message === 'string' && value.message.trim()
    ? value.message
    : fallback;
}

function isCentralSchemaMissing(error: unknown): boolean {
  const value = recordValue(error);
  const code = typeof value.code === 'string' ? value.code : '';
  const message = [value.message, value.details, value.hint]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase();

  return (
    code === '42703' ||
    code === '42P01' ||
    code === 'PGRST204' ||
    code === 'PGRST205' ||
    message.includes('opportunity_id') ||
    message.includes('trade_opportunities')
  );
}

function normalizeOrder(value: unknown): OrderRow {
  const row = recordValue(value);
  return {
    id: String(row.id ?? ''),
    symbol: String(row.symbol ?? ''),
    status: String(row.status ?? 'erro'),
    is_testnet: row.is_testnet === true,
    quote_amount: numberValue(row.quote_amount) ?? 0,
    qty: numberValue(row.qty),
    entry_price: numberValue(row.entry_price),
    exit_price: numberValue(row.exit_price),
    stop_price: numberValue(row.stop_price),
    target_price: numberValue(row.target_price),
    pnl_usdt: numberValue(row.pnl_usdt),
    erro: typeof row.erro === 'string' ? row.erro : null,
    criado_em: typeof row.criado_em === 'string' ? row.criado_em : new Date(0).toISOString(),
    request_id: typeof row.request_id === 'string' ? row.request_id : null,
    protected_at: typeof row.protected_at === 'string' ? row.protected_at : null,
    last_checked_at: typeof row.last_checked_at === 'string' ? row.last_checked_at : null,
    binance_status: typeof row.binance_status === 'string' ? row.binance_status : null,
    unprotected_reason: typeof row.unprotected_reason === 'string' ? row.unprotected_reason : null,
    opportunity_id: typeof row.opportunity_id === 'string' ? row.opportunity_id : null,
  };
}

function normalizeOpportunity(value: unknown): OpportunitySummary | null {
  const row = recordValue(value);
  const id = typeof row.id === 'string' ? row.id : '';

  if (!isSafeUuid(id)) return null;

  return {
    id,
    symbol: typeof row.symbol === 'string' ? row.symbol : '',
    timeframe: typeof row.timeframe === 'string' ? row.timeframe : '',
    lifecycle_status:
      typeof row.lifecycle_status === 'string' ? row.lifecycle_status : 'pending',
    strategy: typeof row.strategy === 'string' ? row.strategy : '',
    strategy_version:
      typeof row.strategy_version === 'string' ? row.strategy_version : '',
    entry_decision:
      typeof row.entry_decision === 'string' ? row.entry_decision : 'pending',
    execution_environment:
      typeof row.execution_environment === 'string'
        ? row.execution_environment
        : 'testnet',
    detected_at:
      typeof row.detected_at === 'string'
        ? row.detected_at
        : new Date(0).toISOString(),
    closed_at: typeof row.closed_at === 'string' ? row.closed_at : null,
  };
}

function resultColor(kind: OrderResultKind): string {
  if (kind === 'success') return S.green;
  if (kind === 'warning') return S.a;
  return S.red;
}

export default function ContaPage() {
  const supabase = getSupabase();

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);

  const [keyInfo, setKeyInfo] = useState<KeyInfo | null | undefined>(undefined);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [isTestnet, setIsTestnet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);

  const [riskSettings, setRiskSettings] = useState<RiskSettings>(DEFAULT_RISK);
  const [riskForm, setRiskForm] = useState<RiskForm>(() => riskToForm(DEFAULT_RISK));
  const [riskBusy, setRiskBusy] = useState(false);
  const [riskMsg, setRiskMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [autoTradeSettings, setAutoTradeSettings] = useState<AutoTradeSettings>(DEFAULT_AUTO_TRADE);
  const [autoTradeForm, setAutoTradeForm] = useState<AutoTradeForm>(
    () => autoTradeToForm(DEFAULT_AUTO_TRADE),
  );
  const [autoTradeBusy, setAutoTradeBusy] = useState(false);
  const [autoTradeMsg, setAutoTradeMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [ordSymbol, setOrdSymbol] = useState('BTCUSDT');
  const [ordAmount, setOrdAmount] = useState('50');
  const [ordStop, setOrdStop] = useState('2');
  const [ordTarget, setOrdTarget] = useState('4');
  const [ordResult, setOrdResult] = useState<OrderResult | null>(null);
  const [ordBusy, setOrdBusy] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [unprotectedLock, setUnprotectedLock] = useState(false);
  const [acknowledgedStoredRisk, setAcknowledgedStoredRisk] = useState(false);

  const requestIdRef = useRef<string | null>(null);
  const requestSignatureRef = useRef<string | null>(null);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState('');
  const [centralSchemaAvailable, setCentralSchemaAvailable] = useState<boolean | null>(null);
  const [opportunityById, setOpportunityById] = useState<Record<string, OpportunitySummary>>({});

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) {
        setKeyInfo(undefined);
        setOrders([]);
        setBalances([]);
        setOpportunityById({});
        setCentralSchemaAvailable(null);
        setAutoTradeSettings(DEFAULT_AUTO_TRADE);
        setAutoTradeForm(autoTradeToForm(DEFAULT_AUTO_TRADE));
        setAutoTradeMsg(null);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  const loadKeyStatus = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_exchange_key_status');
    if (error) throw new Error(`Não foi possível consultar a chave: ${error.message}`);

    const row = Array.isArray(data) ? data[0] : data;
    const value = recordValue(row);

    if (value.configured !== true) {
      setKeyInfo(null);
      return;
    }

    setKeyInfo({
      configured: true,
      api_key_masked: typeof value.api_key_masked === 'string' ? value.api_key_masked : null,
      is_testnet: value.is_testnet !== false,
      atualizado_em: typeof value.atualizado_em === 'string' ? value.atualizado_em : null,
    });
  }, [supabase]);

  const loadRiskSettings = useCallback(async () => {
    const { data, error } = await supabase
      .from('user_settings')
      .select('trading_real_enabled, max_order_usdt, max_open_orders, max_daily_loss_usdt, min_stop_pct, max_stop_pct, min_target_pct, max_target_pct')
      .maybeSingle();

    if (error) throw new Error(`Não foi possível consultar os limites: ${error.message}`);

    const loaded: RiskSettings = data ? {
      trading_real_enabled: data.trading_real_enabled === true,
      max_order_usdt: Number(data.max_order_usdt),
      max_open_orders: Number(data.max_open_orders),
      max_daily_loss_usdt: Number(data.max_daily_loss_usdt),
      min_stop_pct: Number(data.min_stop_pct),
      max_stop_pct: Number(data.max_stop_pct),
      min_target_pct: Number(data.min_target_pct),
      max_target_pct: Number(data.max_target_pct),
    } : DEFAULT_RISK;

    setRiskSettings(loaded);
    setRiskForm(riskToForm(loaded));
  }, [supabase]);

  const loadAutoTradeSettings = useCallback(async () => {
    const { data, error } = await supabase
      .from('user_settings')
      .select([
        'auto_trade_enabled',
        'auto_trade_environment',
        'auto_trade_quote_amount',
        'auto_trade_symbols',
        'auto_trade_timeframes',
        'auto_trade_strategies',
        'auto_trade_min_score_pct',
        'auto_trade_min_risk_reward',
        'auto_trade_require_no_warnings',
        'auto_trade_max_orders_per_day',
        'auto_trade_cooldown_minutes',
        'auto_trade_max_attempts',
        'auto_trade_paused_at',
        'auto_trade_pause_reason',
        'auto_trade_last_run_at',
        'auto_trade_last_success_at',
        'auto_trade_last_error',
      ].join(','))
      .maybeSingle();

    if (error) {
      throw new Error(`Não foi possível consultar o Auto Trade: ${error.message}`);
    }

    const loaded = data
      ? normalizeAutoTradeSettings(data)
      : DEFAULT_AUTO_TRADE;

    setAutoTradeSettings(loaded);
    setAutoTradeForm(autoTradeToForm(loaded));
  }, [supabase]);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError('');

    let centralReady = centralSchemaAvailable !== false;
    const initialResponse = await supabase
      .from('orders')
      .select(centralReady ? ORDER_SELECT_WITH_OPPORTUNITY : ORDER_SELECT_BASE)
      .order('criado_em', { ascending: false })
      .limit(15);

    let orderData: unknown = initialResponse.data;
    let orderError: unknown = initialResponse.error;

    if (orderError && centralReady && isCentralSchemaMissing(orderError)) {
      centralReady = false;
      setCentralSchemaAvailable(false);

      const fallbackResponse = await supabase
        .from('orders')
        .select(ORDER_SELECT_BASE)
        .order('criado_em', { ascending: false })
        .limit(15);

      orderData = fallbackResponse.data;
      orderError = fallbackResponse.error;
    }

    if (orderError) {
      setOrdersError(
        `Não foi possível carregar as ordens: ${errorMessage(orderError)}`,
      );
      setOrdersLoading(false);
      return;
    }

    const loadedOrders = Array.isArray(orderData)
      ? orderData.map(normalizeOrder)
      : [];

    setOrders(loadedOrders);

    if (!loadedOrders.some((order) => order.status === 'entrada_sem_protecao')) {
      setAcknowledgedStoredRisk(false);
    }

    const opportunityIds = [...new Set(
      loadedOrders
        .map((order) => order.opportunity_id)
        .filter((id): id is string => isSafeUuid(id)),
    )];

    if (!centralReady) {
      setOpportunityById({});
      setOrdersLoading(false);
      return;
    }

    setCentralSchemaAvailable(true);

    if (opportunityIds.length === 0) {
      setOpportunityById({});
      setOrdersLoading(false);
      return;
    }

    const { data: opportunityData, error: opportunityError } = await supabase
      .from('trade_opportunities')
      .select('id, symbol, timeframe, lifecycle_status, strategy, strategy_version, entry_decision, execution_environment, detected_at, closed_at')
      .in('id', opportunityIds);

    if (opportunityError) {
      if (isCentralSchemaMissing(opportunityError)) {
        setCentralSchemaAvailable(false);
        setOpportunityById({});
      } else {
        setOrdersError(
          `As ordens foram carregadas, mas o vínculo com a Central não pôde ser consultado: ${opportunityError.message}`,
        );
      }

      setOrdersLoading(false);
      return;
    }

    const nextOpportunityById: Record<string, OpportunitySummary> = {};

    for (const rawOpportunity of opportunityData ?? []) {
      const opportunity = normalizeOpportunity(rawOpportunity);
      if (opportunity) nextOpportunityById[opportunity.id] = opportunity;
    }

    setOpportunityById(nextOpportunityById);
    setOrdersLoading(false);
  }, [centralSchemaAvailable, supabase]);

  const loadAccountData = useCallback(async () => {
    setAccountLoading(true);
    setMsg(null);

    const results = await Promise.allSettled([
      loadKeyStatus(),
      loadRiskSettings(),
      loadAutoTradeSettings(),
      loadOrders(),
    ]);

    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      setMsg({
        text: failure.reason instanceof Error ? failure.reason.message : 'Falha ao carregar a conta.',
        ok: false,
      });
    }

    setAccountLoading(false);
  }, [loadAutoTradeSettings, loadKeyStatus, loadOrders, loadRiskSettings]);

  useEffect(() => {
    if (!session) return;
    void loadAccountData();
  }, [session, loadAccountData]);

  useEffect(() => {
    if (!session) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void loadOrders();
      }, 250);
    };

    const channel = supabase
      .channel(`conta-orders-${session.user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'orders',
          filter: `user_id=eq.${session.user.id}`,
        },
        scheduleRefresh,
      );

    if (centralSchemaAvailable !== false) {
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'trade_opportunities',
          filter: `user_id=eq.${session.user.id}`,
        },
        scheduleRefresh,
      );
    }

    channel.subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      void supabase.removeChannel(channel);
    };
  }, [centralSchemaAvailable, loadOrders, session, supabase]);

  const invoke = useCallback(async (
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<Record<string, unknown>> => {
    const { data, error } = await supabase.functions.invoke('binance-trade', {
      body: payload,
      headers,
    });

    if (error) {
      if (error instanceof FunctionsHttpError) {
        let body: EdgeErrorPayload = {};
        try {
          body = await error.context.json() as EdgeErrorPayload;
        } catch {
          body = {};
        }
        throw new EdgeInvokeError(
          body.error || error.message || 'A função retornou um erro.',
          error.context.status,
          body,
        );
      }

      if (error instanceof FunctionsRelayError) {
        throw new EdgeInvokeError(`Falha no serviço intermediário: ${error.message}`);
      }

      if (error instanceof FunctionsFetchError) {
        throw new EdgeInvokeError(`Não foi possível alcançar a função: ${error.message}`);
      }

      throw new EdgeInvokeError(error.message || 'Falha ao chamar a função.');
    }

    const result = recordValue(data);
    if (typeof result.error === 'string') {
      throw new EdgeInvokeError(result.error, undefined, result as EdgeErrorPayload);
    }
    return result;
  }, [supabase]);

  const saveKeys = async () => {
    const cleanKey = apiKey.trim();
    const cleanSecret = apiSecret.trim();

    if (cleanKey.length < 10 || cleanSecret.length < 10) {
      setMsg({ text: 'Informe uma API Key e um API Secret válidos.', ok: false });
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      await invoke({
        action: 'save_keys',
        api_key: cleanKey,
        api_secret: cleanSecret,
        is_testnet: isTestnet,
      });
      setApiKey('');
      setApiSecret('');
      setBalances([]);
      await Promise.all([loadKeyStatus(), loadRiskSettings()]);
      setMsg({ text: 'Chave salva com o segredo cifrado no servidor.', ok: true });
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : 'Erro ao salvar a chave.', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setMsg(null);
    setBalances([]);
    try {
      const result = await invoke({ action: 'test_connection' });
      const returnedBalances = Array.isArray(result.balances) ? result.balances as Balance[] : [];
      setBalances(returnedBalances);
      setMsg({
        text: `Conexão OK (${result.is_testnet === true ? 'TESTNET' : 'CONTA REAL'}).`,
        ok: true,
      });
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : 'Erro ao testar a conexão.', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const deleteKeys = async () => {
    if (!confirm('Remover a chave da Binance? Ordens abertas na exchange não são canceladas.')) return;

    setBusy(true);
    setMsg(null);
    try {
      await invoke({ action: 'delete_keys' });
      if (session) {
        const removedAt = new Date().toISOString();

        await supabase
          .from('user_settings')
          .update({
            trading_real_enabled: false,
            auto_trade_enabled: false,
            auto_trade_paused_at: removedAt,
            auto_trade_pause_reason: 'A chave Binance foi removida.',
          })
          .eq('user_id', session.user.id);

        const disabledAutoTrade: AutoTradeSettings = {
          ...autoTradeSettings,
          auto_trade_enabled: false,
          auto_trade_paused_at: removedAt,
          auto_trade_pause_reason: 'A chave Binance foi removida.',
        };

        setAutoTradeSettings(disabledAutoTrade);
        setAutoTradeForm(autoTradeToForm(disabledAutoTrade));
      }
      const disabledRisk = { ...riskSettings, trading_real_enabled: false };
      setRiskSettings(disabledRisk);
      setRiskForm(riskToForm(disabledRisk));
      setKeyInfo(null);
      setBalances([]);
      setMsg({ text: 'Chave removida. Operações reais foram bloqueadas.', ok: true });
    } catch (error) {
      setMsg({ text: error instanceof Error ? error.message : 'Erro ao remover a chave.', ok: false });
    } finally {
      setBusy(false);
    }
  };

  const handleRealTradingToggle = (checked: boolean) => {
    setRiskMsg(null);

    if (checked) {
      if (!keyInfo || keyInfo.is_testnet) {
        setRiskMsg({
          text: 'A ativação real só é permitida quando uma chave de conta real está configurada.',
          ok: false,
        });
        return;
      }

      const accepted = confirm(
        'ATENÇÃO: ativar operações reais permite que o VigIA compre e venda ativos com dinheiro de verdade.\n\n' +
        'A proteção OCO pode falhar por indisponibilidade, saldo, filtros da Binance ou erro externo. ' +
        'Confirme somente se você compreende o risco e irá acompanhar a conta diretamente na Binance.',
      );
      if (!accepted) return;
    }

    setRiskForm((current) => ({ ...current, trading_real_enabled: checked }));
  };

  const saveRiskSettings = async () => {
    const parsed = parseRiskForm(riskForm);
    if (!parsed.values) {
      setRiskMsg({ text: parsed.error ?? 'Limites inválidos.', ok: false });
      return;
    }

    if (parsed.values.trading_real_enabled && (!keyInfo || keyInfo.is_testnet)) {
      setRiskMsg({
        text: 'Não é possível ativar operações reais sem uma chave de conta real.',
        ok: false,
      });
      return;
    }

    if (!session) return;

    setRiskBusy(true);
    setRiskMsg(null);
    const { error } = await supabase.from('user_settings').upsert({
      user_id: session.user.id,
      ...parsed.values,
    }, { onConflict: 'user_id' });

    if (error) {
      setRiskMsg({ text: `Não foi possível salvar os limites: ${error.message}`, ok: false });
      setRiskBusy(false);
      return;
    }

    setRiskSettings(parsed.values);
    setRiskForm(riskToForm(parsed.values));
    setRiskMsg({
      text: parsed.values.trading_real_enabled
        ? 'Limites salvos. Operações reais estão habilitadas dentro desses limites.'
        : 'Limites salvos. Operações reais continuam bloqueadas.',
      ok: true,
    });
    setRiskBusy(false);
  };

  const handleAutoTradeToggle = (checked: boolean) => {
    setAutoTradeMsg(null);

    if (checked) {
      const accepted = confirm(
        'ATENÇÃO: o Auto Trade poderá aceitar oportunidades e enviar entradas com proteção OCO sem uma confirmação manual em cada operação.\n\n' +
        'Os limites continuarão sendo revalidados no servidor. Ative somente depois de conferir ambiente, valor, símbolos, timeframes e limites de risco.',
      );

      if (!accepted) return;
    }

    setAutoTradeForm((current) => ({
      ...current,
      auto_trade_enabled: checked,
    }));
  };

  const saveAutoTradeSettings = async () => {
    const parsed = parseAutoTradeForm(autoTradeForm);

    if (!parsed.values) {
      setAutoTradeMsg({ text: parsed.error ?? 'Configuração inválida.', ok: false });
      return;
    }

    if (!session) return;

    if (parsed.values.auto_trade_quote_amount > riskSettings.max_order_usdt) {
      setAutoTradeMsg({
        text: `O valor por operação não pode ultrapassar ${fmt(riskSettings.max_order_usdt)} USDT.`,
        ok: false,
      });
      return;
    }

    if (parsed.values.auto_trade_enabled && !keyInfo) {
      setAutoTradeMsg({
        text: 'Configure e teste uma chave Binance antes de ativar o Auto Trade.',
        ok: false,
      });
      return;
    }

    if (
      parsed.values.auto_trade_enabled &&
      parsed.values.auto_trade_environment === 'testnet' &&
      keyInfo?.is_testnet !== true
    ) {
      setAutoTradeMsg({
        text: 'O ambiente Testnet exige uma chave Binance Spot Testnet.',
        ok: false,
      });
      return;
    }

    if (
      parsed.values.auto_trade_enabled &&
      parsed.values.auto_trade_environment === 'real' &&
      keyInfo?.is_testnet !== false
    ) {
      setAutoTradeMsg({
        text: 'O ambiente real exige uma chave Binance de conta real.',
        ok: false,
      });
      return;
    }

    if (
      parsed.values.auto_trade_enabled &&
      parsed.values.auto_trade_environment === 'real' &&
      !riskSettings.trading_real_enabled
    ) {
      setAutoTradeMsg({
        text: 'Ative primeiro as operações reais nos limites de risco.',
        ok: false,
      });
      return;
    }

    if (
      parsed.values.auto_trade_enabled &&
      parsed.values.auto_trade_environment === 'real'
    ) {
      const accepted = confirm(
        'CONFIRMAÇÃO DE CONTA REAL\n\n' +
        'O Auto Trade enviará operações com dinheiro real sem confirmação individual. ' +
        'A Binance, a rede ou a criação da OCO podem falhar. Você confirma que compreende o risco?',
      );

      if (!accepted) return;
    }

    setAutoTradeBusy(true);
    setAutoTradeMsg(null);

    const { error } = await supabase
      .from('user_settings')
      .upsert({
        user_id: session.user.id,
        ...parsed.values,
      }, { onConflict: 'user_id' });

    if (error) {
      setAutoTradeMsg({
        text: `Não foi possível salvar o Auto Trade: ${error.message}`,
        ok: false,
      });
      setAutoTradeBusy(false);
      return;
    }

    try {
      await loadAutoTradeSettings();
      setAutoTradeMsg({
        text: parsed.values.auto_trade_enabled
          ? `Auto Trade ativado em ${parsed.values.auto_trade_environment === 'testnet' ? 'Testnet' : 'conta real'}.`
          : 'Configurações salvas. O Auto Trade permanece desativado.',
        ok: true,
      });
    } catch (error) {
      setAutoTradeMsg({
        text: error instanceof Error ? error.message : 'Configuração salva, mas não foi possível recarregá-la.',
        ok: false,
      });
    } finally {
      setAutoTradeBusy(false);
    }
  };

  const resumeAutoTrade = async () => {
    if (!session || !autoTradeSettings.auto_trade_paused_at) return;

    const accepted = confirm(
      'Remova a pausa somente depois de conferir diretamente na Binance que não existe entrada sem proteção, ordem desconhecida ou posição que exija ação manual.\n\nVocê já realizou essa conferência?',
    );

    if (!accepted) return;

    setAutoTradeBusy(true);
    setAutoTradeMsg(null);

    const { error } = await supabase
      .from('user_settings')
      .update({
        auto_trade_paused_at: null,
        auto_trade_pause_reason: null,
        auto_trade_last_error: null,
      })
      .eq('user_id', session.user.id);

    if (error) {
      setAutoTradeMsg({
        text: `Não foi possível remover a pausa: ${error.message}`,
        ok: false,
      });
      setAutoTradeBusy(false);
      return;
    }

    try {
      await loadAutoTradeSettings();
      setAutoTradeMsg({
        text: 'Pausa removida. O Auto Trade seguirá o estado de ativação salvo.',
        ok: true,
      });
    } catch (error) {
      setAutoTradeMsg({
        text: error instanceof Error ? error.message : 'Pausa removida, mas não foi possível recarregar os dados.',
        ok: false,
      });
    } finally {
      setAutoTradeBusy(false);
    }
  };

  const clearRequest = useCallback(() => {
    requestIdRef.current = null;
    requestSignatureRef.current = null;
    setActiveRequestId(null);
  }, []);

  const resetOrderAttemptForChange = useCallback(() => {
    if (unprotectedLock || ordBusy) return;
    clearRequest();
    setOrdResult(null);
  }, [clearRequest, ordBusy, unprotectedLock]);

  const updateOrderField = (
    setter: (value: string) => void,
    value: string,
  ) => {
    setter(value);
    resetOrderAttemptForChange();
  };

  const hasStoredUnprotectedOrder = useMemo(
    () => orders.some((order) => order.status === 'entrada_sem_protecao'),
    [orders],
  );

  const orderBlockedByUnprotected = unprotectedLock ||
    (hasStoredUnprotectedOrder && !acknowledgedStoredRisk);

  const orderValidation = useMemo(() => {
    const amount = Number(ordAmount);
    const stop = Number(ordStop);
    const target = Number(ordTarget);

    if (!Number.isFinite(amount) || amount <= 0) return 'Informe um valor de ordem válido.';
    if (amount > riskSettings.max_order_usdt) {
      return `O valor máximo configurado é ${fmt(riskSettings.max_order_usdt)} USDT.`;
    }
    if (!Number.isFinite(stop) || stop < riskSettings.min_stop_pct || stop > riskSettings.max_stop_pct) {
      return `O stop deve ficar entre ${fmt(riskSettings.min_stop_pct)}% e ${fmt(riskSettings.max_stop_pct)}%.`;
    }
    if (!Number.isFinite(target) || target < riskSettings.min_target_pct || target > riskSettings.max_target_pct) {
      return `O alvo deve ficar entre ${fmt(riskSettings.min_target_pct)}% e ${fmt(riskSettings.max_target_pct)}%.`;
    }
    if (keyInfo?.is_testnet === false && !riskSettings.trading_real_enabled) {
      return 'As operações reais estão bloqueadas nas configurações de risco.';
    }
    if (orderBlockedByUnprotected) {
      return 'Existe uma compra sem proteção que precisa ser conferida diretamente na Binance.';
    }
    return null;
  }, [keyInfo, ordAmount, ordStop, ordTarget, orderBlockedByUnprotected, riskSettings]);

  const findOrderByRequestId = useCallback(async (requestId: string): Promise<OrderRow | null> => {
    const withOpportunity = centralSchemaAvailable !== false;
    const initialResponse = await supabase
      .from('orders')
      .select(withOpportunity ? ORDER_SELECT_WITH_OPPORTUNITY : ORDER_SELECT_BASE)
      .eq('request_id', requestId)
      .maybeSingle();

    let orderData: unknown = initialResponse.data;
    let orderError: unknown = initialResponse.error;

    if (orderError && withOpportunity && isCentralSchemaMissing(orderError)) {
      setCentralSchemaAvailable(false);
      const fallbackResponse = await supabase
        .from('orders')
        .select(ORDER_SELECT_BASE)
        .eq('request_id', requestId)
        .maybeSingle();

      orderData = fallbackResponse.data;
      orderError = fallbackResponse.error;
    }

    if (orderError) return null;
    return orderData ? normalizeOrder(orderData) : null;
  }, [centralSchemaAvailable, supabase]);

  const placeOrder = async () => {
    if (!keyInfo || orderValidation) {
      if (orderValidation) setOrdResult({ text: orderValidation, kind: 'error' });
      return;
    }

    const amount = Number(ordAmount);
    const stop = Number(ordStop);
    const target = Number(ordTarget);
    const mode = keyInfo.is_testnet ? 'TESTNET' : 'CONTA REAL ⚠️';
    const summary = `${ordSymbol} · gastar ${fmt(amount)} USDT · stop -${fmt(stop)}% · alvo +${fmt(target)}% · ${mode}`;

    if (!confirm(`Confirmar ordem?\n\n${summary}`)) return;

    const signature = `${ordSymbol}|${amount}|${stop}|${target}|${keyInfo.is_testnet ? 'testnet' : 'real'}`;
    let requestId = requestIdRef.current;

    if (!requestId || requestSignatureRef.current !== signature) {
      requestId = crypto.randomUUID();
      requestIdRef.current = requestId;
      requestSignatureRef.current = signature;
      setActiveRequestId(requestId);
    }

    setOrdBusy(true);
    setOrdResult(null);

    try {
      const result = await invoke({
        action: 'place_entry_oco',
        symbol: ordSymbol,
        quote_amount: amount,
        stop_pct: stop,
        target_pct: target,
        request_id: requestId,
      }, {
        'x-idempotency-key': requestId,
      });

      if (result.duplicate === true) {
        const existing = recordValue(result.order);
        const existingStatus = typeof existing.status === 'string' ? existing.status : 'processada';
        setOrdResult({
          text: `Esta solicitação já havia sido processada. Estado atual: ${STATUS_LABEL[existingStatus]?.label ?? existingStatus}.`,
          kind: existingStatus === 'oco_ativa' ? 'success' : 'warning',
        });
      } else {
        const entry = recordValue(result.entrada);
        const exit = recordValue(result.saida);
        const qty = numberValue(entry.qty);
        const average = numberValue(entry.preco_medio);
        const spent = numberValue(entry.gasto_usdt);
        const targetPrice = numberValue(exit.alvo);
        const stopPrice = numberValue(exit.stop);

        setOrdResult({
          text:
            `Executada (${result.is_testnet === true ? 'testnet' : 'REAL'}): comprou ${qty !== null ? fmt(qty, 8) : '—'} ` +
            `a ~${average !== null ? fmt(average) : '—'} (gasto ${spent !== null ? fmt(spent) : '—'} USDT). ` +
            `OCO ativa: alvo ${targetPrice !== null ? fmt(targetPrice) : '—'} / stop ${stopPrice !== null ? fmt(stopPrice) : '—'}.`,
          kind: 'success',
        });
      }

      clearRequest();
      await loadOrders();
    } catch (error) {
      let storedOrder: OrderRow | null = null;
      try {
        storedOrder = await findOrderByRequestId(requestId);
      } catch {
        storedOrder = null;
      }

      const edgeError = error instanceof EdgeInvokeError ? error : null;
      const payload = edgeError?.payload ?? {};
      const payloadOrder = payload.order ?? {};
      const detectedStatus = storedOrder?.status ?? payloadOrder.status;
      const entryExecuted = payload.entrada_executada === true ||
        detectedStatus === 'entrada_executada' ||
        detectedStatus === 'protecao_pendente' ||
        detectedStatus === 'entrada_sem_protecao' ||
        String(payload.error ?? '').toLowerCase().includes('compra executada');

      if (entryExecuted || detectedStatus === 'entrada_sem_protecao') {
        setUnprotectedLock(true);
        setAcknowledgedStoredRisk(false);
        setOrdResult({
          text:
            'ATENÇÃO: a compra pode ter sido executada, mas a proteção OCO não foi confirmada. ' +
            'Não envie outra ordem. Abra a Binance agora, confira o saldo e proteja ou encerre a posição manualmente. ' +
            `Detalhe: ${storedOrder?.unprotected_reason || storedOrder?.erro || payload.detail || payload.error || edgeError?.message || 'falha desconhecida'}`,
          kind: 'critical',
        });
      } else if (detectedStatus === 'erro_pre_entrada' || payload.entrada_executada === false) {
        clearRequest();
        setOrdResult({
          text: `A compra não foi executada. ${edgeError?.message || 'A solicitação falhou antes da entrada.'}`,
          kind: 'error',
        });
      } else if (edgeError?.status !== undefined) {
        clearRequest();
        setOrdResult({
          text: edgeError.message,
          kind: edgeError.status === 409 ? 'warning' : 'error',
        });
      } else {
        setOrdResult({
          text:
            `${error instanceof Error ? error.message : 'Falha de comunicação.'} ` +
            'O resultado não pôde ser confirmado. O próximo envio reutilizará o mesmo identificador para evitar uma compra duplicada.',
          kind: 'warning',
        });
      }

      await loadOrders();
    } finally {
      setOrdBusy(false);
    }
  };

  const releaseAfterManualCheck = () => {
    const accepted = confirm(
      'Libere uma nova ordem somente depois de conferir diretamente na Binance que a posição anterior está protegida ou encerrada.\n\nVocê já fez essa conferência?',
    );
    if (!accepted) return;

    setUnprotectedLock(false);
    setAcknowledgedStoredRisk(true);
    clearRequest();
    setOrdResult(null);
  };

  const unprotectedOrders = useMemo(
    () => orders.filter((order) => order.status === 'entrada_sem_protecao'),
    [orders],
  );

  const openOrdersCount = useMemo(
    () => orders.filter((order) => OPEN_STATUSES.has(order.status)).length,
    [orders],
  );

  const linkedOrdersCount = useMemo(
    () => orders.filter((order) => isSafeUuid(order.opportunity_id)).length,
    [orders],
  );

  const linkedOpenOrdersCount = useMemo(
    () => orders.filter(
      (order) =>
        isSafeUuid(order.opportunity_id) &&
        OPEN_STATUSES.has(order.status),
    ).length,
    [orders],
  );

  return (
    <main style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <header style={{ borderBottom: `1px solid ${S.border}`, background: S.panel, padding: '12px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="VigIA Trade" style={{ height: 32, width: 'auto', display: 'block' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>Conta Binance</div>
            <div style={{ fontSize: 11, color: S.dim }}>conexão · ordens · histórico</div>
          </div>
        </div>
        <nav
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 20,
            marginTop: 8,
            fontSize: 13,
          }}
        >
          <a href="/" style={{ color: S.dim, textDecoration: 'none' }}>
            Análise
          </a>
          <a href="/daytrade" style={{ color: S.dim, textDecoration: 'none' }}>
            Day Trade
          </a>
          <a href="/oportunidades" style={{ color: S.dim, textDecoration: 'none' }}>
            Oportunidades
          </a>
          <a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>
            Alertas
          </a>
          <span style={{ color: S.a, fontWeight: 600 }}>
            Conta Binance
          </span>
          {session && (
            <button
              onClick={() => supabase.auth.signOut()}
              style={{ background: 'transparent', border: 'none', color: S.red, fontSize: 13, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}
            >
              Sair
            </button>
          )}
        </nav>
      </header>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!authReady ? null : !session ? (
          <Card style={{ textAlign: 'center', color: S.dim, fontSize: 14 }}>
            <div>Entre para acessar as chaves, os limites e o histórico da conta.</div>
            <a
              href="/alertas?next=%2Fconta"
              style={{ color: S.a, display: 'inline-block', marginTop: 8 }}
            >
              Entrar com magic link
            </a>
          </Card>
        ) : (
          <>
            {unprotectedOrders.length > 0 && (
              <Card style={{ textAlign: 'center', borderColor: `${S.red}99`, background: `${S.red}0d` }}>
                <div style={{ color: S.red, fontWeight: 700, fontSize: 14 }}>
                  ⚠️ {unprotectedOrders.length} posição(ões) registrada(s) sem proteção
                </div>
                <div style={{ color: S.text, fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
                  Confira imediatamente a conta diretamente na Binance. Não presuma que existe stop ou alvo ativo.
                </div>
              </Card>
            )}

            {/* --------------------------- Chave --------------------------- */}
            <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Chave de API</div>

              {keyInfo === undefined || accountLoading ? (
                <div style={{ fontSize: 13, color: S.dim }}>Carregando configuração...</div>
              ) : keyInfo ? (
                <>
                  <div
                    style={{
                      fontSize: 13,
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      maxWidth: '100%',
                    }}
                  >
                    <span style={{ color: S.dim }}>Configurada:</span>
                    <code
                      style={{
                        color: S.a,
                        maxWidth: '100%',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-all',
                      }}
                    >
                      {shortMask(keyInfo.api_key_masked)}
                    </code>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 10,
                        fontSize: 11,
                        fontWeight: 700,
                        background: keyInfo.is_testnet ? `${S.green}22` : `${S.red}22`,
                        color: keyInfo.is_testnet ? S.green : S.red,
                      }}
                    >
                      {keyInfo.is_testnet ? 'TESTNET' : 'CONTA REAL'}
                    </span>
                  </div>
                  {keyInfo.atualizado_em && (
                    <div style={{ fontSize: 11, color: S.dim }}>
                      Atualizada em {fmtData(keyInfo.atualizado_em)}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button
                      onClick={testConnection}
                      disabled={busy}
                      style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
                    >
                      {busy ? 'Aguarde...' : 'Testar conexão'}
                    </button>
                    <button
                      onClick={deleteKeys}
                      disabled={busy}
                      style={{ background: 'transparent', color: S.red, border: `1px solid ${S.red}55`, borderRadius: 8, padding: '8px 18px', fontSize: 13, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
                    >
                      Remover chave
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: S.dim, maxWidth: 480 }}>
                    Crie a chave em <strong>testnet.binance.vision</strong> (testnet) ou na Binance real
                    com permissão <strong>apenas de leitura e trade — saque desabilitado</strong>.
                    O segredo é cifrado no servidor e nunca volta ao navegador.
                  </div>
                  <input
                    placeholder="API Key"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...inputStyle, width: '100%', maxWidth: 420 }}
                  />
                  <input
                    placeholder="API Secret"
                    type="password"
                    value={apiSecret}
                    onChange={(event) => setApiSecret(event.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                    style={{ ...inputStyle, width: '100%', maxWidth: 420 }}
                  />
                  <label style={{ fontSize: 13, color: S.dim, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={isTestnet} onChange={(event) => setIsTestnet(event.target.checked)} />
                    É chave da testnet
                  </label>
                  {!isTestnet && (
                    <div style={{ color: S.red, fontSize: 12, maxWidth: 420 }}>
                      ⚠️ Chave da conta REAL: salvar a chave não ativa operações reais. A ativação fica separada nos limites de risco.
                    </div>
                  )}
                  <button
                    onClick={saveKeys}
                    disabled={busy || apiKey.trim().length < 10 || apiSecret.trim().length < 10}
                    style={{
                      background: S.a,
                      color: '#1a1206',
                      border: 'none',
                      borderRadius: 8,
                      padding: '10px 22px',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                      opacity: busy || apiKey.trim().length < 10 || apiSecret.trim().length < 10 ? 0.6 : 1,
                    }}
                  >
                    {busy ? 'Salvando...' : 'Salvar chave'}
                  </button>
                </>
              )}

              {msg && <span style={{ color: msg.ok ? S.green : S.red, fontSize: 13 }}>{msg.text}</span>}

              {balances.length > 0 && (
                <div style={{ fontSize: 12, color: S.dim, lineHeight: 1.6 }}>
                  Saldos: {balances.map((balance) => {
                    const free = Number(balance.free);
                    const locked = Number(balance.locked);
                    return `${balance.asset} ${Number.isFinite(free) ? free.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : balance.free}` +
                      (locked > 0 ? ` (${locked.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} bloqueado)` : '');
                  }).join(' · ')}
                </div>
              )}
            </Card>

            {/* --------------------------- Limites de risco --------------------------- */}
            <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Limites de risco</div>
              <div style={{ fontSize: 12, color: S.dim, maxWidth: 560, lineHeight: 1.5 }}>
                Estes limites são validados novamente no servidor antes de qualquer ordem. Alterar o navegador não ignora as regras.
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Máximo por ordem (USDT)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={riskForm.max_order_usdt}
                    onChange={(event) => setRiskForm((current) => ({ ...current, max_order_usdt: event.target.value }))}
                    style={{ ...inputStyle, width: 150 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Máximo de ordens abertas
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={riskForm.max_open_orders}
                    onChange={(event) => setRiskForm((current) => ({ ...current, max_open_orders: event.target.value }))}
                    style={{ ...inputStyle, width: 150 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Perda diária máxima (USDT)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={riskForm.max_daily_loss_usdt}
                    onChange={(event) => setRiskForm((current) => ({ ...current, max_daily_loss_usdt: event.target.value }))}
                    style={{ ...inputStyle, width: 170 }}
                  />
                </label>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Stop mínimo (%)
                  <input
                    type="number"
                    min="0.01"
                    step="0.1"
                    value={riskForm.min_stop_pct}
                    onChange={(event) => setRiskForm((current) => ({ ...current, min_stop_pct: event.target.value }))}
                    style={{ ...inputStyle, width: 105 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Stop máximo (%)
                  <input
                    type="number"
                    min="0.01"
                    step="0.1"
                    value={riskForm.max_stop_pct}
                    onChange={(event) => setRiskForm((current) => ({ ...current, max_stop_pct: event.target.value }))}
                    style={{ ...inputStyle, width: 105 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Alvo mínimo (%)
                  <input
                    type="number"
                    min="0.01"
                    step="0.1"
                    value={riskForm.min_target_pct}
                    onChange={(event) => setRiskForm((current) => ({ ...current, min_target_pct: event.target.value }))}
                    style={{ ...inputStyle, width: 105 }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Alvo máximo (%)
                  <input
                    type="number"
                    min="0.01"
                    step="0.1"
                    value={riskForm.max_target_pct}
                    onChange={(event) => setRiskForm((current) => ({ ...current, max_target_pct: event.target.value }))}
                    style={{ ...inputStyle, width: 105 }}
                  />
                </label>
              </div>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: riskForm.trading_real_enabled ? S.red : S.dim,
                  fontSize: 13,
                  fontWeight: riskForm.trading_real_enabled ? 700 : 400,
                }}
              >
                <input
                  type="checkbox"
                  checked={riskForm.trading_real_enabled}
                  onChange={(event) => handleRealTradingToggle(event.target.checked)}
                />
                Permitir operações em conta real
              </label>

              <button
                onClick={saveRiskSettings}
                disabled={riskBusy}
                style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: riskBusy ? 0.6 : 1 }}
              >
                {riskBusy ? 'Salvando...' : 'Salvar limites'}
              </button>

              {riskMsg && <span style={{ color: riskMsg.ok ? S.green : S.red, fontSize: 13 }}>{riskMsg.text}</span>}

              <div style={{ fontSize: 11, color: S.dim }}>
                Ordens abertas registradas nesta tela: {openOrdersCount} de {riskSettings.max_open_orders}.
              </div>
            </Card>

            {/* --------------------------- Auto Trade --------------------------- */}
            <Card
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                alignItems: 'center',
                textAlign: 'center',
                borderColor: autoTradeSettings.auto_trade_paused_at
                  ? `${S.red}99`
                  : autoTradeForm.auto_trade_enabled
                    ? `${S.green}88`
                    : S.border,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Auto Trade</div>
                <span
                  style={{
                    padding: '3px 9px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 700,
                    color: autoTradeSettings.auto_trade_paused_at
                      ? S.red
                      : autoTradeForm.auto_trade_enabled
                        ? S.green
                        : S.dim,
                    background: autoTradeSettings.auto_trade_paused_at
                      ? `${S.red}22`
                      : autoTradeForm.auto_trade_enabled
                        ? `${S.green}22`
                        : `${S.dim}18`,
                  }}
                >
                  {autoTradeSettings.auto_trade_paused_at
                    ? 'PAUSADO POR SEGURANÇA'
                    : autoTradeForm.auto_trade_enabled
                      ? 'ATIVADO'
                      : 'DESATIVADO'}
                </span>
              </div>

              <div style={{ fontSize: 12, color: S.dim, maxWidth: 680, lineHeight: 1.55 }}>
                Aceita automaticamente oportunidades elegíveis da Central e reutiliza o motor Binance
                para criar a entrada e a proteção OCO. Pontuação, risco-retorno, limites, saldo,
                preço atual e idempotência são revalidados no servidor.
              </div>

              {autoTradeSettings.auto_trade_paused_at && (
                <div
                  style={{
                    width: '100%',
                    maxWidth: 680,
                    color: S.red,
                    background: `${S.red}0d`,
                    border: `1px solid ${S.red}55`,
                    borderRadius: 8,
                    padding: 12,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <strong>Pausa de segurança:</strong>{' '}
                  {autoTradeSettings.auto_trade_pause_reason || 'Confira a conta diretamente na Binance.'}
                  <div style={{ color: S.dim, marginTop: 4 }}>
                    Desde {fmtData(autoTradeSettings.auto_trade_paused_at)}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Ambiente
                  <select
                    value={autoTradeForm.auto_trade_environment}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_environment: event.target.value === 'real' ? 'real' : 'testnet',
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 150 }}
                  >
                    <option value="testnet">Testnet</option>
                    <option value="real">Conta real</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Valor por operação (USDT)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={autoTradeForm.auto_trade_quote_amount}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_quote_amount: event.target.value,
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 180 }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Pontuação mínima (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={autoTradeForm.auto_trade_min_score_pct}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_min_score_pct: event.target.value,
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 150 }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Risco-retorno mínimo
                  <input
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.1"
                    value={autoTradeForm.auto_trade_min_risk_reward}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_min_risk_reward: event.target.value,
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 160 }}
                  />
                </label>
              </div>

              <div style={{ width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <MultiChipSelect
                  label="Símbolos autorizados"
                  options={AUTO_TRADE_SYMBOL_OPTIONS.map((symbol) => ({ value: symbol, label: symbol }))}
                  selected={autoTradeForm.auto_trade_symbols}
                  disabled={autoTradeBusy}
                  onChange={(next) => setAutoTradeForm((current) => ({
                    ...current,
                    auto_trade_symbols: next,
                  }))}
                  emptyHint="Selecione ao menos um símbolo para ativar."
                />

                <MultiChipSelect
                  label="Timeframes autorizados"
                  options={AUTO_TRADE_TIMEFRAME_OPTIONS.map((timeframe) => ({ value: timeframe, label: timeframe }))}
                  selected={autoTradeForm.auto_trade_timeframes}
                  disabled={autoTradeBusy}
                  onChange={(next) => setAutoTradeForm((current) => ({
                    ...current,
                    auto_trade_timeframes: next,
                  }))}
                  emptyHint="Selecione ao menos um timeframe para ativar."
                />

                <MultiChipSelect
                  label="Estratégias autorizadas"
                  options={AUTO_TRADE_STRATEGY_OPTIONS.map((strategy) => ({ value: strategy.value, label: strategy.label }))}
                  selected={autoTradeForm.auto_trade_strategies}
                  disabled={autoTradeBusy}
                  onChange={(next) => setAutoTradeForm((current) => ({
                    ...current,
                    auto_trade_strategies: next,
                  }))}
                  emptyHint="Selecione ao menos uma estratégia."
                />
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Máximo por dia
                  <input
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                    value={autoTradeForm.auto_trade_max_orders_per_day}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_max_orders_per_day: event.target.value,
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 130 }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Intervalo (minutos)
                  <input
                    type="number"
                    min="0"
                    max="10080"
                    step="1"
                    value={autoTradeForm.auto_trade_cooldown_minutes}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_cooldown_minutes: event.target.value,
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 150 }}
                  />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                  Tentativas por oportunidade
                  <input
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={autoTradeForm.auto_trade_max_attempts}
                    onChange={(event) => setAutoTradeForm((current) => ({
                      ...current,
                      auto_trade_max_attempts: event.target.value,
                    }))}
                    disabled={autoTradeBusy}
                    style={{ ...inputStyle, width: 180 }}
                  />
                </label>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: S.dim, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={autoTradeForm.auto_trade_require_no_warnings}
                  onChange={(event) => setAutoTradeForm((current) => ({
                    ...current,
                    auto_trade_require_no_warnings: event.target.checked,
                  }))}
                  disabled={autoTradeBusy}
                />
                Executar somente oportunidades sem avisos
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  color: autoTradeForm.auto_trade_enabled
                    ? autoTradeForm.auto_trade_environment === 'real' ? S.red : S.green
                    : S.dim,
                  fontSize: 13,
                  fontWeight: autoTradeForm.auto_trade_enabled ? 700 : 400,
                }}
              >
                <input
                  type="checkbox"
                  checked={autoTradeForm.auto_trade_enabled}
                  onChange={(event) => handleAutoTradeToggle(event.target.checked)}
                  disabled={autoTradeBusy}
                />
                Ativar execução automática
              </label>

              {autoTradeForm.auto_trade_enabled && !keyInfo && (
                <div style={{ color: S.red, fontSize: 12 }}>
                  Configure uma chave Binance antes de ativar.
                </div>
              )}

              {autoTradeForm.auto_trade_enabled && keyInfo && (
                (autoTradeForm.auto_trade_environment === 'testnet' && !keyInfo.is_testnet) ||
                (autoTradeForm.auto_trade_environment === 'real' && keyInfo.is_testnet)
              ) && (
                <div style={{ color: S.red, fontSize: 12 }}>
                  O ambiente selecionado não corresponde à chave Binance configurada.
                </div>
              )}

              {autoTradeForm.auto_trade_environment === 'real' && (
                <div style={{ color: S.red, fontSize: 12, maxWidth: 620, lineHeight: 1.5 }}>
                  ⚠️ Em conta real, cada oportunidade elegível poderá movimentar dinheiro sem confirmação individual.
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  onClick={saveAutoTradeSettings}
                  disabled={autoTradeBusy}
                  style={{
                    background: autoTradeForm.auto_trade_enabled ? S.green : S.a,
                    color: '#07140c',
                    border: 'none',
                    borderRadius: 8,
                    padding: '9px 20px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    opacity: autoTradeBusy ? 0.6 : 1,
                  }}
                >
                  {autoTradeBusy ? 'Salvando...' : 'Salvar Auto Trade'}
                </button>

                {autoTradeSettings.auto_trade_paused_at && (
                  <button
                    onClick={resumeAutoTrade}
                    disabled={autoTradeBusy}
                    style={{
                      background: 'transparent',
                      color: S.red,
                      border: `1px solid ${S.red}77`,
                      borderRadius: 8,
                      padding: '9px 20px',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      opacity: autoTradeBusy ? 0.6 : 1,
                    }}
                  >
                    Remover pausa após conferência
                  </button>
                )}
              </div>

              {autoTradeMsg && (
                <span style={{ color: autoTradeMsg.ok ? S.green : S.red, fontSize: 13 }}>
                  {autoTradeMsg.text}
                </span>
              )}

              <div style={{ fontSize: 11, color: S.dim, lineHeight: 1.6 }}>
                {autoTradeSettings.auto_trade_last_run_at && (
                  <div>Último processamento: {fmtData(autoTradeSettings.auto_trade_last_run_at)}</div>
                )}
                {autoTradeSettings.auto_trade_last_success_at && (
                  <div style={{ color: S.green }}>
                    Última execução confirmada: {fmtData(autoTradeSettings.auto_trade_last_success_at)}
                  </div>
                )}
                {autoTradeSettings.auto_trade_last_error && (
                  <div style={{ color: S.red }}>
                    Último erro: {autoTradeSettings.auto_trade_last_error}
                  </div>
                )}
              </div>
            </Card>

            {/* --------------------------- Nova ordem --------------------------- */}
            {keyInfo && (
              <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Nova ordem (entrada + OCO)</div>
                <div style={{ fontSize: 12, color: S.dim, maxWidth: 520, lineHeight: 1.5 }}>
                  Compra a mercado gastando o valor em USDT e registra na Binance uma saída OCO:
                  alvo e stop. Quando uma saída executa, a outra é cancelada pela exchange.
                </div>

                {!keyInfo.is_testnet && !riskSettings.trading_real_enabled && (
                  <div style={{ color: S.red, fontSize: 12, maxWidth: 520 }}>
                    Operações reais bloqueadas. Para liberar, ative explicitamente nos limites de risco e salve a configuração.
                  </div>
                )}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Par
                    <select
                      value={ordSymbol}
                      onChange={(event) => updateOrderField(setOrdSymbol, event.target.value)}
                      disabled={ordBusy || orderBlockedByUnprotected}
                      style={inputStyle}
                    >
                      {['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'].map((symbol) => <option key={symbol}>{symbol}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Gastar (USDT)
                    <input
                      type="number"
                      min="0.01"
                      max={riskSettings.max_order_usdt}
                      step="0.01"
                      value={ordAmount}
                      onChange={(event) => updateOrderField(setOrdAmount, event.target.value)}
                      disabled={ordBusy || orderBlockedByUnprotected}
                      style={{ ...inputStyle, width: 100 }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Stop (−%)
                    <input
                      type="number"
                      min={riskSettings.min_stop_pct}
                      max={riskSettings.max_stop_pct}
                      step="0.1"
                      value={ordStop}
                      onChange={(event) => updateOrderField(setOrdStop, event.target.value)}
                      disabled={ordBusy || orderBlockedByUnprotected}
                      style={{ ...inputStyle, width: 80 }}
                    />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Alvo (+%)
                    <input
                      type="number"
                      min={riskSettings.min_target_pct}
                      max={riskSettings.max_target_pct}
                      step="0.1"
                      value={ordTarget}
                      onChange={(event) => updateOrderField(setOrdTarget, event.target.value)}
                      disabled={ordBusy || orderBlockedByUnprotected}
                      style={{ ...inputStyle, width: 80 }}
                    />
                  </label>
                  <button
                    onClick={placeOrder}
                    disabled={ordBusy || !!orderValidation}
                    style={{
                      background: keyInfo.is_testnet ? S.a : S.red,
                      color: '#1a1206',
                      border: 'none',
                      borderRadius: 8,
                      padding: '10px 22px',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: 'pointer',
                      opacity: ordBusy || orderValidation ? 0.6 : 1,
                    }}
                  >
                    {ordBusy
                      ? 'Enviando...'
                      : orderBlockedByUnprotected
                        ? 'Ordem bloqueada'
                        : activeRequestId
                          ? 'Reenviar com o mesmo ID'
                          : keyInfo.is_testnet
                            ? 'Enviar (testnet)'
                            : riskSettings.trading_real_enabled
                              ? 'Enviar (REAL ⚠️)'
                              : 'REAL bloqueada'}
                  </button>
                </div>

                {orderValidation && !orderBlockedByUnprotected && (
                  <div style={{ fontSize: 12, color: S.red, maxWidth: 540 }}>{orderValidation}</div>
                )}

                {activeRequestId && !orderBlockedByUnprotected && (
                  <div style={{ fontSize: 11, color: S.dim, maxWidth: 540 }}>
                    Solicitação protegida contra duplicidade: <code>{activeRequestId.slice(0, 8)}…</code>
                  </div>
                )}

                {ordResult && (
                  <div
                    style={{
                      fontSize: 13,
                      color: resultColor(ordResult.kind),
                      maxWidth: 560,
                      lineHeight: 1.55,
                      fontWeight: ordResult.kind === 'critical' ? 700 : 400,
                    }}
                  >
                    {ordResult.text}
                  </div>
                )}

                {orderBlockedByUnprotected && (
                  <button
                    onClick={releaseAfterManualCheck}
                    style={{ background: 'transparent', color: S.red, border: `1px solid ${S.red}`, borderRadius: 8, padding: '8px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                  >
                    Já conferi na Binance; liberar nova ordem
                  </button>
                )}
              </Card>
            )}

            {/* --------------------------- Central de Oportunidades --------------------------- */}
            <Card style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Vínculo com a Central</div>

              {centralSchemaAvailable === false ? (
                <div style={{ color: S.dim, fontSize: 12, lineHeight: 1.55, marginTop: 8 }}>
                  O histórico normal continua disponível. Os vínculos com oportunidades aparecerão
                  depois que a migration da Central for aplicada.
                </div>
              ) : (
                <>
                  <div style={{ color: S.dim, fontSize: 12, lineHeight: 1.55, marginTop: 8 }}>
                    {linkedOrdersCount === 0
                      ? 'Nenhuma ordem vinculada a uma oportunidade entre as 15 ordens mais recentes.'
                      : `${linkedOrdersCount} ordem(ns) vinculada(s), sendo ${linkedOpenOrdersCount} ainda aberta(s).`}
                  </div>
                  <a
                    href="/oportunidades"
                    style={{
                      display: 'inline-block',
                      marginTop: 10,
                      color: S.a,
                      textDecoration: 'none',
                      border: `1px solid ${S.a}66`,
                      borderRadius: 8,
                      padding: '7px 14px',
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    Abrir Central de Oportunidades
                  </a>
                </>
              )}
            </Card>

            {/* --------------------------- Histórico de ordens --------------------------- */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Histórico de ordens</div>
                <button
                  onClick={() => void loadOrders()}
                  disabled={ordersLoading}
                  style={{ background: 'transparent', color: S.dim, border: `1px solid ${S.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', opacity: ordersLoading ? 0.6 : 1 }}
                >
                  {ordersLoading ? 'Atualizando...' : 'Atualizar'}
                </button>
              </div>

              {ordersError && (
                <div style={{ color: S.red, fontSize: 12, textAlign: 'center', marginBottom: 10 }}>{ordersError}</div>
              )}

              {orders.length === 0 ? (
                <div style={{ color: S.dim, fontSize: 13, textAlign: 'center' }}>
                  {ordersLoading ? 'Carregando ordens...' : 'Nenhuma ordem registrada ainda.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {orders.map((order) => {
                    const status = STATUS_LABEL[order.status] ?? { label: order.status, color: S.dim };
                    const isUnprotected = order.status === 'entrada_sem_protecao';
                    const opportunityId = isSafeUuid(order.opportunity_id)
                      ? order.opportunity_id
                      : null;
                    const opportunity = opportunityId
                      ? opportunityById[opportunityId] ?? null
                      : null;
                    const opportunityStatus = opportunity
                      ? OPPORTUNITY_STATUS_LABEL[opportunity.lifecycle_status] ?? {
                          label: opportunity.lifecycle_status,
                          color: S.dim,
                        }
                      : null;

                    return (
                      <div
                        key={order.id}
                        style={{
                          border: `1px solid ${isUnprotected ? `${S.red}99` : S.border}`,
                          background: isUnprotected ? `${S.red}0a` : 'transparent',
                          borderRadius: 8,
                          padding: '10px 12px',
                          textAlign: 'center',
                        }}
                      >
                        <div style={{ fontSize: 13 }}>
                          <strong>{order.symbol}</strong>
                          <span style={{ color: order.is_testnet ? S.green : S.red, fontSize: 11 }}>
                            {' '}{order.is_testnet ? 'testnet' : 'REAL'}
                          </span>
                          {' '}· <span style={{ color: status.color, fontWeight: 600 }}>{status.label}</span>
                          {order.pnl_usdt !== null && (
                            <span style={{ color: order.pnl_usdt >= 0 ? S.green : S.red }}>
                              {' '}· {order.pnl_usdt >= 0 ? '+' : ''}{fmt(order.pnl_usdt)} USDT
                            </span>
                          )}
                        </div>
                        {opportunityId && (
                          <div
                            style={{
                              marginTop: 7,
                              padding: '7px 9px',
                              borderRadius: 7,
                              border: `1px solid ${S.blue}44`,
                              background: `${S.blue}0b`,
                              fontSize: 11,
                              lineHeight: 1.5,
                            }}
                          >
                            <div style={{ color: S.text, fontWeight: 600 }}>
                              Oportunidade vinculada
                              {opportunityStatus && (
                                <>
                                  {' '}·{' '}
                                  <span style={{ color: opportunityStatus.color }}>
                                    {opportunityStatus.label}
                                  </span>
                                </>
                              )}
                            </div>
                            {opportunity && (
                              <div style={{ color: S.dim, marginTop: 2 }}>
                                {opportunity.symbol || order.symbol}
                                {opportunity.timeframe && ` · ${opportunity.timeframe}`}
                                {opportunity.strategy && ` · ${opportunity.strategy}`}
                                {opportunity.strategy_version && ` v${opportunity.strategy_version}`}
                                {' · '}
                                {opportunity.execution_environment === 'real' ? 'real' : 'testnet'}
                              </div>
                            )}
                            <a
                              href={`/oportunidades?focus=${encodeURIComponent(opportunityId)}`}
                              style={{
                                color: S.blue,
                                display: 'inline-block',
                                marginTop: 4,
                                textDecoration: 'none',
                                fontWeight: 700,
                              }}
                            >
                              Abrir histórico do cenário
                            </a>
                          </div>
                        )}

                        <div style={{ fontSize: 11, color: S.dim, marginTop: 4, lineHeight: 1.5 }}>
                          {fmtData(order.criado_em)} · gasto {fmt(order.quote_amount)} USDT
                          {order.qty !== null && ` · qtd. ${fmt(order.qty, 8)}`}
                          {order.entry_price !== null && ` · entrada ${fmt(order.entry_price)}`}
                          {order.exit_price !== null && ` · saída ${fmt(order.exit_price)}`}
                          {(order.status === 'oco_ativa' || order.status === 'protecao_pendente') && order.target_price !== null && order.stop_price !== null &&
                            ` · alvo ${fmt(order.target_price)} / stop ${fmt(order.stop_price)}`}
                          {order.binance_status && ` · Binance: ${order.binance_status}`}
                        </div>
                        {(order.unprotected_reason || order.erro) && (
                          <div style={{ fontSize: 11, color: isUnprotected ? S.red : S.dim, marginTop: 4, lineHeight: 1.45 }}>
                            {(order.unprotected_reason || order.erro || '').slice(0, 240)}
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: S.dim, marginTop: 4 }}>
                          {order.request_id && <>ID {order.request_id.slice(0, 8)}…</>}
                          {order.protected_at && <> · protegida em {fmtData(order.protected_at)}</>}
                          {order.last_checked_at && <> · verificada em {fmtData(order.last_checked_at)}</>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ fontSize: 11, color: S.dim, textAlign: 'center', marginTop: 10, lineHeight: 1.5 }}>
                O histórico reflete os registros do Supabase. Enquanto a função <code>monitorar-ordens</code> não estiver ativa,
                confirme diretamente na Binance se alvo, stop ou cancelamento foram executados.
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}