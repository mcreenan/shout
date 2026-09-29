import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { JoshRun } from "../src/josh.mjs";
import { CodexClient } from "../src/codex.mjs";

// A scripted JOSH peer: answers the handshake, then behaves per FAKE_JOSH_MODE.
//   stall     answers nothing after execution/start and ignores cancel frames
//   stubborn  like stall, and also ignores SIGTERM
//   callbacks sends user/ask r-1 and model/request r-2; on SIGUSR1 it cancels both,
//             on SIGUSR2 it ends the execution as stopped
// Every frame it receives is appended to FAKE_JOSH_LOG.
const fakeJosh = `#!/usr/bin/env node
const fs = require("node:fs");
const mode = process.env.FAKE_JOSH_MODE, log = process.env.FAKE_JOSH_LOG;
fs.writeFileSync(process.env.FAKE_JOSH_PID, String(process.pid));
if (mode === "stubborn") process.on("SIGTERM", () => {});
setInterval(() => {}, 10000);
const send = (m) => {
  const b = Buffer.from(JSON.stringify({ protocol: "josh/1", ...m }));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + b.length + "\\r\\nContent-Type: application/josh+json; charset=utf-8\\r\\n\\r\\n"), b]));
};
let exec;
const params = (extra) => ({ execution_id: exec.params.execution_id, ...extra });
process.on("SIGUSR1", () => { send({ kind: "cancel", id: "r-1" }); send({ kind: "cancel", id: "r-2" }); });
process.on("SIGUSR2", () => send({ kind: "response", id: exec.id, result: { outcome: "stopped", reason: "enough" } }));
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const at = buf.indexOf("\\r\\n\\r\\n");
    if (at < 0) return;
    const n = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, at).toString())[1]);
    if (buf.length < at + 4 + n) return;
    const m = JSON.parse(buf.subarray(at + 4, at + 4 + n).toString());
    buf = buf.subarray(at + 4 + n);
    fs.appendFileSync(log, JSON.stringify(m) + "\\n");
    if (m.kind !== "request") continue;
    // A stalled runtime answers nothing once the execution has started.
    if (exec && mode !== "callbacks") continue;
    if (m.method === "program/load") send({ kind: "response", id: m.id, result: { program_id: "p", artifact_digest: "d", required_tools: [] } });
    else if (m.method !== "execution/start") send({ kind: "response", id: m.id, result: {} });
    else {
      exec = m;
      if (mode === "callbacks") {
        send({ kind: "request", id: "r-1", method: "user/ask", params: params({ prompt: {}, response_schema: { descriptor: { type: "boolean" } } }) });
        send({ kind: "request", id: "r-2", method: "model/request", params: params({ prompt: {}, response_schema: { descriptor: { type: "boolean" } } }) });
      }
    }
  }
});
send({ kind: "notification", method: "runtime/ready", params: {} });
`;

async function fixture(t, script, name) {
  const dir = await mkdtemp(resolve(tmpdir(), "native-shutdown-test-"));
  const binary = resolve(dir, name);
  await writeFile(binary, script, { mode: 0o700 });
  const paths = { dir, binary, log: resolve(dir, "log"), pid: resolve(dir, "pid") };
  await writeFile(paths.log, "");
  t.after(async () => {
    try {
      process.kill(Number(await readFile(paths.pid, "utf8")), "SIGKILL");
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  return paths;
}
const frames = async (path) =>
  (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check, what, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error(`Timed out waiting for ${what}`);
}
async function josh(t, mode, options = {}) {
  const paths = await fixture(t, fakeJosh, "josh.cjs");
  const saved = { ...process.env };
  Object.assign(process.env, {
    JOSH_BIN: paths.binary,
    FAKE_JOSH_MODE: mode,
    FAKE_JOSH_LOG: paths.log,
    FAKE_JOSH_PID: paths.pid,
  });
  const r = new JoshRun({ wallMs: 10000, ...options });
  const done = r.start();
  process.env = saved;
  await until(async () => r.trace.some((e) => e.type === "execution.start"), "execution/start");
  const pid = Number(await readFile(paths.pid, "utf8"));
  return { r, done, pid, paths };
}

test(
  "cancel is bounded when JOSH never acknowledges, and uses the cancel frame for execution/start",
  { timeout: 8000 },
  async (t) => {
    const { r, done, pid, paths } = await josh(t, "stall");
    const started = Date.now();
    await r.cancel();
    assert.equal((await done).outcome, "cancelled");
    assert.ok(Date.now() - started < 3000, "cancellation stays bounded");
    assert.equal(alive(pid), false, "the runtime process is reaped");
    const sent = await frames(paths.log);
    const execution = sent.find((m) => m.method === "execution/start");
    assert.ok(sent.some((m) => m.kind === "cancel" && m.id === execution.id));
    assert.ok(!sent.some((m) => m.method === "execution/cancel"), "execution/cancel is not a JOSH method");
  },
);

test(
  "cancel escalates to SIGKILL when JOSH ignores SIGTERM",
  { timeout: 8000 },
  async (t) => {
    const { r, done, pid } = await josh(t, "stubborn");
    const started = Date.now();
    await r.cancel();
    assert.equal((await done).outcome, "cancelled");
    assert.ok(Date.now() - started < 4000, "escalation stays bounded");
    assert.equal(alive(pid), false, "SIGKILL reaps the runtime process");
  },
);

test(
  "the wall deadline ends a stalled execution",
  { timeout: 8000 },
  async (t) => {
    const { r, done, pid } = await josh(t, "stall", { wallMs: 300 });
    const outcome = await done;
    assert.equal(outcome.outcome, "cancelled");
    assert.ok(r.trace.some((e) => e.type === "deadline.exceeded"));
    assert.equal(alive(pid), false);
  },
);

test(
  "runtime cancel frames abort their callbacks, clear the question and suppress late responses",
  { timeout: 8000 },
  async (t) => {
    let signal, release, entered;
    const judged = new Promise((r) => (entered = r));
    const judge = (p, s) => {
      signal = s;
      entered();
      return new Promise((r) => (release = r));
    };
    const { r, done, pid, paths } = await josh(t, "callbacks", { judge });
    const [question] = await Promise.race([
      once(r, "question"),
      until(() => r.status().question && [r.status().question], "question"),
    ]);
    await judged;
    assert.equal(r.status().state, "waiting");
    process.kill(pid, "SIGUSR1");
    await until(
      () => r.trace.filter((e) => e.type === "provider.cancelled").length === 2,
      "both callbacks cancelled",
    );
    assert.equal(signal.aborted, true, "the judgment's signal is aborted");
    assert.equal(r.status().question, null);
    assert.equal(r.status().state, "running");
    assert.throws(() => r.answer(question.id, true), /matching/);
    release(true);
    await new Promise((r) => setTimeout(r, 50));
    process.kill(pid, "SIGUSR2");
    assert.equal((await done).outcome, "stopped");
    const late = (await frames(paths.log)).filter(
      (m) => m.kind === "response" && ["r-1", "r-2"].includes(m.id),
    );
    assert.deepEqual(late, [], "no response is sent for a cancelled callback");
  },
);

// A scripted Codex app-server (JSON lines). Turn 1 completes at once; before answering
// turn/start for turn 2 it replays a stale completion of turn 1; turn/interrupt completes
// the named turn as interrupted.
const fakeCodex = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.153.3"); process.exit(0); }
fs.writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
const log = process.env.FAKE_CODEX_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let turns = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(log, line + "\\n");
  if (m.id === undefined) return;
  const threadId = "thread-1";
  if (m.method === "thread/start") return send({ id: m.id, result: { thread: { id: threadId } } });
  if (m.method === "turn/start") {
    const id = "turn-" + ++turns;
    if (turns === 1) {
      send({ id: m.id, result: { turn: { id } } });
      send({ method: "item/completed", params: { threadId, turnId: id, item: { type: "agentMessage", text: "first" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed" } } });
    } else {
      send({ method: "item/completed", params: { threadId, turnId: "turn-1", item: { type: "agentMessage", text: "stale" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
      send({ id: m.id, result: { turn: { id } } });
    }
    return;
  }
  if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    return send({ method: "turn/completed", params: { threadId, turn: { id: m.params.turnId, status: "interrupted" } } });
  }
  send({ id: m.id, result: {} });
});
`;
async function codex(t) {
  const paths = await fixture(t, fakeCodex, "codex.cjs");
  const saved = { ...process.env };
  Object.assign(process.env, {
    CODEX_BIN: paths.binary,
    FAKE_CODEX_LOG: paths.log,
    FAKE_CODEX_PID: paths.pid,
  });
  const client = new CodexClient();
  t.after(() => client.close());
  try {
    await client.open();
  } finally {
    process.env = saved;
  }
  return { client, paths };
}

test(
  "a reused Codex thread can interrupt its second turn and ignores the first turn's late notifications",
  { timeout: 8000 },
  async (t) => {
    const { client, paths } = await codex(t);
    const thread = await client.thread();
    assert.equal((await client.turn(thread, "one")).text, "first");
    const controller = new AbortController();
    const second = client.turn(thread, "two", { signal: controller.signal });
    second.catch(() => {});
    await until(
      async () => (await frames(paths.log)).filter((m) => m.method === "turn/start").length === 2,
      "second turn/start",
    );
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await assert.rejects(second, /cancelled/);
    const interrupt = await until(
      async () => (await frames(paths.log)).find((m) => m.method === "turn/interrupt"),
      "turn/interrupt",
    );
    assert.equal(interrupt.params.turnId, "turn-2");
  },
);

test(
  "close is bounded after the app-server already died from a signal",
  { timeout: 8000 },
  async (t) => {
    const { client } = await codex(t);
    const exited = once(client.child, "exit");
    process.kill(client.child.pid, "SIGKILL");
    await exited;
    const started = Date.now();
    await client.close();
    assert.ok(Date.now() - started < 2000, "close does not wait for a second exit");
  },
);
