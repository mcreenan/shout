import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slug.mjs';

test('trims and lowercases', () => assert.equal(slugify('  Hello World  '), 'hello-world'));
test('normalizes accented characters', () => assert.equal(slugify('Crème brûlée'), 'creme-brulee'));
test('collapses punctuation and repeated separators', () => assert.equal(slugify('Hello___&---Goodbye!'), 'hello-goodbye'));
test('keeps digits', () => assert.equal(slugify('Release 42'), 'release-42'));
test('empty and punctuation-only inputs produce no slug', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('?!___'), '');
});
