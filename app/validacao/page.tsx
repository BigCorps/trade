'use client';

/**
 * app/validacao/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Detalhe estatístico. É a tela para conferir os números por trás do painel.
 *
 * Usa o cabeçalho compartilhado e a paleta `S` das demais telas.
 *
 * Diferença deliberada em relação a um painel de trading comum: aqui não
 * existe ranking de lucro. A tabela é ordenada do PIOR para o melhor, porque
 * o topo de uma tabela ordenada por ganho é justamente onde o viés de seleção
 * se esconde — o olho vai ao topo, e o topo é onde o acaso se acumula.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createClient } from '@supabase/supabase-js';

import CabecalhoVigIA, { S } from '../../components/CabecalhoVigIA';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

const supabase =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface LinhaEvidencia {
  estrategia: string;
  timeframe: string;
  operacoes: number;
  soma_r: number | null;
  media_r: number | null;
  desvio_r: number | null;
  acerto_pct: number | null;
  acerto_equilibrio_pct: number | null;
  derrapagem_stop_r: number | null;
  mfe_perdedoras_r: number | null;
  diagnostico_entrada: string | null;
  t_observado: number | null;
  combinacoes_no_experimento: number | null;
  piso_ruido: number | null;
  p_corrigido: number | null;
  veredito: string;
}

interface Hipotese {
  id: string;
  nome: string;
  pergunta: string;
  amostra_minima: number;
  t_minimo_exigido: number | null;
  criterio_morte: string;
  status: string;
  combinacoes_testadas: number;
}

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  background: S.panel,
  border: `1px solid ${S.border}`,
  borderRadius: 10,
  padding: 16,
};

const rotuloStyle: CSSProperties = {
  fontSize: 11,
  color: S.dim,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

const fraseStyle: CSSProperties = {
  fontSize: 12,
  color: S.dim,
  lineHeight: 1.5,
};

const mono = 'ui-monospace, "SF Mono", Menlo, monospace';

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...cardStyle, ...style }}>{children}</div>;
}

const num = (v: number | null | undefined, casas = 2) =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      });

function corDoVeredito(veredito: string): string {
  if (veredito.includes('negativo')) return S.red;
  if (veredito.includes('sobrevive')) return S.green;
  if (veredito.includes('insuficiente')) return S.dim;
  return S.a;
}

const rotuloCurto: Record<string, string> = {
  'amostra insuficiente': 'Amostra insuficiente',
  'edge negativo significativo — encerrar': 'Perda consistente',
  'indistinguível de ruído': 'Ruído',
  'evidência sobrevive à correção': 'Evidência válida',
  'promissor, sem confirmação': 'Sem confirmação',
};

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function Validacao() {
  const [evidencia, setEvidencia] = useState<LinhaEvidencia[]>([]);
  const [hipoteses, setHipoteses] = useState<Hipotese[]>([]);
  // Estado inicial derivado no render: chamar setState dentro do efeito
  // provoca renderização em cascata.
  const [carregando, setCarregando] = useState(Boolean(supabase));
  const [erro, setErro] = useState<string | null>(
    supabase ? null : 'Variáveis NEXT_PUBLIC_SUPABASE_* não configuradas.',
  );

  useEffect(() => {
    if (!supabase) return;

    let vivo = true;

    void (async () => {
      const [ev, hip] = await Promise.all([
        supabase.from('vw_forward_test_evidencia').select('*'),
        supabase
          .from('hipoteses_pesquisa')
          .select(
            'id, nome, pergunta, amostra_minima, t_minimo_exigido, criterio_morte, status, combinacoes_testadas',
          )
          .order('registrada_em', { ascending: false }),
      ]);

      if (!vivo) return;

      if (ev.error) setErro(ev.error.message);

      setEvidencia((ev.data ?? []) as LinhaEvidencia[]);
      setHipoteses((hip.data ?? []) as Hipotese[]);
      setCarregando(false);
    })();

    return () => {
      vivo = false;
    };
  }, []);

  const piso = evidencia[0]?.piso_ruido ?? null;
  const combinacoes = evidencia[0]?.combinacoes_no_experimento ?? null;

  const totalOperacoes = useMemo(
    () => evidencia.reduce((s, r) => s + (r.operacoes ?? 0), 0),
    [evidencia],
  );

  const somaTotal = useMemo(
    () => evidencia.reduce((s, r) => s + Number(r.soma_r ?? 0), 0),
    [evidencia],
  );

  const aprovadas = evidencia.filter((r) => r.veredito.includes('sobrevive'));

  const escala = Math.max(
    4,
    ...evidencia.map((r) => Math.abs(Number(r.t_observado ?? 0)) + 0.5),
    Number(piso ?? 0) + 0.5,
  );

  return (
    <main
      style={{
        minHeight: '100vh',
        background: S.bg,
        color: S.text,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <CabecalhoVigIA
        titulo="Estatística"
        subtitulo="evidência · correção · hipóteses"
        ativo="/validacao"
        supabase={supabase ?? undefined}
      />

      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          padding: '24px 20px 60px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {erro && (
          <Card style={{ borderLeft: `2px solid ${S.a}` }}>
            <div style={{ fontSize: 13, color: S.dim }}>{erro}</div>
          </Card>
        )}

        {carregando && (
          <Card style={{ textAlign: 'center', color: S.dim, fontSize: 14 }}>
            Carregando evidência…
          </Card>
        )}

        {!carregando && (
          <>
            {/* ===================================== resumo */}
            <section>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>
                O resultado é real ou foi o acaso?
              </h2>
              <p style={{ ...fraseStyle, fontSize: 13, margin: '0 0 16px' }}>
                Toda combinação testada aparece aqui, inclusive as ruins. Ocultar
                as que falharam é o que faz uma estratégia parecer melhor do que
                é.
              </p>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                  gap: 1,
                  background: S.border,
                  border: `1px solid ${S.border}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {[
                  { r: 'Operações', v: String(totalOperacoes), c: S.text },
                  {
                    r: 'Acumulado',
                    v: `${somaTotal >= 0 ? '+' : ''}${num(somaTotal)} R`,
                    c: somaTotal < 0 ? S.red : S.green,
                  },
                  {
                    r: 'Aprovadas',
                    v: `${aprovadas.length} de ${evidencia.length}`,
                    c: aprovadas.length === 0 ? S.dim : S.green,
                  },
                  {
                    r: 'Nível a superar',
                    v: `t = ${num(piso)}`,
                    c: S.a,
                  },
                ].map((item) => (
                  <div key={item.r} style={{ background: S.bg, padding: '12px 14px' }}>
                    <div style={rotuloStyle}>{item.r}</div>
                    <div
                      style={{
                        fontFamily: mono,
                        fontSize: 20,
                        fontWeight: 300,
                        marginTop: 6,
                        color: item.c,
                      }}
                    >
                      {item.v}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* ===================================== gráfico */}
            <section>
              <h3 style={{ ...rotuloStyle, margin: '0 0 6px' }}>
                Cada estratégia contra a linha de ruído
              </h3>
              <p style={{ ...fraseStyle, margin: '0 0 14px' }}>
                A linha pontilhada marca o resultado que o acaso produziria como
                melhor entre {combinacoes ?? '—'} combinações. Quem não a cruza
                não tem evidência, independentemente do R acumulado.
              </p>

              <Card style={{ padding: '18px 14px' }}>
                {evidencia.length === 0 && (
                  <div style={{ ...fraseStyle, textAlign: 'center' }}>
                    Nenhuma operação encerrada ainda.
                  </div>
                )}

                {evidencia.map((linha) => {
                  const t = Number(linha.t_observado ?? 0);
                  const largura = (Math.abs(t) / escala) * 50;
                  const cor = corDoVeredito(linha.veredito);

                  return (
                    <div
                      key={`${linha.estrategia}-${linha.timeframe}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '96px 1fr 62px',
                        alignItems: 'center',
                        gap: 10,
                        padding: '7px 0',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 11,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {linha.estrategia}
                        </div>
                        <div style={{ fontSize: 10, color: S.dim, fontFamily: mono }}>
                          {linha.timeframe}
                        </div>
                      </div>

                      <div
                        style={{
                          position: 'relative',
                          height: 20,
                          background: 'rgba(255,255,255,0.02)',
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            left: '50%',
                            top: 0,
                            bottom: 0,
                            width: 1,
                            background: S.border,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: `${50 + (Number(piso ?? 0) / escala) * 50}%`,
                            top: -2,
                            bottom: -2,
                            width: 1,
                            background: `repeating-linear-gradient(to bottom, ${S.dim} 0 3px, transparent 3px 6px)`,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            left: `${50 - (Number(piso ?? 0) / escala) * 50}%`,
                            top: -2,
                            bottom: -2,
                            width: 1,
                            background: `repeating-linear-gradient(to bottom, ${S.dim} 0 3px, transparent 3px 6px)`,
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            top: 5,
                            bottom: 5,
                            minWidth: 2,
                            background: cor,
                            width: `${largura}%`,
                            ...(t >= 0 ? { left: '50%' } : { right: '50%' }),
                          }}
                        />
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: mono, fontSize: 12 }}>
                          {t >= 0 ? '+' : ''}
                          {num(t)}
                        </div>
                        <div style={{ fontSize: 10, color: S.dim }}>
                          n={linha.operacoes}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </Card>
            </section>

            {/* ===================================== tabela */}
            {evidencia.length > 0 && (
              <section>
                <h3 style={{ ...rotuloStyle, margin: '0 0 10px' }}>
                  Todas as combinações
                </h3>

                <div
                  style={{
                    overflowX: 'auto',
                    border: `1px solid ${S.border}`,
                    borderRadius: 8,
                  }}
                >
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: 12,
                    }}
                  >
                    <thead>
                      <tr>
                        {[
                          'Estratégia',
                          'TF',
                          'n',
                          'Soma R',
                          'Acerto',
                          'Empate',
                          'MFE perd.',
                          'Veredito',
                        ].map((h, i) => (
                          <th
                            key={h}
                            style={{
                              textAlign: i >= 2 && i <= 6 ? 'right' : 'left',
                              padding: '10px 10px',
                              fontSize: 10,
                              letterSpacing: '0.09em',
                              textTransform: 'uppercase',
                              color: S.dim,
                              fontWeight: 500,
                              background: S.panel,
                              borderBottom: `1px solid ${S.border}`,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {evidencia.map((l) => (
                        <tr key={`${l.estrategia}-${l.timeframe}-linha`}>
                          <td style={celula(mono)}>{l.estrategia}</td>
                          <td style={celula(mono)}>{l.timeframe}</td>
                          <td style={celula(mono, 'right')}>{l.operacoes}</td>
                          <td
                            style={{
                              ...celula(mono, 'right'),
                              color: Number(l.soma_r ?? 0) < 0 ? S.red : S.green,
                            }}
                          >
                            {Number(l.soma_r ?? 0) >= 0 ? '+' : ''}
                            {num(l.soma_r)}
                          </td>
                          <td style={celula(mono, 'right')}>
                            {l.acerto_pct !== null ? `${l.acerto_pct}%` : '—'}
                          </td>
                          <td style={celula(mono, 'right')}>
                            {l.acerto_equilibrio_pct !== null
                              ? `${l.acerto_equilibrio_pct}%`
                              : '—'}
                          </td>
                          <td
                            style={celula(mono, 'right')}
                            title={l.diagnostico_entrada ?? ''}
                          >
                            {l.mfe_perdedoras_r !== null
                              ? `${num(l.mfe_perdedoras_r)} R`
                              : '—'}
                          </td>
                          <td style={celula()}>
                            <span
                              style={{
                                display: 'inline-block',
                                padding: '2px 7px',
                                fontSize: 10,
                                border: `1px solid ${corDoVeredito(l.veredito)}`,
                                color: corDoVeredito(l.veredito),
                                borderRadius: 4,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {rotuloCurto[l.veredito] ?? l.veredito}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p style={{ ...fraseStyle, marginTop: 12 }}>
                  <strong style={{ color: S.text }}>MFE perd.</strong> mede quanto
                  as operações que terminaram no stop chegaram a andar a favor.
                  Abaixo de 0,80 R elas vão direto ao stop — e nesse caso mudar
                  trailing, breakeven ou parcial não altera o resultado, porque não
                  há excursão a capturar.
                </p>
              </section>
            )}

            {/* ===================================== hipóteses */}
            {hipoteses.length > 0 && (
              <section>
                <h3 style={{ ...rotuloStyle, margin: '0 0 10px' }}>
                  Hipóteses registradas
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {hipoteses.map((h) => (
                    <Card key={h.id}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: 10,
                          marginBottom: 6,
                        }}
                      >
                        <span style={{ fontSize: 14 }}>{h.nome}</span>
                        <span
                          style={{
                            fontSize: 10,
                            padding: '2px 7px',
                            border: `1px solid ${
                              h.status === 'morta' ? S.red : S.a
                            }`,
                            color: h.status === 'morta' ? S.red : S.a,
                            borderRadius: 4,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                          }}
                        >
                          {h.status}
                        </span>
                      </div>

                      <p style={{ ...fraseStyle, margin: '0 0 10px' }}>
                        {h.pergunta}
                      </p>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))',
                          gap: 8,
                          fontSize: 11,
                        }}
                      >
                        <div>
                          <div style={{ color: S.dim }}>Amostra mínima</div>
                          <div style={{ fontFamily: mono, marginTop: 2 }}>
                            {h.amostra_minima}
                          </div>
                        </div>
                        <div>
                          <div style={{ color: S.dim }}>t exigido</div>
                          <div style={{ fontFamily: mono, marginTop: 2 }}>
                            {num(h.t_minimo_exigido)}
                          </div>
                        </div>
                        <div>
                          <div style={{ color: S.dim }}>Combinações</div>
                          <div style={{ fontFamily: mono, marginTop: 2 }}>
                            {h.combinacoes_testadas}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          marginTop: 10,
                          paddingTop: 10,
                          borderTop: `1px solid ${S.border}`,
                          ...fraseStyle,
                          fontSize: 11,
                        }}
                      >
                        <strong style={{ color: S.dim }}>Critério de morte:</strong>{' '}
                        {h.criterio_morte}
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            )}

            <div
              style={{
                borderTop: `1px solid ${S.border}`,
                paddingTop: 16,
                fontSize: 11,
                color: S.dim,
              }}
            >
              Análise estatística de um sistema em teste. Não é recomendação de
              investimento.
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function celula(
  fontFamily?: string,
  align: 'left' | 'right' = 'left',
): CSSProperties {
  return {
    padding: '9px 10px',
    borderBottom: `1px solid ${S.border}`,
    color: S.dim,
    whiteSpace: 'nowrap',
    textAlign: align,
    ...(fontFamily ? { fontFamily } : {}),
  };
}
