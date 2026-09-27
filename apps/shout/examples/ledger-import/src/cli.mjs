#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { importStatement } from './importer.mjs';
import { mergeImports } from './ledger.mjs';
import { monthlySummary } from './report.mjs';
import { formatCents } from './money.mjs';

const args = process.argv.slice(2);
const bankFlag = args.indexOf('--bank');
const bank = bankFlag === -1 ? 'northwind' : args.splice(bankFlag, 2)[1];
if (!args.length) {
  console.error('Usage: ledger-import [--bank name] statement.csv...');
  process.exit(2);
}

let ledger = [];
for (const file of args) ledger = mergeImports(ledger, importStatement(await readFile(file, 'utf8'), { bank }));
for (const month of monthlySummary(ledger)) {
  console.log(`${month.month}  in ${formatCents(month.incomeCents)}  out ${formatCents(month.spendingCents)}`);
  for (const [category, cents] of Object.entries(month.byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${category.padEnd(14)} ${formatCents(cents)}`);
}
