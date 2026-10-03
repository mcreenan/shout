import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { startServer } from '../src/server.mjs';
import { CodexProvider } from '../../../prototypes/owned/src/provider.mjs';
import { ClaudeProvider } from '../src/claude-provider.mjs';
import { CodexAgent } from '../src/agent.mjs';
import { ScriptedAgent, codeAgent, scenarioProvider } from './doubles.mjs';

async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for session state');
}
const providerFactory = data => scenarioProvider(data.scenario);
async function setup(t, { agent = codeAgent() } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-session-'));
  const store = await new SessionStore({ stateRoot: dir, agent, providerFactory }).init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, dir };
}

test('chat drives real ALLEN, waits for approval, changes actual files, tests and persists session', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ scenario: 'pricing' });
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
  assert.equal(session.data.status, 'idle', JSON.stringify(session.data.messages.at(-1)));
  assert.equal(session.data.runs.at(-1).skill, 'code');
  assert.equal(session.data.runs.at(-1).result.output.passed, true);
  assert.notEqual(await readFile(resolve(session.data.workspace, 'pricing.mjs'), 'utf8'), original);
  assert.throws(() => session.answer(id, { accept: true }), /no longer pending/);
  for (const type of ['chat.started', 'command.routed', 'program.loaded', 'model.started', 'user.question', 'workspace.changed', 'tool.completed', 'run.terminal']) assert.ok(session.data.events.some(e => e.type === type), type);
  const judgments = session.data.events.filter(e => e.type === 'model.started').map(e => e.effectId);
  assert.ok(judgments.length && judgments.every(Boolean));
  assert.deepEqual(session.data.events.filter(e => e.type === 'model.worker').map(e => e.effectId), judgments, 'worker events name their judgment');
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.equal(saved.status, 'idle'); assert.ok(saved.runs[0].source.includes('model.request'));
  const restored = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent() }).init();
  assert.equal(restored.get(session.data.id).data.messages.length, session.data.messages.length);
  await restored.close();
});

test('declining and cancelling leave workspace unchanged; other workspace sessions cannot race', async t => {
  const { store } = await setup(t);
  const session = await store.create({ scenario: 'slug' });
  const before = await session.workspace.read('slug.mjs');
  store.send(session.data.id, session.data.suggestedPrompt);
  await waitFor(() => session.data.question);
  const other = await store.create({ workspace: session.data.workspace });
  assert.throws(() => store.send(other.data.id, 'hello'), /Another session/);
  session.answer(session.data.question.id, { accept: false }); await session.task;
  assert.equal(session.data.status, 'idle'); assert.equal(session.data.runs.at(-1).result.output.accepted, false);
  assert.equal(await session.workspace.read('slug.mjs'), before);
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  const id = session.data.question.id; session.cancel(); await session.task;
  assert.equal(session.data.status, 'cancelled'); assert.equal(session.data.question, null);
  assert.equal(session.data.messages.at(-1).content, 'Cancelled.', 'nothing was written, so nothing is said to remain');
  assert.throws(() => session.answer(id, { accept: true }), /no longer pending/);
  assert.equal(await session.workspace.read('slug.mjs'), before);
});

test('one model thread per session: instructions once, then only the user text', async t => {
  const agent = new ScriptedAgent(async ({ text, say }) => say(`echo: ${text}`));
  const { store, dir } = await setup(t, { agent });
  const session = await store.create({ workspace: dir });
  store.send(session.data.id, 'first'); await session.task;
  store.send(session.data.id, 'second'); await session.task;
  assert.equal(agent.threads.length, 1);
  assert.match(agent.threads[0].instructions, /^You are SHOUT/);
  assert.match(agent.threads[0].context, new RegExp(`Workspace: ${dir}`));
  assert.ok(agent.threads[0].tools.some(tool => tool.name === 'run_program'));
  assert.deepEqual(agent.turns, [{ threadId: 'thread-1', text: 'first', model: 'gpt-6-astra', effort: 'medium' }, { threadId: 'thread-1', text: 'second', model: 'gpt-6-astra', effort: 'medium' }]);
  assert.deepEqual(session.data.messages.map(m => m.content), ['first', 'echo: first', 'second', 'echo: second']);
  assert.equal(session.data.status, 'idle');
  await session.persist();
  const restoredAgent = new ScriptedAgent();
  const restored = await new SessionStore({ stateRoot: dir, agent: restoredAgent }).init();
  t.after(() => restored.close());
  const copy = restored.get(session.data.id);
  restored.send(copy.data.id, 'third'); await copy.task;
  assert.equal(restoredAgent.threads.length, 0, 'the saved thread continues after a restart');
  assert.deepEqual(restoredAgent.turns, [{ threadId: 'thread-1', text: 'third', model: 'gpt-6-astra', effort: 'medium' }]);
});

test('the agent reads the workspace directly, and fixes a program from the compiler diagnostics', async t => {
  const program = (returns) => `// Echo the request.\nmanifest {\n  language: "0.1"\n  entry: main\n  capabilities: []\n  tools: { required: [] }\n}\n\nexport async fn main(args: String) ${returns} String {\n  \`You asked: \${args}\`\n}\n`;
  const results = {};
  const agent = new ScriptedAgent(async ({ text, call, say }) => {
    results.files = await call('list_files', {});
    results.read = await call('read_file', { path: 'notes.txt' });
    results.search = await call('search_files', { query: 'beta' });
    results.missing = await call('read_file', { path: 'nope.txt' }).catch(error => `failed: ${error.message}`);
    results.guide = await call('allen_guide', {});
    results.skills = await call('list_skills', {});
    results.draft = await call('run_program', { program: program('retruns'), args: text }).catch(error => `failed: ${error.message}`);
    results.run = await call('run_program', { program: program('returns'), args: text });
    say('Ran it.');
  });
  const { store, dir } = await setup(t, { agent });
  const workspace = resolve(dir, 'project');
  const session = await store.create({ workspace, createWorkspace: true });
  await writeFile(resolve(workspace, 'notes.txt'), 'alpha\nbeta\n');
  store.send(session.data.id, 'say hello');
  await session.task;
  assert.equal(results.files, 'notes.txt');
  assert.equal(results.read, 'alpha\nbeta\n');
  assert.equal(results.search, 'notes.txt:2: beta');
  assert.match(results.missing, /^failed: /);
  assert.match(results.guide, /## Tool catalog[\s\S]*### code\.allen/);
  assert.match(results.skills, /^- code /m);
  assert.match(results.draft, /^failed: The program does not compile[\s\S]*retruns/);
  assert.match(results.run, /completed[\s\S]*You asked: say hello/);
  const checks = session.data.events.filter(e => e.tool === 'allen.check' && e.type !== 'tool.started').map(e => e.type);
  assert.deepEqual(checks, ['tool.failed', 'tool.completed']);
  assert.equal(session.data.runs.length, 1); assert.equal(session.data.runs[0].generated, true);
  assert.deepEqual(session.data.messages.slice(-2).map(m => m.content), ['You asked: say hello', 'Ran it.']);
  assert.equal(session.data.status, 'idle');
});

test('a missing workspace folder is reported, then created on request', async t => {
  const { store, dir } = await setup(t);
  const target = resolve(dir, 'new', 'project');
  await assert.rejects(store.create({ workspace: target }), (error) => error.code === 'workspace_missing' && error.path === target);
  const session = await store.create({ workspace: target, createWorkspace: true });
  assert.equal(session.data.workspace, target);
  assert.ok((await stat(target)).isDirectory());
  await writeFile(resolve(dir, 'a-file'), 'x');
  await assert.rejects(store.create({ workspace: resolve(dir, 'a-file'), createWorkspace: true }), /must be a directory/);
});

test('restart asks the pending approval again', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ scenario: 'validation' });
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  const changes = session.data.question.prompt.data.value.changes;
  await store.suspend();
  assert.deepEqual([session.data.status, session.data.question, session.data.runs[0].state], ['suspended', null, 'suspended']);
  const restored = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent(), providerFactory }).init();
  t.after(() => restored.close());
  const copy = restored.get(session.data.id);
  assert.equal(copy.data.status, 'resuming');
  await waitFor(() => copy.data.question);
  assert.equal(copy.data.status, 'waiting_user');
  assert.deepEqual(copy.data.question.prompt.data.value.changes, changes, 'the same approval, asked again');
  assert.equal(copy.data.messages.at(-1).content, 'Resuming `/code` after a restart…');
  copy.answer(copy.data.question.id, { accept: true }); await copy.task;
  // The agent started this run, so its turn is over: the session is idle with the result in chat.
  assert.deepEqual([copy.data.status, copy.data.runs[0].state, copy.data.runs[0].result.output.passed], ['idle', 'completed', true]);
});

test('HTTP session routes, SSE snapshot, export and local-origin protections work together', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-http-'));
  const app = await startServer({ port: 0, stateRoot: dir, agent: codeAgent(), providerFactory, checkProvider: async () => ({ available: true, version: 'test' }) });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', 'X-Shout-Client': '1' };
  const config = await (await fetch(`${app.url}/api/config`)).json(); assert.equal(config.scenarios.length, 3);
  const denied = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: '{}' }); assert.equal(denied.status, 403);
  const noHeader = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(noHeader.status, 403);
  const created = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ scenario: 'pricing' }) }); assert.equal(created.status, 201);
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
  const session = await store.create({ scenario: 'pricing' });
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
  const session = await store.create({ scenario: 'pricing' });
  let release; let applied = false;
  const gate = new Promise(resolve => { release = resolve; });
  const apply = session.workspace.apply.bind(session.workspace);
  session.workspace.apply = async (...args) => { const value = await apply(...args); applied = true; await gate; return value; };
  t.after(() => release());
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  session.answer(session.data.question.id, { accept: true }); await waitFor(() => applied);
  session.cancel(); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'Cancelled. Changes already written remain in the workspace.');
  assert.throws(() => store.send(session.data.id, 'hello'), /still stopping/);
  const other = await store.create({ workspace: session.data.workspace });
  assert.throws(() => store.send(other.data.id, 'hello'), /Another session/);
  release(); await waitFor(() => session.pendingTools.size === 0);
  store.send(session.data.id, 'Review again'); await session.task;
  assert.equal(session.data.changes.length, 0);
  assert.ok(!session.data.events.some(e => e.type === 'workspace.changed'));
});

test('time budgets are persisted per session, cannot change during work, and can be disabled', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ scenario: 'pricing' });
  assert.equal(session.data.timeBudgetsEnabled, true);
  session.setTimeBudgets(false);
  assert.equal(session.data.timeBudgetsEnabled, false);
  store.send(session.data.id, session.data.suggestedPrompt);
  assert.throws(() => session.setTimeBudgets(true), { message: 'Session is busy' });
  session.cancel(); await session.task; await session.persist();
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.equal(saved.timeBudgetsEnabled, false);
});

test('sleeping persists, is refused during work, and a new message wakes the session', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ scenario: 'pricing' });
  assert.equal(session.data.sleeping, false);
  session.setSleeping(true);
  assert.equal(store.list().find(s => s.id === session.data.id).sleeping, true);
  await session.persist();
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.equal(saved.sleeping, true);
  assert.throws(() => session.setSleeping('yes'), /must be a boolean/);
  store.send(session.data.id, session.data.suggestedPrompt);
  assert.equal(session.data.sleeping, false);
  assert.throws(() => session.setSleeping(true), { message: 'Session is busy' });
  session.cancel(); await session.task;
});

test('the model and effort default to 6 Astra medium, persist, and reach the next turn', async t => {
  const agent = new ScriptedAgent();
  const { store, dir } = await setup(t, { agent });
  const session = await store.create();
  assert.deepEqual([session.data.model, session.data.effort], ['gpt-6-astra', 'medium']);
  assert.throws(() => session.setModel({ model: 'gpt-4', effort: 'low' }), /Unknown model/);
  assert.throws(() => session.setModel({ model: 'gpt-6-sol', effort: 'max' }), /Unknown effort/);
  session.setModel({ model: 'gpt-6-sol', effort: 'xhigh' });
  store.send(session.data.id, 'Hello'); await session.task;
  assert.deepEqual(agent.turns.map(({ model, effort }) => [model, effort]), [['gpt-6-sol', 'xhigh']]);
  await session.persist();
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.deepEqual([saved.model, saved.effort], ['gpt-6-sol', 'xhigh']);
});

test('background storage failure is surfaced without an unhandled task rejection', async t => {
  const { store, dir } = await setup(t, { agent: new ScriptedAgent() });
  const session = await store.create();
  await rename(resolve(dir, 'sessions'), resolve(dir, 'saved-sessions'));
  await writeFile(resolve(dir, 'sessions'), 'blocked');
  store.send(session.data.id, 'Hello');
  await assert.doesNotReject(session.task);
  assert.match(session.data.storageError, /could not be saved/);
  assert.equal(session.data.status, 'idle');
  await rm(resolve(dir, 'sessions')); await rename(resolve(dir, 'saved-sessions'), resolve(dir, 'sessions'));
});

test('the model locks with the first message; effort stays adjustable within the model\'s efforts', async t => {
  const agent = new ScriptedAgent();
  const { store, dir } = await setup(t, { agent });
  const session = await store.create();
  assert.deepEqual([session.data.modelLocked, session.snapshot().provider], [false, 'codex']);
  assert.throws(() => session.setModel({ model: 'gpt-6-sol', effort: 'max' }), /Unknown effort for 6 Sol: max/);
  session.setModel({ model: 'claude-opus-5-5', effort: 'max' });
  assert.deepEqual([session.snapshot().provider, session.snapshot().modelLocked], ['claude', false]);
  store.send(session.data.id, 'Hello'); await session.task;
  assert.equal(session.data.modelLocked, true);
  assert.throws(() => session.setModel({ model: 'gpt-6-sol', effort: 'high' }), /model is locked after the first message/);
  assert.throws(() => session.setModel({ model: 'claude-fable-5-1', effort: 'max' }), /locked/);
  session.setModel({ model: 'claude-opus-5-5', effort: 'low' });
  store.send(session.data.id, 'Again'); await session.task;
  assert.deepEqual(agent.turns.map(({ model, effort }) => [model, effort]), [['claude-opus-5-5', 'max'], ['claude-opus-5-5', 'low']]);
  const summary = store.list().find(item => item.id === session.data.id);
  assert.deepEqual([summary.model, summary.effort, summary.modelLocked, summary.provider], ['claude-opus-5-5', 'low', true, 'claude']);
  await session.persist();
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.deepEqual([saved.model, saved.effort, saved.modelLocked], ['claude-opus-5-5', 'low', true]);
});

test('each session gets the agent and judgment provider of its model\'s provider, and keeps its thread context', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-providers-'));
  const codex = new ScriptedAgent(async ({ say, usage }) => { say('from codex'); usage({ inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 }); });
  const claude = new ScriptedAgent(async ({ say, usage, turn }) => { say('from claude'); usage({ inputTokens: 12, cachedInputTokens: 10, outputTokens: 2 }); return turn === 1 ? { threadId: 'claude-session' } : {}; });
  const store = await new SessionStore({ stateRoot: dir, agents: { codex, claude } }).init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const first = await store.create({ workspace: dir });
  store.send(first.data.id, 'one'); await first.task; // Until then it is the folder's draft, which another create would return.
  const second = await store.create({ workspace: dir, model: 'claude-fable-5-1', effort: 'xhigh' });
  assert.ok(first.provider instanceof CodexProvider); assert.ok(second.provider instanceof ClaudeProvider);
  store.send(second.data.id, 'two'); await second.task;
  store.send(second.data.id, 'three'); await second.task;
  assert.deepEqual(codex.turns, [{ threadId: 'thread-1', text: 'one', model: 'gpt-6-astra', effort: 'medium' }]);
  assert.deepEqual(claude.turns.map(turn => [turn.threadId, turn.text, turn.model, turn.effort]), [['thread-1', 'two', 'claude-fable-5-1', 'xhigh'], ['claude-session', 'three', 'claude-fable-5-1', 'xhigh']]);
  assert.equal(second.data.threadId, 'claude-session', 'the ID the agent reports is kept');
  assert.match(codex.threads[0].instructions, /Codex's own built-in tools/);
  assert.doesNotMatch(claude.threads[0].instructions, /Codex/);
  const thread = { cwd: dir, instructions: claude.threads[0].instructions, context: claude.threads[0].context, tools: claude.threads[0].tools };
  assert.equal(second.data.threadContext, thread.context);
  assert.deepEqual(claude.threadOptions, [thread, thread], 'every turn gets the thread start options');
  const worker = session => session.data.events.filter(event => event.type === 'chat.worker').map(event => [event.provider, event.usage]);
  assert.deepEqual(worker(first), [['codex-app-server', { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 }]]);
  assert.deepEqual(worker(second)[0], ['claude-agent-sdk', { input_tokens: 12, cached_input_tokens: 10, output_tokens: 2 }]);
  await second.persist();
  const restartedAgent = new ScriptedAgent();
  const restarted = await new SessionStore({ stateRoot: dir, agents: { claude: restartedAgent } }).init();
  t.after(() => restarted.close());
  restarted.send(second.data.id, 'four'); await restarted.get(second.data.id).task;
  assert.equal(restartedAgent.threads.length, 0);
  assert.deepEqual(restartedAgent.threadOptions, [thread], 'the same system prompt after a restart');
});

test('sessions saved before the model lock are locked once they have messages', async t => {
  const { store, dir } = await setup(t, { agent: new ScriptedAgent() });
  const used = await store.create({ workspace: dir });
  store.send(used.data.id, 'Hello'); await used.task;
  const fresh = await store.create({ workspace: dir });
  for (const session of [used, fresh]) {
    await session.persist();
    const path = resolve(dir, 'sessions', `${session.data.id}.json`);
    const { modelLocked: _locked, ...saved } = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify(saved));
  }
  const restored = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent() }).init();
  t.after(() => restored.close());
  assert.equal(restored.get(used.data.id).data.modelLocked, true);
  assert.equal(restored.get(fresh.data.id).data.modelLocked, false);
  assert.throws(() => restored.get(used.data.id).setModel({ model: 'claude-opus-5-5', effort: 'medium' }), /locked/);
  assert.equal(restored.get(fresh.data.id).setModel({ model: 'claude-opus-5-5', effort: 'medium' }).provider, 'claude');
});

test('HTTP config reports each provider; sessions start on an available one and refuse unavailable ones', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-http-providers-'));
  const checkProvider = async () => ({ codex: { available: false, version: null, error: 'Codex is signed out.' }, claude: { available: true, version: '2.1.283', error: null } });
  const app = await startServer({ port: 0, stateRoot: dir, defaultWorkspace: dir, agent: new ScriptedAgent(), checkProvider });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const headers = { 'Content-Type': 'application/json', 'X-Shout-Client': '1' };
  const post = (path, body) => fetch(`${app.url}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const config = await (await fetch(`${app.url}/api/config`)).json();
  assert.deepEqual(config.provider, { available: true, version: '2.1.283', error: null });
  assert.deepEqual(config.providers.map(item => [item.id, item.label, item.available, item.error]), [['codex', 'Codex', false, 'Codex is signed out.'], ['claude', 'Claude', true, null]]);
  assert.deepEqual(config.defaultModel, { model: 'claude-fable-5-1', effort: 'medium' });
  assert.deepEqual(config.models.find(item => item.id === 'claude-opus-5-5'), { id: 'claude-opus-5-5', label: 'Opus 5.5', provider: 'claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.ok(config.efforts.includes('max'));
  const created = await (await post('/sessions', {})).json();
  assert.deepEqual([created.model, created.effort, created.provider, created.modelLocked], ['claude-fable-5-1', 'medium', 'claude', false]);
  const toCodex = await post(`/sessions/${created.id}/model`, { model: 'gpt-6-sol', effort: 'high' });
  assert.equal(toCodex.status, 400); assert.match((await toCodex.json()).error, /^Codex is unavailable\. Codex is signed out\.$/);
  assert.equal((await post('/sessions', { model: 'gpt-6-astra' })).status, 400);
  const codexSession = await app.store.create({ workspace: resolve(dir, 'codex'), createWorkspace: true, model: 'gpt-6-astra', effort: 'medium' });
  const refused = await post(`/sessions/${codexSession.data.id}/messages`, { text: 'Hello' });
  assert.equal(refused.status, 400); assert.match((await refused.json()).error, /Codex is unavailable/);
  assert.equal((await post(`/sessions/${created.id}/messages`, { text: 'Hello' })).status, 202);
  await waitFor(() => app.store.get(created.id).data.status === 'idle');
  const locked = await post(`/sessions/${created.id}/model`, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(locked.status, 400); assert.match((await locked.json()).error, /locked/);
  assert.equal((await (await post(`/sessions/${created.id}/model`, { model: 'claude-fable-5-1', effort: 'max' })).json()).effort, 'max');
});

// Lifecycle: tool calls that overlap, turns that end under them, and cancels that race the next message.
const isChild = thread => !thread.tools.some(tool => tool.name === 'spawn_agents');

test('an approval stays answerable while reads and sub-agents finish beside the program that asked', async t => {
  const seen = {}; let session;
  const agent = new ScriptedAgent(async ({ text, call, say, thread }) => {
    if (isChild(thread)) return say('child report');
    const program = call('run_skill', { name: 'code', args: text }).then(() => 'ok', error => error.message);
    await waitFor(() => session.data.question);
    seen.read = await call('read_file', { path: 'pricing.mjs' });
    seen.spawn = await call('spawn_agents', { purpose: 'beside', agents: [{ name: 'look', brief: 'Look.' }] });
    seen.status = session.data.status;
    seen.program = await program;
    say('done');
  });
  const { store } = await setup(t, { agent });
  session = await store.create({ scenario: 'pricing' });
  store.send(session.data.id, session.data.suggestedPrompt);
  await waitFor(() => seen.status);
  assert.equal(seen.status, 'waiting_user', 'finishing reads and sub-agents leave the question pending');
  assert.equal(session.data.status, 'waiting_user');
  session.answer(session.data.question.id, { accept: true });
  await session.task;
  assert.deepEqual([seen.program, session.data.status, session.data.runs.at(-1).state], ['ok', 'idle', 'completed']);
  assert.match(seen.spawn, /## look \(completed\)\nchild report/);
});

test('the model\'s programs run one at a time, and cancelling stops the running one and the ones waiting', async t => {
  const seen = {};
  const agent = new ScriptedAgent(async ({ text, call }) => {
    seen.results = await Promise.all([1, 2, 3].map(() => call('run_skill', { name: 'code', args: text }).then(() => 'ok', error => error.message)));
  });
  const { store } = await setup(t, { agent });
  const session = await store.create({ scenario: 'pricing' });
  store.send(session.data.id, session.data.suggestedPrompt);
  await waitFor(() => session.data.question);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(session.data.runs.length, 1, 'the other programs wait for the first');
  const first = session.data.runs[0].id;
  assert.equal(session.data.events.find(event => event.type === 'user.question').run, first, 'the question belongs to the running program');
  session.cancel(); await session.task;
  await waitFor(() => seen.results && session.pendingTools.size === 0, 3000);
  assert.deepEqual(session.data.runs.map(run => run.state), ['cancelled']);
  assert.deepEqual(seen.results, ['The task was cancelled', 'The task was cancelled', 'The task was cancelled']);
  store.send(session.data.id, 'again');
  await waitFor(() => session.data.question);
  assert.deepEqual(session.data.runs.map(run => run.state), ['cancelled', 'running'], 'the next task runs its own programs');
  assert.equal(session.data.events.findLast(event => event.type === 'user.question').run, session.data.runs[1].id);
  session.cancel(); await session.task;
});

test('a turn that ends under a running program stops the program and waits for it before the session settles', async t => {
  let session; const settled = [];
  const agent = new ScriptedAgent(async ({ text, call, say }) => {
    void call('run_skill', { name: 'code', args: text }).catch(() => {});
    await waitFor(() => session.data.question);
    if (text === 'fail') throw new Error('The app-server exited');
    say('I stopped waiting for the program.');
  });
  const { store } = await setup(t, { agent });
  session = await store.create({ scenario: 'pricing' });
  const before = await session.workspace.read('pricing.mjs');
  session.on('snapshot', snapshot => { if (!['thinking', 'running', 'waiting_user'].includes(snapshot.status)) settled.push(snapshot.runs.map(run => run.state)); });
  for (const [text, status] of [['fail', 'failed'], ['complete', 'idle']]) {
    store.send(session.data.id, text); await session.task;
    assert.equal(session.data.status, status, text);
    assert.equal(session.data.runs.at(-1).state, 'cancelled', `${text}: the program is stopped`);
    assert.deepEqual([session.data.question, session.pendingTools.size], [null, 0], text);
    const events = session.data.events.length;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(session.data.events.length, events, `${text}: nothing happens after the session settles`);
    assert.equal(session.data.status, status);
  }
  assert.ok(settled.every(states => states.every(state => state !== 'running' && state !== 'waiting_user' && state !== 'starting')), JSON.stringify(settled));
  assert.equal(await session.workspace.read('pricing.mjs'), before);
});

test('a thread started for a cancelled task never replaces the thread of the task after it', async t => {
  let release; const gate = new Promise(r => { release = r; });
  const agent = new ScriptedAgent(async ({ threadId, say }) => say(`on ${threadId}`));
  const startThread = agent.startThread.bind(agent);
  agent.startThread = async options => { const id = await startThread(options); if (id === 'thread-1') await gate; return id; };
  const { store, dir } = await setup(t, { agent });
  const session = await store.create({ workspace: dir });
  store.send(session.data.id, 'first'); const first = session.task;
  await waitFor(() => agent.threads.length === 1);
  session.cancel();
  store.send(session.data.id, 'second'); await session.task;
  assert.equal(session.data.threadId, 'thread-2');
  release(); await first;
  assert.equal(session.data.threadId, 'thread-2', 'the late thread is dropped');
  store.send(session.data.id, 'third'); await session.task;
  assert.deepEqual(agent.turns.map(turn => turn.threadId), ['thread-2', 'thread-2']);
});

test('CodexAgent queues a turn behind a cancelled one until Codex confirms the interrupt', async () => {
  const agent = new CodexAgent({ home: '/nonexistent' });
  const requests = []; let turns = 0; let confirm;
  agent.ensure = async () => {}; agent.loaded.add('t');
  const completed = status => agent.receive(JSON.stringify({ method: 'turn/completed', params: { threadId: 't', turn: { status } } }));
  agent.request = async (method, params) => {
    requests.push(method);
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } };
    if (method === 'turn/interrupt') confirm = () => completed('interrupted');
    return {};
  };
  const controller = new AbortController();
  const first = agent.turn('t', 'one', { onToolCall: async () => '', signal: controller.signal });
  await new Promise(r => setImmediate(r));
  controller.abort();
  const second = agent.turn('t', 'two', { onToolCall: async () => '' });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(requests, ['turn/start', 'turn/interrupt'], 'the next turn waits for the interrupt to be confirmed');
  confirm();
  assert.deepEqual(await first, { status: 'interrupted' });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(requests, ['turn/start', 'turn/interrupt', 'turn/start']);
  completed('completed');
  assert.deepEqual(await second, { status: 'completed' });
  const busy = agent.turn('t', 'three', { onToolCall: async () => '' });
  await new Promise(r => setImmediate(r));
  await assert.rejects(agent.turn('t', 'four', { onToolCall: async () => '' }), /already has a turn in progress/);
  completed('completed'); await busy;
});

test('a user question JOSH asks again carries its attempt and the issues with the last answer; a first ask carries no issues', async t => {
  const skill = `// Ask for a count.
manifest { language: "0.1" entry: main capabilities: [user.ask] }
record Count { count: Int }
export async fn main(args: String) returns String effects [user.ask] {
  match await user.ask<Count>(prompt { system: "How many?" output: Count policy: { max_attempts: 2 } }) {
    Ok(answer) => to_string(answer.count)
    Err(error) => error.code
  }
}
`;
  const { store, dir } = await setup(t, { agent: new ScriptedAgent() });
  const previousHome = process.env.SHOUT_HOME; process.env.SHOUT_HOME = resolve(dir, 'home');
  t.after(() => { if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome; });
  const workspace = resolve(dir, 'project');
  await mkdir(resolve(workspace, '.shout', 'skills'), { recursive: true });
  await writeFile(resolve(workspace, '.shout', 'skills', 'count.allen'), skill);
  const session = await store.create({ workspace });
  store.send(session.data.id, '/count');
  const first = await waitFor(() => session.data.question);
  assert.deepEqual([first.kind, typeof first.interaction, first.attempt, 'issues' in first], ['ask', 'string', 1, false]);
  // Within the JSON schema (an integer), outside JOSH's Int: JOSH rejects it and asks again.
  session.answer(first.id, { count: 1e20 });
  const again = await waitFor(() => session.data.question?.id !== first.id && session.data.question);
  assert.deepEqual([again.kind, again.interaction, again.attempt, again.issues], ['ask', first.interaction, 2, [{ path: '/count', code: 'range' }]]);
  assert.deepEqual(session.snapshot().question.issues, [{ path: '/count', code: 'range' }], 'snapshots carry them');
  assert.deepEqual(Object.keys(again).slice(0, 4), ['id', 'kind', 'prompt', 'schema'], 'the existing fields are unchanged');
  session.answer(again.id, { count: 3 }); await session.task;
  assert.deepEqual([session.data.messages.at(-1).content, session.data.status, session.data.question], ['3', 'completed', null]);
});

test('a question the runtime cancels is cleared at once, the session goes back to running, and a late answer is refused', async t => {
  // The kernel test's program: the second task's stop cancels the first task's pending question.
  const skill = `// Ask, then stop from a sibling task.
manifest { language: "0.1" entry: main capabilities: [user.ask, model.request] }
record Answer { answer: Bool }
async fn ask() returns Bool effects [user.ask] {
  match await user.ask<Bool>(prompt { system: "Continue?" output: Bool }) { Ok(v) => v Err(_) => false }
}
async fn quit() returns Bool effects [model.request] {
  let r = match await model.request<Answer>(prompt { system: "Judge" output: Answer }) { Ok(v) => v.answer Err(_) => false };
  stop("enough")
}
export async fn main() returns Bool effects [task.spawn, user.ask, model.request] {
  await {
    let a = spawn ask();
    let b = spawn quit();
    let x = await a;
    let z = await b;
    x
  }
}
`;
  let session; const seen = {};
  // The judgment waits for the question, so the stop always lands on a pending one.
  const provider = { judge: async () => { await waitFor(() => seen.asked); return { answer: true }; } };
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-session-'));
  const store = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent(), providerFactory: () => provider }).init();
  const previousHome = process.env.SHOUT_HOME; process.env.SHOUT_HOME = resolve(dir, 'home');
  t.after(async () => { await store.close(); if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome; await rm(dir, { recursive: true, force: true }); });
  const workspace = resolve(dir, 'project');
  await mkdir(resolve(workspace, '.shout', 'skills'), { recursive: true });
  await writeFile(resolve(workspace, '.shout', 'skills', 'ask-stop.allen'), skill);
  session = await store.create({ workspace });
  const record = session.event.bind(session);
  session.event = (type, detail) => {
    const event = record(type, detail);
    if (type === 'user.question') seen.asked = session.data.question;
    // The state as the session records the cancel, before the run's end settles everything else.
    if (type === 'effect.cancelled') {
      seen.cancelled = { id: detail.id, question: session.data.question, status: session.data.status, attention: store.list().find(item => item.id === session.data.id).attention };
      try { session.answer(seen.asked.id, true); seen.late = 'accepted'; } catch (error) { seen.late = error.message; }
    }
    return event;
  };
  store.send(session.data.id, '/ask-stop'); await session.task;
  assert.equal(seen.asked?.kind, 'ask');
  assert.equal(seen.cancelled?.id, seen.asked.id, 'the runtime cancelled the pending question');
  assert.deepEqual([seen.cancelled.question, seen.cancelled.status, seen.cancelled.attention], [null, 'running', null]);
  assert.equal(seen.late, 'This question is no longer pending');
  assert.deepEqual([session.data.runs.at(-1).state, session.data.question], ['stopped', null]);
  assert.ok(!session.data.events.some(event => event.type === 'user.answered'), 'no answer was recorded');
});

test('a skill header limits its run: the judgment budget fails with a hint to raise it, the question budget at the next question', async t => {
  const judge = `// Judge twice.
// limits: judgments=1 minutes=3
manifest { language: "0.1" entry: main capabilities: [model.request] }
record Answer { answer: Bool }
export async fn main(args: String) returns Bool effects [model.request] {
  let a = match await model.request<Answer>(prompt { system: "First" output: Answer }) { Ok(v) => v.answer Err(_) => false };
  let b = match await model.request<Answer>(prompt { system: "Second" output: Answer }) { Ok(v) => v.answer Err(_) => false };
  a && b
}
`;
  const ask = `// Ask twice.
// limits: questions=1
manifest { language: "0.1" entry: main capabilities: [user.ask] }
export async fn main(args: String) returns Bool effects [user.ask] {
  let a = match await user.ask<Bool>(prompt { system: "First?" output: Bool }) { Ok(v) => v Err(_) => false };
  let b = match await user.ask<Bool>(prompt { system: "Second?" output: Bool }) { Ok(v) => v Err(_) => false };
  a && b
}
`;
  const provider = { judge: async () => ({ answer: true }) };
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-session-'));
  const store = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent(), providerFactory: () => provider }).init();
  const previousHome = process.env.SHOUT_HOME; process.env.SHOUT_HOME = resolve(dir, 'home');
  t.after(async () => { await store.close(); if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome; await rm(dir, { recursive: true, force: true }); });
  const workspace = resolve(dir, 'project');
  await mkdir(resolve(workspace, '.shout', 'skills'), { recursive: true });
  await writeFile(resolve(workspace, '.shout', 'skills', 'judge.allen'), judge);
  await writeFile(resolve(workspace, '.shout', 'skills', 'ask.allen'), ask);
  const session = await store.create({ workspace });
  store.send(session.data.id, '/judge'); await session.task;
  const judged = session.data.runs.at(-1);
  assert.deepEqual([judged.state, judged.limits, judged.counters.modelJudgments], ['failed', { judgments: 1, tools: 128, questions: 8, minutes: 3 }, 1]);
  assert.equal(session.data.messages.at(-1).content, '`/judge` failed at line 7: Model judgment budget exhausted (1 per run). Raise it with `// limits: judgments=N` in the skill header (at most 32).');
  store.send(session.data.id, '/ask');
  const first = await waitFor(() => session.data.question);
  session.answer(first.id, true); await session.task;
  const asked = session.data.runs.at(-1);
  assert.deepEqual([asked.state, asked.limits.questions, asked.failedAt?.line], ['failed', 1, 6]);
  assert.match(session.data.messages.at(-1).content, /^`\/ask` failed at line 6: User question budget exhausted \(1 per run\). Raise it with `\/\/ limits: questions=N`/);
});
