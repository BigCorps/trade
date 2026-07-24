import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyNews } from '../../lib/market-news/classifier';

test('classifica processo regulatório contra Ripple', () => { const item = classifyNews('SEC lawsuit against Ripple puts XRP under pressure'); assert.equal(item.category, 'regulacao'); assert.equal(item.direction, 'negativa'); assert.ok(item.assets.includes('XRPUSDT')); });
test('classifica aprovação de ETF como institucional positiva', () => { const item = classifyNews('Bitcoin ETF approved as institutional adoption grows'); assert.equal(item.category, 'institucional'); assert.equal(item.direction, 'positiva'); assert.ok(item.assets.includes('BTCUSDT')); });
test('classifica exploit como segurança negativa', () => { const item = classifyNews('Crypto protocol hacked in major exploit and funds stolen'); assert.equal(item.category, 'seguranca'); assert.equal(item.direction, 'negativa'); });
test('notícia macro sem direção explícita permanece incerta', () => { const item = classifyNews('Federal Reserve interest rate decision approaches'); assert.equal(item.category, 'macroeconomia'); assert.equal(item.direction, 'incerta'); });
