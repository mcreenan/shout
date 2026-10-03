import { JoshConnection } from '../../../prototypes/owned/src/connection.mjs';
import { shoutTools } from './tools.mjs';

// A run connection may load up to 32 programs and start 1,024 executions (JOSH's own ceilings; it has
// no program/unload). One goes back to the pool only below these, so the next run always has room.
const RUN_LIMITS = { max_loaded_programs: 32, max_total_executions: 1024 };
const MAX_PROGRAMS = 31; const MAX_EXECUTIONS = 1000; const MAX_IDLE = 2;
const CHECK_TIMEOUT_MS = 30_000;
const MISSING_MANIFEST = 'a skill must begin with an inline manifest { ... } block';

/**
 * SHOUT's long-lived JOSH processes: one **checker** connection that serves `program/check`, one check
 * at a time, and a **pool** of run connections, handed to one run at a time by `acquire()`.
 *
 * Checks are serial so that a compiler panic, which takes the whole `josh serve` down, is traced to
 * the source that caused it; the checker is opened again on the next check. A run connection goes back
 * to the pool only after JOSH finished its execution (see `JoshConnection.release`). The pool keeps one
 * connection warm: from the first check or run on, one is open (idle or in use) at all times.
 * Every process starts lazily, and idle ones don't keep Node running. `close()` ends them all.
 */
export class JoshHost {
  constructor({ tools = shoutTools, checkTimeoutMs = CHECK_TIMEOUT_MS, log } = {}) {
    this.tools = tools; this.checkTimeoutMs = checkTimeoutMs; this.log = log;
    this.checker = null; this.idle = []; this.pool = new Set(); this.closed = false; this.checks = Promise.resolve();
  }
  connect(limits) {
    const connection = new JoshConnection({ tools: this.tools, limits, log: this.log, onRelease: (released, { clean }) => this.release(released, clean) });
    connection.onClose = () => {
      if (connection === this.checker) { this.checker = null; return; }
      this.pool.delete(connection);
      const at = this.idle.indexOf(connection);
      if (at !== -1) this.idle.splice(at, 1);
      this.warm();
    };
    return connection;
  }
  // Opens a run connection when none is open, so the next run need not wait for one. It is called when a
  // connection closes, from JOSH's exit handler, so a JOSH that cannot start is left to acquire() to report.
  warm() {
    if (this.closed || this.pool.size) return;
    let connection;
    try { connection = this.connect(RUN_LIMITS); } catch { return; }
    this.pool.add(connection); this.idle.push(connection);
  }
  /** A handshaken run connection for one run. The run releases it when it ends. */
  async acquire() {
    for (let attempt = 1; ; attempt++) {
      if (this.closed) throw new Error('JOSH host is closed');
      // The most recently used connection first: it is the likeliest to have the program loaded.
      let connection = this.idle.pop();
      if (!connection) { connection = this.connect(RUN_LIMITS); this.pool.add(connection); }
      try {
        await connection.ready;
        if (connection.closed) throw connection.failure ?? new Error('JOSH connection closed');
        return connection;
      } catch (error) {
        connection.retire();
        if (attempt >= 2) throw error;
      }
    }
  }
  release(connection, clean) {
    if (clean && !this.closed && connection.programs < MAX_PROGRAMS && connection.executions < MAX_EXECUTIONS && this.idle.length < MAX_IDLE) this.idle.push(connection);
    else connection.retire();
  }
  /**
   * Compiles a source against the catalog without running it: `{ ok, diagnostics, entry: { name, input,
   * output, effects }, capabilities, tools, debug }`. Rejects only when JOSH itself is unavailable.
   */
  check(source) {
    const next = this.checks.then(() => this.checkNow(source));
    this.checks = next.catch(() => {});
    return next;
  }
  async checkNow(source) {
    if (this.closed) throw new Error('JOSH host is closed');
    this.warm();
    const checker = this.checker ??= this.connect({});
    let timer; let timedOut = false;
    try {
      await checker.ready;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error(`ALLEN check timed out after ${this.checkTimeoutMs / 1000} s`)); }, this.checkTimeoutMs); });
      return checkResult(await Promise.race([checker.check(source), timeout]), source);
    } catch (error) {
      if (timedOut) { checker.retire(); throw error; }
      // A source problem without compiler diagnostics (a bundle JOSH refuses, such as one too large).
      if (/^(program|catalog)\./.test(error.wire?.code ?? '')) return failed('SHOUT002', error.wire.message);
      if (checker.failure) {
        // A compiler panic is a property of this source, not an unavailable checker.
        await Promise.race([checker.exited, new Promise(resolveWait => setTimeout(resolveWait, 1000).unref())]);
        const panic = compilerPanic(checker.transport.diagnostics);
        if (panic) return panic;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  /** Ends every JOSH process. A run still attached to one is interrupted, as if its JOSH had exited. */
  close() {
    this.closed = true;
    for (const connection of [this.checker, ...this.pool]) {
      connection?.run?.onFailure(new Error('JOSH host closed'));
      connection?.retire();
    }
    this.idle = [];
  }
}

const failed = (code, message) => ({ ok: false, diagnostics: [{ line: 1, column: 1, code, message }] });

/** SHOUT007 for a `josh serve` stderr tail that shows a panic, else null. */
export function compilerPanic(stderr) {
  const panic = /panicked at [^\n]*\n([^\n]*)/.exec(stderr ?? '');
  return panic ? failed('SHOUT007', `The ALLEN compiler crashed on this source (a compiler bug, not your error): ${panic[1].trim()}. Restructuring the program usually avoids it.`) : null;
}

/** A `program/check` result in SHOUT's shape. */
export function checkResult(checked, source) {
  if (checked.diagnostics?.length) {
    for (const diagnostic of checked.diagnostics) {
      if (/not in the frozen catalog/.test(diagnostic.message)) diagnostic.message += '. Add the tool to the manifest tools.required list, and check its name against the SHOUT tool catalog.';
    }
    return { ok: false, diagnostics: checked.diagnostics };
  }
  // JOSH compiles a source without a manifest with an empty one; a skill must declare its own.
  if (!opensWithManifest(source)) return failed('SHOUT001', MISSING_MANIFEST);
  const contract = checked.entries.find(entry => entry.name === 'main') ?? checked.entries[0];
  const entry = contract ? { name: contract.name, input: describe(contract.input_descriptor), output: describe(contract.output_descriptor), effects: contract.effects } : null;
  // program/check has no manifest fields, so the declared capabilities are read from the (compiled) source.
  return { ok: true, diagnostics: [], entry,
    capabilities: manifestCapabilities(source) ?? (contract?.effects ?? []).filter(effect => !effect.startsWith('tool.')),
    tools: checked.required_tools, debug: checked.debug ?? null };
}

// The end of the comment at `at`: a line comment, or a block comment (which nests).
const commentEnd = (source, at) => {
  if (source.startsWith('//', at)) { const end = source.slice(at).search(/[\r\n]/); return end === -1 ? source.length : at + end; }
  let depth = 0;
  do {
    if (source.startsWith('/*', at)) { depth++; at += 2; } else if (source.startsWith('*/', at)) { depth--; at += 2; } else at++;
  } while (depth > 0 && at < source.length);
  return at;
};
const isComment = (source, at) => source.startsWith('//', at) || source.startsWith('/*', at);

/** Whether a source's first token, after spaces, line breaks and (nested block) comments, is `manifest`. */
export function opensWithManifest(source) {
  let at = 0;
  while (at < source.length) {
    if (' \t\r\n'.includes(source[at])) at++;
    else if (isComment(source, at)) at = commentEnd(source, at);
    else break;
  }
  return /^manifest(?![A-Za-z0-9_])/.test(source.slice(at));
}

/**
 * The capabilities a compiled source's inline manifest declares, sorted as the compiler keeps them
 * (`model.request`, `fs.read(workspace)`, …), or null if none are found. The manifest's text is read
 * without comments and with its strings emptied, up to its closing brace.
 */
export function manifestCapabilities(source) {
  let text = ''; let depth = 0; let at = 0;
  while (at < source.length) {
    if (isComment(source, at)) { at = commentEnd(source, at); text += ' '; continue; }
    const char = source[at];
    if (char === '"') {
      at++;
      while (at < source.length && source[at] !== '"') at += source[at] === '\\' ? 2 : 1;
      at++; text += '""'; continue;
    }
    text += char; at++;
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) break;
  }
  const list = /^\s*manifest\s*\{[\s\S]*?\bcapabilities\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  return list === undefined ? null : list.split(',').map(item => item.replace(/\s+/g, '')).filter(Boolean).sort();
}

/**
 * An entry contract's boundary descriptor as SHOUT describes types: `void`, `bool`, `int`, `float`,
 * `string`, `list`, `option`, `result`, `record` with `fields`, `map`, or `other` (bytes, tuples, enums).
 * A newtype is its wire type.
 */
export function describe(descriptor) {
  const variants = descriptor?.variants?.map(variant => variant.tag).join();
  const payload = variant => (variant?.fields?.value ? describe(variant.fields.value) : { type: 'void' });
  switch (descriptor?.type) {
    case 'null': return { type: 'void' };
    case 'boolean': return { type: 'bool' };
    case 'integer': return { type: 'int' };
    case 'float': return { type: 'float' };
    case 'string': return { type: 'string' };
    case 'array': return { type: 'list', items: describe(descriptor.items) };
    case 'object': return { type: 'record', fields: Object.fromEntries(Object.entries(descriptor.properties ?? {}).map(([name, field]) => [name, describe(field)])) };
    case 'map': return { type: 'map', key: describe(descriptor.key), value: describe(descriptor.value) };
    case 'newtype': return describe(descriptor.wire);
    case 'tagged_union':
      if (variants === 'None,Some') return { type: 'option', value: payload(descriptor.variants[1]) };
      if (variants === 'Ok,Err') return { type: 'result', ok: payload(descriptor.variants[0]), err: payload(descriptor.variants[1]) };
      return { type: 'other' };
    default: return { type: 'other' };
  }
}
