import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { joshBinary } from '../../../prototypes/owned/src/transport.mjs';
import { shoutTools } from './tools.mjs';

export const builtinSkillsDir = resolve(dirname(new URL(import.meta.url).pathname), '../skills');
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

/** Leading `//` comment lines: first line is the description; `args: …` gives an argument hint. */
export function parseHeader(source) {
  const lines = [];
  for (const line of source.split('\n')) {
    const match = /^\s*\/\/\s?(.*)$/.exec(line);
    if (match) lines.push(match[1].trimEnd());
    else if (line.trim()) break;
  }
  const args = lines.find(line => /^args:/i.test(line))?.replace(/^args:\s*/i, '') ?? '';
  const body = lines.filter(line => !/^args:/i.test(line));
  return { description: body.find(line => line.trim()) ?? '', help: body.join('\n').trim(), args };
}

export class SkillRegistry {
  constructor({ stateRoot, checker = process.env.SHOUT_ALLEN_CHECK } = {}) {
    this.stateRoot = stateRoot; this.checker = checker; this.cache = new Map();
  }
  checkerPath() { return this.checker ?? join(dirname(joshBinary()), 'shout-allen-check'); }
  async catalogFile() {
    this.catalogPath ??= (async () => {
      const path = join(this.stateRoot, 'shout-tool-catalog.json');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(catalogParams()), { mode: 0o600 });
      return path;
    })();
    return this.catalogPath;
  }
  /** Compiles source against SHOUT's catalog. Cached by source digest. */
  async check(source) {
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return { ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT003', message: 'Skill source exceeds 64 KiB' }] };
    const key = createHash('sha256').update(source).digest('hex');
    if (!this.cache.has(key)) {
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, runChecker(this.checkerPath(), await this.catalogFile(), source).catch(error => { this.cache.delete(key); throw error; }));
    }
    return this.cache.get(key);
  }
  /** Compiler check plus SHOUT's entry-input rules: exactly what loading a skill enforces. */
  async validate(source) {
    const checked = await this.check(source);
    const inputError = checked.ok ? entryInputError(checked.entry?.input) : null;
    if (inputError) return { ...checked, ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT006', message: inputError }] };
    return checked;
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
    const header = parseHeader(source);
    let checked;
    try { checked = await this.validate(source); }
    catch (error) { checked = { ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT005', message: `Checker unavailable: ${error.message}` }] }; }
    return {
      ...skill, ...header,
      ok: checked.ok,
      diagnostics: checked.diagnostics ?? [],
      capabilities: checked.capabilities ?? [], tools: checked.tools ?? [], entry: checked.entry ?? null,
      ...(withSource ? { source } : {}),
    };
  }
  async find(workspacePath, name, options) {
    const skill = (await this.list(workspacePath)).find(candidate => candidate.name === name);
    return skill && options?.withSource ? this.load(skill, options) : skill;
  }
}

function runChecker(binary, catalog, source) {
  return new Promise((resolveCheck, reject) => {
    const child = execFile(binary, [catalog], { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      // A compiler panic is a property of this source, not an unavailable checker.
      const panic = /panicked at [^\n]*\n([^\n]*)/.exec(stderr);
      if (panic) return resolveCheck({ ok: false, diagnostics: [{ line: 1, column: 1, code: 'SHOUT007', message: `The ALLEN compiler crashed on this source (a compiler bug, not your error): ${panic[1].trim()}. Restructuring the program usually avoids it.` }] });
      if (error) return reject(new Error(stderr.trim() || error.message));
      let result;
      try { result = JSON.parse(stdout); } catch { return reject(new Error('Checker returned invalid JSON')); }
      for (const diagnostic of result.diagnostics ?? []) {
        if (/not in the frozen catalog/.test(diagnostic.message)) diagnostic.message += '. Add the tool to the manifest tools.required list, and check its name against the SHOUT tool catalog.';
      }
      resolveCheck(result);
    });
    child.stdin.end(source);
  });
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
