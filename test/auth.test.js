import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, sameHex, checkUsername, checkPassword, checkNationName, AUTH } from '../src/auth.js';

test('the same password and salt give the same hash; a different password does not', async () => {
  const a = await hashPassword('correct horse battery');
  const again = await hashPassword('correct horse battery', a.salt, a.iterations);
  const wrong = await hashPassword('correct horse batterz', a.salt, a.iterations);
  assert.equal(a.iterations, AUTH.iterations);
  assert.ok(sameHex(a.hash, again.hash));
  assert.ok(!sameHex(a.hash, wrong.hash));
});

test('every account gets its own salt', async () => {
  const a = await hashPassword('same password');
  const b = await hashPassword('same password');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('hashing fits inside the free plan CPU limit', async () => {
  await hashPassword('warm up');
  const t = performance.now();
  await hashPassword('timed password');
  assert.ok(performance.now() - t < 10, 'should take under 10 ms');
});

test('sign-up rules', () => {
  assert.ok(checkUsername('Sk1z3m').name);
  assert.ok(checkUsername('ab').error);
  assert.ok(checkUsername('has space').error);
  assert.ok(checkUsername('x'.repeat(21)).error);
  assert.ok(checkPassword('1234567').error);
  assert.ok(checkPassword('12345678').pw);
  assert.equal(checkNationName('  New   Cascadia ').name, 'New Cascadia');
  assert.ok(checkNationName('<script>').error);
});
