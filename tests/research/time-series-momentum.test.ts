import assert from 'node:assert/strict';
import test from 'node:test';
import { directionFromReturn, runTimeSeriesMomentum } from '../../lib/research/timeSeriesMomentum';

test('direção do momentum é simétrica', () => {
  assert.equal(directionFromReturn(0.1), 1);
  assert.equal(directionFromReturn(-0.1), -1);
  assert.equal(directionFromReturn(0), 0);
});

test('usa o sinal anterior e desconta custo da operação', () => {
  const candles = Array.from({ length: 100 }, (_, index) => ({
    openTime: Date.UTC(2020, 0, 1 + index),
    close: 100 + index,
  }));
  const result = runTimeSeriesMomentum(candles, 10, 0.3, 0.25);
  assert.ok(result.trades.length >= 2);
  assert.ok(result.trades.every((trade) => trade.entryTime > trade.signalTime));
  assert.ok(result.trades.every((trade) => Math.abs((trade.grossReturn - 0.00075) - trade.netReturn) < 1e-12));
});

test('recusa lookback inválido', () => {
  assert.throws(() => runTimeSeriesMomentum([], 1), /lookbackDays/);
});
