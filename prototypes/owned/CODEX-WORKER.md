# Codex judgment worker contract

Verified with `codex-cli 0.153.3` on 2026-09-23. The worker uses the existing Codex login through the CLI. No authentication files or tokens were inspected, copied, or exported. The owned harness still owns routing, VM execution, callback dispatch, capabilities, and user interaction; Codex supplies one bounded structured judgment.

## The restriction that matters

Disabling feature flags alone did **not** make the installed Codex model tool-free. The first live probe still reported `apply_patch`, clock, collaboration, and code-mode tools. Disabling `code_mode_host` produced a code-mode-unavailable error item while the model still completed its answer. A successful final answer alone is insufficient evidence.

A local model-catalog override, combined with feature and configuration controls below, produced two successful live turns that reported no available tools and emitted no tool events. The second prompt explicitly requested a clock or shell call if available.

The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `model_catalog_json`, replacement model instructions, web-search policy, and project-document limits. The [official CLI reference](https://learn.chatgpt.com/docs/cli/reference) describes structured output and JSON event reporting. The installed `codex exec --help` also confirms `--ignore-user-config`: it skips the user configuration file while retaining normal CLI authentication. The catalog-field recipe below is a version-specific implementation finding, not a documented general guarantee that every future Codex release has a tool-free mode.

## Exact tested setup

1. Obtain the installed binary's bundled catalog with `codex debug models --bundled`, parsing stdout as JSON. This operation does not make a model inference call.
2. For **every** object in its `models` array, set:

```json
{
  "apply_patch_tool_type": null,
  "experimental_supported_tools": [],
  "shell_type": "disabled",
  "tool_mode": "none"
}
```

Preserve the other fields. Save the resulting JSON to a private temporary directory. These fields were accepted and behaviorally effective in the tested binary. Do not edit the global model catalog or Codex configuration.

3. Write the judgment's object-root JSON Schema and worker instructions into that directory. The tested instructions were:

```text
You are a bounded judgment worker. Use only supplied evidence. Do not call any tool. Return the requested JSON object. List tool names exposed to you in available_tools, but never invoke them.
```

The `available_tools` request is an audit measure, not a required production output field. The production worker should use its own narrow judgment schema.

4. Execute the following argument array, using absolute paths for the catalog, schema, instructions, and working directory. Supply the prompt through stdin and close stdin immediately after writing it. Array construction avoids shell interpolation.

```text
codex exec
  --ignore-user-config
  --ephemeral
  --sandbox read-only
  --skip-git-repo-check
  --strict-config
  --json
  --output-schema /absolute/path/schema.json
  --cd /absolute/path/isolated-working-directory
  -c approval_policy="never"
  -c web_search="disabled"
  -c project_doc_max_bytes=0
  -c skills.include_instructions=false
  -c agents.enabled=false
  -c tools.experimental_request_user_input.enabled=false
  -c tools.update_plan.enabled=false
  -c model_catalog_json="/absolute/path/restricted-models.json"
  -c model_instructions_file="/absolute/path/instructions.txt"
  --disable shell_tool
  --disable unified_exec
  --disable apps
  --disable plugins
  --disable multi_agent
  --disable multi_agent_v2
  --disable browser_use
  --disable computer_use
  --disable image_generation
  --disable view_image
  --disable hooks
  --disable code_mode
  --disable code_mode_host
  --disable skill_search
  --disable goals
  --disable sleep_tool
  --disable tool_suggest
  --disable memories
  -
```

The probes used the same flags but ran in the prototype directory and supplied the prompt as an argument. An isolated working directory and stdin are recommended for the actual provider. The `-c` argument values are TOML; preserve the inner quotation marks when constructing the argument array. `apply_patch_freeform` is listed as **removed** by this binary's feature command and must not be relied on as an enforcement control.

## Live evidence

The schema required `decision` (`retry` or `stop`), `reason` (string), and `available_tools` (array of strings), with `additionalProperties: false`.

| Probe | Prompt evidence | Result | Tokens | Events |
| --- | --- | --- | --- | --- |
| Feature flags alone | Two HTTP 503 responses, read-only request, three-attempt budget | Correct `retry`; built-ins still advertised; code-mode error item | 3,962 input / 217 output | Included error item |
| Restricted model catalog | Same evidence | `retry`; `available_tools: []` | 349 input / 40 output | Only lifecycle and one agent message |
| Restricted catalog, explicit tool request | Exhausted budget; request clock or `pwd` if available | `stop`; explanation that no clock or shell is available; `available_tools: []` | 370 input / 36 output | Only lifecycle and one agent message |

Both restricted probes emitted exactly:

```text
thread.started
turn.started
item.completed  (item.type = agent_message)
turn.completed
```

The actual final objects were:

```json
{"decision":"retry","reason":"The transient HTTP 503 occurred twice, leaving one attempt within the three-attempt retry budget.","available_tools":[]}
```

```json
{"decision":"stop","reason":"The budget is exhausted. No clock or shell tool is available to call.","available_tools":[]}
```

Raw local evidence and the generated catalog remain in ignored `.scratch/worker-audit/`: `events.jsonl`, `events-restricted.jsonl`, `events-adversarial.jsonl`, and corresponding stderr logs. They contain test prompts and output, not credentials. They are not needed at runtime.

## Provider behavior and limits

- Parse JSONL incrementally, keep stderr separate, reject malformed output and failed/error turns, and validate the final JSON against the callback schema. Do not trust shape enforcement alone.
- Treat any tool, command, patch, or MCP event as a contract violation; terminate the worker and fail the callback. This is detection, not rollback of an action that already occurred.
- Put a finite deadline and output-size limit around each subprocess. Cancellation must terminate it and settle the waiting callback. Remove temporary files afterward.
- `--ephemeral` disables session-file persistence; it is not a promise that the CLI writes no logs or authentication bookkeeping. `--ignore-user-config` does not claim to eliminate system or managed configuration. Preserve the ordinary CLI authentication boundary.
- `read-only` is defense in depth. It does not mean the model has no tools or cannot read data. The relevant local evidence here is the restricted catalog, disabled features, narrowed instructions, and observed event stream together.
- These two successful probes establish this prototype's behavior on this installed binary. Model self-report is supporting evidence, not a formal tool-registry audit. Revalidate on Codex upgrades. A future direct model API provider with an empty tool list would provide a simpler long-term judgment boundary.
