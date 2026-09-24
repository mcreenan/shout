import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Session, packageRoot } from '../src/kernel.mjs';
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

test('wall budget cancels a pending provider', async t => {
  const session = await create(t, { judge: () => new Promise(() => {}) }, { wallMs: 100 });
  const run = await session.review(); const result = await run.done;
  assert.equal(result.state, 'failed'); assert.match(result.result.error, /wall-time/);
});
