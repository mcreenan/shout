#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
common_git=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)
cache_root="${JOSH_CACHE_DIR:-$(dirname "$common_git")/.cache/josh-allen}"
revision=abb8a9782fc438d1b87e8aa2fdaea65e5db633c3
mkdir -p "$cache_root"
exec 9>"$cache_root/setup.lock"
flock 9
source_dir="$cache_root/source"
target_dir="$cache_root/target"
if [ ! -d "$source_dir/.git" ]; then
  git clone https://github.com/mcreenan/josh-allen.git "$source_dir" >&2
fi
if ! git -C "$source_dir" cat-file -e "$revision^{commit}" 2>/dev/null; then
  git -C "$source_dir" fetch origin "$revision" >&2
fi
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$revision" ]; then
  git -C "$source_dir" checkout --detach "$revision" >&2
fi
if [ ! -x "$target_dir/debug/josh" ] || [ ! -x "$target_dir/debug/allen" ] || [ "$(cat "$cache_root/built-revision" 2>/dev/null || true)" != "$revision" ]; then
  CARGO_TARGET_DIR="$target_dir" cargo build --locked --manifest-path "$source_dir/Cargo.toml" -p josh -p allen-cli >&2
  printf '%s\n' "$revision" > "$cache_root/built-revision"
fi
printf '%s\n' "$target_dir/debug/josh"
