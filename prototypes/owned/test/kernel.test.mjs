import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Session, Run, packageRoot } from '../src/kernel.mjs';
import { FixtureProvider } from '../src/provider.mjs';

async function create(t, provider = new FixtureProvider(), options = {}) {
  const scratchRoot = await mkdtemp(resolve(tmpdir(), 'owned-allen-test-'));
  const session = new Session({ provider, scratchRoot, ...options });
  t.after(async () => { session.close(); await delay(30); await rm(scratchRoot, { recursive: true, force: true }); });
  return session;
}
async function event(run, type) {
  const found = run.events.find(e => e.type === type); if (found) return found;
  return new Promise((resolveDone, reject) => {
    const timeout = setTimeout(() => { run.off('event', onEvent); reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(run.snapshot())}`)); }, 5000);
    const onEvent = e => { if (e.type === type || e.type === 'run.terminal') { clearTimeout(timeout); run.off('event', onEvent); e.type === type ? resolveDone(e) : reject(new Error(JSON.stringify(e))); } };
    run.on('event', onEvent);
  });
}

test('real ALLEN filters before judgment, writes native draft, waits for exact typed answer and returns typed result', async t => {
  let supplied;
  const fixture = new FixtureProvider();
  const session = await create(t, { judge: async args => { supplied = args.prompt.data.value; return fixture.judge(args); } });
  const run = await session.review(); const question = await event(run, 'user.question');
  assert.deepEqual(supplied.map(ticket => ticket.id), ['T-100', 'T-103']);
  assert.equal(session.status().runs[0].state, 'waiting_user');
  assert.equal(run.counters.automaticProviderReplies, 2);
  assert.throws(() => session.answer('other:r-3', { accept: true }), /Unknown/);
  assert.throws(() => session.answer(question.id, { accept: 'true' }), /Schema rejected/);
  assert.equal(run.state, 'waiting_user');
  session.answer(question.id, { accept: false }, 'test-fixture');
  assert.throws(() => session.answer(question.id, { accept: true }), /Unknown/);
  const result = await run.done;
  assert.equal(result.state, 'completed');
  assert.deepEqual({ ...result.result.output, draft: '', reason: '' }, { accepted: false, draft: '', eligible: 2, reason: '', scanned: 4, ticket_id: 'T-100' });
  assert.equal(result.counters.modelJudgments, 1);
  assert.equal(result.counters.nativeToolCalls, 1);
  assert.equal(result.counters.automaticProviderReplies, 3);
  assert.equal(result.counters.modelForwardingEnvelopes, 0);
  assert.equal((await readdir(run.scratch)).length, 1);
});

test('cancel waiting question, reject late/cross-run answer, and allow a fresh run', async t => {
  const session = await create(t); const first = await session.review();
  const q1 = await event(first, 'user.question'); session.cancel();
  assert.equal((await first.done).state, 'cancelled');
  assert.throws(() => session.answer(q1.id, { accept: true }), /Unknown/);
  const second = await session.review(); const q2 = await event(second, 'user.question');
  assert.throws(() => second.answer(q1.id, { accept: true }), /Unknown/);
  session.answer(q2.id, { accept: true }, 'test-fixture');
  assert.equal((await second.done).state, 'completed');
});

test('cancel pending model aborts provider; a late model resolution cannot dispatch a host tool', async t => {
  let resolveModel; let signal;
  const session = await create(t, { judge: args => { signal = args.signal; return new Promise(resolve => { resolveModel = resolve; }); } });
  const run = await session.review(); await event(run, 'model.started'); await delay(0);
  session.cancel(); assert.equal(signal.aborted, true);
  resolveModel({ ticket_id: 'T-100', reason: 'late' }); await delay(20);
  assert.equal(run.state, 'cancelled'); assert.equal(run.counters.nativeToolCalls, 0);
});

test('malformed and out-of-candidate judgments never report success', async t => {
  for (const value of [{ ticket_id: 7, reason: 'wrong type' }, { ticket_id: 'T-102', reason: 'closed ticket' }]) {
    const session = await create(t, { judge: async () => value });
    const result = await (await session.review()).done;
    assert.notEqual(result.state, 'completed'); assert.equal(result.counters.nativeToolCalls, 0);
  }
});

test('plain chat chooses reply or registered review while own session keeps history', async t => {
  const session = await create(t);
  assert.equal((await session.message('hello')).action, 'reply');
  assert.equal(session.runs.size, 0);
  const action = await session.message('Please triage the synthetic tickets');
  assert.equal(action.action, 'review');
  const question = await event(session.active, 'user.question');
  assert.equal(session.status().chat, 'idle');
  session.answer(question.id, { accept: true }, 'test-fixture');
  assert.equal((await session.active.done).state, 'completed');
  assert.equal(session.chatCalls, 2);
});

test('cancel immediately during async review/read prevents late start', async t => {
  const session = await create(t);
  const launch = session.review(); session.cancel();
  await assert.rejects(launch, /cancelled/); assert.equal(session.runs.size, 0);
  const launchFile = session.runFile(resolve(packageRoot, 'fixtures/review.allen'), resolve(packageRoot, 'fixtures/review.json'));
  session.cancel(); await assert.rejects(launchFile, /cancelled/); assert.equal(session.runs.size, 0);
});

test('cancel model chat prevents a late workflow launch', async t => {
  let resolveChat;
  const session = await create(t, { judge: () => new Promise(resolve => { resolveChat = resolve; }) });
  const chatting = session.message('review please'); session.cancel();
  resolveChat({ action: 'review', text: 'start' }); await assert.rejects(chatting, /cancelled/);
  assert.equal(session.runs.size, 0);
});

test('reusable runner accepts a different pure ALLEN source and rejects invalid source', async t => {
  const session = await create(t);
  assert.equal((await session.start({ source: 'export fn main() returns Int { 6 * 7 }' }).done).result.output, 42);
  assert.equal((await session.start({ source: 'this is not ALLEN' }).done).state, 'failed');
  assert.throws(() => session.start({ source: 'x'.repeat(65537) }), /64 KiB/);
});

test('real VM callback loop stops before exceeding host model budget', async t => {
  const session = await create(t, { judge: async () => ({ answer: true }) });
  const source = `manifest { language: "0.1" entry: main capabilities: [model.request] }
record Answer { answer: Bool }
export async fn main() returns Int effects [model.request] {
  mut count = 0;
  for n in 0..5 {
    let response = await model.request<Answer>(prompt { system: "Judge" output: Answer });
    count += 1;
  }
  count
}`;
  const result = await session.start({ source }).done;
  assert.equal(result.state, 'failed'); assert.match(result.result.error, /budget exhausted/);
  assert.equal(result.counters.modelJudgments, 3);
});

test('generic program may invoke the native draft tool twice', async t => {
  const session = await create(t);
  const source = `manifest { language: "0.1" entry: main capabilities: [] tools: { required: [{ name: "review_draft", version: ">=1.0.0, <2.0.0" }] } }
export async fn main() returns String effects [tool.review_draft@1] {
 let one = await tools.review_draft.call({ ticket_id: "one", reason: "First" });
 let two = await tools.review_draft.call({ ticket_id: "two", reason: "Second" });
 "done"
}`;
  const run = session.start({ source }); const result = await run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.counters.nativeToolCalls, 2);
  assert.equal((await readdir(run.scratch)).length, 2);
});

test('unexpected VM exit is interruption, not resumable completion', async t => {
  const session = await create(t); const run = await session.review(); await event(run, 'user.question');
  run.transport.child.kill('SIGKILL');
  assert.equal((await run.done).state, 'interrupted'); assert.equal(run.effects.size, 0);
});

test('wall budget cancels a pending provider and reports its duration', async t => {
  const session = await create(t, { judge: () => new Promise(() => {}) }, { wallMs: 100 });
  const run = await session.review(); const result = await run.done;
  assert.equal(result.state, 'failed'); assert.match(result.result.error, /wall-time budget expired after 100 ms/);
});

test('run accepts a disabled wall budget while cancellation still aborts work', async t => {
  const session = await create(t, { judge: () => new Promise(() => {}) }, { wallMs: null });
  const run = await session.review(); await event(run, 'model.started');
  session.cancel();
  assert.equal((await run.done).state, 'cancelled');
});

test('provider requests carry their origin: site line, loop iteration and the static tables', async t => {
  const session = await create(t);
  const source = `manifest { language: "0.1" entry: main capabilities: [] tools: { required: [{ name: "review_draft", version: ">=1.0.0, <2.0.0" }] } }
export async fn main() returns Int effects [tool.review_draft@1] {
  mut count = 0;
  for ticket in ["one", "two", "three"] {
    let draft = await tools.review_draft.call({ ticket_id: ticket, reason: "Loop" });
    count += 1;
  }
  count
}`;
  const run = session.start({ source }); const result = await run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.result.output, 3);
  const loaded = run.events.find(e => e.type === 'program.loaded');
  assert.deepEqual(loaded.constructs.map(c => [c.id, c.kind, c.line, c.column]), [[0, 'for', 4, 3]]);
  assert.deepEqual(loaded.sites.map(s => [s.id, s.kind, s.tool, s.line, s.constructs]), [[0, 'tool', 'review_draft', 5, [0]]]);
  const started = run.events.filter(e => e.type === 'tool.started');
  assert.deepEqual(started.map(e => e.origin.scope.map(entry => [entry.kind, entry.construct, entry.region, entry.instance, entry.iteration])),
    [[['for', 0, 'body', 1, 1]], [['for', 0, 'body', 1, 2]], [['for', 0, 'body', 1, 3]]]);
  for (const { origin } of started) {
    assert.equal(origin.task, 0);
    assert.deepEqual([origin.site.id, origin.site.source, origin.site.line, origin.site.column], [0, 'src/main.allen', 5, 17]);
    assert.equal(source.slice(origin.site.start, origin.site.end), 'await tools.review_draft.call({ ticket_id: ticket, reason: "Loop" })');
  }
  assert.deepEqual(run.events.filter(e => e.type === 'effect.requested').map(e => e.origin.scope[0].iteration), [1, 2, 3]);
});

test('model and user callbacks carry the origin of their source line', async t => {
  const session = await create(t);
  const run = await session.review(); const question = await event(run, 'user.question');
  const model = run.events.find(e => e.type === 'model.started');
  assert.deepEqual([model.origin.site.line, model.origin.scope], [17, []]);
  assert.deepEqual([question.origin.site.line, question.origin.task], [30, 0]);
  assert.equal(run.events.find(e => e.type === 'tool.started').origin.site.line, 26);
  session.answer(question.id, { accept: false }, 'test-fixture');
  assert.equal((await run.done).state, 'completed');
});

test('model.worker events carry the id of the judgment they report on', async t => {
  const session = await create(t, { judge: async ({ onEvent }) => { onEvent({ provider: 'test', usage: { inputTokens: 3 } }); return { answer: true }; } });
  const source = `manifest { language: "0.1" entry: main capabilities: [model.request] }
record Answer { answer: Bool }
export async fn main() returns Int effects [model.request] {
  mut count = 0;
  for n in 0..2 {
    let response = await model.request<Answer>(prompt { system: "Judge" output: Answer });
    count += 1;
  }
  count
}`;
  const run = session.start({ source }); const result = await run.done;
  assert.equal(result.state, 'completed');
  const judgments = run.events.filter(e => e.type === 'model.started').map(e => e.id);
  assert.equal(new Set(judgments).size, 2);
  const workers = run.events.filter(e => e.type === 'model.worker');
  assert.deepEqual(workers.map(e => [e.id, e.provider, e.usage.inputTokens]), judgments.map(id => [id, 'test', 3]));
});

test('a program that does not compile fails with the compiler diagnostics from program/load', async t => {
  const session = await create(t);
  const source = 'export fn main() returns Int {\n  let value = 1;\n  value + missing\n}\n';
  const result = await session.start({ source }).done;
  assert.equal(result.state, 'failed');
  assert.match(result.result.error, /^Program does not compile:\nsrc\/main\.allen:3:11: error\[E\d+\]: /);
  const [diagnostic] = result.result.diagnostics;
  assert.deepEqual([diagnostic.source, diagnostic.line, diagnostic.column, diagnostic.end_line, diagnostic.end_column], ['src/main.allen', 3, 11, 3, 18]);
  assert.equal(source.slice(diagnostic.start, diagnostic.end), 'missing');
  assert.equal(diagnostic.severity, 'error');
});

// Every response-type descriptor JOSH can send. The program returns what JOSH decoded, so the
// run output is JOSH's own encoding of the accepted answer.
const allKinds = `manifest { language: "0.1" entry: main capabilities: [model.request, user.ask] }
enum Color { Red Blue }
enum Shape { Dot Line(Int, String) Box { width: Float } }
newtype Score = Int
record Answer {
  name: Option<String>
  missing: Option<Int>
  ratio: Float
  whole: Float
  color: Color
  line: Shape
  box: Shape
  dot: Shape
  counts: Map<String, Int>
  pair: (String, Int)
  score: Score
  tags: List<List<Bool>>
  raw: Bytes
  outcome: Result<Int, String>
  nothing: Void
}
export async fn main(asker: String) returns Answer effects [model.request, user.ask] {
  let reply = if (asker == "user") {
    user.ask<Answer>(prompt { system: "Answer every field" output: Answer policy: { max_attempts: 1 } })
  } else {
    model.request<Answer>(prompt { system: "Answer every field" output: Answer policy: { max_attempts: 1 } })
  };
  match await reply {
    Ok(answer) => answer
    Err(error) => stop(error.code)
  }
}`;
const modelShaped = {
  name: { tag: 'Some', value: 'Ada' }, missing: { tag: 'None' }, ratio: 0.25, whole: 3, color: 'Blue',
  line: { tag: 'Line', value: { 0: 7, 1: 'seven' } }, box: { tag: 'Box', value: { width: 2 } }, dot: { tag: 'Dot' },
  counts: [{ key: 'é', value: 2 }, { key: 'b', value: 1 }], pair: { 0: 'x', 1: -4 }, score: 9,
  tags: [[true], []], raw: { $bytes: 'aGk=' }, outcome: { tag: 'Err', value: 'no' }, nothing: null,
};
// JOSH's encoding: tagged unions, tuples as arrays, maps as sorted [key, value] pairs.
const wireShaped = {
  name: { tag: 'Some', value: 'Ada' }, missing: { tag: 'None' }, ratio: 0.25, whole: 3, color: { tag: 'Blue' },
  line: { tag: 'Line', value: [7, 'seven'] }, box: { tag: 'Box', value: { width: 2 } }, dot: { tag: 'Dot' },
  counts: [['b', 1], ['é', 2]], pair: ['x', -4], score: 9,
  tags: [[true], []], raw: { $bytes: 'aGk=' }, outcome: { tag: 'Err', value: 'no' }, nothing: null,
};

test('model.request answers of every response type reach the program through JOSH', async t => {
  let schema;
  const session = await create(t, { judge: async args => { schema = args.schema; return structuredClone(modelShaped); } });
  const result = await session.start({ source: allKinds, input: 'model' }).done;
  assert.equal(result.state, 'completed', JSON.stringify(result.result));
  assert.deepEqual(result.result.output, wireShaped);
  // The schema uses only keywords both structured-output modes accept.
  const keywords = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) { if (key !== 'properties') keywords.add(key); walk(key === 'properties' ? Object.values(value) : value); }
  })(schema);
  assert.deepEqual([...keywords].sort(), ['additionalProperties', 'anyOf', 'enum', 'items', 'required', 'type']);
  assert.deepEqual(schema.properties.color, { type: 'string', enum: ['Red', 'Blue'] });
  assert.deepEqual(schema.properties.pair.required, ['0', '1']);
});

test('user.ask answers of every response type are validated, translated and decoded', async t => {
  const session = await create(t);
  const run = session.start({ source: allKinds, input: 'user' });
  const question = await event(run, 'user.question');
  assert.deepEqual([question.attempt, typeof question.interaction, question.issues], [1, 'string', undefined]);
  assert.throws(() => session.answer(question.id, { ...modelShaped, color: { tag: 'Blue' } }), /Schema rejected/);
  session.answer(question.id, structuredClone(modelShaped), 'test-fixture');
  const result = await run.done;
  assert.equal(result.state, 'completed', JSON.stringify(result.result));
  assert.deepEqual(result.result.output, wireShaped);
});

const judged = (maxAttempts = null) => `manifest { language: "0.1" entry: main capabilities: [model.request] }
record Verdict { score: Int reason: String }
export async fn main() returns String effects [model.request] {
  match await model.request<Verdict>(prompt { system: "Judge" output: Verdict${maxAttempts ? ` policy: { max_attempts: ${maxAttempts} }` : ''} }) {
    Ok(verdict) => \`ok \${to_string(verdict.score)} \${verdict.reason}\`
    Err(error) => \`err \${error.code}\`
  }
}`;
const scripted = answers => {
  const calls = [];
  return { calls, judge: async args => { calls.push(args); const next = answers[Math.min(calls.length, answers.length) - 1]; if (next instanceof Error) throw next; return structuredClone(next); } };
};

test('JOSH re-asks after an invalid model answer and the program gets the valid retry', async t => {
  const provider = scripted([{ score: 'high', reason: 'looks fine' }, { score: 8, reason: 'looks fine' }]);
  const session = await create(t, provider);
  const run = session.start({ source: judged() }); const result = await run.done;
  assert.equal(result.result.output, 'ok 8 looks fine');
  assert.equal(result.counters.modelJudgments, 2);
  const started = run.events.filter(e => e.type === 'model.started');
  assert.deepEqual(started.map(e => [e.interaction, e.attempt, e.issues]), [
    [started[0].interaction, 1, undefined], [started[0].interaction, 2, [{ path: '/score', code: 'type' }]]]);
  assert.deepEqual(run.events.filter(e => e.type === 'effect.requested').map(e => e.attempt), [1, 2]);
  const [rejected] = run.events.filter(e => e.type === 'model.rejected');
  assert.deepEqual(rejected, { ...rejected, id: started[0].id, interaction: started[0].interaction, attempt: 1, issues: [{ path: '/score', code: 'type' }] });
  assert.ok(run.events.indexOf(rejected) < run.events.indexOf(started[1]));
  assert.deepEqual(run.events.filter(e => e.type === 'model.completed').map(e => e.valid), [false, undefined]);
  // The second attempt tells the model what was wrong.
  assert.equal(provider.calls[1].attempt, 2);
  assert.match(provider.calls[1].prompt.system, /^Judge\n\nThis is attempt 2 of 3\. .*\n- \/score: wrong type\n/s);
  assert.equal(provider.calls[0].prompt.system, 'Judge');
});

test('when every attempt is invalid the program takes its Err branch', async t => {
  const provider = scripted([{ score: 1 }]);
  const session = await create(t, provider);
  const run = session.start({ source: judged(2) }); const result = await run.done;
  assert.equal(result.state, 'completed');
  assert.equal(result.result.output, 'err model.validation_failed');
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(run.events.filter(e => e.type === 'model.rejected').map(e => [e.attempt, e.issues]), [[1, [{ path: '/reason', code: 'required' }]]]);
});

test('max_attempts 1 returns Err after one invalid answer, and unparseable answers are retried', async t => {
  const once = scripted([{ score: 'x', reason: 'y' }]);
  const first = await create(t, once);
  const run = first.start({ source: judged(1) }); const result = await run.done;
  assert.equal(result.result.output, 'err model.validation_failed');
  assert.equal(once.calls.length, 1);
  assert.equal(run.events.filter(e => e.type === 'model.rejected').length, 0);

  const garbled = scripted([Object.assign(new Error('not JSON'), { code: 'invalid_answer' }), { score: 3, reason: 'ok' }]);
  const second = await create(t, garbled);
  const retried = second.start({ source: judged() }); const outcome = await retried.done;
  assert.equal(outcome.result.output, 'ok 3 ok');
  assert.match(garbled.calls[1].prompt.system, /- the answer was not a JSON value/);
  assert.equal(retried.events.find(e => e.type === 'model.completed').value, null);
});

test('a model refusal is model.denied for the program; other provider failures still fail the run', async t => {
  const refused = await create(t, scripted([Object.assign(new Error('Claude declined this request.'), { code: 'refusal' })]));
  const run = refused.start({ source: judged() }); const result = await run.done;
  assert.equal(result.result.output, 'err model.denied');
  assert.deepEqual(run.events.find(e => e.type === 'effect.rejected').code, 'model.denied');
  const broken = await create(t, scripted([new Error('network down')]));
  const failed = await broken.start({ source: judged() }).done;
  assert.equal(failed.state, 'failed'); assert.match(failed.result.error, /network down/);
});

test('every attempt counts against the model judgment budget', async t => {
  const scratchRoot = await mkdtemp(resolve(tmpdir(), 'owned-allen-budget-'));
  t.after(() => rm(scratchRoot, { recursive: true, force: true }));
  const provider = scripted([{ score: 'bad', reason: 'r' }]);
  const run = new Run({ provider, source: judged(3), input: null, scratchRoot, maxModelJudgments: 2 });
  void run.start(); const result = await run.done;
  assert.equal(result.state, 'failed'); assert.match(result.result.error, /Model judgment budget exhausted \(2 per run\)/);
  assert.equal(provider.calls.length, 2);
});

test('a repeated map key is rejected by JOSH, reported on the model-shape path, and fixed on retry', async t => {
  const provider = scripted([{ counts: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] }, { counts: [{ key: 'b', value: 2 }, { key: 'a', value: 1 }] }]);
  const session = await create(t, provider);
  const source = `manifest { language: "0.1" entry: main capabilities: [model.request] }
record Tally { counts: Map<String, Int> }
export async fn main() returns List<String> effects [model.request] {
  match await model.request<Tally>(prompt { system: "Count" output: Tally }) {
    Ok(tally) => map.keys(tally.counts)
    Err(error) => [error.code]
  }
}`;
  const run = session.start({ source }); const result = await run.done;
  assert.deepEqual(result.result.output, ['a', 'b']);
  assert.deepEqual(run.events.find(e => e.type === 'model.rejected').issues, [{ path: '/counts/1/key', code: 'order' }]);
  assert.match(provider.calls[1].prompt.system, /- \/counts\/1\/key: repeated key \(map keys must be distinct\)/);
});

test('an oversized model answer fails the run at once instead of stranding it', async t => {
  const session = await create(t, { judge: async () => ({ text: 'x'.repeat(1100000) }) }, { wallMs: 5000 });
  const source = `manifest { language: "0.1" entry: main capabilities: [model.request] }
record Answer { text: String }
export async fn main() returns String effects [model.request] {
  match await model.request<Answer>(prompt { system: "Say" output: Answer }) { Ok(v) => v.text Err(e) => e.code }
}`;
  const run = session.start({ source }); const result = await run.done;
  assert.equal(result.state, 'failed');
  assert.match(result.result.error, /frame/);
  assert.doesNotMatch(result.result.error, /wall-time/);
  assert.ok(run.events.some(e => e.type === 'effect.failed'));
});

test('an oversized user answer is refused and the question stays answerable', async t => {
  const session = await create(t);
  const source = `manifest { language: "0.1" entry: main capabilities: [user.ask] }
export async fn main() returns String effects [user.ask] {
  match await user.ask<String>(prompt { system: "Name?" output: String }) { Ok(v) => v Err(e) => e.code }
}`;
  const run = session.start({ source }); const question = await event(run, 'user.question');
  assert.throws(() => run.answer(question.id, 'x'.repeat(1100000)), /frame/);
  assert.equal(run.state, 'waiting_user');
  assert.deepEqual(run.snapshot().pending.map(e => e.id), [question.id]);
  assert.ok(!run.events.some(e => e.type === 'user.answered'), 'a refused answer is not recorded as given');
  run.answer(question.id, 'Ada');
  const result = await run.done;
  assert.equal(result.state, 'completed'); assert.equal(result.result.output, 'Ada');
});

test('a run starts only once', async t => {
  const session = await create(t);
  const run = session.start({ source: 'export fn main() returns Int { 6 * 7 }' });
  await assert.rejects(run.start(), /only once/);
  const result = await run.done;
  assert.equal(result.result.output, 42);
  assert.equal(run.events.filter(e => e.type === 'run.started').length, 1);
});

test('a question the runtime cancels leaves the waiting state', async t => {
  const session = await create(t, { judge: async () => ({ answer: true }) });
  // The second task's stop cancels the first task's pending question.
  const source = `manifest { language: "0.1" entry: main capabilities: [user.ask, model.request] }
record Answer { answer: Bool }
async fn ask() returns Bool effects [user.ask] {
  match await user.ask<Bool>(prompt { system: "Continue?" output: Bool }) { Ok(v) => v Err(_) => false }
}
async fn quit() returns Bool effects [model.request] {
  let r = match await model.request<Answer>(prompt { system: "Judge" output: Answer }) { Ok(v) => v.answer Err(_) => false };
  stop("enough")
}
export async fn main() returns Bool effects [task.spawn, user.ask, model.request] {
  await {
    let a = spawn ask();
    let b = spawn quit();
    let x = await a;
    let z = await b;
    x
  }
}`;
  const run = session.start({ source });
  let state;
  run.on('event', e => { if (e.type === 'effect.cancelled') state = run.state; });
  const result = await run.done;
  assert.equal(result.state, 'stopped');
  assert.equal(state, 'running');
});
