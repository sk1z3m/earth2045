// Earth: 2045 — AI-controlled nations.
// Each AI nation is a normal nation with a play style. A scheduled job wakes
// them every 30 minutes; they spend their turns through the same actions a
// player uses, so they can never break the rules.

import { applyAction, newNation, stats, BUILDINGS, UNITS, GameError } from './game.js';

// tax: % they set · invest: share of cash spent on buildings · army: share spent on units
// density: troops per acre they aim to keep
// build / units: how they split what they buy
export const STYLES = {
  builder: {
    label: 'Builder', density: 0.6, tax: 35, invest: 0.8, army: 0.15,
    build: { housing: 3, industry: 4, farm: 1, oilRig: 1, barracks: 1, yard: 1 },
    units: { infantry: 3, artillery: 1 },
  },
  warlord: {
    label: 'Warlord', density: 2, tax: 45, invest: 0.6, army: 0.45,
    build: { housing: 2, industry: 3, farm: 1, oilRig: 2, barracks: 3 },
    units: { infantry: 2, tank: 3, jet: 1 },
  },
  turtle: {
    label: 'Turtle', density: 1.5, tax: 35, invest: 0.65, army: 0.35,
    build: { housing: 2, industry: 3, farm: 1, oilRig: 1, barracks: 2, grid: 2 },
    units: { infantry: 2, artillery: 3 },
  },
  farmer: {
    label: 'Farmer', density: 0.6, tax: 30, invest: 0.7, army: 0.15,
    build: { housing: 3, industry: 3, farm: 3, oilRig: 2, barracks: 1 },
    units: { infantry: 3, artillery: 1 },
  },
  scientist: {
    label: 'Scientist', density: 0.8, tax: 40, invest: 0.7, army: 0.2,
    build: { housing: 2, industry: 3, farm: 1, oilRig: 1, barracks: 1, lab: 3 },
    units: { infantry: 2, artillery: 1, spy: 1 },
  },
};

// Invented nations. skill (0.6–1) scales how much of their cash they put to work.
export const ROSTER = [
  ['Valdris', 'warlord', 0.95],
  ['Kessmark', 'builder', 0.9],
  ['Aurelian League', 'scientist', 0.85],
  ['Tornhold', 'turtle', 0.8],
  ['Sarvenna', 'farmer', 0.75],
  ['Quellis', 'builder', 0.7],
  ['Draymoor', 'warlord', 0.75],
  ['Ilvaran Republic', 'scientist', 0.65],
  ['Brennoch', 'turtle', 0.7],
  ['Caldera Union', 'farmer', 0.6],
];

export function newBot([name, style, skill], now) {
  const n = newNation(name, now);
  n.bot = { style, skill };
  n.log = [{ at: now, text: `${name} was founded.` }];
  return n;
}

// Spend up to maxTurns turns. Returns how many were used.
export function botPlay(n, now, maxTurns = 12) {
  const style = STYLES[n.bot?.style] ?? STYLES.builder;
  const skill = n.bot?.skill ?? 0.8;
  if (n.tax !== style.tax) applyAction(n, { type: 'setTax', rate: style.tax }, now);

  let used = 0;
  while (n.turns > 0 && used < maxTurns) {
    used++;
    let acted = false;
    try {
      acted = step(n, now, style, skill);
    } catch (err) {
      if (!(err instanceof GameError)) throw err; // a rule said no: just pass the turn
    }
    if (!acted) applyAction(n, { type: 'useTurns', count: 1 }, now);
  }
  // Keep only the AI's last few report lines; nobody reads them.
  n.log.length = Math.min(n.log.length, 10);
  return used;
}

function step(n, now, style, skill) {
  const s = stats(n);

  // 1. Fix shortages before anything else.
  if (s.foodPerTick < 0 && s.freeLand > 0) {
    return build(n, now, { farm: Math.min(s.freeLand, Math.ceil(-s.foodPerTick / 40) + 2) });
  }
  if (s.oilPerTick < 0 && s.freeLand > 0) {
    return build(n, now, { oilRig: Math.min(s.freeLand, Math.ceil(-s.oilPerTick / 30) + 1) });
  }

  // 2. Keep the army at the style's size before growing further.
  //    Units still in training count, so the AI doesn't keep re-ordering.
  const inTraining = n.queue.filter(q => q.kind === 'unit' && UNITS[q.type].troop).reduce((t, q) => t + q.count, 0);
  const gap = Math.floor(n.land * style.density * skill) - s.troops - inTraining;
  if (gap > 0 && trainUnits(n, now, style, skill, s, gap)) return true;

  // 3. Build on free land, in the style's mix.
  if (s.freeLand >= 4) {
    const w = style.build, wt = total(w);
    const avgCost = Object.entries(w).reduce((t, [k, v]) => t + BUILDINGS[k].cost * v, 0) / wt * (1 - s.buildDiscount);
    const count = Math.min(s.freeLand, Math.floor((n.cash * style.invest * skill) / avgCost));
    if (count >= 2) return build(n, now, split(w, count));
  }

  // 4. Land nearly full: explore if it's affordable.
  if (s.freeLand < 10 && n.cash * skill > s.explorePerTurn * 1.5) {
    applyAction(n, { type: 'explore', batches: 1 }, now);
    return true;
  }

  return false; // nothing worth doing: just run the economy
}

// Buy up to `gap` troops in the style's mix, if there's barracks space and income to pay upkeep.
function trainUnits(n, now, style, skill, s, gap) {
  const budget = n.cash * style.army * skill;
  if (budget < 2000 || s.cashPerTick < 500 || s.troops > s.barracksCap * 1.1 + 50) return false;
  const w = style.units, wt = total(w);
  const items = {};
  for (const [k, v] of Object.entries(w)) {
    const byCash = Math.floor((budget * v / wt) / UNITS[k].cost);
    const byGap = UNITS[k].troop ? Math.ceil(gap * v / wt) : Math.ceil(gap * v / wt / 20); // ~1 spy per 20 troops
    const c = Math.min(byCash, byGap);
    if (c > 0) items[k] = c;
  }
  if (!Object.keys(items).length) return false;
  applyAction(n, { type: 'train', items }, now);
  return true;
}

function build(n, now, items) {
  applyAction(n, { type: 'build', items }, now);
  return true;
}

const total = w => Object.values(w).reduce((t, v) => t + v, 0);

// Split `count` into whole numbers in proportion to the weights.
function split(weights, count) {
  const wt = total(weights);
  const out = {};
  let given = 0;
  for (const [k, v] of Object.entries(weights)) {
    out[k] = Math.floor(count * v / wt);
    given += out[k];
  }
  const top = Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
  out[top] += count - given;
  return out;
}
