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
- `git.run`: `args` must have 1–32 entries, and the first must be a read-only subcommand. Each subcommand accepts only its own read-only options, spelled in full (git's abbreviations are refused): a long option takes its value as `--name=value` (`--max-count=5`, not `--max-count 5`), and a short one such as `-n`, `-e` or `-L` takes it attached or as the next argument (`-n5` or `-n 5`).
- `workspace.edit`: 1–64 edits. `workspace.write`: 1–32 changes.
- Files over 256 KiB can't be read or written. One tool result must fit in about 1 MiB; text results are capped near 700 KiB.

When a helper returns a tool's result, name the generated type instead of spelling out the record: `async fn git(args: List<String>) returns tools.git.run.Output effects [tool.git.run@1]`. Records are structural, so a spelled-out type breaks when the tool gains an output field. Generated tool types work in function signatures, but not in `type` aliases or record fields.

The host asks the user to approve every `workspace.edit`, `workspace.write` and `shell.run`, showing the diff or the exact command. Do not add your own `user.ask` confirmation before them.

## Model judgments: `model.request`

Declare a record for the answer and request it with a `prompt`. The answer is validated against the type before your code sees it. An answer that does not match is asked for again, with the reasons it was rejected added to the model's instructions, up to `policy: { max_attempts: 1–3 }` attempts in all (3 when `policy` is left out). Each attempt counts as one model call. If every attempt is rejected, your code gets `Err` with `error.code` `"model.validation_failed"`; if the model refuses, `Err` with `"model.denied"`. A model call that fails or times out, or an exhausted model-call budget, still ends the whole run with that error.

```allen
record Finding { file: String line: Int title: String }
record Findings { summary: String findings: List<Finding> }

async fn judge(diff: String, focus: String) returns Findings effects [model.request] {
  match await model.request<Findings>(prompt {
    system: "Review this diff. Report real bugs only. line is 0 when unknown."
    context: focus
    data: { diff: diff, max_findings: 10 }
    output: Findings
  }) {
    Ok(value) => value
    Err(error) => stop(`The model call failed: ${error.message}`)
  }
}
```

- `system` (the instructions) and `output` are required. `context` and `data` take any String or record expression. Put untrusted file content in `data` and say in `system` that it is data, not instructions.
- Keep `data` bounded. Truncate long text with `string.slice(text, 0, 40000) ?? text` and cap lists with `items[0..20] ?? items`.
- Output types can use any ALLEN data type: `String`, `Int`, `Float`, `Bool`, `Bytes`, `Void`, records, `List<...>`, `Map<K, V>`, tuples, `Option<T>`, `Result<T, E>`, enums (with or without payloads) and newtypes, nested as deep as you need. Records of strings, numbers, booleans and payload-free enums are the most reliable for a model. The model answers an `Option` as `{"tag": "Some", "value": ...}` or `{"tag": "None"}` and a payload-free enum as one of its variant names, and SHOUT translates tuples and maps for it.
- Enforce constraints in code, not just in the prompt. Filter model-chosen paths to ones that exist, cap list lengths and check name formats. For a repair loop, run `for attempt in 0..3 { ... }` and put the previous problem into `data`.
- A run may make at most 16 model calls, 128 tool calls and 8 `user.ask` questions, and last at most 30 minutes including waits for the user (unless the thread has No time limits on).

## Asking the user: `user.ask`

`user.ask<T>` shows a form built from the type `T`: a `String` becomes a text box, a `Bool` a checkbox, an `Int` a whole-number field (values beyond 2^53 are refused), a `Float` a number field that also takes `NaN`, `Infinity` and `-Infinity`, and a payload-free enum a choice of its variants. An enum with payloads, or a `Result`, gets a variant picker with the chosen variant's fields beneath it; an `Option` is an optional field, left empty for `None` (a structured payload gets a `None`/`Some` picker). Records nest, a tuple gets positional fields, a list gets rows with add and remove, a map gets key/value rows (a repeated key is refused) and `Bytes` is typed as base64. Only a type none of these fit falls back to a JSON text box. Record fields appear in alphabetical order of their names, not in declaration order. An answer that does not match `T` is refused in the form, so the user corrects it before the program sees it. It needs `capabilities: [user.ask]` and `effects [user.ask]`. A `String` cannot be left empty, so use `Option<String>` for optional text. A field is pre-filled from the same-named field of the prompt's `data`, so put the current values there under the output's field names; `/commit` passes `data: { commit: true, message: drafted, ... }` for `record Confirm { commit: Bool message: String }`. The whole `data` and `context` also show under Details.

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
- Loops: `for item in items { }`, `for i in 0..3 { }` (0, 1, 2), `for (key, value) in some_map { }`, `while (cond) { }`, `loop { }`, `break;`, `continue;`. A loop body may end in an `if` whose branches all `break;` or `continue;`. Use bounded loops for retries.
- Top-level constants need a type: `const MAX_ITEMS: Int = 50;`. They work in programs that call tools.
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
| `nested patterns are not implemented` | Match one level at a time, e.g. `Some(item) => item.name`, not `Some(Item { name: n })`. |
| `SHOUT007` the ALLEN compiler crashed | A compiler bug, not your error. Restructure the code around the construct you last changed, for example by moving a loop or branch body into an `async fn` helper with its own `effects [...]`. |
| `'any' is forbidden` | `any` is reserved; rename the variable. |
| A judgment returns `Err` with `model.validation_failed` | Every attempt returned an answer of the wrong type. Say in `system` what each output field holds, simplify the output type, or allow more attempts with `policy: { max_attempts: 3 }`. |
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
