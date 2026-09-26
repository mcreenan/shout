import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace, scenarios, createScenario, fixtureChanges } from '../src/workspace.mjs';

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shout-workspace-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('inspect bounds text access and excludes hidden, dependency, secret, and symlink paths', async t => {
  const base = await temporary(t);
  const directory = path.join(base, 'project');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'app.mjs'), 'export const answer = 42;\n');
  await fs.writeFile(path.join(directory, '.env'), 'DO_NOT_READ=secret');
  await fs.writeFile(path.join(directory, 'credentials.json'), '{"token":"secret"}');
  await fs.writeFile(path.join(base, 'outside.mjs'), 'outside');
  await fs.symlink(path.join(base, 'outside.mjs'), path.join(directory, 'linked.mjs'));
  await fs.symlink(base, path.join(directory, 'linked-dir'));
  await fs.mkdir(path.join(directory, 'node_modules'));
  await fs.writeFile(path.join(directory, 'node_modules', 'dependency.mjs'), 'ignored');
  const workspace = await new Workspace(directory).init();
  assert.deepEqual(await workspace.list(), ['app.mjs']);
  assert.deepEqual((await workspace.inspect()).files, [{ path: 'app.mjs', content: 'export const answer = 42;\n' }]);
  for (const filename of ['../outside.mjs', '/etc/passwd', '.env', 'credentials.json', 'node_modules/dependency.mjs', 'linked.mjs', 'linked-dir/outside.mjs', 'x/../../outside.mjs', 'x\\file.mjs']) {
    await assert.rejects(workspace.read(filename));
    await assert.rejects(workspace.apply([{ path: filename, before: '', after: 'changed' }]));
  }
  assert.equal(await fs.readFile(path.join(base, 'outside.mjs'), 'utf8'), 'outside');
});

test('preflights every edit, rejects stale/duplicate edits, and supports new nested files', async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'a.mjs'), 'original a');
  await fs.writeFile(path.join(directory, 'b.mjs'), 'original b');
  const workspace = await new Workspace(directory).init();
  await assert.rejects(workspace.apply([
    { path: 'a.mjs', before: 'original a', after: 'changed a' },
    { path: 'b.mjs', before: 'stale', after: 'changed b' },
  ]), /Stale patch/);
  assert.equal(await workspace.read('a.mjs'), 'original a');
  await assert.rejects(workspace.apply([
    { path: 'a.mjs', before: 'original a', after: 'x' },
    { path: 'a.mjs', before: 'original a', after: 'y' },
  ]), /Duplicate/);
  assert.deepEqual(await workspace.apply([
    { path: 'a.mjs', before: 'original a', after: 'short' },
    { path: 'src/new.mjs', before: '', after: 'export const added = true;\n' },
  ]), { changed: ['a.mjs', 'src/new.mjs'] });
  assert.equal(await workspace.read('a.mjs'), 'short');
  assert.equal(await workspace.read('src/new.mjs'), 'export const added = true;\n');
  await assert.rejects(workspace.apply([{ path: 'a.mjs', before: 'original a', after: 'stale result' }]), /Stale patch/);
});

test('concurrent patch requests serialize and cannot overwrite a changed precondition', async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'a.mjs'), 'original');
  const workspace = await new Workspace(directory).init();
  const results = await Promise.allSettled([
    workspace.apply([{ path: 'a.mjs', before: 'original', after: 'first' }]),
    workspace.apply([{ path: 'a.mjs', before: 'original', after: 'second' }]),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(await workspace.read('a.mjs'), 'first');
});

test('rejects oversized, binary, invalid UTF-8 files and oversized patches', async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'large.mjs'), 'a'.repeat(65 * 1024));
  await fs.writeFile(path.join(directory, 'binary.mjs'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(directory, 'invalid.mjs'), Buffer.from([0xff]));
  const workspace = await new Workspace(directory).init();
  for (const filename of ['large.mjs', 'binary.mjs', 'invalid.mjs']) await assert.rejects(workspace.read(filename));
  await assert.rejects(workspace.apply([{ path: 'new.mjs', before: '', after: 'a'.repeat(65 * 1024) }]), /bounded text/);
  await assert.rejects(workspace.apply([{ path: 'new.mjs', before: '', after: 'hello\0world' }]), /bounded text/);
});

for (const scenario of scenarios) {
  test(`${scenario.id}: isolated real project fails initially, scripted patch makes tests pass`, async t => {
    const base = await temporary(t);
    const config = await createScenario(scenario.id, base);
    const workspace = await new Workspace(config.workspace, config).init();
    const initial = await workspace.test();
    assert.equal(initial.passed, false, initial.output);
    assert.match(initial.output, /fail [1-9]/);
    const before = await workspace.inspect();
    assert.equal(before.files.some(file => file.path.includes('solution')), false);
    const changes = await fixtureChanges(scenario.id, before.files);
    await workspace.apply(changes);
    const result = await workspace.test();
    assert.equal(result.passed, true, result.output);
    assert.match(result.output, /fail 0/);
    const second = await createScenario(scenario.id, base);
    assert.notEqual(second.workspace, config.workspace);
    assert.equal((await new Workspace(second.workspace, second).test()).passed, false);
  });
}

test('unconfigured verification is explicitly skipped and never reported passing', async t => {
  const workspace = await new Workspace(await temporary(t)).init();
  const result = await workspace.test();
  assert.equal(result.skipped, true);
  assert.equal(result.passed, false);
});

test('test command cancellation terminates its process group and records cancellation', async t => {
  const directory = await temporary(t);
  const workspace = await new Workspace(directory, { testCommand: "node -e 'console.log(\"ready\");setInterval(() => {}, 1000)'" }).init();
  const controller = new AbortController();
  const running = workspace.test({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 150);
  t.after(() => clearTimeout(timer));
  const result = await running;
  assert.equal(result.passed, false);
  assert.equal(result.stopped, 'cancelled');
  assert.match(result.output, /test command cancelled/);
});

test('test command timeout and output limits are enforced', async t => {
  const directory = await temporary(t);
  const timeout = await new Workspace(directory, { testCommand: "node -e 'setInterval(() => {}, 1000)'", testTimeoutMs: 100 }).test();
  assert.equal(timeout.passed, false);
  assert.equal(timeout.stopped, 'timeout');
  const noisy = await new Workspace(directory, { testCommand: "node -e 'setInterval(() => console.log(\"x\".repeat(1000)), 1)'", maxOutputBytes: 1024 }).test();
  assert.equal(noisy.passed, false);
  assert.equal(noisy.stopped, 'output limit exceeded');
  assert.ok(noisy.output.length < 1200);
});

test('already-cancelled patches never mutate files', async t => {
  const directory = await temporary(t);
  const workspace = await new Workspace(directory).init();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.apply([{ path: 'new.mjs', before: '', after: 'change' }], { signal: controller.signal }));
  assert.deepEqual(await fs.readdir(directory), []);
});
