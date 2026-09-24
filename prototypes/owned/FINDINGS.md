# Owned-harness findings

Verified 2026-09-23 America/New_York (2026-09-24 UTC).

## Result

The owned runtime can orchestrate the existing ALLEN compiler and VM without model-written forwarding envelopes. The actual terminal application successfully runs plain chat, model selection of a registered workflow, deterministic ALLEN processing, independent typed model judgment, native tool invocation, a pending user question, continuation and typed completion.

The native process boundary is adequate for this slice. A new VM or programming language was unnecessary. The important component is the code that owns pending effects, operation identity, provider execution, user answers and cancellation.

## Verified behavior

The direct live run used one actual Codex judgment: 421 input tokens and 55 output tokens reported by the worker. ALLEN reduced four input tickets to two candidates before the call. The model chose the duplicate-charge incident. The host wrote a scratch review draft, surfaced a question, supplied the explicitly labelled scripted fixture answer, and returned a schema-valid `ReviewResult`. Three callback responses were dispatched by code; no model supplied a forwarding envelope.

A separate real chat session made two outer judgment calls: one conversational reply (465 input / 51 output tokens), then one registered-review selection (523 / 33). Its ALLEN run made one further judgment (413 / 37) and completed the same workflow. These observations show routing ownership, not a measured token-savings comparison with another harness. The event transition count is an application-observation count, not VM instruction count.

The offline suite uses actual JOSH processes and ALLEN source, with model doubles only where reproducibility is needed. It verifies eligible candidate reduction, typed answers, status while waiting, duplicate/late/cross-run rejection, model cancellation and late replies, malformed judgment rejection, semantic invalid-selection rejection, plain-chat routing, cancellation during asynchronous source loading, a different pure program, compile errors, source bounds, model budgets, repeated native tool use, VM interruption, wall-time expiry and actual CLI exit with its input pipe still open.

## Engineering discoveries

1. **Typed callbacks were already sufficient.** The host can freeze a catalog, load source, start execution and route the existing protocol. It never needs to ask the model to identify the next provider operation.
2. **The callback descriptor is not generally JSON Schema.** Records and ordinary scalars translate directly, but ALLEN-specific enums/maps/newtypes need explicit converters. The prototype rejects unsupported shapes. Codex output is wrapped in a root object so a supported scalar callback can still be represented by the provider's structured-output interface.
3. **Catalog validation is stricter than casual JSON.** Required field lists must be canonically sorted. Actual wire framing is `Content-Length` plus the JOSH content type; source behavior is the authority.
4. **Ownership needs explicit late-result checks.** Every effect has a run-scoped ID and cancellation signal. A late model result must be discarded before tool dispatch. Async source loading also needs a session generation check or `/cancel` can accidentally be followed by a delayed start.
5. **A successful model answer does not prove a restricted worker.** Disabling Codex features alone left built-ins visible. A local override of bundled model metadata plus supported flags produced two audited live probes with no available tools and no tool events, including an adversarial request to call a tool. The wrapper rejects non-message/reasoning items and provider failures. This is a version-specific adapter contract, not a general security sandbox theorem.
6. **Provider completion must be explicit.** Independent review found that a zero process exit plus valid output file could conceal a truncated event stream. The worker now requires `turn.completed`, validates the trailing JSONL buffer, and rejects tool items even without a final newline; four subprocess regressions cover this boundary.
7. **Terminal UI lifecycle matters.** Closing readline alone can keep an input pipe alive. The explicit `/quit` path now closes owned work and destroys stdin; the subprocess regression covers it.

## Tradeoffs and next step

This application genuinely owns the outer harness, but reuses Codex as a bounded independently invoked model worker. It does not prove same-agent `agent.ask` semantics, direct API-provider portability, model-authored ALLEN reliability, persistent sessions or crash recovery. The ALLEN process is a live worker; an in-memory wait is not durability.

The next useful extension is to add one direct provider implementation behind the same `judge` interface, then compare it with this supported-login worker. After that, model-authored source could be introduced as a separately validated structured action with compiler diagnostics and bounded repair. Durability should be another explicit experiment with effect intent/outcome recording, rather than inferred from the current traces.

The owned approach provides clean placement for conversation policy, task status and interruptions. Its extra work is the session/UI/provider lifecycle that an existing harness would otherwise supply. The smaller native-adapter prototype can decide whether this additional product ownership is worthwhile.
