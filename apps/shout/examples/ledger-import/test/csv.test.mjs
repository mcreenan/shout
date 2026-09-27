import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('splits simple rows and trims fields', () => {
  assert.deepEqual(parseCsv('Date, Description ,Amount\n08/01/2026,Payroll,2500.00\n'), [
    ['Date', 'Description', 'Amount'],
    ['08/01/2026', 'Payroll', '2500.00'],
  ]);
});

test('skips blank lines', () => {
  assert.deepEqual(parseCsv('a,b\n\n  \nc,d'), [['a', 'b'], ['c', 'd']]);
});

test('supports a custom delimiter', () => {
  assert.deepEqual(parseCsv('a;b\nc;d', { delimiter: ';' }), [['a', 'b'], ['c', 'd']]);
});
