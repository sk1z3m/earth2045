import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrueTurns, stats, newNation, CONFIG } from '../src/game.js';
import { botPlay, newBot, ROSTER, STYLES, chooseTarget, attackPlan } from '../src/bots.js';

const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
const HALF_HOUR = 30 * 60 * 1000;

// Run a nation the way the scheduled job does: wake every 30 minutes.
function simulate(n, days) {
  for (let t = T0 + HALF_HOUR; t <= T0 + days * 864e5; t += HALF_HOUR) {
    accrueTurns(n, t);
    botPlay(n, t);
  }
  return n;
}

test('every roster entry uses a real style', () => {
  for (const [, style] of ROSTER) assert.ok(STYLES[style], style);
  assert.equal(new Set(ROSTER.map(r => r[0])).size, ROSTER.length, 'names are unique');
});

test('a bot spends turns but never more than the cap per wake-up', () => {
  const n = newBot(ROSTER[0], T0);
  const used = botPlay(n, T0, 12);
  assert.equal(used, 12);
  assert.equal(n.turns, CONFIG.startTurns - 12);
});

test('every style survives and grows over a simulated week', () => {
  for (const entry of ROSTER) {
    const n = simulate(newBot(entry, T0), 7);
    const s = stats(n);
    assert.ok(n.land > 250, `${entry[0]} should explore (land ${n.land})`);
    assert.ok(s.built > 100, `${entry[0]} should build`);
    assert.ok(n.cash >= 0 && n.food >= 0, `${entry[0]} stays solvent`);
    assert.ok(s.troops >= 200, `${entry[0]} keeps an army (${s.troops})`);
    assert.ok(s.freeLand >= 0);
  }
});

test('styles play differently', () => {
  const war = simulate(newBot(['W', 'warlord', 0.9], T0), 7);
  const farm = simulate(newBot(['F', 'farmer', 0.9], T0), 7);
  assert.ok(stats(war).offence > stats(farm).offence, 'warlord has more offence');
  assert.ok(farm.buildings.farm > war.buildings.farm, 'farmer has more farms');
});

test('a human who only uses turns is not out-grown by the weakest bot in a day (sanity print)', () => {
  const weakest = simulate(newBot(ROSTER.at(-1), T0), 1);
  const idle = newNation('Idle', T0);
  assert.ok(weakest.land >= idle.land);
  // Print a week of growth per bot for balancing.
  const rows = ROSTER.map(e => { const n = simulate(newBot(e, T0), 7); return `${e[0].padEnd(18)} ${e[1].padEnd(10)} land ${n.land}  networth ${stats(n).networth}`; });
  console.log('\n' + rows.join('\n'));
});


const LATE = T0 + 4 * 864e5;
const asCandidate = (id, n) => ({ id, nation: n });

test('turtles never pick fights; warlords do', () => {
  const turtle = newBot(['T', 'turtle', 1], T0), warlord = newBot(['W', 'warlord', 1], T0);
  const target = asCandidate(2, newBot(['X', 'builder', 1], T0));
  assert.equal(chooseTarget(turtle, [target], {}, LATE, () => 0), null);
  assert.equal(chooseTarget(warlord, [target], {}, LATE, () => 0)?.id, 2);
  assert.equal(chooseTarget(warlord, [target], {}, LATE, () => 0.99), null, 'aggression roll can say no');
});

test('AI targets: no shields, sensible size, not already hit twice today', () => {
  const w = newBot(['W', 'warlord', 1], T0);
  const shielded = asCandidate(2, newNation('Newbie', LATE));            // human founded just now
  const tiny = asCandidate(3, Object.assign(newBot(['Tiny', 'builder', 1], T0), { land: 100 }));
  const huge = asCandidate(4, Object.assign(newBot(['Huge', 'builder', 1], T0), { land: 1000 }));
  const sore = asCandidate(5, newBot(['Sore', 'builder', 1], T0));
  assert.equal(chooseTarget(w, [shielded, tiny, huge, sore], { 5: 2 }, LATE, () => 0), null);
  const fine = asCandidate(6, newBot(['Fine', 'farmer', 1], T0));
  assert.equal(chooseTarget(w, [shielded, tiny, huge, sore, fine], { 5: 2 }, LATE, () => 0)?.id, 6);
});

test('AI needs readiness and turns to attack', () => {
  const w = newBot(['W', 'warlord', 1], T0);
  const t = asCandidate(2, newBot(['X', 'builder', 1], T0));
  w.readiness = 40;
  assert.equal(chooseTarget(w, [t], {}, LATE, () => 0), null);
  w.readiness = 100; w.turns = 2;
  assert.equal(chooseTarget(w, [t], {}, LATE, () => 0), null);
});

test('AI attacks only with a clear margin', () => {
  const w = newBot(['W', 'warlord', 1], T0);           // offence 300
  assert.equal(attackPlan(w, { defence: 560 }), null);
  assert.deepEqual(attackPlan(w, { defence: 200 }), { infantry: 200, tank: 20 });
  w.oil = 0;
  assert.deepEqual(attackPlan(w, { defence: 100 }), { infantry: 200, tank: 0 }, 'no oil: leaves tanks home');
});
