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

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '../../lib/supabaseClient';

// ---------------------------------------------------------------------------
// Domínio (espelha os CHECKs do banco — mantenha em sincronia)
// ---------------------------------------------------------------------------

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'] as const;
const TIMEFRAMES = [
  { value: '1h', label: '1 hora' },
  { value: '4h', label: '4 horas' },
  { value: '1d', label: 'diário' },
  { value: '1w', label: 'semanal' },
] as const;
const INDICADORES = [
  { value: 'preco', label: 'Preço (USDT)' },
  { value: 'volatilidade', label: 'Volatilidade anualizada (%)' },
  { value: 'regime', label: 'Regime de volatilidade' },
] as const;
const REGIMES = ['calmo', 'normal', 'volátil', 'extremo'] as const;
const ALERT_LIMIT = 10;

type SymbolName = (typeof SYMBOLS)[number];
type Timeframe = (typeof TIMEFRAMES)[number]['value'];
type Indicador = (typeof INDICADORES)[number]['value'];
type Operador = 'acima' | 'abaixo';
type Regime = (typeof REGIMES)[number];

interface Rule {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  indicador: Indicador;
  operador: Operador | null;
  nivel: number | string | null;
  nivel_regime: Regime | null;
  ativo: boolean;
  ultimo_lado: Operador | null;
  ultimo_regime: Regime | null;
  last_triggered_at: string | null;
  criado_em: string;
}

interface AlertEvent {
  id: string;
  rule_id: string;
  valor: number | string | null;
  regime: string | null;
  mensagem: string | null;
  notificado: boolean;
  erro_envio: string | null;
  disparado_em: string;
}

// ---------------------------------------------------------------------------
// Estilo (mesma paleta do dashboard)
// ---------------------------------------------------------------------------

const S = {
  bg: '#101418', panel: '#181f26', border: '#2a343f',
  text: '#d7dee6', dim: '#7d8a97',
  a: '#e8a13c', green: '#3fb26f', red: '#d05555', blue: '#4f8fd0',
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
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });

function fmtNivel(value: number | string | null): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '—';
  return numberValue.toLocaleString('pt-BR', { maximumFractionDigits: 8 });
}

function getErrorMessage(error: unknown, fallback = 'Não foi possível concluir a operação.'): string {
  if (!error) return fallback;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim();
    if (message) return message;
  }
  return fallback;
}

function friendlyDatabaseError(error: unknown): string {
  const message = getErrorMessage(error);
  const normalized = message.toLocaleLowerCase('pt-BR');

  if (normalized.includes('limite de 10 alertas')) {
    return 'Limite de 10 alertas ativos atingido. Pause um alerta antes de ativar outro.';
  }
  if (normalized.includes('duplicate') || normalized.includes('duplicad')) {
    return 'Já existe um registro igual. Atualize a página e tente novamente.';
  }
  if (normalized.includes('row-level security') || normalized.includes('rls')) {
    return 'Sua sessão não autorizou esta alteração. Entre novamente e repita a operação.';
  }
  if (normalized.includes('jwt') || normalized.includes('token')) {
    return 'Sua sessão expirou. Entre novamente para continuar.';
  }

  return message;
}

function descreveRegra(r: Rule): string {
  const tfLabel = TIMEFRAMES.find((t) => t.value === r.timeframe)?.label ?? r.timeframe;
  if (r.indicador === 'regime') return `${r.symbol} · ${tfLabel} · regime vira ${r.nivel_regime ?? '—'}`;
  const indicadorLabel = r.indicador === 'preco' ? 'preço' : 'volatilidade';
  const unidade = r.indicador === 'preco' ? ' USDT' : '%';
  return `${r.symbol} · ${tfLabel} · ${indicadorLabel} ${r.operador ?? '—'} de ${fmtNivel(r.nivel)}${unidade}`;
}

function eventDelivery(event: AlertEvent): { label: string; color: string; detail: string | null } {
  if (event.notificado) {
    return { label: 'email enviado', color: S.green, detail: null };
  }

  const error = event.erro_envio?.trim() || null;
  if (!error) {
    return { label: 'evento registrado', color: S.dim, detail: null };
  }

  const normalized = error.toLocaleLowerCase('pt-BR');
  if (normalized.includes('não configurad')) {
    return { label: 'evento registrado · email não configurado', color: S.a, detail: error };
  }
  if (normalized.includes('sem email')) {
    return { label: 'evento registrado · conta sem email', color: S.a, detail: error };
  }

  return { label: 'evento registrado · email não enviado', color: S.red, detail: error };
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
  const [authBusy, setAuthBusy] = useState(false);

  // Formulário de regra
  const [symbol, setSymbol] = useState<SymbolName>('BTCUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const [indicador, setIndicador] = useState<Indicador>('preco');
  const [operador, setOperador] = useState<Operador>('acima');
  const [nivel, setNivel] = useState('');
  const [nivelRegime, setNivelRegime] = useState<Regime>('volátil');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  // Dados
  const [rules, setRules] = useState<Rule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);

  const activeCount = useMemo(() => rules.filter((rule) => rule.ativo).length, [rules]);

  // Sessão -------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) setAuthError(error.message);
      setSession(data.session);
      setAuthReady(true);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) {
        setRules([]);
        setEvents([]);
        setLoadError('');
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  // Carrega regras + eventos -------------------------------------------------
  const load = useCallback(async () => {
    if (!session) return;

    setLoading(true);
    setLoadError('');

    try {
      const [rulesResult, eventsResult] = await Promise.all([
        supabase
          .from('alert_rules')
          .select('id, symbol, timeframe, indicador, operador, nivel, nivel_regime, ativo, ultimo_lado, ultimo_regime, last_triggered_at, criado_em')
          .order('criado_em', { ascending: false }),
        supabase
          .from('alert_events')
          .select('id, rule_id, valor, regime, mensagem, notificado, erro_envio, disparado_em')
          .order('disparado_em', { ascending: false })
          .limit(20),
      ]);

      const errors = [rulesResult.error, eventsResult.error].filter(Boolean);
      if (errors.length > 0) throw errors[0];

      setRules((rulesResult.data as Rule[] | null) ?? []);
      setEvents((eventsResult.data as AlertEvent[] | null) ?? []);
    } catch (error) {
      setLoadError(friendlyDatabaseError(error));
    } finally {
      setLoading(false);
    }
  }, [session, supabase]);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  // Atualiza ao voltar para a aba, útil quando o CRON disparou um alerta.
  useEffect(() => {
    if (!session) return;

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [session, load]);

  // Ações --------------------------------------------------------------------
  const sendMagicLink = async () => {
    const normalizedEmail = email.trim().toLocaleLowerCase('pt-BR');
    setAuthError('');

    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      setAuthError('Email inválido.');
      return;
    }

    setAuthBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/alertas` : undefined,
        },
      });
      if (error) throw error;
      setEmail(normalizedEmail);
      setMagicSent(true);
    } catch (error) {
      setAuthError(getErrorMessage(error, 'Não foi possível enviar o link de acesso.'));
    } finally {
      setAuthBusy(false);
    }
  };

  const createRule = async () => {
    if (!session || saving) return;

    setFormError('');

    if (activeCount >= ALERT_LIMIT) {
      setFormError('Limite de 10 alertas ativos atingido. Pause um alerta antes de criar outro.');
      return;
    }

    const isRegime = indicador === 'regime';
    const numericLevel = Number(nivel.replace(',', '.'));

    if (!isRegime && (!nivel.trim() || !Number.isFinite(numericLevel) || numericLevel <= 0)) {
      setFormError('Informe um nível numérico maior que zero.');
      return;
    }

    const duplicate = rules.some((rule) => {
      if (!rule.ativo || rule.symbol !== symbol || rule.timeframe !== timeframe || rule.indicador !== indicador) return false;
      if (isRegime) return rule.nivel_regime === nivelRegime;
      return rule.operador === operador && Number(rule.nivel) === numericLevel;
    });

    if (duplicate) {
      setFormError('Já existe um alerta ativo com exatamente essa configuração.');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.from('alert_rules').insert({
        user_id: session.user.id,
        symbol,
        timeframe,
        indicador,
        operador: isRegime ? null : operador,
        nivel: isRegime ? null : numericLevel,
        nivel_regime: isRegime ? nivelRegime : null,
        ativo: true,
      });

      if (error) throw error;
      setNivel('');
      await load();
    } catch (error) {
      setFormError(friendlyDatabaseError(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule: Rule) => {
    if (actionId) return;

    setFormError('');
    setLoadError('');

    if (!rule.ativo && activeCount >= ALERT_LIMIT) {
      setFormError('Limite de 10 alertas ativos atingido. Pause outro alerta antes de reativar este.');
      return;
    }

    setActionId(rule.id);
    try {
      const { data, error } = await supabase
        .from('alert_rules')
        .update({ ativo: !rule.ativo })
        .eq('id', rule.id)
        .select('id, ativo')
        .single();

      if (error) throw error;
      if (!data) throw new Error('O alerta não foi encontrado.');

      setRules((current) => current.map((item) => (
        item.id === rule.id ? { ...item, ativo: Boolean(data.ativo) } : item
      )));
    } catch (error) {
      setLoadError(friendlyDatabaseError(error));
      await load();
    } finally {
      setActionId(null);
    }
  };

  const deleteRule = async (rule: Rule) => {
    if (actionId) return;
    if (!confirm(`Excluir o alerta "${descreveRegra(rule)}"? O histórico ligado a ele também será removido.`)) return;

    setLoadError('');
    setActionId(rule.id);
    try {
      const { data, error } = await supabase
        .from('alert_rules')
        .delete()
        .eq('id', rule.id)
        .select('id');

      if (error) throw error;
      if (!data?.length) throw new Error('O alerta não foi encontrado ou já havia sido excluído.');

      setRules((current) => current.filter((item) => item.id !== rule.id));
      setEvents((current) => current.filter((event) => event.rule_id !== rule.id));
    } catch (error) {
      setLoadError(friendlyDatabaseError(error));
      await load();
    } finally {
      setActionId(null);
    }
  };

  const signOut = async () => {
    setAuthError('');
    const { error } = await supabase.auth.signOut();
    if (error) setAuthError(error.message);
  };

  // Render -------------------------------------------------------------------
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

<span style={{ color: S.a, fontWeight: 600 }}>
  Alertas
</span>

<a href="/conta" style={{ color: S.dim, textDecoration: 'none' }}>
  Conta Binance
</a>
          {session && (
            <button onClick={signOut}
              style={{ background: 'transparent', border: 'none', color: S.red, fontSize: 13, cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
              Sair
            </button>
          )}
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
              <>
                <div style={{ color: S.green, fontSize: 14 }}>
                  Link enviado para <strong>{email}</strong>. Abra o email e clique para entrar (confira o spam).
                </div>
                <button onClick={() => setMagicSent(false)} disabled={authBusy}
                  style={{ background: 'transparent', color: S.a, border: `1px solid ${S.a}`, borderRadius: 8, padding: '8px 18px', fontSize: 13, cursor: 'pointer' }}>
                  Enviar novamente
                </button>
              </>
            ) : (
              <>
                <input type="email" placeholder="seu@email.com" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !authBusy) void sendMagicLink(); }}
                  autoComplete="email"
                  disabled={authBusy}
                  style={{ ...inputStyle, width: 260, opacity: authBusy ? 0.7 : 1 }} />
                <button onClick={sendMagicLink} disabled={authBusy}
                  style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: authBusy ? 0.6 : 1 }}>
                  {authBusy ? 'Enviando...' : 'Enviar link de acesso'}
                </button>
              </>
            )}
            {authError && <span style={{ color: S.red, fontSize: 13 }}>{authError}</span>}
          </Card>
        ) : (
          <>
            {/* ------------------------- Criar alerta ------------------------- */}
            <Card style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center' }}>Novo alerta</div>
              <div style={{ fontSize: 12, color: activeCount >= ALERT_LIMIT ? S.red : S.dim, textAlign: 'center' }}>
                {activeCount} de {ALERT_LIMIT} alertas ativos
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                  Ativo
                  <select value={symbol} onChange={(e) => setSymbol(e.target.value as SymbolName)} style={inputStyle} disabled={saving}>
                    {SYMBOLS.map((item) => <option key={item}>{item}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                  Timeframe
                  <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} style={inputStyle} disabled={saving}>
                    {TIMEFRAMES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                  Indicador
                  <select value={indicador} onChange={(e) => setIndicador(e.target.value as Indicador)} style={inputStyle} disabled={saving}>
                    {INDICADORES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>

                {indicador === 'regime' ? (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                    Avisar quando virar
                    <select value={nivelRegime} onChange={(e) => setNivelRegime(e.target.value as Regime)} style={inputStyle} disabled={saving}>
                      {REGIMES.map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </label>
                ) : (
                  <>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                      Condição
                      <select value={operador} onChange={(e) => setOperador(e.target.value as Operador)} style={inputStyle} disabled={saving}>
                        <option value="acima">acima de</option>
                        <option value="abaixo">abaixo de</option>
                      </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: S.dim, textAlign: 'center' }}>
                      Nível {indicador === 'preco' ? '(USDT)' : '(%)'}
                      <input type="number" min="0" step="any" value={nivel}
                        onChange={(e) => setNivel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !saving) void createRule(); }}
                        placeholder={indicador === 'preco' ? '65000' : '60'}
                        disabled={saving}
                        style={{ ...inputStyle, width: 110 }} />
                    </label>
                  </>
                )}

                <button onClick={createRule} disabled={saving || activeCount >= ALERT_LIMIT}
                  style={{ background: S.a, color: '#1a1206', border: 'none', borderRadius: 8, padding: '10px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving || activeCount >= ALERT_LIMIT ? 0.6 : 1 }}>
                  {saving ? 'Salvando...' : 'Criar alerta'}
                </button>
              </div>

              {formError && <span style={{ color: S.red, fontSize: 13, textAlign: 'center' }}>{formError}</span>}
              <div style={{ fontSize: 11, color: S.dim, textAlign: 'center', maxWidth: 520 }}>
                O aviso é disparado quando o valor cruza o nível — não enquanto permanece nele —,
                com intervalo mínimo de 60 minutos entre avisos da mesma regra. Verificação a cada 5 minutos.
              </div>
            </Card>

            {/* ------------------------- Regras ------------------------- */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center' }}>
                  Alertas configurados
                  <span style={{ color: S.dim, fontWeight: 400 }}> · {activeCount} ativos</span>
                </div>
                <button onClick={load} disabled={loading || actionId !== null}
                  style={{ background: 'transparent', color: S.dim, border: `1px solid ${S.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
                  {loading ? 'Atualizando...' : 'Atualizar'}
                </button>
              </div>

              {loadError && (
                <div style={{ color: S.red, fontSize: 13, textAlign: 'center', marginBottom: 10 }}>
                  {loadError}
                </div>
              )}

              {rules.length === 0 && !loading && (
                <div style={{ color: S.dim, fontSize: 13, textAlign: 'center' }}>Nenhum alerta ainda. Crie o primeiro acima.</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rules.map((rule) => {
                  const isBusy = actionId === rule.id;
                  return (
                    <div key={rule.id} style={{
                      display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 10,
                      border: `1px solid ${S.border}`, borderRadius: 8, padding: '10px 12px',
                      opacity: rule.ativo ? 1 : 0.5, textAlign: 'center',
                    }}>
                      <span style={{ fontSize: 13, flex: '1 1 260px' }}>{descreveRegra(rule)}</span>
                      <span style={{ fontSize: 11, color: S.dim }}>
                        {rule.last_triggered_at ? `último aviso ${fmtData(rule.last_triggered_at)}` : 'nunca disparou'}
                      </span>
                      <button onClick={() => toggleRule(rule)} disabled={actionId !== null}
                        style={{ background: 'transparent', color: rule.ativo ? S.a : S.green, border: `1px solid ${rule.ativo ? S.a : S.green}`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', opacity: actionId !== null && !isBusy ? 0.5 : 1 }}>
                        {isBusy ? 'Salvando...' : rule.ativo ? 'Pausar' : 'Reativar'}
                      </button>
                      <button onClick={() => deleteRule(rule)} disabled={actionId !== null}
                        style={{ background: 'transparent', color: S.red, border: `1px solid ${S.red}55`, borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', opacity: actionId !== null && !isBusy ? 0.5 : 1 }}>
                        Excluir
                      </button>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* ------------------------- Histórico ------------------------- */}
            <Card>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 15, fontWeight: 600, textAlign: 'center' }}>Últimos disparos</div>
                <button onClick={load} disabled={loading || actionId !== null}
                  style={{ background: 'transparent', color: S.dim, border: `1px solid ${S.border}`, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
                  {loading ? 'Atualizando...' : 'Atualizar'}
                </button>
              </div>

              {events.length === 0 && !loading && (
                <div style={{ color: S.dim, fontSize: 13, textAlign: 'center' }}>Nenhum disparo registrado ainda.</div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {events.map((event) => {
                  const delivery = eventDelivery(event);
                  return (
                    <div key={event.id} style={{ border: `1px solid ${S.border}`, borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                      <div style={{ fontSize: 13 }}>{event.mensagem || 'Alerta disparado.'}</div>
                      <div style={{ fontSize: 11, color: S.dim, marginTop: 4 }}>
                        {fmtData(event.disparado_em)} · <span style={{ color: delivery.color }}>{delivery.label}</span>
                      </div>
                      {delivery.detail && (
                        <div title={delivery.detail} style={{ fontSize: 10, color: S.dim, marginTop: 3, overflowWrap: 'anywhere' }}>
                          {delivery.detail.length > 140 ? `${delivery.detail.slice(0, 140)}…` : delivery.detail}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 11, color: S.dim, textAlign: 'center', marginTop: 10 }}>
                O CRON avalia as regras a cada 5 minutos. O histórico é atualizado ao abrir esta página,
                voltar para esta aba ou tocar em “Atualizar”.
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
