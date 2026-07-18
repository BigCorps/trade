#!/usr/bin/env node

/**
 * Adiciona "Copiar Markdown para outra IA" à página principal do VigIA Trade.
 *
 * Uso, na raiz do repositório:
 *   node apply-main-markdown.mjs
 *
 * O script:
 * - altera somente app/page.tsx;
 * - cria app/page.tsx.before-markdown como backup;
 * - valida marcadores da versão atual antes de escrever;
 * - não altera a rota /api/relatorio nem o Supabase.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const targetPath = resolve(process.cwd(), 'app/page.tsx');
const backupPath = resolve(process.cwd(), 'app/page.tsx.before-markdown');
const expectedGitBlobSha = '5afc0b931fa0e439928bbaf68d917d6e38651eb8';

function gitBlobSha(content) {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest('hex');
}

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);

  if (first < 0) {
    throw new Error(`Não encontrei o trecho esperado: ${label}.`);
  }

  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`O trecho apareceu mais de uma vez: ${label}.`);
  }

  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

if (!existsSync(targetPath)) {
  throw new Error(`Arquivo não encontrado: ${targetPath}`);
}

let page = readFileSync(targetPath, 'utf8');

if (
  page.includes('const copyAnalysisMarkdown = useCallback(async () =>') ||
  page.includes('Copiar Markdown para outra IA')
) {
  console.log('A exportação Markdown já parece estar instalada. Nenhuma alteração foi feita.');
  process.exit(0);
}

const currentSha = gitBlobSha(page);

if (currentSha !== expectedGitBlobSha) {
  console.warn(
    `Aviso: app/page.tsx foi alterado desde a versão usada para preparar este pacote.\n` +
      `SHA atual:    ${currentSha}\n` +
      `SHA esperado: ${expectedGitBlobSha}\n` +
      'O script continuará somente se todos os trechos estruturais ainda coincidirem.',
  );
}

const oldState = `  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);`;

const newState = `  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle');
  const [copyMessage, setCopyMessage] = useState('');`;

page = replaceOnce(
  page,
  oldState,
  newState,
  'estados do relatório',
);

const oldReset = `    setError('');
    setReport('');
    setCurrentAnalysisId(null);`;

const newReset = `    setError('');
    setReport('');
    setCopyStatus('idle');
    setCopyMessage('');
    setCurrentAnalysisId(null);`;

page = replaceOnce(
  page,
  oldReset,
  newReset,
  'limpeza ao iniciar análise',
);

const selectMarker = `  const select = (
    value: string,`;

const copyFunction = String.raw`  const copyAnalysisMarkdown = useCallback(async () => {
    if (!statsA) {
      setCopyStatus('error');
      setCopyMessage('Execute uma análise antes de copiar o Markdown.');
      return;
    }

    const generatedAt = new Date();
    const firstCandleA = dataA[0] ?? null;
    const lastCandleA = dataA[dataA.length - 1] ?? null;
    const firstCandleB = dataB[0] ?? null;
    const lastCandleB = dataB[dataB.length - 1] ?? null;

    const mdNumber = (
      value: number | null | undefined,
      digits = 2,
    ): string =>
      value === null || value === undefined || !Number.isFinite(value)
        ? '—'
        : fmt(value, digits);

    const mdPct = (
      value: number | null | undefined,
      digits = 2,
    ): string =>
      value === null || value === undefined || !Number.isFinite(value)
        ? '—'
        : \`\${value >= 0 ? '+' : ''}\${fmt(value, digits)}%\`;

    const mdDate = (
      value: number | string | null | undefined,
    ): string => {
      if (value === null || value === undefined || value === '') return '—';
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime())
        ? '—'
        : parsed.toLocaleString('pt-BR');
    };

    const cleanCell = (
      value: string | number | null | undefined,
    ): string =>
      String(value ?? '—')
        .replaceAll('|', '\\|')
        .replace(/\r?\n/g, ' ')
        .trim();

    const appendAsset = (
      lines: string[],
      title: string,
      stats: AssetStats,
      candles: Candle[],
      firstCandle: Candle | null,
      lastCandle: Candle | null,
    ) => {
      lines.push(
        '',
        \`## \${title}: \${stats.symbol}\`,
        '',
        \`- **Candles encerrados utilizados:** \${candles.length}\`,
        \`- **Primeiro candle:** \${mdDate(firstCandle?.openTime)}\`,
        \`- **Último candle encerrado:** \${mdDate(lastCandle?.closeTime)}\`,
        '',
        '| Métrica | Valor |',
        '|---|---:|',
        \`| Último fechamento | \${mdNumber(stats.lastPrice, 8)} USDT |\`,
        \`| Retorno no período | \${mdPct(stats.returnPct)} |\`,
        \`| Retorno anualizado histórico | \${mdPct(stats.annualReturnPct)} |\`,
        \`| Drawdown máximo | \${mdPct(stats.maxDrawdownPct)} |\`,
        \`| Drawdown atual | \${mdPct(stats.currentDrawdownPct)} |\`,
        \`| Tempo abaixo de um topo anterior | \${mdNumber(stats.timeInDrawdownPct, 0)}% |\`,
        \`| Volatilidade média anualizada | \${mdNumber(stats.annualVolPct, 2)}% |\`,
        \`| Volatilidade atual anualizada | \${mdNumber(stats.currentVolPct, 2)}% |\`,
        \`| Regime atual | \${stats.regime} |\`,
        \`| Sharpe histórico simplificado | \${mdNumber(stats.sharpe, 4)} |\`,
        \`| Candles positivos | \${mdNumber(stats.pctPositive, 2)}% |\`,
        \`| Melhor \${tf.unitLabel} | \${mdPct(stats.bestUnitPct)} |\`,
        \`| Pior \${tf.unitLabel} | \${mdPct(stats.worstUnitPct)} |\`,
      );

      if (lastCandle) {
        lines.push(
          '',
          '### Último candle encerrado',
          '',
          '| Abertura | Máxima | Mínima | Fechamento | Volume base |',
          '|---:|---:|---:|---:|---:|',
          \`| \${mdNumber(lastCandle.open, 8)} | \${mdNumber(lastCandle.high, 8)} | \${mdNumber(lastCandle.low, 8)} | \${mdNumber(lastCandle.close, 8)} | \${mdNumber(lastCandle.volume, 8)} |\`,
        );
      }
    };

    const lines: string[] = [
      '# VigIA Trade — Snapshot completo da análise de mercado',
      '',
      '> Faça uma revisão quantitativa independente deste snapshot. Verifique a consistência matemática, a interpretação das métricas, as limitações da amostra e eventuais contradições. Não invente notícias ou dados externos, não altere números sem demonstrar a fórmula e não transforme a análise em recomendação de investimento.',
      '',
      '## Contexto',
      '',
      \`- **Gerado em:** \${generatedAt.toLocaleString('pt-BR')}\`,
      \`- **Ativo principal:** \${usedSymbolA}\`,
      \`- **Ativo comparativo:** \${statsB ? usedSymbolB : 'não utilizado'}\`,
      \`- **Timeframe:** \${tf.label} (\${usedTf})\`,
      \`- **Período analisado:** \${usedPeriodLabel}\`,
      \`- **Janela de volatilidade:** \${tf.windowLabel}\`,
      '- **Fonte dos candles:** Binance',
      '- **Regra temporal:** somente candles encerrados',
      '',
      '## Observações metodológicas',
      '',
      '- Retorno no período compara o primeiro e o último fechamento da janela.',
      '- Retorno anualizado é uma extrapolação matemática do período observado e não uma previsão.',
      '- Volatilidade anualizada mede amplitude das oscilações, não direção.',
      '- Drawdown mede a distância abaixo de um topo anterior.',
      '- Sharpe simplificado compara retorno médio com volatilidade usando taxa livre de risco igual a zero.',
      '- O regime compara a volatilidade atual com a distribuição histórica do próprio ativo na amostra.',
    ];

    appendAsset(
      lines,
      'Ativo principal',
      statsA,
      dataA,
      firstCandleA,
      lastCandleA,
    );

    if (statsB) {
      appendAsset(
        lines,
        'Ativo de comparação',
        statsB,
        dataB,
        firstCandleB,
        lastCandleB,
      );

      lines.push(
        '',
        '## Comparação e correlação',
        '',
        '| Item | Resultado |',
        '|---|---:|',
        \`| Retorno de \${statsA.symbol} | \${mdPct(statsA.returnPct)} |\`,
        \`| Retorno de \${statsB.symbol} | \${mdPct(statsB.returnPct)} |\`,
        \`| Volatilidade atual de \${statsA.symbol} | \${mdNumber(statsA.currentVolPct, 2)}% a.a. |\`,
        \`| Volatilidade atual de \${statsB.symbol} | \${mdNumber(statsB.currentVolPct, 2)}% a.a. |\`,
        \`| Drawdown máximo de \${statsA.symbol} | \${mdPct(statsA.maxDrawdownPct)} |\`,
        \`| Drawdown máximo de \${statsB.symbol} | \${mdPct(statsB.maxDrawdownPct)} |\`,
        \`| Correlação de Pearson | \${corr === null ? 'indisponível' : mdNumber(corr, 4)} |\`,
        \`| Classificação da correlação | \${corr === null ? 'amostra insuficiente' : cleanCell(correlationLabel(corr))} |\`,
      );
    }

    lines.push(
      '',
      '## Relatório explicativo do VigIA',
      '',
      report
        ? report
        : 'O relatório interno com IA ainda não foi gerado. Revise diretamente as métricas acima.',
      '',
      '## Perguntas sugeridas para a IA revisora',
      '',
      '1. Os retornos, drawdowns, volatilidades e extremos parecem internamente coerentes?',
      '2. A interpretação do regime de volatilidade respeita a distribuição histórica do próprio ativo?',
      '3. A correlação foi interpretada sem confundir associação com causalidade?',
      '4. O Sharpe foi usado apenas como retorno por unidade de volatilidade, sem representar todo o risco?',
      '5. A duração e a quantidade de candles são suficientes para a conclusão apresentada?',
      '6. Quais limitações deveriam ser destacadas antes de comparar os ativos?',
      '',
      '> Este snapshot é descritivo, usa dados históricos e não constitui recomendação de investimento.',
    );

    const markdown = lines.join('\n');

    setCopyStatus('loading');
    setCopyMessage('Preparando o Markdown...');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = markdown;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();

        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (!copied) {
          throw new Error('O navegador recusou o acesso à área de transferência.');
        }
      }

      setCopyStatus('success');
      setCopyMessage(
        \`Markdown completo copiado (\${markdown.length.toLocaleString('pt-BR')} caracteres). Cole na IA de sua preferência.\`,
      );
    } catch (copyError) {
      setCopyStatus('error');
      setCopyMessage(
        copyError instanceof Error
          ? \`Não foi possível copiar: \${copyError.message}\`
          : 'Não foi possível copiar o Markdown.',
      );
    }
  }, [
    statsA,
    statsB,
    dataA,
    dataB,
    corr,
    usedSymbolA,
    usedSymbolB,
    usedTf,
    usedPeriodLabel,
    tf,
    report,
  ]);

`;

if (!page.includes(selectMarker)) {
  throw new Error('Não encontrei o ponto de inserção antes da função select.');
}

page = page.replace(selectMarker, copyFunction + selectMarker);

const oldReportCard = `            {/* Relatório IA */}
            <Card>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    Relatório analítico
                  </div>
                  <div style={{ fontSize: 12, color: S.dim }}>
                    Gerado por IA a partir das métricas acima. Descritivo, não
                    recomendação.
                  </div>
                </div>

                <button
                  onClick={generateReport}
                  disabled={reportLoading}
                  style={{
                    background: 'transparent',
                    color: S.a,
                    border: \`1px solid \${S.a}\`,
                    borderRadius: 8,
                    padding: '8px 18px',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: reportLoading ? 'wait' : 'pointer',
                    opacity: reportLoading ? 0.6 : 1,
                  }}
                >
                  {reportLoading ? 'Gerando...' : 'Gerar relatório'}
                </button>
              </div>

              {report && (
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 14,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    borderTop: \`1px solid \${S.border}\`,
                    paddingTop: 14,
                    textAlign: 'left',
                  }}
                >
                  {report}
                </div>
              )}
            </Card>`;

const newReportCard = `            {/* Relatório IA e exportação */}
            <Card>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                  textAlign: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>
                    Relatório analítico
                  </div>
                  <div style={{ fontSize: 12, color: S.dim }}>
                    Gere pelo VigIA ou copie o snapshot em Markdown para revisar
                    na IA de sua preferência.
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                    gap: 10,
                  }}
                >
                  <button
                    onClick={generateReport}
                    disabled={reportLoading}
                    style={{
                      background: 'transparent',
                      color: S.a,
                      border: \`1px solid \${S.a}\`,
                      borderRadius: 8,
                      padding: '8px 18px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: reportLoading ? 'wait' : 'pointer',
                      opacity: reportLoading ? 0.6 : 1,
                    }}
                  >
                    {reportLoading
                      ? 'Gerando...'
                      : report
                        ? 'Gerar novo relatório'
                        : 'Gerar relatório com IA'}
                  </button>

                  <button
                    onClick={copyAnalysisMarkdown}
                    disabled={copyStatus === 'loading'}
                    style={{
                      background:
                        copyStatus === 'success' ? \`\${S.green}18\` : 'transparent',
                      color: copyStatus === 'success' ? S.green : S.b,
                      border: \`1px solid \${
                        copyStatus === 'success' ? S.green : S.b
                      }\`,
                      borderRadius: 8,
                      padding: '8px 18px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: copyStatus === 'loading' ? 'wait' : 'pointer',
                      opacity: copyStatus === 'loading' ? 0.6 : 1,
                    }}
                  >
                    {copyStatus === 'loading'
                      ? 'Copiando...'
                      : copyStatus === 'success'
                        ? '✓ Markdown copiado'
                        : 'Copiar Markdown para outra IA'}
                  </button>
                </div>

                {copyMessage && (
                  <div
                    style={{
                      color:
                        copyStatus === 'success'
                          ? S.green
                          : copyStatus === 'error'
                            ? S.red
                            : S.dim,
                      fontSize: 11,
                      lineHeight: 1.45,
                      maxWidth: 760,
                    }}
                  >
                    {copyMessage}
                  </div>
                )}
              </div>

              {report && (
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 14,
                    lineHeight: 1.7,
                    whiteSpace: 'pre-wrap',
                    borderTop: \`1px solid \${S.border}\`,
                    paddingTop: 14,
                    textAlign: 'left',
                  }}
                >
                  {report}
                </div>
              )}
            </Card>`;

page = replaceOnce(
  page,
  oldReportCard,
  newReportCard,
  'card do relatório',
);

if (!existsSync(backupPath)) {
  copyFileSync(targetPath, backupPath);
}

writeFileSync(targetPath, page, 'utf8');

console.log('Concluído: app/page.tsx foi atualizado.');
console.log('Backup: app/page.tsx.before-markdown');
console.log('Agora execute: npm run build');
