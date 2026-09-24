# Prototype work management

## Accepted scope

Local, single-user conversational runtime. Deterministic code owns orchestration; models make judgment calls. Two independently runnable prototypes use the existing ALLEN compiler and runtime. The shared definition of done is in [the work order](PROTOTYPE-WORK-ORDER.md).

## Workstreams

| Track | Branch and worktree | Approach | Status |
|---|---|---|---|
| Native adapter | `prototype/native-adapter`, `.worktrees/native` | Codex app-server dynamic tool dispatching ALLEN natively | Complete and integrated |
| Owned harness | `prototype/owned-harness`, `.worktrees/owned` | Own terminal session/kernel, JOSH native protocol, bounded Codex judgment worker | Complete and integrated |
| Shared infrastructure and acceptance | `main` | Pinned JOSH build, common launch commands, independent verification and comparison | Complete |

## Verification milestones

- [x] Create Git repository and two isolated worktrees.
- [x] Record explicit acceptance criteria and delegate parallel implementation.
- [x] Compile pinned JOSH and ALLEN binaries from original source.
- [x] Verify supported local model authentication is available.
- [x] Native adapter real-VM offline suite and live harness demonstration.
- [x] Owned harness real-VM offline suite and live judgment demonstration.
- [x] Independently drive question, status, answer, and cancellation paths.
- [x] Review lifecycle behavior and fix failures.
- [x] Integrate both prototype directories and publish run instructions and findings locally.

Root reran setup, verification, both offline demos and both live demos from integrated `main`. The native suite passed 9 tests, the owned suite passed 17, and the shared subprocess driver passed four interactive scenarios. Live runs returned typed completed results and recorded zero model-generated forwarding envelopes. See [verification evidence](PROTOTYPE-VERIFICATION.md) for exact scope.

No restart-resume or production-sandbox guarantee is implied by completion of this first routing experiment. Each track documents its actual semantics and limits.
