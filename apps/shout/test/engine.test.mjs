import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Run } from '../../../prototypes/owned/src/kernel.mjs';
import { codingTools } from '../src/catalog.mjs';

const source = await readFile(new URL('../workflows/coding.allen', import.meta.url), 'utf8');

async function create(t, { judge, approve = true, testResults = [true], toolHandler, ...options } = {}) {
  const scratchRoot = await mkdtemp(join(tmpdir(), 'shout-engine-test-'));
  const calls = []; const approvals = []; const modelInputs = []; let content = 'old'; let testIndex = 0;
  const run = new Run({ source, input: { goal: 'Fix the code', history: '' }, scratchRoot, tools: codingTools,
    provider: { judge: async args => {
      modelInputs.push(args.prompt.data.value);
      return judge ? judge(args, modelInputs.length) : { summary: 'Fix code', changes: [{ path: 'code.js', before: content, after: 'fixed' }] };
    } },
    toolHandler: async (name, input, context) => {
      calls.push({ name, input });
      if (toolHandler) return toolHandler(name, input, context);
      if (name === 'inspect_workspace') return { files: [{ path: 'code.js', content }], summary: 'One file' };
      if (name === 'apply_changes') {
        assert.equal(input.changes[0].before, content);
        content = input.changes[0].after;
        return { changed: input.changes.map(change => change.path) };
      }
      const passed = testResults[testIndex++] ?? false;
      return { passed, output: passed ? 'PASS' : 'FAIL code.js expected fixed', exitCode: passed ? 0 : 1, skipped: false };
    }, ...options });
  run.on('event', event => {
    if (event.type === 'user.question') {
      approvals.push(event);
      if (approve !== null) run.answer(event.id, { accept: typeof approve === 'function' ? approve(approvals.length) : approve });
    }
  });
  t.after(async () => { run.cancel(); await delay(20); await rm(scratchRoot, { recursive: true, force: true }); });
  void run.start();
  return { run, calls, approvals, modelInputs, content: () => content };
}

test('real ALLEN filters unchanged files, gates exact changes, runs tools and returns typed success', async t => {
  const fixture = await create(t, { judge: async () => ({ summary: 'Fix one file', changes: [
    { path: 'same.js', before: 'unchanged', after: 'unchanged' }, { path: 'code.js', before: 'old', after: 'fixed' },
  ] }) });
  const result = await fixture.run.done;
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.deepEqual(result.result.output, { summary: 'Fix one file', accepted: true, passed: true, changed: 1, attempts: 1, test_output: 'PASS' });
  assert.deepEqual(fixture.calls.map(call => call.name), ['inspect_workspace', 'apply_changes', 'run_tests']);
  assert.equal(fixture.approvals.length, 1);
  assert.deepEqual(fixture.approvals[0].prompt.data.value.changes, fixture.calls[1].input.changes);
  const toolStart = fixture.run.events.find(event => event.type === 'tool.started' && event.tool === 'apply_changes');
  const toolEnd = fixture.run.events.find(event => event.type === 'tool.completed' && event.id === toolStart.id);
  assert.deepEqual(toolEnd.value, { changed: ['code.js'] });
  assert.equal(result.counters.modelForwardingEnvelopes, 0);
});

test('real ALLEN repairs twice using fresh snapshots and observed failures, approving all three patches', async t => {
  const fixture = await create(t, { testResults: [false, false, true], judge: async ({ prompt }, attempt) => ({
    summary: `Repair ${attempt}`, changes: [{ path: 'code.js', before: prompt.data.value.files[0].content, after: `version${attempt}` }],
  }) });
  const result = await fixture.run.done;
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.equal(result.result.output.attempts, 3); assert.equal(result.result.output.passed, true);
  assert.equal(fixture.approvals.length, 3); assert.equal(fixture.calls.length, 9);
  assert.deepEqual(fixture.modelInputs.map(value => value.files[0].content), ['old', 'version1', 'version2']);
  assert.match(fixture.modelInputs[1].previous_test_output, /FAIL/);
});

test('repair loop stops after three judgments and reports remaining test failures', async t => {
  const fixture = await create(t, { testResults: [false, false, false], judge: async ({ prompt }, attempt) => ({
    summary: `Repair ${attempt}`, changes: [{ path: 'code.js', before: prompt.data.value.files[0].content, after: `v${attempt}` }],
  }) });
  const result = await fixture.run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.result.output.passed, false);
  assert.equal(result.result.output.attempts, 3); assert.equal(result.counters.modelJudgments, 3);
});

test('declining the first patch never mutates files or launches tests', async t => {
  const fixture = await create(t, { approve: false }); const result = await fixture.run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.result.output.accepted, false);
  assert.equal(result.result.output.changed, 0); assert.equal(fixture.content(), 'old');
  assert.deepEqual(fixture.calls.map(call => call.name), ['inspect_workspace']);
});

test('declining repair preserves earlier edits and reports their count without claiming success', async t => {
  const fixture = await create(t, { approve: number => number === 1, testResults: [false], judge: async ({ prompt }, number) => ({
    summary: 'Repair', changes: [{ path: 'code.js', before: prompt.data.value.files[0].content, after: `v${number}` }],
  }) });
  const result = await fixture.run.done;
  assert.equal(result.result.output.accepted, false); assert.equal(result.result.output.changed, 1);
  assert.equal(result.result.output.passed, false); assert.equal(fixture.content(), 'v1');
});

test('empty/no-op proposals explain themselves without claiming tests passed', async t => {
  const fixture = await create(t, { judge: async () => ({ summary: 'Cannot implement from the available context', changes: [] }) });
  const result = await fixture.run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.result.output.passed, false);
  assert.equal(result.result.output.accepted, false); assert.equal(fixture.approvals.length, 0);
  assert.deepEqual(fixture.calls.map(call => call.name), ['inspect_workspace']);
});

test('nine changed files stop before approval or mutation', async t => {
  const fixture = await create(t, { judge: async () => ({ summary: 'Too broad', changes: Array.from({ length: 9 }, (_, i) => ({ path: `${i}.js`, before: '', after: 'new' })) }) });
  const result = await fixture.run.done;
  assert.equal(result.state, 'stopped'); assert.equal(fixture.approvals.length, 0);
  assert.equal(fixture.calls.length, 1);
});

test('cancel pending custom tool aborts signal and ignores late output', async t => {
  let resolveTool; let signal;
  const fixture = await create(t, { toolHandler: (_name, _input, context) => {
    signal = context.signal;
    return new Promise(resolve => { resolveTool = resolve; });
  } });
  while (!resolveTool) { if (fixture.run.result) assert.fail(JSON.stringify(fixture.run.result)); await delay(5); }
  fixture.run.cancel(); assert.equal(signal.aborted, true);
  resolveTool({ files: [], summary: 'late' }); await delay(20);
  assert.equal((await fixture.run.done).state, 'cancelled');
  assert.equal(fixture.run.counters.modelJudgments, 0);
  assert.equal(fixture.run.events.filter(event => event.type === 'tool.completed').length, 0);
});

test('custom tool output schemas reject malformed values before model execution', async t => {
  const fixture = await create(t, { toolHandler: async () => ({ files: [], summary: 42 }) });
  const result = await fixture.run.done;
  assert.equal(result.state, 'failed'); assert.match(result.result.error, /Schema rejected/);
  assert.equal(result.counters.modelJudgments, 0);
});

test('skipped tests are never marked passing or sent into a pointless repair loop', async t => {
  const fixture = await create(t, { toolHandler: async name => {
    if (name === 'inspect_workspace') return { files: [{ path: 'code.js', content: 'old' }], summary: '' };
    if (name === 'apply_changes') return { changed: ['code.js'] };
    return { passed: true, skipped: true, exitCode: 0, output: 'No test command configured' };
  } });
  const result = await fixture.run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.result.output.passed, false);
  assert.equal(result.counters.modelJudgments, 1);
});

test('verification-only ALLEN runs configured tests with no judgment, edits, or approval', async t => {
  const verify = await readFile(new URL('../workflows/verify.allen', import.meta.url), 'utf8');
  for (const [passed, skipped] of [[true, false], [false, false], [false, true]]) {
    const fixture = await create(t, { source: verify, maxModelJudgments: 0,
      judge: () => assert.fail('Verification must not call a model'),
      toolHandler: async name => {
        assert.equal(name, 'run_tests');
        return { passed, skipped, exitCode: passed ? 0 : 1, output: skipped ? 'Not configured' : passed ? 'PASS existing tests' : 'FAIL existing tests' };
      } });
    const result = await fixture.run.done;
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.result.output.passed, passed && !skipped);
    assert.equal(result.result.output.accepted, true);
    assert.equal(result.result.output.changed, 0);
    assert.equal(result.result.output.attempts, 0);
    assert.equal(result.counters.modelJudgments, 0);
    assert.equal(fixture.approvals.length, 0);
    assert.deepEqual(fixture.calls.map(call => call.name), ['run_tests']);
    if (skipped) assert.match(result.result.output.summary, /not run/);
  }
});
