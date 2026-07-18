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

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError('');

    const { data, error } = await supabase
      .from('orders')
      .select('id, symbol, status, is_testnet, quote_amount, qty, entry_price, exit_price, stop_price, target_price, pnl_usdt, erro, criado_em, request_id, protected_at, last_checked_at, binance_status, unprotected_reason')
      .order('criado_em', { ascending: false })
      .limit(15);

    if (error) {
      setOrdersError(`Não foi possível carregar as ordens: ${error.message}`);
      setOrdersLoading(false);
      return;
    }

    const loadedOrders = Array.isArray(data) ? data.map(normalizeOrder) : [];
    setOrders(loadedOrders);
    if (!loadedOrders.some((order) => order.status === 'entrada_sem_protecao')) {
      setAcknowledgedStoredRisk(false);
    }
    setOrdersLoading(false);
  }, [supabase]);

  const loadAccountData = useCallback(async () => {
    setAccountLoading(true);
    setMsg(null);

    const results = await Promise.allSettled([
      loadKeyStatus(),
      loadRiskSettings(),
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
  }, [loadKeyStatus, loadOrders, loadRiskSettings]);

  useEffect(() => {
    if (!session) return;
    void loadAccountData();
  }, [session, loadAccountData]);

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
        await supabase
          .from('user_settings')
          .update({ trading_real_enabled: false })
          .eq('user_id', session.user.id);
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
    const { data } = await supabase
      .from('orders')
      .select('id, symbol, status, is_testnet, quote_amount, qty, entry_price, exit_price, stop_price, target_price, pnl_usdt, erro, criado_em, request_id, protected_at, last_checked_at, binance_status, unprotected_reason')
      .eq('request_id', requestId)
      .maybeSingle();

    return data ? normalizeOrder(data) : null;
  }, [supabase]);

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
            Entre primeiro em <a href="/alertas" style={{ color: S.a }}>/alertas</a> para acessar esta página.
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
                  <div style={{ fontSize: 13 }}>
                    Configurada: <code style={{ color: S.a }}>{keyInfo.api_key_masked ?? '••••••'}</code>{' '}
                    <span
                      style={{
                        marginLeft: 6,
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
                O histórico reflete os 3 últimos registros. Também confirme
                diretamente na Binance se alvo, stop ou cancelamento foram executados por garantia.
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
