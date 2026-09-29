// Reproduces LEDGER-142: "Real bank exports break the import and overlapping
// statements double-count spending." Every case below comes from an actual
// export attached to the ticket (account details removed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';
import { parseAmount } from '../src/money.mjs';
import { importStatement } from '../src/importer.mjs';
import { mergeImports } from '../src/ledger.mjs';
import { monthlySummary } from '../src/report.mjs';

test('csv: quoted fields may contain the delimiter', () => {
  assert.deepEqual(parseCsv('08/03/2026,"AMAZON MKTPLACE, SEATTLE WA",-42.10'), [
    ['08/03/2026', 'AMAZON MKTPLACE, SEATTLE WA', '-42.10'],
  ]);
});

test('csv: doubled quotes inside a quoted field are a literal quote', () => {
  assert.deepEqual(parseCsv('"JOE\'S ""FAMOUS"" DELI",-9.00'), [['JOE\'S "FAMOUS" DELI', '-9.00']]);
});

test('csv: Windows line endings do not leak into the last field', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
});

test('csv: a quoted field may span lines', () => {
  assert.deepEqual(parseCsv('08/05/2026,"TRANSFER\nREF 5521",-100.00\n08/06/2026,SHELL,-40.00'), [
    ['08/05/2026', 'TRANSFER\nREF 5521', '-100.00'],
    ['08/06/2026', 'SHELL', '-40.00'],
  ]);
});

test('money: accounting-style parentheses are negative', () => {
  assert.equal(parseAmount('(12.50)'), -1250);
  assert.equal(parseAmount('($1,000.00)'), -100000);
});

test('money: comma decimal separator', () => {
  assert.equal(parseAmount('1.234,56', { decimal: ',' }), 123456);
  assert.equal(parseAmount('-0,99', { decimal: ',' }), -99);
  assert.equal(parseAmount('23', { decimal: ',' }), 2300);
});

test('money: more than two decimal places is rejected, not rounded', () => {
  assert.throws(() => parseAmount('12.345'), /Invalid amount/);
  assert.throws(() => parseAmount('1,5', { decimal: '.' }), /Invalid amount/);
});

test('import: a UTF-8 byte order mark does not hide the first column', () => {
  const csv = '﻿Date,Description,Amount\r\n08/03/2026,"AMAZON MKTPLACE, SEATTLE WA","-$1,234.56"\r\n';
  assert.deepEqual(importStatement(csv, { bank: 'northwind' }), [
    { date: '2026-08-03', description: 'AMAZON MKTPLACE, SEATTLE WA', amountCents: -123456, category: 'shopping' },
  ]);
});

test('import: rheinbank exports (semicolons, DD.MM.YYYY, comma decimals)', () => {
  const csv = [
    'Buchungstag;Verwendungszweck;Betrag',
    '03.08.2026;"REWE SAGT DANKE; 4711";-23,45',
    '31.08.2026;GEHALT AUGUST;3.150,00',
    '1.9.2026;DEUTSCHE BAHN;-89,90',
  ].join('\n');
  assert.deepEqual(importStatement(csv, { bank: 'rheinbank' }), [
    { date: '2026-08-03', description: 'REWE SAGT DANKE; 4711', amountCents: -2345, category: 'groceries' },
    { date: '2026-08-31', description: 'GEHALT AUGUST', amountCents: 315000, category: 'income' },
    { date: '2026-09-01', description: 'DEUTSCHE BAHN', amountCents: -8990, category: 'transport' },
  ]);
});

const july = importStatement([
  'Date,Description,Amount',
  '07/30/2026,ACME PAYROLL,2500.00',
  '07/31/2026,STARBUCKS #123,-5.75',
  '08/01/2026,SAFEWAY,-61.20',
].join('\n'));

// The August export overlaps July's by two days. The same coffee was bought
// twice on 08/01, which is real spending, and the bank changed the spacing
// and casing of one description between exports.
const august = importStatement([
  'Date,Description,Amount',
  '07/31/2026,Starbucks  #123,-5.75',
  '08/01/2026,SAFEWAY,-61.20',
  '08/01/2026,BLUE BOTTLE,-4.50',
  '08/01/2026,BLUE BOTTLE,-4.50',
  '08/02/2026,UBER TRIP,-18.20',
].join('\n'));
// Deep copies taken before any test runs, so a merge that changes its inputs cannot hide it.
const pristine = structuredClone({ july, august });

test('ledger: overlapping statements are not double-counted', () => {
  const ledger = mergeImports(july, august);
  assert.equal(ledger.length, 6);
  assert.deepEqual(ledger.slice(0, 3), july);
  assert.deepEqual(ledger.slice(3).map(t => t.description), ['BLUE BOTTLE', 'BLUE BOTTLE', 'UBER TRIP']);
});

test('ledger: re-importing the same statement adds nothing', () => {
  assert.deepEqual(mergeImports(august, august), august);
});

test('ledger: repeats beyond those already recorded are kept', () => {
  const once = mergeImports([], august.slice(2, 3));
  const merged = mergeImports(once, august);
  assert.equal(merged.filter(t => t.description === 'BLUE BOTTLE').length, 2);
});

test('ledger: inputs are not mutated', () => {
  const existing = structuredClone(pristine.july);
  const incoming = structuredClone(pristine.august);
  mergeImports(existing, incoming);
  assert.deepEqual(existing, pristine.july);
  assert.deepEqual(incoming, pristine.august);
});

test('report: merged overlapping statements give the real August spending', () => {
  const [, aug] = monthlySummary(mergeImports(july, august));
  assert.equal(aug.spendingCents, 6120 + 450 + 450 + 1820);
});
