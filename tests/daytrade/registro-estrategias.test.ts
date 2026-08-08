import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DAYTRADE_STRATEGY_IDS,
  DAYTRADE_STRATEGY_REGISTRY,
  EXECUTABLE_DAYTRADE_STRATEGY_IDS,
  isDayTradeStrategyId,
} from '../../lib/daytrade/strategies';

import {
  getBacktestStrategyDescriptor,
  getDefaultMaximumNextOpenDistanceAtr,
  evaluateCommonBacktestStrategy,
} from '../../lib/daytrade/strategies/backtestAdapter';

import { calculateDayTradeIndicators } from '../../lib/daytrade/indicators';
import type {
  DayTradeCandle,
  DayTradeIndicatorOptions,
} from '../../lib/daytrade/indicators';

/** Opções mínimas para timeframe de 1 hora. */
const OPCOES_1H: DayTradeIndicatorOptions = {
  periodsPerYear: 24 * 365,
  volatilityWindow: 60,
};

// ---------------------------------------------------------------------------
// Candles sintéticos: tendência de alta com rompimento no último candle.
// ---------------------------------------------------------------------------

function buildTrendingCandles(count = 260): DayTradeCandle[] {
  const candles: DayTradeCandle[] = [];
  let price = 100;

  for (let index = 0; index < count; index += 1) {
    const open = price;
    const drift = 0.35;
    const close = open + drift;
    const high = close + 0.25;
    const low = open - 0.2;

    candles.push({
      openTime: index * 3_600_000,
      closeTime: (index + 1) * 3_600_000 - 1,
      open,
      high,
      low,
      close,
      volume: 1_000,
    });

    price = close;
  }

  // Último candle: rompimento com corpo dominante e volume alto.
  const last = candles[candles.length - 1];
  last.close = last.open + 2.4;
  last.high = last.close + 0.1;
  last.low = last.open - 0.05;
  last.volume = 4_000;

  return candles;
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

test('as quatro estratégias originais continuam registradas', () => {
  for (const id of [
    'trend_breakout',
    'trend_pullback',
    'squeeze_breakout',
    'range_mean_reversion',
  ]) {
    assert.ok(
      DAYTRADE_STRATEGY_IDS.includes(id as never),
      `${id} sumiu do registro`,
    );
  }
});

test('confirmed_trend_continuation entrou no registro', () => {
  assert.ok(isDayTradeStrategyId('confirmed_trend_continuation'));
  assert.ok(
    DAYTRADE_STRATEGY_IDS.includes('confirmed_trend_continuation' as never),
  );
});

test('nenhuma estratégia ganhou autorização de ordem automática', () => {
  // Esta é a trava mais importante do arquivo. Se um dia falhar, alguma
  // estratégia passou a poder criar ordens sem passar pelo portão estatístico.
  assert.equal(
    EXECUTABLE_DAYTRADE_STRATEGY_IDS.length,
    0,
    'alguma estratégia ficou autorizada a criar ordens',
  );
});

test('a nova estratégia entrou como shadow', () => {
  const definicao =
    DAYTRADE_STRATEGY_REGISTRY.confirmed_trend_continuation;

  assert.equal(definicao.executionMode, 'shadow');
  assert.equal(definicao.authorizedForAutomaticOrders, false);
  assert.equal(definicao.enabledForBacktest, true);
});

// ---------------------------------------------------------------------------
// Adaptador de backtest
// ---------------------------------------------------------------------------

test('o adaptador resolve a nova estratégia sem lançar', () => {
  const descritor = getBacktestStrategyDescriptor(
    'confirmed_trend_continuation',
    OPCOES_1H,
  );

  assert.equal(descritor.id, 'confirmed_trend_continuation');
  assert.ok(descritor.requiredCandleCount > 0);
  assert.ok(descritor.defaultMaximumNextOpenDistanceAtr > 0);
});

test('as opções da nova estratégia chegam ao adaptador', () => {
  const padrao = getDefaultMaximumNextOpenDistanceAtr(
    'confirmed_trend_continuation',
  );

  const customizado = getDefaultMaximumNextOpenDistanceAtr(
    'confirmed_trend_continuation',
    {
      confirmed_trend_continuation: {
        maximumLateEntryDistanceAtr: 0.9,
      },
    },
  );

  assert.notEqual(padrao, 0.9);
  assert.equal(customizado, 0.9);
});

test('a avaliação comum devolve o formato esperado', () => {
  const candles = buildTrendingCandles();
  const indicators = calculateDayTradeIndicators(candles, OPCOES_1H);

  const avaliacao = evaluateCommonBacktestStrategy({
    strategyId: 'confirmed_trend_continuation',
    candles,
    indicators,
  });

  assert.equal(avaliacao.strategy, 'confirmed_trend_continuation');
  assert.equal(avaliacao.direction, 'long');

  // Campos que o formato comum exige e que a estratégia não declarava:
  // precisam existir como número, nunca undefined.
  assert.equal(typeof avaliacao.diagnostics.ready, 'boolean');
  assert.equal(typeof avaliacao.diagnostics.candleCount, 'number');
  assert.equal(typeof avaliacao.diagnostics.requiredCandles, 'number');
  assert.equal(typeof avaliacao.diagnostics.missingCandles, 'number');
  assert.equal(typeof avaliacao.diagnostics.volatilityRegime, 'string');
  assert.ok(
    avaliacao.diagnostics.relativeVolume === null ||
      typeof avaliacao.diagnostics.relativeVolume === 'number',
  );
});

test('as estratégias antigas continuam avaliando igual', () => {
  const candles = buildTrendingCandles();
  const indicators = calculateDayTradeIndicators(candles, OPCOES_1H);

  for (const id of ['trend_breakout', 'trend_pullback'] as const) {
    const avaliacao = evaluateCommonBacktestStrategy({
      strategyId: id,
      candles,
      indicators,
    });

    assert.equal(avaliacao.strategy, id);
    assert.equal(avaliacao.direction, 'long');
    assert.equal(typeof avaliacao.scorePct, 'number');
    assert.equal(typeof avaliacao.diagnostics.requiredCandles, 'number');
  }
});

// ---------------------------------------------------------------------------
// Estratégia vendida
// ---------------------------------------------------------------------------

test('failed_breakout_reversal foi registrada somente em shadow', () => {
  assert.equal(isDayTradeStrategyId('failed_breakout_reversal'), true);

  const definicao = DAYTRADE_STRATEGY_REGISTRY.failed_breakout_reversal;
  assert.equal(definicao.executionMode, 'shadow');
  assert.equal(definicao.authorizedForAutomaticOrders, false);
  assert.equal(definicao.enabledForBacktest, true);
});

test('adaptador preserva a direção short da reversão de falso rompimento', () => {
  const candles = buildTrendingCandles();
  const indicators = calculateDayTradeIndicators(candles, OPCOES_1H);
  const avaliacao = evaluateCommonBacktestStrategy({
    strategyId: 'failed_breakout_reversal',
    candles,
    indicators,
  });

  assert.equal(avaliacao.strategy, 'failed_breakout_reversal');
  assert.equal(avaliacao.direction, 'short');

  const descritor = getBacktestStrategyDescriptor(
    'failed_breakout_reversal',
    OPCOES_1H,
  );
  assert.equal(descritor.defaultMaximumNextOpenDistanceAtr, 0.35);
});
