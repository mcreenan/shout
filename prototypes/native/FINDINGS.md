# Native adapter findings

The smaller native-adapter path works for the target callback-routing problem. The parent Codex harness itself invoked a dynamic tool, waited while JOSH executed real ALLEN and a separate Codex thread supplied typed judgment, then received the typed result. No parent-model turn relayed a callback response. This is materially different from merely using Codex as the judgment provider for an otherwise custom harness.

## Observed vertical slice

The live run used a synthetic authorization/retry review. ALLEN reduced three findings to two, Codex identified both as worthy of human review, `review.save` returned `review:2:true`, and a clearly labelled scripted fixture supplied the final Boolean answer. The parent Codex turn then summarized the typed result. The transcript stays in ignored scratch storage; the command is reproducible with the logged-in CLI.

The successful route requires two independent asynchronous transports: Content-Length framed JOSH requests and newline-delimited Codex JSON-RPC. The reader must continue dispatching while an `item/tool/call` handler awaits a child thread. Awaiting the handler directly inside a blocking message reader would deadlock this integration.

## Friction discovered

1. **Documentation drift exists even at a pinned revision.** JOSH's agent-facing protocol guide describes netstring framing, while the pinned `josh serve` binary and Python bridge use Content-Length headers. This adapter follows the actual implementation. The ALLEN reference remains useful for syntax and typed effects.
2. **Wire schemas are wrapped.** A JOSH callback supplies `response_schema: { descriptor, digest }`; the descriptor is the actual JSON Schema. Passing the outer wrapper to Codex structured output fails. The fixture's descriptor is directly usable after wrapping the value in an object-root schema.
3. **A reserved word can appear in a catalog name but break source access.** The first local tool name, `review.record`, collided with the language's `record` keyword when used in source. Renaming the fixture tool to `review.save` solved it.
4. **Codex dynamic tools are an experimental API.** Installed version 0.153.3 requires a `type: "function"` discriminator, experimental initialization and an `item/tool/call` response using the JSON-RPC request ID. Pinning the adapter and re-generating installed protocol types is necessary when upgrading.
5. **Separate model judgment is easy; true invoking-agent continuation remains open.** This prototype intentionally implements `model.request` rather than pretending that an unrelated child conversation is `agent.ask`. The same-agent transcript/turn contract still requires design.
6. **CLI authentication solved access, not capability isolation.** Codex app-server lacks the `exec --ignore-user-config` launch switch. Existing configuration can advertise builtins/integrations. The adapter observes and rejects unexpected tool events; stronger tool-free worker restrictions are separate engineering. It never reads or copies auth files.

## Evidence and limits

`npm test` covers actual JOSH execution, filtering, malformed judgment output, correlated user answers, two concurrent run IDs, cancellation while waiting or during judgment, late provider results, a judgment budget and one-shot/source-size checks. `npm run live` tests the real Codex parent and callback thread. The automated live answer is a fixture, not human approval; `npm start` provides the actual interactive wait/answer/cancel path.

Counters establish routing structure, not economics. The workflow makes one judgment call but the parent harness also makes model calls to select the tool and summarize. No controlled token benchmark against the older prompt relay was performed. The work suggests trying a native adapter first for existing-harness adoption while retaining the owned-runtime path for session UX, policy and durable execution.

A separate actual-live cancellation probe cancelled immediately after the nested judgment thread started, then sent `/quit`. The CLI exited code 0, the VM reported cancellation without invoking the tool or asking the user, and all nine observed owned process IDs were gone. A deterministic stalled-handshake peer exposed an initialization ownership gap; the client is now retained before `open()` is awaited and the regression proves cancellation/quit reaps that peer in about one second.
