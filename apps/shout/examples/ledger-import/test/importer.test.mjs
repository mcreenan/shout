import test from 'node:test';
import assert from 'node:assert/strict';
import { importStatement } from '../src/importer.mjs';

test('imports a simple northwind export', () => {
  const csv = 'Date,Description,Amount\n08/01/2026,ACME PAYROLL,2500.00\n08/02/2026,STARBUCKS #123,-5.75\n';
  assert.deepEqual(importStatement(csv, { bank: 'northwind' }), [
    { date: '2026-08-01', description: 'ACME PAYROLL', amountCents: 250000, category: 'income' },
    { date: '2026-08-02', description: 'STARBUCKS #123', amountCents: -575, category: 'coffee' },
  ]);
});

test('imports a ledgerline export with ISO dates', () => {
  const csv = 'posted,memo,amount\n2026-08-04,UBER TRIP,-18.20\n';
  assert.deepEqual(importStatement(csv, { bank: 'ledgerline' }), [
    { date: '2026-08-04', description: 'UBER TRIP', amountCents: -1820, category: 'transport' },
  ]);
});

test('names the missing column', () => {
  assert.throws(() => importStatement('When,What,Amount\n', { bank: 'northwind' }), /Missing column "Date"/);
});

test('rejects unknown banks', () => {
  assert.throws(() => importStatement('a\n', { bank: 'nobank' }), /Unsupported bank: nobank/);
});
