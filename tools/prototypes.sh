#!/usr/bin/env bash
set -euo pipefail
root_dir=$(cd "$(dirname "$0")/.." && pwd)

track_dir() {
  local track="$1"
  if [ -f "$root_dir/prototypes/$track/package.json" ]; then
    printf '%s\n' "$root_dir/prototypes/$track"
  elif [ -f "$root_dir/.worktrees/$track/prototypes/$track/package.json" ]; then
    printf '%s\n' "$root_dir/.worktrees/$track/prototypes/$track"
  else
    printf 'Prototype is not available: %s\n' "$track" >&2
    return 1
  fi
}

command_name="${1:-help}"
shift || true
case "$command_name" in
  setup)
    export JOSH_BIN="$("$root_dir/tools/setup-josh.sh")"
    for track in native owned; do
      project_dir=$(track_dir "$track")
      npm --prefix "$project_dir" ci --no-audit --no-fund
    done
    ;;
  test|typecheck)
    export JOSH_BIN="${JOSH_BIN:-$("$root_dir/tools/setup-josh.sh")}"
    for track in native owned; do
      project_dir=$(track_dir "$track")
      npm --prefix "$project_dir" run "$command_name" -- "$@"
    done
    ;;
  native|owned)
    project_dir=$(track_dir "$command_name")
    action="${1:-start}"
    shift || true
    export JOSH_BIN="${JOSH_BIN:-$("$root_dir/tools/setup-josh.sh")}"
    cd "$project_dir"
    exec npm run "$action" -- "$@"
    ;;
  *)
    printf 'Usage: tools/prototypes.sh setup|test|typecheck|native|owned [script] [arguments...]\n'
    ;;
esac
