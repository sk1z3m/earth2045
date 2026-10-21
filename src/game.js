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

// Combat dials (design doc: Combat and attacks).
export const WAR = {
  assaultTurns: 2,
  landShare: 0.07,        // land taken = 7% of target land × min(1.5, off/def) × size × repeat factors
  maxRatio: 1.5,
  minSizeRatio: 0.4,      // targets under 40% of your land can't be attacked
  fullSizeRatio: 0.75,    // at or above 75% of your land: full gains
  biggerBonusMax: 1.2,    // hitting bigger nations gives up to +20%
  repeatFactor: 0.7,      // each successful hit on a target within 24 h yields 70% of the last
  capturedBuildings: 0.3, // share of the buildings on taken land that survive
  captureTicks: 8,        // taken land arrives after 8 turns
  lossWin: 0.07, lossLose: 0.14,          // attacker losses (share of units sent)
  defLossWin: 0.04, defLossLose: 0.02,    // defender losses (share of all units), by attacker's result
  readinessCost: 8, readinessMax: 100, readinessPenaltyBelow: 50,
  protectionHours: 72, protectionTurns: 200,
  swing: 0.05,            // ±5% random swing on the attacker's side
};
export const ASSAULT_UNITS = ['infantry', 'tank'];

// The economy's dials, all in one place. Tested against week-long AI simulations.
export const ECON = {
  taxFactor: 0.5,        // cash a person pays per turn at 100% tax
  popPerAcre: 20,        // people every acre supports
  popPerHousing: 60,     // extra people per Housing
  industryCash: 15,      // cash per Industry per turn (pays back in ~53 turns)
  farmFood: 25,          // food per Farm per turn (~10% of land in farms breaks even)
  rigOil: 30,            // oil per Oil rig per turn
  peoplePerFood: 15,     // 1 food per this many people per turn
  troopsPerFood: 4,      // 1 food per this many troops per turn
  exploreBase: 100,      // explore cost per acre = base + linear × land + land² ÷ squareDiv
  exploreLinear: 0.8,
  exploreSquareDiv: 650, // makes land expensive for big nations (0 = off)
};

export const BUILDINGS = {
  housing:  { name: 'Housing',           cost: 400,  get effect() { return `+${ECON.popPerHousing} population cap`; } },
  industry: { name: 'Industry',          cost: 800,  get effect() { return `+${ECON.industryCash} cash a turn`; } },
  farm:     { name: 'Farm',              cost: 500,  get effect() { return `+${ECON.farmFood} food a turn`; } },
  oilRig:   { name: 'Oil rig',           cost: 900,  get effect() { return `+${ECON.rigOil} oil a turn`; } },
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
  const popCap = ECON.popPerAcre * n.land + ECON.popPerHousing * b.housing;

  const troops = sum(u, (k, v) => (UNITS[k].troop ? v : 0));
  const barracksCap = 50 * b.barracks;
  let troopUpkeep = sum(u, (k, v) => (UNITS[k].troop ? v * UNITS[k].upkeep : 0));
  if (troops > barracksCap && troops > 0) troopUpkeep *= 1 + (troops - barracksCap) / troops; // overflow pays double
  const upkeep = Math.round(troopUpkeep + u.spy * UNITS.spy.upkeep);

  const taxIncome = n.population * (n.tax / 100) * ECON.taxFactor;
  const cashPerTick = Math.round(taxIncome + ECON.industryCash * b.industry - upkeep);
  const foodPerTick = Math.round(ECON.farmFood * b.farm - n.population / ECON.peoplePerFood - troops / ECON.troopsPerFood);
  const oilPerTick = ECON.rigOil * b.oilRig - sum(u, (k, v) => v * UNITS[k].oil);

  const gridBonus = Math.min(0.25, 0.01 * b.grid);
  const offence = Math.round(sum(u, (k, v) => v * UNITS[k].off));
  const defence = Math.round(sum(u, (k, v) => v * UNITS[k].def) * (1 + gridBonus));

  const yardSteps = Math.floor((b.yard / n.land) / 0.05);
  const buildDiscount = Math.min(0.4, yardSteps * 0.04);

  const exploreAcres = Math.floor(Math.max(3, 25 - n.land / 200));
  const exploreCostPerAcre = Math.round(ECON.exploreBase + ECON.exploreLinear * n.land +
    (ECON.exploreSquareDiv ? n.land * n.land / ECON.exploreSquareDiv : 0));

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
  n.readiness = Math.min(WAR.readinessMax, (n.readiness ?? WAR.readinessMax) + 1);

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
    if (q.kind === 'capture') {
      n.land += q.count;
      for (const [k, v] of Object.entries(q.buildings ?? {})) n.buildings[k] += v;
      const kept = Object.values(q.buildings ?? {}).reduce((t, v) => t + v, 0);
      log(n, now, `${q.count} acres taken from ${q.from} are now yours${kept ? `, with ${kept} buildings` : ''}.`);
    } else if (q.kind === 'building') {
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

// ---------- ground assaults ----------

export function isProtected(n, now) {
  if (n.bot || n.protectionEnded) return false;
  return now - n.createdAt < WAR.protectionHours * 3600e3 && n.ticks < WAR.protectionTurns;
}

// Size factor: small targets give much less; bigger ones a little more.
export function sizeFactor(attLand, tgtLand) {
  const r = tgtLand / attLand;
  if (r < WAR.minSizeRatio) return 0;
  if (r < WAR.fullSizeRatio) return r * r;
  return Math.min(WAR.biggerBonusMax, 1 + Math.max(0, r - 1) * 0.4);
}

export function readinessFactor(n) {
  const r = n.readiness ?? WAR.readinessMax;
  return r >= WAR.readinessPenaltyBelow ? 1 : Math.max(0, 1 - (WAR.readinessPenaltyBelow - r) * 0.01);
}

export function sentOffence(n, sent) {
  return Math.round(Object.entries(sent).reduce((t, [k, v]) => t + v * UNITS[k].off, 0) * readinessFactor(n));
}

// Check an attack can happen. Throws GameError with the reason if not.
export function checkAssault(att, tgt, sent, now) {
  if (att.name === tgt.name) throw new GameError("You can't attack yourself.");
  if (isProtected(tgt, now)) throw new GameError(`${tgt.name} is under new-player protection.`);
  if (sizeFactor(att.land, tgt.land) === 0) {
    throw new GameError(`${tgt.name} is less than ${WAR.minSizeRatio * 100}% of your size, too small to attack.`);
  }
  let total = 0;
  for (const [k, v] of Object.entries(sent)) {
    if (!ASSAULT_UNITS.includes(k)) throw new GameError('Ground assaults use infantry and tanks.');
    if (!Number.isInteger(v) || v < 0) throw new GameError('Unit counts must be whole numbers.');
    if (v > att.units[k]) throw new GameError(`You only have ${att.units[k]} ${UNITS[k].name}.`);
    total += v;
  }
  if (!total) throw new GameError('Choose some infantry or tanks to send.');
  if (sent.tank > 0 && att.oil <= 0) throw new GameError('Tanks need oil to attack, and you have none.');
  if (att.turns < WAR.assaultTurns) throw new GameError(`An assault takes ${WAR.assaultTurns} turns (you have ${att.turns}).`);
}

const lose = (units, keys, share) => {
  const out = {};
  for (const k of keys) { const c = Math.ceil((units[k] ?? 0) * share - 1e-9); if (c > 0) out[k] = c; } // 1e-9: 0.07 × 400 is 28.000000000000004 in floating point
  return out;
};
const listUnits = obj => Object.entries(obj).map(([k, v]) => `${v.toLocaleString('en-CA')} ${UNITS[k].name}`).join(', ') || 'nothing';

// Resolve a ground assault. Changes both nations. recentHits = successful
// hits on the target by anyone in the last 24 hours.
export function groundAssault(att, tgt, sent, now, { recentHits = 0, rng = Math.random } = {}) {
  sent = Object.fromEntries(Object.entries(sent).filter(([, v]) => v > 0));
  checkAssault(att, tgt, sent, now);

  const offence = sentOffence(att, sent);
  const defence = Math.max(1, stats(tgt).defence);
  const swing = 1 - WAR.swing + rng() * 2 * WAR.swing;
  const success = offence * swing > defence;

  // Casualties
  const attLost = lose(sent, Object.keys(sent), success ? WAR.lossWin : WAR.lossLose);
  const defKeys = Object.keys(UNITS).filter(k => UNITS[k].troop);
  const defLost = lose(tgt.units, defKeys, success ? WAR.defLossWin : WAR.defLossLose);
  for (const [k, v] of Object.entries(attLost)) att.units[k] -= v;
  for (const [k, v] of Object.entries(defLost)) tgt.units[k] -= v;

  let acres = 0, keptBuildings = {};
  if (success) {
    const ratio = Math.min(WAR.maxRatio, offence / defence);
    const size = sizeFactor(att.land, tgt.land);
    const repeat = WAR.repeatFactor ** recentHits;
    acres = Math.max(1, Math.floor(WAR.landShare * tgt.land * ratio * size * repeat));
    acres = Math.min(acres, tgt.land - 1);
    // Buildings standing on the taken acres go with them (proportionally); 30% survive for the attacker.
    const share = acres / tgt.land;
    for (const [k, v] of Object.entries(tgt.buildings)) {
      const gone = Math.round(v * share);
      if (!gone) continue;
      tgt.buildings[k] -= gone;
      const kept = Math.round(gone * WAR.capturedBuildings);
      if (kept) keptBuildings[k] = kept;
    }
    tgt.land -= acres;
  }

  // The attacker spends the turns (each runs a normal economy cycle) and readiness.
  att.readiness = Math.max(0, (att.readiness ?? WAR.readinessMax) - WAR.readinessCost);
  att.protectionEnded = true;
  spendTurns(att, WAR.assaultTurns);
  for (let i = 0; i < WAR.assaultTurns; i++) tick(att, now);
  // Queued after this action's own ticks, so the land takes a full 8 turns to arrive.
  if (success) att.queue.push({ kind: 'capture', count: acres, from: tgt.name, buildings: keptBuildings, ticks: WAR.captureTicks });

  const message = success
    ? `Victory over ${tgt.name}: ${acres} acres taken (arriving in ${WAR.captureTicks} turns). You lost ${listUnits(attLost)}.`
    : `Your assault on ${tgt.name} was driven back. You lost ${listUnits(attLost)}.`;
  log(att, now, message);
  const defenderText = success
    ? `${att.name} attacked and took ${acres} acres. You lost ${listUnits(defLost)}.`
    : `You drove back an attack from ${att.name}. You lost ${listUnits(defLost)}.`;
  return { success, offence, defence, acres, attLost, defLost, message, defenderText };
}

// ---------- spying ----------
// Spying looks at another nation. Success depends on your spies per acre
// compared with theirs: equal = 50%, double = ~74%, half = ~26% (5%–95%).
export function spyChance(n, target) {
  const mine = n.units.spy / n.land;
  const theirs = target.units.spy / target.land;
  if (theirs <= 0) return 0.95;
  const r = (mine / theirs) ** 1.5;
  return Math.min(0.95, Math.max(0.05, r / (r + 1)));
}

export function spyOp(n, target, now, rng = Math.random) {
  if (n.units.spy < 1) throw new GameError('You need at least 1 spy. Train some under Military.');
  const chance = spyChance(n, target); // judged before this turn's tick
  spendTurns(n, 1);
  tick(n, now);
  if (rng() < chance) {
    const s = stats(target);
    const report = {
      at: now, name: target.name, land: target.land, population: target.population,
      cash: target.cash, food: target.food, oil: target.oil,
      buildings: { ...target.buildings }, units: { ...target.units },
      offence: s.offence, defence: s.defence, networth: s.networth,
    };
    n.intel = [report, ...(n.intel ?? []).filter(r => r.name !== target.name)].slice(0, 8);
    log(n, now, `Your spies reported on ${target.name}.`);
    return { success: true, chance, message: `Your spies got into ${target.name}. Report below.` };
  }
  const lost = Math.max(1, Math.ceil(n.units.spy * 0.05));
  n.units.spy -= lost;
  const message = `Your spies were caught in ${target.name}; ${lost} ${lost === 1 ? 'spy' : 'spies'} lost.`;
  log(n, now, message);
  return { success: false, chance, lost, message };
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
      intel: n.intel ?? [],
      readiness: n.readiness ?? WAR.readinessMax, protected: isProtected(n, now),
    },
    stats: stats(n),
    serverTime: now,
  };
}

export const RULES = { config: CONFIG, econ: ECON, war: WAR, assaultUnits: ASSAULT_UNITS, buildings: BUILDINGS, units: UNITS };
