import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignup, validateProfile } from './validators.mjs';

for (const [entryPoint, validate] of [['signup', validateSignup], ['profile', validateProfile]]) {
  test(`${entryPoint}: accepts names after trimming`, () => {
    for (const name of ['Alice', 'user_123', '  Bob  ', 'a'.repeat(20)]) assert.equal(validate(name), true, name);
  });
  test(`${entryPoint}: rejects invalid names`, () => {
    for (const name of ['', '  ', 'ab', 'a'.repeat(21), '1alice', '_alice', 'bad-name', 'has space', 'éclair']) assert.equal(validate(name), false, JSON.stringify(name));
  });
}
test('entry points agree on all supplied values', () => {
  for (const name of ['alice', 'ab', '1ab', '   Bob   ', 'bad-name']) assert.equal(validateSignup(name), validateProfile(name), name);
});
