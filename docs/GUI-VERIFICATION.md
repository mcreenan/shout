# SHOUT GUI verification

The coding GUI was verified against the existing JOSH/ALLEN revision `abb8a9782fc438d1b87e8aa2fdaea65e5db633c3` and the supported Codex CLI 0.153.3 judgment worker. This document records observed behavior. [Live evidence](gui-live-evidence.json) preserves the synthetic typed results and model usage.

## Automated checks

`npm run verify` passed JavaScript syntax checks, 26 existing prototype tests, four existing CLI interaction scenarios, and 32 new tests:

- 11 real-VM engine tests: exact patches, unchanged-file filtering, fresh approval on each repair, three-judgment limit, decline, empty proposals, patch limits, cancellation, typed tool validation, skipped tests, and verification-only runs.
- 14 workspace tests: bounded reads, protected paths, symlinks/hardlinks, stale edits, concurrent patches, cancellation before writes, three actual failing-to-passing fixture projects, process cancellation, timeouts and output limits.
- 7 session/HTTP tests: real chat-to-VM flow, approval and persistence, decline/cancel, shared-workspace locking, interruption on restart, SSE/export/origin guards, model-free `/test`, late-result fencing, and storage failure without an unhandled background rejection.

`npm run test:browser` passed against real Chromium. It drives a scenario through the actual browser interface: create session, submit prompt, inspect exact diff, approve, observe passing tests, inspect the flow and executed ALLEN source, browse the changed file, run `/test`, reload the saved session, cancel a second scenario, and inspect mobile layout. There were no uncaught browser errors. Fixture judgments keep this test reproducible; filesystem changes, test processes and JOSH/ALLEN execution are real.

## Actual model runs

**Pricing, session engine:** real conversation routing and a real coding judgment produced a one-file patch correcting discount-before-tax calculation. After a labelled automated fixture approval, the real host wrote the file and all four tests passed. Typed result: `accepted:true`, `changed:1`, `attempts:1`, `passed:true`.

**Slug utility, full GUI:** the browser created a Live session and submitted the scenario prompt. A real model proposed a normalized slug implementation. The automated browser driver inspected the proposal and clicked approval in the isolated scenario. SHOUT wrote the file, ran the real test process, and returned `accepted:true`, `changed:1`, `attempts:1`, `passed:true`; all five tests passed. The UI and trace showed completion. This run used a router judgment (557 input / 57 output tokens reported) and a coding judgment (964 input / 289 output tokens reported). These are observations, not a cost benchmark.

All live verification approvals were automated test actions. They are not claims of actual human approval. The templates and SHOUT source were not modified by those coding runs; each ran in a freshly created scenario workspace.

## Issues found during verification

- Typed JOSH prompts initially displayed as `[object Object]`; the UI now renders the question and proposed summary explicitly.
- Node's outer test-runner environment could make nested `node --test` commands silently skip work. Workspace commands now remove inherited `NODE_TEST_*` flags, and the scenario tests prove real failure before the patch and success after it.
- Late file-tool completion could update a newer task's UI after cancellation. Generation checks now fence the update, and the workspace stays locked while cancelled operations drain.
- A final background save failure could become an unhandled rejection. It is now caught and surfaced as an unsaved-session warning; it does not convert a successful coding result into a fabricated saved result.
- Test-only requests could previously return an empty patch without testing. `/test` and the router's test action now execute a dedicated ALLEN verification workflow.
- Hardlinked regular files could bypass path-only confinement. Opened read/write handles now reject multiple links. Cancellation is rechecked before truncation and writing.

## Scope of the result

This proves a local GUI coding workflow with real model judgments, real ALLEN control flow, real changes and tests, and inspectable execution history. It does not prove arbitrary large-repository competence, production isolation, same-agent callbacks, multiple model providers, model-written ALLEN, or VM recovery after restart. Sessions restore as records; interrupted execution is explicitly marked and cannot resume.
