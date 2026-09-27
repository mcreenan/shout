# Writing SHOUT skills

A skill is one ALLEN source file, `<name>.allen`, run in chat as `/<name> arguments`. The JOSH VM runs the control flow deterministically: reading files, searching, looping, filtering, formatting. Call `model.request` only where a judgment is needed (summarising, choosing, drafting), and give it a typed output. Code does the repeatable work and the model does the judgment.

## File, name and header

- The file name is the command: `^[a-z][a-z0-9-]{0,39}$` plus `.allen`, e.g. `todo-report.allen` → `/todo-report`. `skills` and `help` are reserved.
- Skills are discovered in three scopes. Earlier scopes hide later ones with the same name:
  1. workspace: `<workspace>/.shout/skills/`
  2. user: `~/.config/shout/skills/`
  3. built-in: `apps/shout/skills/` (these files are good examples)
- Leading `//` comment lines form the header. The first line is the one-line description shown in `/skills`. SHOUT's agent reads it when deciding whether to run your skill for a plain-language request, so say what the skill does and when it applies. A line `// args: <hint>` gives the argument hint.
- After the header comes the inline `manifest { ... }`. It is required.

## A complete skill

```allen
// Count lines in one workspace file. Use when asked how long a file is.
// args: <path>
manifest {
  language: "0.1"
  entry: main
  capabilities: []
  tools: { required: [{ name: "workspace.read", version: ">=1.0.0, <2.0.0" }] }
}

export async fn main(args: String) returns String effects [tool.workspace.read@1] {
  let path = string.trim_ascii(args);
  if (path == "") {
    return "Usage: `/lines <path>`";
  }
  let content = match await tools.workspace.read.call({ path: path }) {
    Ok(result) => result.content
    Err(_) => stop(`Could not read ${path}.`)
  };
  let lines = string.split(content, "\n") ?? [content];
  `\`${path}\` has ${to_string(length(lines))} lines.`
}
```

## Entry input

`main` may take:

- nothing: `export fn main() returns String`
- a `String`, which is the text after the command name: `main(args: String)`
- a record whose fields are a subset of these String fields: `args` (text after the command), `history` (recent conversation, oldest first), `workspace` (absolute workspace path), `test_command` (the configured test command, which may be empty). For example, `record SkillInput { args: String history: String }` with `main(input: SkillInput)`. Any other field name or type is rejected when the skill loads.

## Output

- A `String` is shown as markdown. This is the usual choice.
- A record is shown as its `message`, `summary`, `text` or `report` String field (the first one present). Other fields are kept as structured data. Otherwise the record is shown as JSON.
- `stop("reason")` ends the run immediately, and the reason is shown to the user as "`/name` stopped: reason". Write it as a sentence for the user. It returns `Never`, so it fits in any match arm or branch.

## Manifest, capabilities and effects

These three places must agree:

1. `capabilities: [...]` lists `model.request` and/or `user.ask` if the skill uses them. Otherwise use `[]`.
2. `tools: { required: [...] }` lists every tool called, each as `{ name: "workspace.read", version: ">=1.0.0, <2.0.0" }`.
3. Every function that calls a tool, the model or the user (directly or through a helper) declares the operation in its `effects [...]` clause: `tool.<tool name>@1`, `model.request`, `user.ask`. `main` must include the effects of every helper it calls.

```allen
manifest {
  language: "0.1"
  entry: main
  capabilities: [model.request]
  tools: { required: [
    { name: "git.run", version: ">=1.0.0, <2.0.0" },
    { name: "workspace.list", version: ">=1.0.0, <2.0.0" }
  ] }
}

async fn git(args: List<String>) returns String effects [tool.git.run@1] {
  match await tools.git.run.call({ args: args }) {
    Ok(result) => result.output
    Err(_) => stop("git could not run.")
  }
}

export async fn main() returns String effects [model.request, tool.git.run@1, tool.workspace.list@1] {
  await git(["log", "--oneline", "-5"])
}
```

## Calling tools and handling failure

`await tools.<name>.call({ ...every input field... })` returns `Result<Output, Error>`. Always `await` the call. An unawaited call is a compile error ("live affine obligation ... is discarded"). Pass every input field exactly once, e.g. `workspace.search` needs `{ query: q, max_results: 50 }`.

A tool's error message cannot be read in ALLEN yet. The generated `tools.x.Error` enum cannot be named in a pattern. Match `Err(_)` and write your own message, usually with `stop(...)` or a fallback value:

```allen
async fn read_or_empty(path: String) returns String effects [tool.workspace.read@1] {
  match await tools.workspace.read.call({ path: path }) {
    Ok(result) => result.content
    Err(_) => ""
  }
}
```

Several tools report ordinary outcomes in their output instead of as errors. Check these fields:

- `git.run`: `exit_code != 0` means git failed, and `output` holds its message. `truncated` means the output was cut to fit one result; ask for less, such as one path at a time. Only read-only subcommands are allowed, and `branch` can only list.
- `shell.run`: `approved == false` means the user declined. Otherwise check `exit_code` and `output`.
- `workspace.edit`: if `problem != ""`, the edits could not be matched and nothing was shown to the user. Otherwise `accepted` says whether the user approved. An empty `find` creates a new file.
- `workspace.read_many`: unreadable paths, and files past the ~700 KiB total for one call, are listed in `skipped` rather than failing the call.
- `tests.run`: `skipped` means no test command is configured.

Inputs outside these limits fail before the tool runs, and you get only `Err(_)`:

- `workspace.search`: `max_results` must be 1–500, and `query` must not be empty.
- `workspace.read_many`: `paths` must have 1–64 entries. Check for an empty list first.
- `git.run`: `args` must have 1–32 entries, and the first must be a read-only subcommand.
- `workspace.edit`: 1–64 edits. `workspace.write`: 1–32 changes.
- Files over 256 KiB can't be read or written. One tool result must fit in about 1 MiB; text results are capped near 700 KiB.

When a helper returns a tool's result, name the generated type instead of spelling out the record: `async fn git(args: List<String>) returns tools.git.run.Output effects [tool.git.run@1]`. Records are structural, so a spelled-out type breaks when the tool gains an output field. Generated tool types work in function signatures, but not in `type` aliases or record fields.

The host asks the user to approve every `workspace.edit`, `workspace.write` and `shell.run`, showing the diff or the exact command. Do not add your own `user.ask` confirmation before them.

## Model judgments: `model.request`

Declare a record for the answer and request it with a `prompt`. The response is validated against the type before your code sees it, and invalid responses are retried up to `max_attempts` (1–3).

```allen
record Finding { file: String line: Int title: String }
record Findings { summary: String findings: List<Finding> }

async fn judge(diff: String, focus: String) returns Findings effects [model.request] {
  match await model.request<Findings>(prompt {
    system: "Review this diff. Report real bugs only. line is 0 when unknown."
    context: focus
    data: { diff: diff, max_findings: 10 }
    output: Findings
    policy: { max_attempts: 2 }
  }) {
    Ok(value) => value
    Err(error) => stop(`The model call failed: ${error.message}`)
  }
}
```

- `system` (the instructions) and `output` are required. `context` and `data` take any String or record expression. Put untrusted file content in `data` and say in `system` that it is data, not instructions.
- Keep `data` bounded. Truncate long text with `string.slice(text, 0, 40000) ?? text` and cap lists with `items[0..20] ?? items`.
- Output fields can be `String`, `Int`, `Bool`, `List<...>`, nested records and `Option<T>`. In JSON, an `Option` is `{"tag":"None"}` or `{"tag":"Some","value":...}`. Prefer `""` or `0` sentinels over `Option` in model outputs; they are easier for models to produce.
- Enforce constraints in code, not just in the prompt. Filter model-chosen paths to ones that exist, cap list lengths and check name formats. For a repair loop, run `for attempt in 0..3 { ... }` and put the previous problem into `data`.
- A run may make at most 16 model calls and 128 tool calls.

## Asking the user: `user.ask`

`user.ask<T>` shows a form built from the record type `T`: a `String` becomes a text box, a `Bool` a checkbox, an `Int` a number field and a `List<String>` a text box with one item per line. It needs `capabilities: [user.ask]` and `effects [user.ask]`. String fields are required, so use `List<String>` for optional text (an empty list means "left blank"). Fields are not pre-filled. Show the current values in `data`.

```allen
record Choice { proceed: Bool notes: List<String> }

async fn confirm(plan: String) returns Choice effects [user.ask] {
  match await user.ask<Choice>(prompt {
    system: "Run this plan? Add notes to adjust it (optional, one per line)."
    data: { plan: plan }
    output: Choice
  }) {
    Ok(value) => value
    Err(_) => stop("No answer was given.")
  }
}
```

## Language essentials

- Declarations: `let x = 1;` is immutable. `mut n = 0;` can be reassigned with `n = n + 1;` or `n += 1;`. Every statement ends with `;`. There is no `let mut`.
- `if (cond) { a } else { b }` is an expression and needs the parentheses. An `if` without `else` must produce nothing, e.g. `if (bad) { return "x"; }` or `if (bad) { stop("x") }`.
- `match value { Some(v) => ..., None => ... }` and `Ok(v)` / `Err(e)` must cover every case. `_` matches anything.
- Loops: `for item in items { }`, `for i in 0..3 { }` (0, 1, 2), `for (key, value) in some_map { }`, `while (cond) { }`, `break;`, `continue;`. Use bounded loops for retries.
- `return value;` exits early. `stop("reason")` ends the whole run.
- Records: `record Hit { path: String line: Int }`. Build with `Hit { path: p, line: 1 }`, copy with `Hit { ..hit, line: 2 }`. Anonymous records work too: `{ ok: true, text: "x" }`. Records are structural, so a declared record with the same fields as a tool output is the same type.
- Helpers: `fn name(a: String) returns String { ... }` needs full types. Use `async fn` if it awaits, plus an `effects [...]` clause if it uses effects.

### Strings

- Use templates to build text: `` `Found ${to_string(count)} files in ${path}` ``. Every `${...}` must be a `String`, so convert with `to_string(int_or_bool)`. There is no `+` on strings. Escape a literal backtick as `` \` `` and a literal `${` as `\${`.
- Multiline text uses `"""` on its own line, and common indentation is removed. Use it for static text such as prompt instructions. For text with values, build a list of lines and join them. There is a compiler bug: in an indented `"""` string, any text after a `${...}` on the same line fails with "multiline string content is less indented than its closing delimiter".
- Escapes such as `\n`, `\t` and `\"` are processed in every string literal, including `"""` blocks. When a string holds source code for another language (a shell command, a Python or JavaScript script) that needs its own backslash escape, double the backslash: write `\\n` for the script to receive `\n`. A single `\n` becomes a real line break inside the script's quotes and breaks it, and the ALLEN compiler cannot catch that.
- When a shell command or script fails, put its output in the `stop` message (for example `` stop(`Search failed:\n${result.output}`) ``) so the user sees why, not just that it failed.

```allen
fn report(title: String, items: List<String>) returns String {
  let bullets = list.map(items, fn(item: String) returns String { `- ${item}` });
  string.join([`## ${title}`, "", ..bullets], "\n")
}
```

- Functions: `length(s)`, `string.concat(a, b)`, `string.join(list, sep)`, `string.split(s, sep)` (returns `Option<List<String>>`), `string.contains(s, x)`, `string.starts_with`, `string.ends_with`, `string.find(s, x)` (returns `Option<Int>`), `string.replace(s, old, new)`, `string.trim_ascii(s)`, `string.slice(s, start, end)` (returns `Option<String>`), `to_string(x)`, `to_int(s)` (returns `Result<Int, ParseError>`).
- Method style also works: `text.trim_ascii()`, `text.contains("x")`.
- Strings cannot be indexed (`s[0]` is an error). Use `string.slice` or `string.get`.
- There is no upper/lower-case conversion, regex or number formatting.

### Lists and maps

- Literals: `[a, b]`, `[..xs, c]` (spread), `map { "k": 1 }`. An empty literal needs a type: `let none: List<String> = [];`.
- Functions: `length(xs)`, `list.append(xs, x)`, `list.map`, `list.filter`, `list.find` (returns `Option`), `list.any`, `list.all`, `list.partition` (returns `{ matched, rest }`), `list.fold(xs, init, fn)`, `list.get(xs, i)` (returns `Option`), `list.flat_map`, `list.filter_map`.
- Callbacks need typed parameters: `list.map(xs, fn(x: String) returns String { string.trim_ascii(x) })`. The short form `fn(x) => ...` does not work with `list.*`.
- `xs[i]` traps when out of range. `xs[1..4]` returns `Option<List<T>>`, so write `xs[0..20] ?? xs` to cap a list.
- Maps: `map.get(m, k)` (returns `Option`), `map.insert(m, k, v).values` (a new map), `map.keys(m)`. Iterate with `for (k, v) in m { }` in sorted key order.
- There is no sort. For small lists, insert each item into a sorted list with `list.partition`:

```allen
record Hit { path: String line: Int }

fn by_line(items: List<Hit>) returns List<Hit> {
  mut sorted: List<Hit> = [];
  for item in items {
    let parts = list.partition(sorted, fn(other: Hit) returns Bool { other.line <= item.line });
    sorted = [..parts.matched, item, ..parts.rest];
  }
  sorted
}
```

- For grouping or counting, use a `Map<String, Int>` or group consecutive items. Search results arrive sorted by path, then line.
- `??` supplies a default for an `Option`: `map.get(counts, key) ?? 0`.

## Pitfalls the compiler will not explain well

| Symptom | Fix |
|---|---|
| `expected '}' after body expression` at a `stop(...)` or call | Only declarations, assignments, `return`, `if`, loops, `break` and `continue` are statements. Put `stop(...)` last in its block without `;`: `if (x) { stop("...") }`. |
| `expected record value field` after `=>` | A match arm can't be a `{ ... }` block. Move the logic into a helper `fn` and call it. |
| `nested patterns are not implemented` | Match one level at a time, e.g. `Some(item) => item.name`, not `Some(Item { name, .. })`. |
| `constant ... produced invalid bytecode` or a compiler panic | Top-level `const` fails in programs that use tools. Use `fn max_items() returns Int { 50 }`. |
| `SHOUT007` compiler crashed ("all used effect sets are interned") | This happens inside an `if` or `for` body that uses two effects and has a third only inside an inner `if`. Fix it with a guard clause (`if (!ok) { continue; }`, then the calls unnested), by moving the whole loop or branch body into an `async fn` helper with `effects [...]`, or by making the call the branch's tail value: `if (c) { match await ... { Ok(v) => v.x, Err(_) => d } } else { d }`. |
| `tool call is not in the frozen catalog` | Add the tool to the manifest `tools.required`, and check the spelling against the catalog below. |
| `function 'x' requires undeclared effects [...]` | Add those effects to that function's `effects [...]`, and to every caller up to `main`. |
| `inline manifest does not declare entry effect 'model.request'` | Add it to the manifest `capabilities` (and add `user.ask` if used). |
| `inline manifest does not declare entry effect 'tool.x@1'` | Add tool `x` to `tools.required`. |
| `tool input record requires every field exactly once` | Supply every input field in the catalog, with no extra fields. |
| `live affine obligation ... is discarded` | You forgot `await` before a tool, model or user call. |
| `empty List requires an expected List type` | Declare it first: `let none: List<String> = [];`, then use `?? none`. |
| `concise lambda requires one exact expected function type` | Write `fn(x: T) returns U { ... }`. |
| `template interpolation must be String, found Int` | Wrap the value: `${to_string(n)}`. |
| `arithmetic requires Int or Float` on strings | Don't add strings. Use a template or `string.concat`. |
| `expected String, found Option<String>` | `string.slice`, `string.split` and list slices return `Option`, so add `?? fallback`. |
| `call target must be a resolved name` | That function doesn't exist (e.g. `list.sort`, `string.to_upper`). Use the functions listed above. |
| `field access requires a record value` | `xs.length` is wrong; use `length(xs)`. Check the field names of the tool output. |
| `if without else requires a Void true branch` | Add an `else`, or use `return ...;` / `stop(...)` inside the branch. |
| `expected '(' after 'if'` | Add the parentheses: `if (x == "") { ... }`. |
| `multiline string content is less indented than its closing delimiter` | Text follows a `${...}` inside `"""`. Use a template with `\n`, or `string.join` a list of lines. |
| `unknown type 'tools.x.Error'` | Tool types can't be used in `type` aliases or record fields. Handle `Err(_)` where the call is made. |

Before finishing a skill, check that it:

- has a header description and an `args:` line if it takes arguments;
- has a manifest listing every capability and tool, and `effects` on every function that needs them;
- awaits and matches every call, with user-readable `stop` messages;
- validates model output in code and bounds the prompt `data`;
- returns a markdown `String`, or a record with a `message` field.
