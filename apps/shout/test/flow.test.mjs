import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, formatDuration, modelTask, modelOutput, toolResult, toolActivity } from '../public/flow.js';

let sequence = 0;
const at = (ms, type, fields = {}) => ({ id: `e${++sequence}`, sequence, time: new Date(Date.UTC(2026, 0, 1) + ms).toISOString(), type, ...fields });
const run = 'run-1';

test('effect events fold into one timed step per tool call', () => {
  const events = [
    at(0, 'chat.started', { label: 'Route' }), at(5, 'chat.worker', { usage: { input_tokens: 900, output_tokens: 100 } }), at(40, 'chat.completed'),
    at(50, 'run.started', { run }), at(51, 'program.loaded', { run }), at(52, 'vm.event', { run }),
    at(60, 'effect.requested', { run, effectId: 'r-1' }), at(61, 'tool.started', { run, effectId: 'r-1', tool: 'git.run', input: { args: ['diff', 'HEAD'] } }),
    at(70, 'tool.completed', { run, effectId: 'r-1' }), at(72, 'effect.resolved', { run, effectId: 'r-1' }),
    at(80, 'run.terminal', { run, state: 'completed' }),
  ];
  const [routing, main] = buildFlow(events);
  assert.equal(routing.run, null);
  assert.deepEqual(routing.steps.map((step) => [step.label, step.detail, step.end - step.start]), [['Agent', '1.0k tokens', 40]]);
  assert.equal(main.state, 'completed');
  assert.equal(main.duration, 30);
  assert.equal(main.events.length, 3, 'run lifecycle and VM events stay off the step list');
  const tool = main.steps.find((step) => step.kind === 'tool');
  assert.deepEqual([tool.label, tool.detail, tool.status, tool.end - tool.start, tool.events.length], ['git.run', 'diff HEAD', 'ok', 12, 4]);
  assert.equal(tool.id, events[7].id, 'the step is identified by its tool.started event');
  assert.equal(main.steps.find((step) => step.label === 'Program loaded').status, 'instant');
});

test('unfinished steps are active while live and stale afterwards', () => {
  const events = [at(0, 'run.started', { run }), at(10, 'effect.requested', { run, effectId: 'r-2' }), at(11, 'model.started', { run, effectId: 'r-2' })];
  const [live] = buildFlow(events, { live: true, now: Date.UTC(2026, 0, 1) + 1000 });
  assert.equal(live.steps[0].status, 'active');
  assert.equal(live.end, null);
  assert.equal(live.duration, 1000);
  const [done] = buildFlow(events);
  assert.equal(done.steps[0].status, 'stale');
  assert.equal(done.state, 'interrupted');
});

test('host approvals without an effect wrapper close on their answer', () => {
  const events = [at(0, 'run.started', { run }), at(5, 'user.question', { run, effectId: 'approval-1', host: true, title: 'Apply changes' }), at(900, 'user.answered', { run, effectId: 'approval-1' })];
  const [segment] = buildFlow(events, { live: true });
  assert.deepEqual([segment.steps[0].label, segment.steps[0].detail, segment.steps[0].status, segment.steps[0].end - segment.steps[0].start], ['Approval', 'Apply changes', 'ok', 895]);
});

test('durations format compactly', () => {
  assert.deepEqual([4, 1234, 15444, 78_500].map(formatDuration), ['4ms', '1.2s', '15s', '1m 18s']);
});

test('model calls describe their task and inputs, and surface findings or edits', () => {
  const task = modelTask({ system: 'You are a careful senior code reviewer. Review the supplied diff. Be concise.', data: { tag: 'Some', value: { all_changed_paths: ['a', 'b'], files: [{}], attempt: 1, note: '' } } });
  assert.deepEqual(task, { role: 'careful senior code reviewer', task: 'Review the supplied diff.', inputs: ['2 changed paths', '1 file', 'attempt 1'] });
  assert.equal(modelTask({ system: 'You explain code to a developer.' }).task, 'Explain code to a developer.');
  const review = modelOutput({ summary: 'One issue.', findings: [{ title: 'Race', severity: 'high', file: 'a.mjs', line: 3 }] });
  assert.deepEqual(review, { text: 'One issue.', items: [{ title: 'Race', meta: 'high · a.mjs:3', tone: 'high', detail: '' }], files: [] });
  assert.deepEqual(modelOutput({ markdown: 'Hi', edits: [{ path: 'x' }, { path: 'x' }] }).items, [{ title: 'x', meta: '2 edits', tone: 'edit' }]);
  assert.deepEqual(modelOutput({ paths: ['a.mjs', 'b.mjs'] }).files, ['a.mjs', 'b.mjs'], 'selection judgments surface the files they chose');
});

test('tool steps read as present-tense activity and a short outcome', () => {
  const step = (tool, input, value) => ({ label: tool, detail: '', events: [{ type: 'tool.started', tool, input }, ...(value ? [{ type: 'tool.completed', value }] : [])] });
  assert.equal(toolActivity(step('git.run', { args: ['diff', 'HEAD'] })), 'Running git diff HEAD');
  assert.equal(toolResult(step('git.run', {}, { exit_code: 1 })), 'exit 1');
  assert.equal(toolResult(step('tests.run', {}, { passed: true })), 'passed');
  assert.equal(toolResult(step('workspace.search', {}, { matches: [1, 2] })), '2 matches');
});

test('steps left open by an earlier run stop once a later run starts', () => {
  const other = 'run-2';
  const events = [at(0, 'run.started', { run }), at(5, 'effect.requested', { run, effectId: 'r-9' }), at(6, 'tool.started', { run, effectId: 'r-9', tool: 'workspace.edit' }), at(50, 'run.started', { run: other })];
  const [first, second] = buildFlow(events, { live: true });
  assert.equal(first.steps[0].status, 'stale');
  assert.equal(first.state, 'interrupted');
  assert.equal(second.state, 'running');
});
