'use client';

/**
 * app/alertas/page.tsx — VigIA Trade
 * ----------------------------------------------------------------------------
 * Login por magic link + gestão de alertas:
 * - criar regra (preço / volatilidade / regime, com campos condicionais)
 * - listar, pausar/reativar e excluir regras
 * - histórico dos últimos disparos (alert_events)
 * CRUD direto no Supabase protegido por RLS (user_id = auth.uid()).
 */

import { useState, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Domínio (espelha os CHECKs da migração 001 — mantenha em sincronia)
// ---------------------------------------------------------------------------

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const TIMEFRAMES = [
  { value: '1h', label: '1 hora' }, { value: '4h', label: '4 horas' },
  { value: '1d', label: 'diário' }, { value: '1w', label: 'semanal' },
];
const INDICADORES = [
  { value: 'preco', label: 'Preço (USDT)' },
  { value: 'volatilidade', label: 'Volatilidade anualizada (%)' },
  { value: 'regime', label: 'Regime de volatilidade' },
];
const REGIMES = ['calmo', 'normal', 'volátil', 'extremo'];

interface Rule {
  id: string;
  symbol: string;
  timeframe: string;
  indicador: 'preco' | 'volatilidade' | 'regime';
  operador: 'acima' | 'abaixo' | null;
  nivel: number | null;
  nivel_regime: string | null;
  ativo: boolean;
  last_triggered_at: string | null;
  criado_em: string;
}

interface AlertEvent {
  id: string;
  mensagem: string;
  notificado: boolean;
  disparado_em: string;
}

// ---------------------------------------------------------------------------
// Estilo (mesma paleta do dashboard)
// ---------------------------------------------------------------------------

const S = {
  bg: '#101418', panel: '#181f26', border: '#2a343f',
  text: '#d7dee6', dim: '#7d8a97',
  a: '#e8a13c', green: '#3fb26f', red: '#d05555',
};

const inputStyle: React.CSSProperties = {
  background: S.bg, border: `1px solid ${S.border}`, borderRadius: 6,
  color: S.text, padding: '8px 10px', fontSize: 14, textAlign: 'center',
};

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 10, padding: 16, ...style }}>
      {children}
    </section>
  );
}

const fmtData = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function descreveRegra(r: Rule): string {
  const tfLabel = TIMEFRAMES.find((t) => t.value === r.timeframe)?.label ?? r.timeframe;
  if (r.indicador === 'regime') return `${r.symbol} · ${tfLabel} · regime vira ${r.nivel_regime}`;
  const ind = r.indicador === 'preco' ? 'preço' : 'volatilidade';
  const unidade = r.indicador === 'preco' ? ' USDT' : '%';
  return `${r.symbol} · ${tfLabel} · ${ind} ${r.operador} de ${r.nivel}${unidade}`;
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function AlertasPage() {
  const supabase = getSupabase();

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  // Login
  const [email, setEmail] = useState('');
  const [magicSent, setMagicSent] = useState(false);
  const [authError, setAuthError] = useState('');

  // Formulário de regra
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [timeframe, setTimeframe] = useState('1d');
  const [indicador, setIndicador] = useState<'preco' | 'volatilidade' | 'regime'>('preco');
  const [operador, setOperador] = useState<'acima' | 'abaixo'>('acima');
  const [nivel, setNivel] = useState('');
  const [nivelRegime, setNivelRegime] = useState('volátil');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Dados
  const [rules, setRules] = useState<Rule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(false);

  // Sessão -------------------------------------------------------------------
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  // Carrega regras + eventos ---------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true);
    const [r, e] = await Promise.all([
      supabase.from('alert_rules').select('*').order('criado_em', { ascending: false }),
      supabase.from('alert_events').select('id, mensagem, notificado, disparado_em')
        .order('disparado_em', { ascending: false }).limit(10),
    ]);
    if (!r.error) setRules(r.data as Rule[]);
    if (!e.error) setEvents(e.data as AlertEvent[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { if (session) load(); }, [session, load]);

  // Ações ----------------------------------------------------------------------
  const sendMagicLink = async () => {
    setAuthError('');
    if (!/^\S+@\S+\.\S+$/.test(email)) { setAuthError('Email inválido.'); return; }
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/alertas` : undefined },
    });
    if (error) setAuthError(error.message);
    else setMagicSent(true);
  };

  const createRule = async () => {
    setFormError('');
    const isRegime = indicador === 'regime';
    if (!isRegime) {
      const n = Number(nivel);
      if (!nivel || Number.isNaN(n) || n <= 0) { setFormError('Informe um nível numérico maior que zero.'); return; }
    }
    setSaving(true);
    const { error } = await supabase.from('alert_rules').insert({
      symbol, timeframe, indicador,
      operador: isRegime ? null : operador,
      nivel: isRegime ? null : Number(nivel),
      nivel_regime: isRegime ? nivelRegime : null,
    });
    setSaving(false);
    if (error) {
      setFormError(error.message.includes('Limite') ? 'Limite de 10 alertas ativos atingido.' : error.message);
      return;
    }
    setNivel('');
    load();
  };

  const toggleRule = async (r: Rule) => {
    await supabase.from('alert_rules').update({ ativo: !r.ativo }).eq('id', r.id);
    load();
  };

  const deleteRule = async (r: Rule) => {
    if (!confirm(`Excluir o alerta "${descreveRegra(r)}"?`)) return;
    await supabase.from('alert_rules').delete().eq('id', r.id);
    load();
  };

  // Render ----------------------------------------------------------------------
  return (
    <main style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>

      <header style={{ borderBottom: `1px solid ${S.border}`, background: S.panel, padding: '12px 20px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: S.text }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="VigIA Trade" style={{ height: 32, width: 'auto', display: 'block' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>Meus alertas</div>
            <div style={{ fontSize: 11, color: S.dim }}>monitoramento automático · aviso por email</div>
          </div>
        </a>
        {session && (
          <button onClick={() => supabase.auth.signOut()}
            style={{ position: 'absolute', right: 20, background: 'transparent', color: S.dim, border: `1px solid ${S.border}`, borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
            Sair
          </button>
        )}
        </div>
        <nav style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 8, fontSize: 13 }}>
          <a href="/" style={{ color: S.dim, textDecoration: 'none' }}>Análise</a>
          <span style={{ color: S.a, fontWeight: 600 }}>Alertas</span>
          <a href="/conta" style={{ color: S.dim, textDecoration: 'none' }}>Conta Binance</a>
        </nav>
      </header>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {!authReady ? null : !session ? (
          /* ----------------------------- Login ----------------------------- */
          <Card style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Entre para gerenciar seus alertas</div>
            <div style={{ fontSize: 13, color: S.dim, maxWidth: 420 }}>
              Sem senha: enviamos um link de acesso para o seu email. Os alertas rodam no servidor
              e chegam por email mesmo com o site fechado.
            </div>
            {magicSent ? (
              <div style={{ color: S.green, fontSize: 14 }}>
                Link enviado para <strong>{email}</strong>. Abra o email e clique para entrar (confira o spam).
              </div>
            ) : (
              <>
                <input type="email" placeholder="seu@email.com" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendMagicLink()}
                  style={{ ...inputStyle, width: 260 }} />
                <button onClick={sendMagicLink}
                  style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
                  Enviar link de acesso
                </button>
                {authError && <span style={{ color: S.red, fontSize: 13 }}>{authError}</span>}
              </>
            )}
          </Card>
        ) : (
          <>
            {/* ------------------------- Criar alerta ------------------------- */}
            <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center' }}>Novo alerta</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                  Ativo
                  <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={inputStyle}>
                    {SYMBOLS.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                  Timeframe
                  <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} style={inputStyle}>
                    {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                  Indicador
                  <select value={indicador} onChange={(e) => setIndicador(e.target.value as typeof indicador)} style={inputStyle}>
                    {INDICADORES.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
                  </select>
                </label>

                {indicador === 'regime' ? (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                    Avisar quando virar
                    <select value={nivelRegime} onChange={(e) => setNivelRegime(e.target.value)} style={inputStyle}>
                      {REGIMES.map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </label>
                ) : (
                  <>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                      Condição
                      <select value={operador} onChange={(e) => setOperador(e.target.value as 'acima' | 'abaixo')} style={inputStyle}>
                        <option value="acima">acima de</option>
                        <option value="abaixo">abaixo de</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                      Nível {indicador === 'preco' ? '(USDT)' : '(%)'}
                      <input type="number" min="0" step="any" value={nivel}
                        onChange={(e) => setNivel(e.target.value)}
                        placeholder={indicador === 'preco' ? '65000' : '60'}
                        style={{ ...inputStyle, width: 110 }} />
                    </label>
                  </>
                )}

                <button onClick={createRule} disabled={saving}
                  style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Salvando...' : 'Criar alerta'}
                </button>
              </div>
              {formError && <span style={{ color: S.red, fontSize: 13, textAlign: 'center' }}>{formError}</span>}
              <div style={{ fontSize: 11, color: S.dim, textAlign: 'center', maxWidth: 520 }}>
                O aviso é disparado quando o valor CRUZA o nível (não enquanto permanece nele),
                com intervalo mínimo de 60 min entre avisos da mesma regra. Verificação a cada 5 minutos.
              </div>
            </Card>

            {/* ------------------------- Regras ------------------------- */}
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center', marginBottom: 12 }}>
                Alertas configurados {loading && <span style={{ color: S.dim, fontWeight: 400 }}>· carregando...</span>}
              </div>
              {rules.length === 0 && !loading && (
                <div style={{ color: S.dim, fontSize: 13, textAlign: 'center' }}>Nenhum alerta ainda. Crie o primeiro acima.</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rules.map((r) => (
                  <div key={r.id} style={{
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 10,
                    border: `1px solid ${S.border}`, borderRadius: 8, padding: '10px 12px',
                    opacity: r.ativo ? 1 : 0.5, textAlign: 'center',
                  }}>
                    <span style={{ fontSize: 13, flex: '1 1 260px' }}>{descreveRegra(r)}</span>
                    <span style={{ fontSize: 11, color: S.dim }}>
                      {r.last_triggered_at ? `último aviso ${fmtData(r.last_triggered_at)}` : 'nunca disparou'}
                    </span>
                    <button onClick={() => toggleRule(r)}
                      style={{ background: 'transparent', color: r.ativo ? S.a : S.green, border: `1px solid ${r.ativo ? S.a : S.green}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                      {r.ativo ? 'Pausar' : 'Reativar'}
                    </button>
                    <button onClick={() => deleteRule(r)}
                      style={{ background: 'transparent', color: S.red, border: `1px solid ${S.red}55`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                      Excluir
                    </button>
                  </div>
                ))}
              </div>
            </Card>

            {/* ------------------------- Histórico ------------------------- */}
            <Card>
              <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center', marginBottom: 12 }}>Últimos disparos</div>
              {events.length === 0 && (
                <div style={{ color: S.dim, fontSize: 13, textAlign: 'center' }}>Nenhum disparo registrado ainda.</div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {events.map((e) => (
                  <div key={e.id} style={{ border: `1px solid ${S.border}`, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 13 }}>{e.mensagem}</div>
                    <div style={{ fontSize: 11, color: S.dim, marginTop: 4 }}>
                      {fmtData(e.disparado_em)} · {e.notificado ? 'email enviado' : 'falha no envio'}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
