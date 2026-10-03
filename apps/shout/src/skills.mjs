import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JoshHost } from './josh-host.mjs';
import { shoutTools } from './tools.mjs';

// fileURLToPath decodes the URL: `.pathname` keeps spaces and other characters percent-encoded.
export const builtinSkillsDir = fileURLToPath(new URL('../skills', import.meta.url));
const SKILL_FILE = /^([a-z][a-z0-9-]{0,39})\.allen$/;
const MAX_SOURCE_BYTES = 64 * 1024;
// Host-handled commands. Skills cannot shadow these names.
export const commands = [
  { name: 'skills', description: 'List available skills', args: '' },
  { name: 'help', description: 'Show commands, skills, and how to write a skill', args: '' },
];
// Values SHOUT can supply to a skill entry record. Every field is a String.
export const inputFields = {
  args: 'Text after the command name',
  history: 'Recent conversation, oldest first',
  workspace: 'Absolute workspace path',
  test_command: 'Configured test command (may be empty)',
};

export function skillRoots(workspacePath) {
  const userHome = process.env.SHOUT_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'shout');
  return [
    { scope: 'workspace', dir: join(workspacePath, '.shout', 'skills') },
    { scope: 'user', dir: join(userHome, 'skills') },
    { scope: 'builtin', dir: builtinSkillsDir },
  ];
}

// A run's budgets: model judgments (every attempt counts), host tool calls, questions to the user, and
// wall time. A skill header may set any of them up to the ceiling; a program the agent writes may only lower them.
export const RUN_LIMIT_DEFAULTS = Object.freeze({ judgments: 16, tools: 128, questions: 8, minutes: 30 });
export const RUN_LIMIT_CEILINGS = Object.freeze({ judgments: 32, tools: 256, questions: 16, minutes: 120 });
const LIMIT_MINIMUMS = { judgments: 0, tools: 0, questions: 0, minutes: 1 };

/**
 * Leading `//` comment lines: first line is the description; `args: …` gives an argument hint, and
 * `limits: judgments=4 tools=32 questions=0 minutes=10` (any subset) sets the run's budgets. `limits` holds
 * the valid values given, `limitLines` the header line of each, and `limitErrors` `[{ line, message }]`.
 */
export function parseHeader(source) {
  const lines = [];
  const sourceLines = source.split('\n');
  for (let index = 0; index < sourceLines.length; index++) {
    const match = /^\s*\/\/\s?(.*)$/.exec(sourceLines[index]);
    if (match) lines.push({ text: match[1].trimEnd(), line: index + 1 });
    else if (sourceLines[index].trim()) break;
  }
  const args = lines.find(({ text }) => /^args:/i.test(text))?.text.replace(/^args:\s*/i, '') ?? '';
  const limits = {}; const limitLines = {}; const limitErrors = [];
  for (const { text, line } of lines.filter(({ text }) => /^limits:/i.test(text))) {
    // `key=value` pairs, separated by spaces or commas; spaces around `=` are allowed.
    const pairs = text.replace(/^limits:/i, '').replace(/\s*=\s*/g, '=').split(/[\s,]+/).filter(Boolean);
    if (!pairs.length) limitErrors.push({ line, message: 'The limits line sets nothing. Write key=value pairs, e.g. // limits: judgments=4 minutes=10' });
    for (const pair of pairs) {
      const [, key, value] = /^([^=]*)=(.*)$/.exec(pair) ?? [];
      if (key === undefined) { limitErrors.push({ line, message: `"${pair}" is not key=value. Write limits as judgments=4, tools=32, questions=0 or minutes=10` }); continue; }
      if (!(key in RUN_LIMIT_DEFAULTS)) { limitErrors.push({ line, message: `Unknown limit "${key}". The limits are ${Object.keys(RUN_LIMIT_DEFAULTS).join(', ')}` }); continue; }
      if (key in limitLines) { limitErrors.push({ line, message: `The ${key} limit is set twice` }); continue; }
      limitLines[key] = line;
      const number = /^\d{1,6}$/.test(value) ? Number(value) : NaN;
      if (!(number >= LIMIT_MINIMUMS[key] && number <= RUN_LIMIT_CEILINGS[key])) {
        limitErrors.push({ line, message: `The ${key} limit must be a whole number from ${LIMIT_MINIMUMS[key]} to ${RUN_LIMIT_CEILINGS[key]} (default ${RUN_LIMIT_DEFAULTS[key]}), not "${value}"` });
        continue;
      }
      limits[key] = number;
    }
  }
  const body = lines.map(({ text }) => text).filter(text => !/^(args|limits):/i.test(text));
  return { description: body.find(text => text.trim()) ?? '', help: body.join('\n').trim(), args, limits, limitLines, limitErrors };
}

/** A run's budgets from a parsed header: the defaults, overridden by its limits. A generated program can only lower them. */
export function resolveLimits(header, { generated = false } = {}) {
  const limits = { ...RUN_LIMIT_DEFAULTS, ...header?.limits };
  if (generated) for (const key of Object.keys(limits)) limits[key] = Math.min(limits[key], RUN_LIMIT_DEFAULTS[key]);
  return limits;
}
// A zero limit for an effect the entry declares: the run could only fail there.
const contradictions = [
  ['judgments', effect => effect === 'model.request', 'makes model.request calls'],
  ['questions', effect => effect === 'user.ask', 'asks the user (user.ask)'],
  ['tools', effect => effect.startsWith('tool.'), 'calls host tools'],
];

export class SkillRegistry {
  /** `josh` is the JoshHost whose checker compiles skills; without one the registry opens (and closes) its own. */
  constructor({ josh } = {}) {
    this.ownsJosh = !josh; this.josh = josh ?? new JoshHost({ tools: shoutTools }); this.cache = new Map();
  }
  /** Ends the registry's own JOSH processes (a shared JoshHost is closed by its owner). */
  close() { if (this.ownsJosh) this.josh.close(); }
  /** Compiles source against SHOUT's catalog with JOSH's program/check. Cached by source digest. */
  async check(source) {
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return { ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT003', message: 'Skill source exceeds 64 KiB' }] };
    const key = createHash('sha256').update(source).digest('hex');
    if (!this.cache.has(key)) {
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, this.josh.check(source).catch(error => { this.cache.delete(key); throw error; }));
    }
    return this.cache.get(key);
  }
  /**
   * Compiler check plus SHOUT's entry-input and header-limit rules: exactly what loading a skill enforces.
   * A valid result carries the run's `limits`; `generated` (a program the agent wrote) caps them at the defaults.
   */
  async validate(source, { generated = false } = {}) {
    const checked = await this.check(source);
    const inputError = checked.ok ? entryInputError(checked.entry?.input) : null;
    if (inputError) return { ...checked, ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT006', message: inputError }] };
    const header = parseHeader(source);
    const problems = header.limitErrors.map(({ line, message }) => ({ line, column: 1, code: 'SHOUT008', message }));
    const limits = resolveLimits(header, { generated });
    if (checked.ok) {
      const effects = checked.entry?.effects ?? [];
      for (const [key, uses, what] of contradictions) {
        if (limits[key] === 0 && key in header.limits && effects.some(uses)) problems.push({ line: header.limitLines[key], column: 1, code: 'SHOUT009', message: `${key}=0, but the entry ${what}. Raise the limit or remove the effect` });
      }
    }
    if (problems.length) return { ...checked, ok: false, diagnostics: [...(checked.diagnostics ?? []), ...problems] };
    return checked.ok ? { ...checked, limits } : checked;
  }
  /** All skills visible to a workspace; earlier scopes shadow later ones. Files are re-read every call. */
  async list(workspacePath) {
    const found = new Map();
    for (const { scope, dir } of skillRoots(workspacePath)) {
      let names = [];
      try { names = (await readdir(dir)).sort(); } catch { continue; }
      for (const file of names) {
        const match = SKILL_FILE.exec(file);
        if (!match || found.has(match[1]) || commands.some(command => command.name === match[1])) continue;
        const path = join(dir, file);
        try { if (!(await stat(path)).isFile()) continue; } catch { continue; }
        found.set(match[1], { name: match[1], scope, path });
      }
    }
    return Promise.all([...found.values()].map(skill => this.load(skill)));
  }
  async load(skill, { withSource = false } = {}) {
    let source;
    try { source = await readFile(skill.path, 'utf8'); }
    catch (error) { return { ...skill, description: '', args: '', ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT004', message: error.message }], capabilities: [], tools: [] }; }
    const { limits: _limits, limitLines: _lines, limitErrors: _errors, ...header } = parseHeader(source);
    let checked;
    try { checked = await this.validate(source); }
    catch (error) { checked = { ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT005', message: `Checker unavailable: ${error.message}` }] }; }
    return {
      ...skill, ...header,
      ok: checked.ok,
      diagnostics: checked.diagnostics ?? [],
      capabilities: checked.capabilities ?? [], tools: checked.tools ?? [], entry: checked.entry ?? null,
      limits: checked.limits ?? null,
      ...(withSource ? { source } : {}),
    };
  }
  async find(workspacePath, name, options) {
    const skill = (await this.list(workspacePath)).find(candidate => candidate.name === name);
    return skill && options?.withSource ? this.load(skill, options) : skill;
  }
}

export function catalogParams() {
  return { schema_dialect: 'https://json-schema.org/draft/2020-12/schema',
    metadata: { source: 'shout', source_revision: '0.1.0', observed_at_unix_ms: Date.now(), freshness: 'current', complete: true },
    tools: [...shoutTools].sort((a, b) => a.name.localeCompare(b.name)) };
}

function entryInputError(input) {
  if (!input || input.type === 'void' || input.type === 'string') return null;
  if (input.type !== 'record') return 'The skill entry must take no parameter, a String (the command arguments), or a record of String fields';
  for (const [name, field] of Object.entries(input.fields)) {
    if (!(name in inputFields)) return `Unsupported entry input field "${name}". Available String fields: ${Object.keys(inputFields).join(', ')}`;
    if (field.type !== 'string') return `Entry input field "${name}" must be a String`;
  }
  return null;
}

export function buildInput(input, values) {
  if (!input || input.type === 'void') return null;
  if (input.type === 'string') return values.args;
  return Object.fromEntries(Object.keys(input.fields).map(name => [name, values[name] ?? '']));
}

/** Chat text for a skill result: strings as-is, a record's message/summary/text field, otherwise JSON. */
export function renderOutput(value) {
  if (value === null || value === undefined) return 'Done.';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (value.tag === 'Some' && 'value' in value) return renderOutput(value.value);
    if (value.tag === 'None') return 'Done.';
    const text = ['message', 'summary', 'text', 'report'].map(key => value[key]).find(field => typeof field === 'string');
    if (text !== undefined) return text;
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** ALLEN type spelling for a catalog JSON schema, used in the authoring guide. */
export function allenType(schema) {
  if (schema.type === 'string') return 'String';
  if (schema.type === 'boolean') return 'Bool';
  if (schema.type === 'integer') return schema.maximum < 1e9 ? `Int (${schema.minimum}–${schema.maximum})` : 'Int';
  if (schema.type === 'number') return 'Float';
  if (schema.type === 'array') return `List<${allenType(schema.items)}> (${schema.minItems}–${schema.maxItems} items)`;
  if (schema.type === 'object') return `{ ${Object.entries(schema.properties).map(([key, value]) => `${key}: ${allenType(value)}`).join(', ')} }`;
  return 'unknown';
}

export function catalogReference() {
  return [...shoutTools].sort((a, b) => a.name.localeCompare(b.name)).map(tool =>
    `- \`${tool.name}\` (effect \`tool.${tool.name}@1\`): ${tool.description}\n  input ${allenType(tool.input_schema)}\n  output ${allenType(tool.output_schema)}`).join('\n');
}

export async function skillGuide() {
  const guide = await readFile(join(builtinSkillsDir, 'GUIDE.md'), 'utf8');
  return `${guide.trim()}\n\n## Tool catalog (generated)\n\nCall as \`await tools.<name>.call(input)\`, which returns \`Result<Output, Error>\`. List each tool in the manifest \`tools.required\` with version ">=1.0.0, <2.0.0" and its effect in the function's \`effects [...]\`.\n\n${catalogReference()}\n\n## Entry input fields\n\n${Object.entries(inputFields).map(([name, text]) => `- \`${name}: String\`: ${text}`).join('\n')}\n`;
}
