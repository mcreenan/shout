# SHOUT runtime improvements: implementation plan

Status: planned 2026-10-03. Written against SHOUT `3cc3ebf`, JOSH `abb8a97` plus patches 0001–0009 (protocol `josh/1.8`). Every phase is host-side: **no JOSH patch is needed.**

Four phases, implemented in order:

1. Show runtime error positions
2. Per-skill limits
3. Long-lived JOSH connections, and `program/check` instead of `shout-allen-check`
4. Resume runs after a server restart

## Resolved decisions

These were open questions. The user asked for the whole plan to be carried out, so the recommended answer was adopted for each.

| # | Question | Decision |
|---|---|---|
| Q1 | JOSH allows **one active execution per connection** (`josh-protocol/src/state.rs:639`, `josh-host/src/session.rs:652-656`) and has **no `program/unload`** (at most 32 programs per connection, `session.rs:37,470-483`), so one literal long-lived `josh serve` cannot serve concurrent runs. | One long-lived connection only for `program/check`, plus a small pool of run connections. A connection is reused after a clean finish and retired at 32 loaded programs or after any unclean end. No JOSH patch. |
| Q2 | Ceilings for per-skill limits, and whether an agent-written program (`run_program`) may raise its own budgets. | Defaults stay 16 judgments / 128 tool calls / 8 questions / 30 min. Skill ceilings are 32 / 256 / 16 / 120 min. A generated program may only **lower** its limits (capped at the defaults). |
| Q3 | On replay divergence, stop or continue live? | **Stop.** The run becomes `interrupted` with "Could not resume after the restart: …". |
| Q4 | Resume agent-started runs (`run_skill`/`run_program`) as well as slash-command runs? | **Both.** The agent's turn is marked interrupted. The run's result is posted in chat and given to the agent as a note at the start of its next turn. |
| Q5 | A write that was cut off part-way by a restart: error to the program, or fail the run? | **A declared tool error.** The program sees `Err` naming which files were written and which weren't. Nothing is repeated. |
| Q6 | Should every SIGTERM/SIGINT/desktop disconnect suspend runs instead of cancelling them? | **Yes.** An explicit Cancel in the UI still cancels. |

## Findings that change the brief

1. **A graceful restart cancels runs, it does not interrupt them.** `server.mjs:208-209` calls `app.close()` → `store.close()` (`session.mjs:811`) → `session.close()` → `cancel()` (`session.mjs:590-607`). That records `Cancelled.` and the run state `cancelled`. Node's `--watch` stops the child with SIGTERM (verify on the installed Node), so every save produces "Cancelled.". The `Interrupted by restart.` path (`session.mjs:654-658`) runs only after a hard crash, which makes `docs/JOSH-ALLEN-INTEGRATION.md:43` wrong today.
2. **Agent threads survive a restart, but agent turns do not.** `CodexAgent` reloads its thread with `thread/resume` (`agent.mjs:137`) and `ClaudeAgent` resumes by session id (`claude-agent.mjs:113,126`). An in-flight turn's tool call dies with the process. Sub-agents are marked `interrupted` only on the crash path (`session.mjs:659`).
3. **Connection limits are negotiated, so no patch is needed to raise them.** The host asks for `max_loaded_programs: 1, max_total_executions: 1` (`kernel.mjs:12-13`). JOSH grants the lower of that request and its own ceilings: 32 programs and 1,024 executions per connection lifetime (`session.rs:774-791`).
4. **A compiler panic in `josh serve` takes the whole process down.** Compilation runs on the request loop with no `catch_unwind`; only execution is guarded (`session.rs:173`). Checks therefore run on an isolated connection that is restarted when it dies.
5. **Replay journals exist only in the testkit** (JOSH `docs/implementation-spec.md` §11). `josh serve` does not expose them, so SHOUT, as the host, has to do the replay.
6. **The browser already receives runtime error spans; only the message drops them.** A trap returns `{outcome:'failed', error:{code, message, span:{source,start,end,line,column,end_line,end_column}}}` (`session.rs:947-983`). The kernel passes it through `finish` (`kernel.mjs:135-136`), and `data.runs[i].result.error.span` reaches the browser through `Object.assign(item, outcome)` (`session.mjs:532`). Only `failure()` (`session.mjs:76`) discards it.

## Constraints for implementers

- `shout.service` runs the app in watch mode on port 4310 against the real `.runs/shout/`. The coordinator has stopped it for this work. **Never test against the real state.** Copy it first (`cp -a .runs/shout /tmp/shout-state-copy`), then run `SHOUT_STATE_DIR=/tmp/shout-state-copy PORT=4399 bash tools/start-gui.sh`.
- The repo is public. Committed files, fixtures and docs must contain no home paths, hostnames, IP addresses or emails.
- Don't push. Don't touch JOSH's `main` or the pin in `tools/setup-josh.sh`, and don't touch `~/josh-allen` or `~/p/experiments/josh-allen`. If a JOSH change turns out to be needed (none is planned), follow `tools/josh-patches/README.md`: commit in `.worktrees/josh-allen` (branch `shout/effect-origin`), regenerate a numbered patch, and bump the protocol literal in `prototypes/owned/src/kernel.mjs:119` and `prototypes/native/src/josh.mjs` if the protocol changes.
- Verify with `export JOSH_BIN="$(bash tools/setup-josh.sh)"; npm run verify; npm run test:browser`. The 55 prototype tests must pass unchanged.
- Update these docs in the same change: `docs/JOSH-ALLEN-INTEGRATION.md` (How it works, Terminal states, What remains awkward, Next steps), `apps/shout/README.md` (the env table, the module table) and the test counts in the root `README.md`.

---

## Phase 1: show runtime error positions (hours)

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Where the position is computed | In the session, after the run ends: `item.failedAt = { line, column, end_line, end_column }` | The span is already in `result.error.span`, so traps need no kernel change. |
| Host-side failures (an exhausted budget, a provider failure) | The kernel adds a `span`, taken from the pending effect's `origin.site`, to the failure result | "Model judgment budget exhausted" is just as useful with a line. This adds a field and doesn't change the prototypes' behaviour. |
| Message text | "`/code` failed at line 42: division by zero". For an agent-written program, the error returned to the agent also quotes the source line, like the compile diagnostics in `session.mjs:452`. | The agent can then fix its own program. |
| UI link | A message field `failure: { run, line }`, rendered as a "line 42" button; a "failed at line 42" button on the run card; an `error-line` row in the Program tab | Reuses `showProgramLine` (`app.js:745-750`). |
| Older sessions | The browser falls back to `run.result?.error?.span` | No migration is needed. |

### Changes

- `prototypes/owned/src/kernel.mjs`, the `dispatch` catch (lines 246-251): `this.finish('failed', { outcome:'failed', error: error.message, ...(siteSpan(params.origin)) })`, where `siteSpan` picks `{source,start,end,line,column,end_line,end_column}` from `origin.site`.
- `apps/shout/src/session.mjs`:
  - A new `failureSpan(outcome)` returns `outcome.result?.error?.span ?? outcome.result?.span`. It accepts a span only when `source === 'src/main.allen'` and `line` is an integer.
  - `failure()` keeps the text.
  - `runProgram` sets `item.failedAt` and builds the message with "at line N", using `messageRecord('assistant', text, { failure: { run: run.id, line } })`.
  - `agentTool` appends `\n  <source line>` for generated programs.
- `apps/shout/public/flow.js`: export a pure `runFailure(run)` that returns `{ line, column, message }` from `run.failedAt` or `run.result.error.span`.
- `apps/shout/public/app.js`:
  - `runCard`: for a failed run with a line, add a `button.run-failed-at` that calls `showProgramLine(run.id, line)`.
  - `messageItem`: render `message.failure` as a link button.
  - `renderProgram`: mark the failing row with `error-line`, add an inline error inlay with the message, and on first render scroll to the row if nothing has focus.
  - `renderMessages`: include the failure line in its render key.
- `apps/shout/public/style.css`: styles for `.code-line.error-line` and `.run-failed-at`. Don't use left accent borders.

### Edge cases

These show no position or link: a `stopped` run (no span), a span without `line`, a line past the end of the source, and a `cancelled` or `interrupted` run.

### Tests

- New `apps/shout/test/error-position.test.mjs` (real VM):
  - A skill whose line 3 divides by zero. Assert `item.failedAt.line === 3`, the message matches `/failed at line 3/`, and `message.failure.run === run.id`.
  - A budget failure reports the `model.request` line.
- `flow.test.mjs`: `runFailure` with `failedAt`, with only `result.error.span`, with no line, and with a foreign `source`.
- Browser smoke: a scripted failing run. Clicking "failed at line 3" opens the Program tab with row 3 marked `error-line`.

**Acceptance:** a run that traps shows "failed at line N" in chat and on the run card, and clicking it opens the Program tab on that line.

---

## Phase 2: per-skill limits (~1 day)

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Where limits are declared | The skill header, not the manifest: `// limits: judgments=0 tools=4 questions=0 minutes=5` | JOSH rejects unknown manifest keys. The header is already SHOUT's own (`parseHeader`, `skills.mjs:36-47`, like `// args:`). |
| Keys | `judgments`, `tools`, `questions`, `minutes`. Any subset; an omitted key uses the default. | They cover the four hard-coded budgets. |
| Defaults and ceilings | Defaults 16/128/8/30, ceilings 32/256/16/120. Constants `RUN_LIMIT_DEFAULTS` and `RUN_LIMIT_CEILINGS` in `skills.mjs`. | Q2. |
| An invalid value or one over the ceiling | Compile-time diagnostic `SHOUT008` at the header line. The skill shows "(has errors)". | Authors find out when the skill loads, not mid-run. |
| Limits that contradict the program | `SHOUT009`: `judgments=0` while the entry's `effects` include `model.request`. Likewise `questions=0` with `user.ask`, and `tools=0` with any `tool.*` effect. | A cheap static check against the entry effects that are already returned. |
| The "No time limits" toggle | Still overrides `minutes` | Same behaviour as today. |

### Changes

- `apps/shout/src/skills.mjs`:
  - `parseHeader` returns `limits` and `limitErrors: [{line, message}]`, recording header line numbers as it scans.
  - `validate()` merges the limits, turns `limitErrors` into `SHOUT008`, runs the `SHOUT009` checks and returns `checked.limits`. `run_program` goes through `validate` too, so it gets the same rules.
  - Export `resolveLimits(header, { generated })`. For a generated program each value is `min(value, default)`.
  - `load()` exposes `limits`.
- `prototypes/owned/src/kernel.mjs`:
  - A new option `maxUserQuestions = 8` replaces the hard-coded 8.
  - The judgment option accepts 0–64, and a questions bound of 0–64 is added.
  - Prototype defaults don't change.
- `apps/shout/src/session.mjs`:
  - `runSkill` and `runGenerated` pass the limits to `runProgram`, which passes `maxModelJudgments`, `maxToolCalls`, `maxUserQuestions` and `wallMs`.
  - Record `item.limits`.
  - When a skill run fails with "budget exhausted", the message adds "Raise it with `// limits: judgments=N` in the skill header (at most 32)."
- `apps/shout/src/server.mjs`: the skills route includes `limits`. `app.js` shows a "Limits" fact in the Skill tab.
- `apps/shout/skills/GUIDE.md`: document the `limits:` line, the defaults and ceilings, and the budget-exhausted hint.
- Built-in skills: confirm each value against the skill's `effect_sites` and loop bounds before setting it.

| Skill | Header |
|---|---|
| `find`, `todo` | `judgments=0 questions=0 minutes=5` |
| `test` | `judgments=0 questions=0` |
| `explain` | `judgments=4 questions=0` |
| `code` | `judgments=8 questions=0` |
| `review`, `new-skill` | `questions=0` |
| `commit` | defaults |

### Tests

- `skills.test.mjs`:
  - Parsing: subsets, spacing, duplicates, non-integers, and values over the ceiling, which give `SHOUT008` with the right line.
  - `SHOUT009` for a `judgments=0` skill that makes a model call.
  - A generated program can't raise its limits.
- `session.test.mjs`:
  - A skill with `judgments=1` that asks for two judgments fails with the hint, and `item.limits` is recorded.
  - A skill with `questions=1` fails at its second question.

**Acceptance:** `/find` runs with `judgments=0`; adding a `model.request` to a copy of it produces `SHOUT009`; the Skill tab shows the limits.

---

## Phase 3: long-lived JOSH connections and `program/check` (2–3 days)

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Topology | A `JoshHost` per `SessionStore`, with one **checker** connection and a **run pool** | JOSH's per-connection limits (Q1) and compiler panics (finding 4). |
| Checker connection | Handshaken and its catalog frozen once. It serves only `program/check`, **one check at a time**, with a 30 s timeout per check, and is respawned lazily after it exits. | Serial checks let a panic be traced to the source that caused it. A check takes milliseconds. |
| Run pool | `acquire()` returns a handshaken connection (limits: 32 programs, 1,024 executions, the catalog size). Each connection caches loaded programs by source sha256 → `{program_id, artifact_digest, required_tools, debug}`. One warm spare is kept. | Saves a process start and four requests per run; a repeated skill skips `program/load`. |
| Reuse rule | A connection goes back to the pool **only** if the `execution/start` response arrived (completed, stopped or failed), it has fewer than 31 programs and 1,000 executions, and there are at most 2 idle connections. Anything else retires it. | Cancel, wall time and host failures keep today's kill semantics. |
| Multiplexing | A connection is attached to at most one `Run`. Frames with a different `execution_id` are dropped and logged. | Safe because JOSH allows one execution per connection. |
| Crash of a run connection | Same as today: the run becomes `interrupted` and the connection is retired. | No new behaviour. |
| Prototypes | **Opt-in, app only.** `Run` takes an optional `connection` factory. Without one, the current one-shot path (limits 1/1, closed afterwards) runs unchanged. | The 55 prototype tests and `prototypes/native` stay untouched. |
| Retire `tools/allen-check` | Yes, once the equivalence check below passes | `program/check` uses the same `compile_source_bundle` (patch 0008). |

### Changes

- New `prototypes/owned/src/connection.mjs`, class `JoshConnection`:
  - `static open({ tools, limits, projectionId })` does today's handshake.
  - Methods: `load(source)` (cached), `check(source)`, `attach(run)`, `detach()`, `start(params)`, `cancel(requestId)`, `release({ clean })`, `retire()`. Counters: `programs`, `executions`.
  - It wraps `JoshTransport` and routes requests, notifications and failures to the attached run.
- `prototypes/owned/src/kernel.mjs`, `Run.start`: use `this.connectionFactory?.() ?? JoshConnection.open({ ...one-shot limits })`, and go through the connection instead of `this.transport` directly. In `finish()`, call `connection.release({ clean })`. `clean` is true only on the `execution/start` result path; one-shot connections always close.
- New `apps/shout/src/josh-host.mjs`, class `JoshHost({ tools })`:
  - `check(source)` returns the old checker's shape: `{ ok, diagnostics, entry: { name, input, output, effects }, capabilities, tools, debug }`. Adapt the entry descriptors (`null`→`void`, `string`, `object`→`record` with `fields`, `newtype`→its wire type, otherwise `other`). `capabilities` are the entry's non-`tool.*` effects, and `tools` is `required_tools`.
  - Errors map to diagnostics:
    - A missing manifest → `SHOUT001`.
    - Any other error without diagnostics → `SHOUT002`.
    - The connection exits with a stderr tail containing `panicked at` → `SHOUT007`, keeping today's message.
    - The "not in the frozen catalog" hint moves here.
  - Also `acquire()` and `close()`.
- `apps/shout/src/skills.mjs`:
  - `SkillRegistry({ stateRoot, josh })`; `check()` calls `josh.check` and keeps the digest cache.
  - Delete the checker path, the catalog file, `runChecker` and the `SHOUT_ALLEN_CHECK` option. Keep `catalogParams`.
  - Add `registry.close()` for standalone use.
- `apps/shout/src/session.mjs`:
  - `SessionStore` creates a `JoshHost`, shares it with the registry and sessions, and closes it in `close()`.
  - `runProgram` passes `connection: () => this.josh.acquire()`.
- Remove `tools/allen-check/` and its build in `tools/setup-josh.sh`. Update `tools/josh-patches/README.md` and `apps/shout/README.md` to match.

### Equivalence gate (before deleting the checker)

Write a throwaway script; don't commit it. Run the old checker and `JoshHost.check` over every built-in skill, `apps/shout/examples`, `apps/shout/workflows`, and the sources in `diagnostics.test.mjs` and the test fixtures. Compare `ok`, `diagnostics` (deep-equal), the adapted `entry.input`/`entry.output`, sorted `tools`, and `capabilities`. Record the result in the commit message. Any difference blocks the deletion.

### Edge cases

- `program/check` caps debug tables at 256 KiB; the checker had no cap. Nothing in `src/` reads `checked.debug`, so this only needs a note in the docs.
- After first use, two `josh serve` processes stay running (today none do between runs). Both start lazily.
- Tests must close every `SessionStore`/`SkillRegistry` so no processes leak.

### Tests

- New `apps/shout/test/josh-host.test.mjs`:
  - Two runs back to back reuse one process (same pid), and the second skips `program/load`.
  - A cancelled run retires its connection.
  - Two sessions run at the same time on two connections.
  - Killing the checker mid-check yields a diagnostic, and the next check succeeds on a new process.
  - A source without a manifest gives `SHOUT001`.
  - A connection is retired after 31 loads.
  - Stray frames from another execution are ignored.
- `diagnostics.test.mjs` now compares `program/check` (through the registry) with a failed `program/load` (through `Run`).
- All of `npm run verify`, plus `npm run test:browser`.

**Acceptance:** `tools/allen-check` is gone; `setup-josh.sh` builds only `josh` and `allen`; the first two "awkward" bullets in the integration doc are rewritten; a run in a warm server starts without spawning a process.

---

## Phase 4: resume runs after a server restart (a week+)

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Mechanism | **Replay by SHOUT, the host.** Record every response SHOUT sends to JOSH. On restart, start the same source and input on a fresh connection with the **same execution id** (`run.id`), answer requests from the record, then continue live. | SHOUT answers every effect, and JOSH doesn't expose its journals over `serve` (finding 5). |
| Matching | By **key + digest**, not arrival order. The key is the method, the tool, the origin path (`task`, `site.id`, and each scope entry's `construct/instance/iteration/branch/arm`), `attempt`, and an occurrence number. The digest is the sha256 of canonical JSON of the request params, **excluding** `execution_id`, `operation_id`, `interaction_id`, `deadline_ms` and `origin`. | Parallel tasks can issue requests in a different order, and operation and interaction ids are numbered in issue order. |
| Completion order | Recorded responses are released in their recorded order. A request whose entry isn't next is held. | Matches the testkit's ordered release (§11). |
| Unknown request during replay | Held, then answered live once the replay ends | It was pending at the restart (for example a sibling task's approval). |
| Divergence | The run stops and becomes `interrupted` with "Could not resume after the restart: at line N the program asked for X, the recording has Y". It stops when a request has the same key as an entry but a different digest, or when the next entry is unmatched while every received request is held and JOSH has been silent for 3 s. | Q3. |
| Binding | The journal header stores the protocol, `artifact_digest`, catalog digest, source sha256, input and limits. If `program/load` returns a different `artifact_digest`, the run is not resumed. Replay always uses the **recorded source**, never the skill file on disk. | Watch restarts often happen *because* a skill file was saved. |
| Pending at the restart | Approvals and asks have no entry, so they run live and **are asked again**. A model judgment is asked again (and counts against the budget). An idempotent tool or `tests.run` runs again. Writes and `shell.run` past approval follow the intent rows below. | Required behaviour. |
| Write intents | After approval and **before** `workspace.apply`, append `{type:'intent'}` with the before and after sha256 of each path, and fsync. | Lets a resume tell an applied write from an unapplied one. |
| Reconciling a write intent with no response | Every path has its after hash → answer as accepted (`{accepted:true, changed:[paths]}`, plus `problem:''` for an edit) and record it. Every path has its before hash → run live (approval asked again; preflight re-checks). Anything else → a **declared tool error** naming the written and unwritten files (Q5). Never re-apply automatically. | A half-applied write must not be repeated. |
| `shell.run` intent with no response | Declared error: "The command started before SHOUT restarted; its outcome is unknown and it was not run again." | The outcome can't be reconciled. |
| Graceful stop | `suspend`, in this order: stop dispatching; abort effects that have no intent; wait up to 5 s for in-flight applies so their results are recorded; kill JOSH **without** `run.terminal`; persist the run as `suspended`. Agent turns and sub-agents become `interrupted` ("Interrupted by restart."). | Q6 and finding 1. Crashes use the same journal. |
| Agent-started runs | Resumed. When the run ends, its result goes in chat, the session goes `idle`, and `data.agentNote` is prepended once to the next user message in `converse`. | Q4. |
| Event ids after a resume | Replayed effects emit **no** events, `vm.event` is suppressed during replay, and `program.loaded` isn't emitted again. New effect ids are `${run.id}:r${n}-${wireId}`. | JOSH's wire ids restart at 1 and would collide with the old ones in the log. |
| Budgets | Counters are rebuilt from the replayed entries. The remaining wall time is `wallMs` minus the last entry's `t`. | Keeps budgets honest. |
| Crash loops | Count resumes in `item.resumes` and give up after 3 (→ `interrupted`) | Protects against a run that kills the server every time. |
| Retention | A journal is deleted when its run ends, and deleting a session deletes its run directories. A journal stops growing at 32 MiB; the run is then marked `resumable:false` and falls back to today's interrupted behaviour. | A single tool result can be about 700 KiB. |

### Data shapes

The journal is `.runs/shout/runs/<runId>/journal.jsonl`, in the existing per-run directory. It is written through one file descriptor with `fs.writeSync`, **before** the frame goes to JOSH. Intents are fsynced.

```jsonc
{"v":1,"type":"header","run":"run-…","session":"session-…","protocol":"josh/1.8","artifactDigest":"…","catalogDigest":"…","sourceSha256":"…","input":{…},"limits":{…},"launch":{"by":"command"|"agent","skill":"code"|null,"generated":false}}
{"type":"response","n":7,"t":41234,"key":"…","digest":"…","result":{…}}
{"type":"response","n":8,"t":45000,"key":"…","digest":"…","result":{…},"answer":{…},"valid":true}
{"type":"error","n":10,"key":"…","digest":"…","error":{"code":"…","message":"…"}}
{"type":"cancelled","key":"…","digest":"…"}
{"type":"intent","key":"…","digest":"…","tool":"workspace.write","changes":[{"path":"a.js","before":"<sha256>","after":"<sha256>"}]}
```

In a model response, `answer` is the model-shape value; it is used to rebuild `kernel.interactions`.

The run item in the session JSON gains `input`, `limits`, `launch`, `resumable` and `resumes`, and the states `suspended` and `resuming`.

### Changes

- `prototypes/owned/src/kernel.mjs`. All hooks are opt-in; prototype defaults are unchanged.
  - Constructor options `id`, `journal`, `replay` and `effectPrefix`.
  - `dispatch` consults `replay` first. A replayed response increments the counters, sets `interactions`, writes the recorded frame and emits no events.
  - `commit`, `rejectEffect` and `answer` append to the journal before writing; a cancel records `cancelled`.
  - New `suspend()` and a `suspended` state.
  - Events `run.resuming` and `run.resumed`.
- New `apps/shout/src/journal.mjs`: `effectKey`, `requestDigest`, `JournalWriter`, `readJournal` (tolerates a torn last line), `ReplayCursor` (ordered release, holds, the 3 s quiescence check) and `reconcileIntent`.
- `apps/shout/src/tools.mjs`: host hooks `beforeApply(changes, ctx)`, between approval and `workspace.apply`, and `beforeRun(command, ctx)` in `shell.run`.
- `apps/shout/src/session.mjs`:
  - `runProgram` creates the journal and records `launch`.
  - `skillTools` wires the two hooks to the journal intents.
  - New `CodingSession.resume(item)` and `suspend()`.
  - `converse` prepends and clears `data.agentNote`.
  - `SessionStore.init` resumes a session when all of these hold: it was active, its last run is resumable, its workspace exists, the journal header is valid and `resumes < 3`. Anything else takes today's interrupted path. The option `resumeRuns` (default `true`) gates this.
  - `SessionStore.suspend()`. `discard()` also removes the session's run directories.
- `apps/shout/src/server.mjs`: `close({ suspend })`. A signal stop and a desktop disconnect suspend; tests keep using `close()`.
- UI:
  - `app.js`: add the `resuming` and `suspended` states and a "resuming" pill on the run card.
  - `flow.js`: `run.resuming` marks open steps from before the restart as stale (interrupted, not pending) and adds a marker step "Resumed after restart: replayed N steps".

### Edge cases

- **The server restarts during a replay:** the journal still has every entry, so the replay starts over and `resumes` goes up by one.
- **The workspace is gone:** the run is marked interrupted.
- **Two resumes on one workspace:** can't happen, because two sessions on one workspace can't both be active.
- **Program input:** `history` in the input is replayed from the record, not rebuilt.
- **Power loss:** the journal may be shorter than what actually happened. A write that was applied but not recorded then fails preflight as "Stale patch" and the program sees `Err`, so nothing is written twice.
- **Model retries:** `interactions` is rebuilt from `answer`, so a live retry after a replay maps its issues correctly.

### Tests

New `apps/shout/test/resume.test.mjs`, on the real VM with a scripted agent and provider:

1. `/code` waiting at its approval → `suspend` → new store. No judgment is asked again (the provider call count is unchanged), the approval is asked again with the same changes, accepting completes the run, and the file is written once.
2. The same through a crash copy of the state.
3. Write-intent reconciliation for each case: all paths after, all paths before, and mixed (the program gets `Err` and nothing is rewritten).
4. A `shell.run` intent without a response gives a declared error, and the command doesn't run again.
5. Divergence (a tampered digest) and a JOSH build mismatch (a tampered `artifactDigest`) each leave the run interrupted with the reason.
6. A parallel `await` block with one branch pending at the restart resumes.
7. An agent-started `run_skill` resumes, and the agent's next turn starts with the note.
8. A run with `resumes ≥ 3` is marked interrupted.
9. The journal is deleted when the run ends, and deleting the session deletes its run directories.
10. A turn with no program at the restart becomes `interrupted` ("Interrupted by restart.") through `suspend`.

Also:

- Unit tests for `journal.mjs`.
- Rewrite `session.test.mjs` "restart invalidates waiting questions…" as "restart asks the pending approval again".
- Update the sub-agent restart test to go through `suspend`.
- `flow.test.mjs`: `run.resuming` marks open steps stale.
- Browser smoke: the "resuming" pill.

**Acceptance:** on a copied state directory, with the server on another port in watch mode:

1. Start `/code` and wait for the approval card.
2. Touch a file under `apps/shout/src`.
3. The server comes back and the thread shows "Resuming `/code`…".
4. No model call is repeated and the approval card appears once.
5. Accepting completes the run.

---

## File ownership and order

| Phase | Owns |
|---|---|
| 1 | `session.mjs` (failure message), the `kernel.mjs` `dispatch` catch, `public/app.js`, `public/flow.js`, `public/style.css`, new `test/error-position.test.mjs` |
| 2 | `skills.mjs` (header and validate), `kernel.mjs` (question budget and bounds), `session.mjs` (`runSkill`/`runGenerated`), the `server.mjs` skills route, `skills/*.allen`, `skills/GUIDE.md` |
| 3 | New `prototypes/owned/src/connection.mjs`, `kernel.mjs` `start`/`finish`, new `apps/shout/src/josh-host.mjs`, `skills.mjs` (checker removal), `SessionStore`, `tools/setup-josh.sh`, deleting `tools/allen-check/` |
| 4 | New `apps/shout/src/journal.mjs`, the `kernel.mjs` hooks, the `tools.mjs` hooks, `session.mjs` (resume, suspend, init), `server.mjs` close, the UI states |

## Not in this plan

Effect events for every provider (a JOSH change), multiple executions per connection, a `program/unload` patch, declared-order record fields, and upstreaming the patches.
