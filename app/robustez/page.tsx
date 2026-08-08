'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabaseClient';

import CabecalhoVigIA, { S } from '../../components/CabecalhoVigIA';


/**
 * Regras responsivas. Inline style não aceita media query, por isso as faixas
 * roláveis vivem aqui. Desktop mantém o comportamento atual (quebra de linha);
 * até 760px cada faixa vira uma trilha horizontal com snap.
 */
const CSS = `
.vt-page { overflow-x: hidden; }
.vt-card { min-width: 0; }
.vt-row { display: flex; gap: 10px; flex-wrap: wrap; }
.vt-row > * { flex: 1 1 150px; min-width: 150px; }
.vt-scroll { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
.vt-row::-webkit-scrollbar,
.vt-scroll::-webkit-scrollbar { height: 6px; }
.vt-row::-webkit-scrollbar-thumb,
.vt-scroll::-webkit-scrollbar-thumb { background: ${S.border}; border-radius: 999px; }
.vt-row,
.vt-scroll { scrollbar-width: thin; scrollbar-color: ${S.border} transparent; }
@media (max-width: 760px) {
  .vt-row {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    margin: 0 -18px;
    padding: 0 18px 8px;
  }
  .vt-row > * { flex: 0 0 58%; min-width: 152px; scroll-snap-align: start; }
}
@media (prefers-reduced-motion: reduce) {
  .vt-row { scroll-snap-type: none; }
}
`;

const CATEGORIES = [
  'regulacao', 'macroeconomia', 'seguranca', 'exchange', 'stablecoin', 'rede',
  'institucional', 'projeto', 'mercado', 'mineracao', 'pagamentos', 'outros',
] as const;
const RELEVANCES = ['relevante', 'ambigua', 'irrelevante'] as const;
const DIRECTIONS = ['positiva', 'negativa', 'incerta'] as const;

type Config = { id: string; nome: string; versao: string };
type Validation = { iniciado_em: string; status: string; operacoes_fechadas: number; resultado: unknown };
type Integrity = {
  problemas_total: number; sinais_total: number; entradas_antes_do_fechamento: number;
  saidas_antes_da_entrada: number; fechados_incompletos: number; grupos_duplicados: number;
};
type NewsRun = {
  iniciado_em: string; finalizado_em: string | null; status: string; artigos_recebidos: number;
  eventos_novos: number; eventos_repetidos: number; reacoes_processadas: number;
  falhas: number; detalhes: unknown; erro: string | null;
};
type NewsEvent = {
  id: string; provider: string; titulo: string; resumo: string | null; url: string;
  categoria: string; direcao_esperada: string; confianca_pct: number; publicado_em: string;
  dominio_fonte: string | null; novidade: string; relevancia: string; relevancia_pct: number;
  motivo_relevancia: string | null; classificador_versao: string; ativo_principal: string | null;
  elegivel_reacao: boolean; hipotese_principal_elegivel: boolean;
};
type Impact = {
  categoria: string; direcao_esperada: string; papel_analise: string; horizonte_minutos: number;
  eventos_independentes: number; linhas_reacao: number; retorno_medio_excesso_pct: number | null;
  direcao_confirmada_pct: number | null; impactos_altos: number; p_value: number | null;
  q_value_fdr: number | null; significativo_fdr: boolean;
};
type Quality = {
  eventos_total: number; eventos_relevantes: number; eventos_ambiguos: number;
  eventos_irrelevantes: number; eventos_nao_avaliados: number; eventos_com_reacao: number;
  eventos_confirmatorios: number; eventos_com_ativo_explicito: number;
  confianca_media_pct: number | null; relevancia_media_pct: number | null;
  classificador_atual: string | null;
};
type Hypothesis = {
  id: string; nome: string; versao: string; descricao: string; status: string;
  congelada_em: string; inicio_amostra_em: string; horizonte_minutos: number;
  confianca_min_pct: number; alvo_eventos: number; eventos_elegiveis: number;
  eventos_concluidos: number; eventos_pendentes: number;
  retorno_medio_excesso_pct: number | null; desvio_padrao_excesso_pct: number | null;
  direcao_confirmada_pct: number | null; situacao_amostra: string;
};
type Review = {
  event_id: string; relevancia_manual: string; categoria_manual: string;
  direcao_manual: string; ativo_principal_manual: string | null; observacoes: string | null;
};
type ValidationSummary = {
  revisoes_total: number; acuracia_relevancia_pct: number | null;
  acuracia_categoria_pct: number | null; acuracia_direcao_pct: number | null;
  relevantes_manuais: number; ambiguos_manuais: number; irrelevantes_manuais: number;
  ultima_revisao_em: string | null;
};
type ProviderStatus = { status: string; received: number; error: string | null };
type Draft = { relevance: string; category: string; direction: string; asset: string; notes: string };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function fmt(value: unknown, digits = 2) {
  const parsed = number(value);
  return parsed === null ? '—' : parsed.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtR(value: unknown) {
  const parsed = number(value);
  return parsed === null ? '—' : `${parsed > 0 ? '+' : ''}${fmt(parsed)}R`;
}
function fmtPct(value: unknown, digits = 2) {
  const parsed = number(value);
  return parsed === null ? '—' : `${fmt(parsed, digits)}%`;
}
function date(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function Card({ children }: { children: React.ReactNode }) {
  return <section className="vt-card" style={{ background: S.panel, border: `1px solid ${S.border}`, borderRadius: 12, padding: 18 }}>{children}</section>;
}
function Row({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="vt-row" style={style}>{children}</div>;
}
function Metric({ label, value, detail, color }: { label: string; value: string; detail?: string; color?: string }) {
  return <div style={{ background: S.soft, border: `1px solid ${S.border}`, borderRadius: 10, padding: 14 }}>
    <div style={{ color: S.dim, fontSize: 11 }}>{label}</div>
    <div style={{ color: color ?? S.text, fontSize: 22, fontWeight: 700, marginTop: 5 }}>{value}</div>
    {detail && <div style={{ color: S.dim, fontSize: 11, marginTop: 4 }}>{detail}</div>}
  </div>;
}
function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return <span style={{ color, border: `1px solid ${color}66`, background: `${color}16`, padding: '3px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>;
}
function statusColor(status: string) {
  if (status === 'concluido' || status === 'ok') return S.green;
  if (status === 'concluido_com_falhas' || status === 'rate_limited') return S.orange;
  if (status === 'executando' || status === 'coletando') return S.blue;
  return S.red;
}
function relevanceColor(relevance: string) {
  if (relevance === 'relevante') return S.green;
  if (relevance === 'ambigua') return S.orange;
  if (relevance === 'irrelevante') return S.red;
  return S.dim;
}
function providerLabel(provider: string) {
  const labels: Record<string, string> = {
    'gdelt-doc-2': 'GDELT', 'coindesk-rss': 'CoinDesk RSS',
    'cointelegraph-rss': 'Cointelegraph RSS', 'decrypt-rss': 'Decrypt RSS',
  };
  return labels[provider] ?? provider;
}

export default function RobustezPage() {
  const supabase = useMemo(() => getSupabase(), []);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingReview, setSavingReview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [newsRun, setNewsRun] = useState<NewsRun | null>(null);
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [impact, setImpact] = useState<Impact[]>([]);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [hypothesis, setHypothesis] = useState<Hypothesis | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const configResult = await supabase.from('forward_test_config').select('id,nome,versao').eq('ativo', true).maybeSingle();
    if (configResult.error || !configResult.data) {
      setError(configResult.error?.message ?? 'Configuração ativa não encontrada. Faça login.');
      setLoading(false);
      return;
    }
    const current = configResult.data as Config;
    setConfig(current);

    const results = await Promise.all([
      supabase.from('forward_test_validation_latest').select('*').eq('config_id', current.id).maybeSingle(),
      supabase.from('forward_test_integrity_summary').select('*').eq('config_id', current.id).maybeSingle(),
      supabase.from('market_news_runs').select('*').order('iniciado_em', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('market_news_events').select('id,provider,titulo,resumo,url,categoria,direcao_esperada,confianca_pct,publicado_em,dominio_fonte,novidade,relevancia,relevancia_pct,motivo_relevancia,classificador_versao,ativo_principal,elegivel_reacao,hipotese_principal_elegivel').order('publicado_em', { ascending: false }).limit(30),
      supabase.from('market_news_impact_summary').select('*').order('eventos_independentes', { ascending: false }).limit(100),
      supabase.from('market_news_quality_summary').select('*').maybeSingle(),
      supabase.from('market_news_primary_hypothesis_status').select('*').maybeSingle(),
      supabase.from('market_news_classifier_reviews').select('event_id,relevancia_manual,categoria_manual,direcao_manual,ativo_principal_manual,observacoes').order('revisado_em', { ascending: false }).limit(500),
      supabase.from('market_news_classifier_validation_summary').select('*').maybeSingle(),
    ]);

    const failure = results.map((result) => result.error).find(Boolean);
    if (failure) setError(failure.message);
    setValidation(results[0].data as Validation | null);
    setIntegrity(results[1].data as Integrity | null);
    setNewsRun(results[2].data as NewsRun | null);
    const nextEvents = (results[3].data as NewsEvent[] | null) ?? [];
    const nextReviews = (results[7].data as Review[] | null) ?? [];
    setEvents(nextEvents);
    setImpact((results[4].data as Impact[] | null) ?? []);
    setQuality(results[5].data as Quality | null);
    setHypothesis(results[6].data as Hypothesis | null);
    setReviews(nextReviews);
    setValidationSummary(results[8].data as ValidationSummary | null);

    const reviewed = new Map(nextReviews.map((review) => [review.event_id, review]));
    const nextDrafts: Record<string, Draft> = {};
    for (const event of nextEvents) {
      const review = reviewed.get(event.id);
      nextDrafts[event.id] = {
        relevance: review?.relevancia_manual ?? event.relevancia,
        category: review?.categoria_manual ?? event.categoria,
        direction: review?.direcao_manual ?? event.direcao_esperada,
        asset: review?.ativo_principal_manual ?? event.ativo_principal ?? '',
        notes: review?.observacoes ?? '',
      };
    }
    setDrafts(nextDrafts);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  const saveReview = async (event: NewsEvent) => {
    if (!session) {
      setError('Faça login para registrar uma revisão manual.');
      return;
    }
    const draft = drafts[event.id];
    if (!draft) return;
    setSavingReview(event.id);
    const result = await supabase.from('market_news_classifier_reviews').upsert({
      event_id: event.id,
      relevancia_manual: draft.relevance,
      categoria_manual: draft.category,
      direcao_manual: draft.direction,
      ativo_principal_manual: draft.asset.trim() || null,
      observacoes: draft.notes.trim() || null,
      classificador_versao: event.classificador_versao,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'event_id' });
    setSavingReview(null);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    await load();
  };

  const result = object(validation?.resultado);
  const base = object(result.base);
  const stress = object(result.stress);
  const costs2x = object(stress.costs2x);
  const robustness = object(result.robustness);
  const monteCarlo = object(result.monteCarlo);
  const drawdown = object(monteCarlo.drawdownR);
  const readiness = object(result.readiness);
  const ready = readiness.readyForRealMoney === true;
  const runDetails = object(newsRun?.detalhes);
  const providers = object(runDetails.providers);
  const providerEntries = Object.entries(providers).map(([name, value]) => [name, object(value) as ProviderStatus] as const);
  const exploratory = impact.filter((row) => row.papel_analise === 'exploratoria');
  const reviewedIds = new Set(reviews.map((review) => review.event_id));
  const reviewQueue = events.filter((event) => event.classificador_versao !== 'legacy-v1').slice(0, 10);
  const progress = hypothesis ? Math.min(100, (Number(hypothesis.eventos_concluidos) / Number(hypothesis.alvo_eventos)) * 100) : 0;

  return <main className="vt-page" style={{ minHeight: '100vh', background: S.bg, color: S.text, fontFamily: 'ui-sans-serif,system-ui,sans-serif' }}>
    <style dangerouslySetInnerHTML={{ __html: CSS }} />

    <CabecalhoVigIA
        titulo="Robustez"
        subtitulo="integridade · classificação"
        ativo="/robustez"
        supabase={supabase}
      />

    <div style={{ maxWidth: 1220, margin: '0 auto', padding: '24px 16px 60px', display: 'grid', gap: 18 }}>
      {loading && <Card>Carregando…</Card>}
      {error && <Card><span style={{ color: S.orange }}>{error}</span></Card>}

      {!loading && config && <>
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}><strong>{config.nome} v{config.versao}</strong><div style={{ color: S.dim, fontSize: 12, marginTop: 4 }}>Última validação: {date(validation?.iniciado_em)}</div></div>
            <button onClick={() => void load()} style={{ background: S.blue, border: 0, color: 'white', padding: '8px 14px', borderRadius: 8, cursor: 'pointer' }}>Atualizar</button>
          </div>
        </Card>

        <Card>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Prontidão estatística da estratégia</h2>
          <Row>
            <Metric label="Operações encerradas" value={fmt(validation?.operacoes_fechadas, 0)} />
            <Metric label="Resultado acumulado" value={fmtR(base.sum)} color={(number(base.sum) ?? 0) >= 0 ? S.green : S.red} />
            <Metric label="Resultado com custos 2x" value={fmtR(costs2x.sum)} />
            <Metric label="Sem as 3 melhores" value={fmtR(robustness.withoutBestThreeTradesR)} />
            <Metric label="Prob. terminar negativo" value={fmtPct(monteCarlo.probabilityNegativePct)} />
            <Metric label="Drawdown P95" value={fmtR(drawdown.p95)} />
          </Row>
          <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: ready ? 'rgba(63,178,111,.10)' : 'rgba(232,161,60,.08)', color: ready ? S.green : S.orange }}>
            {ready ? 'Critérios mínimos atendidos; a decisão real continua exigindo revisão humana.' : 'Ainda não aprovado para dinheiro real.'}
          </div>
        </Card>

        <Card>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Integridade operacional</h2>
          <Row>
            <Metric label="Problemas encontrados" value={fmt(integrity?.problemas_total, 0)} color={(integrity?.problemas_total ?? 0) === 0 ? S.green : S.red} />
            <Metric label="Sinais auditados" value={fmt(integrity?.sinais_total, 0)} />
            <Metric label="Entradas antecipadas" value={fmt(integrity?.entradas_antes_do_fechamento, 0)} />
            <Metric label="Fechamentos incompletos" value={fmt(integrity?.fechados_incompletos, 0)} />
            <Metric label="Grupos duplicados" value={fmt(integrity?.grupos_duplicados, 0)} />
          </Row>
        </Card>

        <Card>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Qualidade da coleta e classificação</h2>
          <Row>
            <Metric label="Eventos armazenados" value={fmt(quality?.eventos_total, 0)} />
            <Metric label="Relevantes" value={fmt(quality?.eventos_relevantes, 0)} color={S.green} />
            <Metric label="Ambíguos" value={fmt(quality?.eventos_ambiguos, 0)} color={S.orange} />
            <Metric label="Irrelevantes" value={fmt(quality?.eventos_irrelevantes, 0)} color={S.red} />
            <Metric label="Geraram reações" value={fmt(quality?.eventos_com_reacao, 0)} detail="eventos, não linhas" />
            <Metric label="Ativo explícito" value={fmt(quality?.eventos_com_ativo_explicito, 0)} />
            <Metric label="Classificador" value={quality?.classificador_atual ?? '—'} />
          </Row>
          <p style={{ color: S.dim, fontSize: 12, lineHeight: 1.6, marginBottom: 0 }}>
            Notícias irrelevantes e ambíguas continuam armazenadas para auditoria, mas não geram novas reações. Eventos gerais relevantes usam somente BTC como série de mercado.
          </p>
        </Card>

        {hypothesis && <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>Hipótese principal congelada</h2>
              <div style={{ color: S.dim, fontSize: 11, marginTop: 5 }}>{hypothesis.versao} · congelada em {date(hypothesis.congelada_em)}</div>
            </div>
            <Badge color={S.purple}>CONFIRMATÓRIA</Badge>
          </div>
          <p style={{ color: S.text, fontSize: 13, lineHeight: 1.6 }}>{hypothesis.descricao}</p>
          <Row>
            <Metric label="Eventos independentes" value={`${fmt(hypothesis.eventos_concluidos, 0)} / ${fmt(hypothesis.alvo_eventos, 0)}`} detail="uma observação por evento" />
            <Metric label="Elegíveis" value={fmt(hypothesis.eventos_elegiveis, 0)} />
            <Metric label="Pendentes" value={fmt(hypothesis.eventos_pendentes, 0)} />
            <Metric label="Excesso médio" value={fmtPct(hypothesis.retorno_medio_excesso_pct)} />
            <Metric label="Direção confirmada" value={fmtPct(hypothesis.direcao_confirmada_pct)} />
            <Metric label="Horizonte fixo" value={`${fmt(hypothesis.horizonte_minutos, 0)} min`} />
          </Row>
          <div style={{ height: 8, background: S.soft, borderRadius: 999, overflow: 'hidden', marginTop: 14 }}>
            <div style={{ height: '100%', width: `${progress}%`, background: S.purple }} />
          </div>
          <div style={{ color: S.dim, fontSize: 11, marginTop: 7 }}>
            {hypothesis.situacao_amostra === 'coletando' ? 'Coletando dados futuros. Nenhuma conclusão deve ser emitida antes da amostra-alvo.' : 'A amostra-alvo foi atingida e está pronta para análise formal.'}
          </div>
        </Card>}

        <Card>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Última execução do coletor</h2>
          <Row>
            <Metric label="Última coleta" value={date(newsRun?.iniciado_em)} detail={newsRun?.status ?? 'ainda não executada'} color={newsRun ? statusColor(newsRun.status) : S.dim} />
            <Metric label="Artigos recebidos" value={fmt(newsRun?.artigos_recebidos, 0)} />
            <Metric label="Eventos novos" value={fmt(newsRun?.eventos_novos, 0)} />
            <Metric label="Eventos repetidos" value={fmt(newsRun?.eventos_repetidos, 0)} />
            <Metric label="Reações processadas" value={fmt(newsRun?.reacoes_processadas, 0)} />
            <Metric label="Falhas" value={fmt(newsRun?.falhas, 0)} color={(newsRun?.falhas ?? 0) > 0 ? S.orange : S.green} />
          </Row>
          {providerEntries.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10, marginTop: 14 }}>
            {providerEntries.map(([name, provider]) => <div key={name} style={{ background: S.soft, border: `1px solid ${S.border}`, borderRadius: 9, padding: 12, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 12 }}>{providerLabel(name)}</strong><span style={{ color: statusColor(String(provider.status)), fontSize: 11, fontWeight: 700 }}>{String(provider.status)}</span></div>
              <div style={{ color: S.dim, fontSize: 11, marginTop: 6 }}>{fmt(provider.received, 0)} artigos</div>
              {provider.error && <div style={{ color: S.orange, fontSize: 10, marginTop: 6, wordBreak: 'break-word' }}>{provider.error}</div>}
            </div>)}
          </div>}
        </Card>

        {exploratory.length > 0 && <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}><h2 style={{ fontSize: 15, margin: 0 }}>Cruzamentos exploratórios</h2><div style={{ color: S.dim, fontSize: 11, marginTop: 5 }}>Primeiro agrupados por evento; FDR Benjamini–Hochberg aplicado entre células testáveis.</div></div>
            <Badge color={S.orange}>NÃO CONFIRMATÓRIO</Badge>
          </div>
          <div className="vt-scroll" style={{ marginTop: 12 }}>
            <table style={{ width: '100%', minWidth: 980, borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr>{['Categoria','Direção','Horizonte','Eventos independentes','Linhas','Excesso médio','Confirmação','p','q-FDR','Leitura'].map((label) => <th key={label} style={{ textAlign: 'left', color: S.dim, padding: 8, borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>{label}</th>)}</tr></thead>
              <tbody>{exploratory.map((row, index) => <tr key={`${row.categoria}-${row.direcao_esperada}-${row.horizonte_minutos}-${index}`}>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{row.categoria}</td><td style={{ padding: 8, whiteSpace: 'nowrap' }}>{row.direcao_esperada}</td><td style={{ padding: 8, whiteSpace: 'nowrap' }}>{row.horizonte_minutos} min</td>
                <td style={{ padding: 8, fontWeight: 700, whiteSpace: 'nowrap' }}>{row.eventos_independentes}</td><td style={{ padding: 8, color: S.dim, whiteSpace: 'nowrap' }}>{row.linhas_reacao}</td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{fmtPct(row.retorno_medio_excesso_pct)}</td><td style={{ padding: 8, whiteSpace: 'nowrap' }}>{fmtPct(row.direcao_confirmada_pct)}</td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{row.p_value === null ? '—' : fmt(row.p_value, 4)}</td><td style={{ padding: 8, whiteSpace: 'nowrap' }}>{row.q_value_fdr === null ? '—' : fmt(row.q_value_fdr, 4)}</td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}><Badge color={row.significativo_fdr ? S.purple : S.dim}>{row.significativo_fdr ? 'SINAL EXPLORATÓRIO' : row.eventos_independentes < 5 ? 'AMOSTRA INSUFICIENTE' : 'SEM SINAL'}</Badge></td>
              </tr>)}</tbody>
            </table>
          </div>
        </Card>}

        <Card>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Validação manual do classificador</h2>
          <Row style={{ marginBottom: 14 }}>
            <Metric label="Revisões" value={fmt(validationSummary?.revisoes_total, 0)} />
            <Metric label="Acurácia de relevância" value={fmtPct(validationSummary?.acuracia_relevancia_pct)} />
            <Metric label="Acurácia de categoria" value={fmtPct(validationSummary?.acuracia_categoria_pct)} />
            <Metric label="Acurácia de direção" value={fmtPct(validationSummary?.acuracia_direcao_pct)} />
          </Row>
          <p style={{ color: S.dim, fontSize: 12, lineHeight: 1.6 }}>Revise uma amostra contínua. As correções ficam registradas para medir precisão e orientar uma futura versão do classificador; elas não reescrevem silenciosamente a hipótese congelada.</p>
          {!session && <div style={{ color: S.orange, fontSize: 12 }}>Entre na conta para salvar revisões.</div>}
          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            {reviewQueue.map((event) => {
              const draft = drafts[event.id];
              if (!draft) return null;
              return <article key={event.id} style={{ background: S.soft, border: `1px solid ${reviewedIds.has(event.id) ? S.green : S.border}`, borderRadius: 9, padding: 12, minWidth: 0 }}>
                <a href={event.url} target="_blank" rel="noreferrer" style={{ color: S.text, fontSize: 12, fontWeight: 650, textDecoration: 'none' }}>{event.titulo}</a>
                <div style={{ color: S.dim, fontSize: 10, marginTop: 5 }}>Previsto: {event.relevancia} · {event.categoria} · {event.direcao_esperada} · {event.ativo_principal ?? 'sem ativo'} · {fmtPct(event.relevancia_pct)}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(135px,1fr))', gap: 8, marginTop: 10 }}>
                  <select value={draft.relevance} onChange={(e) => setDrafts((old) => ({ ...old, [event.id]: { ...draft, relevance: e.target.value } }))} style={{ background: S.panel, color: S.text, border: `1px solid ${S.border}`, borderRadius: 7, padding: 7, minWidth: 0, maxWidth: '100%' }}>
                    {RELEVANCES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <select value={draft.category} onChange={(e) => setDrafts((old) => ({ ...old, [event.id]: { ...draft, category: e.target.value } }))} style={{ background: S.panel, color: S.text, border: `1px solid ${S.border}`, borderRadius: 7, padding: 7, minWidth: 0, maxWidth: '100%' }}>
                    {CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <select value={draft.direction} onChange={(e) => setDrafts((old) => ({ ...old, [event.id]: { ...draft, direction: e.target.value } }))} style={{ background: S.panel, color: S.text, border: `1px solid ${S.border}`, borderRadius: 7, padding: 7, minWidth: 0, maxWidth: '100%' }}>
                    {DIRECTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  <input value={draft.asset} onChange={(e) => setDrafts((old) => ({ ...old, [event.id]: { ...draft, asset: e.target.value.toUpperCase() } }))} placeholder="Ativo principal" style={{ background: S.panel, color: S.text, border: `1px solid ${S.border}`, borderRadius: 7, padding: 7, minWidth: 0, maxWidth: '100%' }} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <input value={draft.notes} onChange={(e) => setDrafts((old) => ({ ...old, [event.id]: { ...draft, notes: e.target.value } }))} placeholder="Observação opcional" style={{ flex: '1 1 160px', minWidth: 0, background: S.panel, color: S.text, border: `1px solid ${S.border}`, borderRadius: 7, padding: 7 }} />
                  <button disabled={!session || savingReview === event.id} onClick={() => void saveReview(event)} style={{ background: S.blue, color: 'white', border: 0, borderRadius: 7, padding: '7px 12px', cursor: session ? 'pointer' : 'not-allowed', opacity: session ? 1 : 0.5, whiteSpace: 'nowrap' }}>{savingReview === event.id ? 'Salvando…' : reviewedIds.has(event.id) ? 'Atualizar' : 'Revisar'}</button>
                </div>
              </article>;
            })}
          </div>
        </Card>

        <Card>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>Notícias recentes</h2>
          {events.length === 0 ? <div style={{ color: S.dim }}>A coleta ainda não registrou eventos.</div> : <div style={{ display: 'grid', gap: 10 }}>
            {events.map((event) => <article key={event.id} style={{ background: S.soft, border: `1px solid ${S.border}`, borderRadius: 9, padding: 12, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <a href={event.url} target="_blank" rel="noreferrer" style={{ color: S.text, fontSize: 13, fontWeight: 600, textDecoration: 'none', flex: '1 1 200px', minWidth: 0 }}>{event.titulo}</a>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><Badge color={relevanceColor(event.relevancia)}>{event.relevancia.toUpperCase()}</Badge>{event.hipotese_principal_elegivel && <Badge color={S.purple}>HIPÓTESE PRINCIPAL</Badge>}{event.elegivel_reacao ? <Badge color={S.blue}>COM REAÇÃO</Badge> : <Badge color={S.dim}>SEM REAÇÃO</Badge>}</div>
              </div>
              <div style={{ color: S.dim, fontSize: 11, marginTop: 7 }}>{providerLabel(event.provider)} · {event.categoria} · {event.direcao_esperada} · confiança {fmtPct(event.confianca_pct)} · relevância {fmtPct(event.relevancia_pct)} · {event.ativo_principal ?? 'sem ativo explícito'} · {event.dominio_fonte ?? 'fonte não identificada'} · {date(event.publicado_em)}</div>
              {event.motivo_relevancia && <div style={{ color: S.dim, fontSize: 10, marginTop: 5 }}>{event.motivo_relevancia}</div>}
            </article>)}
          </div>}
        </Card>
      </>}
    </div>
  </main>;
}
