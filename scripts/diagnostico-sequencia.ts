/**
 * scripts/diagnostico-sequencia.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Dois diagnósticos que a tabela da bateria não responde:
 *
 * 1. DECAIMENTO NO TEMPO
 *    As janelas do walk-forward são cronológicas. Este script as imprime em
 *    ordem de data (a bateria ordena por resultado, não por tempo) e mede se
 *    existe tendência de piora comparando a primeira metade do período com a
 *    segunda.
 *
 * 2. DEPENDÊNCIA ENTRE OPERAÇÕES CONSECUTIVAS
 *    É a única coisa que poderia justificar martingale ou anti-martingale.
 *    Esquemas de tamanho de posição não alteram a expectativa de cada operação
 *    isolada; eles só fazem diferença se o resultado de uma operação ajudar a
 *    prever o da seguinte. O teste mede exatamente isso: qual o resultado médio
 *    DEPOIS de um ganho contra DEPOIS de uma perda.
 *
 *    - média depois de perda > média depois de ganho  -> martingale teria base
 *    - média depois de ganho > média depois de perda  -> anti-martingale teria base
 *    - sem diferença estatística                      -> nenhum dos dois ajuda
 *
 *    As sequências são montadas DENTRO de cada símbolo (operações de moedas
 *    diferentes não formam sequência) e depois agrupadas.
 *
 * Uso:
 *
 *   npx tsx scripts/diagnostico-sequencia.ts [TIMEFRAME] [DIAS] [SIMBOLOS] [ESTRATEGIA] [CUSTOS]
 *
 * Exemplos:
 *
 *   npx tsx scripts/diagnostico-sequencia.ts 1d 2900 BTCUSDT,ETHUSDT,SOLUSDT trend_pullback
 *   npx tsx scripts/diagnostico-sequencia.ts 1d 2900 BTCUSDT,ETHUSDT,LTCUSDT,TRXUSDT trend_breakout reais
 *
 * Não grava nada no banco e não executa ordens.
 */

import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
} from '../lib/daytrade/indicators';

import type { DayTradeStrategyId } from '../lib/daytrade/strategies';

import { runWalkForwardBacktest } from '../lib/daytrade/walkForward';

// -----------------------------------------------------------------------------
// Configuração
// -----------------------------------------------------------------------------

const BINANCE_BASE_URLS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
] as const;

const TIMEFRAME_MS: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 5 * 60 * 1_000,
  '15m': 15 * 60 * 1_000,
  '30m': 30 * 60 * 1_000,
  '1h': 60 * 60 * 1_000,
  '4h': 4 * 60 * 60 * 1_000,
  '1d': 24 * 60 * 60 * 1_000,
};

const WINDOW_BY_TIMEFRAME: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 2_000,
  '15m': 2_000,
  '30m': 2_000,
  '1h': 2_000,
  '4h': 750,
  '1d': 250,
};

const VALID_STRATEGIES: DayTradeStrategyId[] = [
  'trend_breakout',
  'trend_pullback',
  'squeeze_breakout',
  'range_mean_reversion',
];

const PAGE_SIZE = 1_000;
const MAX_PAGES = 250;

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\nErro: ${message}\n`);
  console.error(
    'Uso: npx tsx scripts/diagnostico-sequencia.ts [TIMEFRAME] [DIAS] [SIMBOLOS] [ESTRATEGIA] [CUSTOS]',
  );
  process.exit(1);
}

const [, , rawTimeframe, rawDays, rawSymbols, rawStrategy, rawCosts] =
  process.argv;

const timeframe = (rawTimeframe ?? '1d') as DayTradeIndicatorTimeframe;

if (!(timeframe in TIMEFRAME_MS)) {
  fail(`Timeframe inválido: ${rawTimeframe}. Use 5m, 15m, 30m, 1h, 4h ou 1d.`);
}

const days = rawDays ? Number(rawDays) : 2_900;

if (!Number.isFinite(days) || days < 5 || days > 3_650) {
  fail(`Dias inválido: ${rawDays}.`);
}

const symbols = (rawSymbols ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
  .split(',')
  .map((item) => item.toUpperCase().trim())
  .filter((item) => item.length > 0);

const strategyId = (rawStrategy ?? 'trend_pullback') as DayTradeStrategyId;

if (!VALID_STRATEGIES.includes(strategyId)) {
  fail(`Estratégia inválida: ${rawStrategy}.`);
}

const costsKey = (rawCosts ?? 'reais').toLowerCase().trim();
const feeRatePct = costsKey === 'zero' ? 0 : 0.1;
const slippagePct = costsKey === 'zero' ? 0 : 0.05;

const WINDOW_CANDLES = WINDOW_BY_TIMEFRAME[timeframe];

// -----------------------------------------------------------------------------
// Download
// -----------------------------------------------------------------------------

async function fetchHistory(symbol: string): Promise<DayTradeCandle[]> {
  const intervalMs = TIMEFRAME_MS[timeframe];
  const endTime = Date.now();
  const candles: DayTradeCandle[] = [];

  let cursor = endTime - days * 24 * 60 * 60 * 1_000;
  let pages = 0;

  while (cursor < endTime && pages < MAX_PAGES) {
    let page: unknown[] | null = null;

    for (const baseUrl of BINANCE_BASE_URLS) {
      try {
        const url = new URL('/api/v3/klines', baseUrl);
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('interval', timeframe);
        url.searchParams.set('startTime', String(cursor));
        url.searchParams.set('endTime', String(endTime));
        url.searchParams.set('limit', String(PAGE_SIZE));

        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) continue;

        const payload = (await response.json()) as unknown;
        if (Array.isArray(payload)) {
          page = payload;
          break;
        }
      } catch {
        // tenta o próximo domínio
      }
    }

    if (page === null || page.length === 0) break;

    for (const row of page) {
      if (!Array.isArray(row) || row.length < 8) continue;

      const candle: DayTradeCandle = {
        openTime: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closeTime: Number(row[6]),
        quoteVolume: Number(row[7]),
        isClosed: Number(row[6]) <= Date.now(),
      };

      if (
        Object.values(candle).some(
          (value) => typeof value === 'number' && !Number.isFinite(value),
        )
      ) {
        continue;
      }

      candles.push(candle);
    }

    const lastOpen = Number(page[page.length - 1]?.[0 as never]);
    if (!Number.isFinite(lastOpen)) break;

    cursor = lastOpen + intervalMs;
    pages += 1;

    if (page.length < PAGE_SIZE) break;
  }

  return candles;
}

// -----------------------------------------------------------------------------
// Estatística
// -----------------------------------------------------------------------------

function media(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function desvio(values: readonly number[]): number | null {
  const m = media(values);
  if (m === null || values.length < 2) return null;

  const variancia =
    values.reduce((total, value) => total + (value - m) ** 2, 0) /
    (values.length - 1);

  return Math.sqrt(variancia);
}

function fmt(value: number | null, casas = 3): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sinal = value > 0 ? '+' : '';
  return `${sinal}${value.toFixed(casas)}`;
}

// -----------------------------------------------------------------------------
// Execução
// -----------------------------------------------------------------------------

interface Operacao {
  simbolo: string;
  entrada: number;
  resultadoR: number;
}

interface Janela {
  simbolo: string;
  inicio: number;
  somaR: number;
  operacoes: number;
}

async function main(): Promise<void> {
  console.log(
    `Diagnóstico de sequência: ${strategyId} · ${timeframe} · ${days} dias · custos ${costsKey}`,
  );
  console.log(`Símbolos: ${symbols.join(', ')}\n`);

  const todasJanelas: Janela[] = [];

  /** Sequências separadas por símbolo: operações de moedas distintas não encadeiam. */
  const sequenciasPorSimbolo: Operacao[][] = [];

  for (const simbolo of symbols) {
    process.stdout.write(`\rProcessando ${simbolo}...            `);

    let candles: DayTradeCandle[];

    try {
      candles = await fetchHistory(simbolo);
    } catch {
      console.error(`\n[${simbolo}] falha no download; pulado.`);
      continue;
    }

    if (candles.length < WINDOW_CANDLES + 300) {
      console.error(
        `\n[${simbolo}] histórico insuficiente (${candles.length} candles); pulado.`,
      );
      continue;
    }

    const resultado = runWalkForwardBacktest({
      strategyId,
      candles,
      indicatorOptions: DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
      backtestOptions: {
        initialCapitalUsdt: 1_000,
        riskPercent: 1,
        feeRatePct,
        slippagePct,
      },
      walkForwardOptions: {
        windowCandles: WINDOW_CANDLES,
        warmupCandles: 300,
      },
    });

    for (const janela of resultado.windows) {
      if (janela.skipped) continue;

      todasJanelas.push({
        simbolo,
        inicio: janela.firstCandleOpenTime,
        somaR: janela.sumR,
        operacoes: janela.trades,
      });
    }

    const operacoes: Operacao[] = [];

    for (const janela of resultado.windowResults) {
      if (!janela) continue;

      for (const trade of janela.trades) {
        if (trade.exitReason === 'end_of_data') continue;

        operacoes.push({
          simbolo,
          entrada: trade.entryTime,
          resultadoR: trade.resultR,
        });
      }
    }

    operacoes.sort((a, b) => a.entrada - b.entrada);
    if (operacoes.length >= 2) sequenciasPorSimbolo.push(operacoes);
  }

  process.stdout.write('\r                                        \r');

  if (todasJanelas.length === 0) {
    fail('Nenhum símbolo produziu janelas avaliáveis.');
  }

  // ---------------------------------------------------------------------------
  // 1. Decaimento no tempo
  // ---------------------------------------------------------------------------

  console.log('=== 1. DESEMPENHO AO LONGO DO TEMPO (ordem cronológica) ===\n');

  const porPeriodo = new Map<string, { somaR: number; operacoes: number }>();

  for (const janela of todasJanelas) {
    const chave = new Date(janela.inicio).toISOString().slice(0, 7);
    const atual = porPeriodo.get(chave) ?? { somaR: 0, operacoes: 0 };

    atual.somaR += janela.somaR;
    atual.operacoes += janela.operacoes;
    porPeriodo.set(chave, atual);
  }

  const periodos = [...porPeriodo.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  console.log('  início da janela | operações | somaR das janelas');
  for (const [chave, valor] of periodos) {
    const barra =
      valor.somaR >= 0
        ? '█'.repeat(Math.min(30, Math.round(valor.somaR)))
        : '░'.repeat(Math.min(30, Math.round(-valor.somaR)));

    console.log(
      `  ${chave}          | ${String(valor.operacoes).padStart(9)} | ` +
        `${fmt(valor.somaR, 2).padStart(8)}  ${barra}`,
    );
  }

  const metade = Math.floor(todasJanelas.length / 2);
  const ordenadas = [...todasJanelas].sort((a, b) => a.inicio - b.inicio);

  const primeiraMetade = ordenadas.slice(0, metade);
  const segundaMetade = ordenadas.slice(metade);

  const rPrimeira =
    primeiraMetade.reduce((t, j) => t + j.somaR, 0) /
    Math.max(1, primeiraMetade.reduce((t, j) => t + j.operacoes, 0));

  const rSegunda =
    segundaMetade.reduce((t, j) => t + j.somaR, 0) /
    Math.max(1, segundaMetade.reduce((t, j) => t + j.operacoes, 0));

  console.log(
    `\n  Primeira metade do período: ${fmt(rPrimeira)}R por operação`,
  );
  console.log(`  Segunda metade do período:  ${fmt(rSegunda)}R por operação`);
  console.log(
    `  Diferença: ${fmt(rSegunda - rPrimeira)}R ` +
      `(negativo indica piora ao longo do tempo)\n`,
  );

  // ---------------------------------------------------------------------------
  // 2. Dependência entre operações consecutivas
  // ---------------------------------------------------------------------------

  console.log(
    '=== 2. O RESULTADO ANTERIOR PREVÊ O PRÓXIMO? (base do martingale) ===\n',
  );

  const depoisDeGanho: number[] = [];
  const depoisDePerda: number[] = [];

  for (const sequencia of sequenciasPorSimbolo) {
    for (let i = 1; i < sequencia.length; i += 1) {
      const anterior = sequencia[i - 1].resultadoR;
      const atual = sequencia[i].resultadoR;

      if (anterior > 0) depoisDeGanho.push(atual);
      else if (anterior < 0) depoisDePerda.push(atual);
    }
  }

  const mGanho = media(depoisDeGanho);
  const mPerda = media(depoisDePerda);
  const sGanho = desvio(depoisDeGanho);
  const sPerda = desvio(depoisDePerda);

  console.log(
    `  Depois de um GANHO:  ${String(depoisDeGanho.length).padStart(4)} operações, média ${fmt(mGanho)}R`,
  );
  console.log(
    `  Depois de uma PERDA: ${String(depoisDePerda.length).padStart(4)} operações, média ${fmt(mPerda)}R`,
  );

  if (
    mGanho !== null &&
    mPerda !== null &&
    sGanho !== null &&
    sPerda !== null &&
    depoisDeGanho.length > 1 &&
    depoisDePerda.length > 1
  ) {
    const diferenca = mGanho - mPerda;

    const erroPadrao = Math.sqrt(
      sGanho ** 2 / depoisDeGanho.length + sPerda ** 2 / depoisDePerda.length,
    );

    const t = erroPadrao > 0 ? diferenca / erroPadrao : null;

    console.log(`\n  Diferença (ganho - perda): ${fmt(diferenca)}R`);
    console.log(`  Estatística t da diferença: ${fmt(t, 2)}`);

    console.log('\n  Leitura:');

    if (t === null || Math.abs(t) < 2) {
      console.log(
        '    Não há dependência detectável entre operações consecutivas.',
      );
      console.log(
        '    O resultado anterior não ajuda a prever o próximo, portanto NENHUM',
      );
      console.log(
        '    esquema de tamanho baseado em ganhos ou perdas recentes agrega valor.',
      );
      console.log(
        '    Martingale e anti-martingale apenas redistribuem o mesmo resultado,',
      );
      console.log('    e o martingale concentra risco nas sequências ruins.');
    } else if (t > 0) {
      console.log(
        '    Ganhos tendem a ser seguidos de resultados melhores (agrupamento).',
      );
      console.log(
        '    Há base empírica para testar anti-martingale (aumentar após ganho).',
      );
    } else {
      console.log(
        '    Perdas tendem a ser seguidas de resultados melhores (reversão).',
      );
      console.log(
        '    Há base empírica para testar aumento de tamanho após perda —',
      );
      console.log(
        '    ainda assim, sem vantagem positiva por operação isso não vira lucro.',
      );
    }
  }

  console.log(
    '\nResultado educacional. Não representa recomendação nem promessa de resultado.\n',
  );
}

main().catch((error) => {
  console.error(
    `\nFalha: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
