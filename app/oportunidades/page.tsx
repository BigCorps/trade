'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
.vt-row > * { flex: 1 1 145px; min-width: 145px; }
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

type Config = {
  id: string;
  nome: string;
  versao: string;
  grupo_experimento: string;
  timeframes: string[];
  estrategias: string[];
  simbolos: string[];
  amostra_alvo: number;
  protocolo_status: string;
  congelado_em: string;
  observacoes: string | null;
};

type Dashboard = {
  config_id: string;
  nome: string;
  versao: string;
  grupo_experimento: string;
  amostra_alvo: number;
  protocolo_status: string;
  congelado_em: string;
  operacoes: number;
  abertas: number;
  resultado_r_liquido: number;
  media_r_operacao: number | null;
  acerto_pct: number | null;
  profit_factor: number | null;
  progresso_pct: number;
  situacao_amostra: string;
};

type Validation = {
  config_id: string;
  status: string;
  iniciado_em: string;
  operacoes_fechadas: number;
  resultado: Record<string, unknown>;
};

type Funding = {
  simbolo: string;
  coletado_em: string;
  funding_rate_pct: number;
  funding_anualizado_pct: number;
  basis_pct: number;
  custo_round_trip_pct: number;
  carry_liquido_anualizado_pct: number;
  elegivel: boolean;
  motivo: string;
};

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function fmt(value: unknown, digits = 2) {
  const number = numeric(value);
  return number !== null
    ? number.toLocaleString('pt-BR', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : '—';
}
function fmtR(value: unknown) {
  const number = numeric(value);
  return number !== null
    ? `${number > 0 ? '+' : ''}${fmt(number)}R`
    : '—';
}
function fmtPct(value: unknown, digits = 2) {
  const number = numeric(value);
  return number !== null ? `${fmt(number, digits)}%` : '—';
}
function date(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function colorForResult(value: unknown) {
  const number = numeric(value);
  return number === null ? S.dim : number > 0 ? S.green : number < 0 ? S.red : S.dim;
}
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="vt-card"
      style={{
        background: S.panel,
        border: `1px solid ${S.border}`,
        borderRadius: 12,
        padding: 18,
      }}
    >
      {children}
    </section>
  );
}
function Row({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="vt-row" style={style}>
      {children}
    </div>
  );
}
function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span
      style={{
        color,
        border: `1px solid ${color}66`,
        background: `${color}18`,
        borderRadius: 999,
        padding: '3px 8px',
        fontSize: 10,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
function Metric({
  label,
  value,
  detail,
  color,
}: {
  label: string;
  value: string;
  detail?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: S.soft,
        border: `1px solid ${S.border}`,
        borderRadius: 10,
        padding: 13,
      }}
    >
      <div style={{ color: S.dim, fontSize: 11 }}>{label}</div>
      <div style={{ color: color ?? S.text, fontSize: 21, fontWeight: 750, marginTop: 5 }}>
        {value}
      </div>
      {detail ? <div style={{ color: S.dim, fontSize: 11, marginTop: 4 }}>{detail}</div> : null}
    </div>
  );
}

export default function OportunidadesV2Page() {
  const supabase = useMemo(() => getSupabase(), []);
  const [configs, setConfigs] = useState<Config[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard[]>([]);
  const [validations, setValidations] = useState<Validation[]>([]);
  const [funding, setFunding] = useState<Funding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const results = await Promise.all([
      supabase
        .from('forward_test_config')
        .select(
          'id,nome,versao,grupo_experimento,timeframes,estrategias,simbolos,amostra_alvo,protocolo_status,congelado_em,observacoes',
        )
        .like('versao', '2.0.0-%')
        .order('congelado_em', { ascending: true }),
      supabase
        .from('forward_test_v2_dashboard')
        .select('*')
        .order('congelado_em', { ascending: true }),
      supabase
        .from('forward_test_validation_latest')
        .select('config_id,status,iniciado_em,operacoes_fechadas,resultado'),
      supabase
        .from('funding_carry_latest')
        .select('*')
        .order('carry_liquido_anualizado_pct', { ascending: false }),
    ]);
    const failure = results.map((result) => result.error).find(Boolean);
    if (failure) setError(failure.message);
    setConfigs((results[0].data as Config[] | null) ?? []);
    setDashboard((results[1].data as Dashboard[] | null) ?? []);
    setValidations((results[2].data as Validation[] | null) ?? []);
    setFunding((results[3].data as Funding[] | null) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const validationByConfig = new Map(
    validations.map((validation) => [validation.config_id, validation]),
  );
  const dashboardByConfig = new Map(
    dashboard.map((row) => [row.config_id, row]),
  );

  return (
    <main
      className="vt-page"
      style={{
        minHeight: '100vh',
        background: S.bg,
        color: S.text,
        fontFamily: 'ui-sans-serif,system-ui,sans-serif',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <CabecalhoVigIA
        titulo="Teste prospectivo"
        subtitulo="sinais · funding · validação"
        ativo="/oportunidades"
        supabase={supabase}
      />

      <div
        style={{
          maxWidth: 1220,
          margin: '0 auto',
          padding: '24px 16px 60px',
          display: 'grid',
          gap: 18,
        }}
      >
        {loading ? <Card>Carregando protocolos…</Card> : null}
        {error ? (
          <Card>
            <div style={{ color: S.red, fontWeight: 700 }}>Não foi possível carregar tudo</div>
            <div style={{ color: S.dim, fontSize: 12, marginTop: 6 }}>{error}</div>
          </Card>
        ) : null}

        {!loading ? (
          <Card>
            <div style={{ fontSize: 17, fontWeight: 750 }}>Regras desta rodada</div>
            <div style={{ color: S.dim, fontSize: 13, marginTop: 7, lineHeight: 1.55 }}>
              Nenhuma estratégia está liberada para Testnet ou conta real. As três amostras usam
              tamanho fixo de 1R, custos incluídos e histórico separado. A seleção de ativos é
              comparada contra uma cesta ampla para evitar confundir escolha retrospectiva com vantagem.
            </div>
          </Card>
        ) : null}

        {configs.map((config) => {
          const summary = dashboardByConfig.get(config.id);
          const validation = validationByConfig.get(config.id);
          const report = object(validation?.resultado);
          const readiness = object(report.readiness);
          const monteCarlo = object(report.monteCarlo);
          const robustness = object(report.robustness);
          const stress = object(report.stress);
          const costs2x = object(stress.costs2x);
          const ready = readiness.readyForRealMoney === true;

          return (
            <Card key={config.id}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 17 }}>{config.nome}</strong>
                    <Badge color={S.purple}>{config.versao}</Badge>
                    <Badge color={ready ? S.green : S.orange}>{ready ? 'APROVADA' : 'SHADOW'}</Badge>
                  </div>
                  <div style={{ color: S.dim, fontSize: 12, marginTop: 7 }}>
                    {config.estrategias.join(', ')} · {config.timeframes.join(' / ')} ·{' '}
                    {config.simbolos.length} ativos · congelada em {date(config.congelado_em)}
                  </div>
                </div>
                <Badge color={S.blue}>{config.grupo_experimento}</Badge>
              </div>

              <Row style={{ marginTop: 15 }}>
                <Metric
                  label="Operações"
                  value={String(summary?.operacoes ?? 0)}
                  detail={`alvo ${config.amostra_alvo}`}
                />
                <Metric
                  label="Progresso"
                  value={fmtPct(summary?.progresso_pct ?? 0)}
                  detail={summary?.situacao_amostra ?? 'insuficiente'}
                  color={S.blue}
                />
                <Metric
                  label="Resultado"
                  value={fmtR(summary?.resultado_r_liquido)}
                  color={colorForResult(summary?.resultado_r_liquido)}
                />
                <Metric
                  label="Média"
                  value={fmtR(summary?.media_r_operacao)}
                  color={colorForResult(summary?.media_r_operacao)}
                />
                <Metric
                  label="Profit factor"
                  value={fmt(summary?.profit_factor)}
                  color={(summary?.profit_factor ?? 0) > 1 ? S.green : S.orange}
                />
                <Metric
                  label="Acerto"
                  value={fmtPct(summary?.acerto_pct)}
                />
              </Row>

              {validation ? (
                <div style={{ marginTop: 15 }}>
                  <div style={{ color: S.dim, fontSize: 11, marginBottom: 8 }}>
                    Validação mais recente: {date(validation.iniciado_em)} · {validation.status}
                  </div>
                  <Row>
                    <Metric
                      label="Custos 2×"
                      value={fmtR(costs2x.sum)}
                      color={colorForResult(costs2x.sum)}
                    />
                    <Metric
                      label="Sem 3 melhores"
                      value={fmtR(robustness.withoutBestThreeTradesR)}
                      color={colorForResult(robustness.withoutBestThreeTradesR)}
                    />
                    <Metric
                      label="Monte Carlo negativo"
                      value={fmtPct(monteCarlo.probabilityNegativePct)}
                      color={
                        Number(monteCarlo.probabilityNegativePct) <= 20 ? S.green : S.red
                      }
                    />
                    <Metric
                      label="Decisão"
                      value={ready ? 'APTA' : 'NÃO APTA'}
                      color={ready ? S.green : S.red}
                    />
                  </Row>
                </div>
              ) : (
                <div style={{ color: S.dim, fontSize: 12, marginTop: 14 }}>
                  Ainda sem validação: o relatório será criado pelo cron após existirem operações fechadas.
                </div>
              )}

              {config.observacoes ? (
                <div
                  style={{
                    color: S.dim,
                    fontSize: 12,
                    lineHeight: 1.5,
                    marginTop: 14,
                    borderTop: `1px solid ${S.border}`,
                    paddingTop: 12,
                  }}
                >
                  {config.observacoes}
                </div>
              ) : null}
            </Card>
          );
        })}

        {!loading && configs.length === 0 ? (
          <Card>
            <div style={{ color: S.orange, fontWeight: 700 }}>Protocolos v2 ainda não encontrados</div>
            <div style={{ color: S.dim, fontSize: 12, marginTop: 6 }}>
              Aplique a migração do pacote depois de publicar o motor de estratégias.
            </div>
          </Card>
        ) : null}

        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 750 }}>Funding carry delta-neutro</div>
              <div style={{ color: S.dim, fontSize: 12, marginTop: 5 }}>
                Long spot + short perp, apenas observacional. Custos e basis entram na triagem.
              </div>
            </div>
            <Badge color={S.orange}>SEM ORDENS</Badge>
          </div>

          <div className="vt-scroll" style={{ marginTop: 14 }}>
            <table style={{ width: '100%', minWidth: 780, borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: S.dim, textAlign: 'left' }}>
                  {['Ativo', 'Funding 8h', 'Anualizado', 'Basis', 'Carry líquido est.', 'Situação', 'Coleta'].map(
                    (title) => (
                      <th
                        key={title}
                        style={{
                          padding: '8px 10px',
                          borderBottom: `1px solid ${S.border}`,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {title}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {funding.map((row) => (
                  <tr key={row.simbolo}>
                    <td style={{ padding: '9px 10px', borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>
                      <strong>{row.simbolo}</strong>
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>
                      {fmtPct(row.funding_rate_pct, 4)}
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>
                      {fmtPct(row.funding_anualizado_pct)}
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>
                      {fmtPct(row.basis_pct, 3)}
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        borderBottom: `1px solid ${S.border}`,
                        color: colorForResult(row.carry_liquido_anualizado_pct),
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {fmtPct(row.carry_liquido_anualizado_pct)}
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>
                      <Badge color={row.elegivel ? S.green : S.dim}>
                        {row.elegivel ? 'ELEGÍVEL' : 'OBSERVAR'}
                      </Badge>
                    </td>
                    <td style={{ padding: '9px 10px', borderBottom: `1px solid ${S.border}`, whiteSpace: 'nowrap' }}>
                      {date(row.coletado_em)}
                    </td>
                  </tr>
                ))}
                {funding.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ color: S.dim, padding: 14 }}>
                      O coletor ainda não registrou snapshots.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </main>
  );
}
