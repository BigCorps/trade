/**
 * app/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Painel principal.
 *
 * Substitui a home antiga (2.728 linhas) que mostrava ordens, análises e
 * oportunidades — tabelas com 6 a 16 registros de um sistema que não opera.
 *
 * Este painel responde quatro perguntas, nesta ordem de importância:
 *
 *   1. Posso operar com dinheiro de verdade hoje?
 *   2. Como está indo o teste?
 *   3. Por que está perdendo?
 *   4. Existe alguma oportunidade real aberta?
 *
 * Regra de escrita: todo número aparece acompanhado da frase que explica o
 * que ele significa. Quem lê não precisa saber o que é "expectativa em R"
 * para entender se pode operar ou não.
 */

import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface LinhaEvidencia {
  estrategia: string;
  timeframe: string;
  operacoes: number;
  soma_r: number | null;
  media_r: number | null;
  t_observado: number | null;
  piso_ruido: number | null;
  combinacoes_no_experimento: number | null;
  veredito: string;
  mfe_perdedoras_r: number | null;
}

interface Decomposicao {
  operacoes: number;
  taxa_acerto: number | null;
  ganho_medio_r: number | null;
  perda_media_r: number | null;
  expectativa_real_r: number | null;
  expectativa_sem_friccao_r: number | null;
  custo_friccao_r: number | null;
  stop_pct_preco: number | null;
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

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

async function carregar() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  const db = createClient(url, key);

  const [evidencia, decomposicao, faixas, funding, politicas] =
    await Promise.all([
      db.from('vw_forward_test_evidencia').select('*'),
      db.from('vw_decomposicao_edge').select('*').maybeSingle(),
      db.from('vw_imposto_por_faixa_risco').select('*'),
      db
        .from('funding_carry_latest')
        .select('simbolo, funding_anualizado_pct, carry_liquido_anualizado_pct, elegivel')
        .order('carry_liquido_anualizado_pct', { ascending: false, nullsFirst: false })
        .limit(6),
      db
        .from('daytrade_strategy_execution_policy')
        .select('strategy, execution_environment, execution_enabled'),
    ]);

  return {
    evidencia: (evidencia.data ?? []) as LinhaEvidencia[],
    decomposicao: (decomposicao.data ?? null) as Decomposicao | null,
    faixas: (faixas.data ?? []) as FaixaRisco[],
    funding: (funding.data ?? []) as Funding[],
    politicas: politicas.data ?? [],
  };
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

const n = (valor: number | null | undefined, casas = 2): string =>
  valor === null || valor === undefined ? '—' : Number(valor).toFixed(casas);

const pct = (valor: number | null | undefined, casas = 1): string =>
  valor === null || valor === undefined ? '—' : `${(Number(valor) * 100).toFixed(casas)}%`;

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export default async function Painel() {
  const dados = await carregar();

  if (!dados) {
    return (
      <main className="painel">
        <style>{estilos}</style>
        <div className="aviso">
          Defina <code>NEXT_PUBLIC_SUPABASE_URL</code> e{' '}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> para carregar o painel.
        </div>
      </main>
    );
  }

  const { evidencia, decomposicao, faixas, funding, politicas } = dados;

  const habilitadasReal = politicas.filter(
    (p: { execution_environment: string; execution_enabled: boolean }) =>
      p.execution_environment === 'real' && p.execution_enabled,
  ).length;

  const totalOperacoes = evidencia.reduce((s, r) => s + (r.operacoes ?? 0), 0);
  const somaTotal = evidencia.reduce((s, r) => s + Number(r.soma_r ?? 0), 0);

  const aprovadas = evidencia.filter((r) => r.veredito.includes('sobrevive'));
  const podeOperar = habilitadasReal > 0 && aprovadas.length > 0;

  const fundingElegivel = funding.filter((f) => f.elegivel);
  const melhorFunding = funding[0] ?? null;

  const comAmostra = evidencia
    .filter((r) => r.operacoes >= 30)
    .sort((a, b) => Number(a.soma_r ?? 0) - Number(b.soma_r ?? 0));

  return (
    <main className="painel">
      <style>{estilos}</style>

      {/* ============================================ 1. O SEMÁFORO */}
      <section className={`semaforo ${podeOperar ? 'liberado' : 'travado'}`}>
        <p className="semaforo-pergunta">
          Posso operar com dinheiro de verdade hoje?
        </p>
        <p className="semaforo-resposta">{podeOperar ? 'SIM' : 'NÃO'}</p>
        <p className="semaforo-motivo">
          {podeOperar
            ? `${aprovadas.length} estratégia(s) passaram na verificação estatística e a execução real está habilitada.`
            : 'Nenhuma estratégia passou na verificação estatística. O sistema está travado — e essa trava é intencional.'}
        </p>

        <div className="semaforo-detalhe">
          <div>
            <span>Estratégias liberadas para dinheiro real</span>
            <strong>{habilitadasReal} de 6</strong>
          </div>
          <div>
            <span>Estratégias com evidência aprovada</span>
            <strong>{aprovadas.length} de {evidencia.length}</strong>
          </div>
        </div>
      </section>

      {/* ============================================ 2. O TESTE */}
      <section className="bloco">
        <h2>Como está indo o teste</h2>
        <p className="intro">
          O sistema vem gerando sinais e registrando o que teria acontecido, sem
          dinheiro envolvido. Cada operação é medida em <strong>R</strong> — a
          unidade que você arriscou. Perder 1 R é perder exatamente o que estava
          disposto a perder naquela operação.
        </p>

        <div className="cartoes">
          <div className="cartao">
            <span className="cartao-rotulo">Operações registradas</span>
            <span className="cartao-numero">{totalOperacoes}</span>
            <span className="cartao-frase">
              desde que o teste começou
            </span>
          </div>

          <div className="cartao">
            <span className="cartao-rotulo">Resultado acumulado</span>
            <span className={`cartao-numero ${somaTotal < 0 ? 'ruim' : 'bom'}`}>
              {somaTotal >= 0 ? '+' : ''}
              {n(somaTotal)} R
            </span>
            <span className="cartao-frase">
              {somaTotal < 0
                ? `arriscando 1% por operação, isso seria cerca de ${Math.abs(somaTotal).toFixed(0)}% da conta`
                : 'em terreno positivo'}
            </span>
          </div>

          <div className="cartao">
            <span className="cartao-rotulo">Por operação</span>
            <span
              className={`cartao-numero ${
                Number(decomposicao?.expectativa_real_r ?? 0) < 0 ? 'ruim' : 'bom'
              }`}
            >
              {n(decomposicao?.expectativa_real_r, 3)} R
            </span>
            <span className="cartao-frase">
              o que sobra, em média, ao fim de cada operação
            </span>
          </div>
        </div>

        {comAmostra.length > 0 && (
          <>
            <h3>Cada estratégia, com amostra suficiente para julgar</h3>
            <div className="lista">
              {comAmostra.map((linha) => {
                const t = Number(linha.t_observado ?? 0);
                const piso = Number(linha.piso_ruido ?? 0);
                const ruim = linha.veredito.includes('negativo');
                const ruido = linha.veredito.includes('ruído');

                return (
                  <div
                    className="item"
                    key={`${linha.estrategia}-${linha.timeframe}`}
                  >
                    <div className="item-topo">
                      <span className="item-nome">
                        {linha.estrategia}
                        <span className="item-tf">{linha.timeframe}</span>
                      </span>
                      <span className={`item-r ${ruim ? 'ruim' : ''}`}>
                        {Number(linha.soma_r ?? 0) >= 0 ? '+' : ''}
                        {n(linha.soma_r)} R
                      </span>
                    </div>

                    <p className="item-traducao">
                      {ruim
                        ? `Em ${linha.operacoes} operações, perdeu de forma consistente. ` +
                          `Não é falta de sorte: o resultado é forte o bastante para ` +
                          `esperar que se repita.`
                        : ruido
                          ? `Em ${linha.operacoes} operações, o resultado não se distingue ` +
                            `do acaso. Testamos ${linha.combinacoes_no_experimento} combinações, ` +
                            `e com esse tanto de tentativas a sorte sozinha produziria algo assim.`
                          : `${linha.operacoes} operações registradas. Ainda sem conclusão.`}
                    </p>

                    <div className="barra-fundo">
                      <div
                        className="barra-piso"
                        style={{ left: `${Math.min(95, (piso / 4) * 100)}%` }}
                      />
                      <div
                        className={`barra-valor ${ruim ? 'ruim' : 'neutro'}`}
                        style={{
                          width: `${Math.min(50, (Math.abs(t) / 4) * 50)}%`,
                          [t >= 0 ? 'left' : 'right']: '50%',
                        }}
                      />
                      <div className="barra-zero" />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="rodape-nota">
              A linha pontilhada marca o nível que um resultado precisa cruzar
              para ser levado a sério. Ela existe porque testar muitas
              combinações e escolher a melhor produz vencedores por acaso — e
              quanto mais combinações, mais alto o nível.
            </p>
          </>
        )}
      </section>

      {/* ============================================ 3. O PORQUÊ */}
      {decomposicao && (
        <section className="bloco">
          <h2>Por que está perdendo</h2>
          <p className="intro">
            Existem só duas causas possíveis, e elas se resolvem de formas
            opostas. Confundir uma com a outra custa meses.
          </p>

          <div className="causas">
            <div className="causa">
              <span className="causa-titulo">1. A entrada não acerta</span>
              <span
                className={`causa-numero ${
                  Number(decomposicao.expectativa_sem_friccao_r ?? 0) < 0 ? 'ruim' : 'bom'
                }`}
              >
                {n(decomposicao.expectativa_sem_friccao_r, 3)} R
              </span>
              <p>
                É o que sobraria se a corretora não cobrasse nada. Como está
                negativo, o problema começa na decisão de entrar — o sistema
                acerta a direção em apenas{' '}
                <strong>{pct(decomposicao.taxa_acerto)}</strong> das vezes, e
                precisaria de mais para empatar.
              </p>
            </div>

            <div className="causa">
              <span className="causa-titulo">2. O custo de operar</span>
              <span className="causa-numero ruim">
                {n(decomposicao.custo_friccao_r, 3)} R
              </span>
              <p>
                Taxas e diferença de preço na execução. É o pedágio que se paga
                para abrir e fechar, independentemente do que o mercado faça.
              </p>
            </div>
          </div>

          <p className="conclusao">{decomposicao.problema_principal}</p>

          <div className="numeros-simples">
            <div>
              <span>Acerta</span>
              <strong>{pct(decomposicao.taxa_acerto)}</strong>
              <em>das operações</em>
            </div>
            <div>
              <span>Precisaria acertar</span>
              <strong>
                {n(
                  (Math.abs(Number(decomposicao.perda_media_r ?? 0)) /
                    (Math.abs(Number(decomposicao.ganho_medio_r ?? 0)) +
                      Math.abs(Number(decomposicao.perda_media_r ?? 1)))) *
                    100,
                  1,
                )}
                %
              </strong>
              <em>só para empatar</em>
            </div>
            <div>
              <span>Quando ganha</span>
              <strong>+{n(decomposicao.ganho_medio_r)} R</strong>
              <em>em média</em>
            </div>
            <div>
              <span>Quando perde</span>
              <strong className="ruim">
                −{n(Math.abs(Number(decomposicao.perda_media_r ?? 0)))} R
              </strong>
              <em>em média</em>
            </div>
          </div>
        </section>
      )}

      {/* ============================================ 4. O PEDÁGIO */}
      {faixas.length > 0 && (
        <section className="bloco">
          <h2>A conta que decide quase tudo</h2>
          <p className="intro">
            As taxas são cobradas sobre o <strong>valor negociado</strong>, mas o
            resultado é medido sobre o <strong>risco assumido</strong>. Quando o
            stop fica perto do preço de entrada, o risco é pequeno e a mesma taxa
            vira uma fatia enorme do resultado possível.
          </p>

          <div className="faixas">
            {faixas.map((f) => {
              const imposto = Number(f.imposto_pct_de_cada_r ?? 0);
              return (
                <div className={`faixa sev-${f.severidade}`} key={f.faixa}>
                  <div className="faixa-topo">
                    <span className="faixa-nome">
                      {f.faixa.replace(/^\d\.\s*/, '')}
                    </span>
                    <span className="faixa-n">{f.operacoes} op.</span>
                  </div>

                  <div className="faixa-medidor">
                    <div
                      className="faixa-preenchimento"
                      style={{ width: `${Math.min(100, imposto)}%` }}
                    />
                  </div>

                  <p className="faixa-frase">
                    A corretora fica com <strong>{n(imposto, 1)}%</strong> de cada
                    unidade de risco. Resultado médio:{' '}
                    <strong className={Number(f.resultado_medio_r) < 0 ? 'ruim' : 'bom'}>
                      {n(f.resultado_medio_r, 3)} R
                    </strong>
                  </p>
                </div>
              );
            })}
          </div>

          <p className="rodape-nota">
            Quanto mais apertado o risco, maior a fatia que vai para a corretora
            e pior o resultado — sem exceção em nenhuma faixa. Operações de risco
            muito curto nascem perdidas antes de o mercado se mexer.
          </p>
        </section>
      )}

      {/* ============================================ 5. FUNDING */}
      {funding.length > 0 && (
        <section className="bloco">
          <h2>Existe alguma oportunidade real aberta?</h2>
          <p className="intro">
            Esta é a única parte do sistema que não tenta adivinhar para onde o
            preço vai. Ela captura um pagamento que existe entre quem está
            comprado e quem está vendido em contratos perpétuos. Vale a pena
            quando esse pagamento supera o custo de montar a operação.
          </p>

          <div className={`funding-estado ${fundingElegivel.length > 0 ? 'aberta' : 'fechada'}`}>
            <span className="funding-titulo">
              {fundingElegivel.length > 0
                ? `${fundingElegivel.length} oportunidade(s) dentro do critério`
                : 'Nenhuma oportunidade dentro do critério agora'}
            </span>
            {melhorFunding && (
              <span className="funding-detalhe">
                O melhor caso hoje é {melhorFunding.simbolo}, pagando{' '}
                {n(melhorFunding.funding_anualizado_pct)}% ao ano. Depois de
                descontar os custos, sobrariam{' '}
                {n(melhorFunding.carry_liquido_anualizado_pct)}% ao ano — ainda
                pouco para justificar o risco de execução.
              </span>
            )}
          </div>

          <div className="funding-lista">
            {funding.map((f) => (
              <div className="funding-item" key={f.simbolo}>
                <span className="funding-simbolo">{f.simbolo}</span>
                <span className="funding-bruto">
                  {n(f.funding_anualizado_pct)}% bruto
                </span>
                <span
                  className={`funding-liquido ${
                    Number(f.carry_liquido_anualizado_pct ?? 0) > 0 ? 'bom' : 'ruim'
                  }`}
                >
                  {n(f.carry_liquido_anualizado_pct)}% líquido
                </span>
              </div>
            ))}
          </div>

          <p className="rodape-nota">
            Este módulo custa quase nada para manter rodando e avisa quando a
            janela abrir. Historicamente isso acontece em períodos de euforia,
            algumas vezes por ano.
          </p>
        </section>
      )}

      <footer className="pe">
        <p>
          Painel de acompanhamento de um sistema em teste. Não é recomendação de
          investimento.
        </p>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

const estilos = `
.painel {
  --tinta: #0D1014;
  --superficie: #151A21;
  --superficie-alta: #1C232C;
  --traco: #29323D;
  --texto: #E3E8EF;
  --texto-suave: #8794A5;
  --texto-fraco: #5A6675;
  --ruim: #B85C50;
  --atencao: #B08843;
  --bom: #4B9478;

  background: var(--tinta);
  color: var(--texto);
  min-height: 100vh;
  padding: 2.5rem 1.25rem 5rem;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-feature-settings: "tnum" 1;
  line-height: 1.6;
}

.painel .cartao-numero,
.painel .causa-numero,
.painel .semaforo-resposta,
.painel .item-r,
.painel .numeros-simples strong,
.painel .funding-bruto,
.painel .funding-liquido,
.painel .faixa-n {
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}

.ruim { color: var(--ruim); }
.bom  { color: var(--bom); }

.aviso {
  max-width: 44rem; margin: 4rem auto;
  padding: 1.25rem; border: 1px solid var(--traco);
  border-left: 2px solid var(--atencao);
  background: var(--superficie); color: var(--texto-suave);
  font-size: 0.9rem;
}
.aviso code { font-family: ui-monospace, monospace; color: var(--texto); }

/* ---------- semáforo ---------- */
.semaforo {
  max-width: 44rem; margin: 0 auto 3.5rem;
  padding: 2.25rem 1.75rem;
  border: 1px solid var(--traco);
  background: var(--superficie);
  text-align: center;
}
.semaforo.travado  { border-top: 3px solid var(--ruim); }
.semaforo.liberado { border-top: 3px solid var(--bom); }

.semaforo-pergunta {
  font-size: 0.82rem; letter-spacing: 0.06em;
  color: var(--texto-fraco); margin: 0 0 1rem;
  text-transform: uppercase;
}
.semaforo-resposta {
  font-size: clamp(3rem, 14vw, 4.5rem);
  line-height: 1; font-weight: 300; letter-spacing: -0.04em;
  margin: 0 0 1.25rem;
}
.semaforo.travado  .semaforo-resposta { color: var(--ruim); }
.semaforo.liberado .semaforo-resposta { color: var(--bom); }

.semaforo-motivo {
  color: var(--texto-suave); font-size: 0.9rem;
  max-width: 28rem; margin: 0 auto 2rem;
}

.semaforo-detalhe {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 1px; background: var(--traco);
  border: 1px solid var(--traco); text-align: left;
}
.semaforo-detalhe > div {
  background: var(--tinta); padding: 0.9rem 1rem;
  display: flex; flex-direction: column; gap: 0.3rem;
}
.semaforo-detalhe span {
  font-size: 0.7rem; color: var(--texto-fraco);
  text-transform: uppercase; letter-spacing: 0.08em;
}
.semaforo-detalhe strong {
  font-family: ui-monospace, monospace; font-size: 1.1rem; font-weight: 400;
}

/* ---------- blocos ---------- */
.bloco { max-width: 44rem; margin: 0 auto 3.5rem; }
.bloco h2 {
  font-size: 1.15rem; font-weight: 500; letter-spacing: -0.01em;
  margin: 0 0 0.75rem;
}
.bloco h3 {
  font-size: 0.82rem; font-weight: 500; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--texto-fraco);
  margin: 2.5rem 0 1rem;
}
.intro {
  color: var(--texto-suave); font-size: 0.88rem;
  margin: 0 0 1.75rem;
}
.intro strong { color: var(--texto); font-weight: 500; }

/* ---------- cartões ---------- */
.cartoes {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 1px; background: var(--traco); border: 1px solid var(--traco);
}
.cartao {
  background: var(--superficie); padding: 1.25rem 1.1rem;
  display: flex; flex-direction: column; gap: 0.55rem;
}
.cartao-rotulo {
  font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.1em;
  color: var(--texto-fraco);
}
.cartao-numero {
  font-size: 1.7rem; font-weight: 300; letter-spacing: -0.02em; line-height: 1;
}
.cartao-frase {
  font-size: 0.75rem; color: var(--texto-suave); line-height: 1.45;
}

/* ---------- lista de estratégias ---------- */
.lista { display: flex; flex-direction: column; gap: 1px;
  background: var(--traco); border: 1px solid var(--traco); }
.item { background: var(--superficie); padding: 1.15rem 1.1rem; }
.item-topo {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 1rem; margin-bottom: 0.5rem;
}
.item-nome { font-size: 0.9rem; display: flex; align-items: baseline; gap: 0.5rem; }
.item-tf {
  font-family: ui-monospace, monospace; font-size: 0.68rem;
  color: var(--texto-fraco); letter-spacing: 0.06em;
}
.item-r { font-size: 1rem; }
.item-traducao {
  font-size: 0.8rem; color: var(--texto-suave); margin: 0 0 0.9rem;
}

.barra-fundo {
  position: relative; height: 0.5rem;
  background: rgba(255,255,255,0.025);
}
.barra-zero {
  position: absolute; left: 50%; top: -0.15rem; bottom: -0.15rem;
  width: 1px; background: var(--traco);
}
.barra-piso {
  position: absolute; top: -0.2rem; bottom: -0.2rem; width: 1px;
  background: repeating-linear-gradient(
    to bottom, var(--texto-fraco) 0 3px, transparent 3px 6px);
}
.barra-valor { position: absolute; top: 0; bottom: 0; min-width: 2px; }
.barra-valor.ruim   { background: var(--ruim); }
.barra-valor.neutro { background: var(--texto-fraco); }

.rodape-nota {
  font-size: 0.78rem; color: var(--texto-fraco);
  margin: 1.25rem 0 0;
}

/* ---------- causas ---------- */
.causas {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1px; background: var(--traco); border: 1px solid var(--traco);
}
.causa {
  background: var(--superficie); padding: 1.4rem 1.2rem;
  display: flex; flex-direction: column; gap: 0.7rem;
}
.causa-titulo {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--texto-fraco);
}
.causa-numero { font-size: 1.8rem; font-weight: 300; letter-spacing: -0.02em; }
.causa p { font-size: 0.8rem; color: var(--texto-suave); margin: 0; }
.causa strong { color: var(--texto); }

.conclusao {
  margin: 1.5rem 0 2rem; padding: 1rem 1.15rem;
  border-left: 2px solid var(--atencao); background: var(--superficie);
  color: var(--texto-suave); font-size: 0.85rem;
}

.numeros-simples {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: 1px; background: var(--traco); border: 1px solid var(--traco);
}
.numeros-simples > div {
  background: var(--tinta); padding: 0.95rem 1rem;
  display: flex; flex-direction: column; gap: 0.25rem;
}
.numeros-simples span {
  font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.09em;
  color: var(--texto-fraco);
}
.numeros-simples strong { font-size: 1.15rem; font-weight: 400; }
.numeros-simples em {
  font-size: 0.7rem; color: var(--texto-suave); font-style: normal;
}

/* ---------- faixas de risco ---------- */
.faixas { display: flex; flex-direction: column; gap: 1px;
  background: var(--traco); border: 1px solid var(--traco); }
.faixa { background: var(--superficie); padding: 1.05rem 1.1rem; }
.faixa-topo {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 0.6rem;
}
.faixa-nome { font-size: 0.85rem; }
.faixa-n { font-size: 0.72rem; color: var(--texto-fraco); }

.faixa-medidor {
  height: 0.4rem; background: rgba(255,255,255,0.03);
  margin-bottom: 0.65rem;
}
.faixa-preenchimento { height: 100%; }
.sev-proibitivo .faixa-preenchimento { background: var(--ruim); }
.sev-alto       .faixa-preenchimento { background: var(--atencao); }
.sev-aceitavel  .faixa-preenchimento { background: var(--bom); }

.faixa-frase { font-size: 0.78rem; color: var(--texto-suave); margin: 0; }
.faixa-frase strong { font-family: ui-monospace, monospace; font-weight: 400; }

/* ---------- funding ---------- */
.funding-estado {
  padding: 1.15rem 1.2rem; border: 1px solid var(--traco);
  background: var(--superficie); margin-bottom: 1.25rem;
  display: flex; flex-direction: column; gap: 0.55rem;
}
.funding-estado.fechada { border-left: 2px solid var(--texto-fraco); }
.funding-estado.aberta  { border-left: 2px solid var(--bom); }
.funding-titulo { font-size: 0.92rem; }
.funding-detalhe { font-size: 0.8rem; color: var(--texto-suave); }

.funding-lista { display: flex; flex-direction: column; gap: 1px;
  background: var(--traco); border: 1px solid var(--traco); }
.funding-item {
  background: var(--tinta); padding: 0.75rem 1rem;
  display: grid; grid-template-columns: 1fr auto auto; gap: 1rem;
  align-items: baseline;
}
.funding-simbolo { font-size: 0.82rem; }
.funding-bruto { font-size: 0.78rem; color: var(--texto-fraco); }
.funding-liquido { font-size: 0.82rem; }

.pe {
  max-width: 44rem; margin: 0 auto; padding-top: 2rem;
  border-top: 1px solid var(--traco);
}
.pe p { font-size: 0.75rem; color: var(--texto-fraco); margin: 0; }

@media (max-width: 560px) {
  .painel { padding: 1.75rem 1rem 3.5rem; }
  .cartao-numero { font-size: 1.4rem; }
  .causa-numero { font-size: 1.5rem; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
