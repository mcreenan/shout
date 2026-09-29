import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackCodec, schemaErrors } from '../../../prototypes/owned/src/schema.mjs';
import { kindOf, schemaIssues, reason } from '../public/ask-form.js';

// Descriptors for every answer type, turned into the kernel's own model-shape schema.
const str = { type: 'string' };
const int = { type: 'integer' };
const float = { type: 'float', finite: 'number', nonfinite: ['NaN', 'Infinity', '-Infinity'] };
const union = (...variants) => ({ type: 'tagged_union', tag: 'tag', variants: variants.map(([tag, value]) => ({ tag, fields: value ? { value } : {} })) });
const record = (properties) => ({ type: 'object', required: Object.keys(properties), properties });
const shape = union(['Dot'], ['Line', { type: 'tuple', items: [int, str] }], ['Box', record({ width: float })]);
const descriptor = record({
  name: union(['None'], ['Some', str]), missing: union(['None'], ['Some', int]), ratio: float, whole: float,
  color: union(['Red'], ['Blue']), line: shape, box: shape, dot: shape,
  counts: { type: 'map', key: str, value: int }, pair: { type: 'tuple', items: [str, int] }, score: { type: 'newtype', wire: int },
  tags: { type: 'array', items: { type: 'array', items: { type: 'boolean' } } }, raw: { type: 'bytes' },
  outcome: union(['Ok', int], ['Err', str]), nothing: { type: 'null' }, plan: union(['None'], ['Some', record({ steps: { type: 'array', items: str } })]),
});
const { schema } = callbackCodec(descriptor);
const valid = {
  name: { tag: 'Some', value: 'Ada' }, missing: { tag: 'None' }, ratio: 0.25, whole: 'Infinity', color: 'Blue',
  line: { tag: 'Line', value: { 0: 7, 1: 'seven' } }, box: { tag: 'Box', value: { width: 2 } }, dot: { tag: 'Dot' },
  counts: [{ key: 'é', value: 2 }, { key: 'b', value: 1 }], pair: { 0: 'x', 1: -4 }, score: 9, tags: [[true], []],
  raw: { $bytes: 'aGk=' }, outcome: { tag: 'Err', value: 'no' }, nothing: null, plan: { tag: 'Some', value: { steps: ['a'] } },
};

test('each answer type gets its control', () => {
  const kinds = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, kindOf(value)]));
  assert.deepEqual(kinds, {
    name: 'option', missing: 'option', ratio: 'float', whole: 'float', color: 'enum', line: 'union', box: 'union', dot: 'union',
    counts: 'map', pair: 'tuple', score: 'integer', tags: 'list', raw: 'bytes', outcome: 'union', nothing: 'null', plan: 'option',
  });
  assert.equal(kindOf(schema), 'record');
  assert.equal(kindOf(schema.properties.tags.items), 'list');
  assert.equal(kindOf({ anyOf: [{ type: 'string' }, { type: 'integer' }] }), 'json', 'what the form cannot express falls back to JSON');
  assert.equal(kindOf(undefined), 'json');
});

test('the local check agrees with the kernel (Ajv) and points at the field', () => {
  assert.equal(schemaErrors(schema, valid), null);
  assert.deepEqual(schemaIssues(schema, valid), []);
  const broken = [
    [{ color: { tag: 'Blue' } }, [{ path: '/color', code: 'type' }]],
    [{ line: { tag: 'Arc' } }, [{ path: '/line/tag', code: 'tag' }]],
    [{ line: { tag: 'Line', value: { 0: 1 } } }, [{ path: '/line/value/1', code: 'required' }]],
    [{ ratio: 'nan' }, [{ path: '/ratio', code: 'type' }]],
    [{ counts: [{ key: 'a' }] }, [{ path: '/counts/0/value', code: 'required' }]],
    [{ pair: { 0: 'x', 1: 1.5 } }, [{ path: '/pair/1', code: 'type' }]],
    [{ score: 2.5 }, [{ path: '/score', code: 'type' }]],
    [{ tags: [[1]] }, [{ path: '/tags/0/0', code: 'type' }]],
    [{ raw: { $bytes: 5 } }, [{ path: '/raw/$bytes', code: 'type' }]],
    [{ nothing: 0 }, [{ path: '/nothing', code: 'type' }]],
    [{ bogus: 1 }, [{ path: '/bogus', code: 'unknown' }]],
    [{ name: { tag: 'Some' } }, [{ path: '/name/value', code: 'required' }]],
  ];
  for (const [change, issues] of broken) {
    const value = { ...structuredClone(valid), ...change };
    assert.notEqual(schemaErrors(schema, value), null, JSON.stringify(change));
    assert.deepEqual(schemaIssues(schema, value), issues, JSON.stringify(change));
  }
  const missing = structuredClone(valid);
  delete missing.score;
  assert.deepEqual(schemaIssues(schema, missing), [{ path: '/score', code: 'required' }]);
});

test('every issue code has a short reason', () => {
  for (const code of ['type', 'required', 'unknown', 'range', 'fields', 'length', 'encoding', 'tag', 'order', 'something-new']) {
    const words = reason(code).split(' ').length;
    assert.ok(words >= 2 && words <= 3, `${code}: ${reason(code)}`);
  }
});
