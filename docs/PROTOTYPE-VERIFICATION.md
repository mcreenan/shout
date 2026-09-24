# Integrated prototype verification

Verified 23 September 2026 America/New_York (24 September UTC), from the integrated main workspace. This records actual runs, not planned checks.

Environment: Node 22+, Linux, Codex CLI 0.153.3 using its existing supported login, JOSH/ALLEN revision `abb8a9782fc438d1b87e8aa2fdaea65e5db633c3`. The original compiler/VM was built from source without modification.

| Command | Observed result |
|---|---|
| `npm run setup` | Pinned runtime available; both lockfiles installed successfully |
| `npm run verify` | JavaScript syntax checks; 9 native tests; 17 owned tests; four independent interactive scenarios—all passed |
| `npm run native:demo` | Real VM, fixture model, scripted answer; typed completion |
| `npm run owned:demo` | Real VM, fixture model, scripted answer; typed completion and scratch draft |
| `npm run native:live` | Real parent Codex tool call, real child judgment, real VM, typed result returned to parent; exit 0 |
| `npm run owned:live` | Real restricted Codex judgment, real VM, scratch tool, typed result returned to session; exit 0 |

The script named `typecheck` performs `node --check` syntax validation of plain JavaScript. It is not a static type checker. Runtime callback validation is separate and exercised by the tests.

## Live evidence

The native result contained `candidate_count: 2`, `recommend: true`, `receipt: "review:2:true"`, and `approved: true`. Its model identified authorization removal and unlimited retries as deserving review. The parent received this typed result and summarized it. Its trace recorded:

```json
{
  "modelJudgments": 1,
  "toolInvocations": 1,
  "userQuestions": 1,
  "deterministicDispatches": 3,
  "modelForwardingEnvelopes": 0
}
```

These counters describe the ALLEN execution. The parent harness also uses model calls to choose the tool and summarize the result; those are not included in `modelJudgments`.

The owned result contained `scanned: 4`, `eligible: 2`, `ticket_id: "T-100"`, and `accepted: true`, plus a draft and explanation prioritizing duplicate customer charges. Its worker reported 421 input and 56 output tokens in the root verification run, with zero accepted tool events. Its execution counters were one judgment, one native tool call, one user question, three automatic provider replies, and zero model-forwarding envelopes.

**All automated live demo answers were explicitly scripted fixtures, not real user approval.** Both interactive CLIs separately expose pending questions for actual answers. Neither fixture changes an external ticket, repository or service.

Root saved [sanitized integrated live evidence](prototype-live-evidence.json) containing both typed results, counters and the native parent's summary. Ignored raw traces are in `prototypes/native/.scratch/live-trace.json` and `prototypes/owned/.scratch/live-demo.json`; launch logs are in `.cache/verification/`. Raw files are overwritten by later runs. The owned track additionally preserves a [sanitized proof of its live direct and conversational runs](../prototypes/owned/evidence/live-proof.json). These measurements are evidence of routing, not a controlled cost comparison.

## Independent lifecycle checks

`tools/interactive-smoke.mjs` starts each real CLI as a subprocess with a deterministic model provider and the actual VM. It waits for a question, checks status while waiting, rejects the wrong ID, submits a valid answer, verifies completion, rejects a duplicate, and exits. A second run cancels while waiting and rejects a late answer. `/quit` must terminate even while the input pipe remains open. All four scenarios passed.

The native suite additionally covers concurrent run isolation, malformed model results, cancellation during model judgment, late model replies, judgment budgets and source limits. The owned suite covers those lifecycle boundaries plus chat selection, cancellation during asynchronous source loading, a different pure ALLEN program, compile errors, repeated tool calls, VM exit, wall-time expiry, and truncated/malformed model-worker streams.

A further live native cancellation probe interrupted the child judgment, observed ALLEN cancellation before tool/user continuation, and confirmed all nine observed owned processes exited. A stalled-initialization regression then exposed a startup ownership gap; the client is now retained before awaiting initialization and shutdown has bounded escalation. This regression is the ninth native test (the other eight use the actual VM).

This establishes the agreed bounded prototype slice. Restart recovery, same-agent callbacks, production capability isolation, model-authored program reliability and comparative token savings remain unproven.
