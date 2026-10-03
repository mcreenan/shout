import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';
import { ScriptedAgent } from './doubles.mjs';

// Line 3 divides by the length of the arguments, so `/divide` with none traps there.
const divide = `manifest { language: "0.1" entry: main capabilities: [] }
export fn main(args: String) returns Int {
  10 / length(args)
}
`;
// Twenty judgments in a loop: the seventeenth exhausts the run's budget of sixteen at line 5.
const judge = `manifest { language: "0.1" entry: main capabilities: [model.request] }
record Answer { answer: Bool }
export async fn main(args: String) returns String effects [model.request] {
  for attempt in 0..20 {
    let answer = match await model.request<Answer>(prompt { system: "Judge" output: Answer }) { Ok(v) => v.answer Err(_) => false };
  }
  "done"
}
`;

async function setup(t, { agent = new ScriptedAgent(), skills = {} } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-error-position-'));
  const workspace = resolve(dir, 'project');
  await mkdir(resolve(workspace, '.shout', 'skills'), { recursive: true });
  for (const [name, source] of Object.entries(skills)) await writeFile(resolve(workspace, '.shout', 'skills', `${name}.allen`), source);
  const previousHome = process.env.SHOUT_HOME; process.env.SHOUT_HOME = resolve(dir, 'home');
  const provider = { judge: async () => ({ answer: true }) };
  const store = await new SessionStore({ stateRoot: resolve(dir, 'state'), agent, providerFactory: () => provider }).init();
  t.after(async () => { await store.close(); if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome; await rm(dir, { recursive: true, force: true }); });
  return { store, session: await store.create({ workspace }) };
}

test('a runtime trap records the failing line and the message links to it', async t => {
  const { store, session } = await setup(t, { skills: { divide } });
  store.send(session.data.id, '/divide'); await session.task;
  const run = session.data.runs.at(-1);
  assert.equal(run.state, 'failed');
  assert.deepEqual(run.failedAt, { line: 3, column: 3, end_line: 3, end_column: run.failedAt.end_column });
  const message = session.data.messages.at(-1);
  assert.match(message.content, /^`\/divide` failed at line 3: division by zero$/);
  assert.deepEqual(message.failure, { run: run.id, line: 3 });
});

test('an exhausted judgment budget reports the model.request line', async t => {
  const { store, session } = await setup(t, { skills: { judge } });
  store.send(session.data.id, '/judge'); await session.task;
  const run = session.data.runs.at(-1);
  assert.deepEqual([run.state, run.failedAt?.line, run.result.span.source], ['failed', 5, 'src/main.allen']);
  assert.match(session.data.messages.at(-1).content, /failed at line 5: Model judgment budget exhausted/);
  assert.equal(session.data.messages.at(-1).failure.line, 5);
});

test('a program the agent wrote fails back to the agent with its failing line quoted', async t => {
  // An empty args field gives the program the user's message, so this one divides by zero whatever it gets.
  const program = divide.replace('10 / length(args)', '10 / (length(args) - length(args))');
  const errors = [];
  const agent = new ScriptedAgent(async ({ call, say }) => {
    await call('run_program', { program, args: '' }).catch(error => errors.push(error.message));
    say('Done.');
  });
  const { store, session } = await setup(t, { agent });
  store.send(session.data.id, 'divide something'); await session.task;
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'The program failed at line 3: division by zero\n  10 / (length(args) - length(args))');
  assert.equal(session.data.runs.at(-1).failedAt.line, 3);
});

test('a stopped run has no position', async t => {
  const stops = `manifest { language: "0.1" entry: main capabilities: [] }
export fn main(args: String) returns String {
  stop("enough")
}
`;
  const { store, session } = await setup(t, { skills: { stops } });
  store.send(session.data.id, '/stops'); await session.task;
  const run = session.data.runs.at(-1);
  assert.deepEqual([run.state, 'failedAt' in run, 'failure' in session.data.messages.at(-1)], ['stopped', false, false]);
});
