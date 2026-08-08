import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  resolverCandleAmbiguo,
  resolverPreenchimentoAlvo,
  resolverPreenchimentoStop,
} from '../../lib/daytrade/preenchimentoRealista';

test('gap adverso na abertura executa na abertura, não no stop', () => {
  // Comprado com stop em 100. O candle abre em 96 — gap de 4%.
  const fill = resolverPreenchimentoStop({
    direction: 'long',
    stopPrice: 100,
    candle: { open: 96, high: 97, low: 95, close: 96.5 },
    slippagePct: 0.05,
  });

  assert.equal(fill.triggered, true);
  assert.equal(fill.gapped, true);
  assert.equal(fill.reason, 'gap_na_abertura');
  // O modelo antigo devolveria ~99,95. O real é ~95,95.
  assert.ok(fill.fillPrice! < 96.1, `preenchimento ${fill.fillPrice}`);
  assert.ok(fill.gapCostPct > 3.9);
});

test('stop tocado sem gap executa no stop com slippage', () => {
  const fill = resolverPreenchimentoStop({
    direction: 'long',
    stopPrice: 100,
    candle: { open: 103, high: 104, low: 99, close: 101 },
    slippagePct: 0.05,
  });

  assert.equal(fill.triggered, true);
  assert.equal(fill.gapped, false);
  assert.ok(Math.abs(fill.fillPrice! - 99.95) < 0.01);
});

test('stop não tocado não aciona', () => {
  const fill = resolverPreenchimentoStop({
    direction: 'long',
    stopPrice: 100,
    candle: { open: 103, high: 105, low: 101, close: 104 },
  });
  assert.equal(fill.triggered, false);
  assert.equal(fill.fillPrice, null);
});

test('vendido: gap para cima é adverso', () => {
  const fill = resolverPreenchimentoStop({
    direction: 'short',
    stopPrice: 100,
    candle: { open: 104, high: 105, low: 103, close: 104 },
  });
  assert.equal(fill.gapped, true);
  assert.ok(fill.fillPrice! > 104);
});

test('gap favorável no alvo também é modelado', () => {
  // Sem isto o modelo ficaria pessimista de forma assimétrica.
  const fill = resolverPreenchimentoAlvo({
    direction: 'long',
    targetPrice: 110,
    candle: { open: 114, high: 115, low: 113, close: 114 },
  });
  assert.equal(fill.gapped, true);
  assert.ok(fill.fillPrice! > 113);
});

test('candle ambíguo resolve a favor do stop', () => {
  const stop = resolverPreenchimentoStop({
    direction: 'long',
    stopPrice: 100,
    candle: { open: 105, high: 112, low: 99, close: 106 },
  });
  const alvo = resolverPreenchimentoAlvo({
    direction: 'long',
    targetPrice: 110,
    candle: { open: 105, high: 112, low: 99, close: 106 },
  });

  const r = resolverCandleAmbiguo(stop, alvo);
  assert.equal(r.escolhido, 'stop');
  assert.equal(r.ambiguo, true);
});

test('gap aumenta o custo médio do stop acima de 1 R', () => {
  // Reproduz o efeito medido: stop custando 1,241 R em vez de 1,00 R.
  const entrada = 100;
  const stopPrice = 98;      // risco de 2%
  const risco = entrada - stopPrice;

  const candles = [
    { open: 99.5, high: 99.6, low: 97.0, close: 97.5 },  // tocou
    { open: 96.0, high: 96.5, low: 95.0, close: 95.5 },  // gap
    { open: 99.0, high: 99.2, low: 97.9, close: 98.0 },  // tocou
    { open: 94.0, high: 94.5, low: 93.0, close: 93.5 },  // gap grande
  ];

  const perdas = candles.map((candle) => {
    const fill = resolverPreenchimentoStop({
      direction: 'long', stopPrice, candle, slippagePct: 0.05,
    });
    return (entrada - fill.fillPrice!) / risco;
  });

  const media = perdas.reduce((a, b) => a + b, 0) / perdas.length;
  assert.ok(media > 1.2, `perda média ${media.toFixed(3)} R deveria superar 1,2`);
});
