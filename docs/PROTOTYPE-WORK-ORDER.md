# Two working agent-runtime prototypes

## Objective and ownership

Build two independent executable prototypes of the accepted local, single-user scope in `unified-agent-runtime-proposal.md`. The runtime handles deterministic orchestration; models supply judgment wherever needed. Root owns requirements, dependencies, verification, comparison, and integration.

- Native track: an actual existing agent harness executes ALLEN through a native adapter. Own files under `prototypes/native/` in branch `prototype/native-adapter`.
- Owned track: a small application owns the session, command routing, task/effect lifecycle and ALLEN orchestration. Existing libraries or bounded coding/model workers are welcome. Own files under `prototypes/owned/` in branch `prototype/owned-harness`.
- Shared infrastructure is root-owned under `tools/` and `.cache/`. Request changes through root rather than racing on shared files.

Each track has its own Git worktree. Use explicit working directories for all commands. Commit working milestones on your branch; root will integrate both directories into the main workspace after review. Preserve the research documents.

## Required vertical slice

Use the real pinned JOSH/ALLEN compiler and runtime, revision `abb8a9782fc438d1b87e8aa2fdaea65e5db633c3`. Source and binaries are provided by `tools/setup-josh.sh`. Implement native `josh/1.6` routing or the Rust provider seam; the prompt-assisted Python MCP relay is not the execution path being tested.

Demonstrate a bounded review workflow: deterministic processing of fixture data, typed model judgment, a host tool invocation, a user question, continued execution, and a typed final result. The fixtures may be synthetic and harmless. The model sees meaningful decisions and task results, not request IDs or instructions to call a resume tool.

Required behavior:

1. The existing harness (native track) or owned application (owned track) starts an ALLEN program and receives its final outcome.
2. Tools and model callbacks are dispatched automatically by code. Run at least one actual model judgment through an available supported authenticated interface; use deterministic providers for reproducible acceptance tests too.
3. A pending user question has an ID; status remains available while waiting. The user can answer it and continue. Scripted demo answers must be explicitly labelled fixtures, never impersonated as real user approval.
4. Cancellation stops owned work. Wrong/late/duplicate answers and malformed model results do not cause successful execution or cross-run resolution.
5. Provide a visible event trace and counters identifying model judgment calls versus deterministic orchestration. Demonstrate zero model-generated forwarding envelopes.
6. Supply a simple setup/run command, interactive usage, and an offline automated verification command covering the real ALLEN runtime and lifecycle edge cases.

Restart recovery is optional in this first routing prototype. If implemented, state its exact profile and test it; otherwise accurately report interruption rather than claim resumability. No external mutations beyond scratch workspace files are needed.

## Implementation process

Read the local research audit for existing seams. When writing ALLEN, read its canonical language reference and applicable JOSH skill. When integrating provider APIs, verify the selected interface against current official documentation and installed types. Pin dependency versions.

Tell root your chosen approach and first milestone early. Send updates when a milestone passes, a blocker appears, or scope changes. Keep a concise `STATUS.md` in your track directory with completed work, current blocker, and exact verification commands.

Use subagents for concrete independent work such as protocol inspection, acceptance-test design, or a bounded code review. Four total concurrency slots exist: root, two track leads, and one helper. Coordinate the helper slot through root; do not block useful local work while waiting for it. Existing live sessions are also available through ordinary CLI/SDK interfaces when useful.

Protect credentials: use supported logged-in CLI/SDK paths or environment variables; report availability and errors without printing secrets. Keep runtime state and transcripts in ignored scratch directories. Initial live runs should be small, bounded, and limited to the synthetic workflow.

## Definition of done

A track is done when root can install it, run the real offline acceptance suite, drive the interactive wait/answer/cancel flow, and inspect evidence of at least one real model-backed end-to-end run. Tests alone using a mocked VM or a scripted model are insufficient. Document any narrower callback semantics (for example separate model judgment versus same-agent context) explicitly.

Deliver a README, executable source, fixtures, meaningful lifecycle verification, a findings note comparing the implementation with the proposal, and committed code. Root will independently review and rerun both prototypes before declaring completion.
