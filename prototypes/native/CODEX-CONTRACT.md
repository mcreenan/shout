# Codex native adapter contract

Verified against installed `codex-cli 0.153.3` on 2026-09-23. Exact type details below come from locally generated protocol types (`codex app-server generate-ts --experimental --out /tmp/native-codex-protocol`). This research did not make model calls.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) establishes stdio newline-delimited JSON messages, the initialize handshake, experimental dynamic tools, and the turn notification lifecycle. The dynamic-tool interface is experimental. Initialize once, acknowledge with `initialized`, then create threads and turns. `turn/interrupt` returns an empty result and the turn subsequently completes with interrupted status. `outputSchema` constrains the final assistant response for that turn only.

## Minimal wire examples

Start `codex app-server --listen stdio://`. Keep stderr separate from stdout. Each JSON object below is one newline-terminated message. Wait for each request's response before using its result.

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"josh_native_prototype","title":"JOSH Native Prototype","version":"0.1.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
```

After the initialize response:

```json
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"ephemeral":true,"approvalPolicy":"never","sandbox":"read-only","developerInstructions":"Use allen_run to execute the requested ALLEN workflow. Leave control flow and callback routing to the adapter.","dynamicTools":[{"type":"function","name":"allen_run","description":"Execute a bounded ALLEN program and return its result.","inputSchema":{"type":"object","properties":{"source":{"type":"string"}},"required":["source"],"additionalProperties":false}}]}}
```

Read `result.thread.id` from response ID 2. The current generated union **requires `type: "function"`** for a function declaration; old examples omitting the discriminator may be stale. `deferLoading` is optional and should be omitted for the first experiment.

```json
{"id":3,"method":"turn/start","params":{"threadId":"THREAD_ID","input":[{"type":"text","text":"Run the requested workflow.","text_elements":[]}]}}
```

Read `result.turn.id` from response ID 3. A tool invocation is a server request, not a notification:

```json
{"id":77,"method":"item/tool/call","params":{"threadId":"THREAD_ID","turnId":"TURN_ID","callId":"CALL_ID","namespace":null,"tool":"allen_run","arguments":{"source":"..."}}}
```

Respond to the **request ID**, not `callId`:

```json
{"id":77,"result":{"contentItems":[{"type":"inputText","text":"{\"result\":42}"}],"success":true}}
```

For an ALLEN or callback failure, return `success:false` and readable diagnostic text. Preserve a typed failure inside the ALLEN callback protocol when the program can handle it. Do not let exceptions leave the server request unanswered.

## Nested model judgment callback

Create another ephemeral thread for a judgment callback, with no ALLEN dynamic tool to prevent uncontrolled recursive execution. Supply the callback's explicit prompt/context. Use an object-root schema (wrap primitive values in an object):

```json
{"id":4,"method":"thread/start","params":{"ephemeral":true,"approvalPolicy":"never","sandbox":"read-only","developerInstructions":"Provide the requested judgment using the supplied context. Return the requested structured response."}}
{"id":5,"method":"turn/start","params":{"threadId":"CALLBACK_THREAD_ID","input":[{"type":"text","text":"Choose the appropriate next action from the supplied evidence.","text_elements":[]}],"outputSchema":{"type":"object","properties":{"decision":{"type":"string"}},"required":["decision"],"additionalProperties":false}}}
```

The first response must precede sending the second request. Match callback notifications using both thread and turn IDs. Observe `item/completed` where `params.item.type === "agentMessage"`, recording `params.item.text`; prefer `phase === "final_answer"` if several messages occur. Parse and independently validate that text when `turn/completed` reports `status === "completed"`. Reject `failed` and `interrupted`. Do not rely on `turn.items` being populated: the generated `Turn.itemsView` explicitly describes partial item loading.

Independent threads are the intended integration route. The docs/type contract does **not** explicitly guarantee a second thread's turn will execute while the first thread awaits a dynamic tool result. Verify this with the live prototype. Never try to get the callback judgment by starting a new turn on the waiting parent thread: active-turn input can be queued/steered and is not a separate callback invocation.

The client reader must continue dispatching messages while handlers await callback turns. For example, invoke asynchronous server-request handling from a line event without awaiting it in the reader loop, and attach a rejection handler. Otherwise the client itself deadlocks even if the server supports concurrent threads.

## Cancellation and ownership

```json
{"id":6,"method":"turn/interrupt","params":{"threadId":"CALLBACK_THREAD_ID","turnId":"CALLBACK_TURN_ID"}}
```

Interrupt all active child turns when the parent is cancelled, terminate or cancel the corresponding ALLEN execution, and settle pending promises. Maintain a map keyed by `(threadId, turnId)`; avoid one global turn waiter. Register notification listeners before `turn/start` so fast completion cannot race registration. Every RPC and callback needs a bounded timeout.

No shutdown RPC appeared in the inspected generated client request interface. For an adapter-owned stdio child, first interrupt work, close stdin, wait a bounded grace period, then signal the child if it remains. Always handle spawn errors, process exit, broken pipes, malformed JSON, and a bounded stderr tail. Reject outstanding RPCs and turn promises on exit. Do not attach to or terminate the user's shared app-server daemon.

The server inherits local Codex configuration unless overridden. `ephemeral` limits conversation persistence but does not disable configured tools, MCP servers, instructions, or skills. A child judgment thread with no dynamic tools still has Codex built-ins. A pure tool-free model boundary therefore needs additional provider/harness configuration; do not claim it from the empty `dynamicTools` list alone.
