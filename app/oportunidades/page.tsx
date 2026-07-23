'use client';

/**
 * app/oportunidades/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Teste prospectivo das estratégias diárias.
 *
 * Esta rota antes exibia oportunidades intradiárias acionáveis. Aquelas
 * estratégias foram reprovadas na validação walk-forward (média de -0,142R por
 * operação no 1h, com 0 de 9 símbolos positivos), e apresentar sinais delas
 * como acionáveis seria enganoso. A rota foi mantida para não quebrar links,
 * mas o conteúdo agora é o acompanhamento honesto de um experimento em curso.
 *
 * A página é deliberadamente somente leitura. O valor do teste prospectivo vem
 * de as regras permanecerem congeladas; qualquer botão que permitisse ajustar
 * parâmetros no meio do caminho destruiria o experimento.
 *
 * Nenhuma ordem é executada a partir daqui.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '@/lib/supabaseClient';

// ---------------------------------------------------------------------------
// Estilo (mesma paleta das demais páginas)
// ---------------------------------------------------------------------------

const S = {
  bg: '#101418',
  panel: '#181f26',
  panelSoft: '#141a20',
  border: '#2a343f',
  text: '#d7dee6',
  dim: '#7d8a97',
  a: '#e8a13c',
  b: '#4f8fd0',
  green: '#3fb26f',
  red: '#d05555',
};

const fmtNum = (valor: number | null | undefined, casas = 2): string => {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) {
    return '—';
  }
  return Number(valor).toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
};

const fmtR = (valor: number | null | undefined): string => {
  if (valor === null || valor === undefined || !Number.isFinite(Number(valor))) {
    return '—';
  }
  return `${Number(valor) > 0 ? '+' : ''}${fmtNum(valor)}R`;
};

const fmtData = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      });
};

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: string;
  nome: string;
  versao: string;
  timeframe: string;
  estrategias: string[];
  simbolos: string[];
  fee_rate_pct: number;
  slippage_pct: number;
  congelado_em: string;
  observacoes: string | null;
}

interface ResumoRow {
  nome: string;
  versao: string;
  estrategia: string;
  operacoes_fechadas: number;
  em_andamento: number;
  ganhos: number;
  perdas: number;
  media_r: number | null;
  soma_r_fixo: number | null;
  soma_r_anti: number | null;
  primeiro_sinal: string | null;
  ultimo_sinal: string | null;
}

interface SinalRow {
  id: string;
  simbolo: string;
  estrategia: string;
  candle_open_time: string;
  status: string;
  entrada_referencia: number;
  stop_referencia: number;
  alvo_referencia: number;
  entrada_preco: number | null;
  saida_preco: number | null;
  saida_motivo: string | null;
  resultado_r: number | null;
  tamanho_anti: number;
  resultado_anterior: string | null;
}

// ---------------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------------

function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        background: S.panel,
        border: `1px solid ${S.border}`,
        borderRadius: 12,
        padding: 18,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Metrica({
  rotulo,
  valor,
  detalhe,
  cor,
}: {
  rotulo: string;
  valor: string;
  detalhe?: string;
  cor?: string;
}) {
  return (
    <div
      style={{
        background: S.panelSoft,
        border: `1px solid ${S.border}`,
        borderRadius: 10,
        padding: 14,
        minWidth: 150,
        flex: '1 1 150px',
      }}
    >
      <div style={{ color: S.dim, fontSize: 11, marginBottom: 6 }}>
        {rotulo}
      </div>
      <div style={{ color: cor ?? S.text, fontSize: 22, fontWeight: 600 }}>
        {valor}
      </div>
      {detalhe && (
        <div style={{ color: S.dim, fontSize: 11, marginTop: 4 }}>
          {detalhe}
        </div>
      )}
    </div>
  );
}

function Etiqueta({ status }: { status: string }) {
  const cores: Record<string, string> = {
    aguardando_entrada: S.b,
    aberto: S.a,
    fechado: S.green,
    cancelado: S.dim,
  };

  const rotulos: Record<string, string> = {
    aguardando_entrada: 'aguardando',
    aberto: 'aberta',
    fechado: 'fechada',
    cancelado: 'cancelada',
  };

  const cor = cores[status] ?? S.dim;

  return (
    <span
      style={{
        color: cor,
        border: `1px solid ${cor}`,
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        whiteSpace: 'nowrap',
      }}
    >
      {rotulos[status] ?? status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function TestePropectivoPage() {
  const supabase = useMemo(() => getSupabase(), []);

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigRow | null>(null);
  const [resumo, setResumo] = useState<ResumoRow[]>([]);
  const [sinais, setSinais] = useState<SinalRow[]>([]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);

    const [configRes, resumoRes, sinaisRes] = await Promise.all([
      supabase
        .from('forward_test_config')
        .select('*')
        .eq('ativo', true)
        .maybeSingle(),
      supabase.from('forward_test_resumo').select('*'),
      supabase
        .from('forward_test_signals')
        .select(
          'id, simbolo, estrategia, candle_open_time, status, entrada_referencia, stop_referencia, alvo_referencia, entrada_preco, saida_preco, saida_motivo, resultado_r, tamanho_anti, resultado_anterior',
        )
        .order('candle_open_time', { ascending: false })
        .limit(60),
    ]);

    if (configRes.error) {
      setErro(
        'Não foi possível carregar a configuração. Faça login para acompanhar o experimento.',
      );
      setCarregando(false);
      return;
    }

    setConfig((configRes.data as ConfigRow | null) ?? null);
    setResumo((resumoRes.data as ResumoRow[] | null) ?? []);
    setSinais((sinaisRes.data as SinalRow[] | null) ?? []);
    setCarregando(false);
  }, [supabase]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const totais = useMemo(() => {
    const fechadas = resumo.reduce(
      (t, r) => t + Number(r.operacoes_fechadas ?? 0),
      0,
    );
    const andamento = resumo.reduce(
      (t, r) => t + Number(r.em_andamento ?? 0),
      0,
    );
    const ganhos = resumo.reduce((t, r) => t + Number(r.ganhos ?? 0), 0);
    const perdas = resumo.reduce((t, r) => t + Number(r.perdas ?? 0), 0);
    const somaFixo = resumo.reduce((t, r) => t + Number(r.soma_r_fixo ?? 0), 0);
    const somaAnti = resumo.reduce((t, r) => t + Number(r.soma_r_anti ?? 0), 0);

    return {
      fechadas,
      andamento,
      ganhos,
      perdas,
      somaFixo,
      somaAnti,
      acerto: ganhos + perdas > 0 ? (ganhos / (ganhos + perdas)) * 100 : null,
      mediaR: fechadas > 0 ? somaFixo / fechadas : null,
    };
  }, [resumo]);

  /**
   * Abaixo de ~100 operações a diferença entre habilidade e acaso não é
   * estatisticamente distinguível. O aviso é permanente até lá, de propósito.
   */
  const amostraSuficiente = totais.fechadas >= 100;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: S.bg,
        color: S.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '28px 16px 60px',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, margin: 0, fontWeight: 600 }}>
            Teste prospectivo
          </h1>
          <p
            style={{
              color: S.dim,
              fontSize: 13,
              marginTop: 6,
              lineHeight: 1.6,
            }}
          >
            Acompanhamento de um experimento em andamento, com regras congeladas.
            Nenhuma ordem é executada a partir desta página, e os números abaixo
            não constituem recomendação.
          </p>

          <nav
            style={{
              display: 'flex',
              gap: 20,
              marginTop: 14,
              fontSize: 13,
              flexWrap: 'wrap',
            }}
          >
            <a href="/" style={{ color: S.dim, textDecoration: 'none' }}>
              Análise
            </a>
            <a href="/daytrade" style={{ color: S.dim, textDecoration: 'none' }}>
              Validação
            </a>
            <span style={{ color: S.a, fontWeight: 600 }}>
              Teste prospectivo
            </span>
            <a href="/alertas" style={{ color: S.dim, textDecoration: 'none' }}>
              Alertas
            </a>
            <a href="/conta" style={{ color: S.dim, textDecoration: 'none' }}>
              Conta Binance
            </a>
          </nav>
        </header>

        {carregando && (
          <Card>
            <span style={{ color: S.dim }}>Carregando…</span>
          </Card>
        )}

        {erro && !carregando && (
          <Card style={{ borderColor: S.a }}>
            <span style={{ color: S.a }}>{erro}</span>
          </Card>
        )}

        {!carregando && !erro && !config && (
          <Card>
            <span style={{ color: S.dim }}>
              Nenhum experimento ativo no momento.
            </span>
          </Card>
        )}

        {!carregando && !erro && config && (
          <>
            {!amostraSuficiente && (
              <Card
                style={{
                  borderColor: S.a,
                  marginBottom: 18,
                  background: 'rgba(232,161,60,0.06)',
                }}
              >
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <strong style={{ color: S.a }}>
                    Amostra ainda insuficiente.
                  </strong>{' '}
                  São {totais.fechadas} operações encerradas. Abaixo de cerca de
                  100, a diferença entre habilidade e acaso não é
                  estatisticamente distinguível — qualquer resultado aqui, bom ou
                  ruim, deve ser lido como preliminar. Uma vantagem pequena, do
                  tamanho que esperamos, precisaria de várias centenas de
                  operações para ser confirmada.
                </div>
              </Card>
            )}

            <Card style={{ marginBottom: 18 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <h2 style={{ fontSize: 15, margin: 0, fontWeight: 600 }}>
                  {config.nome}{' '}
                  <span style={{ color: S.dim, fontWeight: 400 }}>
                    v{config.versao}
                  </span>
                </h2>
                <span style={{ color: S.dim, fontSize: 12 }}>
                  congelado em {fmtData(config.congelado_em)}
                </span>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 12,
                  marginTop: 14,
                  fontSize: 12,
                }}
              >
                <div>
                  <div style={{ color: S.dim }}>Timeframe</div>
                  <div>{config.timeframe}</div>
                </div>
                <div>
                  <div style={{ color: S.dim }}>Estratégias</div>
                  <div>{config.estrategias.join(', ')}</div>
                </div>
                <div>
                  <div style={{ color: S.dim }}>Moedas</div>
                  <div>{config.simbolos.length} pares</div>
                </div>
                <div>
                  <div style={{ color: S.dim }}>Custos simulados</div>
                  <div>
                    taxa {config.fee_rate_pct}% + slippage {config.slippage_pct}%
                  </div>
                </div>
              </div>

              {config.observacoes && (
                <p
                  style={{
                    color: S.dim,
                    fontSize: 12,
                    marginTop: 14,
                    marginBottom: 0,
                    lineHeight: 1.6,
                  }}
                >
                  {config.observacoes}
                </p>
              )}
            </Card>

            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 18,
              }}
            >
              <Metrica
                rotulo="Operações encerradas"
                valor={String(totais.fechadas)}
                detalhe={`${totais.andamento} em andamento`}
              />
              <Metrica
                rotulo="Taxa de acerto"
                valor={
                  totais.acerto === null ? '—' : `${fmtNum(totais.acerto, 1)}%`
                }
                detalhe={`${totais.ganhos} ganhos / ${totais.perdas} perdas`}
              />
              <Metrica
                rotulo="Média por operação"
                valor={fmtR(totais.mediaR)}
                detalhe="tamanho fixo"
                cor={
                  totais.mediaR === null
                    ? undefined
                    : totais.mediaR > 0
                      ? S.green
                      : S.red
                }
              />
              <Metrica
                rotulo="Soma — tamanho fixo"
                valor={fmtR(totais.somaFixo)}
                detalhe="referência do experimento"
                cor={totais.somaFixo > 0 ? S.green : S.red}
              />
              <Metrica
                rotulo="Soma — anti-martingale"
                valor={fmtR(totais.somaAnti)}
                detalhe="×1,5 após ganho"
                cor={totais.somaAnti > 0 ? S.green : S.red}
              />
            </div>

            {resumo.length > 0 && (
              <Card style={{ marginBottom: 18 }}>
                <h2
                  style={{ fontSize: 15, margin: '0 0 12px', fontWeight: 600 }}
                >
                  Por estratégia
                </h2>

                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: 13,
                    }}
                  >
                    <thead>
                      <tr style={{ color: S.dim, textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>Estratégia</th>
                        <th style={{ padding: '6px 8px' }}>Fechadas</th>
                        <th style={{ padding: '6px 8px' }}>Andamento</th>
                        <th style={{ padding: '6px 8px' }}>Acerto</th>
                        <th style={{ padding: '6px 8px' }}>Média R</th>
                        <th style={{ padding: '6px 8px' }}>Soma fixo</th>
                        <th style={{ padding: '6px 8px' }}>Soma anti</th>
                      </tr>
                    </thead>
                    <tbody>
                      {resumo.map((linha) => {
                        const decididas =
                          Number(linha.ganhos ?? 0) + Number(linha.perdas ?? 0);
                        const acerto =
                          decididas > 0
                            ? (Number(linha.ganhos ?? 0) / decididas) * 100
                            : null;

                        return (
                          <tr
                            key={linha.estrategia}
                            style={{ borderTop: `1px solid ${S.border}` }}
                          >
                            <td style={{ padding: '8px' }}>
                              {linha.estrategia}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {linha.operacoes_fechadas}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {linha.em_andamento}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {acerto === null ? '—' : `${fmtNum(acerto, 1)}%`}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {fmtR(linha.media_r)}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {fmtR(linha.soma_r_fixo)}
                            </td>
                            <td style={{ padding: '8px' }}>
                              {fmtR(linha.soma_r_anti)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            <Card>
              <h2 style={{ fontSize: 15, margin: '0 0 12px', fontWeight: 600 }}>
                Sinais recentes
              </h2>

              {sinais.length === 0 ? (
                <p style={{ color: S.dim, fontSize: 13, margin: 0 }}>
                  Nenhum sinal registrado ainda. O experimento avalia os candles
                  diários uma vez por dia; os primeiros sinais aparecem conforme
                  as condições das estratégias forem atendidas.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      fontSize: 13,
                    }}
                  >
                    <thead>
                      <tr style={{ color: S.dim, textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px' }}>Data</th>
                        <th style={{ padding: '6px 8px' }}>Moeda</th>
                        <th style={{ padding: '6px 8px' }}>Estratégia</th>
                        <th style={{ padding: '6px 8px' }}>Situação</th>
                        <th style={{ padding: '6px 8px' }}>Entrada</th>
                        <th style={{ padding: '6px 8px' }}>Stop</th>
                        <th style={{ padding: '6px 8px' }}>Alvo</th>
                        <th style={{ padding: '6px 8px' }}>Resultado</th>
                        <th style={{ padding: '6px 8px' }}>Tam. anti</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sinais.map((sinal) => (
                        <tr
                          key={sinal.id}
                          style={{ borderTop: `1px solid ${S.border}` }}
                        >
                          <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                            {fmtData(sinal.candle_open_time)}
                          </td>
                          <td style={{ padding: '8px' }}>{sinal.simbolo}</td>
                          <td style={{ padding: '8px', color: S.dim }}>
                            {sinal.estrategia.replace('trend_', '')}
                          </td>
                          <td style={{ padding: '8px' }}>
                            <Etiqueta status={sinal.status} />
                          </td>
                          <td style={{ padding: '8px' }}>
                            {fmtNum(
                              sinal.entrada_preco ?? sinal.entrada_referencia,
                              4,
                            )}
                          </td>
                          <td style={{ padding: '8px', color: S.dim }}>
                            {fmtNum(sinal.stop_referencia, 4)}
                          </td>
                          <td style={{ padding: '8px', color: S.dim }}>
                            {fmtNum(sinal.alvo_referencia, 4)}
                          </td>
                          <td
                            style={{
                              padding: '8px',
                              color:
                                sinal.resultado_r === null
                                  ? S.dim
                                  : Number(sinal.resultado_r) > 0
                                    ? S.green
                                    : S.red,
                            }}
                          >
                            {fmtR(sinal.resultado_r)}
                          </td>
                          <td style={{ padding: '8px', color: S.dim }}>
                            ×{fmtNum(sinal.tamanho_anti, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <p
              style={{
                color: S.dim,
                fontSize: 11,
                marginTop: 20,
                lineHeight: 1.7,
              }}
            >
              As estratégias intradiárias que antes ocupavam esta página foram
              retiradas após serem reprovadas na validação: média de −0,142R por
              operação no timeframe de 1 hora, com nenhum dos nove símbolos
              testados apresentando resultado positivo. Este experimento mede
              estratégias diárias, cujo resultado ainda é desconhecido. Conteúdo
              educacional; não constitui recomendação de investimento.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

