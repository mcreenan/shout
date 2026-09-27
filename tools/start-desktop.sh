#!/usr/bin/env bash
# Launches the SHOUT desktop app. It reuses a SHOUT server already running on PORT (default 4310)
# or starts one through tools/start-gui.sh, so server preparation lives in one place.
set -euo pipefail
repo_root=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
desktop="$repo_root/apps/desktop"
fail() {
  printf 'SHOUT: %s\n' "$1" >&2
  # Launched from the app menu there is no terminal, so say it on the desktop too.
  if [ ! -t 2 ] && command -v notify-send >/dev/null; then notify-send -a SHOUT -i dialog-error 'SHOUT could not start' "$1" || true; fi
  exit 1
}
command -v node >/dev/null || fail 'Node.js is not on PATH. Install Node 26 (for example: mise use -g node@26).'
if [ ! -d "$desktop/node_modules/electron" ]; then
  npm --prefix "$desktop" ci --no-audit --no-fund >&2 || fail "Installing the desktop app's dependencies failed (npm --prefix apps/desktop ci)."
fi
# Electron 44 downloads its binary on first use rather than at install time.
node "$desktop/node_modules/electron/install.js" >&2 || fail 'Downloading the Electron binary failed.'
electron="$desktop/node_modules/electron/dist/$(cat "$desktop/node_modules/electron/path.txt")"
# Electron 44 (Chromium 152) already runs as a native Wayland client with fractional scaling and
# text-input-v3 IME (checked with WAYLAND_DEBUG on Hyprland), so no platform flags are needed.
# SHOUT_ELECTRON_FLAGS adds extra Chromium switches (for example --disable-gpu); "$@" is passed through.
read -r -a extra <<< "${SHOUT_ELECTRON_FLAGS:-}"
cd "$repo_root"
exec "$electron" "$desktop" "${extra[@]}" "$@"
