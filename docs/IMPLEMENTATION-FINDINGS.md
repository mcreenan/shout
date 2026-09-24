# Findings from building the two prototypes

This records observed implementation facts. Final run results and recommendations will be added after independent verification.

## Reused foundation

Both tracks use real `josh serve` and the existing ALLEN compiler/VM at revision `abb8a9782fc438d1b87e8aa2fdaea65e5db633c3`. The pinned binaries compiled successfully from source. Native routing is implemented in ordinary host code, bypassing the prompt-assisted MCP relay.

## JOSH framing reference mismatch

The native workstream observed that the agent-facing protocol reference describes netstrings, while the pinned executable and framing implementation use `Content-Length` / `Content-Type` headers. Both implementations must use the actual byte protocol. This is a documentation mismatch in the original project, not a reason to replace the runtime.

## Harness choices

The native track selected Codex app-server because its installed schema exposes client-executed dynamic tools and supported local login was available. Pi and OpenCode were considered; neither had locally configured authentication in the checked standard locations. Selection is practical for this experiment, not a conclusion about their comparative capability.

The owned track uses a separate bounded Codex execution for typed judgments while its own code controls the conversation, programs, questions, tools, and cancellation. This tests ownership of orchestration while borrowing a model worker. It does not yet establish a direct-provider implementation or same-agent callback semantics.

## Interpretation limits

The tracks use different synthetic review inputs. Compare execution ownership and lifecycle behavior; their token or latency totals are not a controlled performance comparison. Offline fixture decisions and automated fixture answers must remain visibly labelled. Live demonstrations exercise real model decisions with the same runtime path.
