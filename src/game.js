// Earth: 2045 — game rules (stage 1: single-player core).
// Pure functions only: no database, no network. The Worker loads a nation,
// calls these, and saves the result. Every number here comes from the design
// doc and is meant to be tuned in playtesting.

export const CONFIG = {
  turnMinutes: 15,      // 1 turn every 15 minutes (96 a day)
  turnCap: 240,         // max banked turns
  startTurns: 100,
  buildTicks: 8,        // buildings finish over 8 ticks
  trainTicks: 4,        // units arrive after 4 ticks
  taxMin: 10,           // tax slider, percent
  taxMax: 70,
  logSize: 40,          // report entries kept
};

export const BUILDINGS = {
  housing:  { name: 'Housing',           cost: 400,  effect: '+60 population cap' },
  industry: { name: 'Industry',          cost: 800,  effect: '+120 cash a turn' },
  farm:     { name: 'Farm',              cost: 500,  effect: '+40 food a turn' },
  oilRig:   { name: 'Oil rig',           cost: 900,  effect: '+30 oil a turn' },
  barracks: { name: 'Barracks',          cost: 700,  effect: 'Houses 50 troops' },
  lab:      { name: 'Research lab',      cost: 1200, effect: '+1 tech point every 4 turns' },
  grid:     { name: 'Defence grid',      cost: 1000, effect: '+1% defence (max +25%)' },
  yard:     { name: 'Construction yard', cost: 1000, effect: 'Cheaper building (max −40%)' },
};

export const UNITS = {
  infantry:  { name: 'Infantry',  cost: 100, off: 1, def: 2, upkeep: 1, oil: 0, troop: true },
  tank:      { name: 'Tank',      cost: 450, off: 5, def: 2, upkeep: 3, oil: 1, troop: true },
  artillery: { name: 'Artillery', cost: 400, off: 1, def: 6, upkeep: 3, oil: 0, troop: true },
  jet:       { name: 'Jet',       cost: 750, off: 6, def: 1, upkeep: 5, oil: 2, troop: true },
  spy:       { name: 'Spy',       cost: 300, off: 0, def: 0, upkeep: 2, oil: 0, troop: false },
};

const TURN_MS = CONFIG.turnMinutes * 60 * 1000;

export class GameError extends Error {}

// ---------- creating and reading a nation ----------

export function newNation(name, now) {
  return {
    name,
    land: 250,
    cash: 20000,
    food: 5000,
    oil: 1000,
    population: 3000,
    tax: 30,
    techPoints: 0,
    buildings: { housing: 30, industry: 25, farm: 25, oilRig: 10, barracks: 10, lab: 0, grid: 0, yard: 0 },
    units: { infantry: 200, tank: 20, artillery: 20, jet: 0, spy: 10 },
    queue: [],            // { kind: 'building'|'unit', type, count, ticks }
    turns: CONFIG.startTurns,
    lastTurnAt: now,
    ticks: 0,
    log: [{ at: now, text: `${name} was founded with 250 acres.` }],
    createdAt: now,
  };
}

// Turns are not added by a timer: they are worked out from the clock
// whenever the nation is loaded. This can't drift and costs nothing while idle.
export function accrueTurns(n, now) {
  const earned = Math.floor((now - n.lastTurnAt) / TURN_MS);
  if (earned <= 0) return n;
  n.turns = Math.min(CONFIG.turnCap, n.turns + earned);
  n.lastTurnAt = n.turns >= CONFIG.turnCap ? now : n.lastTurnAt + earned * TURN_MS;
  return n;
}

export function nextTurnAt(n) {
  return n.turns >= CONFIG.turnCap ? null : n.lastTurnAt + TURN_MS;
}

const sum = (obj, f) => Object.entries(obj).reduce((t, [k, v]) => t + f(k, v), 0);

export function stats(n) {
  const b = n.buildings, u = n.units;
  const built = sum(b, (_, v) => v);
  const queuedBuildings = n.queue.filter(q => q.kind === 'building').reduce((t, q) => t + q.count, 0);
  const freeLand = n.land - built - queuedBuildings;
  const popCap = 20 * n.land + 60 * b.housing;

  const troops = sum(u, (k, v) => (UNITS[k].troop ? v : 0));
  const barracksCap = 50 * b.barracks;
  let troopUpkeep = sum(u, (k, v) => (UNITS[k].troop ? v * UNITS[k].upkeep : 0));
  if (troops > barracksCap && troops > 0) troopUpkeep *= 1 + (troops - barracksCap) / troops; // overflow pays double
  const upkeep = Math.round(troopUpkeep + u.spy * UNITS.spy.upkeep);

  const taxIncome = n.population * (n.tax / 100) * 0.5;
  const cashPerTick = Math.round(taxIncome + 120 * b.industry - upkeep);
  const foodPerTick = Math.round(40 * b.farm - n.population / 50 - troops / 10);
  const oilPerTick = 30 * b.oilRig - sum(u, (k, v) => v * UNITS[k].oil);

  const gridBonus = Math.min(0.25, 0.01 * b.grid);
  const offence = Math.round(sum(u, (k, v) => v * UNITS[k].off));
  const defence = Math.round(sum(u, (k, v) => v * UNITS[k].def) * (1 + gridBonus));

  const yardSteps = Math.floor((b.yard / n.land) / 0.05);
  const buildDiscount = Math.min(0.4, yardSteps * 0.04);

  const exploreAcres = Math.floor(Math.max(3, 25 - n.land / 200));
  const exploreCostPerAcre = Math.round(100 + 0.8 * n.land);

  const networth = Math.round(
    n.land * 200 + built * 300 + sum(u, (k, v) => v * UNITS[k].cost * 0.5)
  );

  return {
    built, queuedBuildings, freeLand, popCap, troops, barracksCap, upkeep,
    cashPerTick, foodPerTick, oilPerTick, offence, defence, gridBonus,
    buildDiscount, exploreAcres, exploreCostPerAcre,
    explorePerTurn: exploreAcres * exploreCostPerAcre,
    techPerTick: 0.25 * b.lab, networth,
  };
}

function log(n, now, text) {
  n.log.unshift({ at: now, text });
  if (n.log.length > CONFIG.logSize) n.log.length = CONFIG.logSize;
}

// ---------- one economic tick (what one spent turn does) ----------

export function tick(n, now) {
  const s = stats(n);

  // Population moves toward the cap, more slowly when taxes are high.
  if (n.population < s.popCap) {
    n.population += Math.round(0.03 * (s.popCap - n.population) * (1 - n.tax / 100));
  } else if (n.population > s.popCap) {
    n.population -= Math.ceil(0.05 * (n.population - s.popCap));
  }

  n.cash += s.cashPerTick;
  n.food += s.foodPerTick;
  n.oil += s.oilPerTick;
  n.techPoints = Math.round((n.techPoints + s.techPerTick) * 100) / 100;

  if (n.food < 0) {
    n.food = 0;
    n.population = Math.floor(n.population * 0.97);
    for (const k in n.units) if (UNITS[k].troop) n.units[k] = Math.floor(n.units[k] * 0.97);
    log(n, now, 'Food ran out: 3% of people and troops were lost.');
  }
  if (n.cash < 0) {
    n.cash = 0;
    for (const k in n.units) n.units[k] = Math.floor(n.units[k] * 0.95);
    log(n, now, 'Cash ran out: 5% of units deserted.');
  }
  if (n.oil < 0) {
    n.oil = 0;
    log(n, now, 'Oil ran out: tanks and jets cannot attack until it is restored.');
  }

  // Advance construction and training.
  const still = [];
  for (const q of n.queue) {
    q.ticks -= 1;
    if (q.ticks > 0) { still.push(q); continue; }
    if (q.kind === 'building') {
      n.buildings[q.type] += q.count;
      log(n, now, `Finished building ${q.count} ${BUILDINGS[q.type].name}.`);
    } else {
      n.units[q.type] += q.count;
      log(n, now, `${q.count} ${UNITS[q.type].name} finished training.`);
    }
  }
  n.queue = still;
  n.ticks += 1;
}

function spendTurns(n, count) {
  if (n.turns < count) throw new GameError(`Not enough turns (you have ${n.turns}).`);
  n.turns -= count;
}

function readCounts(items, table) {
  if (!items || typeof items !== 'object') throw new GameError('Nothing selected.');
  const out = {};
  let total = 0;
  for (const [k, raw] of Object.entries(items)) {
    if (!(k in table)) throw new GameError(`Unknown type: ${k}`);
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0) throw new GameError('Counts must be whole numbers.');
    if (v > 0) { out[k] = v; total += v; }
  }
  if (total === 0) throw new GameError('Nothing selected.');
  return { counts: out, total };
}

const money = v => Math.round(v).toLocaleString('en-CA');

// ---------- player actions ----------
// Each returns a short message; it throws GameError if the action isn't allowed.
// Before calling, the Worker has already run accrueTurns().

export function applyAction(n, action, now) {
  switch (action?.type) {
    case 'useTurns': {
      const count = Number(action.count);
      if (!Number.isInteger(count) || count < 1) throw new GameError('Choose at least 1 turn.');
      spendTurns(n, count);
      const before = { cash: n.cash, food: n.food, oil: n.oil, population: n.population };
      for (let i = 0; i < count; i++) tick(n, now);
      const msg = `Used ${count} turn${count > 1 ? 's' : ''}: cash ${signed(n.cash - before.cash)}, ` +
        `food ${signed(n.food - before.food)}, oil ${signed(n.oil - before.oil)}, ` +
        `population ${signed(n.population - before.population)}.`;
      log(n, now, msg);
      return msg;
    }

    case 'explore': {
      const batches = Number(action.batches ?? 1);
      if (!Number.isInteger(batches) || batches < 1) throw new GameError('Choose at least 1 turn of exploring.');
      if (n.turns < batches) throw new GameError(`Not enough turns (you have ${n.turns}).`);
      let acres = 0, spent = 0;
      for (let i = 0; i < batches; i++) {
        const s = stats(n);
        if (n.cash < s.explorePerTurn) {
          if (i === 0) throw new GameError(`Exploring costs ${money(s.explorePerTurn)} cash a turn right now.`);
          break;
        }
        spendTurns(n, 1);
        n.cash -= s.explorePerTurn;
        n.land += s.exploreAcres;
        acres += s.exploreAcres;
        spent += s.explorePerTurn;
        tick(n, now);
      }
      const msg = `Explored ${acres} new acres for ${money(spent)} cash.`;
      log(n, now, msg);
      return msg;
    }

    case 'build': {
      const { counts, total } = readCounts(action.items, BUILDINGS);
      const s = stats(n);
      if (total > s.freeLand) throw new GameError(`Only ${s.freeLand} free acres to build on.`);
      const cost = Math.round(sum(counts, (k, v) => v * BUILDINGS[k].cost) * (1 - s.buildDiscount));
      if (cost > n.cash) throw new GameError(`That costs ${money(cost)} cash; you have ${money(n.cash)}.`);
      spendTurns(n, 1);
      n.cash -= cost;
      tick(n, now);
      for (const [k, v] of Object.entries(counts)) {
        n.queue.push({ kind: 'building', type: k, count: v, ticks: CONFIG.buildTicks });
      }
      const msg = `Started ${total} buildings for ${money(cost)} cash; they finish in ${CONFIG.buildTicks} turns.`;
      log(n, now, msg);
      return msg;
    }

    case 'train': {
      const { counts, total } = readCounts(action.items, UNITS);
      const cost = sum(counts, (k, v) => v * UNITS[k].cost);
      if (cost > n.cash) throw new GameError(`That costs ${money(cost)} cash; you have ${money(n.cash)}.`);
      spendTurns(n, 1);
      n.cash -= cost;
      tick(n, now);
      for (const [k, v] of Object.entries(counts)) {
        n.queue.push({ kind: 'unit', type: k, count: v, ticks: CONFIG.trainTicks });
      }
      const msg = `Training ${total} units for ${money(cost)} cash; ready in ${CONFIG.trainTicks} turns.`;
      log(n, now, msg);
      return msg;
    }

    case 'setTax': {
      const rate = Number(action.rate);
      if (!Number.isInteger(rate) || rate < CONFIG.taxMin || rate > CONFIG.taxMax) {
        throw new GameError(`Tax must be a whole number from ${CONFIG.taxMin} to ${CONFIG.taxMax}.`);
      }
      n.tax = rate;
      return `Tax rate set to ${rate}%.`;
    }

    case 'demolish': {
      const { counts, total } = readCounts(action.items, BUILDINGS);
      for (const [k, v] of Object.entries(counts)) {
        if (v > n.buildings[k]) throw new GameError(`You only have ${n.buildings[k]} ${BUILDINGS[k].name}.`);
      }
      const refund = Math.round(sum(counts, (k, v) => v * BUILDINGS[k].cost) * 0.25);
      for (const [k, v] of Object.entries(counts)) n.buildings[k] -= v;
      n.cash += refund;
      const msg = `Demolished ${total} buildings and recovered ${money(refund)} cash.`;
      log(n, now, msg);
      return msg;
    }

    default:
      throw new GameError('Unknown action.');
  }
}

function signed(v) {
  const r = Math.round(v);
  return (r >= 0 ? '+' : '−') + Math.abs(r).toLocaleString('en-CA');
}

// What the browser is allowed to see.
export function view(n, now) {
  return {
    nation: {
      name: n.name, land: n.land, cash: n.cash, food: n.food, oil: n.oil,
      population: n.population, tax: n.tax, techPoints: n.techPoints,
      buildings: n.buildings, units: n.units, queue: n.queue,
      turns: n.turns, nextTurnAt: nextTurnAt(n), ticks: n.ticks, log: n.log,
    },
    stats: stats(n),
    serverTime: now,
  };
}

export const RULES = { config: CONFIG, buildings: BUILDINGS, units: UNITS };
