export type MomentumDirection = -1 | 0 | 1;

export interface DailyClose {
  openTime: number;
  close: number;
}

export interface MomentumTrade {
  signalTime: number;
  entryTime: number;
  exitTime: number;
  direction: MomentumDirection;
  grossReturn: number;
  netReturn: number;
}

export interface MomentumResult {
  lookbackDays: number;
  trades: MomentumTrade[];
  grossReturn: number;
  netReturn: number;
  annualizedReturn: number;
  maxDrawdown: number;
  positiveMonths: number;
}

const DAY_MS = 86_400_000;

function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
}

export function directionFromReturn(value: number): MomentumDirection {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export function runTimeSeriesMomentum(
  candles: readonly DailyClose[],
  lookbackDays: number,
  roundTripCostPct = 0.3,
  capitalFraction = 0.25,
): MomentumResult {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 2) {
    throw new Error('lookbackDays deve ser inteiro e maior que 1');
  }
  if (candles.length <= lookbackDays + 1) {
    return { lookbackDays, trades: [], grossReturn: 0, netReturn: 0, annualizedReturn: 0, maxDrawdown: 0, positiveMonths: 0 };
  }

  const trades: MomentumTrade[] = [];
  let lastMonth = '';
  for (let signalIndex = lookbackDays; signalIndex < candles.length - 1; signalIndex += 1) {
    const signal = candles[signalIndex];
    const key = monthKey(signal.openTime);
    if (key === lastMonth) continue;
    lastMonth = key;

    const reference = candles[signalIndex - lookbackDays];
    const direction = directionFromReturn(signal.close / reference.close - 1);
    if (direction === 0) continue;

    const entryIndex = signalIndex + 1;
    let exitIndex = entryIndex;
    const entryMonth = monthKey(candles[entryIndex].openTime);
    while (exitIndex + 1 < candles.length && monthKey(candles[exitIndex + 1].openTime) === entryMonth) exitIndex += 1;
    if (exitIndex <= entryIndex) continue;

    const assetReturn = direction * (candles[exitIndex].close / candles[entryIndex].close - 1);
    const grossReturn = capitalFraction * assetReturn;
    const netReturn = grossReturn - capitalFraction * roundTripCostPct / 100;
    trades.push({ signalTime: signal.openTime, entryTime: candles[entryIndex].openTime, exitTime: candles[exitIndex].openTime, direction, grossReturn, netReturn });
  }

  let grossEquity = 1;
  let netEquity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const trade of trades) {
    grossEquity *= 1 + trade.grossReturn;
    netEquity *= 1 + trade.netReturn;
    peak = Math.max(peak, netEquity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - netEquity) / peak : 1);
  }
  const first = trades[0]?.entryTime;
  const last = trades.at(-1)?.exitTime;
  const years = first && last ? Math.max((last - first) / (365.25 * DAY_MS), 1 / 12) : 0;
  const annualizedReturn = years > 0 && netEquity > 0 ? netEquity ** (1 / years) - 1 : 0;
  return {
    lookbackDays,
    trades,
    grossReturn: grossEquity - 1,
    netReturn: netEquity - 1,
    annualizedReturn,
    maxDrawdown,
    positiveMonths: trades.filter((trade) => trade.netReturn > 0).length,
  };
}
