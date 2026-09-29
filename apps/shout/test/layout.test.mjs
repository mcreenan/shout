import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, createLayout, groups, groupOfTab, addTab, moveTab, closeTab, splitWith, resize, serialize, restore } from '../public/layout.js';

const file = (path) => ({ id: `file:${path}`, kind: 'file', path });

test('chat starts as the only tab and cannot be closed', () => {
  const layout = createLayout();
  assert.deepEqual(groups(layout.root).map((group) => group.tabs), [[CHAT]]);
  assert.equal(closeTab(layout, CHAT), false);
  assert.ok(layout.tabs[CHAT]);
});

test('tabs open in the focused group and closing the last tab of a split collapses it', () => {
  const layout = createLayout();
  addTab(layout, file('a.js'));
  const chatGroup = groupOfTab(layout, CHAT);
  assert.deepEqual(chatGroup.tabs, [CHAT, 'file:a.js']);
  assert.equal(chatGroup.active, 'file:a.js');
  splitWith(layout, 'file:a.js', chatGroup.id, 'right');
  assert.equal(layout.root.type, 'split');
  assert.equal(layout.root.dir, 'row');
  assert.deepEqual(groups(layout.root).map((group) => group.tabs), [[CHAT], ['file:a.js']]);
  assert.equal(layout.focus, groupOfTab(layout, 'file:a.js').id);
  closeTab(layout, 'file:a.js');
  assert.equal(layout.root.type, 'group');
  assert.deepEqual(layout.root.tabs, [CHAT]);
});

test('splits nest across directions and flatten within one direction', () => {
  const layout = createLayout();
  addTab(layout, file('a.js'));
  addTab(layout, file('b.js'));
  addTab(layout, file('c.js'));
  const first = groupOfTab(layout, CHAT).id;
  splitWith(layout, 'file:a.js', first, 'right');
  splitWith(layout, 'file:b.js', first, 'left');
  assert.equal(layout.root.dir, 'row');
  assert.deepEqual(groups(layout.root).map((group) => group.tabs), [['file:b.js'], [CHAT, 'file:c.js'], ['file:a.js']]);
  assert.ok(Math.abs(layout.root.sizes.reduce((sum, size) => sum + size, 0) - 2) < 1e-9);
  splitWith(layout, 'file:c.js', first, 'bottom');
  const column = layout.root.children[1];
  assert.equal(column.type, 'split');
  assert.equal(column.dir, 'col');
  assert.deepEqual(groups(column).map((group) => group.tabs), [[CHAT], ['file:c.js']]);
  // Moving the only tab out of a group removes the group and its now-single-child split.
  moveTab(layout, 'file:c.js', groupOfTab(layout, 'file:a.js').id);
  assert.equal(layout.root.children.length, 3);
  assert.ok(layout.root.children.every((child) => child.type === 'group'));
});

test('splitting a group with its own only tab is a no-op', () => {
  const layout = createLayout();
  const before = serialize(layout);
  splitWith(layout, CHAT, layout.root.id, 'right');
  assert.equal(serialize(layout), before);
});

test('moveTab reorders within a group', () => {
  const layout = createLayout();
  addTab(layout, file('a.js'));
  addTab(layout, file('b.js'));
  moveTab(layout, CHAT, layout.root.id, 3);
  assert.deepEqual(layout.root.tabs, ['file:a.js', 'file:b.js', CHAT]);
  moveTab(layout, 'file:b.js', layout.root.id, 0);
  assert.deepEqual(layout.root.tabs, ['file:b.js', 'file:a.js', CHAT]);
});

test('resize clamps and preserves the pair total', () => {
  const split = { sizes: [1, 1, 2] };
  resize(split, 1, 0.99);
  assert.ok(Math.abs(split.sizes[0] - 1.76) < 1e-9);
  assert.ok(Math.abs(split.sizes[0] + split.sizes[1] - 2) < 1e-9);
  assert.equal(split.sizes[2], 2);
});

test('layouts round-trip and malformed input falls back safely', () => {
  const layout = createLayout();
  addTab(layout, { id: 'viz-1', kind: 'viz', view: 'changes', runFilter: 'transient' });
  splitWith(layout, 'viz-1', layout.root.id, 'bottom');
  const restored = restore(serialize(layout));
  assert.deepEqual(groups(restored.root).map((group) => group.tabs), [[CHAT], ['viz-1']]);
  assert.deepEqual(restored.tabs['viz-1'], { id: 'viz-1', kind: 'viz', view: 'changes' });
  for (const bad of [null, '', '{', '{"root":{"type":"group"}}', '{"root":{"type":"split","id":"s","dir":"row","children":[],"sizes":[1]}}']) {
    assert.deepEqual(groups(restore(bad).root).map((group) => group.tabs), [[CHAT]]);
  }
  // Unknown tabs, bad views and a missing chat tab are repaired.
  const repaired = restore(JSON.stringify({ root: { type: 'group', id: 'g', tabs: ['x', 'y'], active: 'x' }, tabs: { x: { id: 'x', kind: 'viz', view: 'nope' }, y: { id: 'y', kind: 'file', path: 'a.js' } }, focus: 'missing' }));
  assert.deepEqual(repaired.root.tabs, [CHAT, 'y']);
  assert.equal(repaired.root.active, CHAT);
  assert.equal(repaired.focus, 'g');
});

test('a sub-agent tab round-trips with its agent; one without an agent is dropped', () => {
  const layout = createLayout();
  addTab(layout, { id: 'agent-1', kind: 'agent', agent: 'agent-7c1e' });
  splitWith(layout, 'agent-1', layout.root.id, 'right');
  const restored = restore(serialize(layout));
  assert.deepEqual(groups(restored.root).map((group) => group.tabs), [[CHAT], ['agent-1']]);
  assert.deepEqual(restored.tabs['agent-1'], { id: 'agent-1', kind: 'agent', agent: 'agent-7c1e' });
  const broken = restore(JSON.stringify({ root: { type: 'group', id: 'g', tabs: [CHAT, 'a'], active: 'a' }, tabs: { [CHAT]: { id: CHAT, kind: 'chat' }, a: { id: 'a', kind: 'agent', agent: 3 } }, focus: 'g' }));
  assert.deepEqual(broken.root.tabs, [CHAT]);
});
