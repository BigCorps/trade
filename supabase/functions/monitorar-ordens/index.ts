// ============================================================================
// VigIA Trade — Edge Function: monitorar-ordens
// supabase/functions/monitorar-ordens/index.ts
// ============================================================================
// Reconcilia ordens Binance, mantém o diário Day Trade e sincroniza a Central
// de Oportunidades em tempo real. A função é idempotente e nunca cria entradas.
//
// Segurança:
// - publique com verify_jwt = false, pois é acionada pelo cron;
// - toda chamada exige x-cron-secret igual ao secret CRON_SECRET;
// - chaves Binance são lidas somente com service_role e descriptografadas em
//   memória;
// - nenhuma credencial é retornada na resposta;
// - falhas de consulta nunca são interpretadas automaticamente como alvo/stop;
// - reconcilia position_sizing_decisions, risco real, equivalente de risco fixo
//   e efeito do anti-martingale depois do encerramento;
// - pausa o Auto Trade ao atingir o limite configurado de perdas consecutivas.
//
// Esta Edge é autocontida: toda a lógica necessária permanece neste index.ts.
// ============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const REAL_BASE = 'https://api.binance.com';
const TESTNET_BASE = 'https://testnet.binance.vision';
const MONITORED_STATUSES = [
  'entrada_enviada',
  'entrada_executada',
  'protecao_pendente',
  'entrada_sem_protecao',
  'oco_ativa',
];
const TERMINAL_ORDER_STATUSES = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH']);
const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 12_000;
const TERMINAL_DB_STATUSES = ['alvo_executado', 'stop_executado', 'cancelada', 'erro_pre_entrada', 'erro'];

interface DbOrder {
  id: string;
  user_id: string;
  is_testnet: boolean;
  symbol: string;
  quote_amount: number | string;
  qty: number | string | null;
  entry_price: number | string | null;
  stop_price: number | string | null;
  target_price: number | string | null;
  entry_order_id: number | string | null;
  oco_list_id: number | string | null;
  status: string;
  erro: string | null;
  raw: Record<string, unknown> | null;
  client_order_id: string | null;
  list_client_order_id: string | null;
  protected_at: string | null;
  last_checked_at: string | null;
  binance_status: string | null;
  unprotected_reason: string | null;
  exit_price: number | string | null;
  pnl_usdt: number | string | null;
  fechado_em: string | null;
  criado_em: string;
  request_id: string | null;
  opportunity_id: string | null;
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

interface ExchangeKeys {
  user_id: string;
  api_key: string;
  api_secret_enc: string;
  is_testnet: boolean;
}

interface BinanceOrder {
  symbol?: string;
  orderId?: number;
  orderListId?: number;
  clientOrderId?: string;
  price?: string;
  origQty?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  status?: string;
  type?: string;
  side?: string;
  stopPrice?: string;
  time?: number;
  updateTime?: number;
  workingTime?: number;
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
}


interface BinanceTrade {
  id?: number;
  orderId?: number;
  price?: string;
  qty?: string;
  quoteQty?: string;
  commission?: string;
  commissionAsset?: string;
  time?: number;
  isBuyer?: boolean;
  isMaker?: boolean;
}

interface DayTradeJournal {
  id: string;
  user_id: string;
  order_id: string | null;
  mode: string;
  status: string;
  entry_reference: number | string;
  stop_reference: number | string;
  target_reference: number | string;
  planned_quantity: number | string | null;
  risk_usdt: number | string | null;
  risk_percent: number | string | null;
  entry_price: number | string | null;
  exit_price: number | string | null;
  quantity: number | string | null;
  fees_usdt: number | string | null;
  pnl_usdt: number | string | null;
  result_r: number | string | null;
  aberto_em: string | null;
  fechado_em: string | null;
  position_sizing_decision_id: string | null;
  sizing_mode: 'fixed' | 'anti_martingale' | 'martingale_testnet';
  base_risk_percent: number | string | null;
  applied_risk_percent: number | string | null;
  risk_multiplier: number | string;
  fixed_risk_equivalent_pnl_usdt: number | string | null;
  sizing_effect_pnl_usdt: number | string | null;
  sizing_snapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}



interface TradeOpportunity {
  id: string;
  user_id: string;
  lifecycle_status: string;
  execution_environment: string;
  entry_reference: number | string | null;
  stop_reference: number | string | null;
  target_reference: number | string | null;
  quote_amount: number | string | null;
  opened_at: string | null;
  closed_at: string | null;
  strategy: string;
  strategy_version: string;
  position_sizing_decision_id: string | null;
  sizing_snapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

interface OpportunityOutcome {
  id: string;
  status: string;
  entry_price: number | string | null;
  entry_at: string | null;
  exit_price: number | string | null;
  exit_at: string | null;
  fees_usdt: number | string | null;
  slippage_usdt: number | string | null;
  metadata: Record<string, unknown> | null;
  target_hit_at: string | null;
  stop_hit_at: string | null;
  resolved_at: string | null;
  position_sizing_decision_id: string | null;
  fixed_risk_equivalent_pnl_usdt: number | string | null;
  sizing_effect_pnl_usdt: number | string | null;
  sizing_snapshot: Record<string, unknown> | null;
}

interface ExecutionMetrics {
  entryPrice: number | null;
  exitPrice: number | null;
  quantity: number | null;
  feesUsdt: number;
  feesComplete: boolean;
  grossPnlUsdt: number | null;
  netPnlUsdt: number | null;
  grossPnlPct: number | null;
  netPnlPct: number | null;
  riskUsdt: number | null;
  actualRiskUsdt: number | null;
  resultR: number | null;
  fixedRiskEquivalentPnlUsdt: number | null;
  sizingEffectPnlUsdt: number | null;
  slippageUsdt: number;
  openedAt: string | null;
  closedAt: string | null;
  entrySummary: TradeSummary | null;
  exitSummary: TradeSummary | null;
}

interface TradeSummary {
  quantity: number | null;
  quoteQuantity: number | null;
  averagePrice: number | null;
  feesUsdt: number;
  feesComplete: boolean;
  source: 'myTrades' | 'raw_entry' | 'unavailable';
  unresolvedCommissions: Array<{ asset: string; amount: number }>;
  estimatedCommissionAssets: string[];
  firstTradeAt: string | null;
  lastTradeAt: string | null;
}

type BinanceCtx = {
  base: string;
  apiKey: string;
  secret: string;
  offset: number;
};

type MonitorSummary = {
  selecionadas: number;
  verificadas: number;
  abertas: number;
  reconciliadas: number;
  alvos: number;
  stops: number;
  sem_protecao: number;
  canceladas: number;
  erros: number;
  diarios_atualizados: number;
  diarios_fechados: number;
  taxas_incompletas: number;
  erros_diario: number;
  oportunidades_atualizadas: number;
  oportunidades_fechadas: number;
  resultados_executados_atualizados: number;
  eventos_oportunidade: number;
  sizing_decisions_synced: number;
  sizing_results_resolved: number;
  auto_trade_pauses: number;
  erros_sizing: number;
  erros_oportunidade: number;
  sizing_errors: Array<{ order_id: string; decision_id: string | null; error: string }>;
  opportunity_errors: Array<{ order_id: string; opportunity_id: string | null; error: string }>;
};

class BinanceError extends Error {
  status: number;
  code: number | null;
  payload: unknown;

  constructor(status: number, message: string, code: number | null, payload: unknown) {
    super(message);
    this.name = 'BinanceError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' };
const nowIso = () => new Date().toISOString();
const truncate = (value: unknown, max = 500) => String(value ?? '').slice(0, max);
const finite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const positive = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
};

function mergeObjects(
  first: Record<string, unknown> | null | undefined,
  second: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(first ?? {}), ...second };
}

function sizingSnapshotForOrder(
  order: DbOrder,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return mergeObjects(asRecord(order.sizing_snapshot), {
    decision_id: order.position_sizing_decision_id,
    sizing_mode: order.sizing_mode,
    base_risk_percent: finite(order.base_risk_percent),
    target_risk_percent: finite(order.target_risk_percent),
    applied_risk_percent: finite(order.applied_risk_percent),
    risk_multiplier: finite(order.risk_multiplier) ?? 1,
    planned_risk_usdt: finite(order.planned_risk_usdt),
    actual_risk_usdt: finite(order.actual_risk_usdt),
    ...extra,
  });
}

function fixedRiskEquivalentPnl(
  order: DbOrder,
  netPnlUsdt: number | null,
): number | null {
  if (netPnlUsdt === null) return null;
  if (order.sizing_mode === 'fixed') return netPnlUsdt;

  const baseRisk = positive(order.base_risk_percent);
  const appliedRisk = positive(order.applied_risk_percent);
  if (baseRisk === null || appliedRisk === null) return null;
  return netPnlUsdt * baseRisk / appliedRisk;
}

function calculateActualRiskUsdt(
  order: DbOrder,
  entryPrice: number | null,
  quantity: number | null,
  entryFeesUsdt = 0,
): number | null {
  const stored = positive(order.actual_risk_usdt);
  if (stored !== null) return stored;

  const stop = finite(order.stop_price);
  if (entryPrice === null || stop === null || quantity === null || quantity <= 0) {
    return positive(order.planned_risk_usdt);
  }

  const priceRisk = Math.max(0, entryPrice - stop) * quantity;
  const total = priceRisk + Math.max(0, entryFeesUsdt);
  return total > 0 ? total : positive(order.planned_risk_usdt);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function fetchTimeout(url: string, init: RequestInit = {}, ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAesKey(): Promise<CryptoKey> {
  const hex = Deno.env.get('ENCRYPTION_KEY');
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY ausente ou inválida.');
  }
  const raw = new Uint8Array(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
}

async function decrypt(ciphertext: string): Promise<string> {
  const key = await getAesKey();
  const bytes = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
  if (bytes.length <= 12) throw new Error('credencial criptografada inválida');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

async function hmac(secret: string, query: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(query));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getOffset(base: string): Promise<number> {
  const response = await fetchTimeout(`${base}/api/v3/time`);
  if (!response.ok) throw new Error(`Binance time ${response.status}`);
  const payload = await response.json();
  const serverTime = finite(payload?.serverTime);
  if (serverTime === null) throw new Error('horário inválido retornado pela Binance');
  return serverTime - Date.now();
}

async function signed(
  ctx: BinanceCtx,
  path: string,
  params: Record<string, string | number>,
): Promise<any> {
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
    timestamp: String(Date.now() + ctx.offset),
    recvWindow: '10000',
  });
  query.append('signature', await hmac(ctx.secret, query.toString()));

  const response = await fetchTimeout(`${ctx.base}${path}?${query}`, {
    method: 'GET',
    headers: { 'X-MBX-APIKEY': ctx.apiKey },
  });
  const text = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { msg: text.slice(0, 300) };
  }

  if (!response.ok) {
    const code = finite(payload?.code);
    const message = truncate(payload?.msg ?? payload?.message ?? text, 300);
    throw new BinanceError(response.status, `Binance ${response.status} em ${path}: ${message}`, code, payload);
  }
  return payload;
}

function isNotFound(error: unknown): boolean {
  return error instanceof BinanceError && [-2011, -2013].includes(error.code ?? 0);
}

async function getOrderList(ctx: BinanceCtx, order: DbOrder): Promise<BinanceOrderList | null> {
  const params: Record<string, string | number> = {};
  if (order.oco_list_id !== null) params.orderListId = String(order.oco_list_id);
  else if (order.list_client_order_id) params.origClientOrderId = order.list_client_order_id;
  else return null;

  try {
    return await signed(ctx, '/api/v3/orderList', params) as BinanceOrderList;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function getSingleOrder(ctx: BinanceCtx, order: DbOrder): Promise<BinanceOrder | null> {
  const params: Record<string, string | number> = { symbol: order.symbol };
  if (order.entry_order_id !== null) params.orderId = String(order.entry_order_id);
  else if (order.client_order_id) params.origClientOrderId = order.client_order_id;
  else return null;

  try {
    return await signed(ctx, '/api/v3/order', params) as BinanceOrder;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function getOrderDetails(ctx: BinanceCtx, list: BinanceOrderList): Promise<BinanceOrder[]> {
  const orders = Array.isArray(list.orders) ? list.orders : [];
  const details: BinanceOrder[] = [];
  for (const item of orders.slice(0, 4)) {
    if (!item.orderId || !item.symbol) continue;
    try {
      details.push(await signed(ctx, '/api/v3/order', {
        symbol: item.symbol,
        orderId: item.orderId,
      }) as BinanceOrder);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return details;
}

function classifyLeg(order: BinanceOrder, dbOrder: DbOrder): 'stop' | 'target' | 'unknown' {
  const type = String(order.type ?? '').toUpperCase();
  const stopPrice = finite(order.stopPrice) ?? 0;
  if (type.includes('STOP') || stopPrice > 0) return 'stop';
  if (type.includes('LIMIT') || type.includes('TAKE_PROFIT')) return 'target';

  const price = finite(order.price);
  const stop = finite(dbOrder.stop_price);
  const target = finite(dbOrder.target_price);
  if (price !== null && stop !== null && target !== null) {
    return Math.abs(price - stop) < Math.abs(price - target) ? 'stop' : 'target';
  }
  return 'unknown';
}

function listStatus(list: BinanceOrderList, details: BinanceOrder[]): string {
  const legs = details.map((item) => `${item.type ?? 'ORDEM'}:${item.status ?? 'DESCONHECIDO'}`).join('|');
  return truncate(
    [list.listStatusType, list.listOrderStatus, legs].filter(Boolean).join(' / ') || 'OCO_LOCALIZADA',
    250,
  );
}

function mergeRaw(order: DbOrder, monitor: Record<string, unknown>) {
  const existing = order.raw && typeof order.raw === 'object' && !Array.isArray(order.raw) ? order.raw : {};
  return { ...existing, monitor };
}

const ORDER_SELECT = [
  'id',
  'user_id',
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
  'request_id',
  'client_order_id',
  'list_client_order_id',
  'protected_at',
  'last_checked_at',
  'binance_status',
  'unprotected_reason',
  'exit_price',
  'pnl_usdt',
  'fechado_em',
  'criado_em',
  'opportunity_id',
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoFromMs(value: unknown): string | null {
  const ms = finite(value);
  return ms !== null && ms > 0 ? new Date(ms).toISOString() : null;
}

function journalStatus(orderStatus: string): string {
  switch (orderStatus) {
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

function symbolAssets(symbol: string): { baseAsset: string; quoteAsset: string } {
  if (!symbol.endsWith('USDT') || symbol.length <= 4) {
    return { baseAsset: '', quoteAsset: 'USDT' };
  }
  return { baseAsset: symbol.slice(0, -4), quoteAsset: 'USDT' };
}

function rawEntryTrades(order: DbOrder): BinanceTrade[] {
  const raw = asRecord(order.raw);
  const entry = asRecord(raw?.entry);
  const fills = Array.isArray(entry?.fills) ? entry.fills : [];
  const orderId = finite(entry?.orderId) ?? finite(order.entry_order_id);
  const transactTime = finite(entry?.transactTime) ?? finite(entry?.workingTime);

  return fills.flatMap((item, index) => {
    const fill = asRecord(item);
    if (!fill) return [];
    const price = finite(fill.price);
    const qty = finite(fill.qty);
    if (price === null || qty === null || price <= 0 || qty <= 0) return [];
    return [{
      id: finite(fill.tradeId) ?? index,
      orderId: orderId ?? undefined,
      price: String(price),
      qty: String(qty),
      quoteQty: String(price * qty),
      commission: String(Math.max(0, finite(fill.commission) ?? 0)),
      commissionAsset: String(fill.commissionAsset ?? ''),
      time: transactTime ?? undefined,
      isBuyer: true,
      isMaker: Boolean(fill.isMaker),
    } satisfies BinanceTrade];
  });
}

function filledExitOrder(order: DbOrder): BinanceOrder | null {
  const raw = asRecord(order.raw);
  const monitor = asRecord(raw?.monitor);
  const details = Array.isArray(monitor?.orders) ? monitor.orders : [];
  for (const item of details) {
    const detail = asRecord(item);
    if (!detail || String(detail.status ?? '').toUpperCase() !== 'FILLED') continue;
    return detail as unknown as BinanceOrder;
  }
  return null;
}

async function getAccountTrades(
  ctx: BinanceCtx,
  symbol: string,
  orderId: number | string | null,
): Promise<BinanceTrade[]> {
  if (orderId === null || orderId === undefined || String(orderId) === '') return [];
  const payload = await signed(ctx, '/api/v3/myTrades', {
    symbol,
    orderId: String(orderId),
    limit: 1000,
  });
  return Array.isArray(payload) ? payload as BinanceTrade[] : [];
}

async function assetPriceUsdt(
  ctx: BinanceCtx,
  asset: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  if (asset === 'USDT') return 1;
  if (cache.has(asset)) return cache.get(asset) ?? null;

  try {
    const response = await fetchTimeout(
      `${ctx.base}/api/v3/ticker/price?symbol=${encodeURIComponent(`${asset}USDT`)}`,
    );
    if (!response.ok) {
      cache.set(asset, null);
      return null;
    }
    const payload = await response.json();
    const price = finite(payload?.price);
    const valid = price !== null && price > 0 ? price : null;
    cache.set(asset, valid);
    return valid;
  } catch {
    cache.set(asset, null);
    return null;
  }
}

async function summarizeTrades(
  trades: BinanceTrade[],
  source: TradeSummary['source'],
  baseAsset: string,
  quoteAsset: string,
  ctx: BinanceCtx | null,
  priceCache: Map<string, number | null>,
): Promise<TradeSummary> {
  let quantity = 0;
  let quoteQuantity = 0;
  let feesUsdt = 0;
  let feesComplete = true;
  const unresolvedCommissions: Array<{ asset: string; amount: number }> = [];
  const estimatedAssets = new Set<string>();
  const times: number[] = [];

  for (const trade of trades) {
    const price = finite(trade.price);
    const qty = finite(trade.qty);
    const quote = finite(trade.quoteQty) ?? (
      price !== null && qty !== null ? price * qty : null
    );
    if (qty !== null && qty > 0) quantity += qty;
    if (quote !== null && quote > 0) quoteQuantity += quote;
    const tradeTime = finite(trade.time);
    if (tradeTime !== null && tradeTime > 0) times.push(tradeTime);

    const commission = Math.max(0, finite(trade.commission) ?? 0);
    const asset = String(trade.commissionAsset ?? '').toUpperCase();
    if (commission <= 0) continue;

    if (asset === quoteAsset) {
      feesUsdt += commission;
      continue;
    }
    if (asset === baseAsset && price !== null && price > 0) {
      feesUsdt += commission * price;
      continue;
    }
    if (ctx && asset) {
      const conversion = await assetPriceUsdt(ctx, asset, priceCache);
      if (conversion !== null) {
        feesUsdt += commission * conversion;
        estimatedAssets.add(asset);
        continue;
      }
    }

    feesComplete = false;
    unresolvedCommissions.push({ asset: asset || 'DESCONHECIDO', amount: commission });
  }

  return {
    quantity: quantity > 0 ? quantity : null,
    quoteQuantity: quoteQuantity > 0 ? quoteQuantity : null,
    averagePrice: quantity > 0 && quoteQuantity > 0 ? quoteQuantity / quantity : null,
    feesUsdt,
    feesComplete,
    source,
    unresolvedCommissions,
    estimatedCommissionAssets: [...estimatedAssets],
    firstTradeAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastTradeAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

async function tradeSummaryForOrder(
  ctx: BinanceCtx | null,
  order: DbOrder,
  orderId: number | string | null,
  fallback: BinanceTrade[],
  priceCache: Map<string, number | null>,
): Promise<TradeSummary> {
  const { baseAsset, quoteAsset } = symbolAssets(order.symbol);
  if (ctx && orderId !== null) {
    try {
      const trades = await getAccountTrades(ctx, order.symbol, orderId);
      if (trades.length) {
        return summarizeTrades(trades, 'myTrades', baseAsset, quoteAsset, ctx, priceCache);
      }
    } catch (error) {
      console.warn(`myTrades indisponível para ordem ${order.id}:`, error);
    }
  }
  if (fallback.length) {
    return summarizeTrades(fallback, 'raw_entry', baseAsset, quoteAsset, ctx, priceCache);
  }
  return summarizeTrades([], 'unavailable', baseAsset, quoteAsset, ctx, priceCache);
}

function mergeJournalMetadata(
  current: Record<string, unknown> | null,
  monitoring: Record<string, unknown>,
): Record<string, unknown> {
  const existing = current && typeof current === 'object' && !Array.isArray(current)
    ? current
    : {};
  return { ...existing, monitorar_ordens: monitoring };
}

async function syncDayTradeJournal(
  admin: any,
  order: DbOrder,
  ctx: BinanceCtx | null,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
) {
  try {
    const { data, error } = await admin
      .from('daytrade_journal')
      .select('id,user_id,order_id,mode,status,entry_reference,stop_reference,target_reference,planned_quantity,risk_usdt,risk_percent,entry_price,exit_price,quantity,fees_usdt,pnl_usdt,result_r,aberto_em,fechado_em,position_sizing_decision_id,sizing_mode,base_risk_percent,applied_risk_percent,risk_multiplier,fixed_risk_equivalent_pnl_usdt,sizing_effect_pnl_usdt,sizing_snapshot,metadata')
      .eq('order_id', order.id)
      .maybeSingle();

    if (error) {
      if (error.code === '42P01' || String(error.message ?? '').includes('daytrade_journal')) return;
      throw new Error(error.message);
    }
    if (!data) return;

    const journal = data as DayTradeJournal;
    const mappedStatus = journalStatus(order.status);
    const terminal = orderHasClosedPosition(order);
    const exitOrder = filledExitOrder(order);
    const priceCache = new Map<string, number | null>();
    const entrySummary = terminal
      ? await tradeSummaryForOrder(
        ctx,
        order,
        order.entry_order_id,
        rawEntryTrades(order),
        priceCache,
      )
      : null;
    const exitSummary = terminal
      ? await tradeSummaryForOrder(
        ctx,
        order,
        finite(exitOrder?.orderId),
        [],
        priceCache,
      )
      : null;

    const entryPrice = entrySummary?.averagePrice ?? finite(order.entry_price) ?? finite(journal.entry_price);
    const exitPrice = exitSummary?.averagePrice ?? finite(order.exit_price) ?? finite(journal.exit_price);
    const quantity = exitSummary?.quantity ?? finite(order.qty) ?? finite(journal.quantity);
    const existingFees = Math.max(0, finite(journal.fees_usdt) ?? 0);
    const calculatedFees = (entrySummary?.feesUsdt ?? 0) + (exitSummary?.feesUsdt ?? 0);
    const hasFeeEvidence = Boolean(
      entrySummary && entrySummary.source !== 'unavailable' ||
      exitSummary && exitSummary.source !== 'unavailable'
    );
    const feesUsdt = terminal && hasFeeEvidence ? calculatedFees : existingFees;
    const grossPnl = terminal && entryPrice !== null && exitPrice !== null && quantity !== null && quantity > 0
      ? (exitPrice - entryPrice) * quantity
      : null;
    const netPnl = grossPnl !== null ? grossPnl - feesUsdt : finite(journal.pnl_usdt);
    const plannedRisk = positive(order.planned_risk_usdt) ?? positive(journal.risk_usdt);
    const fallbackRiskQuantity = finite(journal.planned_quantity) ?? quantity;
    const riskPerUnit = finite(journal.entry_reference) !== null && finite(journal.stop_reference) !== null
      ? Math.max(0, Number(journal.entry_reference) - Number(journal.stop_reference))
      : null;
    const calculatedFallbackRisk = riskPerUnit !== null && fallbackRiskQuantity !== null && fallbackRiskQuantity > 0
      ? riskPerUnit * fallbackRiskQuantity
      : null;
    const actualRiskUsdt = calculateActualRiskUsdt(
      order,
      entryPrice,
      quantity,
      entrySummary?.feesUsdt ?? 0,
    );
    const riskUsdt = actualRiskUsdt ?? plannedRisk ?? calculatedFallbackRisk;
    const resultR = terminal && netPnl !== null && riskUsdt !== null && riskUsdt > 0
      ? netPnl / riskUsdt
      : finite(journal.result_r);
    const fixedEquivalent = fixedRiskEquivalentPnl(order, terminal ? netPnl : null);
    const sizingEffect = terminal && netPnl !== null && fixedEquivalent !== null
      ? netPnl - fixedEquivalent
      : null;
    const feesComplete = terminal
      ? Boolean(entrySummary?.feesComplete && exitSummary?.feesComplete && hasFeeEvidence)
      : true;
    const openedAt = journal.aberto_em
      ?? entrySummary?.firstTradeAt
      ?? isoFromMs(asRecord(asRecord(order.raw)?.entry)?.transactTime)
      ?? order.criado_em;
    const closedAt = order.fechado_em ?? journal.fechado_em;

    const update: Record<string, unknown> = {
      status: mappedStatus,
      entry_price: entryPrice,
      quantity,
      risk_usdt: riskUsdt,
      risk_percent: finite(order.applied_risk_percent) ?? finite(journal.risk_percent),
      position_sizing_decision_id:
        order.position_sizing_decision_id ?? journal.position_sizing_decision_id,
      sizing_mode: order.sizing_mode ?? journal.sizing_mode ?? 'fixed',
      base_risk_percent:
        finite(order.base_risk_percent) ?? finite(journal.base_risk_percent),
      applied_risk_percent:
        finite(order.applied_risk_percent) ?? finite(journal.applied_risk_percent),
      risk_multiplier:
        finite(order.risk_multiplier) ?? finite(journal.risk_multiplier) ?? 1,
      sizing_snapshot: sizingSnapshotForOrder(order, {
        synced_at: nowIso(),
        actual_risk_usdt: actualRiskUsdt,
      }),
      aberto_em: openedAt,
      metadata: mergeJournalMetadata(journal.metadata, {
        version: 3,
        synced_at: nowIso(),
        order_status: order.status,
        binance_status: order.binance_status,
        gross_pnl_usdt: grossPnl,
        net_pnl_usdt: terminal ? netPnl : null,
        actual_risk_usdt: actualRiskUsdt,
        result_r: terminal ? resultR : null,
        fixed_risk_equivalent_pnl_usdt: fixedEquivalent,
        sizing_effect_pnl_usdt: sizingEffect,
        position_sizing_decision_id: order.position_sizing_decision_id,
        sizing_mode: order.sizing_mode,
        fees_usdt: terminal ? feesUsdt : null,
        fees_complete: feesComplete,
        entry_trade_source: entrySummary?.source ?? null,
        exit_trade_source: exitSummary?.source ?? null,
        estimated_commission_assets: [
          ...(entrySummary?.estimatedCommissionAssets ?? []),
          ...(exitSummary?.estimatedCommissionAssets ?? []),
        ],
        unresolved_commissions: [
          ...(entrySummary?.unresolvedCommissions ?? []),
          ...(exitSummary?.unresolvedCommissions ?? []),
        ],
      }),
    };

    if (terminal) {
      update.exit_price = exitPrice;
      update.fees_usdt = feesUsdt;
      update.pnl_usdt = netPnl;
      update.result_r = resultR;
      update.fixed_risk_equivalent_pnl_usdt = fixedEquivalent;
      update.sizing_effect_pnl_usdt = sizingEffect;
      update.fechado_em = closedAt ?? nowIso();
    } else if (mappedStatus === 'cancelada') {
      update.fechado_em = closedAt ?? nowIso();
    }

    const { error: updateError } = await admin
      .from('daytrade_journal')
      .update(update)
      .eq('id', journal.id);
    if (updateError) throw new Error(updateError.message);

    summary.diarios_atualizados++;
    if (terminal) summary.diarios_fechados++;
    if (terminal && !feesComplete) summary.taxas_incompletas++;
  } catch (error) {
    const message = truncate(error instanceof Error ? error.message : error, 500);
    summary.erros_diario++;
    journalErrors.push({ order_id: order.id, error: message });
    console.error(`Falha ao sincronizar diário da ordem ${order.id}:`, error);
  }
}


function isMissingOpportunitySchema(error: unknown): boolean {
  const record = asRecord(error);
  const code = String(record?.code ?? '');
  const message = String(record?.message ?? error ?? '').toLowerCase();
  return code === '42P01' || code === '42703' ||
    message.includes('trade_opportunities') ||
    message.includes('opportunity_outcomes') ||
    message.includes('opportunity_events') ||
    message.includes('opportunity_id');
}

function storedEntrySummary(order: DbOrder): TradeSummary | null {
  const raw = asRecord(order.raw);
  const entrySummary = asRecord(raw?.entry_summary);
  if (!entrySummary) return null;

  const quantity = finite(entrySummary.quantity) ?? finite(order.qty);
  const quoteQuantity = finite(entrySummary.quoteSpent);
  const averagePrice = finite(entrySummary.averagePrice) ?? finite(order.entry_price);
  const feesUsdt = Math.max(0, finite(entrySummary.feesUsdt) ?? 0);
  const unresolvedRaw = Array.isArray(entrySummary.unresolvedFees)
    ? entrySummary.unresolvedFees
    : [];
  const unresolvedCommissions = unresolvedRaw.flatMap((item) => {
    const row = asRecord(item);
    if (!row) return [];
    const amount = finite(row.amount ?? row.commission);
    if (amount === null || amount <= 0) return [];
    return [{ asset: String(row.asset ?? row.commissionAsset ?? 'DESCONHECIDO'), amount }];
  });
  const entryAt = typeof entrySummary.entryAt === 'string'
    ? entrySummary.entryAt
    : isoFromMs(asRecord(raw?.entry)?.transactTime);

  if (quantity === null && averagePrice === null && feesUsdt === 0) return null;

  return {
    quantity,
    quoteQuantity: quoteQuantity ?? (
      quantity !== null && averagePrice !== null
        ? quantity * averagePrice
        : null
    ),
    averagePrice,
    feesUsdt,
    feesComplete: unresolvedCommissions.length === 0,
    source: 'raw_entry',
    unresolvedCommissions,
    estimatedCommissionAssets: [],
    firstTradeAt: entryAt,
    lastTradeAt: entryAt,
  };
}

function orderOpenedAt(order: DbOrder): string | null {
  const raw = asRecord(order.raw);
  const summary = asRecord(raw?.entry_summary);
  return (
    (typeof summary?.entryAt === 'string' ? summary.entryAt : null) ??
    isoFromMs(asRecord(raw?.entry)?.transactTime) ??
    (finite(order.entry_price) !== null ? order.criado_em : null)
  );
}

function orderHasClosedPosition(order: DbOrder): boolean {
  if (order.status === 'alvo_executado' || order.status === 'stop_executado') return true;
  return Boolean(
    order.fechado_em &&
    finite(order.exit_price) !== null &&
    finite(order.entry_price) !== null &&
    finite(order.qty) !== null
  );
}

function outcomeStatusForOrder(order: DbOrder): string {
  if (order.status === 'alvo_executado') return 'target_hit';
  if (order.status === 'stop_executado') return 'stop_hit';
  if (orderHasClosedPosition(order)) return 'manual_exit';
  if (order.status === 'cancelada') return 'cancelled';
  if (order.status === 'erro' || order.status === 'erro_pre_entrada') return 'error';
  return 'tracking';
}

function lifecycleForOrder(order: DbOrder): string {
  if (order.status === 'alvo_executado' || order.status === 'stop_executado' || orderHasClosedPosition(order)) {
    return 'closed';
  }
  if (order.status === 'oco_ativa') return 'open';
  if (['entrada_enviada', 'entrada_executada', 'protecao_pendente'].includes(order.status)) {
    return 'opening';
  }
  if (['entrada_sem_protecao', 'erro', 'erro_pre_entrada', 'cancelada'].includes(order.status)) {
    return 'error';
  }
  return 'opening';
}

function eventTypeForOrder(order: DbOrder): string | null {
  if (order.status === 'alvo_executado') return 'target_hit';
  if (order.status === 'stop_executado') return 'stop_hit';
  if (orderHasClosedPosition(order)) return 'position_closed';
  if (order.status === 'oco_ativa') return 'position_opened';
  if (order.status === 'entrada_sem_protecao') return 'protection_lost';
  if (order.status === 'cancelada') return 'entry_cancelled';
  if (order.status === 'erro' || order.status === 'erro_pre_entrada') return 'order_error';
  return null;
}

async function calculateExecutionMetrics(
  order: DbOrder,
  opportunity: TradeOpportunity,
  existingOutcome: OpportunityOutcome | null,
  ctx: BinanceCtx | null,
): Promise<ExecutionMetrics> {
  const closed = orderHasClosedPosition(order);
  const exitOrder = filledExitOrder(order);
  const priceCache = new Map<string, number | null>();
  const storedSummary = storedEntrySummary(order);

  const entrySummary = closed
    ? await tradeSummaryForOrder(
      ctx,
      order,
      order.entry_order_id,
      rawEntryTrades(order),
      priceCache,
    )
    : storedSummary;

  const exitSummary = closed && exitOrder
    ? await tradeSummaryForOrder(
      ctx,
      order,
      finite(exitOrder.orderId),
      [],
      priceCache,
    )
    : null;

  const entryPrice = entrySummary?.averagePrice ?? finite(order.entry_price) ?? finite(existingOutcome?.entry_price);
  const exitPrice = exitSummary?.averagePrice ?? finite(order.exit_price) ?? finite(existingOutcome?.exit_price);
  const quantity = exitSummary?.quantity ?? entrySummary?.quantity ?? finite(order.qty);

  const existingFees = Math.max(0, finite(existingOutcome?.fees_usdt) ?? 0);
  const calculatedFees = (entrySummary?.feesUsdt ?? 0) + (exitSummary?.feesUsdt ?? 0);
  const hasFeeEvidence = Boolean(
    (entrySummary && entrySummary.source !== 'unavailable') ||
    (exitSummary && exitSummary.source !== 'unavailable')
  );
  const feesUsdt = closed
    ? (hasFeeEvidence ? calculatedFees : existingFees)
    : Math.max(existingFees, entrySummary?.feesUsdt ?? 0);
  const feesComplete = closed
    ? Boolean(
      hasFeeEvidence &&
      (entrySummary?.feesComplete ?? true) &&
      (exitSummary?.feesComplete ?? true)
    )
    : (entrySummary?.feesComplete ?? true);

  const grossPnlUsdt = closed && entryPrice !== null && exitPrice !== null && quantity !== null && quantity > 0
    ? (exitPrice - entryPrice) * quantity
    : null;
  const netPnlUsdt = grossPnlUsdt !== null ? grossPnlUsdt - feesUsdt : null;
  const notional = entryPrice !== null && quantity !== null && quantity > 0
    ? entryPrice * quantity
    : null;
  const grossPnlPct = grossPnlUsdt !== null && notional !== null && notional > 0
    ? (grossPnlUsdt / notional) * 100
    : null;
  const netPnlPct = netPnlUsdt !== null && notional !== null && notional > 0
    ? (netPnlUsdt / notional) * 100
    : null;

  const referenceEntry = finite(opportunity.entry_reference);
  const referenceStop = finite(opportunity.stop_reference);
  const referenceTarget = finite(opportunity.target_reference);
  const riskPerUnit = referenceEntry !== null && referenceStop !== null
    ? Math.abs(referenceEntry - referenceStop)
    : null;
  const referenceRiskUsdt = riskPerUnit !== null && quantity !== null && quantity > 0
    ? riskPerUnit * quantity
    : null;
  const actualRiskUsdt = calculateActualRiskUsdt(
    order,
    entryPrice,
    quantity,
    entrySummary?.feesUsdt ?? 0,
  );
  const riskUsdt = actualRiskUsdt ?? positive(order.planned_risk_usdt) ?? referenceRiskUsdt;
  const resultR = netPnlUsdt !== null && riskUsdt !== null && riskUsdt > 0
    ? netPnlUsdt / riskUsdt
    : null;
  const fixedRiskEquivalentPnlUsdt = fixedRiskEquivalentPnl(order, netPnlUsdt);
  const sizingEffectPnlUsdt = netPnlUsdt !== null && fixedRiskEquivalentPnlUsdt !== null
    ? netPnlUsdt - fixedRiskEquivalentPnlUsdt
    : null;

  const entrySlippage = entryPrice !== null && referenceEntry !== null && quantity !== null
    ? Math.max(0, entryPrice - referenceEntry) * quantity
    : 0;
  let exitSlippage = 0;
  if (exitPrice !== null && quantity !== null) {
    if (order.status === 'alvo_executado' && referenceTarget !== null) {
      exitSlippage = Math.max(0, referenceTarget - exitPrice) * quantity;
    } else if (order.status === 'stop_executado' && referenceStop !== null) {
      exitSlippage = Math.max(0, referenceStop - exitPrice) * quantity;
    }
  }

  return {
    entryPrice,
    exitPrice,
    quantity,
    feesUsdt,
    feesComplete,
    grossPnlUsdt,
    netPnlUsdt,
    grossPnlPct,
    netPnlPct,
    riskUsdt,
    actualRiskUsdt,
    resultR,
    fixedRiskEquivalentPnlUsdt,
    sizingEffectPnlUsdt,
    slippageUsdt: Math.max(0, entrySlippage + exitSlippage),
    openedAt: existingOutcome?.entry_at ?? entrySummary?.firstTradeAt ?? orderOpenedAt(order),
    closedAt: closed ? (order.fechado_em ?? exitSummary?.lastTradeAt ?? nowIso()) : null,
    entrySummary,
    exitSummary,
  };
}


async function pauseAutoTradeAfterConsecutiveLosses(
  admin: any,
  order: DbOrder,
  netPnlUsdt: number | null,
  summary: MonitorSummary,
): Promise<void> {
  if (netPnlUsdt === null || netPnlUsdt >= 0) return;

  const { data: settings, error: settingsError } = await admin
    .from('user_settings')
    .select('auto_trade_enabled,auto_trade_paused_at,auto_trade_pause_after_consecutive_losses')
    .eq('user_id', order.user_id)
    .maybeSingle();

  if (settingsError) throw new Error(settingsError.message);
  if (!settings || settings.auto_trade_enabled !== true || settings.auto_trade_paused_at) return;

  const threshold = Math.max(
    0,
    Math.trunc(finite(settings.auto_trade_pause_after_consecutive_losses) ?? 0),
  );
  if (threshold <= 0) return;

  const environment = order.is_testnet ? 'testnet' : 'real';
  const { data: snapshot, error: snapshotError } = await admin.rpc(
    'position_sizing_sequence_snapshot',
    {
      p_user_id: order.user_id,
      p_execution_environment: environment,
      p_scope: 'account',
      p_symbol: null,
      p_timeframe: null,
      p_strategy: null,
    },
  );
  if (snapshotError) throw new Error(snapshotError.message);

  const sequence = asRecord(snapshot);
  const losses = Math.max(0, Math.trunc(finite(sequence?.consecutive_losses) ?? 0));
  if (losses < threshold) return;

  const pausedAt = nowIso();
  const reason = `Auto Trade pausado após ${losses} perdas consecutivas no ambiente ${environment}.`;
  const { data: pausedRows, error: pauseError } = await admin
    .from('user_settings')
    .update({
      auto_trade_paused_at: pausedAt,
      auto_trade_pause_reason: reason,
      auto_trade_last_error: reason,
    })
    .eq('user_id', order.user_id)
    .is('auto_trade_paused_at', null)
    .select('user_id');
  if (pauseError) throw new Error(pauseError.message);

  if (Array.isArray(pausedRows) && pausedRows.length > 0) {
    summary.auto_trade_pauses++;
    console.warn(JSON.stringify({
      event: 'auto_trade_paused_after_consecutive_losses',
      user_id: order.user_id,
      order_id: order.id,
      environment,
      consecutive_losses: losses,
      threshold,
      paused_at: pausedAt,
    }));
  }
}

async function syncPositionSizingResolution(
  admin: any,
  order: DbOrder,
  metrics: ExecutionMetrics,
  outcomeStatus: string,
  summary: MonitorSummary,
): Promise<void> {
  const decisionId = order.position_sizing_decision_id;
  if (!decisionId) return;

  try {
    const { data: decision, error: decisionError } = await admin
      .from('position_sizing_decisions')
      .select('id,user_id,result_snapshot,actual_risk_usdt,sizing_mode,base_risk_percent,applied_risk_percent')
      .eq('id', decisionId)
      .eq('user_id', order.user_id)
      .maybeSingle();
    if (decisionError) throw new Error(decisionError.message);
    if (!decision) return;

    const resolved = orderHasClosedPosition(order);
    const fixedEquivalent = metrics.fixedRiskEquivalentPnlUsdt;
    const sizingEffect = metrics.sizingEffectPnlUsdt;
    const resultSnapshot = mergeObjects(asRecord(decision.result_snapshot), {
      order_id: order.id,
      opportunity_id: order.opportunity_id,
      order_status: order.status,
      outcome_status: outcomeStatus,
      net_pnl_usdt: resolved ? metrics.netPnlUsdt : null,
      result_r: resolved ? metrics.resultR : null,
      actual_risk_usdt: metrics.actualRiskUsdt,
      fixed_risk_equivalent_pnl_usdt: resolved ? fixedEquivalent : null,
      sizing_effect_pnl_usdt: resolved ? sizingEffect : null,
      resolved_at: resolved ? (metrics.closedAt ?? nowIso()) : null,
      monitored_at: nowIso(),
    });

    const { error: updateDecisionError } = await admin
      .from('position_sizing_decisions')
      .update({
        actual_risk_usdt:
          metrics.actualRiskUsdt ?? finite(decision.actual_risk_usdt),
        result_snapshot: resultSnapshot,
      })
      .eq('id', decisionId)
      .eq('user_id', order.user_id);
    if (updateDecisionError) throw new Error(updateDecisionError.message);
    summary.sizing_decisions_synced++;
    if (resolved) summary.sizing_results_resolved++;

    const actualRisk = metrics.actualRiskUsdt;
    const orderSnapshot = sizingSnapshotForOrder(order, {
      actual_risk_usdt: actualRisk,
      result_r: resolved ? metrics.resultR : null,
      fixed_risk_equivalent_pnl_usdt: resolved ? fixedEquivalent : null,
      sizing_effect_pnl_usdt: resolved ? sizingEffect : null,
      monitored_at: nowIso(),
    });
    const { error: updateOrderError } = await admin
      .from('orders')
      .update({
        actual_risk_usdt: actualRisk ?? finite(order.actual_risk_usdt),
        sizing_snapshot: orderSnapshot,
      })
      .eq('id', order.id)
      .eq('user_id', order.user_id);
    if (updateOrderError) throw new Error(updateOrderError.message);

    if (resolved) {
      await pauseAutoTradeAfterConsecutiveLosses(
        admin,
        order,
        metrics.netPnlUsdt,
        summary,
      );
    }
  } catch (error) {
    const message = truncate(error instanceof Error ? error.message : error, 500);
    summary.erros_sizing++;
    if (summary.sizing_errors.length < 20) {
      summary.sizing_errors.push({
        order_id: order.id,
        decision_id: decisionId,
        error: message,
      });
    }
    console.error(`Falha ao sincronizar dimensionamento da ordem ${order.id}:`, error);
  }
}

async function logOpportunityEventOnce(
  admin: any,
  opportunity: TradeOpportunity,
  order: DbOrder,
  eventType: string,
  eventData: Record<string, unknown>,
  summary: MonitorSummary,
): Promise<void> {
  const { data: existing, error: queryError } = await admin
    .from('opportunity_events')
    .select('id')
    .eq('opportunity_id', opportunity.id)
    .eq('event_type', eventType)
    .contains('event_data', { orderId: order.id })
    .limit(1);

  if (queryError) {
    if (isMissingOpportunitySchema(queryError)) return;
    throw new Error(queryError.message);
  }
  if (Array.isArray(existing) && existing.length > 0) return;

  const { error } = await admin.rpc('log_opportunity_event', {
    p_opportunity_id: opportunity.id,
    p_user_id: opportunity.user_id,
    p_event_type: eventType,
    p_actor_type: 'edge_function',
    p_event_data: {
      orderId: order.id,
      orderStatus: order.status,
      isTestnet: order.is_testnet,
      ...eventData,
    },
  });
  if (error) {
    if (isMissingOpportunitySchema(error)) return;
    throw new Error(error.message);
  }
  summary.eventos_oportunidade++;
}

async function syncOpportunityFromOrder(
  admin: any,
  order: DbOrder,
  ctx: BinanceCtx | null,
  summary: MonitorSummary,
): Promise<void> {
  if (!order.opportunity_id) return;

  try {
    const { data: opportunityData, error: opportunityError } = await admin
      .from('trade_opportunities')
      .select('id,user_id,lifecycle_status,execution_environment,entry_reference,stop_reference,target_reference,quote_amount,opened_at,closed_at,strategy,strategy_version,position_sizing_decision_id,sizing_snapshot,metadata')
      .eq('id', order.opportunity_id)
      .eq('user_id', order.user_id)
      .maybeSingle();

    if (opportunityError) {
      if (isMissingOpportunitySchema(opportunityError)) return;
      throw new Error(opportunityError.message);
    }
    if (!opportunityData) return;

    const opportunity = opportunityData as TradeOpportunity;
    const { data: outcomeData, error: outcomeQueryError } = await admin
      .from('opportunity_outcomes')
      .select('id,status,entry_price,entry_at,exit_price,exit_at,fees_usdt,slippage_usdt,metadata,target_hit_at,stop_hit_at,resolved_at,position_sizing_decision_id,fixed_risk_equivalent_pnl_usdt,sizing_effect_pnl_usdt,sizing_snapshot')
      .eq('opportunity_id', opportunity.id)
      .eq('mode', 'executed')
      .maybeSingle();

    if (outcomeQueryError) {
      if (isMissingOpportunitySchema(outcomeQueryError)) return;
      throw new Error(outcomeQueryError.message);
    }

    const existingOutcome = outcomeData as OpportunityOutcome | null;
    const desiredOutcomeStatus = outcomeStatusForOrder(order);
    const desiredLifecycle = lifecycleForOrder(order);
    const metrics = await calculateExecutionMetrics(order, opportunity, existingOutcome, ctx);
    const closed = desiredLifecycle === 'closed';
    const resolved = desiredOutcomeStatus !== 'tracking';

    const opportunityPatch: Record<string, unknown> = {};
    const preserveClassifiedLifecycle = ['expired', 'invalidated', 'rejected'].includes(
      opportunity.lifecycle_status,
    );
    if (
      (!preserveClassifiedLifecycle && opportunity.lifecycle_status !== 'closed') ||
      desiredLifecycle === 'closed'
    ) {
      if (opportunity.lifecycle_status !== desiredLifecycle) {
        opportunityPatch.lifecycle_status = desiredLifecycle;
      }
    }
    if (metrics.openedAt && !opportunity.opened_at) {
      opportunityPatch.opened_at = metrics.openedAt;
    }
    if (closed && metrics.closedAt && !opportunity.closed_at) {
      opportunityPatch.closed_at = metrics.closedAt;
    }
    if (finite(opportunity.quote_amount) === null && finite(order.quote_amount) !== null) {
      opportunityPatch.quote_amount = finite(order.quote_amount);
    }
    if (!opportunity.position_sizing_decision_id && order.position_sizing_decision_id) {
      opportunityPatch.position_sizing_decision_id = order.position_sizing_decision_id;
    }
    if (order.position_sizing_decision_id) {
      opportunityPatch.sizing_snapshot = sizingSnapshotForOrder(order, {
        actual_risk_usdt: metrics.actualRiskUsdt,
        last_monitored_at: nowIso(),
      });
    }

    if (Object.keys(opportunityPatch).length > 0) {
      const { error: updateOpportunityError } = await admin
        .from('trade_opportunities')
        .update(opportunityPatch)
        .eq('id', opportunity.id)
        .eq('user_id', opportunity.user_id);
      if (updateOpportunityError) throw new Error(updateOpportunityError.message);
      summary.oportunidades_atualizadas++;
      if (closed && opportunity.lifecycle_status !== 'closed') summary.oportunidades_fechadas++;
    }

    const currentMetadata = asRecord(existingOutcome?.metadata) ?? {};
    const monitoringMetadata = {
      version: 1,
      syncedAt: nowIso(),
      orderId: order.id,
      requestId: order.request_id,
      orderStatus: order.status,
      binanceStatus: order.binance_status,
      isTestnet: order.is_testnet,
      quantity: metrics.quantity,
      riskUsdt: metrics.riskUsdt,
      actualRiskUsdt: metrics.actualRiskUsdt,
      sizingMode: order.sizing_mode,
      riskMultiplier: finite(order.risk_multiplier) ?? 1,
      baseRiskPercent: finite(order.base_risk_percent),
      appliedRiskPercent: finite(order.applied_risk_percent),
      fixedRiskEquivalentPnlUsdt: metrics.fixedRiskEquivalentPnlUsdt,
      sizingEffectPnlUsdt: metrics.sizingEffectPnlUsdt,
      positionSizingDecisionId: order.position_sizing_decision_id,
      feesComplete: metrics.feesComplete,
      entryTradeSource: metrics.entrySummary?.source ?? null,
      exitTradeSource: metrics.exitSummary?.source ?? null,
      estimatedCommissionAssets: [
        ...(metrics.entrySummary?.estimatedCommissionAssets ?? []),
        ...(metrics.exitSummary?.estimatedCommissionAssets ?? []),
      ],
      unresolvedCommissions: [
        ...(metrics.entrySummary?.unresolvedCommissions ?? []),
        ...(metrics.exitSummary?.unresolvedCommissions ?? []),
      ],
      unprotectedReason: order.unprotected_reason,
      error: order.erro,
    };

    const outcomePayload: Record<string, unknown> = {
      opportunity_id: opportunity.id,
      user_id: opportunity.user_id,
      mode: 'executed',
      status: existingOutcome && existingOutcome.status !== 'tracking' && !resolved
        ? existingOutcome.status
        : desiredOutcomeStatus,
      entry_price: metrics.entryPrice,
      entry_at: metrics.openedAt,
      fees_usdt: metrics.feesUsdt,
      slippage_usdt: metrics.slippageUsdt,
      position_sizing_decision_id:
        order.position_sizing_decision_id ??
        opportunity.position_sizing_decision_id ??
        existingOutcome?.position_sizing_decision_id ??
        null,
      fixed_risk_equivalent_pnl_usdt: metrics.fixedRiskEquivalentPnlUsdt,
      sizing_effect_pnl_usdt: metrics.sizingEffectPnlUsdt,
      sizing_snapshot: sizingSnapshotForOrder(order, {
        actual_risk_usdt: metrics.actualRiskUsdt,
        result_r: metrics.resultR,
      }),
      metadata: {
        ...currentMetadata,
        monitorar_ordens: monitoringMetadata,
      },
    };

    if (resolved) {
      outcomePayload.exit_price = metrics.exitPrice;
      outcomePayload.exit_at = metrics.closedAt;
      outcomePayload.exit_reason = desiredOutcomeStatus === 'target_hit'
        ? 'target'
        : desiredOutcomeStatus === 'stop_hit'
          ? 'stop'
          : desiredOutcomeStatus === 'manual_exit'
            ? 'manual_or_unclassified'
            : desiredOutcomeStatus;
      outcomePayload.gross_pnl_pct = metrics.grossPnlPct;
      outcomePayload.net_pnl_pct = metrics.netPnlPct;
      outcomePayload.gross_pnl_usdt = metrics.grossPnlUsdt;
      outcomePayload.net_pnl_usdt = metrics.netPnlUsdt;
      outcomePayload.result_r = metrics.resultR;
      outcomePayload.fixed_risk_equivalent_pnl_usdt =
        metrics.fixedRiskEquivalentPnlUsdt;
      outcomePayload.sizing_effect_pnl_usdt = metrics.sizingEffectPnlUsdt;
      outcomePayload.resolved_at = metrics.closedAt ?? nowIso();
      if (desiredOutcomeStatus === 'target_hit') {
        outcomePayload.target_hit_at = metrics.closedAt ?? nowIso();
      }
      if (desiredOutcomeStatus === 'stop_hit') {
        outcomePayload.stop_hit_at = metrics.closedAt ?? nowIso();
      }
    }

    const { error: outcomeError } = await admin
      .from('opportunity_outcomes')
      .upsert(outcomePayload, { onConflict: 'opportunity_id,mode' });
    if (outcomeError) throw new Error(outcomeError.message);
    summary.resultados_executados_atualizados++;

    await syncPositionSizingResolution(
      admin,
      order,
      metrics,
      desiredOutcomeStatus,
      summary,
    );

    const eventType = eventTypeForOrder(order);
    if (eventType) {
      await logOpportunityEventOnce(
        admin,
        opportunity,
        order,
        eventType,
        {
          lifecycleStatus: desiredLifecycle,
          outcomeStatus: desiredOutcomeStatus,
          entryPrice: metrics.entryPrice,
          exitPrice: metrics.exitPrice,
          quantity: metrics.quantity,
          grossPnlUsdt: metrics.grossPnlUsdt,
          netPnlUsdt: metrics.netPnlUsdt,
          resultR: metrics.resultR,
          feesUsdt: metrics.feesUsdt,
          slippageUsdt: metrics.slippageUsdt,
          actualRiskUsdt: metrics.actualRiskUsdt,
          fixedRiskEquivalentPnlUsdt: metrics.fixedRiskEquivalentPnlUsdt,
          sizingEffectPnlUsdt: metrics.sizingEffectPnlUsdt,
          positionSizingDecisionId: order.position_sizing_decision_id,
          sizingMode: order.sizing_mode,
          riskMultiplier: finite(order.risk_multiplier) ?? 1,
          closedAt: metrics.closedAt,
        },
        summary,
      );
    }
  } catch (error) {
    const message = truncate(error instanceof Error ? error.message : error, 500);
    summary.erros_oportunidade++;
    if (summary.opportunity_errors.length < 20) {
      summary.opportunity_errors.push({
        order_id: order.id,
        opportunity_id: order.opportunity_id,
        error: message,
      });
    }
    console.error(`Falha ao sincronizar oportunidade da ordem ${order.id}:`, error);
  }
}

async function syncAssociatedRecords(
  admin: any,
  order: DbOrder,
  ctx: BinanceCtx | null,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
): Promise<void> {
  await syncDayTradeJournal(admin, order, ctx, summary, journalErrors);
  await syncOpportunityFromOrder(admin, order, ctx, summary);
}

async function updateOrder(admin: any, id: string, values: Record<string, unknown>): Promise<DbOrder> {
  const { data, error } = await admin
    .from('orders')
    .update(values)
    .eq('id', id)
    .select(ORDER_SELECT)
    .single();
  if (error) throw new Error(`falha ao atualizar ordem ${id}: ${error.message}`);
  return data as DbOrder;
}

async function markMonitoringError(admin: any, order: DbOrder, error: unknown) {
  const message = truncate(error instanceof Error ? error.message : 'erro de monitoramento', 500);
  await updateOrder(admin, order.id, {
    last_checked_at: nowIso(),
    binance_status: 'ERRO_MONITORAMENTO',
    erro: message,
  });
}

async function finishFromFilledLeg(
  admin: any,
  order: DbOrder,
  list: BinanceOrderList,
  details: BinanceOrder[],
  filled: BinanceOrder,
  ctx: BinanceCtx,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
) {
  let leg = classifyLeg(filled, order);
  const qty = finite(filled.executedQty);
  const quote = finite(filled.cummulativeQuoteQty);
  const fallbackPrice = finite(filled.price) ?? finite(filled.stopPrice);
  const exitPrice = qty !== null && qty > 0 && quote !== null && quote > 0
    ? quote / qty
    : fallbackPrice;
  const entryPrice = finite(order.entry_price);
  const pnl = entryPrice !== null && qty !== null && qty > 0 && exitPrice !== null
    ? (exitPrice - entryPrice) * qty
    : null;

  if (leg === 'unknown' && exitPrice !== null) {
    const stop = finite(order.stop_price);
    const target = finite(order.target_price);
    if (stop !== null && target !== null) {
      leg = Math.abs(exitPrice - stop) <= Math.abs(exitPrice - target) ? 'stop' : 'target';
    }
  }

  const closedAtMs = finite(filled.updateTime) ?? finite(list.transactionTime) ?? Date.now();
  const status = leg === 'stop'
    ? 'stop_executado'
    : leg === 'target'
      ? 'alvo_executado'
      : 'erro';
  const classificationError = leg === 'unknown'
    ? 'A saída foi executada, mas a perna da OCO não pôde ser classificada com segurança.'
    : null;

  const updatedOrder = await updateOrder(admin, order.id, {
    status,
    oco_list_id: list.orderListId ?? order.oco_list_id,
    exit_price: exitPrice,
    pnl_usdt: pnl,
    fechado_em: new Date(closedAtMs).toISOString(),
    last_checked_at: nowIso(),
    binance_status: listStatus(list, details),
    erro: classificationError,
    unprotected_reason: null,
    raw: mergeRaw(order, {
      checked_at: nowIso(),
      order_list: list,
      orders: details,
      exit_classification: leg,
    }),
  });
  await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);

  if (status === 'stop_executado') summary.stops++;
  else if (status === 'alvo_executado') summary.alvos++;
  else summary.erros++;
}

async function evaluateOrderList(
  admin: any,
  order: DbOrder,
  list: BinanceOrderList,
  ctx: BinanceCtx,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
) {
  const details = await getOrderDetails(ctx, list);
  const checkedAt = nowIso();
  const statusText = listStatus(list, details);
  const filled = details.find((item) => String(item.status).toUpperCase() === 'FILLED');

  if (filled) {
    await finishFromFilledLeg(admin, order, list, details, filled, ctx, summary, journalErrors);
    return;
  }

  const partiallyFilled = details.find((item) => String(item.status).toUpperCase() === 'PARTIALLY_FILLED');
  const stopLeg = details.find((item) => classifyLeg(item, order) === 'stop');
  const stopStatus = String(stopLeg?.status ?? '').toUpperCase();
  const listType = String(list.listStatusType ?? '').toUpperCase();
  const listOrderStatus = String(list.listOrderStatus ?? '').toUpperCase();
  const listEnded = ['ALL_DONE', 'REJECT'].includes(listType) || ['ALL_DONE', 'REJECTED'].includes(listOrderStatus);
  const stopGone = stopLeg && TERMINAL_ORDER_STATUSES.has(stopStatus) && stopStatus !== 'FILLED';

  if (partiallyFilled || stopGone || listEnded) {
    const reason = partiallyFilled
      ? 'saída parcialmente executada; saldo remanescente pode estar sem proteção'
      : stopGone
        ? `ordem de stop não está ativa (${stopStatus || 'status desconhecido'})`
        : 'lista OCO encerrada sem saída totalmente executada; posição pode continuar aberta';

    const updatedOrder = await updateOrder(admin, order.id, {
      status: 'entrada_sem_protecao',
      oco_list_id: list.orderListId ?? order.oco_list_id,
      last_checked_at: checkedAt,
      binance_status: statusText,
      erro: reason,
      unprotected_reason: reason,
      raw: mergeRaw(order, { checked_at: checkedAt, order_list: list, orders: details }),
    });
    await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
    summary.sem_protecao++;
    return;
  }

  const reconciled = order.status !== 'oco_ativa' || String(order.oco_list_id ?? '') !== String(list.orderListId ?? '');
  const updatedOrder = await updateOrder(admin, order.id, {
    status: 'oco_ativa',
    oco_list_id: list.orderListId ?? order.oco_list_id,
    protected_at: order.protected_at ?? checkedAt,
    last_checked_at: checkedAt,
    binance_status: statusText,
    erro: null,
    unprotected_reason: null,
    raw: reconciled
      ? mergeRaw(order, { checked_at: checkedAt, order_list: list, orders: details })
      : order.raw,
  });
  await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
  summary.abertas++;
  if (reconciled) summary.reconciliadas++;
}

async function evaluateWithoutOrderList(
  admin: any,
  order: DbOrder,
  ctx: BinanceCtx,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
) {
  const checkedAt = nowIso();
  const entry = await getSingleOrder(ctx, order);

  if (!entry) {
    if (order.status === 'oco_ativa' && order.binance_status !== 'OCO_NAO_LOCALIZADA') {
      const updatedOrder = await updateOrder(admin, order.id, {
        last_checked_at: checkedAt,
        binance_status: 'OCO_NAO_LOCALIZADA',
        erro: 'OCO não localizada na primeira verificação; será confirmada novamente',
      });
      await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
      summary.abertas++;
      return;
    }

    const reason = order.status === 'oco_ativa'
      ? 'OCO não localizada em verificações consecutivas; proteção não pôde ser confirmada'
      : 'entrada ou OCO não localizada na Binance; posição precisa de conferência manual';
    const updatedOrder = await updateOrder(admin, order.id, {
      status: 'entrada_sem_protecao',
      last_checked_at: checkedAt,
      binance_status: 'NAO_LOCALIZADA',
      erro: reason,
      unprotected_reason: reason,
    });
    await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
    summary.sem_protecao++;
    return;
  }

  const entryStatus = String(entry.status ?? '').toUpperCase();
  const executedQty = finite(entry.executedQty);
  const spent = finite(entry.cummulativeQuoteQty);
  const averagePrice = executedQty !== null && executedQty > 0 && spent !== null && spent > 0
    ? spent / executedQty
    : finite(order.entry_price);

  if (entryStatus === 'FILLED' || entryStatus === 'PARTIALLY_FILLED') {
    const reason = entryStatus === 'PARTIALLY_FILLED'
      ? 'entrada parcialmente executada e sem OCO confirmada'
      : 'entrada executada, mas nenhuma OCO foi localizada';
    const updatedOrder = await updateOrder(admin, order.id, {
      status: 'entrada_sem_protecao',
      entry_order_id: entry.orderId ?? order.entry_order_id,
      qty: executedQty ?? order.qty,
      entry_price: averagePrice,
      last_checked_at: checkedAt,
      binance_status: `ENTRADA:${entryStatus}`,
      erro: reason,
      unprotected_reason: reason,
      raw: mergeRaw(order, { checked_at: checkedAt, entry }),
    });
    await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
    summary.sem_protecao++;
    if (order.status !== 'entrada_sem_protecao') summary.reconciliadas++;
    return;
  }

  if (['CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH'].includes(entryStatus)) {
    const updatedOrder = await updateOrder(admin, order.id, {
      status: 'cancelada',
      entry_order_id: entry.orderId ?? order.entry_order_id,
      fechado_em: new Date(finite(entry.updateTime) ?? Date.now()).toISOString(),
      last_checked_at: checkedAt,
      binance_status: `ENTRADA:${entryStatus}`,
      erro: null,
      unprotected_reason: null,
      raw: mergeRaw(order, { checked_at: checkedAt, entry }),
    });
    await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
    summary.canceladas++;
    return;
  }

  const updatedOrder = await updateOrder(admin, order.id, {
    status: 'entrada_enviada',
    entry_order_id: entry.orderId ?? order.entry_order_id,
    last_checked_at: checkedAt,
    binance_status: `ENTRADA:${entryStatus || 'DESCONHECIDO'}`,
    erro: null,
    raw: mergeRaw(order, { checked_at: checkedAt, entry }),
  });
  await syncAssociatedRecords(admin, updatedOrder, ctx, summary, journalErrors);
  summary.abertas++;
}

async function monitorOrder(
  admin: any,
  order: DbOrder,
  ctx: BinanceCtx,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
) {
  const orderList = await getOrderList(ctx, order);
  if (orderList) {
    await evaluateOrderList(admin, order, orderList, ctx, summary, journalErrors);
    return;
  }
  await evaluateWithoutOrderList(admin, order, ctx, summary, journalErrors);
}


async function reconcileTerminalJournals(
  admin: any,
  keysByUser: Map<string, ExchangeKeys>,
  contexts: Map<string, BinanceCtx>,
  summary: MonitorSummary,
  journalErrors: Array<{ order_id: string; error: string }>,
) {
  const { data: journalRows, error: journalError } = await admin
    .from('daytrade_journal')
    .select('order_id,user_id,status')
    .in('status', ['ordem_enviada', 'aberta', 'erro'])
    .not('order_id', 'is', null)
    .limit(BATCH_SIZE);

  if (journalError) {
    if (journalError.code === '42P01' || String(journalError.message ?? '').includes('daytrade_journal')) return;
    summary.erros_diario++;
    journalErrors.push({ order_id: 'reconciliacao', error: truncate(journalError.message, 500) });
    return;
  }

  const orderIds = [...new Set((journalRows ?? []).map((row: any) => String(row.order_id)).filter(Boolean))];
  if (!orderIds.length) return;

  const { data: terminalRows, error: terminalError } = await admin
    .from('orders')
    .select(ORDER_SELECT)
    .in('id', orderIds)
    .in('status', TERMINAL_DB_STATUSES);
  if (terminalError) {
    summary.erros_diario++;
    journalErrors.push({ order_id: 'reconciliacao', error: truncate(terminalError.message, 500) });
    return;
  }

  const terminalOrders = (terminalRows ?? []) as DbOrder[];
  const missingUserIds = [...new Set(
    terminalOrders
      .map((order) => order.user_id)
      .filter((userId) => !keysByUser.has(userId)),
  )];
  if (missingUserIds.length) {
    const { data: extraKeys } = await admin
      .from('exchange_keys')
      .select('user_id,api_key,api_secret_enc,is_testnet')
      .in('user_id', missingUserIds);
    for (const row of (extraKeys ?? []) as ExchangeKeys[]) keysByUser.set(row.user_id, row);
  }

  for (const order of terminalOrders) {
    let ctx = contexts.get(order.user_id) ?? null;
    const keys = keysByUser.get(order.user_id);
    if (!ctx && keys && Boolean(keys.is_testnet) === Boolean(order.is_testnet)) {
      try {
        const base = keys.is_testnet ? TESTNET_BASE : REAL_BASE;
        ctx = {
          base,
          apiKey: keys.api_key,
          secret: await decrypt(keys.api_secret_enc),
          offset: await getOffset(base),
        };
        contexts.set(order.user_id, ctx);
      } catch (error) {
        console.warn(`Não foi possível reconstruir contexto da ordem ${order.id}:`, error);
      }
    }
    await syncAssociatedRecords(admin, order, ctx, summary, journalErrors);
  }
}


async function contextForOrder(
  admin: any,
  order: DbOrder,
  keysByUser: Map<string, ExchangeKeys>,
  contexts: Map<string, BinanceCtx>,
): Promise<BinanceCtx | null> {
  const cached = contexts.get(order.user_id);
  if (cached) return cached;

  let keys = keysByUser.get(order.user_id);
  if (!keys) {
    const { data } = await admin
      .from('exchange_keys')
      .select('user_id,api_key,api_secret_enc,is_testnet')
      .eq('user_id', order.user_id)
      .maybeSingle();
    if (data) {
      keys = data as ExchangeKeys;
      keysByUser.set(order.user_id, keys);
    }
  }

  if (!keys || Boolean(keys.is_testnet) !== Boolean(order.is_testnet)) return null;

  try {
    const base = keys.is_testnet ? TESTNET_BASE : REAL_BASE;
    const ctx: BinanceCtx = {
      base,
      apiKey: keys.api_key,
      secret: await decrypt(keys.api_secret_enc),
      offset: await getOffset(base),
    };
    contexts.set(order.user_id, ctx);
    return ctx;
  } catch (error) {
    console.warn(`Não foi possível reconstruir contexto da oportunidade ${order.opportunity_id ?? ''}:`, error);
    return null;
  }
}

async function reconcileTerminalOpportunities(
  admin: any,
  keysByUser: Map<string, ExchangeKeys>,
  contexts: Map<string, BinanceCtx>,
  summary: MonitorSummary,
): Promise<void> {
  try {
    const candidateIds = new Set<string>();

    const { data: opportunityRows, error: opportunityError } = await admin
      .from('trade_opportunities')
      .select('id')
      .in('lifecycle_status', ['opening', 'open', 'error', 'closing'])
      .limit(BATCH_SIZE);

    if (opportunityError) {
      if (isMissingOpportunitySchema(opportunityError)) return;
      throw new Error(opportunityError.message);
    }
    for (const row of opportunityRows ?? []) candidateIds.add(String(row.id));

    const { data: trackingRows, error: trackingError } = await admin
      .from('opportunity_outcomes')
      .select('opportunity_id')
      .eq('mode', 'executed')
      .eq('status', 'tracking')
      .limit(BATCH_SIZE);

    if (trackingError) {
      if (isMissingOpportunitySchema(trackingError)) return;
      throw new Error(trackingError.message);
    }
    for (const row of trackingRows ?? []) candidateIds.add(String(row.opportunity_id));

    const ids = [...candidateIds].filter(Boolean).slice(0, BATCH_SIZE);
    if (!ids.length) return;

    const { data: orderRows, error: orderError } = await admin
      .from('orders')
      .select(ORDER_SELECT)
      .in('opportunity_id', ids)
      .in('status', TERMINAL_DB_STATUSES)
      .limit(BATCH_SIZE);

    if (orderError) {
      if (isMissingOpportunitySchema(orderError)) return;
      throw new Error(orderError.message);
    }

    for (const order of (orderRows ?? []) as DbOrder[]) {
      const ctx = await contextForOrder(admin, order, keysByUser, contexts);
      await syncOpportunityFromOrder(admin, order, ctx, summary);
    }
  } catch (error) {
    const message = truncate(error instanceof Error ? error.message : error, 500);
    summary.erros_oportunidade++;
    if (summary.opportunity_errors.length < 20) {
      summary.opportunity_errors.push({
        order_id: 'reconciliacao',
        opportunity_id: null,
        error: message,
      });
    }
    console.error('Falha ao reconciliar oportunidades terminais:', error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return jsonResponse({ error: 'método não permitido' }, 405);

  const expectedSecret = Deno.env.get('CRON_SECRET') ?? '';
  const providedSecret = req.headers.get('x-cron-secret') ?? '';
  if (!expectedSecret || !constantTimeEqual(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const summary: MonitorSummary = {
    selecionadas: 0,
    verificadas: 0,
    abertas: 0,
    reconciliadas: 0,
    alvos: 0,
    stops: 0,
    sem_protecao: 0,
    canceladas: 0,
    erros: 0,
    diarios_atualizados: 0,
    diarios_fechados: 0,
    taxas_incompletas: 0,
    erros_diario: 0,
    oportunidades_atualizadas: 0,
    oportunidades_fechadas: 0,
    resultados_executados_atualizados: 0,
    eventos_oportunidade: 0,
    sizing_decisions_synced: 0,
    sizing_results_resolved: 0,
    auto_trade_pauses: 0,
    erros_sizing: 0,
    erros_oportunidade: 0,
    sizing_errors: [],
    opportunity_errors: [],
  };
  const errors: Array<{ order_id: string; error: string }> = [];
  const journalErrors: Array<{ order_id: string; error: string }> = [];

  try {
    const { data: rows, error: orderError } = await admin
      .from('orders')
      .select(ORDER_SELECT)
      .in('status', MONITORED_STATUSES)
      .order('last_checked_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE);

    if (orderError) return jsonResponse({ error: orderError.message }, 500);
    const orders = (rows ?? []) as DbOrder[];
    summary.selecionadas = orders.length;
    if (orders.length === 0) {
      const emptyKeys = new Map<string, ExchangeKeys>();
      const emptyContexts = new Map<string, BinanceCtx>();
      await reconcileTerminalJournals(admin, emptyKeys, emptyContexts, summary, journalErrors);
      await reconcileTerminalOpportunities(admin, emptyKeys, emptyContexts, summary);
      return jsonResponse({
        ok: summary.erros_diario === 0 && summary.erros_oportunidade === 0 && summary.erros_sizing === 0,
        ...summary,
        errors: [],
        journal_errors: journalErrors.slice(0, 20),
        sizing_errors: summary.sizing_errors.slice(0, 20),
      });
    }

    const userIds = [...new Set(orders.map((order) => order.user_id))];
    const { data: keyRows, error: keyError } = await admin
      .from('exchange_keys')
      .select('user_id,api_key,api_secret_enc,is_testnet')
      .in('user_id', userIds);
    if (keyError) return jsonResponse({ error: keyError.message }, 500);

    const keysByUser = new Map<string, ExchangeKeys>();
    for (const row of (keyRows ?? []) as ExchangeKeys[]) keysByUser.set(row.user_id, row);
    const contexts = new Map<string, BinanceCtx>();

    for (const order of orders) {
      try {
        const keys = keysByUser.get(order.user_id);
        if (!keys) {
          const reason = 'chave Binance removida; monitoramento automático indisponível';
          await updateOrder(admin, order.id, {
            last_checked_at: nowIso(),
            binance_status: 'CHAVE_AUSENTE',
            erro: reason,
          });
          summary.erros++;
          errors.push({ order_id: order.id, error: reason });
          continue;
        }
        if (Boolean(keys.is_testnet) !== Boolean(order.is_testnet)) {
          const reason = `credencial atual pertence ao ambiente ${keys.is_testnet ? 'testnet' : 'real'}, mas a ordem pertence ao ambiente ${order.is_testnet ? 'testnet' : 'real'}`;
          await updateOrder(admin, order.id, {
            last_checked_at: nowIso(),
            binance_status: 'AMBIENTE_DIVERGENTE',
            erro: reason,
          });
          summary.erros++;
          errors.push({ order_id: order.id, error: reason });
          continue;
        }

        let ctx = contexts.get(order.user_id);
        if (!ctx) {
          const base = keys.is_testnet ? TESTNET_BASE : REAL_BASE;
          ctx = {
            base,
            apiKey: keys.api_key,
            secret: await decrypt(keys.api_secret_enc),
            offset: await getOffset(base),
          };
          contexts.set(order.user_id, ctx);
        }

        await monitorOrder(admin, order, ctx, summary, journalErrors);
        summary.verificadas++;
      } catch (error) {
        summary.erros++;
        errors.push({
          order_id: order.id,
          error: truncate(error instanceof Error ? error.message : 'erro desconhecido', 500),
        });
        try {
          await markMonitoringError(admin, order, error);
        } catch (updateError) {
          errors.push({
            order_id: order.id,
            error: `falha ao registrar erro: ${truncate(updateError instanceof Error ? updateError.message : updateError, 300)}`,
          });
        }
      }
    }

    await reconcileTerminalJournals(admin, keysByUser, contexts, summary, journalErrors);
    await reconcileTerminalOpportunities(admin, keysByUser, contexts, summary);

    return jsonResponse({
      ok: summary.erros === 0 && summary.erros_diario === 0 && summary.erros_oportunidade === 0 && summary.erros_sizing === 0,
      ...summary,
      errors: errors.slice(0, 20),
      journal_errors: journalErrors.slice(0, 20),
      sizing_errors: summary.sizing_errors.slice(0, 20),
    });
  } catch (error) {
    return jsonResponse({
      error: truncate(error instanceof Error ? error.message : 'erro interno', 500),
      ...summary,
      errors: errors.slice(0, 20),
      journal_errors: journalErrors.slice(0, 20),
      sizing_errors: summary.sizing_errors.slice(0, 20),
    }, 500);
  }
});