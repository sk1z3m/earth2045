// Run with: npm test   (uses Node's built-in test runner, no install needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNation, accrueTurns, applyAction, stats, tick, CONFIG, GameError } from '../src/game.js';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const TURN = CONFIG.turnMinutes * 60 * 1000;
const fresh = () => newNation('Testland', T0);

test('new nation matches the design doc', () => {
  const n = fresh();
  const s = stats(n);
  assert.equal(n.land, 250);
  assert.equal(s.built, 100);
  assert.equal(s.freeLand, 150);
  assert.equal(n.turns, CONFIG.startTurns);
  assert.ok(s.cashPerTick > 0, 'starting economy should make money');
  assert.ok(s.foodPerTick > 0, 'starting economy should not starve');
  assert.ok(s.oilPerTick > 0, 'starting economy should not run out of oil');
});

test('turns accrue from the clock and stop at the cap', () => {
  const n = fresh();
  accrueTurns(n, T0 + TURN * 3 + 1000);
  assert.equal(n.turns, CONFIG.startTurns + 3);
  assert.equal(n.lastTurnAt, T0 + TURN * 3); // partial progress toward the next turn is kept
  accrueTurns(n, T0 + TURN * 10_000);
  assert.equal(n.turns, CONFIG.turnCap);
});

test('using turns runs ticks and grows the nation', () => {
  const n = fresh();
  const cash = n.cash, pop = n.population;
  applyAction(n, { type: 'useTurns', count: 5 }, T0);
  assert.equal(n.turns, CONFIG.startTurns - 5);
  assert.equal(n.ticks, 5);
  assert.ok(n.cash > cash);
  assert.ok(n.population > pop);
});

test('cannot spend more turns than you have', () => {
  const n = fresh();
  assert.throws(() => applyAction(n, { type: 'useTurns', count: 999 }, T0), GameError);
  assert.equal(n.turns, CONFIG.startTurns);
});

test('exploring adds land and costs cash', () => {
  const n = fresh();
  const s = stats(n);
  applyAction(n, { type: 'explore', batches: 1 }, T0);
  assert.equal(n.land, 250 + s.exploreAcres);
  assert.equal(n.turns, CONFIG.startTurns - 1);
});

test('buildings finish after exactly 8 more turns', () => {
  const n = fresh();
  applyAction(n, { type: 'build', items: { housing: 10 } }, T0);
  assert.equal(n.buildings.housing, 30);
  assert.equal(stats(n).freeLand, 140); // queued buildings reserve their acres
  for (let i = 0; i < 7; i++) tick(n, T0);
  assert.equal(n.buildings.housing, 30);
  tick(n, T0);
  assert.equal(n.buildings.housing, 40);
});

test('cannot build on more land than is free', () => {
  const n = fresh();
  assert.throws(() => applyAction(n, { type: 'build', items: { farm: 151 } }, T0), /free acres/);
});

test('training costs cash and arrives after 4 turns', () => {
  const n = fresh();
  const cash = n.cash;
  applyAction(n, { type: 'train', items: { tank: 10 } }, T0);
  assert.ok(n.cash < cash);
  for (let i = 0; i < 4; i++) tick(n, T0);
  assert.equal(n.units.tank, 30);
});

test('bad input is rejected', () => {
  const n = fresh();
  assert.throws(() => applyAction(n, { type: 'build', items: { castle: 1 } }, T0), GameError);
  assert.throws(() => applyAction(n, { type: 'train', items: { tank: -5 } }, T0), GameError);
  assert.throws(() => applyAction(n, { type: 'train', items: { tank: 1.5 } }, T0), GameError);
  assert.throws(() => applyAction(n, { type: 'setTax', rate: 95 }, T0), GameError);
  assert.throws(() => applyAction(n, { type: 'hack' }, T0), GameError);
});

test('running out of food costs people and troops', () => {
  const n = fresh();
  n.buildings.farm = 0;
  n.food = 0;
  const pop = n.population, inf = n.units.infantry;
  tick(n, T0);
  assert.equal(n.food, 0);
  assert.ok(n.population < pop + 1000); // growth is partly offset by the loss
  assert.ok(n.units.infantry < inf);
});

test('a full day of idle turns keeps the starting nation solvent', () => {
  const n = fresh();
  for (let i = 0; i < 96; i++) tick(n, T0);
  assert.ok(n.cash > 0 && n.food > 0 && n.oil > 0);
});
