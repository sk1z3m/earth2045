// Earth: 2045 — admin API. Every request is checked against the signed-in
// account's admin flag on the server; anyone else gets a plain "Not found".
// Every change is written to the audit log with the admin's username.

import { HttpError, json, readJson, bearer } from './http.js';
import { sha256, hashPassword, sameHex, checkNationName } from './auth.js';
import { accrueTurns, stats, CONFIG } from './game.js';

const DAY = 864e5;

export async function getAnnouncement(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'announcement'").first();
  return row?.value ?? '';
}

export async function handleAdmin(request, env, url, { runBots }) {
  const admin = await requireAdmin(request, env);
  const path = url.pathname.slice('/api/admin/'.length);

  if (request.method === 'GET') {
    if (path === 'overview') return overview(env);
    if (path === 'nations') return listNations(env, url.searchParams.get('q') ?? '');
    if (path === 'nation') return nationDetail(env, Number(url.searchParams.get('id')));
  }
  if (request.method === 'POST') {
    const body = await readJson(request);
    switch (path) {
      case 'rename': return rename(env, admin, body);
      case 'unlock': return unlock(env, admin, body);
      case 'suspend': return suspend(env, admin, body);
      case 'grant': return grant(env, admin, body);
      case 'run-ai': {
        await runBots(env);
        await audit(env, admin, 'run-ai', 0, {});
        return json({ message: 'AI nations took their turns.' });
      }
      case 'announce': return announce(env, admin, body);
    }
  }
  throw new HttpError(404, 'Not found.');
}

async function requireAdmin(request, env) {
  const token = bearer(request);
  const row = token && await env.DB.prepare(
    `SELECT u.id, u.username, u.pass_hash, u.salt, u.iterations
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_admin = 1 AND u.suspended = 0`
  ).bind(await sha256(token), Date.now()).first();
  if (!row) throw new HttpError(404, 'Not found.'); // don't confirm the admin area exists
  return row;
}

async function confirmPassword(admin, password) {
  const check = await hashPassword(String(password ?? ''), admin.salt, admin.iterations);
  if (!sameHex(check.hash, admin.pass_hash)) throw new HttpError(403, 'Password is not correct.');
}

function audit(env, admin, action, nationId, detail) {
  return env.DB.prepare('INSERT INTO audit_log (nation_id, action, detail, at) VALUES (?, ?, ?, ?)')
    .bind(nationId ?? 0, 'admin:' + action, JSON.stringify({ by: admin.username, ...detail }).slice(0, 500), Date.now()).run();
}

// ---------- reading ----------

async function overview(env) {
  const now = Date.now();
  const counts = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM nations WHERE is_bot = 0)                        AS players,
      (SELECT COUNT(*) FROM nations WHERE is_bot = 1)                        AS ai,
      (SELECT COUNT(*) FROM users WHERE created_at > ?)                      AS signups24h,
      (SELECT COUNT(*) FROM nations WHERE is_bot = 0 AND updated_at > ?)     AS active24h,
      (SELECT COUNT(*) FROM users WHERE suspended = 1)                       AS suspended,
      (SELECT COUNT(*) FROM users WHERE locked_until > ?)                    AS locked,
      (SELECT COUNT(*) FROM audit_log WHERE at > ? AND action NOT LIKE 'admin:%') AS actions24h`
  ).bind(now - DAY, now - DAY, now, now - DAY).first();
  const { results: recent } = await env.DB
    .prepare("SELECT action, detail, at FROM audit_log WHERE action LIKE 'admin:%' ORDER BY at DESC LIMIT 15").all();
  return json({ counts, announcement: await getAnnouncement(env), recentAdmin: recent });
}

async function listNations(env, q) {
  const like = '%' + q.trim().replace(/[%_\\]/g, c => '\\' + c) + '%';
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.name, n.land, n.networth, n.is_bot, n.updated_at,
            u.id AS user_id, u.username, u.suspended, u.locked_until
       FROM nations n LEFT JOIN users u ON u.id = n.user_id
      WHERE ? = '' OR n.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\'
      ORDER BY n.land DESC, n.networth DESC LIMIT 100`
  ).bind(q.trim(), like, like).all();
  return json({ nations: results });
}

async function nationDetail(env, id) {
  const row = await env.DB.prepare(
    `SELECT n.id, n.name, n.state, n.is_bot, n.created_at, n.updated_at,
            u.id AS user_id, u.username, u.suspended, u.suspended_reason, u.locked_until, u.failed_logins, u.created_at AS user_created
       FROM nations n LEFT JOIN users u ON u.id = n.user_id WHERE n.id = ?`
  ).bind(id).first();
  if (!row) throw new HttpError(404, 'No such nation.');
  const now = Date.now();
  const n = accrueTurns(JSON.parse(row.state), now);
  const [{ results: actions }, { results: events }] = await Promise.all([
    env.DB.prepare('SELECT action, detail, at FROM audit_log WHERE nation_id = ? ORDER BY at DESC LIMIT 50').bind(id).all(),
    env.DB.prepare('SELECT text, at FROM events WHERE nation_id = ? ORDER BY at DESC LIMIT 20').bind(id).all(),
  ]);
  delete row.state;
  return json({ ...row, nation: n, stats: stats(n), actions, events });
}

// ---------- changing ----------

async function rename(env, admin, body) {
  const id = Number(body.nationId);
  const { name, error } = checkNationName(body.name);
  if (error) throw new HttpError(400, error);
  const old = await env.DB.prepare('SELECT name FROM nations WHERE id = ?').bind(id).first();
  if (!old) throw new HttpError(404, 'No such nation.');
  try {
    await env.DB.prepare("UPDATE nations SET name = ?, state = json_set(state, '$.name', ?), version = version + 1 WHERE id = ?")
      .bind(name, name, id).run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new HttpError(409, 'That nation name is taken.');
    throw err;
  }
  await audit(env, admin, 'rename', id, { from: old.name, to: name });
  return json({ message: `Renamed ${old.name} to ${name}.` });
}

async function unlock(env, admin, body) {
  const userId = Number(body.userId);
  const r = await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').bind(userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'No such account.');
  await audit(env, admin, 'unlock', 0, { userId });
  return json({ message: 'Account unlocked.' });
}

async function suspend(env, admin, body) {
  await confirmPassword(admin, body.password);
  const userId = Number(body.userId);
  const on = body.suspend !== false;
  if (userId === admin.id) throw new HttpError(400, "You can't suspend your own account.");
  const reason = on ? String(body.reason ?? '').trim().slice(0, 200) : null;
  const r = await env.DB.prepare('UPDATE users SET suspended = ?, suspended_reason = ? WHERE id = ?')
    .bind(on ? 1 : 0, reason, userId).run();
  if (!r.meta.changes) throw new HttpError(404, 'No such account.');
  if (on) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run(); // signs them out everywhere
  await audit(env, admin, on ? 'suspend' : 'unsuspend', 0, { userId, reason });
  return json({ message: on ? 'Account suspended and signed out.' : 'Account restored.' });
}

// Add (or with negatives, remove) turns and resources. Testing aid; audited.
async function grant(env, admin, body) {
  const id = Number(body.nationId);
  const amounts = {};
  for (const k of ['turns', 'cash', 'food', 'oil']) {
    const v = Number(body[k] ?? 0);
    if (!Number.isInteger(v)) throw new HttpError(400, 'Amounts must be whole numbers.');
    if (v) amounts[k] = v;
  }
  if (!Object.keys(amounts).length) throw new HttpError(400, 'Enter an amount to give.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await env.DB.prepare('SELECT state, version FROM nations WHERE id = ?').bind(id).first();
    if (!row) throw new HttpError(404, 'No such nation.');
    const now = Date.now();
    const n = accrueTurns(JSON.parse(row.state), now);
    for (const [k, v] of Object.entries(amounts)) n[k] = Math.max(0, n[k] + v);
    n.turns = Math.min(CONFIG.turnCap, n.turns);
    const parts = Object.entries(amounts).map(([k, v]) => `${v > 0 ? '+' : ''}${v.toLocaleString('en-CA')} ${k}`).join(', ');
    n.log.unshift({ at: now, text: `An administrator adjusted your nation: ${parts}.` });
    n.log.length = Math.min(n.log.length, CONFIG.logSize);
    const r = await env.DB.prepare(
      'UPDATE nations SET state = ?, land = ?, networth = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?'
    ).bind(JSON.stringify(n), n.land, stats(n).networth, now, id, row.version).run();
    if (r.meta.changes === 1) {
      await audit(env, admin, 'grant', id, amounts);
      return json({ message: `Gave ${n.name}: ${parts}.` });
    }
  }
  throw new HttpError(409, 'That nation changed at the same moment. Try again.');
}

async function announce(env, admin, body) {
  const text = String(body.text ?? '').trim().slice(0, 300);
  if (text) {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('announcement', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(text).run();
  } else {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'announcement'").run();
  }
  await audit(env, admin, 'announce', 0, { text });
  return json({ message: text ? 'Announcement is live.' : 'Announcement removed.' });
}
