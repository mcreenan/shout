# Prototype work management

## Accepted scope

Local, single-user conversational runtime. Deterministic code owns orchestration; models make judgment calls. Two independently runnable prototypes use the existing ALLEN compiler and runtime. The shared definition of done is in [the work order](PROTOTYPE-WORK-ORDER.md).

## Workstreams

| Track | Branch and worktree | Approach | Status |
|---|---|---|---|
| Native adapter | `prototype/native-adapter`, `.worktrees/native` | Codex app-server dynamic tool dispatching ALLEN natively | Implementing |
| Owned harness | `prototype/owned-harness`, `.worktrees/owned` | Own terminal session/kernel, JOSH native protocol, bounded Codex judgment worker | Implementing |
| Shared infrastructure and acceptance | `main` | Pinned JOSH build, common launch commands, independent verification and comparison | Pinned build completed |

## Verification milestones

- [x] Create Git repository and two isolated worktrees.
- [x] Record explicit acceptance criteria and delegate parallel implementation.
- [x] Compile pinned JOSH and ALLEN binaries from original source.
- [x] Verify supported local model authentication is available.
- [ ] Native adapter real-VM offline suite and live harness demonstration.
- [ ] Owned harness real-VM offline suite and live judgment demonstration.
- [ ] Independently drive question, status, answer, and cancellation paths.
- [ ] Review lifecycle behavior and fix failures.
- [ ] Integrate both prototype directories and publish run instructions and findings locally.

No restart-resume or production-sandbox guarantee is implied by completion of this first routing experiment. Each track documents its actual semantics and limits.
