import test from 'node:test';
import assert from 'node:assert/strict';
import { combineForwardStatistics } from '../../lib/forward-test/statistics';

test('combina estatísticas por soma de quadrados', () => {
  const stats = combineForwardStatistics([
    { operacoes_fechadas: 2, ganhos: 1, perdas: 1, soma_r_fixo: 0, soma_quadrados_r_fixo: 2, ganho_bruto_r: 1, perda_bruta_r: -1, soma_r_anti: 0.5, max_drawdown_r_fixo: 1, max_drawdown_r_anti: 1.5 },
    { operacoes_fechadas: 2, ganhos: 2, perdas: 0, soma_r_fixo: 4, soma_quadrados_r_fixo: 8, ganho_bruto_r: 4, perda_bruta_r: 0, soma_r_anti: 5, max_drawdown_r_fixo: 0, max_drawdown_r_anti: 0 },
  ]);
  assert.equal(stats.closed, 4);
  assert.equal(stats.meanR, 1);
  assert.ok(stats.standardDeviationR !== null);
  assert.ok(Math.abs(stats.standardDeviationR - Math.sqrt(2)) < 1e-12);
  assert.equal(stats.profitFactor, 5);
  assert.equal(stats.deltaAntiR, 1.5);
});

test('uma operação não fabrica IC95', () => {
  const stats = combineForwardStatistics([{ operacoes_fechadas: 1, ganhos: 1, perdas: 0, soma_r_fixo: 1, soma_quadrados_r_fixo: 1 }]);
  assert.equal(stats.standardDeviationR, null);
  assert.equal(stats.confidence95LowerR, null);
});
