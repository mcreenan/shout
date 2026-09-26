import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { startServer } from '../src/server.mjs';

async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for session state');
}
async function setup(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-session-'));
  const store = await new SessionStore({ stateRoot: dir }).init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('chat drives real ALLEN, waits for approval, changes actual files, tests and persists session', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ mode: 'fixture', scenario: 'pricing' });
  const original = await readFile(resolve(session.data.workspace, 'pricing.mjs'), 'utf8');
  store.send(session.data.id, session.data.suggestedPrompt);
  await waitFor(() => session.data.question || session.data.status === 'failed');
  assert.equal(session.data.status, 'waiting_user', JSON.stringify(session.data.events.at(-1)));
  assert.equal(await readFile(resolve(session.data.workspace, 'pricing.mjs'), 'utf8'), original);
  assert.throws(() => session.answer('wrong', { accept: true }), /no longer pending/);
  assert.throws(() => session.answer(session.data.question.id, { accept: 'yes' }), /Schema/);
  const id = session.data.question.id;
  session.answer(id, { accept: true });
  await session.task;
  assert.equal(session.data.status, 'completed', JSON.stringify(session.data.runs));
  assert.equal(session.data.runs.at(-1).result.output.passed, true);
  assert.notEqual(await readFile(resolve(session.data.workspace, 'pricing.mjs'), 'utf8'), original);
  assert.throws(() => session.answer(id, { accept: true }), /no longer pending/);
  for (const type of ['chat.started', 'program.loaded', 'model.started', 'user.question', 'workspace.changed', 'tool.completed', 'run.terminal']) assert.ok(session.data.events.some(e => e.type === type), type);
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.equal(saved.status, 'completed'); assert.ok(saved.runs[0].source.includes('model.request'));
  const restored = await new SessionStore({ stateRoot: dir }).init();
  assert.equal(restored.get(session.data.id).data.messages.length, session.data.messages.length);
  await restored.close();
});

test('declining and cancelling leave workspace unchanged; other workspace sessions cannot race', async t => {
  const { store } = await setup(t);
  const session = await store.create({ mode: 'fixture', scenario: 'slug' });
  const before = await session.workspace.read('slug.mjs');
  store.send(session.data.id, session.data.suggestedPrompt);
  await waitFor(() => session.data.question);
  const other = await store.create({ mode: 'fixture', workspace: session.data.workspace });
  assert.throws(() => store.send(other.data.id, 'hello'), /Another session/);
  session.answer(session.data.question.id, { accept: false }); await session.task;
  assert.equal(session.data.status, 'completed'); assert.equal(session.data.runs.at(-1).result.output.accepted, false);
  assert.equal(await session.workspace.read('slug.mjs'), before);
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  const id = session.data.question.id; session.cancel(); await session.task;
  assert.equal(session.data.status, 'cancelled'); assert.equal(session.data.question, null);
  assert.throws(() => session.answer(id, { accept: true }), /no longer pending/);
  assert.equal(await session.workspace.read('slug.mjs'), before);
});

test('restart invalidates waiting questions instead of pretending the VM resumed', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ mode: 'fixture', scenario: 'validation' });
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  await session.persist();
  const restored = await new SessionStore({ stateRoot: dir }).init();
  const copy = restored.get(session.data.id);
  assert.equal(copy.data.status, 'interrupted'); assert.equal(copy.data.question, null);
  assert.equal(copy.data.runs[0].state, 'interrupted');
  await restored.close();
});

test('HTTP session routes, SSE snapshot, export and local-origin protections work together', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-http-'));
  const app = await startServer({ port: 0, stateRoot: dir, checkProvider: async () => ({ available: true, version: 'test' }) });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', 'X-Shout-Client': '1' };
  const config = await (await fetch(`${app.url}/api/config`)).json(); assert.equal(config.scenarios.length, 3);
  const denied = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' }); assert.equal(denied.status, 403);
  const noHeader = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(noHeader.status, 403);
  const created = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ scenario: 'pricing', mode: 'fixture' }) }); assert.equal(created.status, 201);
  const session = await created.json();
  const streamAbort = new AbortController();
  const stream = await fetch(`${app.url}/api/sessions/${session.id}/events`, { signal: streamAbort.signal });
  const part = await stream.body.getReader().read(); assert.match(new TextDecoder().decode(part.value), /event: snapshot/); streamAbort.abort();
  const result = await fetch(`${app.url}/api/sessions/${session.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: session.suggestedPrompt }) }); assert.equal(result.status, 202);
  await waitFor(() => app.store.get(session.id).data.question);
  const exported = await (await fetch(`${app.url}/api/sessions/${session.id}/export`)).json(); assert.equal(exported.status, 'waiting_user'); assert.ok(exported.changes.length);
  const traversal = await fetch(`${app.url}/api/sessions/${session.id}/file?path=../../etc/passwd`); assert.equal(traversal.status, 400);
});

test('test-only command bypasses model judgment and reports actual failing tests without edits', async t => {
  const { store } = await setup(t);
  const session = await store.create({ mode: 'fixture', scenario: 'pricing' });
  const before = await session.workspace.read('pricing.mjs');
  store.send(session.data.id, '/test'); await session.task;
  assert.equal(session.data.status, 'completed');
  assert.equal(session.data.runs.at(-1).result.output.passed, false);
  assert.match(session.data.runs.at(-1).result.output.test_output, /fail/i);
  assert.equal(session.data.runs.at(-1).counters.modelJudgments, 0);
  assert.ok(!session.data.events.some(e => e.type === 'chat.started'));
  assert.equal(await session.workspace.read('pricing.mjs'), before);
});

test('cancelled late tool completion cannot change a newer task and retains workspace lock while draining', async t => {
  const { store } = await setup(t);
  const session = await store.create({ mode: 'fixture', scenario: 'pricing' });
  let release; let applied = false;
  const gate = new Promise(resolve => { release = resolve; });
  const apply = session.workspace.apply.bind(session.workspace);
  session.workspace.apply = async (...args) => { const value = await apply(...args); applied = true; await gate; return value; };
  t.after(() => release());
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  session.answer(session.data.question.id, { accept: true }); await waitFor(() => applied);
  session.cancel(); await session.task;
  assert.throws(() => store.send(session.data.id, 'hello'), /still stopping/);
  const other = await store.create({ mode: 'fixture', workspace: session.data.workspace });
  assert.throws(() => store.send(other.data.id, 'hello'), /Another session/);
  release(); await waitFor(() => session.pendingTools.size === 0);
  store.send(session.data.id, 'Review again'); await session.task;
  assert.equal(session.data.changes.length, 0);
  assert.ok(!session.data.events.some(e => e.type === 'workspace.changed'));
});

test('background storage failure is surfaced without an unhandled task rejection', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ mode: 'fixture' });
  await rename(resolve(dir, 'sessions'), resolve(dir, 'saved-sessions'));
  await writeFile(resolve(dir, 'sessions'), 'blocked');
  store.send(session.data.id, 'Hello');
  await assert.doesNotReject(session.task);
  assert.match(session.data.storageError, /could not be saved/);
  assert.equal(session.data.status, 'idle');
  await rm(resolve(dir, 'sessions')); await rename(resolve(dir, 'saved-sessions'), resolve(dir, 'sessions'));
});
