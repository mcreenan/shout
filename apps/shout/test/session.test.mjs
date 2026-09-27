import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { startServer } from '../src/server.mjs';
import { CodexProvider } from '../../../prototypes/owned/src/provider.mjs';
import { ClaudeProvider } from '../src/claude-provider.mjs';
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

test('restart invalidates waiting questions instead of pretending the VM resumed', async t => {
  const { store, dir } = await setup(t);
  const session = await store.create({ scenario: 'validation' });
  store.send(session.data.id, session.data.suggestedPrompt); await waitFor(() => session.data.question);
  await session.persist();
  const restored = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent() }).init();
  const copy = restored.get(session.data.id);
  assert.equal(copy.data.status, 'interrupted'); assert.equal(copy.data.question, null);
  assert.equal(copy.data.runs[0].state, 'interrupted');
  await restored.close();
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
  assert.throws(() => session.setTimeBudgets(true), /finish the active task/);
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
  assert.throws(() => session.setSleeping(true), /finish the active task/);
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
