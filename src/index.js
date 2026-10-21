// Earth: 2045 — Cloudflare Worker (stage 1).
// Serves the API under /api/*. Everything else is a static file from /public,
// which Cloudflare serves before this code runs. Every 30 minutes Cloudflare
// also calls scheduled(), which lets the AI nations take their turns.

import { newNation, accrueTurns, applyAction, view, stats, GameError, RULES } from './game.js';
import { ROSTER, newBot, botPlay } from './bots.js';

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

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === '/api/rules' && method === 'GET') return json(RULES);

  if (pathname === '/api/nation' && method === 'POST') return createNation(request, env);
  if (pathname === '/api/nation' && method === 'GET') {
    const row = await loadNation(request, env);
    const now = Date.now();
    const n = accrueTurns(JSON.parse(row.state), now); // shown, not saved: reads cost nothing
    return json(view(n, now));
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

async function createNation(request, env) {
  const body = await readJson(request);
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 '\-]{3,24}$/.test(name)) {
    throw new HttpError(400, 'Name must be 3–24 letters, numbers, spaces, apostrophes or hyphens.');
  }
  const now = Date.now();
  const n = newNation(name, now);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const s = stats(n);
  try {
    await env.DB.prepare(
      `INSERT INTO nations (name, token_hash, state, land, networth, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).bind(name, await sha256(token), JSON.stringify(n), n.land, s.networth, now, now).run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new HttpError(409, 'That name is taken.');
    throw err;
  }
  return json({ token, ...view(n, now) }, 201);
}

async function doAction(request, env) {
  const action = await readJson(request);
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
      return json({ message, ...view(n, now) });
    }
  }
  throw new HttpError(409, 'Your nation changed while that was processing. Please try again.');
}

async function loadNation(request, env) {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) throw new HttpError(401, 'Not signed in.');
  const row = await env.DB
    .prepare('SELECT id, state, version FROM nations WHERE token_hash = ?')
    .bind(await sha256(token)).first();
  if (!row) throw new HttpError(401, 'Nation not found. Create a new one.');
  return row;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 10_000) throw new HttpError(413, 'Request too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Bad request.'); }
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
