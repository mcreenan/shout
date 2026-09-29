#!/usr/bin/env bash
# Build the pinned JOSH/ALLEN revision plus SHOUT's patches (tools/josh-patches/*.patch, applied in
# name order) and SHOUT's skill checker. Prints the josh binary path on stdout and nothing else.
set -euo pipefail

repo_root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
common_git=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
cache_root="${JOSH_CACHE_DIR:-$(dirname "$common_git")/.cache/josh-allen}"
revision=abb8a9782fc438d1b87e8aa2fdaea65e5db633c3
patch_dir="$repo_root/tools/josh-patches"
mkdir -p "$cache_root"
# One setup at a time per cache. flock(1) is not on stock macOS; there a lock directory stands in
# (mkdir is atomic). Its owner writes its pid, and a lock whose owner no longer runs is stale.
# JOSH_SETUP_LOCK=mkdir selects the directory lock where flock exists (for testing it).
if [ "${JOSH_SETUP_LOCK:-}" != mkdir ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$cache_root/setup.lock"
  flock 9
else
  lock_dir="$cache_root/setup.lock.d"
  waited=0
  until mkdir "$lock_dir" 2>/dev/null; do
    owner=$(cat "$lock_dir/pid" 2>/dev/null || true)
    # No pid a minute after mkdir also means its owner died before writing one.
    if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } ||
      { [ -z "$owner" ] && [ -n "$(find "$lock_dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; }; then
      # Moving it aside is atomic, so only one waiter removes a given stale lock.
      mv "$lock_dir" "$lock_dir.stale.$$" 2>/dev/null && rm -rf "$lock_dir.stale.$$"
      continue
    fi
    if [ $((waited % 30)) -eq 0 ]; then
      printf 'Waiting for the JOSH setup lock %s (held by pid %s)\n' "$lock_dir" "${owner:-unknown}" >&2
    fi
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s\n' "$$" > "$lock_dir/pid"
  trap 'rm -rf "$lock_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi
# sha256sum is GNU coreutils; macOS has shasum. Both print "<hash>  -" for standard input.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}
source_dir="$cache_root/source"
target_dir="$cache_root/target"
if [ ! -d "$source_dir/.git" ]; then
  git clone https://github.com/mcreenan/josh-allen.git "$source_dir" >&2
fi
if ! git -C "$source_dir" cat-file -e "$revision^{commit}" 2>/dev/null; then
  git -C "$source_dir" fetch origin "$revision" >&2
fi

# The cached source is disposable: it must be exactly the pinned revision plus every patch.
shopt -s nullglob
patches=("$patch_dir"/*.patch)
shopt -u nullglob
patch_hash=$(for patch in "${patches[@]}"; do basename "$patch"; sha256 < "$patch"; done | sha256 | cut -d' ' -f1)
build_stamp="$revision $patch_hash"
# Fingerprint of the checkout: HEAD, every change against it (patches are applied to the index, so
# new files are included) and any untracked file. Reading it never touches the working files, so
# an unchanged tree keeps cargo's fingerprints and needs no rebuild.
tree_state() {
  {
    git -C "$source_dir" rev-parse HEAD
    git -C "$source_dir" diff --binary --src-prefix=a/ --dst-prefix=b/ HEAD
    git -C "$source_dir" ls-files --others --exclude-standard
  } | sha256 | cut -d' ' -f1
}
if [ "$(cat "$cache_root/applied-stamp" 2>/dev/null || true)" != "$build_stamp $(tree_state)" ]; then
  git -C "$source_dir" checkout --quiet --force --detach "$revision" >&2
  git -C "$source_dir" reset --quiet --hard "$revision" >&2
  git -C "$source_dir" clean -fdxq -e target >&2
  for patch in "${patches[@]}"; do
    git -C "$source_dir" apply --index --whitespace=nowarn "$patch" >&2
  done
  printf '%s %s\n' "$build_stamp" "$(tree_state)" > "$cache_root/applied-stamp"
fi
# rustup chooses the toolchain from the working directory's rust-toolchain.toml, not from
# --manifest-path, so cargo runs inside the checkout to use its pinned toolchain. The toolchain is
# part of the stamp: binaries from another compiler are rebuilt.
toolchain=$(cd "$source_dir" && rustc --version)
if [ ! -x "$target_dir/debug/josh" ] || [ ! -x "$target_dir/debug/allen" ] || [ "$(cat "$cache_root/built-revision" 2>/dev/null || true)" != "$build_stamp $toolchain" ]; then
  (cd "$source_dir" && CARGO_TARGET_DIR="$target_dir" cargo build --locked -p josh -p allen-cli >&2)
  printf '%s\n' "$build_stamp $toolchain" > "$cache_root/built-revision"
fi
# SHOUT's catalog-aware skill checker links the same patched compiler and host crates.
checker_src="$repo_root/tools/allen-check"
checker_dir="$cache_root/shout-allen-check"
checker_stamp="$build_stamp $(cat "$checker_src/Cargo.toml.in" "$checker_src/src/main.rs" | sha256 | cut -d' ' -f1)"
if [ ! -x "$target_dir/debug/shout-allen-check" ] || [ "$(cat "$checker_dir/built-stamp" 2>/dev/null || true)" != "$checker_stamp" ]; then
  mkdir -p "$checker_dir"
  sed -e "s|@ALLEN_SRC@|$source_dir|g" -e "s|@SHOUT_SRC@|$checker_src/src|g" "$checker_src/Cargo.toml.in" > "$checker_dir/Cargo.toml"
  cp "$source_dir/rust-toolchain.toml" "$checker_dir/rust-toolchain.toml"
  # The source lock pins every crate the checker links, so resolution needs no registry update.
  cp "$source_dir/Cargo.lock" "$checker_dir/Cargo.lock"
  (cd "$checker_dir" && CARGO_TARGET_DIR="$target_dir" cargo build --manifest-path "$checker_dir/Cargo.toml" >&2)
  printf '%s\n' "$checker_stamp" > "$checker_dir/built-stamp"
fi
printf '%s\n' "$target_dir/debug/josh"
