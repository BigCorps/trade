/**
 * app/validacao/page.tsx — VigIA Trade
 * ---------------------------------------------------------------------------
 * Painel de evidência.
 *
 * A diferença em relação a um painel de trading comum é deliberada: aqui não
 * existe ranking de lucro. Uma tabela ordenada por "quem ganhou mais" é
 * exatamente o instrumento que produz falsos positivos — o olho vai ao topo
 * e o topo é onde o acaso se acumula.
 *
 * O elemento central é a LINHA DE RUÍDO: a régua que mostra o t que o acaso
 * produziria como melhor resultado, dado quantas combinações foram testadas.
 * Barras que não cruzam essa linha não são notícia, por maior que seja o R.
 */

import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface EvidenceRow {
  estrategia: string;
  timeframe: string;
  operacoes: number;
  soma_r: number | null;
  media_r: number | null;
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

interface DecompositionRow {
  operacoes: number;
  taxa_acerto: number | null;
  rr_planejado: number | null;
  ganho_medio_r: number | null;
  perda_media_r: number | null;
  expectativa_real_r: number | null;
  expectativa_sem_friccao_r: number | null;
  custo_friccao_r: number | null;
  stop_pct_preco: number | null;
  problema_principal: string | null;
}

// ---------------------------------------------------------------------------
// Dados
// ---------------------------------------------------------------------------

async function carregarDados() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return { evidencia: [], decomposicao: null, erro: 'credenciais_ausentes' };
  }

  const supabase = createClient(url, key);

  const [evidencia, decomposicao] = await Promise.all([
    supabase.from('vw_forward_test_evidencia').select('*'),
    supabase.from('vw_decomposicao_edge').select('*').maybeSingle(),
  ]);

  return {
    evidencia: (evidencia.data ?? []) as EvidenceRow[],
    decomposicao: (decomposicao.data ?? null) as DecompositionRow | null,
    erro: evidencia.error?.message ?? null,
  };
}

// ---------------------------------------------------------------------------
// Vereditos
// ---------------------------------------------------------------------------

type Tom = 'neutro' | 'alerta' | 'falha' | 'aprovado';

function tomDoVeredito(veredito: string): Tom {
  if (veredito.includes('negativo')) return 'falha';
  if (veredito.includes('sobrevive')) return 'aprovado';
  if (veredito.includes('insuficiente')) return 'neutro';
  return 'alerta';
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

export default async function ValidacaoPage() {
  const { evidencia, decomposicao, erro } = await carregarDados();

  const totalOperacoes = evidencia.reduce((s, r) => s + (r.operacoes ?? 0), 0);
  const somaTotal = evidencia.reduce((s, r) => s + Number(r.soma_r ?? 0), 0);
  const aprovadas = evidencia.filter((r) => r.veredito.includes('sobrevive')).length;
  const pisoRuido = evidencia[0]?.piso_ruido ?? null;

  const escalaT = Math.max(
    4,
    ...evidencia.map((r) => Math.abs(Number(r.t_observado ?? 0)) + 0.5),
    Number(pisoRuido ?? 0) + 0.5,
  );

  return (
    <main className="validacao">
      <style>{estilos}</style>

      <header className="cabecalho">
        <p className="sobrancelha">Painel de evidência</p>
        <h1>
          O resultado é real
          <br />
          ou foi o acaso?
        </h1>
        <p className="subtitulo">
          Toda combinação testada aparece aqui, inclusive as ruins. Ocultar as
          que falharam é o que faz uma estratégia parecer melhor do que é.
        </p>
      </header>

      {erro === 'credenciais_ausentes' && (
        <div className="aviso">
          Defina <code>NEXT_PUBLIC_SUPABASE_URL</code> e{' '}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> para carregar os dados.
        </div>
      )}

      {erro && erro !== 'credenciais_ausentes' && (
        <div className="aviso">
          Não foi possível ler as visões. Aplique a migração{' '}
          <code>20260807120000_disciplina_estatistica_pesquisa.sql</code> antes
          de abrir esta página. Detalhe: {erro}
        </div>
      )}

      {/* -------------------------------------------------- resumo */}
      <section className="resumo">
        <div className="metrica">
          <span className="rotulo">Operações avaliadas</span>
          <span className="valor">{totalOperacoes}</span>
        </div>
        <div className="metrica">
          <span className="rotulo">Resultado acumulado</span>
          <span className={`valor ${somaTotal < 0 ? 'negativo' : 'positivo'}`}>
            {somaTotal >= 0 ? '+' : ''}
            {somaTotal.toFixed(2)} R
          </span>
        </div>
        <div className="metrica">
          <span className="rotulo">Combinações aprovadas</span>
          <span className={`valor ${aprovadas === 0 ? 'neutro' : 'positivo'}`}>
            {aprovadas} de {evidencia.length}
          </span>
        </div>
        <div className="metrica">
          <span className="rotulo">Piso de ruído</span>
          <span className="valor">
            t = {pisoRuido !== null ? Number(pisoRuido).toFixed(2) : '—'}
          </span>
        </div>
      </section>

      {/* ------------------------------------------ elemento central */}
      <section className="grafico">
        <div className="grafico-topo">
          <h2>Cada estratégia contra a linha de ruído</h2>
          <p>
            A linha marca o t que o acaso produziria como melhor resultado entre{' '}
            {evidencia[0]?.combinacoes_no_experimento ?? '—'} combinações. Quem
            não a cruza não tem evidência, independentemente do R acumulado.
          </p>
        </div>

        <div className="plot">
          {evidencia.length === 0 && (
            <p className="vazio">
              Nenhuma operação encerrada ainda. O painel se preenche conforme o
              teste prospectivo avança.
            </p>
          )}

          {evidencia.map((linha) => {
            const t = Number(linha.t_observado ?? 0);
            const largura = (Math.abs(t) / escalaT) * 50;
            const tom = tomDoVeredito(linha.veredito);

            return (
              <div className="barra-linha" key={`${linha.estrategia}-${linha.timeframe}`}>
                <div className="barra-id">
                  <span className="barra-nome">{linha.estrategia}</span>
                  <span className="barra-tf">{linha.timeframe}</span>
                </div>

                <div className="barra-canvas">
                  <div className="eixo-zero" />
                  <div
                    className="linha-ruido"
                    style={{
                      left: `${50 + (Number(pisoRuido ?? 0) / escalaT) * 50}%`,
                    }}
                    title={`Piso de ruído: t = ${Number(pisoRuido ?? 0).toFixed(2)}`}
                  />
                  <div
                    className="linha-ruido negativa"
                    style={{
                      left: `${50 - (Number(pisoRuido ?? 0) / escalaT) * 50}%`,
                    }}
                  />
                  <div
                    className={`barra tom-${tom}`}
                    style={{
                      width: `${largura}%`,
                      [t >= 0 ? 'left' : 'right']: '50%',
                    }}
                  />
                </div>

                <div className="barra-dados">
                  <span className="t-valor">
                    {t >= 0 ? '+' : ''}
                    {t.toFixed(2)}
                  </span>
                  <span className="n-valor">n={linha.operacoes}</span>
                </div>
              </div>
            );
          })}
        </div>

        {evidencia.length > 0 && (
          <p className="legenda">
            <span className="chave zona-ruido" /> zona de ruído
            <span className="chave tom-falha" /> perda consistente
            <span className="chave tom-alerta" /> sem confirmação
            <span className="chave tom-aprovado" /> evidência válida
          </p>
        )}
      </section>

      {/* --------------------------------------------- decomposição */}
      {decomposicao && (
        <section className="decomposicao">
          <h2>De onde vem o resultado</h2>
          <p className="explicacao">
            Prejuízo por entrada ruim e prejuízo por custo exigem correções
            diferentes. Separá-los evita meses ajustando a coisa errada.
          </p>

          <div className="colunas">
            <div className="coluna">
              <span className="col-rotulo">Se a execução fosse perfeita</span>
              <span
                className={`col-valor ${
                  Number(decomposicao.expectativa_sem_friccao_r ?? 0) < 0
                    ? 'negativo'
                    : 'positivo'
                }`}
              >
                {Number(decomposicao.expectativa_sem_friccao_r ?? 0).toFixed(3)} R
              </span>
              <span className="col-nota">
                Qualidade da entrada, isolada de custos
              </span>
            </div>

            <div className="coluna">
              <span className="col-rotulo">Custo de fricção</span>
              <span className="col-valor negativo">
                {Number(decomposicao.custo_friccao_r ?? 0).toFixed(3)} R
              </span>
              <span className="col-nota">
                Taxas, slippage e gaps por operação
              </span>
            </div>

            <div className="coluna destaque">
              <span className="col-rotulo">Resultado real</span>
              <span
                className={`col-valor ${
                  Number(decomposicao.expectativa_real_r ?? 0) < 0
                    ? 'negativo'
                    : 'positivo'
                }`}
              >
                {Number(decomposicao.expectativa_real_r ?? 0).toFixed(3)} R
              </span>
              <span className="col-nota">Por operação</span>
            </div>
          </div>

          <p className="diagnostico">{decomposicao.problema_principal}</p>

          <div className="detalhes">
            <div>
              <span>Acerto atual</span>
              <strong>
                {((decomposicao.taxa_acerto ?? 0) * 100).toFixed(1)}%
              </strong>
            </div>
            <div>
              <span>Acerto para empatar</span>
              <strong>
                {(
                  (Math.abs(Number(decomposicao.perda_media_r ?? 0)) /
                    (Math.abs(Number(decomposicao.ganho_medio_r ?? 0)) +
                      Math.abs(Number(decomposicao.perda_media_r ?? 1)))) *
                  100
                ).toFixed(1)}
                %
              </strong>
            </div>
            <div>
              <span>Stop custa</span>
              <strong>
                {Math.abs(Number(decomposicao.perda_media_r ?? 0)).toFixed(3)} R
              </strong>
            </div>
            <div>
              <span>Stop em % do preço</span>
              <strong>
                {Number(decomposicao.stop_pct_preco ?? 0).toFixed(2)}%
              </strong>
            </div>
          </div>
        </section>
      )}

      {/* -------------------------------------------------- detalhe */}
      {evidencia.length > 0 && (
        <section className="tabela-secao">
          <h2>Todas as combinações</h2>
          <div className="tabela-rolagem">
            <table>
              <thead>
                <tr>
                  <th>Estratégia</th>
                  <th>TF</th>
                  <th className="num">n</th>
                  <th className="num">Soma R</th>
                  <th className="num">Acerto</th>
                  <th className="num">Empate</th>
                  <th className="num">MFE perdedoras</th>
                  <th>Veredito</th>
                </tr>
              </thead>
              <tbody>
                {evidencia.map((l) => (
                  <tr key={`${l.estrategia}-${l.timeframe}-linha`}>
                    <td className="mono">{l.estrategia}</td>
                    <td className="mono">{l.timeframe}</td>
                    <td className="num mono">{l.operacoes}</td>
                    <td
                      className={`num mono ${
                        Number(l.soma_r ?? 0) < 0 ? 'negativo' : 'positivo'
                      }`}
                    >
                      {Number(l.soma_r ?? 0) >= 0 ? '+' : ''}
                      {Number(l.soma_r ?? 0).toFixed(2)}
                    </td>
                    <td className="num mono">
                      {l.acerto_pct !== null ? `${l.acerto_pct}%` : '—'}
                    </td>
                    <td className="num mono">
                      {l.acerto_equilibrio_pct !== null
                        ? `${l.acerto_equilibrio_pct}%`
                        : '—'}
                    </td>
                    <td className="num mono" title={l.diagnostico_entrada ?? ''}>
                      {l.mfe_perdedoras_r !== null
                        ? `${Number(l.mfe_perdedoras_r).toFixed(2)} R`
                        : '—'}
                    </td>
                    <td>
                      <span className={`selo tom-${tomDoVeredito(l.veredito)}`}>
                        {rotuloCurto[l.veredito] ?? l.veredito}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="nota-rodape">
            <strong>MFE perdedoras</strong> mede quanto as operações que
            terminaram no stop chegaram a andar a favor. Abaixo de 0,80 R, elas
            vão direto ao stop — e nesse caso mudar trailing, breakeven ou
            parcial não altera o resultado, porque não há excursão a capturar.
          </p>
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Estilos
// ---------------------------------------------------------------------------

const estilos = `
.validacao {
  --tinta: #0D1014;
  --superficie: #151A21;
  --superficie-alta: #1C232C;
  --traco: #29323D;
  --texto: #E3E8EF;
  --texto-suave: #8794A5;
  --texto-fraco: #5A6675;
  --ruido: #4A5563;
  --falha: #B85C50;
  --alerta: #B08843;
  --aprovado: #4B9478;

  background: var(--tinta);
  color: var(--texto);
  min-height: 100vh;
  padding: 3rem 1.5rem 6rem;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-feature-settings: "tnum" 1;
}

.validacao .mono,
.validacao .num,
.validacao .valor,
.validacao .col-valor,
.validacao .t-valor,
.validacao .n-valor,
.validacao table {
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
}

.cabecalho { max-width: 62rem; margin: 0 auto 3.5rem; }

.sobrancelha {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--texto-fraco);
  margin: 0 0 1.25rem;
}

.cabecalho h1 {
  font-size: clamp(2rem, 6vw, 3.4rem);
  line-height: 1.04;
  letter-spacing: -0.03em;
  font-weight: 300;
  margin: 0 0 1.5rem;
}

.subtitulo {
  color: var(--texto-suave);
  max-width: 34rem;
  line-height: 1.65;
  font-size: 0.95rem;
  margin: 0;
}

.aviso {
  max-width: 62rem;
  margin: 0 auto 2.5rem;
  padding: 1rem 1.25rem;
  border: 1px solid var(--traco);
  border-left: 2px solid var(--alerta);
  background: var(--superficie);
  color: var(--texto-suave);
  font-size: 0.85rem;
  line-height: 1.6;
}
.aviso code {
  font-family: ui-monospace, monospace;
  color: var(--texto);
  font-size: 0.8rem;
}

/* ---------- resumo ---------- */
.resumo {
  max-width: 62rem;
  margin: 0 auto 4rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  border-top: 1px solid var(--traco);
  border-left: 1px solid var(--traco);
}
.metrica {
  padding: 1.4rem 1.25rem;
  border-right: 1px solid var(--traco);
  border-bottom: 1px solid var(--traco);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.rotulo {
  font-size: 0.68rem;
  letter-spacing: 0.13em;
  text-transform: uppercase;
  color: var(--texto-fraco);
}
.valor { font-size: 1.6rem; font-weight: 300; letter-spacing: -0.02em; }
.valor.negativo, .negativo { color: var(--falha); }
.valor.positivo, .positivo { color: var(--aprovado); }
.valor.neutro { color: var(--texto-suave); }

/* ---------- gráfico ---------- */
.grafico { max-width: 62rem; margin: 0 auto 4.5rem; }
.grafico-topo { margin-bottom: 2.25rem; }
.grafico h2, .decomposicao h2, .tabela-secao h2 {
  font-size: 1.05rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  margin: 0 0 0.6rem;
}
.grafico-topo p {
  color: var(--texto-suave);
  font-size: 0.85rem;
  line-height: 1.6;
  max-width: 40rem;
  margin: 0;
}

.plot {
  border: 1px solid var(--traco);
  background: var(--superficie);
  padding: 1.5rem 1.25rem;
}
.vazio { color: var(--texto-fraco); font-size: 0.85rem; margin: 0; }

.barra-linha {
  display: grid;
  grid-template-columns: 11rem 1fr 5.5rem;
  align-items: center;
  gap: 1rem;
  padding: 0.55rem 0;
}
.barra-id { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.barra-nome {
  font-size: 0.78rem;
  color: var(--texto);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.barra-tf {
  font-family: ui-monospace, monospace;
  font-size: 0.65rem;
  color: var(--texto-fraco);
  letter-spacing: 0.08em;
}

.barra-canvas {
  position: relative;
  height: 1.6rem;
  background: rgba(255,255,255,0.015);
}
.eixo-zero {
  position: absolute; left: 50%; top: 0; bottom: 0;
  width: 1px; background: var(--traco);
}
.linha-ruido {
  position: absolute; top: -0.15rem; bottom: -0.15rem;
  width: 1px;
  background: repeating-linear-gradient(
    to bottom, var(--ruido) 0 3px, transparent 3px 6px
  );
}
.barra {
  position: absolute; top: 0.35rem; bottom: 0.35rem;
  min-width: 2px;
}
.barra.tom-falha    { background: var(--falha); }
.barra.tom-alerta   { background: var(--alerta); }
.barra.tom-aprovado { background: var(--aprovado); }
.barra.tom-neutro   { background: var(--ruido); }

.barra-dados {
  display: flex; flex-direction: column; align-items: flex-end; gap: 0.15rem;
}
.t-valor { font-size: 0.85rem; }
.n-valor { font-size: 0.65rem; color: var(--texto-fraco); }

.legenda {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1.25rem;
  margin: 1.5rem 0 0;
  font-size: 0.7rem;
  color: var(--texto-fraco);
  letter-spacing: 0.04em;
}
.chave {
  display: inline-block; width: 1.5rem; height: 2px;
  margin-right: 0.4rem; vertical-align: middle;
}
.chave.tom-falha    { background: var(--falha); }
.chave.tom-alerta   { background: var(--alerta); }
.chave.tom-aprovado { background: var(--aprovado); }
.chave.zona-ruido   {
  background: repeating-linear-gradient(
    to right, var(--ruido) 0 3px, transparent 3px 6px
  );
}

/* ---------- decomposição ---------- */
.decomposicao { max-width: 62rem; margin: 0 auto 4.5rem; }
.explicacao {
  color: var(--texto-suave);
  font-size: 0.85rem;
  line-height: 1.6;
  max-width: 40rem;
  margin: 0 0 2rem;
}
.colunas {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  border: 1px solid var(--traco);
}
.coluna {
  padding: 1.5rem 1.35rem;
  border-right: 1px solid var(--traco);
  display: flex; flex-direction: column; gap: 0.7rem;
  background: var(--superficie);
}
.coluna:last-child { border-right: none; }
.coluna.destaque { background: var(--superficie-alta); }
.col-rotulo {
  font-size: 0.68rem; letter-spacing: 0.13em;
  text-transform: uppercase; color: var(--texto-fraco);
}
.col-valor { font-size: 1.75rem; font-weight: 300; letter-spacing: -0.02em; }
.col-nota { font-size: 0.72rem; color: var(--texto-suave); line-height: 1.5; }

.diagnostico {
  margin: 1.5rem 0 2rem;
  padding: 1rem 1.25rem;
  border-left: 2px solid var(--alerta);
  background: var(--superficie);
  color: var(--texto-suave);
  font-size: 0.85rem;
  line-height: 1.6;
}

.detalhes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1px;
  background: var(--traco);
  border: 1px solid var(--traco);
}
.detalhes > div {
  background: var(--tinta);
  padding: 1rem 1.1rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.detalhes span {
  font-size: 0.68rem; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--texto-fraco);
}
.detalhes strong {
  font-family: ui-monospace, monospace;
  font-size: 1.05rem; font-weight: 400;
}

/* ---------- tabela ---------- */
.tabela-secao { max-width: 62rem; margin: 0 auto; }
.tabela-rolagem { overflow-x: auto; border: 1px solid var(--traco); }
table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
thead th {
  text-align: left;
  padding: 0.85rem 0.9rem;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 0.66rem;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--texto-fraco);
  font-weight: 500;
  background: var(--superficie);
  border-bottom: 1px solid var(--traco);
  white-space: nowrap;
}
tbody td {
  padding: 0.8rem 0.9rem;
  border-bottom: 1px solid var(--traco);
  color: var(--texto-suave);
  white-space: nowrap;
}
tbody tr:last-child td { border-bottom: none; }
.num { text-align: right; }
thead th.num { text-align: right; }

.selo {
  display: inline-block;
  padding: 0.2rem 0.55rem;
  font-size: 0.68rem;
  letter-spacing: 0.03em;
  border: 1px solid currentColor;
}
.selo.tom-falha    { color: var(--falha); }
.selo.tom-alerta   { color: var(--alerta); }
.selo.tom-aprovado { color: var(--aprovado); }
.selo.tom-neutro   { color: var(--texto-fraco); }

.nota-rodape {
  margin: 1.5rem 0 0;
  font-size: 0.78rem;
  line-height: 1.65;
  color: var(--texto-fraco);
  max-width: 42rem;
}
.nota-rodape strong { color: var(--texto-suave); font-weight: 500; }

@media (max-width: 640px) {
  .validacao { padding: 2rem 1rem 4rem; }
  .barra-linha { grid-template-columns: 7rem 1fr 4rem; gap: 0.6rem; }
  .barra-nome { font-size: 0.7rem; }
  .valor { font-size: 1.3rem; }
  .col-valor { font-size: 1.4rem; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}

.validacao a:focus-visible,
.validacao button:focus-visible {
  outline: 2px solid var(--aprovado);
  outline-offset: 2px;
}
`;
