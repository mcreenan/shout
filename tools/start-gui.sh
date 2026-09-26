#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
if [ ! -d "$repo_root/prototypes/owned/node_modules/ajv" ]; then
  npm --prefix "$repo_root/prototypes/owned" ci --no-audit --no-fund
fi
export JOSH_BIN="${JOSH_BIN:-$("$repo_root/tools/setup-josh.sh")}"
exec node "$repo_root/apps/shout/src/server.mjs" "$@"
