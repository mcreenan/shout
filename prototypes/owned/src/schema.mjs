import Ajv from 'ajv';
const ajv = new Ajv({ strict: true, allErrors: true });

/**
 * JSON Schema and wire translation for JOSH typed-response callbacks (model.request<T>, user.ask<T>).
 *
 * JOSH describes the response type T with a descriptor (allen-runtime `schema_descriptor`): integer,
 * float, boolean, string, bytes, null (Void), array, tuple, object (record), tagged_union (Option,
 * Result and user enums), map, and newtype. The schema below is what a model or the ask form must
 * produce ("model shape"). It uses only keywords that both structured-output modes accept (Codex
 * `--output-schema` strict mode and the Claude Agent SDK's json_schema output): type, properties,
 * required, additionalProperties: false, items, enum and anyOf. Every object lists all of its
 * properties as required, and there are no numeric, length or tuple keywords.
 *
 * Where JOSH's wire encoding cannot be expressed that way, the model shape differs and `toWire`
 * translates it:
 * - Tuple (T, U): an object {"0": T, "1": U} becomes the array [T, U].
 * - Enum whose variants have no payload: the string "Red" becomes {"tag": "Red"}. Option, Result
 *   and enums with payloads keep JOSH's tagged form {"tag": "Some", "value": T} (no "value" when
 *   the payload is Void or absent).
 * - Map<K, V>: an array of {"key": K, "value": V} becomes JOSH's [[K, V], ...], sorted by key in
 *   JOSH's order (Bool, Int, String and Bytes keys; other keys keep the model's order).
 * - Float: any JSON number, or "NaN", "Infinity" or "-Infinity". A whole number is sent as 3.0,
 *   because JOSH reads 3 as an Int and rejects it for a Float.
 * Everything else (records, lists, Int, Bool, String, Bytes as {"$bytes": base64}, Void as null,
 * newtypes as their underlying type) has the same shape on both sides.
 *
 * The schema accepts exactly the model-shape values whose translation JOSH decodes, except what
 * JSON Schema cannot state: Int within 64 bits, canonical base64, and distinct map keys. JOSH
 * checks those and re-asks when its own validation fails.
 */
export function callbackCodec(descriptor) {
  return { schema: schemaOf(descriptor), toWire: value => toWire(descriptor, value),
    modelIssues: (issues, answer) => issues.map(issue => ({ ...issue, path: modelPath(descriptor, issue.path, answer) })) };
}

/** The model-shape JSON Schema for one callback descriptor. Unsupported descriptors fail closed. */
export function callbackSchema(descriptor) { return schemaOf(descriptor); }

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const unitOnly = descriptor => descriptor.variants.every(variant => !Object.keys(variant.fields ?? {}).length);

function schemaOf(descriptor) {
  switch (descriptor?.type) {
    case 'string': case 'boolean': case 'null': return { type: descriptor.type };
    case 'integer': return { type: 'integer' };
    case 'float': return { anyOf: [{ type: 'number' }, { type: 'string', enum: descriptor.nonfinite ?? ['NaN', 'Infinity', '-Infinity'] }] };
    case 'bytes': return object({ $bytes: { type: 'string' } });
    case 'array': return { type: 'array', items: schemaOf(descriptor.items) };
    case 'tuple': return object(Object.fromEntries(descriptor.items.map((item, index) => [String(index), schemaOf(item)])));
    case 'object': return object(Object.fromEntries(Object.entries(descriptor.properties).map(([key, value]) => [key, schemaOf(value)])), [...descriptor.required]);
    case 'tagged_union':
      if (descriptor.tag !== 'tag' || !Array.isArray(descriptor.variants) || !descriptor.variants.length) break;
      if (unitOnly(descriptor)) return { type: 'string', enum: descriptor.variants.map(variant => variant.tag) };
      return { anyOf: descriptor.variants.map(variant => object({ tag: { type: 'string', enum: [variant.tag] },
        ...Object.fromEntries(Object.entries(variant.fields ?? {}).map(([key, value]) => [key, schemaOf(value)])) })) };
    case 'map': return { type: 'array', items: object({ key: schemaOf(descriptor.key), value: schemaOf(descriptor.value) }) };
    case 'newtype': return schemaOf(descriptor.wire);
  }
  throw new Error(`Unsupported callback descriptor type: ${descriptor?.type}`);
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Translation is total: a value that does not have the model shape passes through unchanged, so
// JOSH still sees it and reports exactly what is wrong.
function toWire(descriptor, value) {
  switch (descriptor?.type) {
    case 'float':
      // JSON.rawJSON keeps the decimal point that JSON.stringify would drop from a whole number.
      if (typeof value === 'number' && Number.isInteger(value) && typeof JSON.rawJSON === 'function') {
        return JSON.rawJSON(Object.is(value, -0) ? '-0.0' : Math.abs(value) < 1e21 ? value.toFixed(1) : String(value));
      }
      return value;
    case 'array': return Array.isArray(value) ? value.map(item => toWire(descriptor.items, item)) : value;
    case 'tuple': {
      const keys = descriptor.items.map((_, index) => String(index));
      if (plain(value) && Object.keys(value).length === keys.length && keys.every(key => key in value)) {
        return keys.map((key, index) => toWire(descriptor.items[index], value[key]));
      }
      return Array.isArray(value) && value.length === keys.length ? value.map((item, index) => toWire(descriptor.items[index], item)) : value;
    }
    case 'object':
      return plain(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, key in descriptor.properties ? toWire(descriptor.properties[key], item) : item])) : value;
    case 'tagged_union': {
      if (unitOnly(descriptor) && typeof value === 'string') return { tag: value };
      if (!plain(value)) return value;
      const variant = descriptor.variants.find(candidate => candidate.tag === value.tag);
      if (!variant) return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, variant.fields && key in variant.fields ? toWire(variant.fields[key], item) : item]));
    }
    case 'map': {
      if (!Array.isArray(value)) return value;
      const pairs = value.map(entry => plain(entry) && 'key' in entry && 'value' in entry && Object.keys(entry).length === 2
        ? [toWire(descriptor.key, entry.key), toWire(descriptor.value, entry.value)] : entry);
      return pairs.every(Array.isArray) ? [...pairs].sort((left, right) => compareKeys(left[0], right[0])) : pairs;
    }
    case 'newtype': return toWire(descriptor.wire, value);
    default: return value;
  }
}

const unescapePointer = segment => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const escapePointer = segment => segment.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Map a JSON Pointer into JOSH's wire value onto the model-shape answer it came from: `/color/tag`
 * of a payload-free enum is `/color`, `/counts/1/0` of a map is `/counts/1/key`. `answer` (the
 * model-shape value) picks the variant of an enum with payloads. Unknown parts are kept as they are.
 */
function modelPath(descriptor, path, answer) {
  const segments = String(path ?? '').split('/').slice(1).map(unescapePointer);
  const out = [];
  let current = descriptor; let value = answer;
  for (let index = 0; index < segments.length; index++) {
    while (current?.type === 'newtype') current = current.wire;
    const segment = segments[index];
    if (!current) { out.push(...segments.slice(index)); break; }
    switch (current.type) {
      case 'object': out.push(segment); current = current.properties?.[segment]; value = value?.[segment]; break;
      case 'array': out.push(segment); current = current.items; value = value?.[segment]; break;
      case 'tuple': out.push(segment); current = current.items?.[Number(segment)]; value = value?.[segment]; break;
      case 'map': {
        out.push(segment);
        const part = segments[index + 1];
        if (part === '0' || part === '1') {
          const field = part === '0' ? 'key' : 'value';
          out.push(field); index++; current = current[field]; value = value?.[segment]?.[field];
        } else current = undefined;
        break;
      }
      case 'tagged_union':
        if (unitOnly(current) && segment === 'tag') { current = undefined; break; }
        out.push(segment);
        if (segment === 'value') {
          current = current.variants.find(variant => variant.tag === value?.tag)?.fields?.value;
          value = value?.value;
        } else current = undefined;
        break;
      default: out.push(segment); current = undefined;
    }
  }
  return out.map(segment => `/${escapePointer(segment)}`).join('');
}

// JOSH's map key order (allen-vm compare_map_keys): Bool, Int, String and Bytes by value, strings
// and bytes by their bytes. Other keys compare equal, and the stable sort keeps their order.
function compareKeys(left, right) {
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return Buffer.compare(Buffer.from(left), Buffer.from(right));
  if (plain(left) && plain(right) && typeof left.$bytes === 'string' && typeof right.$bytes === 'string') {
    return Buffer.compare(Buffer.from(left.$bytes, 'base64'), Buffer.from(right.$bytes, 'base64'));
  }
  return 0;
}

/** A value that does not match its schema. `value` is the rejected value and `issues` say why. */
export class SchemaRejection extends Error {
  constructor(value, schema, errors) {
    super(`Schema rejected response: ${errors.map(error => `${error.instancePath || '/'} ${error.keyword}`).join(', ')}`);
    this.name = 'SchemaRejection'; this.value = value; this.schema = schema;
    this.issues = errors.slice(0, 16).map(error => ({ path: error.instancePath, code: error.keyword }));
  }
}

const compiled = new WeakMap();
const checkerFor = schema => {
  let checker = compiled.get(schema);
  if (!checker) { checker = ajv.compile(schema); compiled.set(schema, checker); }
  return checker;
};
/** The validation errors of a value against a schema, or null when it matches. */
export function schemaErrors(schema, value) {
  const checker = checkerFor(schema);
  return checker(value) ? null : checker.errors;
}
export function validate(schema, value) {
  const errors = schemaErrors(schema, value);
  if (errors) throw new SchemaRejection(value, schema, errors);
  return value;
}
export const record = properties => ({ type: 'object', properties, required: Object.keys(properties).sort(), additionalProperties: false });
export const textField = { type: 'string' };
export const chatSchema = record({ action: { type: 'string', enum: ['reply', 'review'] }, text: textField });
