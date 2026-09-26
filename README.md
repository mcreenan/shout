# SHOUT

SHOUT explores a unified agent harness and programming runtime, building on the earlier JOSH/ALLEN research.

## Coding workspace GUI

SHOUT now has a local browser app: chat with a coding agent, inspect proposed file changes, approve edits, run tests, and watch model/tool/VM interactions in **Session VIZ**.

```sh
npm run setup
npm start
```

Open **http://127.0.0.1:4310**. Choose **New session** for your own workspace, or click one of the three guided scenarios. Live mode uses your signed-in **Codex CLI 0.153.3**; **Fixture** mode uses explicitly scripted judgments with real ALLEN execution, file edits and tests.

- **Fix a checkout calculation:** repair discount/tax ordering.
- **Implement a missing slug utility:** add normalized, tested string handling.
- **Unify inconsistent validation:** refactor two entry points around one rule.

Send the prepared prompt, inspect **Changes**, and choose **Approve & continue**. ALLEN handles the execution and bounded repair loop; every new patch requires approval. Enter `/test` to run the configured tests directly, without a model call. Open **Session VIZ** to explore the flow, filter events, inspect tool inputs/results, or read the exact executed ALLEN source.

Sessions and traces persist locally; in-flight executions become interrupted after an app restart. Workspace reads and edits are bounded to small projects. Full usage, architecture, limits and verification: **[GUI guide](apps/shout/README.md)**.

```sh
npm run verify        # 58 automated tests plus original interactive checks
npm run test:browser  # Real Chromium UI acceptance flow (offline model fixtures)
```

Browser tests use `/usr/bin/chromium`, `CHROMIUM_BIN`, or Playwright's installed Chromium (`npx playwright install chromium`). The app itself only needs your normal browser.

## Original harness prototypes

Two working prototypes explore the same principle: deterministic code handles orchestration; models make judgments. Both use the existing, pinned JOSH/ALLEN compiler and VM.

| Prototype | What owns the conversation | Start here |
|---|---|---|
| Native adapter | Existing Codex app-server harness; ALLEN is a native dynamic tool | [Native README](prototypes/native/README.md) |
| Owned harness | Our session, command router and execution kernel; bounded Codex workers supply judgments | [Owned README](prototypes/owned/README.md) |

Both completed actual model-backed runs. Their original verification includes 26 automated tests and four independent interactive scenarios. See [implementation findings and comparison](docs/IMPLEMENTATION-FINDINGS.md) and [verification evidence](docs/PROTOTYPE-VERIFICATION.md).

## Try them

Requirements: Linux with Bash, Git, `flock`, a Rust/Cargo toolchain, and Node 22+ with npm. Initial setup downloads the pinned upstream runtime and npm dependencies. Live runs additionally require **Codex CLI 0.153.3**, signed in through its normal login. Offline runs need no model credentials.

```sh
git clone https://github.com/mcreenan/shout.git
cd shout
npm run setup
npm run verify

# Real ALLEN, deterministic model decisions and labelled scripted answers:
npm run native:demo
npm run owned:demo

# Actual model decisions; labelled scripted answers:
npm run native:live
npm run owned:live
```

For interactive native usage, run `npm run native`, then enter `/live` (actual model) or `/run` (fixture model). Copy the displayed question ID into `/answer QUESTION_ID true`. Use `/status`, `/cancel`, and `/quit` while it runs. The native prototype permits one execution per process.

For interactive owned usage, run `npm run owned`, then say `Please triage the synthetic tickets` or enter `/review`. Answer with `/answer QUESTION_ID {"accept":true}`. Ordinary chat can select the registered workflow or reply. `/status`, `/cancel`, `/trace`, and `/quit` are available. Use `npm run owned -- --fixture` for offline interaction.

These are terminal prototypes with visible JSON event traces. The native tool can accept ALLEN source and input; the owned harness supports `/run file.allen [input.json]`. Both use independent `model.request` judgments, not same-agent `agent.ask`. Neither resumes after a process restart. The track READMEs describe capability and schema limits.

## Original proposal

The research below preceded implementation. Its proposed features and estimates are not a claim that all of them now exist.

- [Read the detailed proposal](docs/unified-agent-runtime-proposal.md)
- [Open the browser edition](docs/unified-agent-runtime-proposal.html) — rendered diagrams, navigation, and print styling; no network required
- [Printable PDF](docs/unified-agent-runtime-proposal.pdf)
- [JOSH/ALLEN source audit](docs/research/josh-allen-audit.md)
- [Harness and protocol research](docs/research/harness-protocols.md)
- [Durable runtime precedents](docs/research/runtime-precedents.md)

Research date: 23 September 2026. JOSH/ALLEN source pinned to [`abb8a978`](https://github.com/mcreenan/josh-allen/tree/abb8a9782fc438d1b87e8aa2fdaea65e5db633c3). The report distinguishes existing capabilities, proposed behavior, estimates, and untested hypotheses.

The main report includes architecture and lifecycle diagrams, four practical scenarios, a recovery trace, alternatives, obstacles, estimated effort, and explicit continue/pivot criteria. Supporting notes contain primary-source citations and the scope of verification.

Implementation was delegated into `.worktrees/native` (`prototype/native-adapter`) and `.worktrees/owned` (`prototype/owned-harness`), with independent helper audits. Both implementations are integrated under `prototypes/` on `main`; the worktrees remain available. [Work order](docs/PROTOTYPE-WORK-ORDER.md) · [Completion checklist](docs/PROTOTYPE-PROGRESS.md).
