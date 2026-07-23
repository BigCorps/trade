/**
 * scripts/walkforward.ts — VigIA Trade
 * -----------------------------------------------------------------------------
 * Runner de linha de comando da validação walk-forward.
 *
 * Uso (no Codespace, na raiz do repo):
 *
 *   npx tsx scripts/walkforward.ts <SYMBOL> <TIMEFRAME> <DIAS> [ESTRATEGIA] [JANELA]
 *
 * Exemplos:
 *
 *   npx tsx scripts/walkforward.ts BTCUSDT 15m 180
 *   npx tsx scripts/walkforward.ts LINKUSDT 5m 90 trend_breakout 2000
 *   npx tsx scripts/walkforward.ts XRPUSDT 1h 365 trend_pullback
 *
 * O script baixa o histórico da Binance (paginado, candles encerrados),
 * roda o walk-forward com custos padrão (taxa 0,1% + slippage 0,05%) e
 * imprime o resultado por janela e o agregado.
 *
 * Não grava nada no banco e não executa ordens.
 */

import {
  DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS,
  type DayTradeCandle,
  type DayTradeIndicatorTimeframe,
} from '../lib/daytrade/indicators';

import type { DayTradeStrategyId } from '../lib/daytrade/strategies';

import {
  runWalkForwardBacktest,
  type WalkForwardResult,
} from '../lib/daytrade/walkForward';

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
};

const VALID_STRATEGIES: DayTradeStrategyId[] = [
  'trend_breakout',
  'trend_pullback',
  'squeeze_breakout',
  'range_mean_reversion',
];

const PAGE_SIZE = 1_000;
const MAX_PAGES = 250; // 250k candles de teto de segurança

// -----------------------------------------------------------------------------
// Argumentos
// -----------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\nErro: ${message}\n`);
  console.error(
    'Uso: npx tsx scripts/walkforward.ts <SYMBOL> <TIMEFRAME> <DIAS> [ESTRATEGIA] [JANELA]',
  );
  console.error('Ex.: npx tsx scripts/walkforward.ts BTCUSDT 15m 180\n');
  process.exit(1);
}

const [, , rawSymbol, rawTimeframe, rawDays, rawStrategy, rawWindow] =
  process.argv;

if (!rawSymbol || !rawTimeframe || !rawDays) {
  fail('Informe símbolo, timeframe e quantidade de dias.');
}

const symbol = rawSymbol.toUpperCase().trim();

if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
  fail(`Símbolo inválido: ${rawSymbol}`);
}

const timeframe = rawTimeframe as DayTradeIndicatorTimeframe;

if (!(timeframe in TIMEFRAME_MS)) {
  fail(`Timeframe inválido: ${rawTimeframe}. Use 5m, 15m, 30m ou 1h.`);
}

const days = Number(rawDays);

if (!Number.isFinite(days) || days < 5 || days > 730) {
  fail(`Dias inválido: ${rawDays}. Use entre 5 e 730.`);
}

const strategyId = (rawStrategy ?? 'trend_breakout') as DayTradeStrategyId;

if (!VALID_STRATEGIES.includes(strategyId)) {
  fail(
    `Estratégia inválida: ${rawStrategy}. Use uma de: ${VALID_STRATEGIES.join(', ')}.`,
  );
}

const windowCandles = rawWindow ? Number(rawWindow) : 2_000;

if (!Number.isInteger(windowCandles) || windowCandles < 300) {
  fail(`Janela inválida: ${rawWindow}. Use um inteiro >= 300.`);
}

// -----------------------------------------------------------------------------
// Download paginado da Binance
// -----------------------------------------------------------------------------

async function fetchPage(
  baseUrl: string,
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

async function fetchHistory(): Promise<DayTradeCandle[]> {
  const intervalMs = TIMEFRAME_MS[timeframe];
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1_000;

  const candles: DayTradeCandle[] = [];
  let cursor = startTime;
  let pages = 0;

  while (cursor < endTime && pages < MAX_PAGES) {
    let page: unknown[] | null = null;
    let lastError: unknown = null;

    for (const baseUrl of BINANCE_BASE_URLS) {
      try {
        page = await fetchPage(baseUrl, cursor, endTime);
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (page === null) {
      throw lastError instanceof Error
        ? lastError
        : new Error('Falha ao baixar candles da Binance.');
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
        isClosed: Number(row[6]) <= Date.now(),
      };

      if (Object.values(candle).some((v) => typeof v === 'number' && !Number.isFinite(v))) {
        continue;
      }

      candles.push(candle);
    }

    const lastOpen = Number(page[page.length - 1]?.[0 as never]);
    if (!Number.isFinite(lastOpen)) break;

    cursor = lastOpen + intervalMs;
    pages += 1;

    process.stdout.write(
      `\rBaixando histórico... ${candles.length} candles (${pages} páginas)`,
    );

    if (page.length < PAGE_SIZE) break;
  }

  process.stdout.write('\n');
  return candles;
}

// -----------------------------------------------------------------------------
// Impressão
// -----------------------------------------------------------------------------

function fmtR(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}R`;
}

function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function printResult(result: WalkForwardResult): void {
  console.log('\n=== Janelas ===');
  console.table(
    result.windows.map((w) => ({
      janela: w.index,
      inicio: new Date(w.firstCandleOpenTime).toISOString().slice(0, 16),
      candles: w.candleCount,
      trades: w.trades,
      acerto: fmtPct(w.winRatePct),
      somaR: fmtR(w.sumR),
      mediaR: fmtR(w.averageR),
      amostraBaixa: w.lowSample ? 'sim' : '',
      pulada: w.skipped ? w.skipReason ?? 'sim' : '',
    })),
  );

  const a = result.aggregate;

  console.log('=== Agregado (todas as janelas, em R) ===');
  console.log(`Operações avaliadas:   ${a.totalTrades} (descartadas por fim de janela: ${a.excludedEndOfDataTrades})`);
  console.log(`Ganhos / perdas:       ${a.wins} / ${a.losses} (taxa de acerto: ${fmtPct(a.winRatePct)})`);
  console.log(`Soma de R:             ${fmtR(a.sumR)}`);
  console.log(`Média de R por trade:  ${fmtR(a.averageR)}  (mediana: ${fmtR(a.medianR)})`);
  console.log(`Profit factor (R):     ${a.profitFactorR === null ? '—' : a.profitFactorR.toFixed(2)}`);
  console.log(`Janelas positivas:     ${a.positiveWindows}/${a.evaluatedWindowCount} (${fmtPct(a.positiveWindowsPct)})`);
  console.log(`Melhor / pior janela:  ${fmtR(a.bestWindowSumR)} / ${fmtR(a.worstWindowSumR)}`);

  if (result.warnings.length > 0) {
    console.log('\n=== Avisos ===');
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log(`\n${result.educationalNotice}\n`);
}

// -----------------------------------------------------------------------------
// Execução
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `Walk-forward: ${strategyId} · ${symbol} · ${timeframe} · ${days} dias · janela ${windowCandles} candles`,
  );

  const candles = await fetchHistory();

  if (candles.length < windowCandles + 300) {
    fail(
      `Histórico insuficiente: ${candles.length} candles baixados; ` +
        `o mínimo é ${windowCandles + 300} (janela + aquecimento). ` +
        'Aumente os dias ou reduza a janela.',
    );
  }

  const result = runWalkForwardBacktest({
    strategyId,
    candles,
    indicatorOptions: DAYTRADE_TIMEFRAME_INDICATOR_OPTIONS[timeframe],
    backtestOptions: {
      initialCapitalUsdt: 1_000,
      riskPercent: 1,
      feeRatePct: 0.1,
      slippagePct: 0.05,
    },
    walkForwardOptions: {
      windowCandles,
      warmupCandles: 300,
    },
  });

  printResult(result);
}

main().catch((error) => {
  console.error(
    `\nFalha: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
