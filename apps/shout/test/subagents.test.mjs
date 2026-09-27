import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { ScriptedAgent } from './doubles.mjs';

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); }
  throw new Error('Timed out waiting for session state');
}
// A sub-agent's thread has the read tools only; its instructions name it.
const childName = thread => (thread.tools.some(tool => tool.name === 'spawn_agents') ? null : /^You are ([a-z][a-z0-9-]*), a sub-agent of SHOUT/.exec(thread.instructions)?.[1]);
const briefs = (...names) => names.map(name => ({ name, brief: `Look into ${name} and report.` }));
const statuses = session => session.data.agents.map(agent => agent.status);
const count = (session, status) => session.data.agents.filter(agent => agent.status === status).length;
const untilAbort = signal => new Promise(resolveAbort => signal.addEventListener('abort', resolveAbort, { once: true }));

/** A session whose model is `parent({ ...turn })` on SHOUT's thread and `child(name, { ...turn })` on each sub-agent's. */
async function setup(t, { parent, child }) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-subagents-'));
  const workspace = resolve(dir, 'project'); const stateRoot = resolve(dir, 'state');
  await mkdir(workspace); await writeFile(resolve(workspace, 'notes.txt'), 'alpha\nbeta\n');
  const agent = new ScriptedAgent(async turn => { const name = childName(turn.thread); return name ? child(name, turn) : parent(turn); });
  const store = await new SessionStore({ stateRoot, agent }).init();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  const session = await store.create({ workspace });
  return { store, session, agent, stateRoot, workspace };
}

test('a fan-out of three runs the children at once on their own threads and returns every report', async t => {
  const seen = { activities: [] }; let running = 0; let peak = 0; let allIn; const together = new Promise(resolveAll => { allIn = resolveAll; });
  const { store, session, agent, workspace } = await setup(t, {
    parent: async ({ call, say }) => { seen.result = await call('spawn_agents', { purpose: 'check the notes', agents: briefs('one', 'two', 'three') }); say('All three reported.'); },
    child: async (name, { call, say, usage }) => {
      running++; peak = Math.max(peak, running); if (running === 3) allIn();
      await call('read_file', { path: 'notes.txt' });
      await Promise.race([together, delay(2000)]);
      say(`Looking at ${name}.`); usage({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }); say(`Report from ${name}.`);
      running--;
    },
  });
  const read = session.workspace.read.bind(session.workspace);
  session.workspace.read = async (...args) => { seen.activities.push(...session.data.agents.map(item => item.activity)); return read(...args); };
  store.send(session.data.id, 'Investigate'); await session.task;
  assert.equal(peak, 3, 'the three children ran at the same time');
  assert.equal(session.data.status, 'idle');
  assert.equal(session.data.messages.at(-1).content, 'All three reported.');
  assert.equal(seen.result, ['one', 'two', 'three'].map(name => `## ${name} (completed)\nReport from ${name}.`).join('\n\n'));
  assert.ok(seen.activities.includes('read_file notes.txt'), JSON.stringify(seen.activities));
  const [first] = session.data.agents;
  assert.equal(session.data.agents.length, 3);
  for (const [index, name] of ['one', 'two', 'three'].entries()) {
    const item = session.data.agents[index];
    assert.match(item.id, /^agent-[0-9a-f-]{36}$/);
    assert.equal(item.group, first.group);
    assert.deepEqual([item.name, item.brief, item.status, item.report, item.error, item.activity, item.calls, item.model, item.effort],
      [name, `Look into ${name} and report.`, 'completed', `Report from ${name}.`, '', '', 1, session.data.model, session.data.effort]);
    assert.deepEqual(item.usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 });
    assert.deepEqual(item.messages.map(message => [message.role, message.content]), [['user', item.brief], ['assistant', `Looking at ${name}.`], ['assistant', `Report from ${name}.`]]);
    assert.match(item.threadId, /^thread-\d$/);
    assert.ok(Date.parse(item.startedAt) <= Date.parse(item.endedAt));
    assert.deepEqual([...new Set(item.events.map(event => event.type))].sort(), ['chat.completed', 'chat.started', 'chat.worker', 'tool.completed', 'tool.started']);
    assert.deepEqual(item.events.find(event => event.type === 'tool.started').input, { path: 'notes.txt' });
    assert.deepEqual(item.events.map(event => event.sequence), item.events.map((_, i) => i + 1));
    assert.equal(item.sequence, item.events.length);
  }
  // Each child has its own thread, instructions and read-only tools, and runs on the session's model and effort.
  const childTurns = agent.turns.filter((_, index) => childName(agent.threadOptions[index]));
  assert.deepEqual(childTurns.map(turn => [turn.text, turn.model, turn.effort]).sort(), ['one', 'three', 'two'].map(name => [`Look into ${name} and report.`, session.data.model, session.data.effort]));
  const childThreads = agent.threads.filter(thread => childName(thread));
  assert.equal(childThreads.length, 3);
  for (const thread of childThreads) {
    assert.deepEqual(thread.tools.map(tool => tool.name), ['list_files', 'read_file', 'search_files', 'git']);
    assert.match(thread.instructions, /^You are (one|two|three), a sub-agent of SHOUT/);
    assert.doesNotMatch(thread.instructions, /run_program|spawn_agents/);
    assert.equal(thread.context, `Workspace: ${workspace}`);
    assert.equal(thread.cwd, workspace);
  }
  for (const [index, thread] of agent.threadOptions.entries()) assert.deepEqual(thread, agent.threads[Number(agent.turns[index].threadId.slice('thread-'.length)) - 1], 'every turn passes its own thread\'s options');
  assert.match(agent.threads[0].instructions, /spawn_agents runs up to 8 sub-agents/);
  assert.ok(agent.threads[0].tools.some(tool => tool.name === 'spawn_agents'));
  // The parent's flow has one agents.spawn step whose effect ID is the group.
  const spawn = session.data.events.filter(event => event.tool === 'agents.spawn');
  assert.deepEqual(spawn.map(event => [event.type, event.effectId]), [['tool.started', first.group], ['tool.completed', first.group]]);
  assert.deepEqual(spawn[0].input, { purpose: 'check the notes', agents: session.data.agents.map(({ id, name }) => ({ id, name })) });
  assert.deepEqual(spawn[1].value, { completed: 3, failed: 0 });
  assert.deepEqual(session.snapshot().agents, session.data.agents, 'the snapshot carries the agents');
  assert.ok(!('agents' in store.list()[0]), 'the session list does not');
});

test('with six children no more than four run at once and the rest wait as queued', async t => {
  let release; const gate = new Promise(resolveGate => { release = resolveGate; }); let running = 0; let peak = 0;
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { say((await call('spawn_agents', { purpose: 'wide', agents: briefs('a', 'b', 'c', 'd', 'e', 'f') })).split('\n\n').length + ' reports'); },
    child: async (name, { say }) => { running++; peak = Math.max(peak, running); await gate; running--; say(`done ${name}`); },
  });
  store.send(session.data.id, 'Go wide');
  await waitFor(() => count(session, 'running') === 4);
  await delay(50);
  assert.deepEqual(statuses(session), ['running', 'running', 'running', 'running', 'queued', 'queued']);
  for (const item of session.data.agents.slice(4)) assert.deepEqual([item.startedAt, item.threadId, item.events.length], [null, null, 0]);
  assert.equal(session.data.status, 'running');
  release(); await session.task;
  assert.equal(peak, 4);
  assert.deepEqual(statuses(session), Array(6).fill('completed'));
  assert.equal(session.data.messages.at(-1).content, '6 reports');
});

test('a failing child is failed while its siblings complete; the call fails only when every child does', async t => {
  const seen = {};
  const { store, session } = await setup(t, {
    parent: async ({ call, say, text }) => {
      if (text === 'mixed') seen.mixed = await call('spawn_agents', { purpose: 'mixed', agents: briefs('good', 'bad', 'fine') });
      else seen.all = await call('spawn_agents', { purpose: 'doomed', agents: briefs('bad-one', 'bad-two') }).then(() => 'resolved', error => error.message);
      say('ok');
    },
    child: async (name, { say }) => { if (name.startsWith('bad')) throw new Error(`boom in ${name}`); say(`fine: ${name}`); },
  });
  store.send(session.data.id, 'mixed'); await session.task;
  assert.deepEqual(statuses(session), ['completed', 'failed', 'completed']);
  const bad = session.data.agents[1];
  assert.deepEqual([bad.error, bad.report, bad.activity], ['boom in bad', '', '']);
  assert.ok(bad.endedAt);
  assert.deepEqual(bad.events.filter(event => event.type === 'session.error').map(event => event.message), ['boom in bad']);
  assert.equal(seen.mixed, '## good (completed)\nfine: good\n\n## bad (failed)\nboom in bad\n\n## fine (completed)\nfine: fine');
  assert.deepEqual(session.data.events.filter(event => event.tool === 'agents.spawn').map(event => event.type), ['tool.started', 'tool.completed']);
  store.send(session.data.id, 'all'); await session.task;
  assert.match(seen.all, /^Every sub-agent failed\.\n\n## bad-one \(failed\)\nboom in bad-one\n\n## bad-two \(failed\)\nboom in bad-two$/);
  const failed = session.data.events.filter(event => event.tool === 'agents.spawn').at(-1);
  assert.deepEqual([failed.type, failed.effectId, failed.error.message], ['tool.failed', session.data.agents.at(-1).group, 'All 2 agents failed']);
  assert.equal(session.data.status, 'idle');
});

test('a child cannot use tools beyond the read tools, and has a tool budget', async t => {
  const seen = {};
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { await call('spawn_agents', { purpose: 'probe', agents: briefs('probe') }); say('ok'); },
    child: async (name, { call, say }) => {
      for (const [tool, input] of [['run_program', { program: 'x', args: '' }], ['spawn_agents', { purpose: 'nest', agents: briefs('inner') }], ['run_skill', { name: 'code', args: '' }], ['allen_guide', {}], ['list_skills', {}]]) {
        seen[tool] = await call(tool, input).then(() => 'resolved', error => error.message);
      }
      seen.budget = [];
      for (let i = 0; i < 41; i++) seen.budget.push(await call('list_files', {}).then(() => 'ok', error => error.message));
      say('done');
    },
  });
  store.send(session.data.id, 'Probe'); await session.task;
  for (const tool of ['run_program', 'spawn_agents', 'run_skill', 'allen_guide', 'list_skills']) assert.match(seen[tool], new RegExp(`^${tool} is not available to sub-agents`), tool);
  assert.deepEqual(seen.budget.slice(0, 40), Array(40).fill('ok'));
  assert.match(seen.budget[40], /Tool budget exhausted \(40 calls\)/);
  const [probe] = session.data.agents;
  assert.deepEqual([probe.status, probe.calls, session.data.agents.length, session.data.runs.length], ['completed', 40, 1, 0]);
});

test('invalid fan-outs fail the call and record nothing', async t => {
  const results = [];
  const inputs = [{ purpose: 'none', agents: [] }, { purpose: 'many', agents: briefs('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i') },
    { purpose: 'name', agents: briefs('Bad Name') }, { purpose: 'twice', agents: briefs('same', 'same') }, { purpose: 'empty', agents: [{ name: 'blank', brief: ' ' }] },
    { purpose: 'budget', agents: briefs('x', 'y', 'z') }];
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { for (const input of inputs) results.push(await call('spawn_agents', input).then(() => 'resolved', error => error.message)); say('ok'); },
    child: async () => { throw new Error('no child should run'); },
  });
  session.data.agents.push(...Array.from({ length: 22 }, (_, i) => ({ id: `agent-old-${i}`, status: 'completed' })));
  store.send(session.data.id, 'Try'); await session.task;
  assert.match(results[0], /takes 1 to 8 agents/); assert.match(results[1], /takes 1 to 8 agents/);
  assert.match(results[2], /Invalid agent name "Bad Name"/); assert.match(results[3], /unique.*same/); assert.match(results[4], /brief for blank/);
  assert.match(results[5], /24 sub-agents in all and this one has 2 left/);
  assert.equal(session.data.agents.length, 22);
  assert.ok(!session.data.events.some(event => event.tool === 'agents.spawn'));
});

test('cancelling the session stops every child and leaves no running or queued agent', async t => {
  const late = [];
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { await call('spawn_agents', { purpose: 'long', agents: briefs('a', 'b', 'c', 'd', 'e', 'f') }).catch(() => {}); say('never'); },
    child: async (name, { call, signal }) => { await untilAbort(signal); late.push(await call('read_file', { path: 'notes.txt' }).then(() => 'ran', error => error.message)); },
  });
  store.send(session.data.id, 'Go');
  await waitFor(() => count(session, 'running') === 4);
  session.cancel(); await session.task;
  assert.deepEqual(statuses(session), Array(6).fill('cancelled'));
  const lengths = session.data.agents.map(item => item.events.length);
  await waitFor(() => late.length === 4);
  await delay(50);
  assert.deepEqual(late, Array(4).fill('This sub-agent has stopped'));
  assert.deepEqual(statuses(session), Array(6).fill('cancelled'));
  assert.deepEqual(session.data.agents.map(item => item.events.length), lengths, 'nothing is recorded after the cancel');
  for (const item of session.data.agents) assert.deepEqual([Boolean(item.endedAt), item.activity], [true, '']);
  assert.deepEqual(session.data.agents.slice(4).map(item => item.startedAt), [null, null], 'queued agents never start');
  assert.equal(session.data.status, 'cancelled');
  assert.ok(!session.data.messages.some(message => message.content === 'never'));
});

test('a restart marks unfinished agents interrupted', async t => {
  const { store, session, stateRoot } = await setup(t, {
    parent: async ({ call }) => { await call('spawn_agents', { purpose: 'long', agents: briefs('a', 'b', 'c', 'd', 'e') }).catch(() => {}); },
    child: async (name, { signal, say }) => { if (name === 'a') return say('quick report'); await untilAbort(signal); },
  });
  store.send(session.data.id, 'Go');
  await waitFor(() => count(session, 'completed') === 1 && count(session, 'running') === 4);
  await session.persist();
  const restored = await new SessionStore({ stateRoot, agent: new ScriptedAgent() }).init();
  t.after(() => restored.close());
  const copy = restored.get(session.data.id);
  assert.equal(copy.data.status, 'interrupted');
  assert.deepEqual(statuses(copy), ['completed', 'interrupted', 'interrupted', 'interrupted', 'interrupted']);
  for (const item of copy.data.agents.slice(1)) assert.deepEqual([Boolean(item.endedAt), item.activity], [true, '']);
  assert.equal(copy.data.agents[0].report, 'quick report');
});

test('child events stay on the agent records and never reach session.events', async t => {
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { await call('read_file', { path: 'notes.txt' }); await call('spawn_agents', { purpose: 'split', agents: briefs('reader', 'broken') }); say('ok'); },
    child: async (name, { call, say, usage }) => {
      await call('search_files', { query: 'beta' }); await call('read_file', { path: 'missing.txt' }).catch(() => {});
      usage({ inputTokens: 3, cachedInputTokens: 0, outputTokens: 1 });
      if (name === 'broken') throw new Error('child failure');
      say('found beta');
    },
  });
  store.send(session.data.id, 'Split'); await session.task;
  const sessionIds = new Set(session.data.events.map(event => event.id));
  const childEvents = session.data.agents.flatMap(item => item.events);
  assert.ok(childEvents.length >= 12);
  assert.ok(childEvents.every(event => !sessionIds.has(event.id)));
  for (const type of ['tool.started', 'tool.completed', 'tool.failed', 'chat.worker', 'session.error']) assert.ok(childEvents.some(event => event.type === type), type);
  assert.deepEqual(session.data.events.filter(event => event.type.startsWith('tool.')).map(event => event.tool), ['workspace.read', 'workspace.read', 'agents.spawn', 'agents.spawn']);
  assert.ok(!session.data.events.some(event => event.type === 'session.error' || (event.type === 'chat.started' && ['reader', 'broken'].includes(event.label))));
  assert.equal(session.data.events.filter(event => event.type === 'chat.worker').length, 0, 'child usage is not the parent\'s');
  assert.deepEqual(statuses(session), ['completed', 'failed']);
});

test('children still running when the parent\'s turn ends are stopped, and the turn stays closed', async t => {
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { void call('spawn_agents', { purpose: 'orphans', agents: briefs('a', 'b', 'c', 'd', 'e') }).catch(() => {}); await waitFor(() => count(session, 'running') === 4); say('moving on'); },
    child: async (name, { signal }) => { await untilAbort(signal); },
  });
  store.send(session.data.id, 'Go'); await session.task;
  await waitFor(() => !statuses(session).some(status => status === 'running' || status === 'queued'));
  await delay(50);
  assert.deepEqual(statuses(session), Array(5).fill('failed'));
  assert.ok(session.data.agents.every(item => item.error === 'SHOUT\'s turn ended before this agent finished'));
  assert.equal(session.data.status, 'idle');
  assert.equal(session.data.events.at(-1).type, 'tool.failed');
  assert.equal(session.data.events.filter(event => event.type === 'chat.started').length, session.data.events.filter(event => event.type === 'chat.completed').length, 'no chat step reopened after the turn');
});

test('snapshots are coalesced to one per 50 ms and the last one carries the final state', async t => {
  const { store, session } = await setup(t, {
    parent: async ({ call, say }) => { await call('spawn_agents', { purpose: 'burst', agents: briefs('a', 'b', 'c', 'd', 'e') }); say('done'); },
    child: async (name, { call, say }) => { for (let i = 0; i < 5; i++) await call('list_files', {}); say(`report ${name}`); },
  });
  const snapshots = []; session.on('snapshot', snapshot => snapshots.push(snapshot));
  for (let i = 0; i < 100; i++) session.changed();
  assert.equal(snapshots.length, 0, 'nothing goes out synchronously');
  await waitFor(() => snapshots.length); await delay(80);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].revision, session.data.revision);
  snapshots.length = 0; let changes = 0;
  const changed = session.changed.bind(session); session.changed = () => { changes++; changed(); };
  store.send(session.data.id, 'Burst'); await session.task; await delay(80);
  assert.ok(snapshots.length >= 1 && snapshots.length < changes / 10, `${snapshots.length} snapshots for ${changes} changes`);
  const last = snapshots.at(-1);
  assert.equal(last.revision, session.data.revision);
  assert.deepEqual([last.status, last.messages.at(-1).content], ['idle', 'done']);
  assert.deepEqual(last.agents.map(item => [item.status, item.report, item.calls]), ['a', 'b', 'c', 'd', 'e'].map(name => ['completed', `report ${name}`, 5]));
});
