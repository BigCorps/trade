'use client';

/**
 * app/conta/page.tsx — VigIA Trade v2
 * ----------------------------------------------------------------------------
 * Novidades: navegação no header + histórico de ordens persistido (tabela
 * orders, atualizada pelo cron monitorar-ordens) — sobrevive ao refresh.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabaseClient';

const S = {
  bg: '#101418', panel: '#181f26', border: '#2a343f',
  text: '#d7dee6', dim: '#7d8a97',
  a: '#e8a13c', green: '#3fb26f', red: '#d05555',
};

const inputStyle: React.CSSProperties = {
  background: S.bg, border: `1px solid ${S.border}`, borderRadius: 6,
  color: S.text, padding: '8px 10px', fontSize: 14, textAlign: 'center',
};

const fmt = (n: number, d = 2) =>
  n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtData = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pendente: { label: 'pendente', color: '#7d8a97' },
  entrada_executada: { label: 'entrada feita', color: '#e8a13c' },
  oco_ativa: { label: 'OCO ativa', color: '#4f8fd0' },
  alvo_executado: { label: 'alvo ✅', color: '#3fb26f' },
  stop_executado: { label: 'stop 🛑', color: '#d05555' },
  cancelada: { label: 'cancelada', color: '#7d8a97' },
  erro: { label: 'erro', color: '#d05555' },
};

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 10, padding: 16, ...style }}>
      {children}
    </section>
  );
}

interface KeyInfo { api_key: string; is_testnet: boolean }
interface Balance { asset: string; free: string; locked: string }
interface OrderRow {
  id: string; symbol: string; status: string; is_testnet: boolean;
  quote_amount: number; qty: number | null;
  entry_price: number | null; exit_price: number | null;
  stop_price: number | null; target_price: number | null;
  pnl_usdt: number | null; erro: string | null; criado_em: string;
}

export default function ContaPage() {
  const supabase = getSupabase();

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [isTestnet, setIsTestnet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);

  const [ordSymbol, setOrdSymbol] = useState('BTCUSDT');
  const [ordAmount, setOrdAmount] = useState('50');
  const [ordStop, setOrdStop] = useState('2');
  const [ordTarget, setOrdTarget] = useState('4');
  const [ordResult, setOrdResult] = useState('');
  const [ordBusy, setOrdBusy] = useState(false);

  const [orders, setOrders] = useState<OrderRow[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  const loadOrders = useCallback(async () => {
    const { data } = await supabase.from('orders')
      .select('id, symbol, status, is_testnet, quote_amount, qty, entry_price, exit_price, stop_price, target_price, pnl_usdt, erro, criado_em')
      .order('criado_em', { ascending: false }).limit(15);
    setOrders((data as OrderRow[]) ?? []);
  }, [supabase]);

  useEffect(() => {
    if (!session) return;
    supabase.from('exchange_keys').select('api_key, is_testnet').maybeSingle()
      .then(({ data }) => setKeyInfo(data as KeyInfo | null));
    loadOrders();
  }, [session, supabase, loadOrders]);

  const invoke = async (payload: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('binance-trade', { body: payload });
    if (error) throw new Error(error.message);
    if (data?.error) throw new Error(data.error);
    return data;
  };

  const saveKeys = async () => {
    setBusy(true); setMsg(null);
    try {
      await invoke({ action: 'save_keys', api_key: apiKey, api_secret: apiSecret, is_testnet: isTestnet });
      setKeyInfo({ api_key: apiKey, is_testnet: isTestnet });
      setApiKey(''); setApiSecret('');
      setMsg({ text: 'Chave salva com o segredo cifrado no servidor.', ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'erro', ok: false });
    } finally { setBusy(false); }
  };

  const testConnection = async () => {
    setBusy(true); setMsg(null); setBalances([]);
    try {
      const r = await invoke({ action: 'test_connection' });
      setBalances(r.balances ?? []);
      setMsg({ text: `Conexão OK (${r.is_testnet ? 'TESTNET' : 'CONTA REAL'}).`, ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'erro', ok: false });
    } finally { setBusy(false); }
  };

  const deleteKeys = async () => {
    if (!confirm('Remover a chave da Binance? Ordens abertas na exchange não são canceladas.')) return;
    setBusy(true); setMsg(null);
    try {
      await invoke({ action: 'delete_keys' });
      setKeyInfo(null); setBalances([]);
      setMsg({ text: 'Chave removida.', ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'erro', ok: false });
    } finally { setBusy(false); }
  };

  const placeTestOrder = async () => {
    const resumo = `${ordSymbol} · gastar ${ordAmount} USDT · stop -${ordStop}% · alvo +${ordTarget}%` +
      ` · ${keyInfo?.is_testnet ? 'TESTNET' : 'CONTA REAL ⚠️'}`;
    if (!confirm(`Confirmar ordem?\n\n${resumo}`)) return;
    setOrdBusy(true); setOrdResult('');
    try {
      const r = await invoke({
        action: 'place_entry_oco', symbol: ordSymbol,
        quote_amount: Number(ordAmount), stop_pct: Number(ordStop), target_pct: Number(ordTarget),
      });
      setOrdResult(
        `Executada (${r.is_testnet ? 'testnet' : 'REAL'}): comprou ${r.entrada.qty} a ~${r.entrada.preco_medio.toFixed(2)} ` +
        `(gasto ${r.entrada.gasto_usdt.toFixed(2)} USDT). OCO ativa: alvo ${r.saida.alvo} / stop ${r.saida.stop}.`,
      );
      loadOrders();
    } catch (e) {
      setOrdResult(`Erro: ${e instanceof Error ? e.message : 'desconhecido'}`);
      loadOrders();
    } finally { setOrdBusy(false); }
  };

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
        <nav style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 8, fontSize: 13 }}>
          <a href="/" style={{ color: S.dim, textDecoration: 'none' }}>Análise</a>
          <a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>Alertas</a>
          <span style={{ color: S.a, fontWeight: 600 }}>Conta Binance</span>
          {session && (
            <button onClick={() => supabase.auth.signOut()}
              style={{ background: 'transparent', border: 'none', color: S.red, fontSize: 13, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
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
            {/* --------------------------- Chave --------------------------- */}
            <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Chave de API</div>

              {keyInfo ? (
                <>
                  <div style={{ fontSize: 13 }}>
                    Configurada: <code style={{ color: S.a }}>...{keyInfo.api_key.slice(-6)}</code>{' '}
                    <span style={{
                      marginLeft: 6, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                      background: keyInfo.is_testnet ? `${S.green}22` : `${S.red}22`,
                      color: keyInfo.is_testnet ? S.green : S.red,
                    }}>
                      {keyInfo.is_testnet ? 'TESTNET' : 'CONTA REAL'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button onClick={testConnection} disabled={busy}
                      style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                      Testar conexão
                    </button>
                    <button onClick={deleteKeys} disabled={busy}
                      style={{ background: 'transparent', color: S.red, border: `1px solid ${S.red}55`, borderRadius: 8, padding: '8px 18px', fontSize: 13, cursor: 'pointer' }}>
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
                  <input placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                    style={{ ...inputStyle, width: '100%', maxWidth: 420 }} />
                  <input placeholder="API Secret" type="password" value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)} autoComplete="off"
                    style={{ ...inputStyle, width: '100%', maxWidth: 420 }} />
                  <label style={{ fontSize: 13, color: S.dim, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={isTestnet} onChange={(e) => setIsTestnet(e.target.checked)} />
                    É chave da testnet
                  </label>
                  {!isTestnet && (
                    <div style={{ color: S.red, fontSize: 12, maxWidth: 420 }}>
                      ⚠️ Chave da conta REAL: ordens movimentam dinheiro de verdade. Use valores pequenos.
                    </div>
                  )}
                  <button onClick={saveKeys} disabled={busy || !apiKey || !apiSecret}
                    style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy || !apiKey || !apiSecret ? 0.6 : 1 }}>
                    {busy ? 'Salvando...' : 'Salvar chave'}
                  </button>
                </>
              )}

              {msg && <span style={{ color: msg.ok ? S.green : S.red, fontSize: 13 }}>{msg.text}</span>}

              {balances.length > 0 && (
                <div style={{ fontSize: 12, color: S.dim }}>
                  Saldos: {balances.map((b) => `${b.asset} ${Number(b.free).toFixed(4)}`).join(' · ')}
                </div>
              )}
            </Card>

            {/* --------------------------- Ordem de teste --------------------------- */}
            {keyInfo && (
              <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Nova ordem (entrada + OCO)</div>
                <div style={{ fontSize: 12, color: S.dim, maxWidth: 480 }}>
                  Compra a mercado gastando o valor em USDT e registra na Binance uma saída OCO:
                  alvo (venda no lucro) e stop (venda na perda máxima) — quando um executa, o outro cancela.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Par
                    <select value={ordSymbol} onChange={(e) => setOrdSymbol(e.target.value)} style={inputStyle}>
                      {['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Gastar (USDT)
                    <input type="number" min="10" value={ordAmount} onChange={(e) => setOrdAmount(e.target.value)} style={{ ...inputStyle, width: 100 }} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Stop (−%)
                    <input type="number" min="0.5" step="0.5" value={ordStop} onChange={(e) => setOrdStop(e.target.value)} style={{ ...inputStyle, width: 80 }} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim }}>
                    Alvo (+%)
                    <input type="number" min="0.5" step="0.5" value={ordTarget} onChange={(e) => setOrdTarget(e.target.value)} style={{ ...inputStyle, width: 80 }} />
                  </label>
                  <button onClick={placeTestOrder} disabled={ordBusy}
                    style={{ background: keyInfo.is_testnet ? S.a : S.red, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: ordBusy ? 0.6 : 1 }}>
                    {ordBusy ? 'Enviando...' : keyInfo.is_testnet ? 'Enviar (testnet)' : 'Enviar (REAL ⚠️)'}
                  </button>
                </div>
                {ordResult && (
                  <div style={{ fontSize: 13, color: ordResult.startsWith('Erro') ? S.red : S.green, maxWidth: 520 }}>
                    {ordResult}
                  </div>
                )}
              </Card>
            )}

            {/* --------------------------- Histórico de ordens --------------------------- */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Histórico de ordens</div>
                <button onClick={loadOrders}
                  style={{ background: 'transparent', color: S.dim, border: `1px solid ${S.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
                  Atualizar
                </button>
              </div>
              {orders.length === 0 ? (
                <div style={{ color: S.dim, fontSize: 13, textAlign: 'center' }}>Nenhuma ordem registrada ainda.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {orders.map((o) => {
                    const st = STATUS_LABEL[o.status] ?? { label: o.status, color: S.dim };
                    return (
                      <div key={o.id} style={{ border: `1px solid ${S.border}`, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                        <div style={{ fontSize: 13 }}>
                          <strong>{o.symbol}</strong>
                          {o.is_testnet && <span style={{ color: S.green, fontSize: 11 }}> testnet</span>}
                          {' '}· <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>
                          {o.pnl_usdt !== null && (
                            <span style={{ color: o.pnl_usdt >= 0 ? S.green : S.red }}>
                              {' '}· {o.pnl_usdt >= 0 ? '+' : ''}{fmt(o.pnl_usdt)} USDT
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 11, color: S.dim, marginTop: 4 }}>
                          {fmtData(o.criado_em)} · gasto {fmt(o.quote_amount)} USDT
                          {o.entry_price !== null && ` · entrada ${fmt(o.entry_price)}`}
                          {o.exit_price !== null && ` · saída ${fmt(o.exit_price)}`}
                          {o.status === 'oco_ativa' && o.target_price !== null && o.stop_price !== null &&
                            ` · alvo ${fmt(o.target_price)} / stop ${fmt(o.stop_price)}`}
                          {o.erro && ` · ${o.erro.slice(0, 80)}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ fontSize: 11, color: S.dim, textAlign: 'center', marginTop: 10 }}>
                Ordens com OCO ativa são verificadas a cada 5 minutos; o resultado (alvo/stop) chega também por email.
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
