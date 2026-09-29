#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
if [ ! -d "$repo_root/prototypes/owned/node_modules/ajv" ]; then
  npm --prefix "$repo_root/prototypes/owned" ci --no-audit --no-fund
fi
# The Claude Agent SDK (and the Claude Code build it pins) for Claude models.
if [ ! -d "$repo_root/node_modules/@anthropic-ai/claude-agent-sdk" ]; then
  npm --prefix "$repo_root" ci --no-audit --no-fund
fi
export JOSH_BIN="${JOSH_BIN:-$("$repo_root/tools/setup-josh.sh")}"
watch=()
# SHOUT_WATCH=1 restarts the server when its source or imported modules change.
if [ "${SHOUT_WATCH:-}" = 1 ]; then watch=(--watch --watch-preserve-output); fi
# The ${x+...} forms keep macOS's bash 3.2 from treating an empty array or argument list as unset under set -u.
exec node ${watch[@]+"${watch[@]}"} --env-file-if-exists="$repo_root/.env" "$repo_root/apps/shout/src/server.mjs" ${1+"$@"}
