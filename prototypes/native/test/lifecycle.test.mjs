import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { JoshRun, fixtureJudge, source } from "../src/josh.mjs";
const run = (options) =>
  new JoshRun({ judge: fixtureJudge, wallMs: 10000, ...options });
test("real ALLEN filters fixtures and resolves native providers to a typed result", async () => {
  const r = run();
  r.on("question", (q) => r.answer(q.id, true));
  const outcome = await r.start();
  assert.equal(outcome.outcome, "completed");
  assert.equal(outcome.output.candidate_count, 2);
  assert.equal(outcome.output.receipt, "review:2:true");
  assert.deepEqual(r.counters, {
    modelJudgments: 1,
    toolInvocations: 1,
    userQuestions: 1,
    deterministicDispatches: 3,
    modelForwardingEnvelopes: 0,
  });
});
test("question status stays available; invalid, wrong, duplicate and late answers fail", async () => {
  const r = run();
  const question = once(r, "question");
  const done = r.start();
  const [q] = await question;
  assert.equal(r.status().state, "waiting");
  assert.throws(() => r.answer("wrong", true), /matching/);
  assert.throws(() => r.answer(q.id, "true"), /Boolean/);
  r.answer(q.id, false);
  assert.throws(() => r.answer(q.id, true), /matching/);
  const out = await done;
  assert.equal(out.output.approved, false);
  assert.throws(() => r.answer(q.id, true), /matching/);
});
test("answers cannot cross concurrent executions", async () => {
  const a = run(),
    b = run();
  const qa = once(a, "question"),
    qb = once(b, "question");
  const da = a.start(),
    db = b.start();
  const [aq] = await qa,
    [bq] = await qb;
  assert.throws(() => a.answer(bq.id, true), /matching/);
  assert.throws(() => b.answer(aq.id, true), /matching/);
  a.answer(aq.id, true);
  b.answer(bq.id, false);
  assert.equal((await da).output.approved, true);
  assert.equal((await db).output.approved, false);
});
test("cancel awaiting user prevents late continuation", async () => {
  const r = run();
  const q = once(r, "question"),
    done = r.start();
  const [question] = await q;
  await r.cancel();
  assert.equal((await done).outcome, "cancelled");
  assert.throws(() => r.answer(question.id, true), /matching/);
});
test("malformed typed model result fails before tool or user execution", async () => {
  const r = run({
    judge: async () => ({ recommend: "yes", reason: "bad type" }),
  });
  assert.equal((await r.start()).outcome, "failed");
  assert.equal(r.counters.toolInvocations, 0);
  assert.equal(r.counters.userQuestions, 0);
});
test("cancellation aborts pending judgment and ignores its late result", async () => {
  let release, entered;
  const started = new Promise((r) => (entered = r));
  let signal;
  const r = run({
    judge: async (p, s) => {
      signal = s;
      entered();
      return new Promise((r) => (release = r));
    },
  });
  const done = r.start();
  await started;
  await r.cancel();
  release({ recommend: true, reason: "late" });
  assert.equal((await done).outcome, "cancelled");
  assert.equal(signal.aborted, true);
  assert.equal(r.counters.toolInvocations, 0);
});
test("judgment budget prevents additional provider calls", async () => {
  const repeated = source.replace(
    "  let receipt =",
    `  let extra = match await model.request<Judgment>(prompt { system: "Extra" output: Judgment }) { Ok(value) => value Err(_) => fail("Budget exhausted") };\n  let receipt =`,
  );
  const r = run({ program: repeated });
  r.budgets.model = 1;
  assert.equal((await r.start()).outcome, "failed");
  assert.equal(r.counters.modelJudgments, 1);
  assert.ok(
    r.trace.some((e) => e.reason === "Model judgment budget exhausted"),
  );
});
test("run is one-shot and source is bounded", async () => {
  const r = run();
  r.on("question", (q) => r.answer(q.id, true));
  await r.start();
  await assert.rejects(r.start(), /only once/);
  await assert.rejects(run({ program: " ".repeat(65537) }).start(), /64 KiB/);
});
