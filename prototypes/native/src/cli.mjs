import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { JoshRun, ROOT, fixtureJudge, source, fixture } from "./josh.mjs";
import { CodexClient } from "./codex.mjs";
const args = process.argv.slice(2),
  live = args.includes("--live"),
  auto = args.includes("--fixture");
const trace = [];
const log = (event) => {
  trace.push(event);
  console.log(JSON.stringify(event));
};
let active = null,
  client = null,
  rl = null,
  useModel = false,
  busy = false;
const controller = new AbortController();
controller.signal.addEventListener(
  "abort",
  () => {
    void client?.close();
  },
  { once: true },
);
const runProgram = async (program = source, input = fixture, sessionId) => {
  if (active) throw Error("Only one execution per native adapter invocation");
  active = new JoshRun({
    judge: useModel ? (p, s) => client.judge(p, s) : fixtureJudge,
    program,
    input,
    sessionId,
  });
  active.on("trace", log);
  active.on("question", (q) => {
    if (auto) {
      log({
        type: "fixture.answer",
        label: "SCRIPTED FIXTURE, not real user approval",
        id: q.id,
        value: true,
      });
      active.answer(q.id, true);
    } else
      console.log(
        `Use /answer ${q.id} true|false. /status and /cancel remain available.`,
      );
  });
  if (controller.signal.aborted) return { outcome: "cancelled" };
  const outcome = await active.start();
  return {
    outcome: outcome.outcome,
    result: outcome,
    counters: active.counters,
  };
};
if (!auto) {
  console.log(
    "Native ALLEN adapter. Commands: /run, /live, /status, /answer <id> true|false, /cancel, /quit. /live asks Codex to invoke the ALLEN tool.",
  );
  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const [cmd, id, raw] = line.trim().split(/\s+/);
    try {
      if (cmd === "/status") log(active?.status() || { state: "idle" });
      else if (cmd === "/answer") {
        if (raw !== "true" && raw !== "false")
          throw Error("Expected true or false");
        active?.answer(id, raw === "true");
      } else if (cmd === "/cancel") {
        controller.abort();
        void active?.cancel();
      } else if (cmd === "/quit") {
        controller.abort();
        void active?.cancel();
        rl.close();
        process.stdin.destroy();
      } else if (cmd === "/run")
        void launch(false).catch((e) => log({ error: e.message }));
      else if (cmd === "/live")
        void launch(true, line.trim().slice(5).trim() || undefined).catch((e) =>
          log({ error: e.message }),
        );
    } catch (e) {
      log({ error: e.message });
    }
  });
  rl.on("close", () => {
    controller.abort();
    void active?.cancel();
    void client?.close();
  });
}
async function launch(
  liveMode,
  userPrompt = "Please run the synthetic review fixture through ALLEN and report the result.",
) {
  if (active || busy)
    throw Error(
      "This prototype permits one run per CLI process; restart to run again",
    );
  controller.signal.throwIfAborted();
  busy = true;
  useModel = liveMode;
  if (!liveMode) {
    log(await runProgram());
    return;
  }
  client = new CodexClient();
  client.on("trace", log);
  try {
    await client.open();
    controller.signal.throwIfAborted();
    const threadId = await client.thread({
      instructions:
        'You are the existing Codex harness in a native ALLEN integration experiment. Use allen_run exactly once to execute the requested review. Select fixture "review" for the synthetic review or supply exact source and input if the user requests a custom ALLEN program. Do not implement the workflow yourself. After it returns summarize its typed outcome briefly. Do not call any other tools.',
      dynamicTools: [
        {
          type: "function",
          name: "allen_run",
          description:
            "Execute ALLEN with native deterministic callback routing. Either choose fixture review, or supply source and input. Source is bounded to 64 KiB; only frozen review.save tool is granted.",
          inputSchema: {
            type: "object",
            properties: {
              fixture: { type: "string" },
              source: { type: "string" },
              input: {},
            },
            additionalProperties: false,
          },
        },
      ],
    });
    log({ type: "codex.parent.started", threadId });
    let calls = 0;
    const r = await client.turn(threadId, userPrompt, {
      signal: controller.signal,
      onTool: async (p) => {
        if (p.tool !== "allen_run" || ++calls > 1)
          throw Error("Unexpected or duplicate native tool invocation");
        const a = p.arguments;
        if (!a || typeof a !== "object") throw Error("Invalid tool input");
        let program = source,
          input = fixture;
        if (a.fixture !== "review") {
          if (
            typeof a.source !== "string" ||
            Buffer.byteLength(a.source) > 65536
          )
            throw Error("Expected fixture review or bounded source");
          program = a.source;
          input = a.input;
        }
        log({ type: "codex.native_tool.called", tool: p.tool });
        const result = await runProgram(program, input, threadId);
        log({
          type: "codex.native_tool.returned",
          outcome: result.outcome,
          counters: result.counters,
        });
        return result;
      },
    });
    if (calls !== 1) throw Error("Codex did not invoke ALLEN");
    log({ type: "codex.parent.completed", text: r.text });
  } finally {
    await active?.cancel();
    await client.close();
  }
}
if (auto) {
  try {
    await launch(live);
    if (active?.outcome?.outcome !== "completed") process.exitCode = 1;
  } catch (e) {
    log({ type: "error", message: e.message });
    process.exitCode = 1;
  } finally {
    mkdirSync(resolve(ROOT, ".scratch"), { recursive: true });
    writeFileSync(
      resolve(
        ROOT,
        ".scratch",
        live ? "live-trace.json" : "fixture-trace.json",
      ),
      JSON.stringify(trace, null, 2) + "\n",
    );
  }
}
