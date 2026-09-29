import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function joshBinary() {
  if (process.env.JOSH_BIN) return process.env.JOSH_BIN;
  for (let dir = ROOT; dirname(dir) !== dir; dir = dirname(dir)) {
    const p = resolve(dir, ".cache/josh-allen/target/debug/josh");
    if (existsSync(p)) return p;
  }
  throw Error("Run tools/setup-josh.sh or set JOSH_BIN");
}
export const fixture = JSON.parse(
  readFileSync(resolve(ROOT, "fixtures/findings.json"), "utf8"),
);
export const source = readFileSync(
  resolve(ROOT, "fixtures/review.allen"),
  "utf8",
);
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const tools = [
  {
    name: "review.save",
    version: "1.0.0",
    description:
      "Return a deterministic receipt for a synthetic review; no external side effect.",
    input_schema: object({
      count: { type: "integer", minimum: 0, maximum: 1000 },
      recommend: { type: "boolean" },
    }),
    output_schema: object({ receipt: { type: "string" } }),
    error_schema: object({ message: { type: "string" } }),
    effects: [],
    idempotency: "idempotent",
  },
];
export class JoshRun extends EventEmitter {
  constructor({
    judge,
    sessionId = `local-${randomUUID()}`,
    wallMs = 120000,
    program = source,
    input = fixture,
    cancelGraceMs = 1000,
    killGraceMs = 1000,
  } = {}) {
    super();
    this.judge = judge;
    this.sessionId = sessionId;
    this.wallMs = wallMs;
    this.program = program;
    this.input = input;
    // Cancellation waits at most cancelGraceMs for JOSH to settle the execution, then
    // terminates the process: SIGTERM, and SIGKILL after killGraceMs.
    this.cancelGraceMs = cancelGraceMs;
    this.killGraceMs = killGraceMs;
    this.id = randomUUID();
    this.state = "new";
    this.pending = new Map();
    this.seq = 0;
    this.question = null;
    // Provider requests in flight, by JOSH wire id, so a runtime cancel frame can abort them.
    this.callbacks = new Map();
    this.counters = {
      modelJudgments: 0,
      toolInvocations: 0,
      userQuestions: 0,
      deterministicDispatches: 0,
      modelForwardingEnvelopes: 0,
    };
    this.trace = [];
    this.abort = new AbortController();
    this.budgets = { model: 3, tools: 16, questions: 8 };
  }
  event(type, data = {}) {
    const e = { seq: this.trace.length + 1, type, ...data };
    this.trace.push(e);
    this.emit("trace", e);
  }
  status() {
    return {
      runId: this.id,
      state: this.state,
      question: this.question
        ? { id: this.question.id, prompt: this.question.prompt }
        : null,
      counters: { ...this.counters },
      outcome: this.outcome,
    };
  }
  send(value) {
    const b = Buffer.from(JSON.stringify({ protocol: "josh/1", ...value }));
    if (b.length > 1048576) throw Error("Outgoing JOSH frame exceeds limit");
    this.child.stdin.write(
      Buffer.concat([
        Buffer.from(
          `Content-Length: ${b.length}\r\nContent-Type: application/josh+json; charset=utf-8\r\n\r\n`,
        ),
        b,
      ]),
    );
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = `host-${++this.seq}`;
      this.pending.set(id, { resolve, reject });
      this.send({ kind: "request", id, method, params });
    });
  }
  fail(error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  // Resolves true once the JOSH process has exited, or false after ms.
  waitExit(ms) {
    let timer;
    return Promise.race([
      this.exited.then(() => true),
      new Promise((r) => (timer = setTimeout(() => r(false), ms))),
    ]).finally(() => clearTimeout(timer));
  }
  // Ends the JOSH process without relying on it to cooperate: SIGTERM, then SIGKILL.
  terminate() {
    this.terminating ??= (async () => {
      if (this.hasExited) return;
      try {
        this.child.stdin.end();
      } catch {}
      this.child.kill("SIGTERM");
      if (await this.waitExit(this.killGraceMs)) return;
      this.event("process.killed");
      this.child.kill("SIGKILL");
      await this.waitExit(this.killGraceMs);
    })();
    return this.terminating;
  }
  // JOSH cancelled one of its provider requests: abort the work and never answer it.
  cancelCallback(id) {
    const callback = this.callbacks.get(id);
    if (!callback || callback.abort.signal.aborted) return;
    callback.abort.abort();
    if (this.question?.wireId === id) {
      this.question.reject(Error("Cancelled by the runtime"));
      this.question = null;
      if (this.state === "waiting") this.state = "running";
    }
    this.event("provider.cancelled", { method: callback.method });
  }
  async handle(m) {
    if (m.protocol !== "josh/1") {
      this.fail(Error("Invalid JOSH protocol"));
      this.child.kill();
      return;
    }
    if (m.kind === "response") {
      const p = this.pending.get(m.id);
      if (!p) {
        this.fail(Error("Unknown JOSH response"));
        this.child.kill();
        return;
      }
      this.pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.kind === "notification") {
      if (m.method === "runtime/ready") this.emit("ready");
      return;
    }
    if (m.kind === "cancel") return this.cancelCallback(m.id);
    if (m.kind !== "request") return;
    if (this.abort.signal.aborted) return;
    const p = m.params;
    const callback = { method: m.method, abort: new AbortController() };
    this.callbacks.set(m.id, callback);
    // Aborted when the run is cancelled or when JOSH cancels this request.
    const signal = AbortSignal.any([this.abort.signal, callback.abort.signal]);
    this.counters.deterministicDispatches++;
    this.event("provider.request", { method: m.method });
    try {
      if (p.execution_id !== this.id) throw Error("Cross-run provider request");
      let result;
      if (m.method === "model/request") {
        if (this.counters.modelJudgments >= this.budgets.model)
          throw Error("Model judgment budget exhausted");
        this.counters.modelJudgments++;
        result = { value: await this.judge(p, signal) };
      } else if (m.method === "tool/invoke") {
        if (
          p.name !== "review.save" &&
          p.tool !== "review.save" &&
          p.tool_name !== "review.save"
        )
          throw Error("Unauthorized tool");
        if (this.counters.toolInvocations >= this.budgets.tools)
          throw Error("Tool budget exhausted");
        this.counters.toolInvocations++;
        result = {
          outcome: "ok",
          value: { receipt: `review:${p.input.count}:${p.input.recommend}` },
        };
      } else if (m.method === "user/ask") {
        if (p.response_schema.descriptor.type !== "boolean")
          throw Error("This prototype supports Boolean user answers only");
        if (this.question)
          throw Error("Only one user question may wait at once");
        if (this.counters.userQuestions >= this.budgets.questions)
          throw Error("User question budget exhausted");
        this.counters.userQuestions++;
        this.state = "waiting";
        const id = `${this.id}:${m.id}`;
        const value = await new Promise((resolve, reject) => {
          this.question = {
            id,
            wireId: m.id,
            prompt: p.prompt,
            resolve,
            reject,
          };
          this.event("user.question", { id, prompt: p.prompt });
          this.emit("question", this.status().question);
        });
        result = { value };
        this.state = "running";
      } else throw Error(`Unsupported provider ${m.method}`);
      // A late result for a cancelled request is dropped.
      if (signal.aborted) return;
      this.send({ kind: "response", id: m.id, result });
      this.event("provider.resolved", { method: m.method });
    } catch (error) {
      if (callback.abort.signal.aborted) return;
      this.event("provider.rejected", {
        method: m.method,
        reason: error.message,
      });
      if (!signal.aborted)
        this.send({
          kind: "response",
          id: m.id,
          error: {
            code: m.method.startsWith("model/")
              ? "model.unavailable"
              : m.method.startsWith("user/")
                ? "user.unavailable"
                : "tool.unavailable",
            message: "Native provider rejected request",
          },
        });
    } finally {
      this.callbacks.delete(m.id);
    }
  }
  answer(id, value) {
    if (this.state !== "waiting" || !this.question || this.question.id !== id)
      throw Error("No matching pending question");
    if (typeof value !== "boolean") throw Error("Answer must be a Boolean");
    const q = this.question;
    this.question = null;
    q.resolve(value);
  }
  cancel() {
    if (this.cancelling) return this.cancelling;
    if (["completed", "failed", "cancelled"].includes(this.state))
      return Promise.resolve();
    this.state = "cancelled";
    this.abort.abort();
    if (this.question) {
      this.question.reject(Error("Cancelled"));
      this.question = null;
    }
    this.event("cancel.requested");
    this.cancelling = (async () => {
      if (!this.child) return;
      // JOSH cancels an execution when the host sends a cancel frame for its
      // execution/start request. Its acknowledgement (the terminal response) is
      // awaited for a bounded time only.
      if (this.execution && this.pending.has(this.execution.id)) {
        try {
          this.send({ kind: "cancel", id: this.execution.id });
        } catch {}
        let timer;
        await Promise.race([
          this.execution.done,
          this.exited,
          new Promise((r) => (timer = setTimeout(r, this.cancelGraceMs))),
        ]);
        clearTimeout(timer);
      }
      this.fail(Error("Cancelled"));
      await this.terminate();
    })();
    return this.cancelling;
  }
  async start() {
    if (this.state !== "new") throw Error("JOSH run may start only once");
    if (Buffer.byteLength(this.program) > 65536)
      throw Error("ALLEN source exceeds 64 KiB");
    this.state = "running";
    this.child = spawn(joshBinary(), ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A failed spawn emits "error" without "exit"; a signal exit leaves exitCode null.
    this.exited = new Promise((resolve) => {
      const done = () => {
        this.hasExited = true;
        resolve();
      };
      this.child.once("exit", done);
      this.child.once("error", () => {
        if (this.child.pid === undefined) done();
      });
    });
    let buf = Buffer.alloc(0);
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", () => {
      this.emit("exit");
      this.fail(Error("JOSH exited"));
    });
    this.child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (buf.length) {
          let at = buf.indexOf("\r\n\r\n");
          if (at < 0) {
            if (buf.length > 4096) throw Error("Oversized frame header");
            break;
          }
          const header = buf.subarray(0, at).toString();
          const match = /Content-Length: ([0-9]+)/i.exec(header);
          if (
            !match ||
            !/Content-Type: application\/josh\+json; charset=utf-8/i.test(
              header,
            )
          )
            throw Error("Bad frame header");
          const n = Number(match[1]);
          if (n > 1048576) throw Error("Oversized JOSH frame");
          if (buf.length < at + 4 + n) break;
          const m = JSON.parse(buf.subarray(at + 4, at + 4 + n));
          buf = buf.subarray(at + 4 + n);
          void this.handle(m);
        }
      } catch (e) {
        this.fail(e);
        this.child.kill();
      }
    });
    const timer = setTimeout(() => {
      this.event("deadline.exceeded");
      void this.cancel();
    }, this.wallMs);
    try {
      await new Promise((res, rej) => {
        this.once("ready", res);
        this.child.once("error", rej);
        this.child.once("exit", () => rej(Error("JOSH exited before ready")));
        this.abort.signal.addEventListener(
          "abort",
          () => rej(Error("Cancelled")),
          { once: true },
        );
      });
      const host = { name: "codex-native-allen", version: "0.1.0" };
      await this.request("initialize", {
        host,
        protocol_versions: ["josh/1.8"],
        language_versions: [">=0.1.0, <0.2.0"],
        execution_mode: "attached",
        invoking_session_id: this.sessionId,
        limits: {
          max_frame_bytes: 1048576,
          max_active_requests: 64,
          max_loaded_programs: 1,
          max_total_executions: 1,
          max_catalog_tools: 128,
          max_catalog_bytes: 1048576,
        },
        standard_capabilities: [],
        extensions: [],
      });
      const metadata = {
        source: "codex-native-allen restricted review tool registry",
        source_revision: "0.1.0",
        observed_at_unix_ms: Date.now(),
        freshness: "current",
        complete: true,
      };
      const sections = [
        "tools",
        "resources",
        "attachments",
        "transcript",
        "models",
        "user_interaction",
        "agents",
        "roots",
        "permissions",
        "telemetry",
      ].map((kind) => ({
        kind,
        ...metadata,
        item_count: kind === "tools" ? tools.length : 0,
      }));
      await this.request("host/project", {
        profile: "josh.host-projection/0.1",
        projection_id: `p-${this.id}`,
        host,
        session_binding: "prompt_assisted",
        sections,
      });
      await this.request("catalog/set", {
        schema_dialect: "https://json-schema.org/draft/2020-12/schema",
        metadata,
        tools,
      });
      const loaded = await this.request("program/load", {
        format: "source_bundle",
        files: [
          { path: "src/main.allen", encoding: "utf8", content: this.program },
        ],
      });
      if (loaded.required_tools.some((name) => name !== "review.save"))
        throw Error("Program requires unauthorized tool");
      if (this.abort.signal.aborted) throw Error("Cancelled");
      this.event("execution.start", { artifactDigest: loaded.artifact_digest });
      const execution = this.request("execution/start", {
        execution_id: this.id,
        program_id: loaded.program_id,
        artifact_digest: loaded.artifact_digest,
        entry: "main",
        input: this.input,
        working_directory: null,
        granted_capabilities: [],
        granted_tools: loaded.required_tools,
        allowed_http_origins: [],
        granted_exec: [],
        granted_exec_environment: [],
        limits: { wall_ms: this.wallMs },
      });
      this.execution = {
        id: `host-${this.seq}`,
        done: execution.catch(() => {}),
      };
      this.outcome = await execution;
      this.state = this.outcome.outcome;
      this.event("execution.terminal", { outcome: this.outcome });
      return this.outcome;
    } catch (e) {
      this.outcome = {
        outcome: this.abort.signal.aborted ? "cancelled" : "failed",
        error: { message: e.message },
      };
      this.state = this.outcome.outcome;
      this.event("execution.terminal", { outcome: this.outcome });
      return this.outcome;
    } finally {
      clearTimeout(timer);
      this.abort.abort();
      if (this.question) {
        this.question.reject(Error("Execution ended"));
        this.question = null;
      }
      await this.terminate();
    }
  }
}
export const fixtureJudge = async () => ({
  recommend: true,
  reason: "FIXTURE: authorization removal and unbounded retries merit review.",
});
