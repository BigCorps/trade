import assert from 'node:assert/strict';
import test from 'node:test';
import { blockBootstrapMonteCarlo, buildValidationReport, maximumDrawdown, robustnessAnalysis } from '../../lib/forward-test/validation';

test('maximumDrawdown respeita a curva acumulada', () => { assert.equal(maximumDrawdown([1, -2, 1]), 2); });
test('robustez remove as melhores operações sem alterar a base', () => {
  const trades = [
    { id: '1', symbol: 'BTCUSDT', timeframe: '1h', strategy: 'x', openedAt: '2026-01-01T00:00:00Z', resultR: 2 },
    { id: '2', symbol: 'ETHUSDT', timeframe: '1h', strategy: 'x', openedAt: '2026-01-02T00:00:00Z', resultR: 1 },
    { id: '3', symbol: 'ETHUSDT', timeframe: '1h', strategy: 'x', openedAt: '2026-01-03T00:00:00Z', resultR: -1 },
  ];
  const result = robustnessAnalysis(trades);
  assert.equal(result.completeR, 2); assert.equal(result.withoutBestTradeR, 0); assert.equal(result.withoutBestThreeTradesR, 0);
});
test('Monte Carlo em blocos é reproduzível com a mesma seed', () => {
  const trades = [{ id: '1', symbol: 'BTCUSDT', timeframe: '1h', strategy: 'x', openedAt: '2026-01-01T00:00:00Z', resultR: 1 }, { id: '2', symbol: 'BTCUSDT', timeframe: '1h', strategy: 'x', openedAt: '2026-01-02T00:00:00Z', resultR: -1 }];
  assert.deepEqual(blockBootstrapMonteCarlo(trades, 100, 7), blockBootstrapMonteCarlo(trades, 100, 7));
});
test('relatório não aprova amostra pequena para dinheiro real', () => {
  const report = buildValidationReport([{ id: '1', symbol: 'BTCUSDT', timeframe: '1h', strategy: 'x', openedAt: '2026-01-01T00:00:00Z', resultR: 1 }], 50, 1);
  assert.equal(report.readiness.readyForRealMoney, false);
});
