import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationWindow, resolveForwardLongSignal, selectRecoveryCandles } from '../../lib/forward-test/engine';
import type { DayTradeCandle } from '../../lib/daytrade/indicators';

function candle(openTime: number, values: Partial<DayTradeCandle> = {}): DayTradeCandle {
  return { openTime, closeTime: openTime + 999, open: 100, high: 101, low: 99, close: 100, volume: 1, quoteVolume: 100, isClosed: true, ...values };
}

test('recupera em ordem cronológica', () => {
  const candles = [1, 2, 3, 4].map((value) => candle(value * 1000));
  const result = selectRecoveryCandles(candles, new Date(1000).toISOString(), 10);
  assert.deepEqual(result.indexes, [1, 2, 3]);
  assert.equal(result.recoveredCount, 2);
});

test('limita a 24 e registra backlog', () => {
  const candles = Array.from({ length: 30 }, (_, index) => candle(index * 1000));
  const result = selectRecoveryCandles(candles, new Date(-1000).toISOString(), 24);
  assert.equal(result.indexes.length, 24);
  assert.equal(result.backlog, 6);
});

test('sem checkpoint só avalia o candle atual', () => {
  const result = selectRecoveryCandles([candle(1000), candle(2000), candle(3000)], null, 24);
  assert.deepEqual(result.indexes, [2]);
  assert.equal(result.recoveredCount, 0);
});

test('janela termina no candle avaliado', () => {
  const candles = Array.from({ length: 500 }, (_, index) => candle(index * 1000));
  const window = evaluationWindow(candles, 450, 400);
  assert.equal(window.length, 400);
  assert.equal(window.at(-1)?.openTime, candles[450].openTime);
});

test('stop tem prioridade quando stop e alvo são tocados', () => {
  const candles = [candle(1000), candle(2000), candle(3000, { high: 112, low: 88 })];
  const result = resolveForwardLongSignal({ candle_open_time: new Date(1000).toISOString(), entrada_referencia: 100, stop_referencia: 90, alvo_referencia: 110, atr: 10, status: 'aguardando_entrada', entrada_preco: null }, candles, { fee_rate_pct: 0, slippage_pct: 0, max_next_open_distance_atr: 0.5 });
  assert.equal(result.saida_motivo, 'stop');
  assert.equal(result.resultado_r, -1);
});

test('gap abaixo do stop sai na abertura', () => {
  const candles = [candle(1000), candle(2000), candle(3000, { open: 80, high: 84, low: 78, close: 82 })];
  const result = resolveForwardLongSignal({ candle_open_time: new Date(1000).toISOString(), entrada_referencia: 100, stop_referencia: 90, alvo_referencia: 110, atr: 10, status: 'aguardando_entrada', entrada_preco: null }, candles, { fee_rate_pct: 0, slippage_pct: 0, max_next_open_distance_atr: 0.5 });
  assert.equal(result.saida_preco, 80);
  assert.equal(result.resultado_r, -2);
});
