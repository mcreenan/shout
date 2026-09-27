import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatCents } from '../src/money.mjs';

test('parses dollar amounts to integer cents', () => {
  assert.equal(parseAmount('$1,234.56'), 123456);
  assert.equal(parseAmount('-12.50'), -1250);
  assert.equal(parseAmount('19.99'), 1999);
  assert.equal(parseAmount('7'), 700);
});

test('rejects text that is not an amount', () => {
  assert.throws(() => parseAmount('pending'), /Invalid amount/);
});

test('formats cents for display', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-1250), '-$12.50');
  assert.equal(formatCents(5), '$0.05');
});
