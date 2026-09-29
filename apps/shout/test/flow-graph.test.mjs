import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFlow } from '../public/flow.js';
import { scopeTree, phases, leaves } from '../public/flow-graph.js';

const T0 = Date.UTC(2026, 0, 1);
const NOW = T0 + 3_600_000;
function script() {
  let sequence = 0;
  let clock = 0;
  let effect = 0;
  const events = [];
  const emit = (type, fields = {}) => { const event = { id: `e${++sequence}`, sequence, time: new Date(T0 + clock).toISOString(), type, ...fields }; events.push(event); return event; };
  const api = {
    events,
    wait(ms) { clock += ms; return api; },
    run(run, fields = {}) { emit('run.started', { run }); emit('program.loaded', { run, ...fields }); return api; },
    end(run, state = 'completed') { clock += 5; emit('run.terminal', { run, state }); return api; },
    // One effect: a tool (or `model`) call. `open` leaves it running.
    call(run, tool, { origin, input = {}, value = {}, failed, ms = 10, open = false } = {}) {
      const effectId = `r-${++effect}`;
      clock += 2;
      emit('effect.requested', { run, effectId, ...(origin && { origin }) });
      if (tool === 'model') emit('model.started', { run, effectId, prompt: { system: 'You are a reviewer. Review it.' }, ...(origin && { origin }) });
      else emit('tool.started', { run, effectId, tool, input, ...(origin && { origin }) });
      if (open) return api;
      clock += ms;
      if (failed) emit(tool === 'model' ? 'model.failed' : 'tool.failed', { run, effectId, error: { message: failed } });
      else emit(tool === 'model' ? 'model.completed' : 'tool.completed', { run, effectId, value });
      emit('effect.resolved', { run, effectId });
      return api;
    },
    approval(run, { answer = true } = {}) {
      const effectId = `approval-${++effect}`;
      clock += 2;
      emit('user.question', { run, effectId, host: true, title: 'Apply 1 file change?' });
      clock += 400;
      emit('user.answered', { run, effectId, origin: 'user', value: { accept: answer } });
      return api;
    },
    emit,
  };
  return api;
}
const loop = (iteration, { construct = 1, instance = 1, line = 4 } = {}) => ({ kind: 'for', construct, line, column: 3, instance, iteration });
const at = (scope, task = 0, line = 9) => ({ task, site: { function: 'main.allen::main', line, column: 5 }, scope });
const session = (runs, messages = []) => ({ id: 's', messages, runs });
const source = 'fn main() {\n  mut n = 0;\n  let x = 1;\n  for attempt in 0..3 {\n    for path in paths {\n      let r = ask(attempt);\n    }\n    if (r) {\n      done()\n    } else {\n      retry()\n    }\n  }\n}';
const graph = (s, runs = [{ id: 'run', source }], options = {}) => phases({ session: session(runs, options.messages), events: s.events, now: NOW, live: options.live ?? false, ui: options.ui });
const shape = (items) => items.map((item) => (item.type === 'step' ? item.step.label : item.type === 'loop' ? { loop: item.key, iterations: item.iterations.map((iteration) => shape(iteration.items)) } : { tracks: item.tracks.map((track) => [track.task, shape(track.items)]) }));
const stepsOf = (s) => buildFlow(s.events).find((segment) => segment.run).steps.filter((step) => step.pair && step.pair !== 'effect');

test('nested loops nest, and each entry into the inner loop is its own instance', () => {
  const s = script().run('run');
  for (const outer of [1, 2]) for (const inner of [1, 2]) s.call('run', 'git.run', { origin: at([loop(outer), loop(inner, { construct: 2, instance: outer, line: 5 })]) });
  const tree = scopeTree(stepsOf(s));
  assert.deepEqual(shape(tree), [{ loop: '/for1#1', iterations: [
    [{ loop: '/for1#1.1/for2#1', iterations: [['git.run'], ['git.run']] }],
    [{ loop: '/for1#1.2/for2#2', iterations: [['git.run'], ['git.run']] }],
  ] }]);
  assert.equal(leaves(tree).length, 4);
});

test('a loop of single steps is a stack; a loop of several steps is a group of tiles', () => {
  const s = script().run('run');
  for (let i = 1; i <= 40; i++) s.call('run', 'git.run', { origin: at([loop(i)]), input: { args: ['diff', `f${i}`] }, value: { exit_code: i === 17 ? 128 : 0 } });
  for (let i = 1; i <= 3; i++) { s.call('run', 'workspace.read', { origin: at([loop(i, { construct: 5, line: 5 })]) }); s.call('run', 'model', { origin: at([loop(i, { construct: 5, line: 5 })]) }); }
  s.end('run');
  const g = graph(s);
  const [stack, group] = g.nodes;
  assert.deepEqual([stack.type, stack.title, stack.steps.length, stack.failed, stack.ended, stack.open], ['stack', 'git.run', 40, 1, true, false]);
  assert.deepEqual([group.type, group.title, group.iterations.length, group.open, group.ended], ['group', 'for path in paths', 3, null, true]);
  assert.deepEqual(group.iterations[0].pips, ['t', 'm']);
  assert.equal(group.iterations[0].activity, 'Model');
  assert.equal(g.frames.length, 1, 'only the run frame while the group is closed');
  assert.equal(g.index.get(stack.steps[3].id).node, stack.id, 'hidden steps map to the card that shows them');
  // Opening an iteration frames the group card with that iteration's cards.
  const open = graph(s, undefined, { ui: { open: new Map([[group.id, 2]]), stacks: new Set([stack.id]) } });
  const frame = open.frames.find((candidate) => candidate.kind === 'group');
  assert.equal(open.nodes.find((node) => node.id === stack.id).open, true);
  assert.deepEqual(frame.members.map((id) => open.nodes.find((node) => node.id === id).type), ['group', 'tool', 'hub']);
  assert.equal(open.index.get(frame.members[1]).node, frame.members[1]);
  const rows = open.rows.filter((row) => row.open.includes(frame.key) || row.close.includes(frame.key));
  assert.deepEqual(rows.map((row) => row.kind), ['group', 'step'], 'the frame opens at the group row and closes after the iteration');
});

test('a live group opens its running iteration until you choose otherwise', () => {
  const s = script().run('run');
  for (let i = 1; i <= 2; i++) { s.call('run', 'workspace.read', { origin: at([loop(i)]) }); s.call('run', 'tests.run', { origin: at([loop(i)]), value: { passed: false } }); }
  s.call('run', 'workspace.read', { origin: at([loop(3)]) }).call('run', 'model', { origin: at([loop(3)]), open: true });
  const live = graph(s, undefined, { live: true });
  const group = live.nodes.find((node) => node.type === 'group');
  assert.deepEqual([group.open, group.ended, group.status, group.failed], [3, false, 'active', 2]);
  assert.deepEqual(group.iterations.map((iteration) => iteration.status), ['failed', 'failed', 'active']);
  assert.equal(live.focus, live.nodes.find((node) => node.step?.pair === 'model').id, 'the running card is followed');
  const closed = graph(s, undefined, { live: true, ui: { open: new Map([[group.id, null]]) } });
  assert.equal(closed.nodes.find((node) => node.type === 'group').open, null);
  assert.equal(closed.focus, group.id, 'a closed group stands in for its running step');
});

test('a loop that ran once reads as its framed body', () => {
  const s = script().run('run');
  s.call('run', 'workspace.read', { origin: at([loop(1)]) }).call('run', 'model', { origin: at([loop(1)]) }).call('run', 'tests.run', { origin: at([loop(1)]) }).end('run');
  const g = graph(s);
  assert.deepEqual(g.nodes.map((node) => node.type), ['tool', 'hub', 'tool']);
  const frame = g.frames.find((candidate) => candidate.kind === 'loop');
  assert.deepEqual([frame.label, frame.count, frame.ended, frame.members.length], ['for attempt in 0..3', 1, true, 3]);
  assert.equal(g.frames.find((candidate) => candidate.kind === 'run').below, 1, 'the run frame pads around the loop frame inside it');
});

test('branches taken become chips on the first card inside them', () => {
  const branch = (taken) => ({ kind: 'if', construct: 7, line: 8, column: 5, branch: taken });
  const s = script().run('run');
  for (let i = 1; i <= 2; i++) {
    s.call('run', 'workspace.read', { origin: at([loop(i), branch('else')]) });
    s.call('run', 'workspace.edit', { origin: at([loop(i), branch('else')]) });
    s.call('run', 'tests.run', { origin: at([loop(i)]) });
  }
  const tree = scopeTree(stepsOf(s));
  const chips = tree[0].iterations.map((iteration) => iteration.items.map((item) => item.chip?.branch ?? null));
  assert.deepEqual(chips, [['else', null, null], ['else', null, null]], 'each iteration enters the branch anew');
  const g = graph(s, undefined, { ui: { open: new Map([['run/for1#1', 1]]) } });
  const chip = g.nodes.find((node) => node.chip);
  assert.deepEqual(chip.chip, { label: 'else', title: 'if (r) {', line: 8 });
});

// JOSH marks another task's effects with a `spawn` entry: the spawner's scope, the spawn, then the task's own.
const parallelSource = 'fn main() {\n  await {\n    let a = spawn summarize("src/importer.mjs");\n    let b = spawn summarize("src/csv.mjs");\n    let c = spawn summarize("src/ledger.mjs");\n  }\n}';
const spawnEnd = (line) => (parallelSource.split('\n')[line - 1] || '').indexOf(';') + 1;
const spawn = (task, line, fn = 'summarize') => ({ kind: 'spawn', task, function: `src/main.allen::${fn}`, instruction: 3, line, column: 13, end_line: line, end_column: spawnEnd(line) });
const spawnedAt = (scope, task) => ({ task, parent_task: 0, site: { function: 'src/main.allen::summarize', line: 4, column: 5 }, scope });

test('tasks spawned in one await block become parallel tracks; the block owner has its own track', () => {
  const block = { kind: 'await_block', construct: 3, line: 2, column: 3, region: 'body' };
  const s = script().run('run');
  for (const task of [1, 2, 3]) s.call('run', 'workspace.read', { origin: spawnedAt([block, spawn(task, task + 2)], task) });
  s.call('run', 'workspace.list', { origin: at([block]) });
  for (const task of [2, 1, 3]) s.call('run', 'model', { origin: spawnedAt([block, spawn(task, task + 2)], task) });
  const tree = scopeTree(stepsOf(s));
  assert.deepEqual(shape(tree), [{ tracks: [[1, ['workspace.read', 'Model']], [2, ['workspace.read', 'Model']], [3, ['workspace.read', 'Model']], [0, ['workspace.list']]] }]);
  const g = graph(s, [{ id: 'run', source: parallelSource }]);
  assert.deepEqual(g.rows.map((row) => [row.kind, row.ids.length]), [['tracks', 4]]);
  assert.deepEqual(g.nodes.map((node) => node.title), ['summarize("src/importer.mjs")', 'summarize("src/csv.mjs")', 'summarize("src/ledger.mjs")', 'main'], 'same-named tracks read as their spawn');
  const lone = script().run('run');
  lone.call('run', 'workspace.read', { origin: spawnedAt([block, spawn(1, 3)], 1) }).call('run', 'model', { origin: spawnedAt([block, spawn(1, 3)], 1) });
  assert.deepEqual(shape(scopeTree(stepsOf(lone))), ['workspace.read', 'Model'], 'one task is not parallel');
});

test('a task spawned outside an await block runs beside its spawner while it lasts; nested spawns nest', () => {
  const s = script().run('run');
  s.call('run', 'workspace.list', { origin: at([]) });
  s.call('run', 'workspace.read', { origin: spawnedAt([spawn(4, 3, 'count')], 4), open: true });
  s.call('run', 'git.run', { origin: at([{ kind: 'call', function: 'src/main.allen::count', line: 4, column: 3 }]) });
  s.wait(30).emit('tool.completed', { run: 'run', effectId: 'r-2' }); s.emit('effect.resolved', { run: 'run', effectId: 'r-2' });
  s.call('run', 'tests.run', { origin: at([]) });
  assert.deepEqual(shape(scopeTree(stepsOf(s))), ['workspace.list', { tracks: [[4, ['workspace.read']], [0, ['git.run']]] }, 'tests.run']);
  // A spawned task that spawns again, outside any block, gets its own block inside its track.
  const block = { kind: 'await_block', construct: 3, line: 2, column: 3 };
  const nested = script().run('run');
  nested.call('run', 'workspace.read', { origin: spawnedAt([block, spawn(1, 3)], 1) });
  nested.call('run', 'workspace.read', { origin: spawnedAt([block, spawn(1, 3), spawn(5, 9, 'deep')], 5), open: true });
  nested.call('run', 'model', { origin: spawnedAt([block, spawn(1, 3)], 1) });
  nested.wait(30).emit('tool.completed', { run: 'run', effectId: 'r-2' }); nested.emit('effect.resolved', { run: 'run', effectId: 'r-2' });
  nested.call('run', 'workspace.read', { origin: spawnedAt([block, spawn(2, 4)], 2) });
  const [top] = scopeTree(stepsOf(nested));
  assert.deepEqual(top.tracks.map((track) => track.task), [1, 2]);
  assert.deepEqual(shape(top.tracks[0].items), ['workspace.read', { tracks: [[5, ['workspace.read']], [1, ['Model']]] }]);
});

test('a construct compiled twice (an or-pattern arm) groups by its span, not its id', () => {
  const twin = (construct, iteration) => ({ kind: 'for', construct, start: 100, end: 180, line: 4, column: 3, instance: 1, iteration });
  const s = script().run('run');
  s.call('run', 'git.run', { origin: at([twin(7, 1)]) }).call('run', 'git.run', { origin: at([twin(9, 2)]) });
  assert.deepEqual(shape(scopeTree(stepsOf(s))), [{ loop: '/for100-180#1', iterations: [['git.run'], ['git.run']] }]);
});

test('without control-flow data, reads share a row; with it, sequential steps never fan out', () => {
  const plain = script().run('run');
  for (const query of ['TODO', 'FIXME', 'HACK']) plain.call('run', 'workspace.search', { input: { query } });
  plain.end('run');
  assert.deepEqual(graph(plain).rows.map((row) => [row.kind, row.ids.length]), [['context', 3]]);
  const traced = script().run('run');
  ['TODO', 'FIXME', 'HACK'].forEach((query, i) => traced.call('run', 'workspace.search', { input: { query }, origin: at([loop(i + 1)]) }));
  traced.call('run', 'workspace.list', { origin: at([]) }).call('run', 'workspace.read', { origin: at([]) });
  traced.end('run');
  assert.deepEqual(graph(traced).rows.map((row) => [row.kind, row.ids.length]), [['stack', 1], ['step', 1], ['step', 1]]);
});

test('steps without an origin stay where the step before them was', () => {
  const s = script().run('run');
  for (let i = 1; i <= 2; i++) s.call('run', 'workspace.edit', { origin: at([loop(i)]) }).approval('run').call('run', 'tests.run', { origin: at([loop(i)]) });
  assert.deepEqual(shape(scopeTree(stepsOf(s))), [{ loop: '/for1#1', iterations: [['workspace.edit', 'Approval', 'tests.run'], ['workspace.edit', 'Approval', 'tests.run']] }]);
});

test('the canvas shows calls and replies, not bookkeeping', () => {
  const s = script();
  s.emit('chat.started', { label: 'Start the agent thread' }); s.emit('chat.completed', { thread: 't-1' });
  s.emit('chat.started', { label: 'SHOUT agent' }); s.wait(20); s.emit('chat.completed', { tool: 'run_skill' });
  s.run('run').call('run', 'workspace.edit').approval('run');
  s.emit('workspace.changed', { run: 'run', changed: ['a.mjs'] });
  s.emit('session.time_budgets', { run: 'run' });
  s.emit('session.error', { run: 'run', message: 'Boom' });
  s.end('run', 'failed');
  const answered = s.events.find((event) => event.type === 'user.answered');
  const messages = [
    { id: 'm1', role: 'user', content: 'Change it', time: new Date(T0).toISOString() },
    { id: 'm2', role: 'user', content: 'Apply these changes.', time: answered.time },
    { id: 'm2b', role: 'user', content: 'Approved: npm test', time: new Date(T0 + 50_000).toISOString(), echo: { kind: 'approval', accept: true, command: 'npm test', origin: 'user' } },
    { id: 'm3', role: 'assistant', content: 'Done.', time: new Date(T0 + 60_000).toISOString() },
    { id: 'm4', role: 'system', content: 'Interrupted', time: new Date(T0 + 70_000).toISOString() },
  ];
  const g = graph(s, [{ id: 'run', skill: 'code', source }], { messages });
  assert.deepEqual(g.nodes.map((node) => node.step?.label || node.message.content), ['Change it', 'Agent', 'workspace.edit', 'Approval', 'Error', 'Done.']);
  assert.equal(g.nodes.at(-1).final, true);
  assert.deepEqual(g.frames.map((frame) => [frame.kind, frame.label, frame.state]), [['run', '/code', 'failed']]);
});

test('a fan-out to sub-agents is one fleet node alone in its row, between the judgments around it', () => {
  const s = script();
  s.emit('chat.started', { label: 'SHOUT agent' }); s.wait(10); s.emit('chat.completed', { tool: 'spawn_agents' });
  s.emit('tool.started', { effectId: 'group-1', tool: 'agents.spawn', input: { purpose: 'Audit the importer', agents: [{ id: 'a', name: 'tester' }] } });
  s.call(null, 'workspace.list');
  s.wait(30);
  s.emit('tool.completed', { effectId: 'group-1', tool: 'agents.spawn', value: { completed: 1, failed: 0 } });
  s.emit('chat.started', { label: 'SHOUT agent' }); s.wait(10); s.emit('chat.completed', {});
  const g = graph(s);
  const fleet = g.nodes.find((node) => node.type === 'fleet');
  assert.deepEqual([fleet.kind, fleet.group, fleet.status, fleet.step.detail], ['agent', 'group-1', 'ok', 'Audit the importer']);
  const row = g.rows.find((candidate) => candidate.ids.includes(fleet.id));
  assert.deepEqual([row.kind, row.ids.length], ['fleet', 1]);
  const [before, after] = g.nodes.filter((node) => node.type === 'hub');
  assert.ok(g.edges.some((edge) => edge.from === before.id && edge.to === fleet.id), 'fed by the judgment that spawned it');
  assert.ok(g.nodes.indexOf(after) > g.nodes.indexOf(fleet));
  // A sub-agent's own canvas labels its replies with the agent.
  const child = phases({ session: session([], [{ id: 'm', role: 'assistant', content: 'Report.', time: new Date(T0).toISOString() }]), events: [], now: NOW, actor: { name: 'tester', kind: 'agent' } });
  assert.equal(child.nodes[0].kind, 'agent');
});

test('only answer echoes are hidden: explicit echoes, or old echo prose just after an answer', () => {
  const s = script().run('run').approval('run').end('run');
  const answered = Date.parse(s.events.find((event) => event.type === 'user.answered').time);
  const said = (ms, content, extra = {}) => ({ id: `m${ms}`, role: 'user', content, time: new Date(answered + ms).toISOString(), ...extra });
  const messages = [
    said(5, 'Apply these changes.'),
    said(10, 'Approved', { echo: { kind: 'approval', accept: true, origin: 'user' } }),
    said(300, 'Also update the README.'),
    said(600_000, 'Apply these changes.'),
  ];
  const g = graph(s, undefined, { messages });
  assert.deepEqual(g.nodes.filter((node) => node.type === 'msg').map((node) => node.message.id), ['m300', 'm600000'], 'a message typed right after an answer stays; so does echo-like prose long after one');
});

test('messages stamped inside a run follow it', () => {
  const s = script().run('run').call('run', 'workspace.read', { ms: 50 }).call('run', 'workspace.list').end('run');
  const inside = new Date(Date.parse(s.events.find((event) => event.type === 'tool.started').time) + 5).toISOString();
  const g = graph(s, undefined, { messages: [{ id: 'm', role: 'assistant', content: 'Working', time: inside }] });
  assert.deepEqual(g.nodes.map((node) => node.type), ['tool', 'tool', 'msg']);
});

// Sessions captured from the real skills on the real JOSH VM (scripted agent and judgments), trimmed.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const LATER = Date.parse('2027-01-01T00:00:00Z');
const runNodes = (g, data, name) => { const run = data.runs.find((item) => (item.skill || (item.generated ? 'program' : '')) === name); const frame = g.frames.find((item) => item.key === `run:${run.id}`); return frame.members.map((id) => g.nodes.find((node) => node.id === id)); };
const describeNode = (node) => (node.type === 'group' || node.type === 'stack' ? `${node.type} ${node.title} ×${node.iterations?.length ?? node.steps.length}${node.failed ? ` ✗${node.failed}` : ''}` : node.type === 'track' ? `track ${node.title}` : `${node.step.label}${node.chip ? ` [${node.chip.label}]` : ''}`);

test('captured runs of the real skills draw their loops, branches and parallel tasks', () => {
  const data = fixture('flow-real-skills.json');
  const g = phases({ session: data, events: data.events, now: LATER, live: false });
  assert.deepEqual(runNodes(g, data, 'todo').map(describeNode), ['stack workspace.search ×3']);
  assert.deepEqual(runNodes(g, data, 'find').map(describeNode), ['workspace.search']);
  assert.deepEqual(runNodes(g, data, 'review').map(describeNode), ['git.run', 'git.run', 'git.run', 'workspace.read_many', 'git.run [then]', 'stack git.run ×36', 'stack Model ×12']);
  const program = runNodes(g, data, 'program');
  assert.deepEqual(program.map(describeNode), ['track size_of("a.mjs")', 'track size_of("b.mjs")', 'track size_of("c.mjs")', 'track count("HACK")', 'track count("NOTE")', 'group for folder in ["src", "test"] ×2', 'stack workspace.list ×3', 'Model [1..=99 | 100..=999]']);
  const whileLoop = program.find((node) => node.title === 'workspace.list');
  assert.deepEqual(whileLoop.steps.map((step) => step.origin.scope[0].iteration), [1, 3, 4], 'the continued iteration has no step');
  const nested = phases({ session: data, events: data.events, now: LATER, live: false, ui: { open: new Map([[program.find((node) => node.type === 'group').id, 2]]) } });
  assert.deepEqual(runNodes(nested, data, 'program').filter((node) => node.type === 'stack').map(describeNode), ['stack workspace.search ×2', 'stack workspace.list ×3'], 'the open iteration holds the inner loop');
  assert.equal(g.nodes.filter((node) => node.type === 'msg' && /^Apply these changes/.test(node.message.content)).length, 0, 'approval echoes stay in the chat');
  const said = g.nodes.filter((node) => node.type === 'msg').map((node) => node.message.content.split('\n')[0].slice(0, 14));
  assert.deepEqual(said.slice(0, 4), ['/todo', '4 markers in 4', '/find TODO', '2 matches for '], 'a reply and the next message in the same millisecond keep their order');
});

test('a captured /code run on a scenario: three attempts, two failing, each through its branch', () => {
  const data = fixture('flow-real-code.json');
  const g = phases({ session: data, events: data.events, now: LATER, live: false });
  const [inspect, group] = runNodes(g, data, 'code');
  assert.deepEqual([describeNode(inspect), describeNode(group), group.iterations.map((iteration) => iteration.status)], ['workspace.inspect', 'group for attempt in 0..3 ×3 ✗2', ['failed', 'failed', 'ok']]);
  const open = phases({ session: data, events: data.events, now: LATER, live: false, ui: { open: new Map([[group.id, 2]]) } });
  assert.deepEqual(runNodes(open, data, 'code').slice(1).map(describeNode), ['group for attempt in 0..3 ×3 ✗2', 'workspace.inspect [then]', 'Model', 'workspace.edit', 'Approval', 'tests.run']);
});

test('a retried judgment inside a loop is one card and does not disturb the iterations, live or after', () => {
  const data = fixture('flow-retry-real.json');
  const [group] = runNodes(phases({ session: data, events: data.events, now: LATER, live: false }), data, 'rate');
  const open = phases({ session: data, events: data.events, now: LATER, live: false, ui: { open: new Map([[group.id, 1]]) } });
  const inside = runNodes(open, data, 'rate').slice(1);
  assert.deepEqual(inside.map((node) => [node.step.label, node.status, node.step.attempts?.length]), [['workspace.read', 'ok', undefined], ['Model', 'ok', 2]], 'a retry adds no card to its iteration');
  assert.ok(inside[1].step.end - inside[1].step.start > 1500, 'its time covers both attempts');
  // Live, the second attempt keeps its card active and its iteration open; the rejected answer is not quoted.
  const cut = data.events.findIndex((event) => event.type === 'model.started' && event.attempt === 2);
  const live = phases({ session: { ...data, runs: data.runs.map((item) => ({ ...item, state: 'running' })) }, events: data.events.slice(0, cut + 1), now: LATER, live: true });
  const running = runNodes(live, data, 'rate').find((node) => node.type === 'group');
  assert.deepEqual([running?.open ?? null, live.nodes.find((node) => node.id === live.focus).step.attempts.map((attempt) => attempt.status)], [null, ['rejected', 'active']], 'one iteration so far: its body is framed, not grouped');
  const focus = live.nodes.find((node) => node.id === live.focus);
  assert.deepEqual([focus.status, focus.step.attempts.at(-1).attempt], ['active', 2]);
});

test('real retries: a re-asked judgment is one card; one whose every attempt was rejected reads as failed', () => {
  // Captured through session.mjs on the real VM: invalid then valid, valid once, invalid twice.
  const data = fixture('flow-retry-real.json');
  const g = phases({ session: data, events: data.events, now: LATER, live: false });
  const [group] = runNodes(g, data, 'rate');
  assert.deepEqual([describeNode(group), group.iterations.map((iteration) => [iteration.status, iteration.pips.length])], ['group for path in ["a.txt", "b.txt", "c.txt"] ×3 ✗1', [['ok', 2], ['ok', 2], ['failed', 2]]]);
  const steps = [...new Set([...g.index.values()].filter((item) => item.step?.pair === 'model').map((item) => item.step))];
  assert.deepEqual(steps.map((step) => [step.status, step.attempts.map((attempt) => attempt.status)]), [['ok', ['rejected', 'ok']], ['ok', ['ok']], ['failed', ['rejected', 'rejected']]]);
  assert.deepEqual(steps[2].attempts[0].issues, [{ path: '/level', code: 'tag' }, { path: '/score', code: 'type' }]);
  assert.deepEqual(steps[0].attempts[0].issues, [{ path: '/level', code: 'tag' }]);
});

test('a long session with a long loop stays quick to build', () => {
  const s = script();
  const runs = [];
  for (let r = 0; r < 6; r++) {
    const run = `run-${r}`;
    runs.push({ id: run, source });
    s.run(run);
    for (let i = 1; i <= 125; i++) s.call(run, 'git.run', { origin: at([loop(i, { instance: r + 1 })]), ms: 3 });
    s.end(run);
  }
  assert.ok(s.events.length >= 2900);
  const started = performance.now();
  const g = graph(s, runs);
  const elapsed = performance.now() - started;
  assert.equal(g.nodes.length, 6);
  assert.ok(elapsed < 400, `built in ${Math.round(elapsed)}ms`);
});
