import { record, textField } from '../../../prototypes/owned/src/schema.mjs';

const list = (items, maxItems) => ({ type: 'array', items, minItems: 0, maxItems });
const integer = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const change = record({ path: textField, before: textField, after: textField });
const definition = (name, description, input_schema, output_schema, idempotency) => ({
  name, version: '1.0.0', description, input_schema, output_schema,
  error_schema: record({ message: textField }), effects: [], idempotency,
});

// This frozen per-run catalog is also the ALLEN compiler's exact tool contract.
export const codingTools = [
  definition('apply_changes', 'Apply an approved set of exact before/after file replacements within the selected workspace.',
    record({ changes: list(change, 8) }), record({ changed: list(textField, 8) }), 'non_idempotent'),
  definition('inspect_workspace', 'Read a bounded snapshot of eligible text files in the selected workspace.',
    record({}), record({ files: list(record({ path: textField, content: textField }), 256), summary: textField }), 'idempotent'),
  definition('run_tests', 'Run the workspace test command chosen by the user and return the observed outcome.',
    record({}), record({ passed: { type: 'boolean' }, output: textField, exitCode: integer, skipped: { type: 'boolean' } }), 'non_idempotent'),
];
