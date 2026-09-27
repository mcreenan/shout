# Sub-agents in SHOUT: implementation plan

Status: plan only, nothing implemented. Written 2026-09-27.
Design reference: [index.html](index.html), section **Flow B**, and `shots/flow-b-dark.png`.

## What we are building

1. SHOUT's agent can fan work out to sub-agents through one new tool, `spawn_agents`.
2. In Flow mode, a fan-out is one **fleet card** with a tile per sub-agent.
3. Clicking a tile opens that sub-agent in a dock tab, or focuses the tab if it is already open.
4. A sub-agent tab is Flow only. It has no Chat mode, no Chat/Flow switch and no composer.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Who orchestrates | SHOUT, through its own tool | Children keep SHOUT's tools and limits. Codex's native `multi_agent` stays disabled. |
| What a child is | Another thread on the session's own agent (`this.agent`) | `CodexAgent` and `ClaudeAgent` share `startThread` and `turn`, so one implementation serves both providers. |
| Child tools | `list_files`, `read_file`, `search_files`, `git` | Read-only children need no approvals and cannot collide on writes. The session tracks one `this.run` and one `question`, so writes wait for a later phase. |
| Nesting | None. Children do not get `spawn_agents` | Keeps cost and the UI bounded. |
| Where child events live | On the agent record, not in `session.events` | Children cannot evict the parent's history from the 3,000-event cap, and `buildFlow` needs no change because each child's log is sequential. |
| Tab placement | Beside the chat (`place(tab, { beside: true })`) | Same as "View program". The fleet card stays visible while you read a child. Change to `place(tab)` to open in the focused group instead. |

Because children are read-only in this version, the mock's "Needs approval" tile state cannot occur yet. Tile states are queued, running, completed, failed and cancelled.

## Data model

Add `agents: []` to the session record (default it in `SessionStore.attach` for older sessions).

```js
{
  id: 'agent-<uuid>',
  group: '<uuid>',          // the fan-out; equals the spawn tool step's effectId
  name: 'tester',           // model-chosen, /^[a-z][a-z0-9-]{0,23}$/, unique within the group
  brief: '...',             // the child's only input
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
  threadId: null,
  model, effort,            // copied from the session at spawn
  startedAt, endedAt,
  calls: 0,                 // tool calls made
  activity: '',             // present-tense line for the tile
  usage: { input_tokens, cached_input_tokens, output_tokens },
  report: '',               // the child's final message
  error: '',
  sequence: 0,
  messages: [],             // { id, role, content, time }; first is the brief as role 'user'
  events: [],               // same shape as session events; capped at 400
}
```

Parent-side events, in `session.events`:

- `tool.started { id: group, tool: 'agents.spawn', input: { purpose, agents: [{ id, name }] } }`
- `tool.completed` or `tool.failed` with the same `id`

Child-side events, in `agent.events`: `chat.started`, `chat.completed`, `chat.worker`, `tool.started`, `tool.completed`, `tool.failed`, `session.error`. These are the types `buildFlow` already folds.

Limits, as constants beside `MAX_AGENT_TOOL_CALLS` in `session.mjs`:

| Constant | Value |
|---|---|
| `MAX_FANOUT` (agents per call) | 8 |
| `MAX_CONCURRENT_AGENTS` | 4 |
| `MAX_SESSION_AGENTS` | 24 |
| `MAX_SUBAGENT_TOOL_CALLS` | 40 |
| `SUBAGENT_WALL_MS` | 10 minutes, off when `timeBudgetsEnabled` is false |
| `MAX_AGENT_EVENTS` | 400 |

## Phase 1: backend

Files: `apps/shout/src/session.mjs`, `apps/shout/test/doubles.mjs`, `apps/shout/test/session.test.mjs`.

1. **Tool definition.** Add `spawn_agents` to `agentTools`:
   ```js
   { name: 'spawn_agents',
     description: 'Run up to 8 independent read-only investigations at once, each by its own agent with a fresh context. ...',
     inputSchema: object({ purpose: string('What the agents are for, in a few words'),
       agents: { type: 'array', minItems: 1, maxItems: 8, items: object({ name: string('Short lowercase label'), brief: string('Complete, self-contained instructions') }) } }) }
   ```
2. **Instructions.** Add one bullet to `agentInstructions`: use `spawn_agents` for independent read-only questions; each brief must stand alone because the child sees nothing else; children cannot change files.
3. **Child tool set and instructions.** Add `subAgentTools` (the four `readTools` entries from `agentTools`) and `subAgentInstructions(name)`: you are a sub-agent of SHOUT; act only through your tools; you cannot change files; finish with one report message.
4. **`spawnAgents(input, controller, current)`**, called from `agentTool` when `tool === 'spawn_agents'`:
   - Validate names, count and `MAX_SESSION_AGENTS`. A bad input throws, which the model sees as a failed call.
   - Create the agent records as `queued`, emit the parent `tool.started`, set `data.status = 'running'`.
   - Run children through a small concurrency pool of `MAX_CONCURRENT_AGENTS`.
   - Use `Promise.allSettled`, so one failed child never fails its siblings.
   - Emit the parent `tool.completed`. If every child failed, emit `tool.failed` and throw.
   - Return one text block per child: `## <name> (<status>)\n<report or error>`. Split `RESULT_CHARS` evenly between children.
5. **`runAgent(agent, controller, current)`**, a trimmed copy of `converse`:
   - `startThread({ cwd, instructions, context, tools: subAgentTools })`, then `turn(threadId, brief, { thread, model, effort, signal, onToolCall, onEvent })`.
   - The signal is `AbortSignal.any([controller.signal, AbortSignal.timeout(SUBAGENT_WALL_MS)])`.
   - `onToolCall` enforces `MAX_SUBAGENT_TOOL_CALLS`, rejects any tool not in `subAgentTools`, and runs read tools through the existing `skillTools(current)` handler.
   - `onEvent` of type `message` appends to `agent.messages` and sets `agent.report` to the latest text. Type `usage` adds to `agent.usage`.
   - Emits the same `think`/`pause` chat steps as `converse`, into `agent.events`.
6. **`agentEvent(agent, type, detail)`**, beside `event()`: same shape, pushed to `agent.events`, capped at `MAX_AGENT_EVENTS`, then `changed()`.
7. **Cancel and restart.**
   - `cancel()` already aborts `this.controller`, which every child signal derives from. Also mark `queued` and `running` agents `cancelled`.
   - `SessionStore.init` marks `queued` and `running` agents `interrupted`, next to the existing run handling.
8. **Snapshot rate.** Several children emitting at once multiplies `changed()` calls, and each one clones and sends the whole session. Coalesce the `snapshot` emit in `changed()` to one per 50 ms (trailing edge), keeping the revision bump immediate.
9. **Test double.** `ScriptedAgent.turn` passes `threadId` and the `thread` options to the script, so a test can script the parent and each child differently.

Tests to add in `session.test.mjs`:

- A fan-out of three runs the children concurrently, records three agents, and returns all three reports to the parent.
- With six children, no more than four are `running` at once and the rest start as `queued`.
- A child that throws is `failed`; its siblings complete; the parent's call succeeds.
- A child calling `run_program` or `spawn_agents` gets a failed tool call.
- Cancelling the session interrupts every child and leaves no `running` agent.
- A restart marks unfinished agents `interrupted`.
- Child events never appear in `session.events`.

## Phase 2: fleet card in Flow

Files: `apps/shout/public/flow-graph.js`, `flow-canvas.js`, `style.css`, `index.html`, `apps/shout/test/flow.test.mjs`.

1. **Graph.** In `flow-graph.js`:
   - `stepNode` returns `{ type: 'fleet', kind: 'agent', group: <effectId of tool.started> }` when `step.label === 'agents.spawn'`.
   - `phases` gives a fleet node a row of its own (`row('fleet')`), so it never shares a line with other actions.
2. **Rendering.** In `flow-canvas.js`:
   - Add `renderFleet(e, node)` to `RENDER`. It reads `s.session.agents` filtered by `group`.
   - Head: "`N` agents", the `purpose`, elapsed time.
   - One `<button class="fleet-tile {status}" data-agent="{id}">` per agent, holding the state mark, name, timer, the `activity` line (or the first line of `report` when done, or `error`), and a strip of its last six steps coloured by kind.
   - `expandable(node)` returns false for `fleet`.
3. **Freshness.** Tiles change without the parent's events changing, so:
   - add `view.session.revision` to the frame signature in `frame()`;
   - add each agent's `status`, `calls` and `activity` to `nodeSignature` for fleet nodes.
4. **Tile timers.** `renderNode` collects the tile timer elements on the entry; `draw` updates them each frame as it does `entry.timer`.
5. **Click.** `createFlowCanvas` takes a new option `openAgent(id)`. The `nodesLayer` click handler checks `event.target.closest('.fleet-tile')` first and calls it. The drag handler already ignores buttons.
6. **Styles.** Port from the mock's `<style>` block into `style.css`:
   - the `--agent` token in all three theme blocks (`#c2267e` light, `#f472b6` dark);
   - `.fl-card.fleet`, `.fleet-grid`, `.fleet-tile`, `.fleet-top`, `.fleet-now`, `.fleet-bar`, `.agent-state`, `.le.agent`;
   - change `.fleet-grid` to `repeat(auto-fill, minmax(160px, 1fr))` so it narrows with the pane.
   - No left accent borders, as in the mock.
7. **Icon.** Add the `i-agents` symbol from the mock to `index.html`.

Tests to add in `flow.test.mjs`: a spawn step becomes one `fleet` node alone in its row, with edges from the hub before it and to the hub after it.

## Phase 3: sub-agent tab

Files: `apps/shout/public/layout.js`, `app.js`, `flow-graph.js`, `flow-canvas.js`, `style.css`, `apps/shout/test/layout.test.mjs`, `tools/gui-browser-smoke.mjs`.

1. **Tab kind.** In `layout.js`:
   - add `'agent'` to `TAB_KINDS`;
   - `serialize` keeps the `agent` field;
   - `restore` drops an agent tab whose `agent` is not a string.
2. **Open or focus.** In `app.js`, following `openSkill`:
   ```js
   function openAgent(id) {
     const existing = Object.values(state.layout.tabs).find((tab) => tab.kind === 'agent' && tab.agent === id);
     if (existing) activate(state.layout, existing.id);
     else place({ id: uid('agent'), kind: 'agent', agent: id }, { beside: true });
     commitLayout();
   }
   ```
   Pass `openAgent` to the chat's `createFlowCanvas` call in `syncFlowCanvas`.
3. **Pane.** `agentPane(tab)` builds:
   - a header bar: "Session › `name`", status pill, model and effort, token total;
   - a collapsed "Brief" line that expands to the full brief;
   - a `.flow-stage` with its own `createFlowCanvas` instance.

   It contains no `#chat-mode` switch and no composer. Wire it into `paneFor` and `tabInfo` (label is the agent name, icon `i-agents`, title is the brief).
4. **Canvas source.** Each agent pane's canvas reads:
   ```js
   () => {
     const agent = state.session?.agents?.find((item) => item.id === tab.agent);
     return agent && { session: { id: agent.id, messages: agent.messages, runs: [], revision: state.session.revision },
       events: agent.events, now: Date.now(), live: agent.status === 'running', actor: { name: agent.name, kind: 'agent' } };
   }
   ```
   Use a fixed `anchor` of 40, since nothing floats over this stage.
5. **Actor labels.** The canvas labels assistant messages "SHOUT" and gives them the brand extrusion. For a sub-agent:
   - `phases` accepts `actor` and `messageNode` uses `actor.kind` for assistant messages;
   - `renderMessage` uses `actor.name` for the head, and labels the first user message "Brief".
   - The parent's canvas passes no `actor`, so it renders as today.
6. **Lifecycle.**
   - Keep canvases in a `Map` by tab id. `renderDock` already removes panes whose tab is gone; call `canvas.stop()` there and in `selectSession`.
   - `applySnapshot` calls a new `renderAgentPanes()` to refresh header bars. The canvases poll on their own.
   - `renderTab` shows a status dot for agent tabs: `active` while running, `failed` on failure.
   - If the tab's agent is missing from the session (restored layout, pruned agent), the pane shows "This agent is no longer part of the session."

Tests to add:

- `layout.test.mjs`: an agent tab round-trips through `serialize` and `restore`; one without an `agent` string is dropped.
- `gui-browser-smoke.mjs`: clicking a tile opens one tab; clicking it again focuses that tab and opens no second one; the pane has a canvas and no `textarea`.

## Phase 4: verify against real providers

Run each check on a Codex session and a Claude session.

| Check | Why it matters |
|---|---|
| A parent tool call that stays open for five minutes still returns its result | Codex dynamic tools and Claude's in-process MCP tools may have call timeouts. If they do, `spawn_agents` must return early and deliver reports another way. |
| Four child turns run at once on one `codex app-server` | `CodexAgent` keys turns by thread, so it should work; the native prototype only proved one child. |
| Four concurrent Claude SDK queries under one parent query | Each child is its own Claude Code process. Check memory and start-up time. |
| Cancel during a fan-out stops every child within a few seconds | `turn/interrupt` on Codex, `abortController` on Claude. |
| A session with 24 finished agents still streams smoothly | Every snapshot carries every agent's events. If it drags, send agent logs on a separate route and keep only summaries in the snapshot. |

## Not in this plan

- Chat mode shows nothing for a fan-out, because it does not show any of the agent's direct tool calls today. The reports reach the user through SHOUT's reply.
- Children that write, run skills or ask for approval.
- Steering or stopping a single child.
- Per-agent lanes in the Inspector.
- Sub-agents from ALLEN programs (`agent/*` in the kernel).
- Mixing providers inside one session.

## Note on the code's current state

`session.mjs` was being edited while this plan was written: the Claude backend (`claude-agent.mjs`, `claude-provider.mjs`, `agentFor`, `providerFor`) landed during the research. The plan targets the shared agent interface rather than line numbers. Re-read `converse` and `agentTool` before starting Phase 1.
