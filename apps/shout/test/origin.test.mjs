// Effect origins end to end: the real /todo skill runs on the real JOSH VM, and every recorded
// provider request names its source line, the loop iteration it ran in and the call that led to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '../src/session.mjs';

test('/todo searches carry their loop iteration, call frame and source lines', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-origin-'));
  const workspace = join(dir, 'project');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'notes.mjs'), '// TODO first\nexport const x = 1; // FIXME second\n');
  const previousHome = process.env.SHOUT_HOME;
  process.env.SHOUT_HOME = join(dir, 'home');
  const store = await new SessionStore({ stateRoot: join(dir, 'state') }).init();
  const session = await store.create({ workspace });
  t.after(async () => {
    await store.close();
    if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  });

  store.send(session.data.id, '/todo'); await session.task;
  assert.equal(session.data.runs.at(-1).state, 'completed', session.data.messages.at(-1)?.content);

  const source = await readFile(new URL('../skills/todo.allen', import.meta.url), 'utf8');
  const lineOf = text => source.split('\n').findIndex(line => line.includes(text)) + 1;
  const loaded = session.data.events.find(event => event.type === 'program.loaded');
  const loop = loaded.constructs.find(construct => construct.kind === 'for' && construct.line === lineOf('for marker in markers'));
  assert.ok(loop, 'the marker loop is in the static construct table');
  assert.equal(loop.function, 'src/main.allen::main');

  const searches = session.data.events.filter(event => event.type === 'tool.started' && event.tool === 'workspace.search');
  assert.deepEqual(searches.map(event => event.input.query), ['TODO', 'FIXME', 'HACK']);
  for (const [index, { origin }] of searches.entries()) {
    assert.equal(origin.task, 0);
    assert.deepEqual([origin.site.function, origin.site.source, origin.site.line],
      ['src/main.allen::search', 'src/main.allen', lineOf('match await tools.workspace.search.call')]);
    assert.equal(loaded.sites[origin.site.id].operation, 'tools.workspace.search.call');
    assert.deepEqual(origin.scope.map(entry => entry.kind), ['for', 'call']);
    const [marker, call] = origin.scope;
    assert.deepEqual([marker.construct, marker.line, marker.region, marker.instance, marker.iteration], [loop.id, loop.line, 'body', 1, index + 1]);
    assert.deepEqual([call.function, call.line], ['src/main.allen::search', lineOf('let found = await search(marker)')]);
  }
  // effect.requested carries the same origin as the tool step it starts.
  const requested = session.data.events.filter(event => event.type === 'effect.requested');
  assert.deepEqual(requested.map(event => event.origin.scope[0].iteration), [1, 2, 3]);
});
