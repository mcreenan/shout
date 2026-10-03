# SHOUT and JOSH/ALLEN: how they fit together, and an evaluation

Written 2026-09-27, against JOSH/ALLEN `abb8a97` plus SHOUT's nine patches (protocol `josh/1.8`, bytecode version 20). It describes the integration as the code has it, what was wrong or awkward, what changed today, and what to do next. Patch mechanics are in [`tools/josh-patches/README.md`](../tools/josh-patches/README.md).

## How the integration works

SHOUT's agent does not run inside JOSH. The agent is a Codex or Claude thread that calls SHOUT's tools; two of those tools (`run_skill`, `run_program`) run an ALLEN program. Every program run goes through `Run` in `prototypes/owned/src/kernel.mjs`, created by `CodingSession.runProgram` in `apps/shout/src/session.mjs`.

### Before a run: checking

Skills are checked with JOSH's `program/check`. `SkillRegistry.check` in `apps/shout/src/skills.mjs` calls `JoshHost.check` (`apps/shout/src/josh-host.mjs`), which sends the source to the server's long-lived **checker** connection: one `josh serve`, handshaken once with SHOUT's catalog, serving one check at a time with a 30 s timeout. `JoshHost` turns JOSH's result into SHOUT's shape: `ok`, `diagnostics`, the manifest's `capabilities` and `tools`, the `entry` (name, input and output types, declared effects) and the static debug tables. Results are cached by source digest. SHOUT adds its own entry-input rules (`SHOUT006`), reports a source without an inline manifest as `SHOUT001` (JOSH compiles one with an empty manifest), and turns a compiler panic into `SHOUT007`. A panic takes the whole `josh serve` down, because JOSH compiles on its request loop without `catch_unwind`; checks are serial so the panic is traced to its source, and the checker is opened again on the next check. `run_program` checks the agent's program the same way before running it, so compile errors go back to the agent as diagnostics.

`program/check` returns the entry's boundary descriptors and declared effects but not the manifest, so `JoshHost` reads the declared capabilities from the source's inline manifest, which the compiler has just accepted. Since patch 0008 `program/check` and `program/load` both call `josh_host::compile_source_bundle`, and `apps/shout/test/diagnostics.test.mjs` checks they report identical diagnostics. Until 2026-10-03 checks went through `shout-allen-check`, a separate Rust binary linking the same crates; `program/check` gave identical results for every built-in skill, workflow, fixture and test source when it was retired.

### A run

A run speaks to a `josh serve` process through a `JoshConnection` (`prototypes/owned/src/connection.mjs`), which wraps `JoshTransport` (`prototypes/owned/src/transport.mjs`): stdin/stdout in `Content-Length` framed JSON, at most 1 MiB per frame. A connection is handshaken once:

1. Wait for the `runtime/ready` notification.
2. `initialize`: protocol `josh/1.8` (JOSH accepts exactly one), language `>=0.1.0, <0.2.0`, `execution_mode: 'unattended'`, and limits: 1 MiB frames, 64 active requests, the catalog size, and the programs and executions the connection may hold. JOSH grants the lower of each request and its own ceiling (32 loaded programs, 1,024 executions per connection).
3. `host/project`: an honest projection saying the host offers only tools.
4. `catalog/set`: SHOUT's frozen catalog of 13 host tools (`apps/shout/src/tools.mjs`). The same catalog is the compiler's tool contract; programs call `tools.workspace.read.call(...)` and declare `tool.workspace.read@1`.

SHOUT's `SessionStore` owns one `JoshHost`, shared by the skill registry and every session. Besides the checker it keeps a **pool of run connections** (limits: 32 programs, 1,024 executions), and `CodingSession.runProgram` gives each `Run` one from `JoshHost.acquire()`. JOSH allows one active execution per connection and has no `program/unload`, so a connection serves one run at a time, and concurrent runs in different threads get different connections. A run then sends:

5. `program/load`: the source as `src/main.allen`, unless this connection has loaded the same source before (the connection caches programs by source sha256). The reply has the program ID, artifact digest, required tools (checked against the catalog) and, with debug information, the static tables (`debug.constructs`, `debug.effect_sites`, `debug.truncated`). The kernel records `program.loaded` with `sites` and `constructs`.
6. `execution/start`: entry `main`, SHOUT's input record, the required tools granted, and the wall-time limit (the skill's `minutes`, 30 by default, or none under "No time limits"). The request stays open until the program ends. JOSH sends an execution's result just before it frees the connection's execution slot, so a start that finds the slot still taken (`request.invalid_state`, nothing started) is sent again after a short wait.

A connection goes back to the pool only when JOSH returned the execution's result (completed, stopped or failed), it has loaded fewer than 31 programs and started fewer than 1,000 executions, and fewer than two connections are idle; anything else retires it. The first check opens a run connection too, and one is reopened whenever the pool is empty, so a run in a warm server starts without spawning a process; after first use two `josh serve` processes stay running (the checker and one run connection). Idle connections don't keep Node running, and `SessionStore.close()` ends them all. A frame naming another execution than the attached run's is dropped and logged.

The prototypes don't use the pool: without a `connection` factory, `Run` opens its own one-shot connection (one program, one execution) and closes it when the run ends.

While the program runs, JOSH sends provider requests to the host:

| JOSH request | SHOUT's handling |
|---|---|
| `tool/invoke` | Validate the input against the tool's schema, count it against the tool budget (the skill's `tools`, 128 by default), call SHOUT's handler. A handler's `ToolError` becomes the tool's declared `{ message }` error, which the program sees as `Err(_)`; any other failure fails the run. A result over the frame budget becomes a declared error. |
| `model/request` | Count the attempt against the judgment budget (the skill's `judgments`, 16 by default), build a JSON Schema from the response descriptor (`callbackCodec` in `prototypes/owned/src/schema.mjs`, every ALLEN data type), ask the judgment worker (`CodexProvider` or `ClaudeProvider`) and send its answer in JOSH's encoding, valid or not. JOSH validates it and, while the prompt's `max_attempts` allows, asks again with validation issues that the kernel adds to the worker's instructions; after the last attempt the program gets `Err`. A refusal is answered `model.denied`, which the program also sees as `Err`. |
| `user/ask` | Count it against the question budget (the skill's `questions`, 8 by default) and show a form built from the schema (`apps/shout/public/ask-form.js`, a control for each ALLEN type); the answer is validated against the schema in SHOUT, so the form refuses a wrong answer at once, then translated and sent back. When JOSH asks again, the session passes the question's `interaction`, `attempt` and `issues`, and the form keeps the previous answer and marks the rejected fields. |
| `agent/*`, `sub_agent/*`, `permission/request` | Rejected (`agent.unavailable` or `request.method_not_found`). |

The four budgets come from the skill header's `// limits:` line (`judgments`, `tools`, `questions`, `minutes`; defaults 16/128/8/30, ceilings 32/256/16/120), which SHOUT parses, not JOSH: a manifest key JOSH does not know is a compile error. The registry reports a bad value as `SHOUT008` and a zero limit for an effect the entry declares as `SHOUT009`. A program the agent writes may only lower its limits. The run's limits are recorded on the run as `limits`.

Every step becomes a kernel event (`effect.requested`, `tool.started`, `model.started`, `model.worker`, `model.completed`, `model.rejected`, `tool.completed`/`tool.failed`, `user.question`, `user.answered`, `effect.resolved`/`failed`/`rejected`/`cancelled`, `vm.event` for each `execution/event` notification, `run.terminal`). `CodingSession` stores them in the thread's event log, renaming the kernel's effect `id` to `effectId`, giving each event its own ID and renumbering `sequence`. JOSH's `cancel` frames abort the matching provider call and a late result is never sent; for a question the runtime withdraws, the kernel leaves `waiting_user` and the session clears the question from the thread. A response is encoded before its effect leaves the pending set: a model or tool answer too large for one frame fails the run with that message, and a user answer too large is refused with the question still open.

### Approvals

Approvals are not `user.ask`. They live in SHOUT's tool handlers: `workspace.edit`, `workspace.write` and `shell.run` call `CodingSession.approve`, which shows the approval card and waits while the `tool/invoke` request stays pending in JOSH. A program cannot skip or answer an approval, and the VM sees only the tool's result (`accepted: false`, `approved: false`).

### Terminal states

`completed` with the program's output; `stopped` from `stop("reason")`, shown as "`/name` stopped: reason"; `failed` for a runtime trap, a provider failure or a budget, shown as "`/name` failed at line N: message" when the failure has a position in the program (a trap's `error.span`, or for a provider failure or budget the effect's `origin.site`, which the kernel adds to the result as `span`); `cancelled`; `interrupted` when JOSH exits unexpectedly. A run that ends any other way than with JOSH's result (a cancel, the host's wall-time budget, a provider failure, a lost connection) retires its connection: the kernel closes stdin, sends SIGTERM and, after 300 ms, SIGKILL, as it does for every one-shot connection. Nothing about a run survives a server restart; unfinished runs are marked interrupted.

## What was wrong or awkward

As of the pinned revision, before today's work:

- **No source position reached the host.** Effect, await, spawn and call instructions were not span-marked, so their debug location was the whole function body; loops exist in bytecode only as jumps. The Program tab guessed with a regular expression over each source line: every `model.request` line showed the same count, and two calls to one tool on different lines were merged.
- **Runtime errors had no location.** `error.span` was always `null`.
- **Compiler bugs that skill authors hit:** a panic ("all used effect sets are interned") for an `if` or `for` body with effects only in inner branch statements; "MIR contains an unreachable block" for a loop body ending in an `if` whose branches all `break` or `continue`; top-level `const` failing in any program that used catalog tools. The authoring guide carried workarounds for the first and the last.
- **A busy loop.** `josh serve` used a full CPU core whenever a provider request was pending, which in SHOUT means during every model judgment and every approval waiting for a person. It had been blamed on oversized frames.
- **Lost final frames.** When the host closed stdin, JOSH could exit before writing its queued responses (about one run in ten under load).
- **No diagnostics from `program/load`.** A source that did not compile failed with a bare error, which is why SHOUT built its own checker.
- **`operation_id` restarted at 1 for each request family**, so it was not unique within an execution.
- **Rigid protocol.** Every payload denies unknown fields, JOSH accepts exactly one protocol version and an exact feature list, and extensions must be empty. Any protocol change needs the host and runtime changed together.

## What changed today

Nine patches, applied by `tools/setup-josh.sh` onto `abb8a97` (46 files, about 6,200 lines added, most of it 0002 and 0008 including tests and docs):

| Patch | Why | Effect on SHOUT |
|---|---|---|
| 0001 if-branch statement effects | The "effect sets are interned" panic | The `SHOUT007` workaround row left the authoring guide |
| 0002 effect origin | Nothing told the host where an effect came from | Provider requests carry `origin`; `program/load` returns the static tables. Flow draws loops, branches and parallel tasks; the Program tab counts exact lines. Protocol `josh/1.7`, bytecode 20 |
| 0003 runtime error spans | `error.span` was `null` | Traps carry source, byte span and line/column. SHOUT records the line as the run's `failedAt`, says "failed at line N" and links it to the Program tab |
| 0004 loop control-branch joins | Loops ending in all-`break`/`continue` branches did not compile | The pattern works in skills |
| 0005 constants with catalog tools | `const` failed beside tool calls | `skills/code.allen` uses a `const` again; the guide's workaround was removed |
| 0006 idle provider wait | The busy loop | JOSH sleeps while requests are pending (50 µs growing to 10 ms) and josh-host wakes it on a response. An oversized or malformed frame closes the connection with a specific message on stderr |
| 0007 flush frames on close | Lost final responses | JOSH waits up to 5 seconds to write queued frames before exiting |
| 0008 compile diagnostics and `program/check` | Load failures had no diagnostics | `program/load` fails with `program.invalid` and `data.diagnostics`; the new `program/check` compiles without loading. The kernel puts the first five diagnostics in the failure message and the full list on the result. Checker and JOSH share one compile path. Protocol `josh/1.8` |
| 0009 execution-wide operation IDs | `operation_id` was only unique per family | `op-<n>` is unique per execution. SHOUT does not use it yet |

The protocol literal `josh/1.8` appears in `prototypes/owned/src/connection.mjs` (in `kernel.mjs` before 2026-10-03) and `prototypes/native/src/josh.mjs`; both native and owned prototypes pass their tests against the patched build.

### Typed responses (2026-09-28, SHOUT only)

JOSH already implemented ALLEN's typed retry: it validates every `model/request` and `user/ask` answer itself, and when an answer does not decode it sends a new request for the same pending effect with the same `interaction_id`, `attempt` + 1 and `validation_issues` (JSON Pointer paths and stable codes such as `type`, `required`, `tag`), up to the prompt's `max_attempts` (1–3, default 3). After the last attempt the program gets `Err` with `model.validation_failed` (`user.validation_failed` for questions). SHOUT never let this happen: the judgment workers and the kernel rejected invalid answers first and failed the run. Now:

- The kernel sends the worker's answer to JOSH even when it does not match, including an answer that is not JSON at all (as a value no ALLEN type decodes). The workers still validate, and the kernel takes the rejected value out of their `SchemaRejection`. `ClaudeProvider` (`apps/shout/src/claude-provider.mjs`) makes one query per JOSH attempt: an answer that does not match throws `SchemaRejection`, no usable answer throws `code: 'invalid_answer'`, and a refusal throws `code: 'refusal'`, answered `model.denied`.
- On a retry the kernel appends the reasons to the prompt's `system` text for the worker, and records `model.rejected` for the previous attempt. JOSH's issue paths point into its wire encoding; the kernel maps them onto the answer as the model gave it (`/level/tag` of a payload-free enum becomes `/level`).
- `effect.requested`, `model.started` and `user.question` carry `interaction`, `attempt` and, from the second attempt, `issues`. `model.completed` has `valid: false` when the answer does not match its schema. `effect.rejected` carries the refusal `message`.
- `callbackCodec` builds a schema for every descriptor kind using only keywords both workers' structured-output modes accept (`type`, `properties`, `required`, `additionalProperties: false`, `items`, `enum`, `anyOf`), and translates answers to JOSH's encoding: a tuple is an object with keys `"0"`, `"1"`…, a payload-free enum a variant name, a map an array of `{key, value}` sorted into JOSH's key order, and a whole-number `Float` is sent as `3.0` (JOSH reads `3` as an `Int` and rejects it).

A real sequence from `apps/shout/test/retries.test.mjs` (a `Rating` with an enum, a `Float` and an `Option`, `max_attempts: 2`; the first answer used an unknown level):

```json
{"type":"model.started","interaction":"interaction-1","attempt":1,"effectId":"run-…:r-1"}
{"type":"model.completed","value":{"level":"Medium","score":2,"note":{"tag":"None"}},"valid":false,"effectId":"run-…:r-1"}
{"type":"model.rejected","interaction":"interaction-1","attempt":1,"issues":[{"path":"/level","code":"tag"}],"effectId":"run-…:r-1"}
{"type":"model.started","interaction":"interaction-1","attempt":2,"issues":[{"path":"/level","code":"tag"}],"effectId":"run-…:r-2"}
{"type":"model.completed","value":{"level":"High","score":2,"note":{"tag":"Some","value":"ok"}},"effectId":"run-…:r-2"}
```

The worker's second prompt ended with `This is attempt 2 of 2. The previous answer was rejected because it does not match the required output type:\n- /level: unknown variant tag\nAnswer again with a value that matches the output schema exactly.`

Structured output makes most rejections rare, because the workers already produce schema-valid JSON. JOSH still rejects what JSON Schema cannot state: in a live run on Codex, a `Map<String, Int>` answer that repeated a key was rejected with `order` at `/counts/1/key`, re-asked once, repeated, and the program's `Err` branch ran with `model.validation_failed`. Live on Claude (Opus 5.5), the same repeated key was rejected, re-asked with the reason, and fixed on attempt 2. For such answers `model.completed` has no `valid: false`; the `model.rejected` that follows is authoritative.

### The origin

With the `effect-origin` feature every provider request may carry an `origin`. It is diagnostic only: not part of request digests or replay journals, and not an authorization input. The kernel copies it onto `effect.requested`, `tool.started`, `model.started` and `user.question`. A real one, from a `/code` run on the checkout sample (the `workspace.inspect` call in the first attempt of the repair loop, on the `then` branch of `if (whole)`):

```json
{
  "task": 0,
  "site": { "id": 5, "function": "src/main.allen::main", "instruction": 48, "source": "src/main.allen",
            "start": 5962, "end": 6000, "line": 106, "column": 13, "end_line": 106, "end_column": 51 },
  "scope": [
    { "kind": "for", "construct": 8, "region": "body", "instance": 1, "iteration": 1, "source": "src/main.allen",
      "start": 5899, "end": 7646, "line": 104, "column": 3, "end_line": 143, "end_column": 4 },
    { "kind": "if", "construct": 9, "region": "then", "branch": "then", "source": "src/main.allen",
      "start": 5937, "end": 6272, "line": 105, "column": 17, "end_line": 112, "end_column": 6 }
  ]
}
```

- `task` is the task that owns the effect (`0` is the root); spawned tasks add `parent_task`.
- `site` is the `await` or `spawn` that started the request, with the static site `id`. Spans are UTF-8 byte offsets; JOSH adds 1-based line and column so the browser never converts offsets.
- `scope` lists what encloses the site, outermost first: `for`, `while` and `loop` with `instance` (which entry into the loop) and 1-based `iteration`; `if` with `branch`; `match` with the 0-based `arm`; `await_block`; `call` frames (with the function and call site) and `spawn`s. An `if` or `match` whose condition contains the site is left out. At most 64 entries; deeper chains keep the innermost and set `truncated`.

The static tables in `program.loaded`:

- `constructs`: every source `for`, `while`, `loop`, `if`, `match` and `await` block, with `id`, `kind`, `function`, `parent`, span and `regions` (`condition`, `then`, `else`, `body`, `scrutinee`, and each `arm` with its index). Conditionals the compiler generates for `&&`, `||`, `??` and pattern lowering are not recorded.
- `effect_sites`: every effect call with `id`, `kind` (tool, model, user…), `operation` as written (`tools.workspace.edit.call`), `tool`, `function`, instruction range, span and enclosing `constructs`.
- `truncated`: the tables stop at a quarter of the negotiated frame size (256 KiB with SHOUT's 1 MiB frames).

### Diagnostics

A diagnostic has `code`, `severity`, `message`, `source`, byte `start`/`end`, `line`/`column`/`end_line`/`end_column`, `labels`, `notes` and `help`. For example `{"code": "E3011", "message": "template interpolation must be String, found Int", "line": 9, "column": 6, …}`. The compiler's line rule (LF, CRLF and a lone CR each end a line) is shared by rendered errors, origins and diagnostics, so all three agree on line numbers.

### The CPU spin

The VM scheduler used to re-poll pending effects in a tight loop. A judgment takes seconds to minutes and an approval can wait for hours, and each held a core at 100% for its whole duration, per run. After 0006, in a check during this write-up, `josh serve` used 0.25% of one core over four seconds while a judgment was pending. The earlier explanation (oversized frames) was wrong; oversized frames now close the connection with a message instead.

## How Flow and the Program tab use the metadata

`apps/shout/public/flow.js` folds events into steps, pairing each start with its completion by effect ID, and keeps the step's `origin`. `programShape` reads `sites` and `constructs` from `program.loaded`.

`scopeTree` in `flow-graph.js` turns a run's steps into a tree:

- Loops are keyed by the whole call path plus the construct's span and `instance`, so re-entering a loop, or reaching it from another call site, starts a new group. Each `iteration` is a container.
- An `await_block` or a `spawn` opens parallel tracks, one per task, named by the function the task runs (`size_of("a.mjs")` when names repeat). A block that turns out to have one track rejoins the sequence.
- The innermost `if`/`match` entered since the previous step becomes that step's chip, labelled from the construct's regions: `then`/`else` with the condition as the tooltip, or the arm's pattern as written.
- A construct compiled twice (an arm body under an or-pattern) is keyed by span, not ID.

`phases` lays the tree out: a loop whose iterations are one step each becomes a stack card; otherwise a group card with iteration tiles and one iteration opened in a frame; a loop that ran once is drawn as its body in a frame. Steps without an origin (host approvals) stay where the previous step was. Without any origin data the old grouping by kind remains.

The Program tab (`renderProgram` in `app.js`, with `programActivity` in `flow.js`) counts steps per `origin.site.line`, credits each `call` and `spawn` line in the scope with the effects beneath it, sums iterations per loop line over all `(construct, instance)` pairs, marks the site that is running or waiting, and uses the `effect_sites` table to dim sites a finished run never reached. The step detail panel builds its breadcrumb (entry function, calls, loop iterations, branches with their conditions) from the same scope, and links to the exact line.

Tests: `prototypes/owned/test/kernel.test.mjs` checks that origins, tables and diagnostics pass through; `apps/shout/test/origin.test.mjs` runs `/todo` on the real VM and checks iterations, call frames and lines; `apps/shout/test/flow-graph.test.mjs` covers the tree and layout, including recorded real runs of `/code`, `/todo`, `/find`, `/review` and an agent-written program (`test/fixtures/flow-real-*.json`).

## What remains awkward

- **One execution per connection, and no unloading.** JOSH runs one execution at a time on a connection and cannot unload a program, so SHOUT keeps a pool instead of one shared process, and retires a connection after 31 loaded programs. A cancelled or timed-out run still costs a process, because killing it is the only way to be sure nothing of the run continues.
- **A compiler panic kills the checker.** JOSH compiles on its request loop without `catch_unwind`, so `SHOUT007` costs a process restart, and checks are serial so the panic can be traced to its source.
- **Exact-version lockstep.** The pin, nine patches and two protocol literals must change together, because JOSH accepts one protocol version and rejects unknown fields.
- **Nothing survives a restart.** JOSH has replay journals; SHOUT does not use them, so an interrupted run cannot resume.
- **Record fields arrive in alphabetical order.** JOSH's response descriptor keeps a record's fields in a sorted map, so the ask form lists them by name, not in declaration order. Keeping the declared order needs a change to JOSH's schema descriptor.
- **Worker failures fail the run, not the call.** Worker transport failures, timeouts and budgets fail the run on purpose: JOSH's recoverable form (`model.unavailable`) would hide the actionable message behind the program's own `Err` handling. Unusable answers are different: both workers report them so that JOSH asks again.
- **ALLEN programs cannot call agents.** The kernel rejects `agent/*`, `sub_agent/*` and `permission/request`; sub-agents exist only as the SHOUT agent's `spawn_agents` tool.
- **Effect events cover tools only.** `execution/event` emits `effect_started/completed/failed` for tool calls; model, user and agent requests are visible only as provider requests.
- **An untyped event contract.** Kernel events are plain objects spread into the session log; nothing checks their shape between kernel, session and UI. The effect `origin` shares its name with `user.answered`'s `origin` (who answered), which is confusing though they never meet on one event.
- **Debug tables can be truncated** for a large program (over 256 KiB of tables, in `program/load` and `program/check` alike; `shout-allen-check` had no cap, but nothing in SHOUT reads the check's tables). Origins still arrive with every request, so grouping still works, but `match` chips read `arm N` instead of the pattern, chip tooltips fall back to the source line, and the Program tab cannot dim sites missing from the table.

## Next steps, in priority order

Effort figures are rough estimates for one person familiar with both codebases.

1. **Resume from replay journals** (a week or more). Persist each run's journal, replay on restart, and define what happens to effects that were pending (an approval shown before the restart must be asked again; a half-applied write must not be repeated). Planned in [`docs/proposals/runtime/IMPLEMENTATION-PLAN.md`](proposals/runtime/IMPLEMENTATION-PLAN.md) (phase 4).
2. **Effect events for every provider** (1–2 days in JOSH). Emit `effect_*` events for model, user and agent requests, so the event log does not depend on the host's own bookkeeping.
3. **Upstream the patches and bump the pin** (half a day plus review). Independent of the items above and worth doing early, since every further JOSH change otherwise adds another local patch. See below.

## Regenerating and upstreaming the patches

The development branch is `shout/effect-origin` in `.worktrees/josh-allen`, one commit per logical change on top of `abb8a97`. **It exists only in that local clone; it has not been pushed.** `.worktrees/` is ignored by Git, so a fresh clone of SHOUT has only the patch files. [`tools/josh-patches/README.md`](../tools/josh-patches/README.md) lists the boundary commits for each patch, the exact `git diff` invocation that regenerates one, the Rust checks to run first, and how to try a clone's build in SHOUT with `JOSH_BIN` before switching the shared cache.

To upstream:

1. In `.worktrees/josh-allen`, run the checks from the patches README (`cargo fmt`, `clippy -D warnings`, the workspace tests and doc tests, `git diff --check`).
2. Push `shout/effect-origin` to `github.com/mcreenan/josh-allen` and open a pull request, or split it per patch. Another local checkout (`~/josh-allen`) has uncommitted work touching `crates/josh/src/runner.rs` and `docs/implementation-spec.md`; 0002 and 0008 also change the spec, so expect to reconcile.
3. After merging, set `revision` in `tools/setup-josh.sh` to the merge commit, delete the merged patches, update the patches README, and run `bash tools/setup-josh.sh` followed by `npm run verify`. The protocol literals stay `josh/1.8` unless upstream renumbers them.
