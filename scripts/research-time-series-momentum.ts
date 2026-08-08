import { writeFileSync } from 'node:fs';
import { runTimeSeriesMomentum, type DailyClose } from '../lib/research/timeSeriesMomentum';

const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'] as const;
const lookbacks = [90, 180, 360] as const;
const endTime = Date.UTC(2026, 7, 8);
const startTime = Date.UTC(2019, 0, 1);
const outOfSampleStart = Date.UTC(2023, 0, 1);

function summarizeReturns(returns: readonly number[]): { total: number; drawdown: number } {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak);
  }
  return { total: equity - 1, drawdown };
}

async function fetchDaily(symbol: string): Promise<DailyClose[]> {
  const rows: DailyClose[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = new URL('https://data-api.binance.vision/api/v3/klines');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '1d');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', '1000');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol}: Binance HTTP ${response.status}`);
    const batch = await response.json() as Array<Array<number | string>>;
    if (batch.length === 0) break;
    for (const row of batch) rows.push({ openTime: Number(row[0]), close: Number(row[4]) });
    const next = Number(batch.at(-1)?.[0]) + 86_400_000;
    if (next <= cursor) break;
    cursor = next;
  }
  return rows;
}

const lines = [
  '# Pesquisa pré-registrada — momentum de série temporal',
  '',
  '- Corte dos dados: 08/08/2026 UTC',
  '- Entrada: candle diário seguinte ao sinal',
  '- Rebalanceamento: mensal',
  '- Direções: long e short',
  '- Custo total por operação: 0,30%',
  '- Alocação máxima por ativo: 25% do capital',
  '- Lookbacks congelados: 90, 180 e 360 dias',
  '- Fora da amostra: operações iniciadas a partir de 01/01/2023',
  '',
  '| Ativo | Lookback | Meses | Retorno líquido | Drawdown | OOS meses | OOS retorno | OOS drawdown |',
  '|---|---:|---:|---:|---:|---:|---:|---:|',
];
const portfolioByLookback = new Map<number, Map<number, number>>();

async function main(): Promise<void> {
  for (const symbol of symbols) {
    const candles = await fetchDaily(symbol);
    for (const lookback of lookbacks) {
      const result = runTimeSeriesMomentum(candles, lookback, 0.3, 0.25);
      const portfolio = portfolioByLookback.get(lookback) ?? new Map<number, number>();
      for (const trade of result.trades) {
        const date = new Date(trade.exitTime);
        const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
        portfolio.set(month, (portfolio.get(month) ?? 0) + trade.netReturn);
      }
      portfolioByLookback.set(lookback, portfolio);
      const oos = result.trades.filter((trade) => trade.entryTime >= outOfSampleStart);
      const oosSummary = summarizeReturns(oos.map((trade) => trade.netReturn));
      lines.push(`| ${symbol} | ${lookback}d | ${result.trades.length} | ${(result.netReturn * 100).toFixed(2)}% | ${(result.maxDrawdown * 100).toFixed(2)}% | ${oos.length} | ${(oosSummary.total * 100).toFixed(2)}% | ${(oosSummary.drawdown * 100).toFixed(2)}% |`);
    }
  }
  lines.push('', '## Carteira combinada', '', '| Lookback | Meses | Retorno | Drawdown | OOS retorno | OOS drawdown |', '|---:|---:|---:|---:|---:|---:|');
  for (const lookback of lookbacks) {
    const monthly = [...(portfolioByLookback.get(lookback)?.entries() ?? [])].sort((a, b) => a[0] - b[0]);
    const full = summarizeReturns(monthly.map(([, value]) => value));
    const oos = summarizeReturns(monthly.filter(([month]) => month >= outOfSampleStart).map(([, value]) => value));
    lines.push(`| ${lookback}d | ${monthly.length} | ${(full.total * 100).toFixed(2)}% | ${(full.drawdown * 100).toFixed(2)}% | ${(oos.total * 100).toFixed(2)}% | ${(oos.drawdown * 100).toFixed(2)}% |`);
  }
  lines.push('', 'Cada uma das 12 combinações conta na carga de múltiplos testes. Nenhum resultado deste relatório autoriza Testnet ou conta real.', '');
  const output = lines.join('\n');
  writeFileSync('docs/time-series-momentum-2026-08-08.md', output);
  console.log(output);
}

void main();
