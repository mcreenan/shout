// Typed-response retries end to end: a skill's model.request gets an invalid answer, JOSH re-asks
// with its validation issues, and the session's recorded events carry the retry for the UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';

const skill = `// Rate the request.
manifest { language: "0.1" entry: main capabilities: [model.request] }
enum Level { Low High }
record Rating { level: Level score: Float note: Option<String> }
export async fn main(args: String) returns String effects [model.request] {
  match await model.request<Rating>(prompt { system: "Rate it" context: args output: Rating policy: { max_attempts: 2 } }) {
    Ok(rating) => match rating.level { Level.Low => "low" Level.High => \`high \${to_string(rating.score)}\` }
    Err(error) => error.code
  }
}
`;

test('a rejected model answer is re-asked and the retry is visible in the session events', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-retries-'));
  const workspace = join(dir, 'project');
  await mkdir(join(workspace, '.shout', 'skills'), { recursive: true });
  await writeFile(join(workspace, '.shout', 'skills', 'rate.allen'), skill);
  const previousHome = process.env.SHOUT_HOME;
  process.env.SHOUT_HOME = join(dir, 'home');
  const calls = [];
  const answers = [{ level: 'Medium', score: 2, note: { tag: 'None' } }, { level: 'High', score: 2, note: { tag: 'Some', value: 'ok' } }];
  const provider = { judge: async args => { calls.push(args); return answers[calls.length - 1]; } };
  const store = await new SessionStore({ stateRoot: join(dir, 'state'), providerFactory: () => provider }).init();
  const session = await store.create({ workspace });
  t.after(async () => {
    await store.close();
    if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  });
  store.send(session.data.id, '/rate a request'); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'high 2.0');
  assert.equal(calls.length, 2);
  const events = session.data.events;
  const started = events.filter(event => event.type === 'model.started');
  assert.deepEqual(started.map(event => [event.attempt, event.issues]), [[1, undefined], [2, [{ path: '/level', code: 'tag' }]]]);
  assert.equal(started[0].interaction, started[1].interaction);
  const rejected = events.find(event => event.type === 'model.rejected');
  // The session renames the kernel's effect id to effectId, as for every run event.
  assert.deepEqual([rejected.effectId, rejected.interaction, rejected.attempt, rejected.issues],
    [started[0].effectId, started[0].interaction, 1, [{ path: '/level', code: 'tag' }]]);
  assert.deepEqual(events.filter(event => event.type === 'effect.requested').map(event => event.attempt), [1, 2]);
  assert.match(calls[1].prompt.system, /- \/level: unknown variant tag/);
});
