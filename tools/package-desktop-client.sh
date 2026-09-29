#!/usr/bin/env bash
# Writes .cache/desktop-client/shout-desktop-client.tgz: the desktop app on its own, for a computer that connects to a
# SHOUT server running elsewhere (for example a MacBook reaching this machine over Tailscale or the LAN).
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/.." && pwd)
out="$repo_root/.cache/desktop-client"
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
bundle="$stage/shout-desktop-client"
mkdir -p "$bundle" "$out"
# node_modules is rebuilt by npm on the target; make-icons.sh needs the full checkout; the tests stay in the repo.
(cd "$repo_root/apps/desktop" && tar --exclude=./node_modules --exclude=./assets/make-icons.sh --exclude=./test -cf - .) | (cd "$bundle" && tar -xf -)
cat > "$bundle/README.md" <<'EOF'
# SHOUT desktop client

The SHOUT desktop app without a server of its own: it opens the SHOUT server running on another computer.

## Requirements

- Node.js 22.12 or newer and npm (Electron 44's installer needs Node 22.12+). macOS or Linux.
- A SHOUT server you can reach, started with `npm start` on its computer. It listens on port 4310 on all
  interfaces and accepts that computer's LAN and Tailscale addresses and names.

## Run

    npm install
    npm start -- --server http://HOST:4310

HOST is the server computer's Tailscale name or IP (for example `my-computer` or `100.x.y.z`) or its LAN IP.
The first `npm start` downloads Electron (about 100 MB).

Without `--server` the app asks for the address and remembers it. Change it later from the application menu
(titled "Electron" on macOS in this unpackaged build) or File › Change server… on Linux.
`SHOUT_SERVER_URL=http://HOST:4310 npm start` works too; `--server` wins over it, and both win over the saved address.

Project paths belong to the server's computer, so pick projects with SHOUT's own folder browser rather than a
local folder dialog.

If the app reports that SHOUT refused the host name, connect with an address the server accepts (its Tailscale or
LAN IP always works) or add the name to `SHOUT_ALLOWED_HOSTS` in the server's `.env`.
EOF
tar -czf "$out/shout-desktop-client.tgz" -C "$stage" shout-desktop-client
echo "$out/shout-desktop-client.tgz"
