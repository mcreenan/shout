import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFlow, formatDuration, modelTask, modelOutput, toolResult, originOf, programShape, programActivity, loopTitle, branchLabel, scopePath, spanText, stepFailed, plural, issueLabel, runFailure } from '../public/flow.js';

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
  assert.equal(main.program, events[4], 'the segment keeps its program.loaded event');
});

test('unfinished steps are active while live and stale afterwards', () => {
  const events = [at(0, 'run.started', { run }), at(10, 'effect.requested', { run, effectId: 'r-2' }), at(11, 'model.started', { run, effectId: 'r-2' })];
  const [live] = buildFlow(events, { live: true, now: Date.UTC(2026, 0, 1) + 1000 });
  assert.equal(live.steps[0].status, 'active');
  assert.equal(live.steps[0].label, 'Model');
  assert.equal(live.end, null);
  assert.equal(live.duration, 1000);
  const [done] = buildFlow(events);
  assert.equal(done.steps[0].status, 'stale');
  assert.equal(done.state, 'interrupted');
});

test('the newest run stays open between effects while the session is live', () => {
  const events = [at(0, 'run.started', { run }), at(1, 'tool.started', { run, effectId: 'r-1', tool: 'git.run' }), at(2, 'tool.completed', { run, effectId: 'r-1' })];
  assert.equal(buildFlow(events, { live: true })[0].end, null);
  assert.notEqual(buildFlow(events)[0].end, null);
});

test('worker usage goes to the judgment it names, even when judgments overlap', () => {
  const events = [at(0, 'run.started', { run }),
    at(1, 'effect.requested', { run, effectId: 'r-1' }), at(2, 'model.started', { run, effectId: 'r-1' }),
    at(3, 'effect.requested', { run, effectId: 'r-2' }), at(4, 'model.started', { run, effectId: 'r-2' }),
    at(5, 'model.worker', { run, effectId: 'r-1', usage: { input_tokens: 1000, output_tokens: 200 } }), at(6, 'model.completed', { run, effectId: 'r-1' }), at(7, 'effect.resolved', { run, effectId: 'r-1' }),
    at(8, 'model.worker', { run, effectId: 'r-2', usage: { input_tokens: 50, output_tokens: 5 } }), at(9, 'model.completed', { run, effectId: 'r-2' }), at(10, 'effect.resolved', { run, effectId: 'r-2' }),
    at(11, 'model.worker', { run, usage: { input_tokens: 7, output_tokens: 0 } })];
  const [segment] = buildFlow(events);
  assert.deepEqual(segment.steps.map((step) => step.detail), ['1.2k tokens', '7 tokens'], 'a worker without an effect ID goes to the latest judgment');
});

// A typed-response retry: JOSH re-asks when an answer fails validation, under the same `interaction`.
const issues = [{ path: '/edits/0/find', code: 'required' }];
function retried({ second = true, placeholder = true } = {}) {
  const tag = (attempt, extra = {}) => ({ run, interaction: 'i-1', attempt, ...extra });
  return [at(0, 'run.started', { run }),
    at(10, 'effect.requested', { effectId: 'r-1', ...tag(1) }), at(11, 'model.started', { effectId: 'r-1', ...tag(1) }),
    at(900, 'model.worker', { run, effectId: 'r-1', usage: { input_tokens: 800, output_tokens: 100 } }), at(1000, 'model.completed', { run, effectId: 'r-1', value: { summary: 'Bad patch.' } }), at(1001, 'effect.resolved', { run, effectId: 'r-1' }),
    at(1002, 'model.rejected', { effectId: 'r-1', ...tag(1, { issues }) }),
    ...(second ? [at(1010, 'effect.requested', { effectId: 'r-2', ...(placeholder ? tag(2, { issues }) : { run }) }), at(1011, 'model.started', { effectId: 'r-2', ...tag(2, { issues }) }),
      at(2500, 'model.worker', { run, effectId: 'r-2', usage: { input_tokens: 900, output_tokens: 120 } }), at(2600, 'model.completed', { run, effectId: 'r-2', value: { summary: 'Good patch.' } }), at(2601, 'effect.resolved', { run, effectId: 'r-2' })] : [])];
}

test('every attempt of one interaction is one step: its attempts, their issues, the final outcome', () => {
  const [segment] = buildFlow(retried());
  assert.equal(segment.steps.length, 1);
  const [step] = segment.steps;
  assert.deepEqual([step.label, step.status, step.end - step.start, step.events.length], ['Model', 'ok', 2591, 11]);
  assert.deepEqual(step.attempts.map((attempt) => [attempt.attempt, attempt.status, attempt.effectId, attempt.issues.length, attempt.events.length]), [[1, 'rejected', 'r-1', 1, 6], [2, 'ok', 'r-2', 0, 5]]);
  assert.deepEqual(step.attempts[0].issues, issues);
  assert.equal(step.attempts[1].events.findLast((event) => event.type === 'model.completed').value.summary, 'Good patch.');
  // The retry's placeholder may lack the interaction; its start event still joins the step.
  const [loose] = buildFlow(retried({ placeholder: false }));
  assert.deepEqual([loose.steps.length, loose.steps[0].attempts.map((attempt) => [attempt.attempt, attempt.status])], [1, [[1, 'rejected'], [2, 'ok']]]);
  // While the second attempt runs, the step is active again.
  const live = retried().slice(0, 9);
  const [running] = buildFlow(live, { live: true }).map((item) => item.steps[0]);
  assert.deepEqual([running.status, running.end, running.attempts.at(-1).status], ['active', null, 'active']);
});

test('validation issues read as a path and a short label; unknown codes stay as given', () => {
  assert.deepEqual(['type', 'required', 'unknown', 'range', 'fields', 'length', 'encoding', 'tag', 'order', 'brand-new'].map((code) => issueLabel({ path: '/a', code })),
    ['wrong type', 'missing', 'unknown field', 'out of range', 'wrong fields', 'wrong length', 'bad encoding', 'unknown variant', 'repeated key', 'brand-new']);
  assert.ok(['wrong type', 'missing', 'unknown field', 'out of range', 'wrong fields', 'wrong length', 'bad encoding', 'unknown variant', 'repeated key'].every((label) => label.split(' ').length <= 3));
  assert.equal(issueLabel({ path: '', code: 'type', message: 'ignored' }), 'wrong type');
});

test('an interaction whose last answer was invalid is failed, even though its effect resolved', () => {
  const events = [at(0, 'run.started', { run }),
    at(1, 'effect.requested', { run, effectId: 'r-1', interaction: 'i-9', attempt: 1 }), at(2, 'model.started', { run, effectId: 'r-1', interaction: 'i-9', attempt: 1 }),
    at(50, 'model.completed', { run, effectId: 'r-1', value: { level: 'Urgent' }, valid: false }), at(51, 'effect.resolved', { run, effectId: 'r-1' }),
    at(52, 'model.rejected', { run, effectId: 'r-1', interaction: 'i-9', attempt: 1, issues: [{ path: '/level', code: 'tag' }] }),
    at(53, 'effect.requested', { run, effectId: 'r-2', interaction: 'i-9', attempt: 2, issues: [{ path: '/level', code: 'tag' }] }), at(54, 'model.started', { run, effectId: 'r-2', interaction: 'i-9', attempt: 2, issues: [{ path: '/level', code: 'tag' }] }),
    at(90, 'model.completed', { run, effectId: 'r-2', value: { level: 'Medium' }, valid: false }), at(91, 'effect.resolved', { run, effectId: 'r-2' }),
    at(95, 'run.terminal', { run, state: 'completed' })];
  const [step] = buildFlow(events)[0].steps;
  assert.deepEqual([step.status, stepFailed(step), step.attempts.map((attempt) => attempt.status)], ['failed', true, ['rejected', 'rejected']]);
  // A single typed answer that is invalid fails the same way; a valid one is fine.
  const [once] = buildFlow(events.slice(0, 5))[0].steps;
  assert.deepEqual([once.status, once.attempts.map((attempt) => attempt.status)], ['failed', ['rejected']]);
});

test('requests without an interaction stay one step each, as before', () => {
  const plain = retried().map(({ interaction, attempt, issues: _, ...event }) => event).filter((event) => event.type !== 'model.rejected');
  const [segment] = buildFlow(plain);
  assert.deepEqual(segment.steps.map((step) => [step.label, step.attempts]), [['Model', undefined], ['Model', undefined]]);
  const single = buildFlow(retried({ second: false }).filter((event) => event.type !== 'model.rejected'))[0].steps[0];
  assert.equal(single.attempts.length, 1, 'a first attempt records its interaction');
});

test('host approvals without an effect wrapper close on their answer', () => {
  const events = [at(0, 'run.started', { run }), at(5, 'user.question', { run, effectId: 'approval-1', host: true, title: 'Apply changes' }), at(900, 'user.answered', { run, effectId: 'approval-1', origin: 'user', value: { accept: true } })];
  const [segment] = buildFlow(events, { live: true });
  assert.deepEqual([segment.steps[0].label, segment.steps[0].detail, segment.steps[0].status, segment.steps[0].end - segment.steps[0].start], ['Approval', 'Apply changes', 'ok', 895]);
  assert.equal(segment.steps[0].origin, null, 'the answer’s string origin is who answered, not control flow');
});

test('ends whose start fell off a capped log are marked as orphans', () => {
  const [segment] = buildFlow([at(0, 'tool.completed', { run, effectId: 'r-9', tool: 'git.run' })]);
  assert.deepEqual([segment.steps[0].label, segment.steps[0].orphan], ['git.run', true]);
});

test('durations format compactly', () => {
  assert.deepEqual([4, 1234, 15444, 78_500].map(formatDuration), ['4ms', '1.2s', '15s', '1m 18s']);
});

test('counts read naturally in the singular', () => {
  assert.deepEqual([plural(1, 'matches'), plural(2, 'matches'), plural(1, 'files'), plural(1, 'changed paths'), plural(1, 'passes')], ['1 match', '2 matches', '1 file', '1 changed path', '1 pass']);
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

test('tool steps have a short outcome, and failures include failing tests and exit codes', () => {
  const step = (tool, value, status = 'ok') => ({ label: tool, detail: '', status, events: [{ type: 'tool.started', tool }, ...(value ? [{ type: 'tool.completed', value }] : [])] });
  assert.equal(toolResult(step('git.run', { exit_code: 1 })), 'exit 1');
  assert.equal(toolResult(step('tests.run', { passed: true })), 'passed');
  assert.equal(toolResult(step('workspace.search', { matches: [1, 2] })), '2 matches');
  assert.equal(toolResult(step('workspace.search', { matches: [1] })), '1 match');
  assert.equal(toolResult(step('workspace.list', { files: ['a', 'b'], truncated: true })), '2 files+');
  assert.deepEqual([step('tests.run', { passed: false }), step('tests.run', { passed: false, skipped: true }), step('git.run', { exit_code: 128 }), step('git.run', { exit_code: 0 }), step('x', null, 'failed')].map(stepFailed), [true, false, true, false, true]);
});

test('steps left open by an earlier run stop once a later run starts', () => {
  const other = 'run-2';
  const events = [at(0, 'run.started', { run }), at(5, 'effect.requested', { run, effectId: 'r-9' }), at(6, 'tool.started', { run, effectId: 'r-9', tool: 'workspace.edit' }), at(50, 'run.started', { run: other })];
  const [first, second] = buildFlow(events, { live: true });
  assert.equal(first.steps[0].status, 'stale');
  assert.equal(first.state, 'interrupted');
  assert.equal(second.state, 'running');
});

/* Control-flow metadata */
const origin = { task: 2, parent_task: 0, site: { function: 'src/main.allen::ask', line: 9, column: 5 }, scope: [{ kind: 'for', construct: 3, line: 4, column: 3, region: 'body', instance: 1, iteration: 2 }, { kind: 'call', function: 'src/main.allen::ask', line: 5, column: 9 }, 'junk', { kind: 'if', construct: 4, line: 7, column: 5, region: 'else', branch: 'else' }] };
// A real /todo run on the real VM, trimmed (apps/shout/test/fixtures).
const skills = JSON.parse(readFileSync(new URL('./fixtures/flow-real-skills.json', import.meta.url), 'utf8'));
const runOf = (data, name) => { const found = data.runs.find((item) => (item.skill || (item.generated ? 'program' : '')) === name); return { run: found, events: data.events.filter((event) => event.run === found.id) }; };

test('origin is read only from objects carrying a site or scope', () => {
  assert.deepEqual(originOf({ origin }), { task: 2, parent: 0, site: origin.site, scope: [origin.scope[0], origin.scope[1], origin.scope[3]], truncated: false });
  assert.equal(originOf({ origin: 'user' }), null);
  assert.equal(originOf({ origin: { note: 'x' } }), null);
  assert.equal(originOf({}), null);
  assert.deepEqual(originOf({ origin: { scope: [], truncated: true } }), { task: 0, parent: null, site: null, scope: [], truncated: true }, 'task defaults to the root task');
  const [todo] = runOf(skills, 'todo').events.filter((event) => event.type === 'tool.started').map(originOf);
  assert.deepEqual([todo.task, todo.site.function, todo.site.line, todo.scope.map((entry) => entry.kind)], [0, 'src/main.allen::search', 13, ['for', 'call']], 'a captured /todo search');
});

test('a step takes its origin from the effect that became it', () => {
  const events = [at(0, 'run.started', { run }), at(1, 'effect.requested', { run, effectId: 'r-1', origin }), at(2, 'tool.started', { run, effectId: 'r-1', tool: 'git.run' }), at(3, 'tool.completed', { run, effectId: 'r-1' }), at(4, 'effect.resolved', { run, effectId: 'r-1' })];
  const [segment] = buildFlow(events);
  assert.equal(segment.steps.length, 1);
  assert.equal(segment.steps[0].origin.site.line, 9);
  assert.equal(segment.steps[0].run, run);
});

test('the program shape adapter reads JOSH effect sites and constructs, with their regions', () => {
  const { events, run: todoRun } = runOf(skills, 'todo');
  const shape = programShape(events.find((event) => event.type === 'program.loaded'));
  assert.deepEqual(shape.sites.map((site) => [site.id, site.kind, site.name, site.operation, site.line]), [[0, 'tool', 'workspace.search', 'tools.workspace.search.call', 13]]);
  const loop = [...shape.constructs.values()].find((item) => item.kind === 'for' && item.line === 38);
  assert.deepEqual([loop.function, loop.parent, loop.regions.map((region) => region.region)], ['src/main.allen::main', null, ['body']]);
  assert.equal(spanText(todoRun.source, shape.sites[0]), 'tools.workspace.search.call({ query: marker, max_results: 500 })');
  const loose = programShape({ effect_sites: [{ site: { line: 5 }, method: 'user/ask' }, { kind: 'sub_agent', line: 7 }], scopes: [{ id: 4, kind: 'if', parent: 3, span: { line: 23 } }] });
  assert.deepEqual(loose.sites.map((site) => [site.line, site.kind]), [[5, 'user'], [7, 'agent']]);
  assert.deepEqual([...loose.constructs.values()].map((item) => [item.id, item.kind, item.parent, item.line, item.regions]), [[4, 'if', 3, 23, []]]);
  assert.deepEqual(programShape(undefined), { sites: [], constructs: new Map() });
});

test('source spans read by code point, across lines', () => {
  const source = 'let naïve = "café";\nfor x in [1,\n  2] {';
  assert.equal(spanText(source, { line: 1, column: 13, endLine: 1, endColumn: 19 }), '"café"', 'end columns are exclusive');
  assert.equal(spanText(source, { line: 2, column: 10, endLine: 3, endColumn: 5 }), '[1,\n  2]');
  assert.equal(spanText(source, { line: 9 }), '');
});

test('loop headers, branch labels and the scope path read from the source', () => {
  const source = 'fn main() {\n  mut n = 0;\n  let x = 1;\n  for attempt in 0..3 {\n    let r = ask(attempt);\n    if (r) {\n    } else {\n    }\n  }\n}';
  assert.equal(loopTitle(source, { kind: 'for', line: 4, column: 3 }), 'for attempt in 0..3');
  assert.equal(loopTitle(undefined, { kind: 'while', line: 4 }), 'while loop');
  assert.deepEqual([branchLabel({ kind: 'if', branch: 'else' }).label, branchLabel({ kind: 'if' }).label, branchLabel({ kind: 'match', arm: 1 }).label], ['else', 'then', 'arm 2'], 'match arms are 0-based');
  assert.deepEqual(scopePath(originOf({ origin }), source).map((item) => item.label), ['main', 'for attempt #2', 'ask', 'else']);
  assert.deepEqual(scopePath(null, source), []);
  // With the program's tables, an arm reads as its pattern and an if as its condition.
  const { run: program, events } = runOf(skills, 'program');
  const shape = programShape(events.find((event) => event.type === 'program.loaded'));
  const matched = events.find((event) => event.type === 'model.started').origin.scope.find((entry) => entry.kind === 'match');
  assert.deepEqual(branchLabel(matched, { shape, source: program.source }).label, '1..=99 | 100..=999');
  const { run: review, events: reviewEvents } = runOf(skills, 'review');
  const reviewShape = programShape(reviewEvents.find((event) => event.type === 'program.loaded'));
  const branch = reviewEvents.find((event) => event.origin?.scope?.some((entry) => entry.kind === 'if')).origin.scope.find((entry) => entry.kind === 'if');
  assert.deepEqual(branchLabel(branch, { shape: reviewShape, source: review.source }), { label: 'then', title: 'if (diff.truncated)' });
  const spawned = originOf(events.find((event) => event.type === 'tool.started' && event.origin.task === 1));
  assert.deepEqual(scopePath(spawned, program.source, shape).map((item) => item.label), ['main', 'await', 'size_of · task 1']);
});

test('program activity counts effects by site line and loops by header line', () => {
  const loop = (iteration, instance = 1) => ({ kind: 'for', construct: 1, line: 3, column: 3, instance, iteration });
  const tool = (ms, id, line, scope, done = true) => [
    at(ms, 'effect.requested', { run, effectId: id, origin: { task: 0, site: { line }, scope } }), at(ms + 1, 'tool.started', { run, effectId: id, tool: 'git.run' }),
    ...(done ? [at(ms + 2, 'tool.completed', { run, effectId: id }), at(ms + 3, 'effect.resolved', { run, effectId: id })] : []),
  ];
  const events = [at(0, 'run.started', { run }), at(1, 'program.loaded', { run, sites: [{ line: 5, kind: 'tool' }, { line: 9, kind: 'model' }] }), ...tool(10, 'r-1', 5, [loop(1)]), ...tool(20, 'r-2', 5, [loop(2)]), ...tool(30, 'r-3', 5, [loop(1, 2)], false)];
  const live = programActivity(events, { live: true });
  assert.equal(live.origin, true);
  assert.deepEqual([...live.lines].map(([line, entry]) => [line, entry.kind, entry.count, entry.state]), [[5, 'tool', 3, 'running']]);
  assert.deepEqual([live.loops.get(3).total, live.loops.get(3).live], [3, true], 'two instances: 2 + 1 iterations');
  assert.deepEqual(live.sites.map((site) => site.line), [5, 9]);
  const done = programActivity(events);
  assert.equal(done.loops.get(3).live, false);
  assert.equal(done.lines.get(5).state, '');
  assert.equal(programActivity([at(0, 'run.started', { run }), at(1, 'tool.started', { run, effectId: 'x', tool: 'git.run' })]).origin, false);
  // Captured retries: three rated notes are three at their site, five attempts beside the count.
  const real = JSON.parse(readFileSync(new URL('./fixtures/flow-retry-real.json', import.meta.url), 'utf8'));
  const rated = [...programActivity(real.events).lines.values()].find((entry) => entry.kind === 'model');
  assert.deepEqual([rated.count, rated.attempts], [3, 5]);
  // A retried request counts once at its site, its attempts beside the count.
  const once = programActivity(retried().map((event) => (['effect.requested', 'model.started'].includes(event.type) ? { ...event, origin: { task: 0, site: { line: 7 }, scope: [] } } : event)));
  assert.deepEqual([once.lines.get(7).count, once.lines.get(7).attempts], [1, 2]);
  // Captured /review: 40 git calls at the helper's one site, counted again at each call line.
  const review = programActivity(runOf(skills, 'review').events);
  assert.equal(review.lines.get(30).count, 40);
  assert.deepEqual([review.calls.get(80).count, review.calls.get(213).count, review.calls.get(199).count, review.loops.get(79).total], [36, 37, 1, 36]);
});

test('a failed run fails at its recorded line, else at its result span in the program source', () => {
  const source = 'manifest {}\nfn main() {\n  10 / 0\n}\n';
  const span = { source: 'src/main.allen', line: 3, column: 3, end_line: 3, end_column: 9 };
  const failedAt = { line: 3, column: 3, end_line: 3, end_column: 9 };
  assert.deepEqual(runFailure({ state: 'failed', source, failedAt, result: { outcome: 'failed', error: { code: 'arithmetic.division_by_zero', message: 'division by zero', span } } }),
    { line: 3, column: 3, message: 'division by zero' });
  // Sessions saved before failedAt: the trap's error span, or the span the kernel gives a host failure.
  assert.deepEqual(runFailure({ state: 'failed', source, result: { error: { message: 'division by zero', span } } }), { line: 3, column: 3, message: 'division by zero' });
  assert.deepEqual(runFailure({ state: 'failed', source, result: { error: 'Model judgment budget exhausted (16 per run)', span: { ...span, line: 2 } } }),
    { line: 2, column: 3, message: 'Model judgment budget exhausted (16 per run)' });
  // No line, a foreign source, a line past the end, or a run that did not fail: no position.
  assert.equal(runFailure({ state: 'failed', source, result: { error: { message: 'x', span: { source: 'src/main.allen' } } } }), null);
  assert.equal(runFailure({ state: 'failed', source, result: { error: { message: 'x', span: { ...span, source: 'std/list.allen' } } } }), null);
  assert.equal(runFailure({ state: 'failed', source, result: { error: { message: 'x', span: { ...span, line: 40 } } } }), null);
  for (const state of ['stopped', 'cancelled', 'interrupted']) assert.equal(runFailure({ state, source, failedAt, result: { error: { message: 'x', span } } }), null, state);
  assert.equal(runFailure(null), null);
});
