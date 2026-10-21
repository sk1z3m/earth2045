// Earth: 2045 — Cloudflare Worker.
// Serves the API under /api/*. Everything else is a static file from /public,
// which Cloudflare serves before this code runs. Every 30 minutes Cloudflare
// also calls scheduled(), which lets the AI nations take their turns.

import { newNation, accrueTurns, applyAction, spyOp, view, stats, GameError, RULES } from './game.js';
import { ROSTER, newBot, botPlay } from './bots.js';
import { AUTH, sha256, randomToken, hashPassword, sameHex, checkUsername, checkPassword, checkNationName } from './auth.js';
import { HttpError, json, readJson, bearer } from './http.js';
import { handleAdmin, getAnnouncement } from './admin.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof GameError) return json({ error: err.message }, 400);
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBots(env));
  },
};

// Let every AI nation spend the turns it has earned. Creates them the first time.
async function runBots(env) {
  const now = Date.now();
  const { results } = await env.DB
    .prepare('SELECT id, state, version FROM nations WHERE is_bot = 1').all();
  if (results.length === 0) return seedBots(env, now);
  const saves = results.map(row => {
    const n = accrueTurns(JSON.parse(row.state), now);
    botPlay(n, now, 4); // small batches keep each run well inside the free CPU limit
    return env.DB.prepare(
      `UPDATE nations SET state = ?, land = ?, networth = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`
    ).bind(JSON.stringify(n), n.land, stats(n).networth, now, row.id, row.version);
  });
  await env.DB.batch(saves);
}

async function seedBots(env, now) {
  await env.DB.batch(ROSTER.map(entry => {
    const n = newBot(entry, now);
    return env.DB.prepare(
      `INSERT OR IGNORE INTO nations (name, token_hash, state, land, networth, version, is_bot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`
    ).bind(n.name, 'bot:' + crypto.randomUUID(), JSON.stringify(n), n.land, stats(n).networth, now, now);
  }));
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/rules' && method === 'GET') return json({ ...RULES, announcement: await getAnnouncement(env) });
  if (pathname.startsWith('/api/admin/')) return handleAdmin(request, env, url, { runBots });

  if (pathname === '/api/register' && method === 'POST') return register(request, env);
  if (pathname === '/api/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/logout' && method === 'POST') return logout(request, env);
  if (pathname === '/api/legacy' && method === 'POST') return legacyInfo(request, env);

  if (pathname === '/api/nation' && method === 'GET') {
    const row = await loadNation(request, env);
    const now = Date.now();
    const n = accrueTurns(JSON.parse(row.state), now); // shown, not saved: reads cost nothing
    return json({ account: { username: row.username, isAdmin: row.is_admin === 1 }, events: await recentEvents(env, row.id), ...view(n, now) });
  }

  if (pathname === '/api/action' && method === 'POST') return doAction(request, env);

  if (pathname === '/api/rankings' && method === 'GET') {
    const { results } = await env.DB
      .prepare('SELECT name, land, networth, is_bot FROM nations ORDER BY land DESC, networth DESC LIMIT 25')
      .all();
    return json({ rankings: results.map(r => ({ name: r.name, land: r.land, networth: r.networth, ai: r.is_bot === 1 })) });
  }

  throw new HttpError(404, 'Not found.');
}

// ---------- accounts ----------

const USER_ID = '(SELECT id FROM users WHERE username = ?)';
const bad = r => { if (r.error) throw new HttpError(400, r.error); return r; };

// Create an account plus either a new nation or, with legacyKey, the nation
// this browser founded before accounts existed.
async function register(request, env) {
  const body = await readJson(request);
  const { name: username } = bad(checkUsername(body.username));
  const { pw } = bad(checkPassword(body.password));
  const now = Date.now();

  let legacy = null, nation = null;
  if (body.legacyKey) {
    legacy = await env.DB
      .prepare('SELECT id, name FROM nations WHERE token_hash = ? AND user_id IS NULL AND is_bot = 0')
      .bind(await sha256(String(body.legacyKey))).first();
    if (!legacy) throw new HttpError(400, 'That nation can no longer be claimed. Found a new one instead.');
  } else {
    const { name } = bad(checkNationName(body.nation));
    if (await env.DB.prepare('SELECT 1 FROM nations WHERE name = ?').bind(name).first()) {
      throw new HttpError(409, 'That nation name is taken.');
    }
    nation = newNation(name, now);
  }
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) {
    throw new HttpError(409, 'That username is taken.');
  }

  const pass = await hashPassword(pw);
  const addUser = env.DB
    .prepare('INSERT INTO users (username, pass_hash, salt, iterations, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(username, pass.hash, pass.salt, pass.iterations, now);
  const attach = legacy
    ? env.DB.prepare(`UPDATE nations SET user_id = ${USER_ID}, token_hash = ? WHERE id = ? AND user_id IS NULL`)
        .bind(username, 'user:' + crypto.randomUUID(), legacy.id)
    : env.DB.prepare(
        `INSERT INTO nations (name, token_hash, state, land, networth, version, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ${USER_ID}, ?, ?)`
      ).bind(nation.name, 'user:' + crypto.randomUUID(), JSON.stringify(nation), nation.land,
             stats(nation).networth, username, now, now);
  try {
    await env.DB.batch([addUser, attach]); // all or nothing
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new HttpError(409, 'That username or nation name was just taken. Try another.');
    throw err;
  }
  return json({ token: await startSession(env, username, now) }, 201);
}

async function login(request, env) {
  const body = await readJson(request);
  const username = String(body.username ?? '').trim();
  const now = Date.now();
  const user = await env.DB
    .prepare('SELECT id, pass_hash, salt, iterations, failed_logins, locked_until, suspended FROM users WHERE username = ?')
    .bind(username).first();
  if (user && user.locked_until > now) {
    const mins = Math.ceil((user.locked_until - now) / 60000);
    throw new HttpError(429, `Too many wrong passwords. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  // Hash even for unknown usernames, so response time doesn't reveal which names exist.
  const check = await hashPassword(String(body.password ?? ''), user?.salt ?? '00'.repeat(16), user?.iterations ?? AUTH.iterations);
  if (!user || !sameHex(check.hash, user.pass_hash)) {
    if (user) {
      const failures = user.failed_logins + 1;
      const locked = failures >= AUTH.maxFailures;
      await env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
        .bind(locked ? 0 : failures, locked ? now + AUTH.lockMinutes * 60000 : 0, user.id).run();
    }
    throw new HttpError(401, 'Wrong username or password.');
  }
  if (user.failed_logins) {
    await env.DB.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').bind(user.id).run();
  }
  if (user.suspended) throw new HttpError(403, 'This account has been suspended.');
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return json({ token: await startSession(env, username, now) });
}

async function logout(request, env) {
  const token = bearer(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true });
}

// Tells a browser holding a pre-accounts key which nation it can claim.
async function legacyInfo(request, env) {
  const body = await readJson(request);
  const row = await env.DB
    .prepare('SELECT name, land FROM nations WHERE token_hash = ? AND user_id IS NULL AND is_bot = 0')
    .bind(await sha256(String(body.key ?? ''))).first();
  if (!row) throw new HttpError(404, 'No nation to claim.');
  return json(row);
}

async function startSession(env, username, now) {
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ${USER_ID}, ?, ?)`)
    .bind(await sha256(token), username, now, now + AUTH.sessionDays * 864e5).run();
  return token;
}

// Things other nations did to you (caught spies now; attacks later).
async function recentEvents(env, nationId) {
  const { results } = await env.DB
    .prepare('SELECT at, text FROM events WHERE nation_id = ? ORDER BY at DESC LIMIT 30')
    .bind(nationId).all();
  return results;
}

const SAVE_NATION = `UPDATE nations SET state = ?, land = ?, networth = ?, version = version + 1, updated_at = ?
                     WHERE id = ? AND version = ?`;
// Runs only if the statement just before it saved (changes() = 1), so a lost race leaves no stray rows.
const IF_SAVED = 'WHERE changes() = 1';

async function doSpy(request, env, action) {
  const targetName = String(action.target ?? '').trim();
  if (!targetName) throw new HttpError(400, 'Choose a nation to spy on.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await loadNation(request, env);
    const target = await env.DB.prepare('SELECT id, name, state FROM nations WHERE name = ?').bind(targetName).first();
    if (!target) throw new HttpError(404, `No nation called ${targetName}.`);
    if (target.id === row.id) throw new HttpError(400, "You can't spy on yourself.");
    const now = Date.now();
    const n = accrueTurns(JSON.parse(row.state), now);
    const result = spyOp(n, JSON.parse(target.state), now);
    const stmts = [
      env.DB.prepare(SAVE_NATION).bind(JSON.stringify(n), n.land, stats(n).networth, now, row.id, row.version),
      env.DB.prepare(`INSERT INTO audit_log (nation_id, action, detail, at) SELECT ?, 'spy', ?, ? ${IF_SAVED}`)
        .bind(row.id, JSON.stringify({ target: target.name, success: result.success }), now),
    ];
    if (!result.success) {
      // The target finds out who tried. (changes() here refers to the audit insert, which ran only if we saved.)
      stmts.push(env.DB.prepare(`INSERT INTO events (nation_id, at, kind, text) SELECT ?, ?, 'spy', ? ${IF_SAVED}`)
        .bind(target.id, now, `You caught ${result.lost} ${result.lost === 1 ? 'spy' : 'spies'} from ${n.name}.`));
    }
    const out = await env.DB.batch(stmts);
    if (out[0].meta.changes === 1) {
      return json({ message: result.message, spy: { success: result.success, chance: result.chance },
                    events: await recentEvents(env, row.id), ...view(n, now) });
    }
  }
  throw new HttpError(409, 'Your nation changed while that was processing. Please try again.');
}

async function doAction(request, env) {
  const action = await readJson(request);
  if (action.type === 'spy') return doSpy(request, env, action);
  // Try twice: if another request changed the nation in between, reload and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await loadNation(request, env);
    const now = Date.now();
    const n = accrueTurns(JSON.parse(row.state), now);
    const message = applyAction(n, action, now);
    const s = stats(n);
    // Save only if nobody else saved since we loaded (version check = no double-spending).
    const result = await env.DB.prepare(
      `UPDATE nations SET state = ?, land = ?, networth = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`
    ).bind(JSON.stringify(n), n.land, s.networth, now, row.id, row.version).run();
    if (result.meta.changes === 1) {
      await env.DB.prepare('INSERT INTO audit_log (nation_id, action, detail, at) VALUES (?, ?, ?, ?)')
        .bind(row.id, String(action.type), JSON.stringify(action).slice(0, 500), now).run();
      return json({ message, events: await recentEvents(env, row.id), ...view(n, now) });
    }
  }
  throw new HttpError(409, 'Your nation changed while that was processing. Please try again.');
}

async function loadNation(request, env) {
  const token = bearer(request);
  if (!token) throw new HttpError(401, 'Please sign in.');
  const row = await env.DB.prepare(
    `SELECT n.id, n.state, n.version, u.username, u.is_admin, u.suspended
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN nations n ON n.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256(token), Date.now()).first();
  if (!row) throw new HttpError(401, 'Please sign in.');
  if (row.suspended) throw new HttpError(403, 'This account has been suspended.');
  return row;
}
