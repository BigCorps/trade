/**
 * scripts/walkforward-batch.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Bateria de validação walk-forward: roda todas as combinações de
 * estratégia × gestão para uma lista de símbolos, no mesmo timeframe e
 * período, e imprime uma tabela consolidada ao final.
 *
 * Uso (na raiz do repo):
 *
 *   npx tsx scripts/walkforward-batch.ts
 *   npx tsx scripts/walkforward-batch.ts 1h 360
 *   npx tsx scripts/walkforward-batch.ts 1h 360 BTCUSDT,ETHUSDT,SOLUSDT
 *   npx tsx scripts/walkforward-batch.ts 15m 180 BTCUSDT,ETHUSDT trend_breakout
 *   npx tsx scripts/walkforward-batch.ts 1h 360 BTCUSDT,ETHUSDT trend_breakout zero
 *   npx tsx scripts/walkforward-batch.ts 1h 360 BNBUSDT trend_breakout 0.075/0.025
 *   npx tsx scripts/walkforward-batch.ts 1h 360 BNBUSDT trend_breakout reais 1.5
 *
 * Padrões: 1h · 360 dias · BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT ·
 * estratégias trend_pullback e trend_breakout · todas as 4 gestões.
 *
 * O 5º parâmetro (CUSTOS) define o modelo de custos:
 *   reais       — taxa 0,1% + slippage 0,05% por execução (padrão);
 *   zero        — sem taxa e sem slippage;
 *   TAXA/SLIP   — valores próprios, ex.: 0.075/0.025.
 *
 * Em qualquer posição pode-se passar fim=AAAA-MM-DD para encerrar o período
 * numa data histórica em vez de hoje. Serve para isolar regimes específicos,
 * por exemplo um mercado de baixa:
 *
 *   npx tsx scripts/walkforward-batch.ts 1d 420 BTCUSDT,ETHUSDT trend_breakout reais fim=2023-01-01
 *
 * O 6º parâmetro (STOP_MIN) filtra os setups pela largura mínima do stop,
 * em múltiplos de ATR (padrão da estratégia: 0.5). Stops mais largos diluem
 * o custo por operação quando medido em R, porque o R fica maior enquanto
 * a taxa continua proporcional ao preço.
 *
 * O modo "zero" NÃO é um cenário operável: nenhuma corretora executa de
 * graça. Ele serve como diagnóstico, para separar duas causas distintas de
 * prejuízo: sinal de entrada ruim (bruto negativo) ou sinal neutro
 * consumido pelos custos (bruto perto de zero).
 *
 * O histórico de cada símbolo é baixado UMA vez e reutilizado em todas as
 * combinações, então a maior parte do tempo é de cálculo, não de download.
 * Ao final, além da tabela no terminal, o resumo é salvo em
 * walkforward-resultados.txt para facilitar copiar/compartilhar.
 *
 * Não grava nada no banco e não executa ordens.
 */

import { writeFileSync } from 'node:fs';

import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
} from '../lib/daytrade/indicators';

import type { DayTradeStrategyId } from '../lib/daytrade/strategies';

import type { MultiStrategyBacktestManagementOptions } from '../lib/daytrade/multiStrategyBacktest';

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

const VALID_STRATEGIES: DayTradeStrategyId[] = [
  'trend_breakout',
  'trend_pullback',
  'squeeze_breakout',
  'range_mean_reversion',
];

const MANAGEMENT_PRESETS: Record<
  string,
  MultiStrategyBacktestManagementOptions | undefined
> = {
  nenhuma: undefined,
  breakeven: { breakevenAtR: 1 },
  parcial: {
    breakevenAtR: 1,
    partialTakeProfit: { triggerR: 1, fraction: 0.5 },
  },
  trailing: {
    atrTrailing: { triggerR: 1, atrMultiple: 2 },
  },
};

const DEFAULT_TIMEFRAME: DayTradeIndicatorTimeframe = '1h';

/**
 * Tamanho da janela de validação por timeframe. No intradiário 2.000 candles
 * equivalem a algumas semanas; no diário equivaleriam a mais de cinco anos,
 * o que produziria uma ou duas janelas apenas. Os valores abaixo mantêm cada
 * janela na casa de meses a um ano em qualquer timeframe.
 */
const WINDOW_BY_TIMEFRAME: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 2_000,
  '15m': 2_000,
  '30m': 2_000,
  '1h': 2_000,
  '4h': 750,
  '1d': 250,
};

/** Período padrão suficiente para gerar várias janelas em cada timeframe. */
const DAYS_BY_TIMEFRAME: Record<DayTradeIndicatorTimeframe, number> = {
  '5m': 90,
  '15m': 180,
  '30m': 360,
  '1h': 360,
  '4h': 1_100,
  '1d': 2_900,
};
const DEFAULT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const DEFAULT_STRATEGIES: DayTradeStrategyId[] = [
  'trend_pullback',
  'trend_breakout',
];

const PAGE_SIZE = 1_000;
const MAX_PAGES = 250;
const OUTPUT_FILE_BASE = 'walkforward-resultados';

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\nErro: ${message}\n`);
  console.error(
    'Uso: npx tsx scripts/walkforward-batch.ts [TIMEFRAME] [DIAS] [SIMBOLOS] [ESTRATEGIAS] [CUSTOS] [STOP_MIN]',
  );
  console.error(
    'Ex.: npx tsx scripts/walkforward-batch.ts 1h 360 BTCUSDT,ETHUSDT trend_pullback\n',
  );
  process.exit(1);
}

const argv = process.argv.slice(2);

/** fim=AAAA-MM-DD pode aparecer em qualquer posição; os demais são ordenados. */
const endDateArg = argv.find((item) => item.startsWith('fim='));
const positional = argv.filter((item) => !item.startsWith('fim='));

const [
  rawTimeframe,
  rawDays,
  rawSymbols,
  rawStrategies,
  rawCosts,
  rawStopMin,
] = positional;

const endTimeMs = (() => {
  if (!endDateArg) return Date.now();

  const parsed = Date.parse(`${endDateArg.slice(4)}T00:00:00Z`);

  if (!Number.isFinite(parsed)) {
    console.error(`\nErro: data final inválida em ${endDateArg}. Use fim=AAAA-MM-DD.\n`);
    process.exit(1);
  }

  if (parsed > Date.now()) {
    console.error('\nErro: a data final não pode estar no futuro.\n');
    process.exit(1);
  }

  return parsed;
})();

const timeframe = (rawTimeframe ??
  DEFAULT_TIMEFRAME) as DayTradeIndicatorTimeframe;

if (!(timeframe in TIMEFRAME_MS)) {
  fail(`Timeframe inválido: ${rawTimeframe}. Use 5m, 15m, 30m, 1h, 4h ou 1d.`);
}

const days = rawDays ? Number(rawDays) : DAYS_BY_TIMEFRAME[timeframe];

if (!Number.isFinite(days) || days < 5 || days > 3_650) {
  fail(`Dias inválido: ${rawDays}. Use entre 5 e 3650.`);
}

const WINDOW_CANDLES = WINDOW_BY_TIMEFRAME[timeframe];

const symbols = (rawSymbols
  ? rawSymbols.split(',').map((item) => item.toUpperCase().trim())
  : DEFAULT_SYMBOLS
).filter((item) => item.length > 0);

if (symbols.length === 0 || symbols.some((s) => !/^[A-Z0-9]{5,20}$/.test(s))) {
  fail(`Lista de símbolos inválida: ${rawSymbols}`);
}

const strategies = (rawStrategies
  ? (rawStrategies.split(',').map((item) => item.trim()) as DayTradeStrategyId[])
  : DEFAULT_STRATEGIES
).filter((item) => item.length > 0);

for (const strategy of strategies) {
  if (!VALID_STRATEGIES.includes(strategy)) {
    fail(
      `Estratégia inválida: ${strategy}. Use uma de: ${VALID_STRATEGIES.join(', ')}.`,
    );
  }
}

const costsKey = (rawCosts ?? 'reais').toLowerCase().trim();

let feeRatePct: number;
let slippagePct: number;

if (costsKey === 'reais') {
  feeRatePct = 0.1;
  slippagePct = 0.05;
} else if (costsKey === 'zero') {
  feeRatePct = 0;
  slippagePct = 0;
} else if (costsKey.includes('/')) {
  const [rawFee, rawSlip] = costsKey.split('/');
  feeRatePct = Number(rawFee);
  slippagePct = Number(rawSlip);

  if (
    !Number.isFinite(feeRatePct) ||
    !Number.isFinite(slippagePct) ||
    feeRatePct < 0 ||
    slippagePct < 0 ||
    feeRatePct > 1 ||
    slippagePct > 1
  ) {
    fail(
      `Custos inválido: ${rawCosts}. Use reais, zero ou TAXA/SLIP (ex.: 0.075/0.025).`,
    );
  }
} else {
  fail(
    `Custos inválido: ${rawCosts}. Use reais, zero ou TAXA/SLIP (ex.: 0.075/0.025).`,
  );
}

const stopMinAtr = rawStopMin ? Number(rawStopMin) : null;

if (
  stopMinAtr !== null &&
  (!Number.isFinite(stopMinAtr) || stopMinAtr <= 0 || stopMinAtr > 5)
) {
  fail(`STOP_MIN inválido: ${rawStopMin}. Use um número entre 0 e 5.`);
}

/**
 * Filtro de largura mínima do stop. Aplicado às duas estratégias de
 * tendência; as demais ignoram a chave que não conhecem.
 */
const strategyOptions =
  stopMinAtr === null
    ? {}
    : {
        trend_breakout: { minimumStopDistanceAtr: stopMinAtr },
        trend_pullback: { minimumStopDistanceAtr: stopMinAtr },
      };

// -----------------------------------------------------------------------------
// Download paginado da Binance (uma vez por símbolo)
// -----------------------------------------------------------------------------

async function fetchPage(
  baseUrl: string,
  symbol: string,
  startTime: number,
  endTime: number,
): Promise<unknown[]> {
  const url = new URL('/api/v3/klines', baseUrl);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', timeframe);
  url.searchParams.set('startTime', String(startTime));
  url.searchParams.set('endTime', String(endTime));
  url.searchParams.set('limit', String(PAGE_SIZE));

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`HTTP ${response.status} em ${baseUrl}: ${body}`);
  }

  const payload = (await response.json()) as unknown;

  if (!Array.isArray(payload)) {
    throw new Error(`Resposta inesperada de ${baseUrl}.`);
  }

  return payload;
}

async function fetchHistory(symbol: string): Promise<DayTradeCandle[]> {
  const intervalMs = TIMEFRAME_MS[timeframe];
  const endTime = endTimeMs;
  const startTime = endTime - days * 24 * 60 * 60 * 1_000;

  const candles: DayTradeCandle[] = [];
  let cursor = startTime;
  let pages = 0;

  while (cursor < endTime && pages < MAX_PAGES) {
    let page: unknown[] | null = null;
    let lastError: unknown = null;

    for (const baseUrl of BINANCE_BASE_URLS) {
      try {
        page = await fetchPage(baseUrl, symbol, cursor, endTime);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (page === null) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Falha ao baixar candles de ${symbol}.`);
    }

    if (page.length === 0) break;

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
        isClosed: Number(row[6]) <= Math.min(Date.now(), endTimeMs),
      };

      if (
        Object.values(candle).some(
          (v) => typeof v === 'number' && !Number.isFinite(v),
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

    process.stdout.write(
      `\r[${symbol}] baixando histórico... ${candles.length} candles`,
    );

    if (page.length < PAGE_SIZE) break;
  }

  process.stdout.write('\n');
  return candles;
}

// -----------------------------------------------------------------------------
// Execução da matriz
// -----------------------------------------------------------------------------

interface BatchRow {
  simbolo: string;
  estrategia: string;
  gestao: string;
  trades: number;
  acertoPct: string;
  somaR: string;
  mediaR: string;
  medianaR: string;
  pfR: string;
  t: string;
  janelasPos: string;
  piorJanela: string;
  obs: string;
}

function fmt(value: number | null, decimals = 2, sign = true): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const prefix = sign && value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(decimals)}`;
}

async function main(): Promise<void> {
  const managements = Object.keys(MANAGEMENT_PRESETS);
  const totalRuns = symbols.length * strategies.length * managements.length;

  console.log(
    `Bateria walk-forward: ${timeframe} · ${days} dias · janela ${WINDOW_CANDLES} candles`,
  );
  console.log(`Símbolos: ${symbols.join(', ')}`);
  console.log(`Estratégias: ${strategies.join(', ')}`);
  console.log(`Gestões: ${managements.join(', ')}`);
  console.log(
    `Custos: taxa ${feeRatePct}% + slippage ${slippagePct}% por execução` +
      (costsKey === 'zero'
        ? ' (DIAGNÓSTICO — não operável na prática)'
        : ''),
  );

  console.log(
    `Stop mínimo: ${stopMinAtr === null ? 'padrão da estratégia' : `${stopMinAtr} ATR`}`,
  );

  console.log(
    `Período encerra em: ${new Date(endTimeMs).toISOString().slice(0, 10)}`,
  );
  console.log(`Total de combinações: ${totalRuns}\n`);

  const rows: BatchRow[] = [];
  let runIndex = 0;

  for (const symbol of symbols) {
    let candles: DayTradeCandle[];

    try {
      candles = await fetchHistory(symbol);
    } catch (error) {
      console.error(
        `[${symbol}] download falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (candles.length < WINDOW_CANDLES + 300) {
      const neededDays = Math.ceil(
        ((WINDOW_CANDLES + 300) * TIMEFRAME_MS[timeframe]) /
          (24 * 60 * 60 * 1_000),
      );

      console.error(
        `[${symbol}] histórico insuficiente: ${candles.length} candles, ` +
          `mínimo ${WINDOW_CANDLES + 300} (janela + aquecimento). ` +
          `Use ao menos ${neededDays} dias, ou o par pode ser recente demais.`,
      );
      continue;
    }

    for (const strategy of strategies) {
      for (const managementKey of managements) {
        runIndex += 1;

        process.stdout.write(
          `\r(${runIndex}/${totalRuns}) ${symbol} · ${strategy} · ${managementKey}        `,
        );

        try {
          const result = runWalkForwardBacktest({
            strategyId: strategy,
            candles,
            indicatorOptions:
              DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
            strategyOptions,
            backtestOptions: {
              initialCapitalUsdt: 1_000,
              riskPercent: 1,
              feeRatePct,
              slippagePct,
              management: MANAGEMENT_PRESETS[managementKey],
            },
            walkForwardOptions: {
              windowCandles: WINDOW_CANDLES,
              warmupCandles: 300,
            },
          });

          const a = result.aggregate;

          rows.push({
            simbolo: symbol,
            estrategia: strategy,
            gestao: managementKey,
            trades: a.totalTrades,
            acertoPct: fmt(a.winRatePct, 1, false),
            somaR: fmt(a.sumR),
            mediaR: fmt(a.averageR),
            medianaR: fmt(a.medianR),
            pfR: fmt(a.profitFactorR, 2, false),
            t: fmt(a.tStatistic),
            janelasPos: `${a.positiveWindows}/${a.evaluatedWindowCount}`,
            piorJanela: fmt(a.worstWindowSumR),
            obs:
              a.tStatistic === null
                ? 'amostra insuficiente'
                : Math.abs(a.tStatistic) < 2
                  ? 'indistinguivel de sorte'
                  : a.totalTrades < 100
                    ? 'amostra baixa'
                    : '',
          });
        } catch (error) {
          rows.push({
            simbolo: symbol,
            estrategia: strategy,
            gestao: managementKey,
            trades: 0,
            acertoPct: '—',
            somaR: '—',
            mediaR: '—',
            medianaR: '—',
            pfR: '—',
            t: '—',
            janelasPos: '—',
            piorJanela: '—',
            obs: `erro: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }

    process.stdout.write('\n');
  }

  // Ordena da melhor média de R para a pior (linhas com erro ao final).
  rows.sort((left, right) => {
    const l = Number.parseFloat(left.mediaR);
    const r = Number.parseFloat(right.mediaR);
    const lv = Number.isFinite(l) ? l : Number.NEGATIVE_INFINITY;
    const rv = Number.isFinite(r) ? r : Number.NEGATIVE_INFINITY;
    return rv - lv;
  });

  console.log('\n=== Resultado consolidado (ordenado por média de R) ===');
  console.table(rows);

  const header =
    `Bateria walk-forward · ${timeframe} · ${days} dias · janela ${WINDOW_CANDLES}\n` +
    `Custos: taxa ${feeRatePct}% + slippage ${slippagePct}% · ` +
    `Stop mínimo: ${stopMinAtr === null ? 'padrão' : `${stopMinAtr} ATR`} · ` +
    `Fim: ${new Date(endTimeMs).toISOString().slice(0, 10)}\n` +
    `Símbolos: ${symbols.join(', ')} · Estratégias: ${strategies.join(', ')}\n` +
    `Gerado em: ${new Date().toISOString()}\n\n`;

  const lines = [
    'simbolo | estrategia | gestao | trades | acerto% | somaR | mediaR | medianaR | PF | t | janelasPos | piorJanela | obs',
    '---|---|---|---|---|---|---|---|---|---|---|---|---',
    ...rows.map(
      (row) =>
        `${row.simbolo} | ${row.estrategia} | ${row.gestao} | ${row.trades} | ${row.acertoPct} | ${row.somaR} | ${row.mediaR} | ${row.medianaR} | ${row.pfR} | ${row.t} | ${row.janelasPos} | ${row.piorJanela} | ${row.obs}`,
    ),
  ].join('\n');

  const costsLabel = costsKey.replace('/', '-');

  const endLabel = endDateArg ? `-ate${endDateArg.slice(4)}` : '';

  const outputFile =
    `${OUTPUT_FILE_BASE}-${timeframe}-${days}d-${costsLabel}` +
    `${stopMinAtr === null ? '' : `-stop${stopMinAtr}`}${endLabel}.txt`;

  writeFileSync(outputFile, header + lines + '\n');

  console.log(`\nResumo salvo em ${outputFile} (pode copiar o arquivo inteiro).`);
  console.log(
    '\nColuna t: média dividida pelo erro padrão. |t| < 2 significa que o ' +
      'resultado não é distinguível de sorte.',
  );
  console.log(
    '\nResultado educacional. A validação mede consistência histórica de regras fixas e não representa recomendação nem promessa de resultado.\n',
  );
}

main().catch((error) => {
  console.error(
    `\nFalha: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
