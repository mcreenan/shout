# SHOUT's JOSH/ALLEN patches

SHOUT runs the JOSH/ALLEN revision pinned in `tools/setup-josh.sh` (`abb8a97`) with these patches applied in name order. `tools/setup-josh.sh` resets the cached checkout in `.cache/josh-allen/source` to the pinned revision, applies every `*.patch` here with `git apply --index`, and rebuilds `josh`, `allen` and `shout-allen-check` whenever the revision or any patch changes (the build stamp includes a hash of the patch files). Cargo runs inside the checkout, so rustup uses the toolchain its `rust-toolchain.toml` pins, and the `josh`/`allen` stamp also records `rustc --version`, so a different compiler triggers a rebuild. The cached checkout is disposable; never edit it by hand.

The current protocol is `josh/1.8` and the bytecode version is 20. The patches are meant to be upstreamed to `github.com/mcreenan/josh-allen`; once they are, bump the pin and delete them.

## Patches

- `0001-if-branch-statement-effects.patch`: fixes the compiler panic `all used effect sets are interned`. `compile_if` and `compile_await_block` computed their effects from the branch tail values instead of the branch blocks, so effects that appear only in branch statements were dropped from the enclosing block's union. Includes a regression test.
- `0002-effect-origin.patch`: effect origins. Protocol `josh/1.7` (feature `effect-origin`), bytecode version 20. Every runtime-to-host provider request (`tool/invoke`, `model/request`, `user/ask`, `agent/*`, `sub_agent/*`, `permission/request`) carries an optional `origin` saying where the effect started: the task, the source site (byte span plus 1-based line/column), and an outermost-first `scope` of enclosing loops (with `instance` and 1-based `iteration`), `if` branches, `match` arms, `await` blocks, call frames and spawns. `program/load` returns the static construct and effect-site tables under `debug`. Contents, in commit order:
  - span-marks effect, await, spawn and call instructions, so their debug locations are their own expressions instead of the function body;
  - adds a control-flow construct table (kind, parent, span, instruction range, source-span regions, loop repeat edges) to the artifact debug section, with canonical validation;
  - documents a validated-input panic and removes an `expect` so `cargo clippy -D warnings` passes on the pinned toolchain;
  - records source `for`/`while`/`loop`/`if`/`match`/`await {}` constructs during lowering, skipping conditionals generated for `&&`, `||`, `??` and decision-lowered patterns, and rolling back discarded code;
  - tracks per-frame loop activations in the VM from that table and reports each effect's origin to a `CheckpointObserver::effect_started` hook (opt-in, no new instructions);
  - joins the origin with the debug tables in `josh-host`, adds the payload types and the `program/load` tables to `josh-protocol`, and updates `docs/implementation-spec.md` and `docs/agents/reference/josh-protocol.md` (including the stale framing text).
- `0003-runtime-error-spans.patch`: JOSH runtime failures carry the failing instruction's source span (`source`, `start`, `end`, and line/column for source loads) in `error.span` instead of `null`, and every otherwise unmarked instruction gets the span of the innermost expression that emitted it, so a trap such as division by zero names its expression.
- `0004-loop-control-branch-joins.patch`: a loop body ending in an `if` or `match` whose every branch leaves through `break` or `continue` no longer fails with "invalid generated MIR: MIR contains an unreachable block".
- `0005-constants-with-catalog-tools.patch`: a top-level `const` now compiles in a program that calls catalog tools (constant evaluation verified the whole module without the tool catalog, failing with "tool invocation requires a frozen tool catalog"). `apps/shout/skills/code.allen` uses a `const` again.
- `0006-idle-provider-wait.patch`: `josh serve` used a full CPU core for as long as any provider request (tool, model, user) was pending, because the VM scheduler re-polled pending effects in a tight loop. This was the "100% CPU" previously blamed on oversized frames. The VM now waits for provider progress (50 microseconds growing to 10 milliseconds) and josh-host wakes it as soon as a response arrives. An oversized or malformed frame closes the connection, as before, now with a specific stderr diagnostic such as `josh: protocol frame exceeds the negotiated max_frame_bytes; closing the connection`. SHOUT's kernel keeps its own size guard.
- `0007-flush-frames-on-close.patch`: when the host closed JOSH's stdin, `josh serve` could exit before writing its queued final responses (about one run in ten under load). A closing connection now waits up to five seconds for queued frames to be written.
- `0008-compile-diagnostics-program-check.patch`: protocol `josh/1.8` (features `compile-diagnostics` and `program-check`). A source program that does not compile fails `program/load` with `program.invalid` and `data.diagnostics` (code, severity, message, bundle path, byte span, 1-based line/column range, labels, notes, help). The new `program/check` request compiles and verifies without loading, returning diagnostics or the digest, entries, required tools and debug tables. Entries carry input/output schema descriptors and declared effects. `josh_host::compile_source_bundle` is the one compile path for load, check and SHOUT's `shout-allen-check`, so all three report identical diagnostics. The compiler's line rule (LF, CRLF and a lone CR each end a line) is now shared by rendered errors, origins and diagnostics.
- `0009-execution-wide-operation-ids.patch`: `operation_id` (`op-<n>`) is unique within an execution across tools, model, user, agent, sub-agent and permission requests (each family used to count from 1). Replay journals never record operation IDs, so they are unchanged.

Known unfixed: `execution/event` emits `effect_started/completed/failed` for tool calls only; model, user, agent and sub-agent requests produce no effect events (SHOUT observes them as provider requests).

## Changing or regenerating the patches

Develop in a separate clone, never in `.cache/josh-allen/source`:

```sh
git clone .cache/josh-allen/source .worktrees/josh-allen      # .worktrees/ is git-ignored
cd .worktrees/josh-allen
git checkout -b shout/effect-origin abb8a9782fc438d1b87e8aa2fdaea65e5db633c3
git remote set-url origin https://github.com/mcreenan/josh-allen.git
for patch in ../../tools/josh-patches/*.patch; do git apply --index "$patch"; done && git commit -m "SHOUT patches"   # or keep the original branch
export CARGO_TARGET_DIR="$PWD/../josh-allen-target"            # never share .cache/josh-allen/target
```

The original branch `shout/effect-origin` in `.worktrees/josh-allen` has one commit per logical change. Each patch is the diff between two boundary commits:

| Patch | From | To |
|---|---|---|
| 0001 | `abb8a97` | `ec8a29c` |
| 0002 | `ec8a29c` | `1050d51` (commits `96e3a3e`..`1050d51`) |
| 0003 | `1050d51` | `afb57a9` |
| 0004 | `afb57a9` | `cc34a2e` |
| 0005 | `cc34a2e` | `0f36431` |
| 0006 | `0f36431` | `3259a78` |
| 0007 | `3259a78` | `6a698fd` |
| 0008 | `6a698fd` | `f581f77` |
| 0009 | `f581f77` | `16b1999` |

Regenerate a patch with fixed prefixes so a local `diff.mnemonicPrefix` setting cannot change the output (text before the first `diff --git` line is a free-form header that `git apply` ignores), for example:

```sh
cd .worktrees/josh-allen
git -c diff.mnemonicPrefix=false diff --binary --src-prefix=a/ --dst-prefix=b/ ec8a29c 1050d51 > ../../tools/josh-patches/0002-effect-origin.patch
git -c diff.mnemonicPrefix=false diff --binary --src-prefix=a/ --dst-prefix=b/ f581f77 16b1999 > ../../tools/josh-patches/0009-execution-wide-operation-ids.patch
```

After adding commits, pass the new boundary commits (`git log --oneline abb8a97..`), or add a new numbered patch for an independent change. Before changing the patches, run the JOSH/ALLEN checks in the clone:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets --all-features
cargo test --workspace --doc
git diff --check
```

Check that the patch set reproduces the branch exactly on a fresh pinned checkout (`git apply --index` each patch in order, then compare `git diff --cached HEAD` with `git diff abb8a97 <tip>`). To try a build in SHOUT before switching the shared cache, point SHOUT at it: `JOSH_BIN=$CARGO_TARGET_DIR/debug/josh SHOUT_ALLEN_CHECK=<checker built against the clone>`.

A protocol change (such as 0002's `josh/1.7` or 0008's `josh/1.8`) requires the matching literal in `prototypes/owned/src/kernel.mjs` and `prototypes/native/src/josh.mjs`, because JOSH accepts exactly one protocol version. Change them together with the patch, then run `bash tools/setup-josh.sh` at once so the shared binaries match.
