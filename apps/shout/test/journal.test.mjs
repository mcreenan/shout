// The replay journal: keys and digests, the writer, reading a torn journal, ordered release and divergence, and
// reconciling writes and commands that a restart cut off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { canonical, requestDigest, effectKey, Keyer, JournalWriter, readJournal, ReplayCursor, reconcileIntent, writeIntent, sha256, SHELL_UNKNOWN } from '../src/journal.mjs';
import { ResumeError } from '../../../prototypes/owned/src/kernel.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const spawnEntry = (task, instruction) => ({ kind: 'spawn', task, function: 'src/main.allen::work', instruction, source: 'src/main.allen', start: 1, end: 2, line: 3, column: 1 });
const loop = (instance, iteration) => ({ kind: 'for', construct: 2, instance, iteration, region: 'body', source: 'src/main.allen', start: 5, end: 9, line: 6, column: 3 });
const origin = (task, scope, site = 1) => ({ task, parent_task: task ? 0 : undefined, site: { id: site, function: 'src/main.allen::work', instruction: 23, source: 'src/main.allen', line: 7, column: 5 }, scope });
const request = (params = {}) => ({ execution_id: 'run-a', operation_id: 'op-1', interaction_id: 'interaction-1', deadline_ms: 1000, attempt: 1, prompt: { system: 'Judge' }, ...params });

test('canonical JSON sorts keys at every level', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}');
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
});

test('the digest leaves out ids, deadlines and the origin; the content counts', () => {
  const base = requestDigest(request());
  assert.equal(requestDigest(request({ execution_id: 'run-b', operation_id: 'op-9', interaction_id: 'interaction-9', deadline_ms: 5, origin: origin(3, []) })), base);
  assert.notEqual(requestDigest(request({ prompt: { system: 'Judge!' } })), base);
  assert.notEqual(requestDigest(request({ attempt: 2 })), base);
});

test('keys name a place in the program, not task numbers or loop instances, which depend on interleaving', () => {
  const a = effectKey('model/request', request({ origin: origin(1, [spawnEntry(1, 3), loop(1, 2)]) }));
  assert.equal(effectKey('model/request', request({ origin: origin(2, [spawnEntry(2, 3), loop(4, 2)]) })), a, 'task 2 and instance 4 for the same place');
  assert.notEqual(effectKey('model/request', request({ origin: origin(1, [spawnEntry(1, 6), loop(1, 2)]) })), a, 'another spawn site is another task');
  assert.notEqual(effectKey('model/request', request({ origin: origin(1, [spawnEntry(1, 3), loop(1, 3)]) })), a, 'another iteration');
  assert.notEqual(effectKey('model/request', request({ attempt: 2, origin: origin(1, [spawnEntry(1, 3), loop(1, 2)]) })), a, 'another attempt');
  assert.notEqual(effectKey('tool/invoke', { tool: 'workspace.read', origin: origin(1, [spawnEntry(1, 3), loop(1, 2)]) }), a);
  // A truncated scope can't tell tasks apart by place, so it keeps their numbers.
  const truncated = task => effectKey('model/request', request({ origin: { ...origin(task, [loop(task, 1)]), truncated: true } }));
  assert.notEqual(truncated(1), truncated(2));
});

test('repeated requests at one place get occurrence numbers in order', () => {
  const keyer = new Keyer();
  const params = request({ origin: origin(0, []) });
  const first = keyer.describe('model/request', params); const second = keyer.describe('model/request', params);
  assert.match(first.key, /#1$/); assert.match(second.key, /#2$/);
  assert.equal(first.key.split('#')[0], second.key.split('#')[0]);
  assert.deepEqual(first.at, { method: 'model/request', line: 7 });
});

test('the writer writes the header when the program loads, numbers responses and fsyncs intents', async t => {
  const dir = await tempDir(t);
  const path = resolve(dir, 'run-a', 'journal.jsonl');
  const journal = new JournalWriter(path, { header: { run: 'run-a', sourceSha256: 'x' } });
  journal.begin({ artifactDigest: 'sha256:a', catalogDigest: 'sha256:c' });
  assert.equal(journal.append({ type: 'response', key: 'k#1', digest: 'd', result: { value: 1 } }), true);
  assert.equal(journal.intent({ key: 'k2#1', digest: 'd2', tool: 'workspace.write', changes: [] }), true);
  journal.append({ type: 'error', key: 'k3#1', digest: 'd3', error: { code: 'model.denied', message: 'no' } });
  journal.close();
  const read = readJournal(path);
  assert.deepEqual([read.header.run, read.header.artifactDigest, read.header.catalogDigest, read.header.v], ['run-a', 'sha256:a', 'sha256:c', 1]);
  assert.deepEqual(read.entries.map(entry => [entry.type, entry.n]), [['response', 1], ['intent', undefined], ['error', 2]]);
  assert.ok(read.entries.every(entry => Number.isInteger(entry.t)));
  assert.equal(read.torn, false);
});

test('a torn last line is dropped, and a resumed writer appends after the last complete line', async t => {
  const dir = await tempDir(t);
  const path = resolve(dir, 'journal.jsonl');
  const journal = new JournalWriter(path, { header: { run: 'run-a' } });
  journal.begin({ artifactDigest: 'sha256:a' });
  journal.append({ type: 'response', key: 'k#1', digest: 'd', result: { value: 1 } });
  journal.close();
  await appendFile(path, '{"type":"response","n":2,"key":"k#2"');
  const read = readJournal(path);
  assert.equal(read.torn, true); assert.equal(read.entries.length, 1);
  const resumed = new JournalWriter(path, { existing: read, elapsedMs: 5000 });
  assert.throws(() => resumed.begin({ artifactDigest: 'sha256:b' }), ResumeError);
  resumed.begin({ artifactDigest: 'sha256:a', catalogDigest: 'sha256:c' });
  resumed.append({ type: 'response', key: 'k#2', digest: 'd', result: { value: 2 } });
  resumed.close();
  const again = readJournal(path);
  assert.equal(again.torn, false);
  assert.deepEqual(again.entries.map(entry => entry.n), [1, 2]);
  assert.ok(again.entries[1].t >= 5000, 'time continues across the restart');
  assert.equal(readJournal(resolve(dir, 'missing.jsonl')), null);
  // Damage before the last line makes the journal unusable.
  await appendFile(path, 'not json\n{"type":"response"}\n');
  assert.equal(readJournal(path).header, null);
});

test('a journal that would pass its size cap stops, and the run is no longer resumable', async t => {
  const dir = await tempDir(t);
  const stopped = [];
  const journal = new JournalWriter(resolve(dir, 'journal.jsonl'), { header: { run: 'run-a' }, maxBytes: 300, onStop: error => stopped.push(error.message) });
  journal.begin({ artifactDigest: 'sha256:a' });
  assert.equal(journal.append({ type: 'response', key: 'k#1', digest: 'd', result: { value: 'x'.repeat(400) } }), false);
  assert.equal(journal.resumable, false);
  assert.deepEqual(stopped, ['The journal reached 300 bytes']);
  assert.equal(journal.append({ type: 'response', key: 'k#2', digest: 'd', result: {} }), false);
  assert.equal(stopped.length, 1);
});

const effect = (id, key, digest = 'd', at = { method: 'model/request', line: 4 }) => ({ id, key, digest, at });
const entry = (key, n, extra = {}) => ({ type: 'response', key, digest: 'd', n, result: { value: n }, at: { method: 'model/request', line: n }, ...extra });

test('recorded responses are released in recorded order, whatever order their requests come in', async () => {
  const cursor = new ReplayCursor({ entries: [entry('a#1', 1), entry('b#1', 2), entry('c#1', 3)] });
  const sent = [];
  const done = new Promise(resolveDone => cursor.start({ onDone: resolveDone, onDiverge: assert.fail, release: (item, recorded) => sent.push([item.id, recorded.n]) }));
  const c = cursor.offer(effect('e3', 'c#1'));
  const b = cursor.offer(effect('e2', 'b#1'));
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.deepEqual(sent, [], 'held until the first entry is matched');
  const a = cursor.offer(effect('e1', 'a#1'));
  assert.deepEqual(sent, [['e1', 1], ['e2', 2], ['e3', 3]], 'the first match releases the ones held behind it, in recorded order, at once');
  assert.deepEqual(await Promise.all([a, b, c]), Array(3).fill({ replayed: true }));
  assert.equal(await done, 3);
  assert.equal(await cursor.offer(effect('e4', 'z#1')), null, 'after the replay everything is live');
});

test('a request with no entry was pending at the restart: it is held until the replay ends, then runs live', async () => {
  const cursor = new ReplayCursor({ entries: [entry('a#1', 1)] });
  cursor.start({ onDone: () => {}, onDiverge: assert.fail, release: () => {} });
  let pending = 'held';
  const unknown = cursor.offer(effect('e9', 'q#1')).then(value => { pending = value; });
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.equal(pending, 'held');
  await cursor.offer(effect('e1', 'a#1'));
  await unknown;
  assert.equal(pending, null);
});

test('a different digest for a recorded key diverges at once', async () => {
  const cursor = new ReplayCursor({ entries: [entry('a#1', 1)] });
  cursor.start({ onDone: assert.fail, onDiverge: () => {} });
  await assert.rejects(cursor.offer(effect('e1', 'a#1', 'other', { method: 'tool/invoke', tool: 'workspace.write', line: 12 })),
    error => error instanceof ResumeError && error.message === 'Could not resume after the restart: at line 12 the program asked for the tool workspace.write with different input than the recording has.');
});

test('the replay diverges when the next recorded request never comes and JOSH stays quiet', async () => {
  const cursor = new ReplayCursor({ entries: [entry('a#1', 1, { at: { method: 'tool/invoke', tool: 'tests.run', line: 9 } })], quietMs: 60 });
  const diverged = new Promise(resolveDiverge => cursor.start({ onDone: assert.fail, onDiverge: resolveDiverge }));
  const held = cursor.offer(effect('e2', 'x#1', 'd', { method: 'user/ask', line: 3 }));
  const error = await diverged;
  assert.equal(error.message, 'Could not resume after the restart: the recording has the tool tests.run at line 9 next, but the program is waiting for an answer from the user at line 3.');
  await assert.rejects(held, ResumeError);
});

test('an intent without a response is reconciled when its request comes, after the replay', async () => {
  const reconciled = [];
  const cursor = new ReplayCursor({
    entries: [entry('a#1', 1), { type: 'intent', key: 'w#1', digest: 'd', tool: 'workspace.write', changes: [] }, { type: 'intent', key: 'done#1', digest: 'd', tool: 'workspace.write' }, entry('done#1', 2)],
    reconcile: async intent => { reconciled.push(intent.key); return { outcome: 'ok', value: { accepted: true, changed: [] } }; },
  });
  cursor.start({ onDone: () => {}, onDiverge: assert.fail, release: () => {} });
  await cursor.offer(effect('e1', 'a#1'));
  await cursor.offer(effect('e2', 'done#1'));
  assert.deepEqual(await cursor.offer(effect('e3', 'w#1')), { synthesized: { outcome: 'ok', value: { accepted: true, changed: [] } } });
  assert.deepEqual(reconciled, ['w#1'], 'an intent with a response is just replayed');
  assert.equal(await cursor.offer(effect('e4', 'w#1')), null, 'reconciled once');
});

test('reconciling a write: all written, none written, part written, and a shell command', async () => {
  const files = new Map([['a.txt', 'A2'], ['b.txt', 'B']]);
  const workspace = { read: async path => { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path); } };
  const changes = await writeIntent(workspace, [{ path: 'a.txt', after: 'A3' }, { path: 'c.txt', after: 'C' }]);
  assert.deepEqual(changes, [{ path: 'a.txt', before: sha256('A2'), after: sha256('A3') }, { path: 'c.txt', before: null, after: sha256('C') }]);
  const intent = { tool: 'workspace.edit', changes: [{ path: 'a.txt', before: sha256('A'), after: sha256('A2') }, { path: 'b.txt', before: sha256('B'), after: sha256('B2') }] };
  files.set('b.txt', 'B2');
  assert.deepEqual(await reconcileIntent(intent, workspace), { outcome: 'ok', value: { accepted: true, changed: ['a.txt', 'b.txt'], problem: '' } });
  files.set('a.txt', 'A'); files.set('b.txt', 'B');
  assert.equal(await reconcileIntent(intent, workspace), null);
  files.set('a.txt', 'A2'); files.set('b.txt', 'B?');
  const mixed = await reconcileIntent({ ...intent, tool: 'workspace.write' }, workspace);
  assert.equal(mixed.outcome, 'error');
  assert.match(mixed.error.message, /Written: a\.txt\. Not written: none\. Changed by something else since: b\.txt\./);
  assert.deepEqual(await reconcileIntent({ tool: 'shell.run', command: 'make' }, workspace), { outcome: 'error', error: { message: SHELL_UNKNOWN } });
  // A new file that was never created is unwritten.
  assert.equal(await reconcileIntent({ tool: 'workspace.write', changes: [{ path: 'new.txt', before: null, after: sha256('N') }] }, workspace), null);
});

test('discarding a journal deletes its file', async t => {
  const dir = await tempDir(t);
  const path = resolve(dir, 'journal.jsonl');
  const journal = new JournalWriter(path, { header: { run: 'run-a' } });
  journal.begin({ artifactDigest: 'sha256:a' });
  journal.append({ type: 'cancelled', key: 'k#1', digest: 'd' });
  journal.discard();
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});
