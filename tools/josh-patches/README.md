# Proposed JOSH/ALLEN fixes

Patches for the pinned josh-allen revision in `tools/setup-josh.sh`. They are not applied automatically; upstream them and bump the pin.

- `0001-if-branch-statement-effects.patch`: fixes the compiler panic `all used effect sets are interned`. `compile_if` and `compile_await_block` computed their effects from the branch tail values instead of the branch blocks, so effects that appear only in branch statements were dropped from the enclosing block's union. Includes a regression test; `cargo test -p allen-compiler` passes with it.

Known unfixed: a top-level `const` in a program that calls catalog tools fails with "tool invocation requires a frozen tool catalog", because `evaluate_constants` verifies the whole module without the catalog. Skills use a pure `fn` instead.

Known unfixed: when a host sends a response frame larger than the negotiated `max_frame_bytes`, `josh serve` spins at 100% CPU instead of rejecting the frame or closing the connection. SHOUT's kernel now refuses oversized tool results before sending them.
