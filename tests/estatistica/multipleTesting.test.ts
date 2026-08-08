import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  assessEvidence,
  deflatedSharpeRatio,
  expectedMaxTUnderNull,
  normalCdf,
  normalQuantile,
  oneSidedPValue,
  requiredSampleSize,
  requiredTStatistic,
  sidakFamilyWisePValue,
} from '../../lib/estatistica/multipleTesting';

import {
  assessExcursion,
  breakEvenWinRate,
  calculateCostTax,
  decomposeEdge,
} from '../../lib/estatistica/diagnostico';

const close = (actual: number, expected: number, tolerance = 0.01) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `esperado ~${expected}, recebido ${actual}`,
  );

// ---------------------------------------------------------------------------
// Normal
// ---------------------------------------------------------------------------

test('normalCdf em pontos conhecidos', () => {
  close(normalCdf(0), 0.5, 1e-6);
  close(normalCdf(1.96), 0.975, 1e-4);
  close(normalCdf(-1.96), 0.025, 1e-4);
  close(normalCdf(2.576), 0.995, 1e-4);
});

test('normalQuantile inverte normalCdf', () => {
  for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975, 0.99]) {
    close(normalCdf(normalQuantile(p)), p, 1e-5);
  }
});

// ---------------------------------------------------------------------------
// Correção por múltiplos testes
// ---------------------------------------------------------------------------

test('Šidák reproduz os p corrigidos da auditoria', () => {
  // Bateria 1d/2900d: 64 combinações, melhor t = +2,04
  const p1d = sidakFamilyWisePValue(oneSidedPValue(2.04), 64);
  close(p1d, 0.737, 0.02);

  // Bateria 4h/1100d: 72 combinações, melhor t = +1,75
  const p4h = sidakFamilyWisePValue(oneSidedPValue(1.75), 72);
  close(p4h, 0.947, 0.02);
});

test('piso de ruído reproduz os valores da auditoria', () => {
  close(expectedMaxTUnderNull(64), 2.20, 0.05);
  close(expectedMaxTUnderNull(72), 2.24, 0.05);
});

test('o melhor resultado histórico ficou ABAIXO do piso de ruído', () => {
  // Este é o achado central: o "vencedor" era menos que ruído.
  assert.ok(2.04 < expectedMaxTUnderNull(64));
  assert.ok(1.75 < expectedMaxTUnderNull(72));
  assert.ok(1.64 < expectedMaxTUnderNull(72));
});

test('limiar exigido cresce com o número de testes', () => {
  const um = requiredTStatistic(1);
  const setenta = requiredTStatistic(72);
  close(um, 1.645, 0.01);
  assert.ok(setenta > um);
  assert.ok(setenta > 3);
});

test('Sharpe deflacionado penaliza busca ampla', () => {
  const poucos = deflatedSharpeRatio({
    observedSharpe: 0.3, sampleSize: 200, numberOfTrials: 1,
  })!;
  const muitos = deflatedSharpeRatio({
    observedSharpe: 0.3, sampleSize: 200, numberOfTrials: 500,
  })!;
  assert.ok(poucos > muitos, 'buscar mais deveria reduzir a confiança');
});

test('amostra necessária cresce com o número de combinações', () => {
  const foco = requiredSampleSize(0.1, 1.3, 1)!;
  const busca = requiredSampleSize(0.1, 1.3, 72)!;
  assert.ok(busca > foco);
  // Edge de +0,1 R com desvio 1,3 exige centenas de operações.
  assert.ok(foco > 400, `esperado >400, recebido ${foco}`);
});

// ---------------------------------------------------------------------------
// Veredito
// ---------------------------------------------------------------------------

test('detecta o edge negativo real do forward test', () => {
  // trend_pullback 1h: n=39, média −0,694 R, desvio 1,283
  const r = assessEvidence({
    meanR: -0.694, standardDeviationR: 1.283, sampleSize: 39, numberOfTests: 8,
  });
  close(r.tStatistic!, -3.38, 0.05);
  assert.equal(r.verdict, 'negativo_significativo');
});

test('resultado bonito com busca ampla vira ruído', () => {
  // TRXUSDT: n=34, t≈2,04, mas 64 combinações foram testadas.
  const r = assessEvidence({
    meanR: 0.51, standardDeviationR: 1.46, sampleSize: 34, numberOfTests: 64,
  });
  assert.equal(r.verdict, 'indistinguivel_de_ruido');
});

test('o mesmo resultado sem busca ampla seria promissor', () => {
  const r = assessEvidence({
    meanR: 0.51, standardDeviationR: 1.46, sampleSize: 34, numberOfTests: 1,
  });
  assert.notEqual(r.verdict, 'indistinguivel_de_ruido');
});

test('amostra pequena nunca aprova', () => {
  const r = assessEvidence({
    meanR: 2.0, standardDeviationR: 1.0, sampleSize: 5, numberOfTests: 1,
  });
  assert.equal(r.verdict, 'amostra_insuficiente');
});

test('edge forte e busca estreita é aprovado', () => {
  const r = assessEvidence({
    meanR: 0.35, standardDeviationR: 1.0, sampleSize: 400, numberOfTests: 2,
  });
  assert.equal(r.verdict, 'aprovado');
});

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

test('ponto de equilíbrio com o payoff real medido', () => {
  close(breakEvenWinRate(1.789, 1.241)!, 0.4096, 0.001);
  close(breakEvenWinRate(2.01, 1.0)!, 0.3322, 0.001);
});

test('decomposição reproduz os números da auditoria', () => {
  const d = decomposeEdge({
    wins: 31,
    losses: 101,
    actualAverageWinR: 1.789,
    actualAverageLossR: 1.241,
    plannedRewardToRisk: 2.01,
  });

  close(d.actualExpectancyR, -0.530, 0.005);
  close(d.frictionlessExpectancyR, -0.293, 0.005);
  close(d.frictionContributionR, -0.236, 0.005);
  close(d.slippageBeyondOneR, 0.241, 0.001);
  close(d.winRate, 0.2348, 0.001);
  assert.equal(d.primaryProblem, 'ambos');
});

test('imposto de custo do cenário 1h', () => {
  const t = calculateCostTax({
    stopDistancePctOfPrice: 1.647, feeRatePct: 0.1, slippagePct: 0.05,
  });
  close(t.costAsSharePct, 18.2, 0.2);
  assert.equal(t.severity, 'alto');
});

test('taxa de futuros com desconto reduz o imposto', () => {
  const spot = calculateCostTax({
    stopDistancePctOfPrice: 1.647, feeRatePct: 0.1, slippagePct: 0.05,
  });
  const futuros = calculateCostTax({
    stopDistancePctOfPrice: 1.647, feeRatePct: 0.018, slippagePct: 0.03,
  });
  assert.ok(futuros.costAsSharePct < spot.costAsSharePct / 2);
});

test('MFE baixa nas perdedoras descarta ajuste de gestão', () => {
  const e = assessExcursion({
    averageFavourableExcursionOnLosersR: 0.44,
    maximumFavourableExcursionOnLosersR: 1.99,
    losers: 101,
  });
  assert.equal(e.entryHasFollowThrough, false);
  assert.equal(e.managementCanHelp, false);
});

test('MFE alta nas perdedoras justifica ajuste de gestão', () => {
  const e = assessExcursion({
    averageFavourableExcursionOnLosersR: 1.4,
    maximumFavourableExcursionOnLosersR: 3.2,
    losers: 80,
  });
  assert.equal(e.managementCanHelp, true);
});
