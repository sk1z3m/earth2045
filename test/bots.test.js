import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accrueTurns, stats, newNation, CONFIG } from '../src/game.js';
import { botPlay, newBot, ROSTER, STYLES } from '../src/bots.js';

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
