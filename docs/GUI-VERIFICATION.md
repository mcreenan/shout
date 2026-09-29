# SHOUT GUI verification

This document records observed behavior, newest first. Earlier sections describe the app as it was then.

## 2026-09-28: typed re-asks, the ask form, and hardening

Environment as on 2026-09-27: Omarchy (Arch Linux) on Hyprland, Node 26.7.0, JOSH/ALLEN `abb8a97` with the same nine patches, Codex CLI 0.157.1, Claude Code 2.1.283 through `@anthropic-ai/claude-agent-sdk` 0.3.283, Electron 44.4.5.

### What changed

- **Typed responses.** Any ALLEN type can be the answer to `model.request` or `user.ask` (`callbackCodec` in `prototypes/owned/src/schema.mjs`). JOSH checks every answer; a model answer that does not match is asked for again with the same interaction, the next attempt and the validation issues, up to the prompt's `max_attempts`, after which the program gets `Err` (`model.validation_failed`, `user.validation_failed`). A refusal (Claude reports these) reaches the program as `model.denied`. The events carry `interaction`, `attempt` and `issues`, and there is a new `model.rejected`. `ClaudeProvider` no longer has a JSON-in-the-prompt fallback of its own. Details: [JOSH/ALLEN integration](JOSH-ALLEN-INTEGRATION.md).
- **UI.** The ask form has a control per answer type, checks the answer in place, and on a re-ask keeps the previous answer and marks the rejected fields. Flow draws a re-asked request as one card with an attempts chip; its detail lists each attempt and its issues, and a judgment whose every attempt was rejected reads as failed. Interrupted steps keep their stale look; a running sub-agent's tile pulses. Drafts are kept per thread and on the welcome screen, a send clears the composer and restores it on failure, and a send from the welcome screen can no longer reach another thread. A skill's name on a run card opens its tab.
- **Sessions.** A turn's programs run one at a time; reads and `spawn_agents` run beside them; a pending question stays answerable; a turn that ends or fails cancels its program before the thread settles; a message sent right after a cancel waits up to 10 seconds for the old turn to stop.
- **Tools and server.** `git` accepts only listed read-only options per subcommand, spelled in full, with a git environment that keeps the repository's config from running programs or fetching. Special files are refused, a UTF-8 byte order mark is kept, oversized tool results are explicit errors, change sets over 32 files are refused before approval. Event streams send only the latest state to slow clients and drop clients stalled for 60 seconds; shutdown stops accepting requests first. Built-in skills are found when the install path contains spaces; `/review` lists files beyond its 100-file limit as not reviewed.
- **Desktop.** `openPath` decides on the canonical path and only reveals anything that could run; overlapping start-ups are tracked per launch; the owned server's process group is cleared even after the server itself exits; an explicit port in a schemeless address is kept.
- **Prototypes and tooling.** The native adapter's cancel is bounded and sends a real cancel frame, and runtime cancel frames abort the matching callback in both prototypes. The owned kernel encodes a response before settling its effect (a model answer too large for a JOSH frame fails the run with the reason; an oversized user answer is refused with the question left open), and `Run.start()` runs once. `tools/setup-josh.sh` builds inside the checkout so the pinned Rust toolchain applies, records the toolchain in its stamp, and no longer requires `flock` or `sha256sum`.

### Automated checks

Run during the documentation pass, on the code as it stood at the end of the day:

| Command | Result |
|---|---|
| `npm run typecheck` | Passed |
| `bash tools/prototypes.sh test` | 55 passed: 15 native, 40 owned (new: `prototypes/native/test/shutdown.test.mjs`, `prototypes/owned/test/schema.test.mjs`) |
| `node tools/interactive-smoke.mjs` | 4 interactive CLI scenarios passed |
| `npm run test:gui` | 189 passed, 0 failed (new: `tools`, `server`, `review`, `retries`, `ask-form` and `flow-render` tests) |
| `npm run test:browser` | Passed, now including drafts and navigation during slow requests, ask forms for several answer types with a re-ask, and the sub-agent fleet |
| `npm run test:desktop` | 29 checks passed, one of them the 3 unit tests in `apps/desktop/test`. New checks: `openPath` on bundles, symlinks and executables; a launch overtaken while starting. The run of `start-gui.sh` under bash 3.2 was skipped (it needs `SHOUT_TEST_BASH32`); only the static check of the launch scripts ran |

### Checks run by the implementers

Not re-run for this document. The Codex results below have saved output in the implementers' temporary directories; the Claude results are as reported.

- **Typed re-asks on Codex** (6 Astra): a `Map<String, Int>` answer that repeated a key was rejected by JOSH with `order` at `/counts/1/key`, asked again, repeated, and the program's `Err` branch ran with `model.validation_failed`.
- **Typed re-asks on Claude** (Opus 5.5): reported as verified live. The check for it is `npm run claude:smoke -- --parts kernel`: an answer type using every schema shape, and a map answer the prompt makes repeat a key on the first attempt, which JOSH must reject and ask again (`max_attempts: 2`).
- **Sub-agents on Codex** (6 Astra, low effort): `tools/subagents-live-smoke.mjs` checks a–f passed, including f, a message sent right after cancelling a turn mid-tool-call, which ran on the same thread and completed.

### Not verified

- **macOS.** The desktop app's macOS code paths, the client bundle on a Mac, and the launch scripts under bash 3.2 have never been run.
- **Real notification popups.** The desktop smoke test stubs notifications and the folder chooser.
- **Access from a second device through the firewall.** Remote mode was tested against a server on this machine's own LAN address.
- **Screen-reader output.** The ask form, Flow and sidebar set ARIA roles and labels, but no screen reader was used.
- **Sub-agents on Claude after the cancel change.** The sub-agent smoke (including check f) was not run on Claude after the session lifecycle changed.

## 2026-09-27: two providers, the desktop app, projects, Flow with effect origins, sub-agents

Environment: Omarchy (Arch Linux, kernel 7.1.9) on Hyprland, Node 26.7.0, JOSH/ALLEN `abb8a97` with SHOUT's nine patches (protocol `josh/1.8`, bytecode 20), Codex CLI 0.157.1, Claude Code 2.1.283 through `@anthropic-ai/claude-agent-sdk` 0.3.283, Electron 44.4.5.

### Automated checks

Run during the documentation pass, after the implementation work:

| Command | Result |
|---|---|
| `npm run typecheck` | Passed (syntax checks of the prototypes, `apps/shout`, `apps/desktop` and `tools`) |
| `bash tools/prototypes.sh test` | 32 passed: 9 native, 23 owned |
| `node tools/interactive-smoke.mjs` | 4 interactive CLI scenarios passed (answer and cancellation on each prototype) |
| `npm run test:gui` | 149 passed, 0 failed |
| `npm run test:browser` | Passed: sample → chat → exact diff → approve → real ALLEN edit and tests → Flow and program source → tabs and splits → file tab → `/test` → reload → cancellation → mobile, with no uncaught page errors |
| `npm run test:desktop` | 27 checks passed, among them: owned server on a busy port, attached server left running and its reported state directory used, bridge validation (14 bad calls rejected), no minimum window size on a tiling compositor and 840×620 elsewhere, external links, permissions, menu commands, notification routing, single instance, renderer crash reload, server crash restart, process-group shutdown, remote mode (UI, server-side folder dialog, outage and reconnect, server left running), the connection screen, and the client bundle installed and started outside the checkout |

The app tests run the real patched compiler and VM with a scripted agent and scripted judgments. New today: projects and migration (13), the Claude adapters against a fake SDK (6), sub-agents (10), the sidebar logic (14), the Flow graph (16, including recorded real runs of `/code`, `/todo`, `/find`, `/review` and an agent-written program), effect origins from a real `/todo` run, and identical diagnostics from the skill checker and `program/load`.

### Checks run by the implementers

Run during the implementation work; the live ones used real models and were not re-run for this document.

- **Claude smoke** (`npm run claude:smoke`) on both Claude models, Fable 5.1 and Opus 5.5: one isolated `model.request` judgment, then a two-turn agent thread whose first turn must call SHOUT's `read_file` and whose second must recall the result from the resumed Claude Code session. The workspace held a `CLAUDE.md` and an `AGENTS.md` that must not reach the model, and the tools Claude Code offered were checked to be SHOUT's only.
- **Sub-agents** (`tools/subagents-live-smoke.mjs`, checks a–d) on both Codex and Claude: (a) a parent asked to investigate three questions fanned out to three read-only children and used their reports; (b) a `spawn_agents` call held open for 5 minutes still returned its result to the turn; (c) four children at once, served by one app-server process on Codex and by one Claude Code process per child on Claude, about 250 MB each; (d) cancelling during a fan-out stopped every child within seconds and left none running.
- **Desktop** (no model): `npm run test:desktop` including remote mode and the client bundle, as above. On Hyprland, Electron 44 was checked with `WAYLAND_DEBUG` to run as a native Wayland client with fractional scaling and text-input-v3 input, so no launch flags are set.

### Findings recorded during the documentation pass

- An `Option<T>`, `Float` or enum in a `model.request` or `user.ask` output type fails the run with "Unsupported callback descriptor type" (the kernel's schema builder does not handle them). The authoring guide said `Option` was supported; it now says not to use them. (Fixed on 2026-09-28: every type is supported.)
- Both judgment workers and the kernel validate every answer before the VM sees it, so an invalid answer fails the run and ALLEN's `max_attempts` retry never engages. The guide now says so; see [JOSH/ALLEN integration](JOSH-ALLEN-INTEGRATION.md). (Fixed on 2026-09-28: JOSH re-asks.)
- With patch 0006, `josh serve` used 0.25% of one core over four seconds while a judgment was pending (it used a full core before).
- The comparison tool's instructions and report (`npm run compare`) still describe the earlier router-based app; see [the example README](../apps/shout/examples/README.md). (Fixed on 2026-09-28.)

### Not verified

- **macOS.** The desktop app's macOS code paths (inset title bar, application menu, dock icon and badge) and the client bundle on a Mac have never been run.
- **Real notification popups.** The desktop smoke test stubs notifications and the native folder chooser; whether the desktop's notification daemon shows SHOUT's notifications, and how badges and frame flashing look on each desktop, was not checked automatically.
- **Access from another device through the firewall.** The remote-mode test connects to a server on this machine's own LAN address. Reaching SHOUT from a second computer or phone over the LAN or Tailscale, through a firewall, was not part of today's checks.
- Other Linux desktops (GNOME, KDE, X11) for the overlay title bar, other Wayland compositors than Hyprland, and Claude on a Claude Code build other than the one the SDK pins.

## 2026-09-26: original GUI

The coding GUI was verified against the existing JOSH/ALLEN revision `abb8a9782fc438d1b87e8aa2fdaea65e5db633c3` and the supported Codex CLI 0.153.3 judgment worker. [Live evidence](gui-live-evidence.json) preserves the synthetic typed results and model usage. This version had one provider, a "New session" dialog, a fixture-model option, a lane-based Flow view and "Approve & continue"; all of these have since been replaced.

### Automated checks

`npm run verify` passed JavaScript syntax checks, 26 existing prototype tests, four existing CLI interaction scenarios, and 32 new tests:

- 11 real-VM engine tests: exact patches, unchanged-file filtering, fresh approval on each repair, three-judgment limit, decline, empty proposals, patch limits, cancellation, typed tool validation, skipped tests, and verification-only runs.
- 14 workspace tests: bounded reads, protected paths, symlinks/hardlinks, stale edits, concurrent patches, cancellation before writes, three actual failing-to-passing fixture projects, process cancellation, timeouts and output limits.
- 7 session/HTTP tests: real chat-to-VM flow, approval and persistence, decline/cancel, shared-workspace locking, interruption on restart, SSE/export/origin guards, model-free `/test`, late-result fencing, and storage failure without an unhandled background rejection.

`npm run test:browser` passed against real Chromium. It drives a scenario through the actual browser interface: create session, submit prompt, inspect exact diff, approve, observe passing tests, inspect the flow and executed ALLEN source, browse the changed file, run `/test`, reload the saved session, cancel a second scenario, and inspect mobile layout. There were no uncaught browser errors. Fixture judgments keep this test reproducible; filesystem changes, test processes and JOSH/ALLEN execution are real.

### Actual model runs

**Pricing, session engine:** real conversation routing and a real coding judgment produced a one-file patch correcting discount-before-tax calculation. After a labelled automated fixture approval, the real host wrote the file and all four tests passed. Typed result: `accepted:true`, `changed:1`, `attempts:1`, `passed:true`.

**Slug utility, full GUI:** the browser created a Live session and submitted the scenario prompt. A real model proposed a normalized slug implementation. The automated browser driver inspected the proposal and clicked approval in the isolated scenario. SHOUT wrote the file, ran the real test process, and returned `accepted:true`, `changed:1`, `attempts:1`, `passed:true`; all five tests passed. The UI and trace showed completion. This run used a router judgment (557 input / 57 output tokens reported) and a coding judgment (964 input / 289 output tokens reported). These are observations, not a cost benchmark.

All live verification approvals were automated test actions. They are not claims of actual human approval. The templates and SHOUT source were not modified by those coding runs; each ran in a freshly created scenario workspace.

### Issues found during verification

- Typed JOSH prompts initially displayed as `[object Object]`; the UI now renders the question and proposed summary explicitly.
- Node's outer test-runner environment could make nested `node --test` commands silently skip work. Workspace commands now remove inherited `NODE_TEST_*` flags, and the scenario tests prove real failure before the patch and success after it.
- Late file-tool completion could update a newer task's UI after cancellation. Generation checks now fence the update, and the workspace stays locked while cancelled operations drain.
- A final background save failure could become an unhandled rejection. It is now caught and surfaced as an unsaved-session warning; it does not convert a successful coding result into a fabricated saved result.
- Test-only requests could previously return an empty patch without testing. `/test` and the router's test action now execute a dedicated ALLEN verification workflow.
- Hardlinked regular files could bypass path-only confinement. Opened read/write handles now reject multiple links. Cancellation is rechecked before truncation and writing.

### Scope of the result

This proved a local GUI coding workflow with real model judgments, real ALLEN control flow, real changes and tests, and inspectable execution history. It did not prove arbitrary large-repository competence, production isolation, same-agent callbacks, multiple model providers, model-written ALLEN, or VM recovery after restart. Sessions restored as records; interrupted execution was explicitly marked and could not resume. (Two providers and model-written ALLEN have since been added; production isolation and VM recovery still have not.)
