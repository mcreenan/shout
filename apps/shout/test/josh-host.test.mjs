// JoshHost: one checker connection for program/check and a pool of run connections, reused after a clean finish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { JoshHost } from '../src/josh-host.mjs';
import { SkillRegistry } from '../src/skills.mjs';
import { shoutTools } from '../src/tools.mjs';
import { Run } from '../../../prototypes/owned/src/kernel.mjs';

const constant = value => `manifest { language: "0.1" entry: main capabilities: [] }
export fn main() returns Int { ${value} }
`;
const ask = `manifest { language: "0.1" entry: main capabilities: [user.ask] }
export async fn main() returns Bool effects [user.ask] {
  match await user.ask<Bool>(prompt { system: "Continue?" output: Bool }) { Ok(v) => v Err(_) => false }
}
`;

async function setup(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-josh-host-'));
  const logged = [];
  const josh = new JoshHost({ tools: shoutTools, log: message => logged.push(message) });
  t.after(async () => { josh.close(); await rm(dir, { recursive: true, force: true }); });
  const start = source => {
    const run = new Run({ provider: { judge: async () => { throw new Error('no model'); } }, source, input: null, scratchRoot: dir,
      tools: shoutTools, toolHandler: async () => { throw new Error('no tools'); }, connection: () => josh.acquire() });
    void run.start();
    return run;
  };
  return { dir, josh, logged, start };
}
const question = run => new Promise(resolveQuestion => run.on('event', event => { if (event.type === 'user.question') resolveQuestion(event); }));
// Records the requests SHOUT sends on a connection.
const methods = connection => {
  const sent = []; const request = connection.transport.request.bind(connection.transport);
  connection.transport.request = (method, params) => { sent.push(method); return request(method, params); };
  return sent;
};

test('a warm server runs without starting a process, and a repeated program reuses the process and its loaded program', async t => {
  const { josh, start } = await setup(t);
  assert.equal((await josh.check(constant(1))).ok, true);
  // The first check also opened a run connection.
  assert.equal(josh.idle.length, 1);
  const warm = josh.idle[0];
  const first = start(constant(7));
  assert.equal((await first.done).state, 'completed');
  assert.equal(first.connection, warm);
  const sent = methods(warm);
  const second = start(constant(7));
  const outcome = await second.done;
  assert.equal(outcome.state, 'completed'); assert.equal(outcome.result.output, 7);
  assert.equal(second.connection, warm); assert.equal(second.connection.pid, first.connection.pid);
  assert.deepEqual(sent, ['execution/start']);
  assert.equal(warm.programs, 1); assert.equal(warm.executions, 2);
  assert.deepEqual(josh.idle, [warm]);
});

test('a cancelled run retires its connection, and the next run gets a new process', async t => {
  const { josh, start } = await setup(t);
  const run = start(ask);
  await question(run);
  const { connection } = run; const { pid } = connection;
  run.cancel();
  assert.equal((await run.done).state, 'cancelled');
  assert.equal(connection.closed, true); assert.equal(josh.pool.has(connection), false);
  await connection.exited;
  const next = start(constant(1));
  assert.equal((await next.done).state, 'completed');
  assert.notEqual(next.connection.pid, pid);
});

test('two runs at once get two connections, and both go back to the pool', async t => {
  const { josh, start } = await setup(t);
  const one = start(ask); const two = start(ask);
  const [first, second] = await Promise.all([question(one), question(two)]);
  assert.notEqual(one.connection, two.connection); assert.notEqual(one.connection.pid, two.connection.pid);
  one.answer(first.id, true); two.answer(second.id, false);
  assert.equal((await one.done).result.output, true); assert.equal((await two.done).result.output, false);
  assert.equal(josh.idle.length, 2); assert.equal(josh.pool.size, 2);
});

test('a checker that dies mid-check yields a diagnostic, and the next check runs on a new process', async t => {
  const { dir, josh } = await setup(t);
  const registry = new SkillRegistry({ josh });
  const path = resolve(dir, 'broken.allen'); await writeFile(path, constant(2));
  assert.equal((await josh.check(constant(1))).ok, true);
  const { checker } = josh; const { pid } = checker;
  const check = checker.check.bind(checker);
  checker.check = source => { const pending = check(source); checker.transport.child.kill('SIGKILL'); return pending; };
  const skill = await registry.load({ name: 'broken', scope: 'workspace', path });
  assert.equal(skill.ok, false); assert.equal(skill.diagnostics[0].code, 'SHOUT005');
  const again = await registry.load({ name: 'broken', scope: 'workspace', path });
  assert.equal(again.ok, true);
  assert.notEqual(josh.checker.pid, pid);
});

test('a source without a manifest is SHOUT001, and a tool missing from the catalog says where to add it', async t => {
  const { josh } = await setup(t);
  const loose = await josh.check('// No manifest.\nexport fn main() returns Int { 1 }\n');
  assert.equal(loose.ok, false); assert.equal(loose.diagnostics[0].code, 'SHOUT001');
  const undeclared = await josh.check(`manifest { language: "0.1" entry: main capabilities: [] }
export async fn main() returns String effects [tool.workspace.read@1] {
  match await tools.workspace.read.call({ path: "a" }) { Ok(file) => file.content Err(_) => "" }
}
`);
  assert.equal(undeclared.ok, false); assert.match(undeclared.diagnostics[0].message, /not in the frozen catalog\. Add the tool to the manifest tools\.required list/);
  // Declared capabilities are reported as the manifest spells them, used or not.
  const declared = await josh.check('manifest { language: "0.1" entry: main capabilities: [user.ask, model.request] }\nexport fn main() returns Int { 1 }\n');
  assert.deepEqual(declared.capabilities, ['model.request', 'user.ask']);
  assert.deepEqual(declared.entry, { name: 'main', input: { type: 'void' }, output: { type: 'int' }, effects: [] });
});

test('a connection is retired after 31 loaded programs', async t => {
  const { start } = await setup(t);
  let connection;
  for (let value = 1; value <= 31; value++) {
    const run = start(constant(value));
    assert.equal((await run.done).state, 'completed');
    connection ??= run.connection;
    assert.equal(run.connection, connection);
  }
  assert.equal(connection.programs, 31); assert.equal(connection.closed, true);
  const next = start(constant(32));
  assert.equal((await next.done).state, 'completed');
  assert.notEqual(next.connection, connection);
});

test('frames for another execution are dropped and logged', async t => {
  const { logged, start } = await setup(t);
  const run = start(ask);
  const asked = await question(run);
  const frame = message => {
    const body = Buffer.from(JSON.stringify({ protocol: 'josh/1', ...message }));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/josh+json; charset=utf-8\r\n\r\n`), body]);
  };
  const { stdout } = run.connection.transport.child;
  stdout.emit('data', frame({ kind: 'request', id: 'runtime-stray', method: 'user/ask', params: { execution_id: 'run-other' } }));
  stdout.emit('data', frame({ kind: 'notification', method: 'execution/event', params: { execution_id: 'run-other' } }));
  assert.equal(logged.length, 2);
  assert.match(logged[0], /dropped a request user\/ask for run-other while attached to run-/);
  assert.equal(run.effects.size, 1);
  run.answer(asked.id, true);
  assert.equal((await run.done).state, 'completed');
});

test('closing the host interrupts an attached run and ends every process', async t => {
  const { josh, start } = await setup(t);
  await josh.check(constant(1));
  const run = start(ask);
  await question(run);
  const connections = [josh.checker, ...josh.pool];
  josh.close();
  assert.equal((await run.done).state, 'interrupted');
  await Promise.all(connections.map(connection => connection.exited));
  for (const connection of connections) assert.notEqual(connection.transport.child.exitCode ?? connection.transport.child.signalCode, null);
  await assert.rejects(josh.acquire(), /closed/);
});
