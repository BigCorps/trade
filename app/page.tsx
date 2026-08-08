'use client';

/**
 * app/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Painel principal.
 *
 * Usa o cabeçalho compartilhado `CabecalhoVigIA` e a paleta `S` já adotada nas
 * demais telas. Nenhum estilo novo foi inventado aqui.
 *
 * Responde quatro perguntas, nesta ordem de importância:
 *
 *   1. Posso operar com dinheiro de verdade hoje?
 *   2. Como está indo o teste?
 *   3. Por que está perdendo?
 *   4. Existe alguma oportunidade real aberta?
 *
 * Regra de escrita: todo número vem com a frase que explica o que ele
 * significa. Quem lê não precisa saber o que é "expectativa em R" para
 * entender se pode operar ou não.
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createClient } from '@supabase/supabase-js';

import CabecalhoVigIA, { S } from '../components/CabecalhoVigIA';

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
  t_observado: number | null;
  piso_ruido: number | null;
  combinacoes_no_experimento: number | null;
  veredito: string;
}

interface Decomposicao {
  taxa_acerto: number | null;
  ganho_medio_r: number | null;
  perda_media_r: number | null;
  expectativa_real_r: number | null;
  expectativa_sem_friccao_r: number | null;
  custo_friccao_r: number | null;
  problema_principal: string | null;
}

interface FaixaRisco {
  faixa: string;
  operacoes: number;
  imposto_pct_de_cada_r: number | null;
  resultado_medio_r: number | null;
  severidade: string;
}

interface Funding {
  simbolo: string;
  funding_anualizado_pct: number | null;
  carry_liquido_anualizado_pct: number | null;
  elegivel: boolean | null;
}

interface Politica {
  execution_environment: string;
  execution_enabled: boolean;
}

// ---------------------------------------------------------------------------
// Estilos derivados da paleta existente
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

const numeroStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 300,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
  lineHeight: 1.1,
};

const fraseStyle: CSSProperties = {
  fontSize: 12,
  color: S.dim,
  lineHeight: 1.5,
};

const mono = 'ui-monospace, "SF Mono", Menlo, monospace';

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

const num = (v: number | null | undefined, casas = 2) =>
  v === null || v === undefined
    ? '—'
    : Number(v).toLocaleString('pt-BR', {
        minimumFractionDigits: casas,
        maximumFractionDigits: casas,
      });

const percentual = (v: number | null | undefined, casas = 1) =>
  v === null || v === undefined ? '—' : `${(Number(v) * 100).toFixed(casas)}%`;

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...cardStyle, ...style }}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default function Painel() {
  const [evidencia, setEvidencia] = useState<LinhaEvidencia[]>([]);
  const [decomposicao, setDecomposicao] = useState<Decomposicao | null>(null);
  const [faixas, setFaixas] = useState<FaixaRisco[]>([]);
  const [funding, setFunding] = useState<Funding[]>([]);
  const [politicas, setPoliticas] = useState<Politica[]>([]);
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
      const [ev, dec, fx, fd, pol] = await Promise.all([
        supabase.from('vw_forward_test_evidencia').select('*'),
        supabase.from('vw_decomposicao_edge').select('*').maybeSingle(),
        supabase.from('vw_imposto_por_faixa_risco').select('*'),
        supabase
          .from('funding_carry_latest')
          .select(
            'simbolo, funding_anualizado_pct, carry_liquido_anualizado_pct, elegivel',
          )
          .order('carry_liquido_anualizado_pct', {
            ascending: false,
            nullsFirst: false,
          })
          .limit(6),
        supabase
          .from('daytrade_strategy_execution_policy')
          .select('execution_environment, execution_enabled'),
      ]);

      if (!vivo) return;

      if (ev.error) setErro(ev.error.message);

      setEvidencia((ev.data ?? []) as LinhaEvidencia[]);
      setDecomposicao((dec.data ?? null) as Decomposicao | null);
      setFaixas((fx.data ?? []) as FaixaRisco[]);
      setFunding((fd.data ?? []) as Funding[]);
      setPoliticas((pol.data ?? []) as Politica[]);
      setCarregando(false);
    })();

    return () => {
      vivo = false;
    };
  }, []);

  const habilitadasReal = useMemo(
    () =>
      politicas.filter(
        (p) => p.execution_environment === 'real' && p.execution_enabled,
      ).length,
    [politicas],
  );

  const aprovadas = useMemo(
    () => evidencia.filter((r) => r.veredito.includes('sobrevive')),
    [evidencia],
  );

  const totalOperacoes = useMemo(
    () => evidencia.reduce((s, r) => s + (r.operacoes ?? 0), 0),
    [evidencia],
  );

  const somaTotal = useMemo(
    () => evidencia.reduce((s, r) => s + Number(r.soma_r ?? 0), 0),
    [evidencia],
  );

  const comAmostra = useMemo(
    () =>
      evidencia
        .filter((r) => r.operacoes >= 30)
        .sort((a, b) => Number(a.soma_r ?? 0) - Number(b.soma_r ?? 0)),
    [evidencia],
  );

  const podeOperar = habilitadasReal > 0 && aprovadas.length > 0;
  const fundingElegivel = funding.filter((f) => f.elegivel);
  const melhorFunding = funding[0] ?? null;

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
        titulo="Painel"
        subtitulo="situação · evidência · custos"
        ativo="/"
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
            Carregando dados do teste…
          </Card>
        )}

        {!carregando && (
          <>
            {/* ===================================== 1. SEMÁFORO */}
            <Card
              style={{
                textAlign: 'center',
                borderTop: `3px solid ${podeOperar ? S.green : S.red}`,
                padding: '24px 18px',
              }}
            >
              <div style={{ ...rotuloStyle, marginBottom: 12 }}>
                Posso operar com dinheiro de verdade hoje?
              </div>
              <div
                style={{
                  fontSize: 52,
                  fontWeight: 300,
                  lineHeight: 1,
                  letterSpacing: '-0.03em',
                  color: podeOperar ? S.green : S.red,
                  marginBottom: 14,
                  fontFamily: mono,
                }}
              >
                {podeOperar ? 'SIM' : 'NÃO'}
              </div>
              <div
                style={{
                  ...fraseStyle,
                  fontSize: 13,
                  maxWidth: 380,
                  margin: '0 auto 20px',
                }}
              >
                {podeOperar
                  ? `${aprovadas.length} estratégia(s) passaram na verificação estatística e a execução real está habilitada.`
                  : 'Nenhuma estratégia passou na verificação estatística. O sistema está travado — e essa trava é intencional.'}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 1,
                  background: S.border,
                  border: `1px solid ${S.border}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                  textAlign: 'left',
                }}
              >
                <div style={{ background: S.bg, padding: '10px 12px' }}>
                  <div style={rotuloStyle}>Liberadas p/ conta real</div>
                  <div style={{ fontFamily: mono, fontSize: 17, marginTop: 4 }}>
                    {habilitadasReal} de 6
                  </div>
                </div>
                <div style={{ background: S.bg, padding: '10px 12px' }}>
                  <div style={rotuloStyle}>Com evidência aprovada</div>
                  <div style={{ fontFamily: mono, fontSize: 17, marginTop: 4 }}>
                    {aprovadas.length} de {evidencia.length}
                  </div>
                </div>
              </div>
            </Card>

            {/* ===================================== 2. O TESTE */}
            <section>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>
                Como está indo o teste
              </h2>
              <p style={{ ...fraseStyle, fontSize: 13, margin: '0 0 16px' }}>
                O sistema gera sinais e registra o que teria acontecido, sem
                dinheiro envolvido. Cada operação é medida em{' '}
                <strong style={{ color: S.text }}>R</strong> — a unidade que você
                arriscou. Perder 1 R é perder exatamente o que estava disposto a
                perder naquela operação.
              </p>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 12,
                }}
              >
                <Card>
                  <div style={rotuloStyle}>Operações</div>
                  <div style={{ ...numeroStyle, margin: '8px 0 6px' }}>
                    {totalOperacoes}
                  </div>
                  <div style={fraseStyle}>desde o início do teste</div>
                </Card>

                <Card>
                  <div style={rotuloStyle}>Acumulado</div>
                  <div
                    style={{
                      ...numeroStyle,
                      margin: '8px 0 6px',
                      color: somaTotal < 0 ? S.red : S.green,
                    }}
                  >
                    {somaTotal >= 0 ? '+' : ''}
                    {num(somaTotal)} R
                  </div>
                  <div style={fraseStyle}>
                    {somaTotal < 0
                      ? `arriscando 1% por operação, seria cerca de ${Math.abs(
                          somaTotal,
                        ).toFixed(0)}% da conta`
                      : 'em terreno positivo'}
                  </div>
                </Card>

                <Card>
                  <div style={rotuloStyle}>Por operação</div>
                  <div
                    style={{
                      ...numeroStyle,
                      margin: '8px 0 6px',
                      color:
                        Number(decomposicao?.expectativa_real_r ?? 0) < 0
                          ? S.red
                          : S.green,
                    }}
                  >
                    {num(decomposicao?.expectativa_real_r, 3)} R
                  </div>
                  <div style={fraseStyle}>o que sobra, em média</div>
                </Card>
              </div>

              {comAmostra.length > 0 && (
                <>
                  <h3 style={{ ...rotuloStyle, margin: '24px 0 10px' }}>
                    Estratégias com amostra suficiente para julgar
                  </h3>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {comAmostra.map((linha) => {
                      const t = Number(linha.t_observado ?? 0);
                      const piso = Number(linha.piso_ruido ?? 0);
                      const ruim = linha.veredito.includes('negativo');
                      const ruido = linha.veredito.includes('ruído');

                      return (
                        <Card key={`${linha.estrategia}-${linha.timeframe}`}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'baseline',
                              gap: 12,
                              marginBottom: 6,
                            }}
                          >
                            <span style={{ fontSize: 14 }}>
                              {linha.estrategia}{' '}
                              <span
                                style={{
                                  fontSize: 11,
                                  color: S.dim,
                                  fontFamily: mono,
                                }}
                              >
                                {linha.timeframe}
                              </span>
                            </span>
                            <span
                              style={{
                                fontFamily: mono,
                                fontSize: 15,
                                color: ruim ? S.red : S.text,
                              }}
                            >
                              {Number(linha.soma_r ?? 0) >= 0 ? '+' : ''}
                              {num(linha.soma_r)} R
                            </span>
                          </div>

                          <p style={{ ...fraseStyle, margin: '0 0 12px' }}>
                            {ruim
                              ? `Em ${linha.operacoes} operações, perdeu de forma consistente. Não é falta de sorte: o resultado é forte o bastante para esperar que se repita.`
                              : ruido
                                ? `Em ${linha.operacoes} operações, o resultado não se distingue do acaso. Foram testadas ${linha.combinacoes_no_experimento} combinações, e com esse tanto de tentativas a sorte sozinha produziria algo assim.`
                                : `${linha.operacoes} operações registradas. Ainda sem conclusão.`}
                          </p>

                          <div
                            style={{
                              position: 'relative',
                              height: 8,
                              background: 'rgba(255,255,255,0.03)',
                              borderRadius: 2,
                            }}
                          >
                            <div
                              style={{
                                position: 'absolute',
                                left: '50%',
                                top: -2,
                                bottom: -2,
                                width: 1,
                                background: S.border,
                              }}
                            />
                            <div
                              title={`Nível a superar: ${piso.toFixed(2)}`}
                              style={{
                                position: 'absolute',
                                left: `${Math.min(96, 50 + (piso / 4) * 50)}%`,
                                top: -3,
                                bottom: -3,
                                width: 1,
                                background: `repeating-linear-gradient(to bottom, ${S.dim} 0 3px, transparent 3px 6px)`,
                              }}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                top: 0,
                                bottom: 0,
                                borderRadius: 2,
                                background: ruim ? S.red : S.dim,
                                width: `${Math.min(50, (Math.abs(t) / 4) * 50)}%`,
                                ...(t >= 0 ? { left: '50%' } : { right: '50%' }),
                              }}
                            />
                          </div>
                        </Card>
                      );
                    })}
                  </div>

                  <p style={{ ...fraseStyle, marginTop: 12 }}>
                    A linha pontilhada marca o nível que um resultado precisa
                    cruzar para ser levado a sério. Ela existe porque testar
                    muitas combinações e escolher a melhor produz vencedores por
                    acaso — quanto mais combinações, mais alto o nível.
                  </p>
                </>
              )}
            </section>

            {/* ===================================== 3. O PORQUÊ */}
            {decomposicao && (
              <section>
                <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>
                  Por que está perdendo
                </h2>
                <p style={{ ...fraseStyle, fontSize: 13, margin: '0 0 16px' }}>
                  Existem só duas causas possíveis, e elas se resolvem de formas
                  opostas. Confundir uma com a outra custa meses.
                </p>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
                    gap: 12,
                  }}
                >
                  <Card>
                    <div style={rotuloStyle}>1. A entrada não acerta</div>
                    <div
                      style={{
                        ...numeroStyle,
                        margin: '8px 0',
                        color:
                          Number(decomposicao.expectativa_sem_friccao_r ?? 0) < 0
                            ? S.red
                            : S.green,
                      }}
                    >
                      {num(decomposicao.expectativa_sem_friccao_r, 3)} R
                    </div>
                    <div style={fraseStyle}>
                      É o que sobraria se a corretora não cobrasse nada. Como está
                      negativo, o problema começa na decisão de entrar — o sistema
                      acerta a direção em apenas{' '}
                      <strong style={{ color: S.text }}>
                        {percentual(decomposicao.taxa_acerto)}
                      </strong>{' '}
                      das vezes.
                    </div>
                  </Card>

                  <Card>
                    <div style={rotuloStyle}>2. O custo de operar</div>
                    <div style={{ ...numeroStyle, margin: '8px 0', color: S.red }}>
                      {num(decomposicao.custo_friccao_r, 3)} R
                    </div>
                    <div style={fraseStyle}>
                      Taxas e diferença de preço na execução. É o pedágio para
                      abrir e fechar, independentemente do que o mercado faça.
                    </div>
                  </Card>
                </div>

                <Card
                  style={{
                    marginTop: 12,
                    borderLeft: `2px solid ${S.a}`,
                    fontSize: 13,
                    color: S.dim,
                  }}
                >
                  {decomposicao.problema_principal}
                </Card>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: 1,
                    background: S.border,
                    border: `1px solid ${S.border}`,
                    borderRadius: 8,
                    overflow: 'hidden',
                    marginTop: 12,
                  }}
                >
                  {[
                    {
                      r: 'Acerta',
                      v: percentual(decomposicao.taxa_acerto),
                      n: 'das operações',
                      c: S.text,
                    },
                    {
                      r: 'Precisaria acertar',
                      v: `${num(
                        (Math.abs(Number(decomposicao.perda_media_r ?? 0)) /
                          (Math.abs(Number(decomposicao.ganho_medio_r ?? 0)) +
                            Math.abs(Number(decomposicao.perda_media_r ?? 1)))) *
                          100,
                        1,
                      )}%`,
                      n: 'só para empatar',
                      c: S.a,
                    },
                    {
                      r: 'Quando ganha',
                      v: `+${num(decomposicao.ganho_medio_r)} R`,
                      n: 'em média',
                      c: S.green,
                    },
                    {
                      r: 'Quando perde',
                      v: `−${num(
                        Math.abs(Number(decomposicao.perda_media_r ?? 0)),
                      )} R`,
                      n: 'em média',
                      c: S.red,
                    },
                  ].map((item) => (
                    <div key={item.r} style={{ background: S.bg, padding: '10px 12px' }}>
                      <div style={rotuloStyle}>{item.r}</div>
                      <div
                        style={{
                          fontFamily: mono,
                          fontSize: 17,
                          margin: '4px 0 2px',
                          color: item.c,
                        }}
                      >
                        {item.v}
                      </div>
                      <div style={{ fontSize: 11, color: S.dim }}>{item.n}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ===================================== 4. O PEDÁGIO */}
            {faixas.length > 0 && (
              <section>
                <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>
                  A conta que decide quase tudo
                </h2>
                <p style={{ ...fraseStyle, fontSize: 13, margin: '0 0 16px' }}>
                  As taxas são cobradas sobre o{' '}
                  <strong style={{ color: S.text }}>valor negociado</strong>, mas o
                  resultado é medido sobre o{' '}
                  <strong style={{ color: S.text }}>risco assumido</strong>. Quando
                  o stop fica perto do preço de entrada, o risco é pequeno e a
                  mesma taxa vira uma fatia enorme do resultado possível.
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {faixas.map((f) => {
                    const imposto = Number(f.imposto_pct_de_cada_r ?? 0);
                    const cor =
                      f.severidade === 'proibitivo'
                        ? S.red
                        : f.severidade === 'alto'
                          ? S.a
                          : S.green;

                    return (
                      <Card key={f.faixa}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'baseline',
                            marginBottom: 8,
                          }}
                        >
                          <span style={{ fontSize: 13 }}>
                            {f.faixa.replace(/^\d\.\s*/, '')}
                          </span>
                          <span
                            style={{ fontSize: 11, color: S.dim, fontFamily: mono }}
                          >
                            {f.operacoes} op.
                          </span>
                        </div>

                        <div
                          style={{
                            height: 6,
                            background: 'rgba(255,255,255,0.04)',
                            borderRadius: 3,
                            overflow: 'hidden',
                            marginBottom: 8,
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${Math.min(100, imposto)}%`,
                              background: cor,
                            }}
                          />
                        </div>

                        <div style={fraseStyle}>
                          A corretora fica com{' '}
                          <strong
                            style={{ color: cor, fontFamily: mono, fontWeight: 400 }}
                          >
                            {num(imposto, 1)}%
                          </strong>{' '}
                          de cada unidade de risco. Resultado médio:{' '}
                          <strong
                            style={{
                              color:
                                Number(f.resultado_medio_r) < 0 ? S.red : S.green,
                              fontFamily: mono,
                              fontWeight: 400,
                            }}
                          >
                            {num(f.resultado_medio_r, 3)} R
                          </strong>
                        </div>
                      </Card>
                    );
                  })}
                </div>

                <p style={{ ...fraseStyle, marginTop: 12 }}>
                  Quanto mais apertado o risco, maior a fatia que vai para a
                  corretora e pior o resultado — sem exceção em nenhuma faixa.
                  Operações de risco muito curto nascem perdidas antes de o mercado
                  se mexer.
                </p>
              </section>
            )}

            {/* ===================================== 5. FUNDING */}
            {funding.length > 0 && (
              <section>
                <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>
                  Existe alguma oportunidade real aberta?
                </h2>
                <p style={{ ...fraseStyle, fontSize: 13, margin: '0 0 16px' }}>
                  Esta é a única parte do sistema que não tenta adivinhar para onde
                  o preço vai. Ela captura um pagamento que existe entre quem está
                  comprado e quem está vendido em contratos perpétuos. Vale a pena
                  quando esse pagamento supera o custo de montar a operação.
                </p>

                <Card
                  style={{
                    borderLeft: `2px solid ${
                      fundingElegivel.length > 0 ? S.green : S.dim
                    }`,
                    marginBottom: 12,
                  }}
                >
                  <div style={{ fontSize: 14, marginBottom: 6 }}>
                    {fundingElegivel.length > 0
                      ? `${fundingElegivel.length} oportunidade(s) dentro do critério`
                      : 'Nenhuma oportunidade dentro do critério agora'}
                  </div>
                  {melhorFunding && (
                    <div style={fraseStyle}>
                      O melhor caso hoje é {melhorFunding.simbolo}, pagando{' '}
                      {num(melhorFunding.funding_anualizado_pct)}% ao ano.
                      Descontados os custos, sobrariam{' '}
                      {num(melhorFunding.carry_liquido_anualizado_pct)}% ao ano —
                      ainda pouco para justificar o risco de execução.
                    </div>
                  )}
                </Card>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                    background: S.border,
                    border: `1px solid ${S.border}`,
                    borderRadius: 8,
                    overflow: 'hidden',
                  }}
                >
                  {funding.map((f) => (
                    <div
                      key={f.simbolo}
                      style={{
                        background: S.bg,
                        padding: '9px 14px',
                        display: 'grid',
                        gridTemplateColumns: '1fr auto auto',
                        gap: 14,
                        alignItems: 'baseline',
                        fontSize: 13,
                      }}
                    >
                      <span>{f.simbolo}</span>
                      <span style={{ color: S.dim, fontSize: 12, fontFamily: mono }}>
                        {num(f.funding_anualizado_pct)}% bruto
                      </span>
                      <span
                        style={{
                          fontFamily: mono,
                          color:
                            Number(f.carry_liquido_anualizado_pct ?? 0) > 0
                              ? S.green
                              : S.red,
                        }}
                      >
                        {num(f.carry_liquido_anualizado_pct)}% líquido
                      </span>
                    </div>
                  ))}
                </div>

                <p style={{ ...fraseStyle, marginTop: 12 }}>
                  Este módulo custa quase nada para manter rodando e avisa quando a
                  janela abrir. Historicamente isso acontece em períodos de euforia,
                  algumas vezes por ano.
                </p>
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
              Painel de acompanhamento de um sistema em teste. Não é recomendação de
              investimento.
            </div>
          </>
        )}
      </div>
    </main>
  );
}
