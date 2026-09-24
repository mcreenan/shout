import Ajv from 'ajv';
const ajv = new Ajv({ strict: true, allErrors: true });
// The ALLEN callback descriptor is not universally JSON Schema. This slice supports
// exact records, arrays and primitive values. Unsupported types fail closed.
export function callbackSchema(descriptor) {
  switch (descriptor.type) {
    case 'string': case 'boolean': case 'null': return { type: descriptor.type };
    case 'integer': return { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
    case 'array': return { type: 'array', items: callbackSchema(descriptor.items) };
    case 'object': return { type: 'object', additionalProperties: false, required: descriptor.required,
      properties: Object.fromEntries(Object.entries(descriptor.properties).map(([key, value]) => [key, callbackSchema(value)])) };
    default: throw new Error(`Unsupported callback descriptor type: ${descriptor.type}`);
  }
}
export function validate(schema, value) {
  const checker = ajv.compile(schema);
  if (!checker(value)) throw new Error(`Schema rejected response: ${checker.errors.map(e => `${e.instancePath || '/'} ${e.keyword}`).join(', ')}`);
  return value;
}
export const record = properties => ({ type: 'object', properties, required: Object.keys(properties).sort(), additionalProperties: false });
export const textField = { type: 'string' };
export const chatSchema = record({ action: { type: 'string', enum: ['reply', 'review'] }, text: textField });
