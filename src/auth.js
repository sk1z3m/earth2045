// Earth: 2045 — accounts: password hashing, sessions and sign-in rules.

export const AUTH = {
  iterations: 25000,                 // PBKDF2 rounds: ~5 ms, inside the free plan's 10 ms CPU limit
  sessionDays: 30,
  maxFailures: 5,                    // wrong passwords in a row before a lock
  lockMinutes: 15,
};

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

export async function hashPassword(password, saltHex, iterations = AUTH.iterations) {
  const salt = saltHex
    ? new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { hash: hex(bits), salt: hex(salt), iterations };
}

// Compare without leaking how many characters matched.
export function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function checkUsername(u) {
  const name = String(u ?? '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return { error: 'Username must be 3–20 letters, numbers or underscores.' };
  return { name };
}

export function checkPassword(p) {
  const pw = String(p ?? '');
  if (pw.length < 8) return { error: 'Password must be at least 8 characters.' };
  if (pw.length > 200) return { error: 'Password is too long.' };
  return { pw };
}

export function checkNationName(n) {
  const name = String(n ?? '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9 '\-]{3,24}$/.test(name)) {
    return { error: 'Nation name must be 3–24 letters, numbers, spaces, apostrophes or hyphens.' };
  }
  return { name };
}
