import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCENARIO_ROOT = fileURLToPath(new URL('../scenarios/', import.meta.url));
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 512 * 1024;
const MAX_CHANGES = 32;
// Opening a FIFO for reading would block a file-system worker until a writer appears; nonblocking opens
// return at once and the descriptor is then checked to be a regular file.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
// A byte order mark stays part of the text, so what is read, compared and written back agree.
const decode = buffer => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
const BLOCKED = /^(?:\..*|node_modules|vendor|target|dist|build|coverage|secrets?|credentials?)(?:$)/i;
const SECRET_FILE = /(?:^|[._-])(?:env|secrets?|credentials?|private[_-]?key)(?:[._-]|$)|\.(?:pem|key|p12|pfx)$/i;
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|md|txt|css|html|svg|py|rs|go|java|rb|sh|ya?ml|toml|allen|sql)$/i;

export const scenarios = [
  {
    id: 'pricing', title: 'Fix a checkout calculation',
    description: 'A discount is applied after tax. Inspect the failing test, fix the calculation, and verify the checkout total.',
    prompt: 'Fix the checkout total in pricing.mjs. Apply the percentage discount to the subtotal before calculating tax. Keep money rounded to cents. Read the existing tests and preserve the exported API. Run the tests after the approved edit.',
  },
  {
    id: 'slug', title: 'Implement a missing slug utility',
    description: 'Turn the supplied slug stub into a working utility with Unicode normalization and supplied contract tests.',
    prompt: 'Implement slugify in slug.mjs to satisfy the supplied tests: trim and lowercase; strip combining accents after Unicode NFD normalization; replace each run of non-ASCII alphanumeric characters with one hyphen; remove leading and trailing hyphens. Return an empty string for punctuation-only input. Preserve the exported API and run the tests.',
  },
  {
    id: 'validation', title: 'Unify inconsistent validation',
    description: 'Two entry points disagree on valid account names. Introduce shared validation and prove both paths behave consistently.',
    prompt: 'Refactor validators.mjs so signup and profile updates share one account-name validator. Names must be trimmed, have 3–20 ASCII letters, digits, or underscores, and start with a letter. The current profile path accepts invalid names. Preserve validateSignup and validateProfile exports, avoid duplicated rules, and run the supplied tests.',
  },
];

export async function createScenario(id, baseDir) {
  const scenario = scenarios.find(item => item.id === id);
  if (!scenario) throw new Error(`Unknown scenario: ${id}`);
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  const workspace = await fs.mkdtemp(path.join(path.resolve(baseDir), `${id}-`));
  await fs.cp(path.join(SCENARIO_ROOT, id), workspace, { recursive: true, errorOnExist: true });
  return { workspace, prompt: scenario.prompt, testCommand: 'node --test *.test.mjs' };
}

/** Workspace confinement protects against accidental escapes, not hostile concurrent OS actors. */
export class Workspace {
  constructor(workspace, { testCommand = '', testTimeoutMs = 30_000, maxOutputBytes = 128 * 1024 } = {}) {
    this.path = path.resolve(workspace);
    this.testCommand = testCommand;
    this.testTimeoutMs = testTimeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.applyQueue = Promise.resolve();
  }

  async init() {
    this.path = await fs.realpath(this.path);
    if (!(await fs.stat(this.path)).isDirectory()) throw new Error('Workspace must be a directory');
    return this;
  }

  async resolveFile(relative, { allowMissing = false } = {}) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Invalid relative workspace path');
    const parts = relative.split('/');
    // `.shout/` holds workspace skills; other hidden and generated paths stay protected.
    if (parts.some((part, index) => !part || part === '.' || part === '..' || (BLOCKED.test(part) && !(index === 0 && part === '.shout' && parts.length > 1)) || SECRET_FILE.test(part))) throw new Error(`Protected or invalid path: ${relative}`);
    let current = this.path;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      let stat;
      try { stat = await fs.lstat(current); }
      catch (error) { if (error.code === 'ENOENT' && allowMissing) return current + (index + 1 < parts.length ? path.sep + parts.slice(index + 1).join(path.sep) : ''); throw error; }
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${relative}`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Parent is not a directory: ${relative}`);
    }
    return current;
  }

  /** Strict listing for whole-workspace snapshots. `limit` returns a truncated listing instead of failing. */
  async list({ limit } = {}) {
    const files = [];
    let visited = 0;
    let truncated = false;
    const walk = async (directory, prefix = '') => {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (truncated) return;
        if (++visited > (limit ? 20000 : 5000)) {
          if (limit) { truncated = true; return; }
          throw new Error('Workspace traversal exceeds 5000 entries; select a smaller workspace');
        }
        if (BLOCKED.test(entry.name) || SECRET_FILE.test(entry.name) || entry.isSymbolicLink()) continue;
        const relative = prefix + entry.name;
        if (entry.isDirectory()) {
          await this.resolveFile(relative);
          await walk(path.join(directory, entry.name), `${relative}/`);
        } else if (entry.isFile() && (TEXT_FILE.test(entry.name) || /^(?:Dockerfile|Makefile|LICENSE)$/.test(entry.name))) {
          if (limit && files.length >= limit) { truncated = true; return; }
          files.push(relative);
          if (!limit && files.length > MAX_FILES) throw new Error(`Workspace exceeds ${MAX_FILES} text files; select a smaller workspace`);
        }
      }
    };
    await walk(this.path);
    return limit ? { files, truncated } : files;
  }

  /** Literal, case-sensitive line search over eligible text files. */
  async search(query, { maxResults = 100 } = {}) {
    if (typeof query !== 'string' || !query) throw new Error('Search query must be a non-empty string');
    const matches = [];
    const { files, truncated: listTruncated } = await this.list({ limit: 5000 });
    for (const file of files) {
      let content;
      try { content = await this.read(file); } catch { continue; }
      if (!content.includes(query)) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        if (matches.length >= maxResults) return { matches, truncated: true };
        matches.push({ path: file, line: index + 1, text: lines[index].slice(0, 400) });
      }
    }
    return { matches, truncated: listTruncated };
  }

  /**
   * Turns exact snippet edits into full before/after changes without writing.
   * Each `find` must occur exactly once in the file's current (or already edited)
   * content; an empty `find` creates a new file. Stale-edit checks still apply
   * when the resulting changes are applied.
   */
  async planEdits(edits) {
    if (!Array.isArray(edits) || !edits.length) throw new Error('Provide at least one edit');
    const files = new Map();
    for (const edit of edits) {
      if (!edit || typeof edit.path !== 'string' || typeof edit.find !== 'string' || typeof edit.replace !== 'string') throw new Error('Each edit requires path, find, and replace strings');
      if (!files.has(edit.path)) {
        let before = null;
        try { before = await this.read(edit.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        files.set(edit.path, { before, after: before });
      }
      const file = files.get(edit.path);
      if (edit.find === '') {
        if (file.after !== null) throw new Error(`An empty find creates a new file, but ${edit.path} already exists`);
        file.after = edit.replace;
        continue;
      }
      if (file.after === null) throw new Error(`File not found: ${edit.path}`);
      const first = file.after.indexOf(edit.find);
      if (first < 0) throw new Error(`Edit text not found in ${edit.path}: ${JSON.stringify(edit.find.slice(0, 120))}`);
      if (file.after.indexOf(edit.find, first + 1) >= 0) throw new Error(`Edit text occurs more than once in ${edit.path}; include more surrounding context: ${JSON.stringify(edit.find.slice(0, 120))}`);
      file.after = file.after.slice(0, first) + edit.replace + file.after.slice(first + edit.find.length);
    }
    return [...files].map(([path, { before, after }]) => ({ path, before: before ?? '', after })).filter(change => change.before !== change.after);
  }

  async read(relative) {
    const filename = await this.resolveFile(relative);
    if (!(await fs.lstat(filename)).isFile()) throw new Error(`Not a bounded text file: ${relative}`);
    const handle = await fs.open(filename, READ_FLAGS);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Not a bounded text file: ${relative}`);
      if (stat.nlink > 1) throw new Error(`Hardlinked files are not allowed: ${relative}`);
      const buffer = await handle.readFile();
      if (buffer.length > MAX_FILE_BYTES || buffer.includes(0)) throw new Error(`Not a bounded text file: ${relative}`);
      return decode(buffer);
    } finally { await handle.close(); }
  }

  async inspect() {
    const files = [];
    let bytes = 0;
    for (const filename of await this.list()) {
      const content = await this.read(filename);
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_CONTEXT_BYTES) throw new Error('Workspace content exceeds 512 KiB; select a smaller workspace');
      files.push({ path: filename, content });
    }
    return { files, summary: `${files.length} text files (${bytes} bytes) in ${this.path}` };
  }

  async apply(changes, { signal } = {}) {
    const operation = this.applyQueue.then(() => this.applyNow(changes, signal));
    this.applyQueue = operation.catch(() => {});
    return operation;
  }

  async applyNow(changes, signal) {
    const plans = await this.preflight(changes, { signal });
    const changed = [];
    try {
      for (const plan of plans) {
        signal?.throwIfAborted();
        await this.resolveFile(plan.path, { allowMissing: true });
        signal?.throwIfAborted();
        await fs.mkdir(path.dirname(plan.filename), { recursive: true });
        await this.resolveFile(plan.path, { allowMissing: true });
        signal?.throwIfAborted();
        const handle = await fs.open(plan.filename, plan.exists ? constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        // Creating a new file is already a mutation, even if cancellation prevents its contents.
        if (!plan.exists) changed.push(plan.path);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Not a bounded text file: ${plan.path}`);
          if (stat.nlink > 1) throw new Error(`Hardlinked files are not allowed: ${plan.path}`);
          if (plan.exists && decode(await handle.readFile()) !== plan.before) throw new Error(`Stale patch: ${plan.path} changed during apply`);
          // Writes are per-file. Later failures can leave earlier approved files changed.
          signal?.throwIfAborted();
          if (plan.exists) changed.push(plan.path);
          await handle.truncate(0);
          const buffer = Buffer.from(plan.after);
          let offset = 0;
          while (offset < buffer.length) {
            signal?.throwIfAborted();
            const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
            if (!bytesWritten) throw new Error(`Unable to finish writing ${plan.path}`);
            offset += bytesWritten;
          }
        } finally { await handle.close(); }
      }
      return { changed };
    } catch (error) {
      // AbortSignal commonly throws a DOMException with a read-only message.
      const failure = new Error(`${error.message}${changed.length ? `; files possibly changed: ${changed.join(', ')}` : ''}`, { cause: error });
      failure.name = error.name;
      failure.changed = changed;
      throw failure;
    }
  }

  /**
   * Checks a change set without writing anything: 1–32 distinct allowed paths, bounded text, and each
   * `before` equal to the file's current content. Run before asking for approval, and again by apply.
   */
  async preflight(changes, { signal } = {}) {
    signal?.throwIfAborted();
    if (!Array.isArray(changes) || changes.length === 0) throw new Error(`Patch must contain 1–${MAX_CHANGES} changes`);
    if (changes.length > MAX_CHANGES) throw new Error(`One change can touch at most ${MAX_CHANGES} files; this one touches ${changes.length}. Split it into smaller changes.`);
    const seen = new Set();
    let bytes = 0;
    const plans = [];
    for (const change of changes) {
      if (!change || typeof change.before !== 'string' || typeof change.after !== 'string') throw new Error('Each change requires path, before, and after strings');
      const filename = await this.resolveFile(change.path, { allowMissing: true });
      if (seen.has(filename)) throw new Error(`Duplicate patch path: ${change.path}`);
      seen.add(filename);
      if (Buffer.byteLength(change.after) > MAX_FILE_BYTES || change.after.includes('\0')) throw new Error(`Patch is not bounded text: ${change.path}`);
      bytes += Buffer.byteLength(change.after);
      if (bytes > MAX_CONTEXT_BYTES) throw new Error('Patch exceeds 512 KiB');
      let exists = true;
      let before;
      try { before = await this.read(change.path); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; before = ''; }
      if (before !== change.before) throw new Error(`Stale patch: ${change.path} no longer matches the proposed before content`);
      plans.push({ ...change, filename, exists });
    }
    return plans;
  }

  async test({ signal } = {}) {
    signal?.throwIfAborted();
    if (!this.testCommand.trim()) return { passed: false, output: 'No test command configured; verification skipped.', exitCode: -1, skipped: true };
    const result = await this.run(this.testCommand, { signal, label: 'test command' });
    return { ...result, passed: result.exitCode === 0 && !result.stopped };
  }

  /** Runs one shell command in the workspace with a timeout, output cap and process-group cancellation. */
  async run(command, { signal, timeoutMs = this.testTimeoutMs, label = 'command' } = {}) {
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      // A Node test runner marks its children as test workers. User test commands
      // are independent runs, including when this module itself is under test.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
      const child = spawn('/bin/bash', ['-c', command], { cwd: this.path, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let bytes = 0;
      let stopped = '';
      let killTimer;
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const stop = reason => {
        if (stopped) return;
        stopped = reason;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killTimer = setTimeout(kill, 250);
      };
      const abort = () => stop('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => stop('timeout'), timeoutMs);
      const append = data => {
        const remaining = this.maxOutputBytes - bytes;
        if (remaining > 0) output += data.subarray(0, remaining).toString('utf8');
        bytes += data.length;
        if (bytes > this.maxOutputBytes) stop('output limit exceeded');
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); if (stopped) kill(); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => {
        cleanup();
        if (stopped) output += `\n[SHOUT: ${label} ${stopped}]\n`;
        resolve({ output, exitCode: code ?? -1, ...(stopped ? { stopped } : {}) });
      });
    });
  }
}
