// Resuming runs after a restart, on the real VM with scripted agents and judgments: a graceful stop suspends a
// running program, a crash leaves its journal, and the next start replays the journal and continues live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { Workspace } from '../src/workspace.mjs';
import { readJournal } from '../src/journal.mjs';
import { ScriptedAgent, codeAgent, scenarioProvider } from './doubles.mjs';

async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for session state');
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
// Judgments counted across stores: a replayed judgment never reaches the provider.
function counted(make) {
  const calls = [];
  return { calls, factory: data => { const provider = make(data); return { judge: request => { calls.push(request.prompt?.system ?? ''); return provider.judge(request); } }; } };
}
const settled = session => session.data.question || ['completed', 'failed', 'cancelled', 'interrupted', 'stopped', 'idle'].includes(session.data.status);
const journalOf = (dir, runId) => resolve(dir, 'runs', runId, 'journal.jsonl');
// Counts workspace writes and shell commands in every store.
function spy(t) {
  const counts = { apply: 0, run: 0 };
  const { apply, run } = Workspace.prototype;
  Workspace.prototype.apply = function (...args) { counts.apply++; return apply.apply(this, args); };
  Workspace.prototype.run = function (...args) { if (!/test/.test(args[1]?.label ?? '')) counts.run++; return run.apply(this, args); };
  t.after(() => { Workspace.prototype.apply = apply; Workspace.prototype.run = run; });
  return counts;
}
async function tempDir(t, prefix = 'shout-resume-') {
  const dir = await mkdtemp(resolve(tmpdir(), prefix));
  const previousHome = process.env.SHOUT_HOME; process.env.SHOUT_HOME = resolve(dir, 'home');
  t.after(async () => { if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome; await rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function open(t, stateRoot, options) {
  const store = await new SessionStore({ stateRoot, agent: new ScriptedAgent(), ...options }).init();
  t.after(() => store.close());
  return store;
}
// `/code` on the pricing sample, waiting at its approval.
async function codeAtApproval(t, dir, { agent, provider = counted(data => scenarioProvider(data.scenario)) } = {}) {
  const store = await open(t, dir, { agent, providerFactory: provider.factory });
  const session = await store.create({ scenario: 'pricing' });
  store.send(session.data.id, agent ? session.data.suggestedPrompt : `/code ${session.data.suggestedPrompt}`);
  await waitFor(() => settled(session));
  assert.equal(session.data.question?.kind, 'approval', JSON.stringify(session.data.messages.at(-1)));
  return { store, session, provider };
}
// A workspace skill (in a new workspace with `files`) and a store to run it.
async function skillSession(t, dir, { name, source, files = {}, providerFactory, stateRoot = resolve(dir, 'state') }) {
  const workspace = resolve(dir, 'project');
  await mkdir(resolve(workspace, '.shout', 'skills'), { recursive: true });
  await writeFile(resolve(workspace, '.shout', 'skills', `${name}.allen`), source);
  for (const [path, content] of Object.entries(files)) await writeFile(resolve(workspace, path), content);
  const store = await open(t, stateRoot, { providerFactory });
  const session = await store.create({ workspace });
  return { store, session, workspace, stateRoot };
}

test('a suspended /code resumes at its approval: no judgment is asked again, and accepting writes the file once', async t => {
  const counts = spy(t);
  const dir = await tempDir(t);
  const { store, session, provider } = await codeAtApproval(t, dir);
  const judged = provider.calls.length; const changes = session.data.question.prompt.data.value.changes;
  const runId = session.data.runs[0].id;
  await store.suspend();
  const saved = JSON.parse(await readFile(resolve(dir, 'sessions', `${session.data.id}.json`), 'utf8'));
  assert.deepEqual([saved.status, saved.question, saved.runs[0].state, saved.runs[0].resumable, saved.runs[0].launch.by], ['suspended', null, 'suspended', true, 'command']);
  assert.ok(existsSync(journalOf(dir, runId)), 'the journal stays for the next start');
  assert.ok(!saved.messages.some(message => /Cancelled/.test(message.content)), 'a suspend is not a cancel');

  const restarted = await open(t, dir, { providerFactory: provider.factory });
  const copy = restarted.get(session.data.id);
  await waitFor(() => settled(copy));
  assert.equal(provider.calls.length, judged, 'the judgment came from the journal');
  assert.equal(copy.data.question.kind, 'approval');
  assert.deepEqual(copy.data.question.prompt.data.value.changes, changes, 'the same changes are proposed again');
  assert.equal(copy.data.runs.length, 1); assert.equal(copy.data.runs[0].id, runId); assert.equal(copy.data.runs[0].resumes, 1);
  assert.equal(copy.data.messages.at(-1).content, 'Resuming `/code` after a restart…');
  const types = copy.data.events.map(event => event.type);
  assert.equal(types.filter(type => type === 'program.loaded').length, 1, 'program.loaded is not emitted again');
  assert.ok(types.includes('run.resuming') && types.includes('run.resumed'));
  const resumed = copy.data.events.find(event => event.type === 'run.resumed');
  assert.deepEqual([resumed.replayed, resumed.counters.modelJudgments, resumed.counters.nativeToolCalls], [3, 1, 2], 'budgets are rebuilt from the replayed entries');
  // New effect ids can't collide with the ones before the restart.
  const question = copy.data.events.findLast(event => event.type === 'tool.started');
  assert.match(question.effectId, new RegExp(`^${runId}:r1-r-\\d+$`));
  copy.answer(copy.data.question.id, { accept: true }); await copy.task;
  assert.equal(copy.data.status, 'completed', JSON.stringify(copy.data.messages.at(-1)));
  assert.deepEqual([copy.data.runs[0].state, copy.data.runs[0].result.output.passed], ['completed', true]);
  assert.equal(counts.apply, 1, 'the change is written once');
  assert.equal(await readFile(resolve(copy.data.workspace, 'pricing.mjs'), 'utf8'), changes[0].after);
  assert.ok(!existsSync(journalOf(dir, runId)), 'the journal is deleted when the run ends');
  assert.ok(!existsSync(resolve(dir, 'runs', runId)), 'and its empty run directory');
  assert.equal(copy.data.runs[0].counters.modelJudgments, 1, 'budgets count the replayed judgment');
});

test('a resumed run that is suspended again resumes again from the same journal', async t => {
  const counts = spy(t);
  const dir = await tempDir(t);
  const { store, session, provider } = await codeAtApproval(t, dir);
  const judged = provider.calls.length;
  await store.suspend();
  const second = await open(t, dir, { providerFactory: provider.factory });
  await waitFor(() => second.get(session.data.id).data.question);
  await second.suspend();
  const third = await open(t, dir, { providerFactory: provider.factory });
  const copy = third.get(session.data.id);
  await waitFor(() => settled(copy));
  assert.equal(copy.data.question?.kind, 'approval');
  assert.deepEqual([provider.calls.length, copy.data.runs[0].resumes], [judged, 2]);
  assert.equal(copy.data.events.findLast(event => event.type === 'run.resumed').replayed, 3);
  assert.match(copy.data.question.id ?? '', /^approval-/);
  assert.match(copy.data.events.findLast(event => event.type === 'tool.started').effectId, /:r2-r-\d+$/);
  copy.answer(copy.data.question.id, { accept: true }); await copy.task;
  assert.deepEqual([copy.data.status, copy.data.runs[0].result.output.passed, counts.apply], ['completed', true, 1]);
});

test('a crash (the state as it was on disk) resumes the same way', async t => {
  const dir = await tempDir(t);
  const { store, session, provider } = await codeAtApproval(t, resolve(dir, 'live'));
  await session.persist();
  await cp(resolve(dir, 'live'), resolve(dir, 'crash'), { recursive: true });
  await store.close();
  const judged = provider.calls.length;
  const restarted = await open(t, resolve(dir, 'crash'), { providerFactory: provider.factory });
  const copy = restarted.get(session.data.id);
  assert.equal(copy.data.status, 'resuming');
  await waitFor(() => settled(copy));
  assert.equal(provider.calls.length, judged);
  copy.answer(copy.data.question.id, { accept: true }); await copy.task;
  assert.deepEqual([copy.data.status, copy.data.runs[0].result.output.passed], ['completed', true]);
});

// Writes two files and reports what the program saw.
const writeSkill = `// Write two files.
manifest {
  language: "0.1"
  entry: main
  capabilities: []
  tools: { required: [ { name: "workspace.write", version: ">=1.0.0, <2.0.0" } ] }
}
export async fn main(args: String) returns String effects [tool.workspace.write@1] {
  match await tools.workspace.write.call({ summary: "Update a and b", changes: [{ path: "a.txt", before: "A\\n", after: "A2\\n" }, { path: "b.txt", before: "B\\n", after: "B2\\n" }] }) {
    Ok(result) => if (result.accepted) { \`written: \${to_string(length(result.changed))}\` } else { "declined" }
    Err(_) => "error"
  }
}
`;
// Runs a tool skill to its approval, accepts, and crashes while the write or command is under way (after its intent).
async function crashMidTool(t, dir, { name, source, files, method }) {
  const { store, session, workspace, stateRoot } = await skillSession(t, dir, { name, source, files, providerFactory: () => ({ judge: async () => { throw new Error('no model'); } }) });
  let started;
  const underway = new Promise(resolveStarted => { started = resolveStarted; });
  // The write or command never finishes until the run is cancelled: a crash happens meanwhile.
  session.workspace[method] = (_value, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  store.send(session.data.id, `/${name}`);
  await waitFor(() => settled(session));
  session.answer(session.data.question.id, { accept: true });
  await underway;
  const runId = session.data.runs[0].id;
  const journal = readJournal(journalOf(stateRoot, runId));
  assert.equal(journal.entries.at(-1).type, 'intent', 'the intent is on disk before the change starts');
  await session.persist();
  const crash = resolve(dir, 'crash');
  await cp(stateRoot, crash, { recursive: true });
  await store.close();
  return { session, workspace, crash, intent: journal.entries.at(-1) };
}
async function resumeCrash(t, crash, id) {
  const restarted = await open(t, crash, { providerFactory: () => ({ judge: async () => { throw new Error('no model'); } }) });
  const copy = restarted.get(id);
  await waitFor(() => settled(copy));
  return copy;
}

test('a write cut off after its intent: every file written is answered as accepted, and nothing is written again', async t => {
  const counts = spy(t);
  const dir = await tempDir(t);
  const { session, workspace, crash, intent } = await crashMidTool(t, dir, { name: 'pair', source: writeSkill, files: { 'a.txt': 'A\n', 'b.txt': 'B\n' }, method: 'apply' });
  assert.deepEqual(intent.changes.map(change => change.path), ['a.txt', 'b.txt']);
  // The write had finished when SHOUT died.
  await writeFile(resolve(workspace, 'a.txt'), 'A2\n'); await writeFile(resolve(workspace, 'b.txt'), 'B2\n');
  const applies = counts.apply;
  const copy = await resumeCrash(t, crash, session.data.id);
  assert.deepEqual([copy.data.status, copy.data.messages.at(-1).content], ['completed', 'written: 2']);
  assert.equal(counts.apply, applies, 'not applied again');
  assert.ok(copy.data.events.some(event => event.type === 'tool.completed' && event.reconciled));
});

test('a write cut off after its intent: no file written runs it live, so the approval is asked again', async t => {
  const counts = spy(t);
  const dir = await tempDir(t);
  const { session, workspace, crash } = await crashMidTool(t, dir, { name: 'pair', source: writeSkill, files: { 'a.txt': 'A\n', 'b.txt': 'B\n' }, method: 'apply' });
  const applies = counts.apply;
  const copy = await resumeCrash(t, crash, session.data.id);
  assert.equal(copy.data.question?.kind, 'approval');
  copy.answer(copy.data.question.id, { accept: true }); await copy.task;
  assert.deepEqual([copy.data.status, copy.data.messages.at(-1).content], ['completed', 'written: 2']);
  assert.equal(counts.apply, applies + 1);
  assert.deepEqual([await readFile(resolve(workspace, 'a.txt'), 'utf8'), await readFile(resolve(workspace, 'b.txt'), 'utf8')], ['A2\n', 'B2\n']);
});

test('a write cut off half-way is a declared tool error naming the files, and nothing is rewritten', async t => {
  const counts = spy(t);
  const dir = await tempDir(t);
  const { session, workspace, crash } = await crashMidTool(t, dir, { name: 'pair', source: writeSkill, files: { 'a.txt': 'A\n', 'b.txt': 'B\n' }, method: 'apply' });
  await writeFile(resolve(workspace, 'a.txt'), 'A2\n');
  const applies = counts.apply;
  const copy = await resumeCrash(t, crash, session.data.id);
  assert.deepEqual([copy.data.status, copy.data.messages.at(-1).content], ['completed', 'error'], 'the program got Err');
  const failed = copy.data.events.find(event => event.type === 'tool.failed' && event.reconciled);
  assert.match(failed.error.message, /Written: a\.txt\. Not written: b\.txt\./);
  assert.equal(counts.apply, applies);
  assert.deepEqual([await readFile(resolve(workspace, 'a.txt'), 'utf8'), await readFile(resolve(workspace, 'b.txt'), 'utf8')], ['A2\n', 'B\n']);
});

test('a shell command cut off after its intent is a declared error and does not run again', async t => {
  const counts = spy(t);
  const dir = await tempDir(t);
  const source = `// Run a command.
manifest {
  language: "0.1"
  entry: main
  capabilities: []
  tools: { required: [ { name: "shell.run", version: ">=1.0.0, <2.0.0" } ] }
}
export async fn main(args: String) returns String effects [tool.shell.run@1] {
  match await tools.shell.run.call({ command: "echo ran >> ran.txt", reason: "Record a run" }) {
    Ok(result) => if (result.approved) { "ran" } else { "declined" }
    Err(_) => "error"
  }
}
`;
  const { session, workspace, crash } = await crashMidTool(t, dir, { name: 'once', source, method: 'run' });
  const runs = counts.run;
  const copy = await resumeCrash(t, crash, session.data.id);
  assert.deepEqual([copy.data.status, copy.data.messages.at(-1).content], ['completed', 'error']);
  assert.match(copy.data.events.find(event => event.type === 'tool.failed' && event.reconciled).error.message, /outcome is unknown and it was not run again/);
  assert.equal(counts.run, runs, 'the command did not run again');
  assert.ok(!existsSync(resolve(workspace, 'ran.txt')));
});

test('a replay that diverges, or a changed JOSH build, leaves the run interrupted with the reason', async t => {
  for (const [tamper, reason] of [
    [journal => { journal.entries[0].digest = '0'.repeat(64); }, /^`\/code` interrupted: Could not resume after the restart: at line \d+ the program asked for the tool workspace\.inspect with different input than the recording has\./],
    [journal => { journal.header.artifactDigest = `sha256:${'0'.repeat(64)}`; }, /^`\/code` interrupted: Could not resume after the restart: the program compiles differently now \(the JOSH build changed/],
  ]) {
    const dir = await tempDir(t);
    const { store, session, provider } = await codeAtApproval(t, dir);
    const runId = session.data.runs[0].id;
    await store.suspend();
    const journal = readJournal(journalOf(dir, runId));
    tamper(journal);
    await writeFile(journalOf(dir, runId), [journal.header, ...journal.entries].map(entry => `${JSON.stringify(entry)}\n`).join(''));
    const restarted = await open(t, dir, { providerFactory: provider.factory });
    const copy = restarted.get(session.data.id);
    await copy.task;
    assert.equal(copy.data.status, 'interrupted');
    assert.equal(copy.data.runs[0].state, 'interrupted');
    assert.match(copy.data.messages.at(-1).content, reason);
    assert.ok(!existsSync(journalOf(dir, runId)));
  }
});

test('a parallel await block resumes with one branch at its approval and the other waiting on a judgment', async t => {
  const dir = await tempDir(t);
  const source = `// Two branches at once.
manifest {
  language: "0.1"
  entry: main
  capabilities: [model.request]
  tools: { required: [ { name: "workspace.read", version: ">=1.0.0, <2.0.0" }, { name: "workspace.write", version: ">=1.0.0, <2.0.0" } ] }
}
record Note { text: String }
async fn judge(label: String, data: String) returns String effects [model.request] {
  match await model.request<Note>(prompt { system: label context: { data: data } output: Note }) { Ok(note) => note.text Err(_) => "no judgment" }
}
async fn writer() returns String effects [model.request, tool.workspace.write@1] {
  let text = await judge("left", "start");
  match await tools.workspace.write.call({ summary: "Write left", changes: [{ path: "left.txt", before: "", after: text }] }) {
    Ok(result) => if (result.accepted) { text } else { "declined" }
    Err(_) => "error"
  }
}
async fn reader() returns String effects [model.request, tool.workspace.read@1] {
  let content = match await tools.workspace.read.call({ path: "in.txt" }) { Ok(file) => file.content Err(_) => "" };
  mut out = "";
  for step in 0..3 {
    let text = await judge(\`right \${to_string(step)}\`, \`\${content}\${out}\`);
    out = \`\${out}\${text}\`;
  }
  out
}
export async fn main(args: String) returns String effects [task.spawn, model.request, tool.workspace.read@1, tool.workspace.write@1] {
  await {
    let left = spawn writer();
    let right = spawn reader();
    let a = await left;
    let b = await right;
    \`\${a}|\${b}\`
  }
}
`;
  // Before the restart the right branch's last judgment never answers.
  let hold = true; const calls = [];
  const providerFactory = () => ({ judge: async ({ prompt, signal }) => {
    calls.push(prompt.system);
    if (prompt.system === 'right 2' && hold) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return { text: `${prompt.system.replace(' ', '')};` };
  } });
  const { store, session, workspace, stateRoot } = await skillSession(t, dir, { name: 'both', source, files: { 'in.txt': 'in;' }, providerFactory });
  store.send(session.data.id, '/both');
  await waitFor(() => session.data.question && calls.includes('right 2'));
  assert.deepEqual([...calls].sort(), ['left', 'right 0', 'right 1', 'right 2']);
  await store.suspend();
  hold = false; calls.length = 0;
  const restarted = await open(t, stateRoot, { providerFactory });
  const copy = restarted.get(session.data.id);
  await waitFor(() => copy.data.question);
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, ['right 2'], 'only the judgment that was pending is asked again');
  assert.equal(copy.data.events.find(event => event.type === 'run.resumed').replayed, 4, 'left, the read, right 0 and right 1 came from the journal');
  assert.deepEqual(copy.data.question.prompt.data.value.changes.map(change => [change.path, change.after]), [['left.txt', 'left;']]);
  // Once right 2 is answered live (and journaled after the replayed entries), another restart replays all five.
  await waitFor(() => copy.data.runs[0].counters.modelJudgments === 4);
  await restarted.suspend();
  calls.length = 0;
  const again = await open(t, stateRoot, { providerFactory });
  const third = again.get(session.data.id);
  await waitFor(() => third.data.question);
  assert.deepEqual([calls, third.data.events.findLast(event => event.type === 'run.resumed').replayed, third.data.runs[0].resumes], [[], 5, 2]);
  third.answer(third.data.question.id, { accept: true }); await third.task;
  assert.deepEqual([third.data.status, third.data.messages.at(-1).content], ['completed', 'left;|right0;right1;right2;'], JSON.stringify(third.data.messages.at(-1)));
  assert.equal(await readFile(resolve(workspace, 'left.txt'), 'utf8'), 'left;');
  assert.equal(third.data.runs[0].counters.modelJudgments, 4);
});
test('a run the agent started resumes; its result goes in chat and the agent hears it at the start of its next turn', async t => {
  const dir = await tempDir(t);
  const { store, session, provider } = await codeAtApproval(t, dir, { agent: codeAgent() });
  assert.equal(session.data.runs[0].launch.by, 'agent');
  await store.suspend();
  const agent = new ScriptedAgent(async ({ say }) => say('noted'));
  const restarted = await open(t, dir, { agent, providerFactory: provider.factory });
  const copy = restarted.get(session.data.id);
  await waitFor(() => copy.data.question);
  copy.answer(copy.data.question.id, { accept: true }); await copy.task;
  assert.equal(copy.data.status, 'idle');
  assert.match(copy.data.messages.at(-1).content, /Tests passed/);
  assert.match(copy.data.agentNote, /^\[SHOUT restarted during your previous turn[\s\S]*The \/code skill you started then resumed after the restart and completed[\s\S]*Tests passed/);
  restarted.send(copy.data.id, 'What happened?'); await copy.task;
  assert.equal(agent.turns.length, 1);
  assert.match(agent.turns[0].text, /^\[SHOUT restarted[\s\S]*\]\n\nWhat happened\?$/);
  assert.equal(copy.data.agentNote, undefined, 'the note is given once');
  assert.equal(copy.data.messages.findLast(message => message.role === 'user').content, 'What happened?');
});

test('a run already resumed three times is interrupted instead', async t => {
  const dir = await tempDir(t);
  const { store, session, provider } = await codeAtApproval(t, dir);
  const runId = session.data.runs[0].id;
  await store.suspend();
  const file = resolve(dir, 'sessions', `${session.data.id}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.runs[0].resumes = 3;
  await writeFile(file, JSON.stringify(saved));
  const restarted = await open(t, dir, { providerFactory: provider.factory });
  const copy = restarted.get(session.data.id);
  assert.deepEqual([copy.data.status, copy.data.runs[0].state], ['interrupted', 'interrupted']);
  assert.match(copy.data.messages.at(-1).content, /^Interrupted by restart\. `\/code` was not resumed again: it had already been resumed 3 times\.$/);
  assert.ok(!existsSync(journalOf(dir, runId)));
});

test('a finished run deletes its journal, and deleting a session deletes its run directories', async t => {
  const dir = await tempDir(t);
  const { store, session, provider } = await codeAtApproval(t, dir);
  const runId = session.data.runs[0].id;
  assert.ok(existsSync(journalOf(dir, runId)));
  await store.suspend();
  // Without resuming the run is interrupted, as before, and its journal goes.
  const restarted = await open(t, dir, { providerFactory: provider.factory, resumeRuns: false });
  const copy = restarted.get(session.data.id);
  assert.deepEqual([copy.data.status, copy.data.messages.at(-1).content], ['interrupted', 'Interrupted by restart.']);
  assert.ok(!existsSync(journalOf(dir, runId)));
  await writeFile(resolve(dir, 'runs', runId, 'draft.txt'), 'scratch');
  await restarted.delete(session.data.id);
  assert.ok(!existsSync(resolve(dir, 'runs', runId)));
});

test('a turn with no program running is interrupted by a suspend', async t => {
  const dir = await tempDir(t);
  const agent = new ScriptedAgent(async ({ signal }) => { await new Promise(resolveAbort => signal.addEventListener('abort', resolveAbort, { once: true })); });
  const store = await open(t, dir, { agent });
  const session = await store.create({ workspace: dir });
  store.send(session.data.id, 'Think for a while');
  await waitFor(() => session.data.status === 'thinking');
  await delay(20);
  await store.suspend();
  assert.deepEqual([session.data.status, session.data.messages.at(-1).content], ['interrupted', 'Interrupted by restart.']);
  const restarted = await open(t, dir);
  const copy = restarted.get(session.data.id);
  assert.deepEqual([copy.data.status, copy.data.messages.filter(message => message.content === 'Interrupted by restart.').length], ['interrupted', 1]);
});
