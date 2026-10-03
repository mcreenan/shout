// The Flow renderers against a minimal DOM: enough of it to build cards and the step detail in node.
import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], dataset: {}, attributes: {}, className: '', style: { setProperty() {} }, hidden: false, text: null }); }
  // Like the DOM: anything that is not a node becomes text (so a stray null reads "null").
  append(...nodes) { for (const node of nodes) { if (node instanceof FakeNode) { if (node.tagName === '#fragment') this.children.push(...node.children); else this.children.push(node); } else this.children.push(Object.assign(new FakeNode('#text'), { text: String(node) })); } this.text = null; }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get textContent() { return this.text ?? this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.text = String(value); }
  set innerHTML(value) { this.children = []; this.text = ''; this.html = value; }
  get classList() { const node = this; const list = () => node.className.split(/\s+/).filter(Boolean); return { add: (...names) => { node.className = [...new Set([...list(), ...names])].join(' '); }, remove: (...names) => { node.className = list().filter((name) => !names.includes(name)).join(' '); }, toggle: (name, on = !list().includes(name)) => { if (on) this.add(name); else this.remove(name); return on; }, contains: (name) => list().includes(name) }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return name in this.attributes; }
  addEventListener() {}
  focus() {}
  contains() { return false; }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector) { const name = selector.replace(/^\./, ''); return this.all().filter((node) => node.className.split(/\s+/).includes(name)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}
globalThis.document = { createElement: (tag) => new FakeNode(tag), createElementNS: (_, tag) => new FakeNode(tag), createDocumentFragment: () => new FakeNode('#fragment'), createTextNode: (text) => Object.assign(new FakeNode('#text'), { text }), addEventListener() {}, activeElement: null, querySelector: () => null };
const { NODE_TYPES } = await import('../public/flow-canvas.js');
const { createFlowDetail } = await import('../public/flow-detail.js');
const { buildFlow } = await import('../public/flow.js');
const { readFileSync } = await import('node:fs');

const T0 = Date.UTC(2026, 0, 1);
let sequence = 0;
const at = (ms, type, fields = {}) => ({ id: `e${++sequence}`, sequence, time: new Date(T0 + ms).toISOString(), type, ...fields });
const ctx = (session = {}) => ({ markdown: (container, text) => container.append(text), session, options: {} });
const marks = (node) => node.querySelectorAll('.fl-state').map((mark) => mark.className.replace('fl-state ', ''));

test('an interrupted step keeps its stale mark in stack rows, not a success check', () => {
  const run = 'run-1';
  const events = [at(0, 'run.started', { run }),
    at(1, 'tool.started', { run, effectId: 'r-1', tool: 'git.run', input: { args: ['diff'] } }), at(2, 'tool.completed', { run, effectId: 'r-1', value: { exit_code: 0 } }),
    at(3, 'tool.started', { run, effectId: 'r-2', tool: 'git.run', input: { args: ['log'] } })];
  const steps = buildFlow(events)[0].steps;
  assert.deepEqual(steps.map((step) => step.status), ['ok', 'stale']);
  const card = new FakeNode('div');
  NODE_TYPES.stack.render(card, { type: 'stack', steps, bare: true, open: true, title: 'git.run', failed: 0, start: steps[0].start, end: steps[1].end, ended: true }, ctx());
  assert.deepEqual(marks(card), ['ok', 'stale']);
});

test('a running sub-agent’s open step pulses in its fleet tile', () => {
  const agent = { id: 'agent-1', group: 'g-1', name: 'tester', status: 'running', startedAt: new Date(T0).toISOString(), activity: 'Thinking',
    events: [at(0, 'chat.started', { label: 'tester' }), at(5, 'chat.completed', { tool: 'read_file' }), at(6, 'tool.started', { effectId: 'c-1', tool: 'read_file', input: { path: 'a.mjs' } }), at(7, 'tool.completed', { effectId: 'c-1' }), at(8, 'chat.started', { label: 'tester' })] };
  const step = { start: T0, end: null, events: [at(0, 'tool.started', { effectId: 'g-1', tool: 'agents.spawn', input: { purpose: 'check', agents: [{ id: 'agent-1', name: 'tester' }] } })] };
  const card = new FakeNode('div');
  NODE_TYPES.fleet.render(card, { type: 'fleet', group: 'g-1', status: 'active', step }, ctx({ agents: [agent] }));
  const pips = card.querySelector('fl-pips').children.map((pip) => pip.className);
  assert.deepEqual(pips.slice(0, 3), ['m', 't', 'm live']);
  // A finished agent has nothing live.
  const done = new FakeNode('div');
  NODE_TYPES.fleet.render(done, { type: 'fleet', group: 'g-1', status: 'ok', step }, ctx({ agents: [{ ...agent, status: 'completed', report: 'Done.' }] }));
  assert.ok(!done.querySelector('fl-pips').children.some((pip) => pip.className.includes('live')));
});

test('the step detail never prints an empty chip list as "null"', () => {
  const host = new FakeNode('aside');
  const detail = createFlowDetail(host, { reveal() {}, onClose() {} });
  const agent = buildFlow([at(0, 'chat.started', { label: 'SHOUT agent' }), at(10, 'chat.completed', {})])[0].steps[0];
  detail.show({ id: agent.id, step: agent, session: { runs: [] } });
  const model = buildFlow([at(0, 'model.started', { effectId: 'm-1', prompt: { system: 'You are a reviewer. Review it.' } }), at(9, 'model.completed', { effectId: 'm-1', value: { summary: 'Fine.' } })])[0].steps[0];
  const agentText = host.textContent;
  detail.show({ id: model.id, step: model, session: { runs: [] } });
  for (const text of [agentText, host.textContent]) assert.ok(!/null|undefined/.test(text), text);
});

// Captured through session.mjs on the real VM: invalid then valid, valid once, invalid twice.
const real = JSON.parse(readFileSync(new URL('./fixtures/flow-retry-real.json', import.meta.url), 'utf8'));
const judgments = buildFlow(real.events).flatMap((segment) => segment.steps).filter((step) => step.pair === 'model');

test('a judgment whose every attempt was rejected reads as failed, with why, not as its last answer', () => {
  const [, , rejected] = judgments;
  const card = new FakeNode('div');
  NODE_TYPES.hub.render(card, { type: 'hub', kind: 'model', status: rejected.status, step: rejected }, ctx());
  assert.ok(card.classList.contains('fail'));
  assert.equal(card.querySelector('fl-chip').textContent, '2 attempts');
  assert.equal(card.querySelector('fl-text').textContent, '/level unknown variant · /score wrong type');
  const retried = new FakeNode('div');
  NODE_TYPES.hub.render(retried, { type: 'hub', kind: 'model', status: judgments[0].status, step: judgments[0] }, ctx());
  assert.ok(!retried.classList.contains('fail'));
  assert.equal(retried.querySelector('retry').textContent, '2 attempts');
});

test('the detail lists every attempt with each issue as its path and a short label', () => {
  const host = new FakeNode('aside');
  createFlowDetail(host, { reveal() {}, onClose() {} }).show({ id: judgments[2].id, step: judgments[2], session: { runs: [] } });
  const attempts = host.querySelector('fd-attempts');
  assert.deepEqual(attempts.children.map((item) => item.className), ['fd-attempt rejected', 'fd-attempt rejected']);
  assert.deepEqual(attempts.querySelector('fd-issues').children.map((line) => line.textContent), ['/levelunknown variant', '/scorewrong type']);
});


test('a folded burst keeps what matters on one line; open, it lists a row per call that selects its step', () => {
  const run = 'run-b';
  const call = (i, tool, input, value) => [at(i * 10, 'tool.started', { run, effectId: `b-${i}`, tool, input }), at(i * 10 + 5, 'tool.completed', { run, effectId: `b-${i}`, tool, value })];
  const steps = buildFlow([at(0, 'run.started', { run }), ...call(1, 'workspace.read', { path: 'a.mjs' }, {}), ...call(2, 'workspace.edit', { path: 'src/a.mjs' }, { changed: ['src/a.mjs', 'src/b.mjs'] }), ...call(3, 'tests.run', { command: 'npm test' }, { passed: false, output: 'not ok 1 - a' })])[0].steps;
  const node = { type: 'burst', kind: 'tool', status: 'ok', steps, start: steps[0].start, end: steps[2].end, failed: 1, mix: { read: 1, edit: 1, test: 1, run: 0, other: 0 }, fails: [{ label: 'tests.run', count: 1 }], writes: ['a.mjs', 'b.mjs'], pips: ['a', 't', 'x'], current: false, open: false };
  const card = new FakeNode('div');
  NODE_TYPES.burst.render(card, node, ctx());
  assert.ok(card.classList.contains('collapsed'));
  assert.deepEqual(['fl-title', 'fl-mix', 'fl-xchip', 'fl-wchip'].map((name) => card.querySelector(name).textContent), ['3 calls', '1 read, 1 edit, 1 test', 'tests.run · 1 failed', 'a.mjs +1']);
  assert.deepEqual(card.querySelector('fl-pips').children.map((pip) => pip.className), ['a', 't', 'x']);
  assert.equal(card.querySelector('fl-head').dataset.act, 'toggle', 'clicking the line pins it open');
  const open = new FakeNode('div');
  NODE_TYPES.burst.render(open, { ...node, open: true, pinned: true }, ctx());
  const rows = open.querySelectorAll('fl-row');
  assert.deepEqual(rows.map((row) => [row.dataset.step, row.dataset.act, row.querySelector('fl-cmp-verb').textContent]), steps.map((step, i) => [step.id, 'row', ['read', 'edit', 'test'][i]]));
  assert.equal(open.querySelector('fl-row-err').textContent, 'not ok 1 - a');
  const live = new FakeNode('div');
  NODE_TYPES.burst.render(live, { ...node, open: true, current: true }, ctx());
  assert.equal(live.querySelector('fl-head').dataset.act, undefined, 'while it is live it is not a toggle');
});

test('a settled call is one line, a judgment lists its inputs inside its card, an answered approval is one line', () => {
  const steps = buildFlow([
    at(0, 'tool.started', { effectId: 'c-1', tool: 'tests.run', input: { command: 'npm test' } }), at(5, 'tool.completed', { effectId: 'c-1', tool: 'tests.run', value: { passed: true } }),
    at(6, 'tool.started', { effectId: 'c-2', tool: 'workspace.search', input: { query: 'retry' } }), at(7, 'tool.completed', { effectId: 'c-2', value: { matches: [1] } }),
    at(8, 'tool.started', { effectId: 'c-3', tool: 'workspace.read_many', input: { paths: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'] } }), at(9, 'tool.completed', { effectId: 'c-3', value: {} }),
    at(10, 'model.started', { effectId: 'm-1', prompt: { system: 'You are a planner. Plan it.' } }), at(20, 'model.completed', { effectId: 'm-1', value: { summary: 'Plan: **retry**.' } }),
    at(30, 'user.question', { effectId: 'q-1', host: true, title: 'Apply these changes?' }), at(90_000, 'user.answered', { effectId: 'q-1', value: { accept: true } }),
  ])[0].steps;
  const [tests, search, read, model, approval] = steps;
  const compact = new FakeNode('div');
  NODE_TYPES.tool.render(compact, { type: 'tool', kind: 'tool', status: 'ok', tier: 2, step: tests }, ctx());
  assert.ok(compact.classList.contains('compact') && compact.classList.contains('pass'), 'one line, and a passing test still shows its check');
  assert.deepEqual([compact.querySelector('fl-cmp-verb').textContent, compact.querySelector('fl-cmp-arg').textContent], ['test', 'npm test']);
  const full = new FakeNode('div');
  NODE_TYPES.tool.render(full, { type: 'tool', kind: 'tool', status: 'ok', tier: 1, step: tests }, ctx());
  assert.ok(!full.classList.contains('compact'));
  const hub = new FakeNode('div');
  NODE_TYPES.hub.render(hub, { type: 'hub', kind: 'model', status: 'ok', step: model, outcome: 'Plan: retry.', inputs: [search, read] }, ctx());
  assert.equal(hub.querySelector('fl-text').textContent, 'Plan: retry.');
  assert.deepEqual(hub.querySelectorAll('fl-in').map((chip) => [chip.textContent, chip.dataset.step, chip.dataset.act]), [['"retry"', search.id, 'row'], ['a.mjs +2', read.id, 'row']]);
  const answered = new FakeNode('div');
  NODE_TYPES.approval.render(answered, { type: 'approval', kind: 'user', status: 'ok', step: approval }, ctx());
  assert.ok(answered.classList.contains('answered'));
  assert.deepEqual(['fl-cmp-title', 'fl-cmp-arg'].map((name) => answered.querySelector(name).textContent), ['Approved', 'Apply these changes?']);
  assert.ok(answered.querySelector('fl-time'), 'how long it waited');
});
