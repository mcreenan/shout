import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./josh.mjs";
export class CodexClient extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
    this.threads = new Map();
    this.seq = 0;
    this.closed = false;
  }
  async open() {
    const version = execFileSync(
      process.env.CODEX_BIN || "codex",
      ["--version"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (version !== "codex-cli 0.153.3")
      throw Error(
        `Native experimental adapter requires codex-cli 0.153.3; found ${version}`,
      );
    this.cwd = resolve(ROOT, ".scratch/codex-workspace");
    mkdirSync(this.cwd, { recursive: true });
    this.child = spawn(
      process.env.CODEX_BIN || "codex",
      ["app-server", "--listen", "stdio://"],
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.stderr = "";
    this.child.stderr.on("data", (b) => {
      this.stderr = (this.stderr + b.toString()).slice(-8192);
    });
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => this.fail(e));
    this.child.on("exit", () => this.fail(Error("Codex app-server exited")));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.handle(JSON.parse(line));
      } catch (e) {
        this.fail(e);
      }
    });
    await this.rpc("initialize", {
      clientInfo: { name: "josh_native_prototype", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: "initialized", params: {} });
    return this;
  }
  send(m) {
    if (!this.child?.stdin.writable) throw Error("Codex pipe closed");
    this.child.stdin.write(JSON.stringify(m) + "\n");
  }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`Codex RPC timed out: ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.get(id).reject(error);
        this.pending.delete(id);
      }
    });
  }
  fail(e) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const t of this.threads.values()) t.reject?.(e);
    this.threads.clear();
  }
  handle(m) {
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      void this.serverRequest(m).catch(() => {
        try {
          this.send({
            id: m.id,
            error: { code: -32603, message: "Native adapter request failed" },
          });
        } catch {}
      });
      return;
    }
    const p = m.params || {},
      t = this.threads.get(p.threadId);
    if (m.method === "item/started" && t) {
      this.emit("trace", {
        type: "codex.item",
        threadId: p.threadId,
        itemType: p.item.type,
      });
      const allowed =
        ["userMessage", "agentMessage", "reasoning"].includes(p.item.type) ||
        (p.item.type === "dynamicToolCall" &&
          t.onTool &&
          p.item.tool === "allen_run");
      if (!allowed) {
        void this.interrupt(p.threadId);
        t.reject?.(Error(`Unexpected Codex item: ${p.item.type}`));
        return;
      }
    }
    if (m.method === "item/completed" && t && p.item?.type === "agentMessage")
      t.text = p.item.text;
    if (m.method === "turn/completed" && t) {
      t.turnId = p.turn.id;
      t.status = p.turn.status;
      if (t.status === "completed") t.resolve?.({ text: t.text, turn: p.turn });
      else t.reject?.(Error(`Codex turn ${t.status}`));
    }
    if (m.method === "error")
      this.emit("trace", {
        type: "codex.error",
        message: p.error?.message || "Codex error",
      });
  }
  async serverRequest(m) {
    if (m.method === "item/tool/call") {
      const t = this.threads.get(m.params.threadId);
      if (!t?.onTool) {
        this.send({
          id: m.id,
          result: {
            contentItems: [
              { type: "inputText", text: "No tool handler for this thread" },
            ],
            success: false,
          },
        });
        return;
      }
      try {
        const result = await t.onTool(m.params);
        this.send({
          id: m.id,
          result: {
            contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
            success: result.outcome === "completed",
          },
        });
      } catch (e) {
        this.send({
          id: m.id,
          result: {
            contentItems: [
              {
                type: "inputText",
                text: JSON.stringify({ outcome: "failed", error: e.message }),
              },
            ],
            success: false,
          },
        });
      }
    } else
      this.send({
        id: m.id,
        error: { code: -32601, message: "Unsupported host request" },
      });
  }
  async thread({ dynamicTools, instructions } = {}) {
    const r = await this.rpc("thread/start", {
      cwd: this.cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: {},
        features: { apps: false },
        web_search: "disabled",
        project_doc_max_bytes: 0,
        "skills.include_instructions": false,
      },
      developerInstructions:
        instructions ||
        "Complete only the supplied bounded task. Do not inspect files, call tools, or access network.",
      ...(dynamicTools ? { dynamicTools } : {}),
    });
    this.threads.set(r.thread.id, { text: "", turnId: null });
    return r.thread.id;
  }
  async turn(
    threadId,
    text,
    { schema, onTool, signal, timeoutMs = 120000 } = {},
  ) {
    const t = this.threads.get(threadId);
    if (!t) throw Error("Unknown Codex thread");
    t.text = "";
    t.onTool = onTool;
    let timer;
    const done = new Promise((resolve, reject) => {
      t.resolve = resolve;
      t.reject = reject;
      timer = setTimeout(() => {
        void this.interrupt(threadId);
        reject(Error("Codex turn deadline exceeded"));
      }, timeoutMs);
    });
    done.catch(() => {});
    const abort = () => {
      void this.interrupt(threadId);
      t.reject?.(Error("Codex turn cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw Error("Codex turn cancelled");
      const r = await this.rpc("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        ...(schema ? { outputSchema: schema } : {}),
      });
      t.turnId = r.turn.id;
      if (signal?.aborted) abort();
      return await done;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      t.resolve = null;
      t.reject = null;
    }
  }
  async interrupt(threadId) {
    const t = this.threads.get(threadId);
    if (t?.turnId && t.status !== "completed")
      try {
        await this.rpc("turn/interrupt", { threadId, turnId: t.turnId });
      } catch {}
  }
  async judge(params, signal) {
    const threadId = await this.thread();
    this.emit("trace", { type: "codex.judgment.started", threadId });
    const wrapped = {
      type: "object",
      properties: { value: params.response_schema.descriptor },
      required: ["value"],
      additionalProperties: false,
    };
    const r = await this.turn(threadId, JSON.stringify(params.prompt), {
      schema: wrapped,
      signal,
    });
    const value = JSON.parse(r.text).value;
    this.emit("trace", { type: "codex.judgment.completed", threadId });
    return value;
  }
  async close() {
    if (this.closed) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      let deadline;
      try {
        await Promise.race([
          Promise.all([...this.threads.keys()].map((id) => this.interrupt(id))),
          new Promise((resolve) => {
            deadline = setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      this.fail(Error("Codex client closed"));
      this.child?.stdin.end();
      const child = this.child;
      if (child && child.exitCode === null) {
        await new Promise((resolve) => {
          let escalation;
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            escalation = setTimeout(() => {
              child.kill("SIGKILL");
            }, 300);
          }, 1000);
          child.once("exit", () => {
            clearTimeout(timer);
            clearTimeout(escalation);
            resolve();
          });
        });
      }
    })();
    return this.closing;
  }
}
