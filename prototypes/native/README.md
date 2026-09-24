# Native Codex × ALLEN prototype

This adapter adds `allen_run` as a native dynamic tool in the existing **Codex 0.153.3 app-server harness**. A real parent Codex turn starts ALLEN; the adapter routes JOSH providers in code; a separate Codex thread supplies typed judgment while the parent tool call waits; the parent then receives the final typed result.

The VM filters evidence and sequences operations. Models decide whether the evidence merits review and summarize the result. They never receive JOSH IDs, forwarding envelopes, or instructions to invoke a resume tool.

## Run

From the repository root, build the pinned runtime once with `tools/setup-josh.sh`. Node 22+ is required. No npm runtime dependencies are needed.

```sh
cd prototypes/native
npm ci
npm test
npm run demo     # real ALLEN runtime, deterministic model and user fixtures
npm run live     # real Codex parent + real judgment; explicitly labelled user fixture
npm start        # interactive, no model call until /live
```

`npm run live` uses the existing CLI login. It checks the exact installed Codex version because dynamic tools are experimental. `CODEX_BIN` can select another executable of that version. `JOSH_BIN` overrides discovery of the repository's pinned build. Model identity follows the existing Codex account/configuration; this prototype does not substitute a model choice.

Interactive commands:

```text
/run                         deterministic judgment, actual interactive answer
/live                        live Codex parent and judgment, interactive answer
/live <natural-language request>  ask the parent to select the review fixture or author/run supplied ALLEN
/status                      inspect the run and pending question
/answer <question-id> true    answer the exact pending Boolean question
/answer <question-id> false
/cancel                      cancel ALLEN and its model worker / parent turn
/quit
```

One execution is allowed per CLI process. Start another process for another run. EOF cancels owned work. A pending question includes its full run-scoped identifier; wrong-run, duplicate, late and non-Boolean answers are rejected. Scripted answers are always emitted as `SCRIPTED FIXTURE, not real user approval`.

The live trace is written to ignored `.scratch/live-trace.json`. The demo writes `.scratch/fixture-trace.json`. Trace counters distinguish model judgments, local tool calls, user questions and automatic dispatches. The model-forwarding-envelope count is zero by construction: no provider request envelope is exposed as a model tool result. There is no inference of token savings from these counters.

## Workflow and reusable seam

`fixtures/review.allen` filters three synthetic findings to the two with severity >= 2, asks the model for `{ recommend: Bool, reason: String }`, calls `review.save`, asks a human for a Boolean decision, then returns the typed final record. `review.save` computes a receipt in memory and makes no external mutation.

The dynamic tool accepts either `{ "fixture": "review" }` or `{ "source": "<ALLEN source>", "input": <JSON> }`. The exported `JoshRun` class accepts the same source/input plus a judgment provider and session ID. It can run other bounded programs against the fixed catalog; it is not limited to a mocked fixture VM. Only `review.save` is available. Source must fit 64 KiB; JOSH frames fit 1 MiB; an execution lasts at most 120 seconds and dispatches at most 3 model judgments, 16 tools and 8 user questions. ALLEN programs can handle provider-budget rejection as a typed unavailable error; the review fixture fails explicitly. The UI currently supports Boolean `user.ask` only and one pending human question; other user schemas or concurrent questions are explicitly rejected.

## What is and is not proven

- **Proven live:** Codex's parent tool turn can remain pending while a second thread in the same app-server supplies the ALLEN model callback. The real typed result returns to the parent without a model-written relay.
- `model.request` means an independent judgment with the supplied prompt/data. It is **not** `agent.ask` against the parent's complete conversation, and does not claim same-agent identity or context. `agent.*` and `sub_agent.*` callbacks are unsupported.
- The catalog describes this adapter's one-tool registry, not every Codex builtin or installed MCP tool. Session binding is conservatively declared `prompt_assisted`; no cryptographic actor identity is claimed.
- The app-server uses normal existing local Codex configuration and authentication. An empty MCP table does not prove inherited integrations are absent. The adapter requests read-only sandboxing and disables web search, but does **not** claim that no builtins are advertised. It watches item-start events and fails/interrupts a turn upon unexpected tool activity. This detects unexpected activity; it is not a security boundary that can reverse a tool's already-started effect. Only synthetic, non-sensitive inputs were tested. The parent and child were observed using only the intended dynamic tool / message events.
- Restart recovery is not implemented. Process loss interrupts the run; traces are diagnostics, not resumable checkpoints. There is no external-effect exactly-once guarantee.
- Offline tests exercise the actual pinned compiler and VM with deterministic judgment providers. The live command separately proves actual harness integration and model judgment.

See [FINDINGS.md](FINDINGS.md) for conclusions and [CODEX-CONTRACT.md](CODEX-CONTRACT.md) for the installed protocol contract and official documentation.
