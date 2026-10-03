// A run's replay journal: every response SHOUT sends to JOSH, recorded before the frame goes out, so a run
// can resume after a restart. On resume SHOUT starts the same source and input on a fresh JOSH connection
// with the same execution id, answers each request from the record (released in recorded order), then
// continues live. See docs/JOSH-ALLEN-INTEGRATION.md, "Restarts".
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync, truncateSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { ResumeError } from '../../../prototypes/owned/src/kernel.mjs';

export const JOURNAL_VERSION = 1;
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
// How long JOSH may stay silent, with the next recorded response's request not yet issued, before the
// replay is called diverged.
export const QUIET_MS = 3000;
export const MAX_RESUMES = 3;
export const SHELL_UNKNOWN = 'The command started before SHOUT restarted; its outcome is unknown and it was not run again.';

export const sha256 = text => createHash('sha256').update(text).digest('hex');
/** JSON with object keys sorted at every level, so equal values always give equal text. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

// Request fields that are numbered in issue order or depend on the clock, so they differ between the
// original execution and its replay. Origins are diagnostic and go into the key instead.
const VOLATILE = new Set(['execution_id', 'operation_id', 'interaction_id', 'deadline_ms', 'origin']);
/** sha256 of the request's canonical params, without its volatile fields. */
export const requestDigest = params => sha256(canonical(Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => !VOLATILE.has(key)))));

// The parts of an origin scope entry that name a place in the program. Task numbers and loop instances are
// left out: they count across tasks, so they depend on how concurrent tasks interleave. A task is named by
// its spawn chain instead (each spawn entry's function and instruction, under its enclosing scope).
const PLACE = ['kind', 'construct', 'function', 'instruction', 'region', 'branch', 'arm', 'iteration'];
const place = entry => Object.fromEntries(PLACE.filter(key => entry?.[key] !== undefined).map(key => [key, entry[key]]));
/**
 * The key of a request without its occurrence number: the method, the tool, the source place it came
 * from (site and scope path) and the typed-response attempt. A truncated scope keeps its task and loop
 * instances, since the innermost entries alone may not tell two tasks apart.
 */
export function effectKey(method, params = {}) {
  const origin = params.origin && typeof params.origin === 'object' ? params.origin : null;
  const site = origin?.site ? { id: origin.site.id, function: origin.site.function, instruction: origin.site.instruction } : null;
  const scope = Array.isArray(origin?.scope) ? origin.scope.map(entry => (origin.truncated ? { ...place(entry), instance: entry.instance, task: entry.task } : place(entry))) : [];
  return sha256(canonical({ method, tool: params.tool ?? null, attempt: Number.isInteger(params.attempt) ? params.attempt : 1, site, scope, ...(origin?.truncated ? { task: origin.task } : {}) })).slice(0, 32);
}
/** What a request is and where, for messages: `{ method, tool?, line? }`. */
export const describeRequest = (method, params = {}) => ({ method, ...(params.tool ? { tool: params.tool } : {}), ...(Number.isInteger(params.origin?.site?.line) ? { line: params.origin.site.line } : {}) });
const what = at => (at?.tool ? `the tool ${at.tool}` : at?.method === 'model/request' ? 'a model judgment' : at?.method === 'user/ask' ? 'an answer from the user' : at?.method ?? 'an unknown request');
const where = at => (Number.isInteger(at?.line) ? ` at line ${at.line}` : '');

/** Gives each request its key (with an occurrence number) and digest, the same way in every execution. */
export class Keyer {
  constructor() { this.seen = new Map(); }
  describe(method, params) {
    const base = effectKey(method, params);
    const occurrence = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, occurrence);
    return { key: `${base}#${occurrence}`, digest: requestDigest(params), at: describeRequest(method, params) };
  }
}

/**
 * Reads a journal: `{ header, entries, bytes, torn }`. `bytes` is the length of its complete lines; a
 * last line cut off by a crash is dropped (`torn`). Returns null for a missing or empty file, and a
 * result without `header` when the first line isn't one.
 */
export function readJournal(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  if (!text) return null;
  const lines = text.split('\n');
  // The text after the last newline is either empty or a torn line.
  const tail = lines.pop();
  let bytes = Buffer.byteLength(text) - Buffer.byteLength(tail);
  const records = [];
  let torn = tail !== '';
  for (let index = 0; index < lines.length; index++) {
    try { records.push(JSON.parse(lines[index])); }
    catch {
      // Only a last line can be torn; anything else is damage.
      if (index !== lines.length - 1) return { header: null, entries: [], bytes: 0, torn: true };
      bytes -= Buffer.byteLength(lines[index]) + 1; torn = true;
    }
  }
  const [first, ...entries] = records;
  return { header: first?.type === 'header' && first.v === JOURNAL_VERSION ? first : null, entries, bytes, torn };
}

/**
 * Appends a run's journal through one file descriptor, synchronously, before each frame is sent to JOSH.
 * Intents are fsynced. A journal that would pass `maxBytes`, or can't be written, stops; `resumable`
 * then turns false and `onStop` is called once.
 *
 * `header` (a new journal) is written by `begin()`, once the program is loaded and its artifact digest is
 * known. `existing` (a resumed journal, from readJournal) is appended to after its last complete line, and
 * `begin()` checks the loaded program and catalog against its header instead.
 */
export class JournalWriter {
  constructor(path, { header = null, existing = null, maxBytes = MAX_JOURNAL_BYTES, elapsedMs = 0, onStop = () => {} } = {}) {
    this.path = path; this.header = existing?.header ?? header; this.resuming = Boolean(existing);
    this.maxBytes = maxBytes; this.onStop = onStop; this.keyer = new Keyer();
    this.started = Date.now(); this.elapsedMs = elapsedMs; this.resumable = true; this.fd = null;
    this.n = existing ? existing.entries.reduce((max, entry) => (Number.isInteger(entry.n) && entry.n > max ? entry.n : max), 0) : 0;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existing) {
      // A torn last line is cut off, and new entries follow the last complete one.
      truncateSync(path, existing.bytes);
      this.fd = openSync(path, 'a', 0o600);
      this.bytes = existing.bytes;
    } else {
      this.fd = openSync(path, 'w', 0o600);
      this.bytes = 0;
    }
  }
  /** Milliseconds of the run so far, across restarts. */
  get t() { return this.elapsedMs + (Date.now() - this.started); }
  describe(method, params) { return this.keyer.describe(method, params); }
  /** Binds the journal to the loaded program: writes a new header, or checks a resumed one. */
  begin({ artifactDigest, catalogDigest }) {
    if (this.resuming) {
      if (this.header.artifactDigest !== artifactDigest) throw new ResumeError('Could not resume after the restart: the program compiles differently now (the JOSH build changed since the run started).');
      if (catalogDigest && this.header.catalogDigest && this.header.catalogDigest !== catalogDigest) throw new ResumeError('Could not resume after the restart: SHOUT\'s tool catalog changed since the run started.');
      return;
    }
    this.header = { ...this.header, artifactDigest, catalogDigest: catalogDigest ?? null };
    this.write({ v: JOURNAL_VERSION, type: 'header', ...this.header });
  }
  append(entry) {
    const numbered = entry.type === 'response' || entry.type === 'error' ? { n: ++this.n, t: this.t } : { t: this.t };
    return this.write({ type: entry.type, ...numbered, ...entry });
  }
  /** Appends an intent and fsyncs it: true once it is on disk. */
  intent(entry) {
    if (!this.append({ type: 'intent', ...entry })) return false;
    try { fsyncSync(this.fd); return true; } catch (error) { this.stop(error); return false; }
  }
  write(record) {
    if (!this.resumable || this.fd === null) return false;
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.maxBytes) { this.stop(new Error(`The journal reached ${this.maxBytes} bytes`)); return false; }
    try { writeSync(this.fd, line); this.bytes += size; return true; } catch (error) { this.stop(error); return false; }
  }
  stop(error) {
    if (!this.resumable) return;
    this.resumable = false; this.close();
    this.onStop(error);
  }
  close() { if (this.fd !== null) { try { closeSync(this.fd); } catch {} this.fd = null; } }
  /** Closes and deletes the journal (its run ended), and its run directory if that is then empty. */
  discard() {
    this.close();
    rmSync(this.path, { force: true });
    try { rmdirSync(dirname(this.path)); } catch {}
  }
}

/** The sha256 of a workspace file's content, null when it doesn't exist, or 'unreadable'. */
export async function fileState(workspace, path) {
  try { return sha256(await workspace.read(path)); }
  catch (error) { return error.code === 'ENOENT' ? null : 'unreadable'; }
}
/** A write intent's changes: each path with the sha256 of its content now and of its approved content. */
export async function writeIntent(workspace, changes) {
  return Promise.all(changes.map(async change => ({ path: change.path, before: await fileState(workspace, change.path), after: sha256(change.after) })));
}

/**
 * The response for an intent that has none: the restart came after approval, while the write or command
 * ran. Returns a tool result (`{ outcome, value }` or `{ outcome: 'error', error }`), or null to run the
 * request live again. Nothing is ever applied again automatically.
 * - Every path has its approved content: the write happened. It is answered as accepted.
 * - Every path has its earlier content: nothing was written. It runs live; the approval is asked again.
 * - Anything else: a declared tool error naming which files were written and which weren't.
 * - A shell command: a declared error, since its outcome can't be known.
 */
export async function reconcileIntent(intent, workspace) {
  if (intent.tool === 'shell.run') return { outcome: 'error', error: { message: SHELL_UNKNOWN } };
  const changes = Array.isArray(intent.changes) ? intent.changes : [];
  const now = await Promise.all(changes.map(change => fileState(workspace, change.path)));
  const written = changes.filter((change, index) => now[index] === change.after);
  const unwritten = changes.filter((change, index) => now[index] !== change.after && now[index] === change.before);
  if (changes.length && written.length === changes.length) {
    return { outcome: 'ok', value: { accepted: true, changed: written.map(change => change.path), ...(intent.tool === 'workspace.edit' ? { problem: '' } : {}) } };
  }
  if (unwritten.length === changes.length) return null;
  const other = changes.filter(change => !written.includes(change) && !unwritten.includes(change));
  const list = items => items.map(change => change.path).join(', ') || 'none';
  return { outcome: 'error', error: { message: `SHOUT restarted while applying this change, and it was not applied again. Written: ${list(written)}. Not written: ${list(unwritten)}.${other.length ? ` Changed by something else since: ${list(other)}.` : ''} Read the files again before proposing another change.` } };
}

/**
 * Answers a resumed execution's requests from its journal.
 *
 * Requests are matched by key and digest, not by arrival order. Recorded responses are released in their
 * recorded order: a request whose entry is not next is held until it is. A request with no entry was
 * pending at the restart; it is held until the replay ends, then answered live (or, if it has a write or
 * shell intent, reconciled first). The replay diverges, and the run must stop, when a request has a
 * recorded key with a different digest, when the execution ends before the record does, or when the next
 * recorded response's request hasn't come and JOSH has been silent for `quietMs`.
 *
 * `start({ release })` takes the function that answers an effect from its entry; it is called synchronously,
 * in recorded order. `offer(effect)` then resolves to `{ replayed: true }` (answered), `{ synthesized: result }`
 * (an intent's reconciled result), or null (run it live); it rejects with a ResumeError on divergence.
 */
export class ReplayCursor {
  constructor({ entries, reconcile = async () => null, quietMs = QUIET_MS }) {
    this.reconcile = reconcile; this.quietMs = quietMs;
    // Responses and errors are released in order. A request JOSH cancelled has no response: replayed, it
    // is held like an unknown one until JOSH cancels it again. The latest intent of a key without a
    // response is reconciled when its request comes.
    this.order = []; this.byKey = new Map(); this.intents = new Map();
    for (const entry of entries) {
      if (entry.type === 'response' || entry.type === 'error') { this.order.push(entry); this.byKey.set(entry.key, entry); }
      else if (entry.type === 'intent') this.intents.set(entry.key, entry);
    }
    for (const key of this.byKey.keys()) this.intents.delete(key);
    this.index = 0; this.held = new Map(); this.replayed = 0; this.finished = false; this.lastActivity = Date.now();
    this.onDone = () => {}; this.onDiverge = () => {}; this.release = () => {};
  }
  /** Starts the replay clock once the execution starts. Calls `release(effect, entry)` for each entry, then `onDone(replayed)`, or `onDiverge(error)`. */
  start({ onDone, onDiverge, release }) {
    this.onDone = onDone; this.onDiverge = onDiverge; this.release = release; this.activity();
    this.pump();
    if (!this.finished) { this.watch = setInterval(() => this.check(), Math.min(250, this.quietMs)); this.watch.unref?.(); }
  }
  /** JOSH sent a frame. */
  activity() { this.lastActivity = Date.now(); }
  offer(effect) {
    if (this.finished) return Promise.resolve(this.intents.has(effect.key) ? this.settle(effect) : null);
    const entry = this.byKey.get(effect.key);
    if (entry && entry.digest !== effect.digest) {
      return Promise.reject(new ResumeError(`Could not resume after the restart: ${where(effect.at).trim()}${where(effect.at) ? ' ' : ''}the program asked for ${what(effect.at)} with different input than the recording has.`));
    }
    return new Promise((resolveOffer, rejectOffer) => {
      this.held.set(effect.id, { effect, entry: entry && !entry.used ? entry : null, resolve: resolveOffer, reject: rejectOffer });
      if (entry) this.pump();
    });
  }
  /** JOSH cancelled a request that is held here. */
  withdraw(effect) { this.held.delete(effect.id); }
  pump() {
    while (!this.finished && this.index < this.order.length) {
      const entry = this.order[this.index];
      const waiting = [...this.held.values()].find(hold => hold.entry === entry);
      if (!waiting) return;
      this.held.delete(waiting.effect.id); entry.used = true;
      this.index++; this.replayed++;
      try { this.release(waiting.effect, entry); }
      catch (error) { waiting.reject(error); continue; }
      waiting.resolve({ replayed: true });
    }
    if (!this.finished && this.index >= this.order.length) this.finish();
  }
  finish() {
    this.finished = true; clearInterval(this.watch);
    const held = [...this.held.values()]; this.held.clear();
    this.onDone(this.replayed);
    for (const hold of held) this.settle(hold.effect).then(hold.resolve, hold.reject);
  }
  async settle(effect) {
    const intent = this.intents.get(effect.key);
    if (!intent || intent.digest !== effect.digest) return null;
    this.intents.delete(effect.key);
    const result = await this.reconcile(intent);
    return result ? { synthesized: result } : null;
  }
  check() {
    if (this.finished || Date.now() - this.lastActivity < this.quietMs) return;
    const next = this.order[this.index];
    const waiting = [...this.held.values()].map(hold => `${what(hold.effect.at)}${where(hold.effect.at)}`);
    this.diverge(new ResumeError(`Could not resume after the restart: the recording has ${what(next.at)}${where(next.at)} next, but the program ${waiting.length ? `is waiting for ${waiting.join(' and ')}` : 'asked for nothing'}.`));
  }
  diverge(error) {
    if (this.finished) return;
    this.finished = true; clearInterval(this.watch);
    for (const hold of this.held.values()) hold.reject(error);
    this.held.clear();
    this.onDiverge(error);
  }
  /** The execution ended (or was stopped); a replay still running then diverged. */
  stop() { clearInterval(this.watch); if (!this.finished) { this.finished = true; this.held.clear(); } }
}
