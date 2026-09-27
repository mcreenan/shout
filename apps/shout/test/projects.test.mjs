import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat, symlink, realpath } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { ProjectStore, listDirectories } from '../src/projects.mjs';
import { startServer } from '../src/server.mjs';
import { createScenario } from '../src/workspace.mjs';
import { ScriptedAgent, codeAgent, scenarioProvider } from './doubles.mjs';

async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for state');
}
async function tempDir(t, prefix = 'shout-projects-') {
  const dir = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
// Replies at once, except that a message starting with "wait" holds its turn until `release()`.
function gatedAgent() {
  const gates = [];
  const agent = new ScriptedAgent(async ({ text, say }) => { if (text.startsWith('wait')) await new Promise(resolve => gates.push(resolve)); say(`echo: ${text}`); });
  return { agent, release: () => { for (const resolve of gates.splice(0)) resolve(); } };
}
async function openStore(t, dir, options = {}) {
  const store = await new SessionStore({ stateRoot: dir, agent: new ScriptedAgent(), ...options }).init();
  t.after(() => store.close());
  return store;
}
async function quietly(fn) {
  const errors = []; const original = console.error; console.error = (...args) => errors.push(args.join(' '));
  try { return { value: await fn(), errors }; } finally { console.error = original; }
}
const sessionFile = (dir, id) => resolve(dir, 'sessions', `${id}.json`);
const exists = path => stat(path).then(() => true, () => false);

test('projects are added once per folder, validated, updated, removed and kept across restarts', async t => {
  const dir = await tempDir(t);
  const work = resolve(dir, 'work'); await mkdir(work);
  const store = await openStore(t, dir);
  const added = await store.addProject({ path: `${work}/` });
  assert.equal(added.existing, false);
  assert.deepEqual(Object.keys(added.project).sort(), ['createdAt', 'defaultModel', 'id', 'name', 'path', 'sample', 'testCommand', 'updatedAt']);
  assert.match(added.project.id, /^project-[a-f0-9-]{36}$/);
  assert.deepEqual([added.project.name, added.project.path, added.project.testCommand, added.project.defaultModel, added.project.sample], ['work', work, '', null, null]);
  await symlink(work, resolve(dir, 'alias'));
  const again = await store.addProject({ path: resolve(dir, 'alias'), name: 'Other' });
  assert.equal(again.existing, true); assert.equal(again.project.id, added.project.id, 'a folder has one project, whatever path names it');
  await assert.rejects(store.addProject({ path: 'relative/folder' }), /absolute/);
  await assert.rejects(store.addProject({ path: work, name: 'x'.repeat(81) }), /1–80/);
  await assert.rejects(store.addProject({ path: resolve(dir, 'fresh'), testCommand: 'x'.repeat(2001) }), /2,000/);
  await assert.rejects(store.addProject({ path: resolve(dir, 'missing') }), error => error.code === 'workspace_missing' && error.path === resolve(dir, 'missing'));
  const made = await store.addProject({ path: resolve(dir, 'missing', 'deep'), createWorkspace: true, name: '  Deep one ', testCommand: ' npm test ' });
  assert.ok((await stat(resolve(dir, 'missing', 'deep'))).isDirectory());
  assert.deepEqual([made.project.name, made.project.testCommand], ['Deep one', 'npm test']);
  await writeFile(resolve(dir, 'a-file'), 'x');
  await assert.rejects(store.addProject({ path: resolve(dir, 'a-file'), createWorkspace: true }), /must be a directory/);

  const updated = await store.updateProject(added.project.id, { name: 'Work', testCommand: 'node --test', defaultModel: { model: 'claude-opus-5-5', effort: 'max' } });
  assert.deepEqual([updated.name, updated.testCommand, updated.defaultModel], ['Work', 'node --test', { model: 'claude-opus-5-5', effort: 'max' }]);
  await assert.rejects(store.updateProject(added.project.id, { path: '/etc' }), /path cannot be changed/);
  await assert.rejects(store.updateProject(added.project.id, { defaultModel: { model: 'gpt-6-sol', effort: 'max' } }), /Unknown model or effort/);
  await assert.rejects(store.updateProject(added.project.id, { name: '' }), /1–80/);
  await assert.rejects(store.updateProject('project-00000000-0000-0000-0000-000000000000', { name: 'x' }), /Project not found/);
  assert.deepEqual(store.projectList().map(project => [project.name, project.threadCount, project.activeCount, project.unavailable]), [['Work', 0, 0, false], ['Deep one', 0, 0, false]]);

  const removed = await store.removeProject(made.project.id);
  assert.deepEqual(removed, { id: made.project.id, removed: true, threads: 0, deletedFolder: false });
  assert.ok(await exists(resolve(dir, 'missing', 'deep')), 'removing a project never deletes its folder');
  const restarted = await openStore(t, dir);
  assert.deepEqual(restarted.projectList().map(({ threadCount: _count, activeCount: _active, unavailable: _missing, ...project }) => project), [updated]);
});

test('project writes are atomic, serialized and private', async t => {
  const dir = await tempDir(t);
  const projects = await new ProjectStore({ stateRoot: dir }).init();
  const { project } = await projects.add({ path: dir });
  const file = resolve(dir, 'projects.json');
  let done = false; let reads = 0;
  const reader = (async () => { while (!done) { JSON.parse(await readFile(file, 'utf8')); reads++; await new Promise(r => setImmediate(r)); } })();
  await Promise.all(Array.from({ length: 40 }, (_, index) => projects.update(project.id, { testCommand: `test ${index}` })));
  done = true; await reader;
  assert.ok(reads > 0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].testCommand, 'test 39', 'the last write wins');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter(name => name.startsWith('projects')), ['projects.json']);
  const reloaded = await new ProjectStore({ stateRoot: dir }).init();
  assert.deepEqual(reloaded.list(), projects.list());
});

test('an unreadable project list is set aside and rebuilt from the threads', async t => {
  const dir = await tempDir(t);
  const work = resolve(dir, 'work'); await mkdir(work);
  const first = await openStore(t, dir);
  const session = await first.create({ workspace: work, testCommand: 'npm test' });
  await first.close();
  await writeFile(resolve(dir, 'projects.json'), '{"projects": [');
  const { value: store, errors } = await quietly(() => openStore(t, dir));
  assert.equal(errors.length, 1); assert.match(errors[0], /moved it to/);
  assert.ok((await readdir(dir)).some(name => name.startsWith('projects.json.unreadable-')));
  const [project] = store.projectList();
  assert.deepEqual([project.path, project.testCommand, project.threadCount], [work, 'npm test', 1]);
  assert.equal(store.get(session.data.id).data.projectId, project.id);
});

test('threads saved before projects join a project for their folder; missing folders stay as read-only history', async t => {
  const dir = await tempDir(t);
  const work = resolve(dir, 'work'); await mkdir(work); await writeFile(resolve(work, 'app.mjs'), 'export {};\n');
  const { workspace: scratch } = await createScenario('pricing', resolve(dir, 'workspaces'));
  const gone = resolve(dir, 'gone');
  await mkdir(resolve(dir, 'sessions'));
  const legacy = async (updatedAt, fields) => {
    const data = { id: `session-${randomUUID()}`, title: 'Earlier work', scenario: null, suggestedPrompt: '', testCommand: '', timeBudgetsEnabled: true, sleeping: false, model: 'gpt-6-astra', effort: 'medium', status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt, sequence: 0, messages: [{ id: randomUUID(), role: 'user', content: 'hello', time: updatedAt }], events: [], runs: [], question: null, changes: [], ...fields };
    await writeFile(sessionFile(dir, data.id), JSON.stringify(data)); return data.id;
  };
  const older = await legacy('2026-01-02T00:00:00.000Z', { workspace: work, testCommand: 'npm test' });
  const newer = await legacy('2026-01-03T00:00:00.000Z', { workspace: work, testCommand: 'make test' });
  const newest = await legacy('2026-01-04T00:00:00.000Z', { workspace: work, testCommand: '' });
  const sample = await legacy('2026-01-05T00:00:00.000Z', { workspace: scratch, scenario: 'pricing', testCommand: 'node --test *.test.mjs' });
  const missing = await legacy('2026-01-06T00:00:00.000Z', { workspace: gone, title: 'Lost folder' });
  const { value: app, errors } = await quietly(() => startServer({ port: 0, allowedHosts: new Set(['127.0.0.1']), stateRoot: dir, agent: new ScriptedAgent(), checkProvider: async () => ({ available: true, version: 'test' }) }));
  t.after(() => app.close());
  assert.deepEqual(errors, [], 'restoring a thread whose folder is gone is not an error');
  const projects = await (await fetch(`${app.url}/api/projects`)).json();
  const byPath = Object.fromEntries(projects.map(project => [project.path, project]));
  assert.equal(projects.length, 3);
  assert.deepEqual([byPath[work].name, byPath[work].testCommand, byPath[work].sample, byPath[work].threadCount, byPath[work].unavailable], ['work', 'make test', null, 3, false], 'the latest non-empty test command wins');
  assert.deepEqual([byPath[scratch].name, byPath[scratch].testCommand, byPath[scratch].sample], ['Fix a checkout calculation', 'node --test *.test.mjs', 'pricing']);
  assert.deepEqual([byPath[gone].name, byPath[gone].threadCount, byPath[gone].unavailable], ['gone', 1, true]);
  for (const id of [older, newer, newest]) {
    const session = app.store.get(id);
    assert.equal(session.data.projectId, byPath[work].id);
    assert.deepEqual([session.data.testCommand, session.workspace.testCommand], ['make test', 'make test'], 'threads take their project\'s test command');
    assert.equal(JSON.parse(await readFile(sessionFile(dir, id), 'utf8')).projectId, byPath[work].id);
  }
  assert.equal(app.store.get(sample).data.projectId, byPath[scratch].id);
  const lost = app.store.get(missing);
  assert.equal(lost.summary().unavailable, true); assert.equal(lost.data.messages[0].content, 'hello');
  const headers = { 'Content-Type': 'application/json', 'X-Shout-Client': '1' };
  const refused = await fetch(`${app.url}/api/sessions/${missing}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(refused.status, 400); assert.equal((await refused.json()).error, `Workspace folder is missing: ${gone}`);
  assert.deepEqual(await (await fetch(`${app.url}/api/sessions/${missing}/files`)).json(), { files: [] });
  const newThread = await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ projectId: byPath[gone].id }) });
  assert.equal(newThread.status, 409); assert.equal((await newThread.json()).code, 'workspace_missing');
  const restarted = await openStore(t, dir);
  assert.equal(restarted.projectList().length, 3, 'migration runs once');
});

test('a new thread reuses the project\'s empty draft and starts on the project\'s default model when its provider is available', async t => {
  const dir = await tempDir(t);
  const store = await openStore(t, dir, { defaultModel: { model: 'gpt-6-sol', effort: 'high' }, modelAvailable: model => !model.startsWith('claude') });
  const { project } = await store.addProject({ path: dir, testCommand: 'npm test' });
  await store.updateProject(project.id, { defaultModel: { model: 'claude-opus-5-5', effort: 'max' } });
  const first = await store.newThread({ projectId: project.id });
  assert.equal(first.reused, false);
  assert.deepEqual([first.session.data.model, first.session.data.effort, first.session.data.projectId, first.session.data.workspace, first.session.data.testCommand, first.session.data.title], ['gpt-6-sol', 'high', project.id, dir, 'npm test', 'New thread']);
  const again = await store.newThread({ projectId: project.id });
  assert.equal(again.reused, true); assert.equal(again.session, first.session);
  assert.equal((await store.newThread({ projectId: project.id, effort: 'xhigh' })).session.data.effort, 'xhigh', 'a given model or effort applies to the draft');
  assert.equal(await store.create({ workspace: dir }), first.session, 'the older workspace form finds the same draft');
  await assert.rejects(store.newThread({ projectId: project.id, model: 'gpt-6-sol', effort: 'max' }), /Unknown model or effort/);
  store.send(first.session.data.id, 'hello'); await first.session.task;
  await store.updateProject(project.id, { defaultModel: { model: 'gpt-6-astra', effort: 'low' } });
  const second = await store.newThread({ projectId: project.id });
  assert.equal(second.reused, false); assert.deepEqual([second.session.data.model, second.session.data.effort], ['gpt-6-astra', 'low']);
  second.session.setTitle('Kept for later');
  const third = await store.newThread({ projectId: project.id, model: 'claude-fable-5-1' });
  assert.equal(third.reused, false, 'a renamed thread is not a draft');
  assert.deepEqual([third.session.data.model, third.session.data.effort], ['claude-fable-5-1', 'low']);
  await assert.rejects(store.newThread({ projectId: 'project-00000000-0000-0000-0000-000000000000' }), /Project not found/);
  assert.equal(store.projectList()[0].threadCount, 3);
});

test('a renamed thread keeps its title through the first message and a restart', async t => {
  const dir = await tempDir(t);
  const store = await openStore(t, dir);
  const { project } = await store.addProject({ path: dir });
  const named = await store.create({ projectId: project.id });
  named.setTitle('  Fix   the\nlogin bug ');
  assert.equal(named.data.title, 'Fix the login bug');
  assert.throws(() => named.setTitle('   '), /1–120/); assert.throws(() => named.setTitle('x'.repeat(121)), /1–120/); assert.throws(() => named.setTitle(7), /1–120/);
  store.send(named.data.id, 'Please look at the session cookie'); await named.task;
  assert.equal(named.data.title, 'Fix the login bug');
  const plain = await store.create({ projectId: project.id });
  store.send(plain.data.id, 'Explain the build'); await plain.task;
  assert.equal(plain.data.title, 'Explain the build');
  await named.persist();
  const restarted = await openStore(t, dir);
  assert.equal(restarted.get(named.data.id).data.title, 'Fix the login bug');
  restarted.send(named.data.id, 'Another message'); await restarted.get(named.data.id).task;
  assert.equal(restarted.get(named.data.id).data.title, 'Fix the login bug');
});

test('summaries carry what a sidebar row needs, including what a waiting thread needs from the user', async t => {
  const dir = await tempDir(t);
  const store = await openStore(t, dir, { agent: codeAgent(), providerFactory: data => scenarioProvider(data.scenario) });
  const { project } = await store.addProject({ sample: 'pricing' });
  assert.equal(project.sample, 'pricing'); assert.equal(project.testCommand, 'node --test *.test.mjs');
  const session = await store.create({ projectId: project.id });
  assert.deepEqual([session.data.scenario, session.data.title], ['pricing', 'Fix a checkout calculation']);
  const fresh = session.summary();
  for (const key of ['id', 'title', 'projectId', 'workspace', 'status', 'attention', 'sleeping', 'model', 'effort', 'provider', 'modelLocked', 'createdAt', 'updatedAt', 'lastMessageAt', 'messageCount', 'runCount', 'unavailable']) assert.ok(key in fresh, key);
  assert.equal('messages' in fresh, false);
  assert.deepEqual([fresh.projectId, fresh.status, fresh.attention, fresh.lastMessageAt, fresh.messageCount, fresh.runCount, fresh.unavailable], [project.id, 'idle', null, null, 0, 0, false]);
  store.send(session.data.id, session.data.suggestedPrompt);
  await waitFor(() => session.data.question);
  const waiting = store.list().find(item => item.id === session.data.id);
  assert.deepEqual([waiting.status, waiting.attention, waiting.runCount], ['waiting_user', 'approval', 1]);
  assert.equal(waiting.lastMessageAt, session.data.messages.at(-1).time);
  assert.equal(store.projectList()[0].activeCount, 1);
  session.cancel(); await session.task;
  Object.assign(session.data, { status: 'waiting_user', question: { id: 'q', kind: 'ask' } });
  assert.equal(session.summary().attention, 'ask');
  Object.assign(session.data, { status: 'cancelled', question: null });
});

test('project test commands reach idle threads at once and busy threads with their next message', async t => {
  const dir = await tempDir(t);
  const { agent, release } = gatedAgent();
  const store = await openStore(t, dir, { agent });
  const { project } = await store.addProject({ path: dir });
  const idle = await store.create({ projectId: project.id });
  store.send(idle.data.id, 'hello'); await idle.task;
  const busy = await store.create({ projectId: project.id });
  store.send(busy.data.id, 'wait for it');
  assert.throws(() => store.send(idle.data.id, 'again'), /Another session is using this workspace/, 'one thread per folder at a time');
  await store.updateProject(project.id, { testCommand: 'npm test' });
  assert.deepEqual([idle.data.testCommand, idle.workspace.testCommand], ['npm test', 'npm test']);
  assert.deepEqual([busy.data.testCommand, busy.workspace.testCommand], ['', '']);
  release(); await busy.task;
  store.send(busy.data.id, 'next'); await busy.task;
  assert.deepEqual([busy.data.testCommand, busy.workspace.testCommand], ['npm test', 'npm test']);
});

test('deleting a thread removes its history only, and is refused while it works', async t => {
  const dir = await tempDir(t);
  const work = resolve(dir, 'work'); await mkdir(work); await writeFile(resolve(work, 'keep.txt'), 'keep\n');
  const { agent, release } = gatedAgent();
  const store = await openStore(t, dir, { agent });
  const session = await store.create({ workspace: work });
  store.send(session.data.id, 'wait');
  await assert.rejects(store.delete(session.data.id), error => error.code === 'busy');
  release(); await session.task;
  const id = session.data.id;
  let deleted = null; session.on('deleted', event => { deleted = event; });
  session.changed(); // a save still pending when the thread goes must not bring its file back
  assert.deepEqual(await store.delete(id), { id, deleted: true });
  assert.deepEqual(deleted, { id });
  assert.throws(() => store.get(id), /Session not found/);
  assert.throws(() => session.send('more'), /closed/);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(await exists(sessionFile(dir, id)), false);
  assert.equal(await readFile(resolve(work, 'keep.txt'), 'utf8'), 'keep\n');
  assert.equal(store.projectList()[0].threadCount, 0);
  const restarted = await openStore(t, dir);
  assert.equal(restarted.list().length, 0);
});

test('removing a project deletes its threads, is refused while one works, and deletes only a sample\'s own scratch copy', async t => {
  const dir = await tempDir(t);
  const work = resolve(dir, 'work'); await mkdir(work); await writeFile(resolve(work, 'keep.txt'), 'keep\n');
  const { agent, release } = gatedAgent();
  const store = await openStore(t, dir, { agent });
  const { project } = await store.addProject({ path: work });
  const threads = [await store.create({ projectId: project.id })];
  store.send(threads[0].data.id, 'hello'); await threads[0].task;
  threads.push(await store.create({ projectId: project.id }));
  store.send(threads[1].data.id, 'wait');
  await assert.rejects(store.removeProject(project.id), error => error.code === 'busy' && /Cancel or finish/.test(error.message));
  assert.equal(store.projectList().length, 1);
  release(); await threads[1].task;
  assert.deepEqual(await store.removeProject(project.id), { id: project.id, removed: true, threads: 2, deletedFolder: false });
  for (const thread of threads) assert.equal(await exists(sessionFile(dir, thread.data.id)), false);
  assert.equal(await readFile(resolve(work, 'keep.txt'), 'utf8'), 'keep\n', 'a real project folder is never deleted');
  assert.deepEqual([store.projectList().length, store.list().length], [0, 0]);

  const { project: sample } = await store.addProject({ sample: 'slug' });
  assert.equal(await realpath(resolve(sample.path, '..')), await realpath(resolve(dir, 'workspaces')));
  await store.create({ projectId: sample.id });
  assert.deepEqual(await store.removeProject(sample.id), { id: sample.id, removed: true, threads: 1, deletedFolder: true });
  assert.equal(await exists(sample.path), false);

  // A sample whose folder is not a scratch copy inside <stateRoot>/workspaces keeps its folder, even through a link.
  const outside = resolve(dir, 'outside'); await mkdir(outside); await writeFile(resolve(outside, 'keep.txt'), 'keep\n');
  const linked = resolve(dir, 'workspaces', 'pricing-abcdef'); await symlink(outside, linked);
  for (const path of [outside, linked]) {
    const adopted = store.projects.adopt({ path, sample: 'pricing' });
    assert.equal((await store.removeProject(adopted.id)).deletedFolder, false);
  }
  assert.equal(await readFile(resolve(outside, 'keep.txt'), 'utf8'), 'keep\n');
});

// Reads one server-sent event stream: `next(match)` resolves to the first event that `match(type, data)` accepts.
async function eventReader(url, signal) {
  const response = await fetch(url, { signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  return {
    response,
    async next(match = () => true) {
      for (;;) {
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && match(type, data && JSON.parse(data))) return { type, data: data && JSON.parse(data) };
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}
const rawStatus = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolveStatus, reject) => {
  const request = httpRequest(url, { method, headers }, response => { response.resume(); resolveStatus(response.statusCode); });
  request.on('error', reject); request.end();
});

test('HTTP project and thread routes, with client-header and host checks on every change', async t => {
  const dir = await tempDir(t);
  const { agent, release } = gatedAgent();
  const app = await startServer({ port: 0, allowedHosts: new Set(['127.0.0.1', 'localhost']), stateRoot: dir, defaultWorkspace: dir, agent, checkProvider: async () => ({ available: true, version: 'test' }) });
  t.after(() => app.close());
  const headers = { 'Content-Type': 'application/json', 'X-Shout-Client': '1' };
  const call = (method, path, body) => fetch(`${app.url}/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const config = await (await fetch(`${app.url}/api/config`)).json();
  assert.equal(config.home, homedir());
  const work = resolve(dir, 'work');

  assert.equal((await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).status, 403);
  assert.equal((await fetch(`${app.url}/api/projects`, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' }, body: JSON.stringify({ path: dir }) })).status, 403);
  assert.equal(await rawStatus(`${app.url}/api/projects`, { headers: { Host: `evil.example:${new URL(app.url).port}` } }), 403);
  const missing = await call('POST', '/projects', { path: work });
  assert.equal(missing.status, 409); assert.deepEqual(await missing.json(), { error: `Workspace folder does not exist: ${work}`, code: 'workspace_missing', path: work });
  assert.equal((await call('POST', '/projects', { path: 'work' })).status, 400);
  assert.equal((await call('POST', '/projects', ['not', 'an', 'object'])).status, 400);
  const created = await call('POST', '/projects', { path: work, createWorkspace: true, testCommand: 'npm test' });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.deepEqual([project.name, project.path, project.testCommand, project.existing, project.threadCount, project.activeCount], ['work', work, 'npm test', false, 0, 0]);
  const again = await call('POST', '/projects', { path: `${work}/` });
  const againBody = await again.json();
  assert.equal(again.status, 200); assert.deepEqual([againBody.id, againBody.existing], [project.id, true]);
  const sample = await (await call('POST', '/projects', { sample: 'validation' })).json();
  assert.deepEqual([sample.sample, sample.name], ['validation', 'Unify inconsistent validation']);

  const updated = await call('POST', `/projects/${project.id}`, { name: 'Work', defaultModel: { model: 'claude-fable-5-1', effort: 'high' } });
  assert.equal(updated.status, 200); assert.deepEqual([(await updated.json()).name], ['Work']);
  assert.equal((await call('POST', `/projects/${project.id}`, { testCommand: 5 })).status, 400);
  assert.equal((await call('POST', '/projects/project-00000000-0000-0000-0000-000000000000', { name: 'x' })).status, 404);

  const thread = await call('POST', '/sessions', { projectId: project.id });
  assert.equal(thread.status, 201);
  const session = await thread.json();
  assert.deepEqual([session.projectId, session.workspace, session.testCommand, session.model, session.effort], [project.id, work, 'npm test', 'claude-fable-5-1', 'high']);
  const draft = await call('POST', '/sessions', { projectId: project.id, effort: 'low' });
  assert.equal(draft.status, 200); assert.deepEqual([(await draft.json()).id, app.store.get(session.id).data.effort], [session.id, 'low']);
  const renamed = await call('POST', `/sessions/${session.id}/title`, { title: 'Named' });
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).title, 'Named');
  assert.equal((await call('POST', `/sessions/${session.id}/title`, { title: '' })).status, 400);
  assert.equal((await call('POST', `/sessions/${session.id}/messages`, { text: 'wait here' })).status, 202);
  assert.equal((await fetch(`${app.url}/api/sessions/${session.id}`, { method: 'DELETE' })).status, 403, 'DELETE needs the client header');
  const refusedThread = await call('DELETE', `/sessions/${session.id}`);
  assert.equal(refusedThread.status, 409); assert.equal((await refusedThread.json()).code, 'busy');
  const refusedProject = await call('DELETE', `/projects/${project.id}`);
  assert.equal(refusedProject.status, 409); assert.equal((await refusedProject.json()).code, 'busy');
  assert.equal((await (await fetch(`${app.url}/api/projects`)).json()).find(item => item.id === project.id).activeCount, 1);
  release(); await waitFor(() => app.store.get(session.id).data.status === 'idle');
  assert.equal(app.store.get(session.id).data.title, 'Named');

  const abort = new AbortController(); t.after(() => abort.abort());
  const events = await eventReader(`${app.url}/api/sessions/${session.id}/events`, abort.signal);
  assert.equal((await events.next()).type, 'snapshot');
  const deleted = await call('DELETE', `/sessions/${session.id}`);
  assert.equal(deleted.status, 200); assert.deepEqual(await deleted.json(), { id: session.id, deleted: true });
  assert.deepEqual(await events.next(type => type === 'deleted'), { type: 'deleted', data: { id: session.id } });
  assert.equal(await events.next(), null, 'the stream ends');
  assert.equal((await fetch(`${app.url}/api/sessions/${session.id}`)).status, 404);
  assert.equal((await call('DELETE', `/sessions/${session.id}`)).status, 404);

  const removed = await call('DELETE', `/projects/${sample.id}`);
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { id: sample.id, removed: true, threads: 0, deletedFolder: true });
  assert.equal((await call('DELETE', `/projects/${sample.id}`)).status, 404);
  assert.deepEqual((await (await fetch(`${app.url}/api/projects`)).json()).map(item => item.id), [project.id]);
});

test('the list stream sends projects and thread summaries on connect and when a thread changes', async t => {
  const dir = await tempDir(t);
  const { agent, release } = gatedAgent();
  const app = await startServer({ port: 0, allowedHosts: new Set(['127.0.0.1']), stateRoot: dir, defaultWorkspace: dir, agent, checkProvider: async () => ({ available: true, version: 'test' }) });
  t.after(() => app.close());
  const headers = { 'Content-Type': 'application/json', 'X-Shout-Client': '1' };
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await eventReader(`${app.url}/api/stream`, abort.signal);
  assert.equal(stream.response.headers.get('content-type'), 'text/event-stream');
  assert.deepEqual((await stream.next()).data, { projects: [], sessions: [] });
  const project = await (await fetch(`${app.url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ path: dir }) })).json();
  const withProject = await stream.next((type, data) => data.projects.length === 1);
  assert.equal(withProject.type, 'state'); assert.equal(withProject.data.projects[0].id, project.id);
  const session = await (await fetch(`${app.url}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ projectId: project.id }) })).json();
  const row = id => data => data.sessions.find(item => item.id === id);
  assert.equal(row(session.id)((await stream.next((type, data) => row(session.id)(data))).data).status, 'idle');
  await fetch(`${app.url}/api/sessions/${session.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'wait please' }) });
  const running = await stream.next((type, data) => row(session.id)(data)?.status === 'thinking');
  assert.equal(running.data.projects[0].activeCount, 1);
  release();
  const done = await stream.next((type, data) => row(session.id)(data)?.status === 'idle');
  assert.deepEqual([row(session.id)(done.data).messageCount, row(session.id)(done.data).title, done.data.projects[0].activeCount], [2, 'wait please', 0]);
});

test('the folder browser lists sub-directories only: no files, no hidden folders, at most 500', async t => {
  const dir = await tempDir(t);
  for (const name of ['beta', 'alpha', '.hidden', 'node_modules']) await mkdir(resolve(dir, name));
  await writeFile(resolve(dir, 'secret.txt'), 'x'); await writeFile(resolve(dir, '.env'), 'x');
  await symlink(resolve(dir, 'alpha'), resolve(dir, 'linked')); await symlink(resolve(dir, 'secret.txt'), resolve(dir, 'file-link'));
  const app = await startServer({ port: 0, allowedHosts: new Set(['127.0.0.1']), stateRoot: resolve(dir, '.state'), agent: new ScriptedAgent(), checkProvider: async () => ({ available: true, version: 'test' }) });
  t.after(() => app.close());
  const list = async path => { const response = await fetch(`${app.url}/api/fs/dirs${path === undefined ? '' : `?path=${encodeURIComponent(path)}`}`); return [response.status, await response.json()]; };
  const [status, listing] = await list(dir);
  assert.equal(status, 200);
  assert.deepEqual(listing, { path: dir, parent: resolve(dir, '..'), exists: true, truncated: false, dirs: ['alpha', 'beta', 'linked', 'node_modules'].map(name => ({ name, path: resolve(dir, name) })) });
  assert.equal((await list(undefined))[1].path, homedir());
  assert.equal((await list('~'))[1].path, homedir());
  assert.deepEqual((await list(resolve(dir, 'nope')))[1], { path: resolve(dir, 'nope'), parent: dir, exists: false, dirs: [], truncated: false });
  assert.equal((await list(resolve(dir, 'secret.txt')))[1].exists, false);
  assert.equal((await list('/'))[1].parent, null);
  assert.equal((await list('relative/path'))[0], 400);
  const many = resolve(dir, 'many');
  await Promise.all(Array.from({ length: 502 }, (_, index) => mkdir(resolve(many, `d${String(index).padStart(3, '0')}`), { recursive: true })));
  const capped = await listDirectories(many);
  assert.deepEqual([capped.dirs.length, capped.truncated, capped.dirs[0].name, capped.dirs.at(-1).name], [500, true, 'd000', 'd499']);
});
