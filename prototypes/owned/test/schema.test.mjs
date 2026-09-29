import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackCodec, callbackSchema, schemaErrors, validate, SchemaRejection } from '../src/schema.mjs';

const float = { type: 'float', finite: 'number', nonfinite: ['NaN', 'Infinity', '-Infinity'] };
const wire = (descriptor, value) => JSON.stringify(callbackCodec(descriptor).toWire(value));

test('floats keep a decimal point on the wire; non-finite floats are named strings', () => {
  assert.equal(wire(float, 3), '3.0');
  assert.equal(wire(float, -0), '-0.0');
  assert.equal(wire(float, 2.5), '2.5');
  assert.equal(wire(float, 1e21), '1e+21');
  assert.equal(wire(float, 'NaN'), '"NaN"');
  const { schema } = callbackCodec(float);
  assert.equal(schemaErrors(schema, 'NaN'), null);
  assert.notEqual(schemaErrors(schema, 'nan'), null);
});

test('map keys are sorted in JOSH order: UTF-8 bytes, not UTF-16 code units', () => {
  const map = { type: 'map', key: { type: 'string' }, value: { type: 'integer' } };
  // U+FB01 sorts after U+1F600 in UTF-16 but before it in UTF-8.
  assert.equal(wire(map, [{ key: '😀', value: 1 }, { key: 'ﬁ', value: 2 }]), '[["ﬁ",2],["😀",1]]');
  const ints = { type: 'map', key: { type: 'integer' }, value: { type: 'boolean' } };
  assert.equal(wire(ints, [{ key: 10, value: true }, { key: -2, value: false }]), '[[-2,false],[10,true]]');
});

test('values that do not have the model shape pass through unchanged for JOSH to report', () => {
  const tuple = { type: 'tuple', items: [{ type: 'string' }, { type: 'integer' }] };
  const colors = { type: 'tagged_union', tag: 'tag', variants: [{ tag: 'Red', fields: {} }] };
  assert.deepEqual(callbackCodec(tuple).toWire({ 0: 'a' }), { 0: 'a' });
  assert.deepEqual(callbackCodec(tuple).toWire(['a', 1]), ['a', 1]);
  assert.deepEqual(callbackCodec(colors).toWire(42), 42);
  assert.deepEqual(callbackCodec({ type: 'map', key: { type: 'string' }, value: { type: 'string' } }).toWire(['x']), ['x']);
});

test('unsupported descriptors fail closed and rejections carry the value and issues', () => {
  assert.throws(() => callbackSchema({ type: 'unsupported' }), /Unsupported callback descriptor type: unsupported/);
  const schema = callbackSchema({ type: 'object', required: ['n'], properties: { n: { type: 'integer' } } });
  let error;
  try { validate(schema, { n: 'x' }); } catch (caught) { error = caught; }
  assert.ok(error instanceof SchemaRejection);
  assert.match(error.message, /^Schema rejected response: \/n type$/);
  assert.deepEqual([error.value, error.schema === schema, error.issues], [{ n: 'x' }, true, [{ path: '/n', code: 'type' }]]);
});

test('issue paths from JOSH point into the answer as the model gave it', () => {
  const descriptor = { type: 'object', required: ['color', 'counts', 'shape', 'pair'], properties: {
    color: { type: 'tagged_union', tag: 'tag', variants: [{ tag: 'Red', fields: {} }] },
    counts: { type: 'map', key: { type: 'string' }, value: { type: 'integer' } },
    shape: { type: 'tagged_union', tag: 'tag', variants: [{ tag: 'Dot', fields: {} },
      { tag: 'Line', fields: { value: { type: 'tuple', items: [{ type: 'integer' }, { type: 'newtype', wire: { type: 'map', key: { type: 'string' }, value: { type: 'boolean' } } }] } } }] },
    pair: { type: 'tuple', items: [{ type: 'string' }, { type: 'integer' }] } } };
  const answer = { color: 'Blue', counts: [{ key: 'a', value: 'x' }], shape: { tag: 'Line', value: { 0: 1, 1: [{ key: 'k', value: 2 }] } }, pair: { 0: 'x', 1: 'y' } };
  const paths = ['/color/tag', '/counts/0/1', '/shape/value/1/0/1', '/shape/tag', '/pair/1', '', '/unknown/deep'];
  assert.deepEqual(callbackCodec(descriptor).modelIssues(paths.map(path => ({ path, code: 'type' })), answer).map(issue => issue.path),
    ['/color', '/counts/0/value', '/shape/value/1/0/value', '/shape/tag', '/pair/1', '', '/unknown/deep']);
});
