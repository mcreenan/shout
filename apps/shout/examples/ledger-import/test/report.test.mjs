import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlySummary } from '../src/report.mjs';

test('summarizes income and spending per month', () => {
  const summary = monthlySummary([
    { date: '2026-08-02', description: 'x', amountCents: -575, category: 'coffee' },
    { date: '2026-07-31', description: 'x', amountCents: 250000, category: 'income' },
    { date: '2026-08-03', description: 'x', amountCents: -2000, category: 'groceries' },
    { date: '2026-08-09', description: 'x', amountCents: -425, category: 'coffee' },
  ]);
  assert.deepEqual(summary, [
    { month: '2026-07', incomeCents: 250000, spendingCents: 0, byCategory: {} },
    { month: '2026-08', incomeCents: 0, spendingCents: 3000, byCategory: { coffee: 1000, groceries: 2000 } },
  ]);
});
