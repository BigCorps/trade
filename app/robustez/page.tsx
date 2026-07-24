'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabaseClient';

const S = { bg: '#101418', panel: '#181f26', soft: '#141a20', border: '#2a343f', text: '#d7dee6', dim: '#7d8a97', orange: '#e8a13c', blue: '#4f8fd0', green: '#3fb26f', red: '#d05555' };

type Config = { id: string; nome: string; versao: string };
type Validation = { iniciado_em: string; status: string; operacoes_fechadas: number; resultado: unknown };
type Integrity = { problemas_total: number; sinais_total: number; entradas_antes_do_fechamento: number; saidas_antes_da_entrada: number; fechados_incompletos: number; grupos_duplicados: number };
type NewsRun = { iniciado_em: string; status: string; artigos_recebidos: number; eventos_novos: number; reacoes_processadas: number; falhas: number };
type NewsEvent = { id: string; titulo: string; categoria: string; direcao_esperada: string; confianca_pct: number; publicado_em: string; dominio_fonte: string | null; novidade: string };
type Impact = { categoria: string; direcao_esperada: string; horizonte_minutos: number; reacoes: number; retorno_medio_excesso_pct: number | null; direcao_confirmada_pct: number | null; impactos_altos: number };

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function number(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function fmt(value: unknown, digits = 2) { const parsed = number(value); return parsed === null ? '—' : parsed.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
function fmtR(value: unknown) { const parsed = number(value); return parsed === null ? '—' : (parsed > 0 ? '+' : '') + fmt(parsed) + 'R'; }
function fmtPct(value: unknown) { const parsed = number(value); return parsed === null ? '—' : fmt(parsed) + '%'; }
function date(value: string | null | undefined) { if (!value) return '—'; return new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }

function Card({ children }: { children: React.ReactNode }) { return <section style={{ background: S.panel, border: '1px solid ' + S.border, borderRadius: 12, padding: 18 }}>{children}</section>; }
function Metric({ label, value, detail, color }: { label: string; value: string; detail?: string; color?: string }) { return <div style={{ background: S.soft, border: '1px solid ' + S.border, borderRadius: 10, padding: 14, minWidth: 150, flex: '1 1 150px' }}><div style={{ color: S.dim, fontSize: 11 }}>{label}</div><div style={{ color: color ?? S.text, fontSize: 22, fontWeight: 700, marginTop: 5 }}>{value}</div>{detail && <div style={{ color: S.dim, fontSize: 11, marginTop: 4 }}>{detail}</div>}</div>; }

export default function RobustezPage() {
  const supabase = useMemo(() => getSupabase(), []);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null); const [validation, setValidation] = useState<Validation | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null); const [newsRun, setNewsRun] = useState<NewsRun | null>(null);
  const [events, setEvents] = useState<NewsEvent[]>([]); const [impact, setImpact] = useState<Impact[]>([]); const [reactionCount, setReactionCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const configResult = await supabase.from('forward_test_config').select('id, nome, versao').eq('ativo', true).maybeSingle();
    if (configResult.error || !configResult.data) { setError(configResult.error?.message ?? 'Configuração ativa não encontrada. Faça login.'); setLoading(false); return; }
    const current = configResult.data as Config; setConfig(current);
    const [validationResult, integrityResult, newsRunResult, eventResult, impactResult, reactionResult] = await Promise.all([
      supabase.from('forward_test_validation_latest').select('*').eq('config_id', current.id).maybeSingle(),
      supabase.from('forward_test_integrity_summary').select('*').eq('config_id', current.id).maybeSingle(),
      supabase.from('market_news_runs').select('*').order('iniciado_em', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('market_news_events').select('id, titulo, categoria, direcao_esperada, confianca_pct, publicado_em, dominio_fonte, novidade').order('publicado_em', { ascending: false }).limit(20),
      supabase.from('market_news_impact_summary').select('*').order('reacoes', { ascending: false }).limit(40),
      supabase.from('market_news_reactions').select('*', { count: 'exact', head: true }),
    ]);
    const failure = validationResult.error ?? integrityResult.error ?? newsRunResult.error ?? eventResult.error ?? impactResult.error ?? reactionResult.error;
    if (failure) setError(failure.message);
    setValidation(validationResult.data as Validation | null); setIntegrity(integrityResult.data as Integrity | null); setNewsRun(newsRunResult.data as NewsRun | null);
    setEvents((eventResult.data as NewsEvent[] | null) ?? []); setImpact((impactResult.data as Impact[] | null) ?? []); setReactionCount(reactionResult.count ?? 0); setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);
  const result = object(validation?.resultado); const base = object(result.base); const stress = object(result.stress); const costs2x = object(stress.costs2x);
  const robustness = object(result.robustness); const monteCarlo = object(result.monteCarlo); const drawdown = object(monteCarlo.drawdownR); const readiness = object(result.readiness);
  const ready = readiness.readyForRealMoney === true;

  return <main style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
    <header style={{ background: S.panel, borderBottom: '1px solid ' + S.border, padding: '12px 20px', textAlign: 'center' }}>
      <img src="/logo.png" alt="VigIA Trade" style={{ height: 32 }} />
      <div style={{ fontWeight: 700, marginTop: 4 }}>Robustez e contexto de mercado</div>
      <nav style={{ display: 'flex', justifyContent: 'center', gap: 20, flexWrap: 'wrap', marginTop: 9, fontSize: 13 }}>
        <a href="/" style={{ color: S.dim, textDecoration: 'none' }}>Análise</a><a href="/daytrade" style={{ color: S.dim, textDecoration: 'none' }}>Validação</a><a href="/oportunidades" style={{ color: S.dim, textDecoration: 'none' }}>Teste prospectivo</a><span style={{ color: S.blue, fontWeight: 700 }}>Robustez</span><a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>Alertas</a>
      </nav>
    </header>
    <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 16px 60px', display: 'grid', gap: 18 }}>
      {loading && <Card>Carregando…</Card>}{error && <Card><span style={{ color: S.orange }}>{error}</span></Card>}
      {!loading && config && <>
        <Card><div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><div><div style={{ fontWeight: 700 }}>{config.nome} v{config.versao}</div><div style={{ color: S.dim, fontSize: 12, marginTop: 4 }}>Última validação: {date(validation?.iniciado_em)}</div></div><button onClick={() => void load()} style={{ background: S.blue, border: 0, color: 'white', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}>Atualizar</button></div></Card>
        <Card><h2 style={{ fontSize: 15, marginTop: 0 }}>Prontidão estatística</h2><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Metric label="Operações encerradas" value={fmt(validation?.operacoes_fechadas, 0)} /><Metric label="Resultado acumulado" value={fmtR(base.sum)} color={(number(base.sum) ?? 0) >= 0 ? S.green : S.red} /><Metric label="Resultado com custos 2x" value={fmtR(costs2x.sum)} /><Metric label="Sem as 3 melhores" value={fmtR(robustness.withoutBestThreeTradesR)} /><Metric label="Prob. terminar negativo" value={fmtPct(monteCarlo.probabilityNegativePct)} /><Metric label="Drawdown P95" value={fmtR(drawdown.p95)} /></div><div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: ready ? 'rgba(63,178,111,.10)' : 'rgba(232,161,60,.08)', color: ready ? S.green : S.orange }}>{ready ? 'Critérios automáticos mínimos atendidos. A decisão real ainda exige revisão humana e estabilidade por mais amostras.' : 'Ainda não aprovado para dinheiro real. O painel continuará acumulando operações, cenários de estresse e Monte Carlo.'}</div></Card>
        <Card><h2 style={{ fontSize: 15, marginTop: 0 }}>Integridade operacional</h2><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Metric label="Problemas encontrados" value={fmt(integrity?.problemas_total, 0)} color={(integrity?.problemas_total ?? 0) === 0 ? S.green : S.red} /><Metric label="Sinais auditados" value={fmt(integrity?.sinais_total, 0)} /><Metric label="Entradas antecipadas" value={fmt(integrity?.entradas_antes_do_fechamento, 0)} /><Metric label="Fechamentos incompletos" value={fmt(integrity?.fechados_incompletos, 0)} /><Metric label="Grupos duplicados" value={fmt(integrity?.grupos_duplicados, 0)} /></div></Card>
        <Card><h2 style={{ fontSize: 15, marginTop: 0 }}>Estudo prospectivo de notícias</h2><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><Metric label="Última coleta" value={date(newsRun?.iniciado_em)} detail={newsRun?.status ?? 'ainda não executada'} /><Metric label="Artigos recebidos" value={fmt(newsRun?.artigos_recebidos, 0)} /><Metric label="Eventos novos" value={fmt(newsRun?.eventos_novos, 0)} /><Metric label="Reações programadas" value={fmt(reactionCount, 0)} /><Metric label="Reações concluídas no run" value={fmt(newsRun?.reacoes_processadas, 0)} /><Metric label="Falhas no run" value={fmt(newsRun?.falhas, 0)} color={(newsRun?.falhas ?? 0) > 0 ? S.orange : S.green} /></div><p style={{ color: S.dim, fontSize: 12, lineHeight: 1.6 }}>As notícias são somente contexto. Elas não criam, bloqueiam ou modificam operações da configuração congelada.</p></Card>
        {impact.length > 0 && <Card><h2 style={{ fontSize: 15, marginTop: 0 }}>Impacto observado por categoria</h2><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}><thead><tr>{['Categoria','Direção textual','Horizonte','Amostra','Excesso médio','Direção confirmada','Impactos altos'].map((label) => <th key={label} style={{ textAlign: 'left', color: S.dim, padding: 8, borderBottom: '1px solid ' + S.border }}>{label}</th>)}</tr></thead><tbody>{impact.map((row, index) => <tr key={row.categoria + row.direcao_esperada + row.horizonte_minutos + index}><td style={{ padding: 8 }}>{row.categoria}</td><td style={{ padding: 8 }}>{row.direcao_esperada}</td><td style={{ padding: 8 }}>{row.horizonte_minutos} min</td><td style={{ padding: 8 }}>{row.reacoes}</td><td style={{ padding: 8 }}>{fmtPct(row.retorno_medio_excesso_pct)}</td><td style={{ padding: 8 }}>{fmtPct(row.direcao_confirmada_pct)}</td><td style={{ padding: 8 }}>{row.impactos_altos}</td></tr>)}</tbody></table></div></Card>}
        <Card><h2 style={{ fontSize: 15, marginTop: 0 }}>Notícias recentes</h2>{events.length === 0 ? <div style={{ color: S.dim }}>A coleta ainda não registrou eventos.</div> : <div style={{ display: 'grid', gap: 10 }}>{events.map((event) => <article key={event.id} style={{ background: S.soft, border: '1px solid ' + S.border, borderRadius: 9, padding: 12 }}><div style={{ fontSize: 13, fontWeight: 600 }}>{event.titulo}</div><div style={{ color: S.dim, fontSize: 11, marginTop: 6 }}>{event.categoria} · {event.direcao_esperada} · confiança {fmtPct(event.confianca_pct)} · {event.novidade} · {event.dominio_fonte ?? 'fonte não identificada'} · {date(event.publicado_em)}</div></article>)}</div>}</Card>
      </>}
    </div>
  </main>;
}
