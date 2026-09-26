import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutTotal } from './pricing.mjs';

test('discount reduces the taxable amount', () => assert.equal(checkoutTotal(100, 20, 10), 88));
test('no discount preserves the regular total', () => assert.equal(checkoutTotal(50, 0, 8), 54));
test('a full discount leaves nothing taxable', () => assert.equal(checkoutTotal(100, 100, 10), 0));
test('round the final total to cents', () => assert.equal(checkoutTotal(19.99, 15, 8.25), 18.39));
