#!/usr/bin/env bash
# Adds (install) or removes (uninstall) the SHOUT launcher entry and icons for the current user.
set -euo pipefail
repo_root=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
entry="$data_home/applications/shout.desktop"
icons="$data_home/icons/hicolor"
sizes=(32 48 64 128 256 512)
launcher="$repo_root/tools/start-desktop.sh"
refresh() {
  if command -v update-desktop-database >/dev/null; then update-desktop-database -q "$data_home/applications" 2>/dev/null || true; fi
  if command -v gtk-update-icon-cache >/dev/null && [ -f "$icons/index.theme" ]; then gtk-update-icon-cache -q -t -f "$icons" 2>/dev/null || true; fi
}
case "${1:-install}" in
  install)
    # Exec= quoting rules make these characters unsafe in a path; spaces are quoted below.
    case "$launcher" in *[\"\`\$\\%]*) echo "Cannot write a desktop entry for a path containing \" \` \$ \\ or %: $launcher" >&2; exit 1;; esac
    exec_path=$launcher; case "$launcher" in *[[:space:]]*) exec_path="\"$launcher\"";; esac
    for size in "${sizes[@]}"; do install -Dm644 "$repo_root/apps/desktop/assets/icons/$size.png" "$icons/${size}x${size}/apps/shout.png"; done
    mkdir -p "$(dirname "$entry")"
    cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=SHOUT
GenericName=Coding Agent
Comment=Local coding-agent workspace
Exec=$exec_path
TryExec=$launcher
Icon=shout
Terminal=false
Categories=Development;
Keywords=agent;coding;AI;ALLEN;
StartupNotify=true
StartupWMClass=shout
EOF
    if command -v desktop-file-validate >/dev/null; then desktop-file-validate "$entry"; fi
    refresh
    echo "Installed $entry (launches $launcher)"
    ;;
  uninstall)
    rm -f "$entry"
    for size in "${sizes[@]}"; do rm -f "$icons/${size}x${size}/apps/shout.png"; done
    refresh
    echo "Removed $entry and the SHOUT icons"
    ;;
  *) echo "usage: $0 install|uninstall" >&2; exit 2 ;;
esac
