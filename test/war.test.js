import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newNation, stats, tick, groundAssault, sizeFactor, isProtected, readinessFactor, WAR, CONFIG } from '../src/game.js';

const T0 = Date.UTC(2026, 9, 21, 12);
const LATER = T0 + 4 * 864e5; // past new-player protection
const pair = () => {
  const a = newNation('Attacker', T0), d = newNation('Defender', T0);
  a.units.tank = 400; // offence 200×1 + 400×5 = 2,200 vs defence 560
  return [a, d];
};
const NO_SWING = () => 0.5;

test('a strong assault wins, takes land and buildings, and costs 2 turns', () => {
  const [a, d] = pair();
  const r = groundAssault(a, d, { infantry: 200, tank: 400 }, LATER, { rng: NO_SWING });
  assert.ok(r.success);
  // 7% of 250 × min(1.5, 2200/560) × size 1 × repeat 1 = 26.25 → 26
  assert.equal(r.acres, 26);
  assert.equal(d.land, 224);
  assert.ok(stats(d).built < 100, 'defender lost buildings with the land');
  assert.equal(a.turns, CONFIG.startTurns - 2);
  assert.equal(a.land, 250, 'land is not here yet');
  for (let i = 0; i < WAR.captureTicks - 1; i++) tick(a, LATER);
  assert.equal(a.land, 250);
  tick(a, LATER);
  assert.equal(a.land, 276, 'arrives after exactly 8 turns');
  assert.ok(a.buildings.housing > 30, 'some captured buildings survive');
});

test('casualties: winners lose 7% of units sent, defenders 4%', () => {
  const [a, d] = pair();
  const r = groundAssault(a, d, { infantry: 200, tank: 400 }, LATER, { rng: NO_SWING });
  assert.deepEqual(r.attLost, { infantry: 14, tank: 28 });
  assert.equal(d.units.infantry, 200 - 8);
  assert.equal(d.units.artillery, 20 - 1);
});

test('a weak assault is driven back with heavier losses and no land', () => {
  const [a, d] = pair();
  const r = groundAssault(a, d, { infantry: 100 }, LATER, { rng: NO_SWING });
  assert.ok(!r.success);
  assert.equal(r.acres, 0);
  assert.equal(a.units.infantry, 200 - 14);
  assert.equal(d.land, 250);
  assert.ok(!a.queue.some(q => q.kind === 'capture'));
});

test('the ±5% swing decides close fights', () => {
  const [a, d] = pair();
  d.units.artillery = 0; d.units.tank = 0; d.units.infantry = 300; // defence 600
  const sent = { infantry: 600 }; a.units.infantry = 600;            // offence 600
  const low = groundAssault(structuredClone(a), structuredClone(d), sent, LATER, { rng: () => 0 });
  const high = groundAssault(structuredClone(a), structuredClone(d), sent, LATER, { rng: () => 1 });
  assert.ok(!low.success && high.success);
});

test('repeat hits within 24 hours give 70% each time', () => {
  const [a, d] = pair();
  const first = groundAssault(structuredClone(a), structuredClone(d), { tank: 400 }, LATER, { rng: NO_SWING });
  const third = groundAssault(structuredClone(a), structuredClone(d), { tank: 400 }, LATER, { rng: NO_SWING, recentHits: 2 });
  assert.equal(third.acres, Math.floor(first.acres * 0.49) || 1);
});

test('size limits: tiny targets blocked, small ones give less, big ones a bit more', () => {
  assert.equal(sizeFactor(1000, 300), 0);
  assert.equal(sizeFactor(1000, 500), 0.25);
  assert.equal(sizeFactor(1000, 900), 1);
  assert.equal(sizeFactor(1000, 3000), 1.2);
  const [a, d] = pair();
  a.land = 1000;
  assert.throws(() => groundAssault(a, d, { tank: 10 }, LATER), /too small/);
});

test('new players are protected; attacking ends your own protection; AI never protected', () => {
  const [a, d] = pair();
  assert.ok(isProtected(d, T0 + 3600e3));
  assert.throws(() => groundAssault(a, d, { tank: 400 }, T0 + 3600e3), /protection/);
  d.ticks = 200;
  assert.ok(!isProtected(d, T0 + 3600e3), '200 turns used ends it early');
  const [a2, d2] = pair();
  d2.bot = { style: 'builder', skill: 1 };
  assert.ok(!isProtected(d2, T0));
  groundAssault(a2, d2, { tank: 400 }, T0, { rng: NO_SWING });
  assert.ok(!isProtected(a2, T0), 'attacker loses their own protection');
});

test('readiness: 8 per attack, back 1 per turn, offence penalty under 50', () => {
  const [a, d] = pair();
  groundAssault(a, d, { tank: 100 }, LATER, { rng: NO_SWING });
  assert.equal(a.readiness, 100 - 8 + 2, 'two turns of recovery during the assault');
  a.readiness = 30;
  assert.ok(Math.abs(readinessFactor(a) - 0.8) < 1e-9);
});

test('rules that block an assault leave both nations untouched', () => {
  const [a, d] = pair();
  const before = JSON.stringify([a, d]);
  assert.throws(() => groundAssault(a, d, { tank: 9999 }, LATER), /only have/);
  assert.throws(() => groundAssault(a, d, { artillery: 5 }, LATER), /infantry and tanks/);
  assert.throws(() => groundAssault(a, d, {}, LATER), /Choose some/);
  a.oil = 0;
  assert.throws(() => groundAssault(a, d, { tank: 10 }, LATER), /oil/);
  a.oil = 1000; a.turns = 1;
  assert.throws(() => groundAssault(a, d, { tank: 10 }, LATER), /2 turns/);
  a.turns = CONFIG.startTurns;
  assert.equal(JSON.stringify([a, d]), before);
});
