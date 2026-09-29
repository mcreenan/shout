# SHOUT desktop app

An Electron 44.4.5 window around a SHOUT server. It loads the same web UI a browser gets from the server, and adds what a browser can't do well: a native folder chooser, application and context menus, notifications for threads that need you, a badge, window attention, and a server it can start and stop itself. It can also be a window onto a SHOUT server on another computer.

The UI, projects, threads and agents are documented in the [app README](../shout/README.md). This file covers the shell.

## Commands

From the repository root:

```sh
npm run desktop                    # launch (tools/start-desktop.sh)
npm run desktop -- --server URL    # launch as a window onto another computer's SHOUT server
npm run desktop:install            # add a SHOUT launcher entry and icons for your user
npm run desktop:uninstall          # remove them
npm run desktop:package            # write the standalone client bundle (see below)
npm run test:desktop               # drive the real shell with Playwright (tools/desktop-smoke.mjs)
```

On first launch `tools/start-desktop.sh` installs `apps/desktop`'s dependencies and downloads the Electron binary (Electron 44 fetches it on first use). It needs `node` on PATH (22.12+). Extra arguments pass through to Electron. `SHOUT_ELECTRON_FLAGS` adds Chromium switches, for example `SHOUT_ELECTRON_FLAGS=--disable-gpu`.

`desktop:install` writes `$XDG_DATA_HOME/applications/shout.desktop` (default `~/.local/share/applications`) and the icons at 32–512 px into the user's `hicolor` theme. The entry runs `tools/start-desktop.sh` from this checkout, so it breaks if the checkout moves. Launched from the menu there is no terminal, so the launcher reports startup failures with `notify-send`.

## Which server it uses

At start the app picks a target in this order: `--server <url>` (or `--server=<url>`), `SHOUT_SERVER_URL`, the address saved from an earlier connection, and otherwise this checkout's own server.

| Mode | When | What happens to the server |
|---|---|---|
| Attached | A SHOUT server already answers on `http://127.0.0.1:<PORT>` (default 4310), for example `npm start` in a terminal or a user service | The app uses it and never stops it. |
| Own | Nothing answers there | The app starts `tools/start-gui.sh` (which prepares dependencies and JOSH), shows its output on the start screen and logs it. If port 4310 is taken by something that isn't SHOUT, it uses a free port. |
| Remote | A server address was given or saved | The app is only a window onto that server. It never starts a local server. |
| Setup | The standalone client bundle, with no address yet | The app asks for an address. |

An owned server:

- binds as configured (`0.0.0.0` by default), so browsers on your LAN and Tailscale keep working while the window uses `127.0.0.1`. It reads `PORT`, `SHOUT_HOST`, `SHOUT_STATE_DIR` and `SHOUT_ALLOWED_HOSTS` from the environment or the repository `.env`, as `npm start` does;
- runs in its own process group with an IPC channel; it reports its URLs over that channel and exits by itself if the app disappears;
- is restarted on the same port if it crashes, with backoff from 0.5 s doubling to 10 s, and the window reloads;
- is stopped when the app quits: SIGTERM, up to 5 seconds for SHOUT to close its threads, then SIGKILL. The process group is then cleared on its own (SIGTERM, up to 2 seconds, SIGKILL), so setup steps and agent CLIs that outlive the server, or ignore SIGTERM, do not stay behind;
- is tracked per launch while it starts: switching servers or quitting during start-up stops it, and a launch overtaken by a newer one stops only itself.

An attached or remote server is checked every 5 seconds while the UI is shown. Two missed checks bring up the connection screen, which retries with backoff (0.5 s doubling to 10 s) and reconnects on its own. If an attached local server stays away for about four attempts, the app starts its own. Quitting never stops an attached or remote server.

The connection screen (`src/loading.html`) shows progress, the address, the reason in plain words ("Nothing is accepting connections at this address. Is SHOUT running there?", "SHOUT refused this host name…") and the actions that apply: **Retry now**, **Change server…**, **Use this computer's SHOUT**, **Show log** and **Cancel**. Addresses are normalised: `host` becomes `http://host:4310` and `host:port` keeps its port (also `:80`); only `http` and `https` are accepted, with no user name or password; path, query and fragment are dropped. The choice is saved.

Data lives in the Electron profile folder `shout-desktop` under the platform's application-data directory (`~/.config/shout-desktop` on Linux): `window-state.json` (size, position, maximized, theme), `settings.json` (the server address) and `logs/server.log` (the owned server's output). SHOUT's own data stays in the server's state directory (`.runs/shout` by default), which the server reports in `/api/config` and Help › Open data folder opens.

## Architecture

| File | Role |
|---|---|
| `src/main.mjs` | Main process: target selection, the window, the connection screen, menus, the bridge handlers, navigation and permission rules, lifecycle |
| `src/backend.mjs` | Server handling without Electron: settings from the environment and `.env`, address normalisation, `check()` of `/api/config`, finding a real `node`, cleaning Electron's variables from the server environment, `OwnedServer` |
| `src/preload.cjs` | The only surface a page gets: `window.shoutDesktop` on the SHOUT page, `window.shoutConnect` on the connection screen |
| `src/loading.html`, `src/connection.js` | The connection screen, with its own strict content security policy |
| `assets/` | Icons at 32–512 px (`make-icons.sh` regenerates them from the wordmark with ImageMagick 7) and wordmarks |

The page side is `apps/shout/public/desktop.js`. In the app it wraps the bridge; in a browser every helper is a harmless no-op (`notify` uses a Web Notification only if permission was already granted). It exports `isDesktop`, `isRemote`, `canPickFolder` and `canRevealPath`, which the UI uses to choose between the native folder chooser and SHOUT's server-side folder browser, and to hide Reveal in file manager.

The server is always started with a real Node found on PATH or through `mise which node`, never Electron's embedded one, because it spawns CLIs and SDKs. Electron's own additions to the environment (`ORIGINAL_XDG_CURRENT_DESKTOP`, `CHROME_DESKTOP`, `ELECTRON_RUN_AS_NODE` and others) are undone for it.

### Bridge API

`window.shoutDesktop` is frozen and exposes no Node globals. It exists only on `http:`/`https:` pages. Every call is re-validated in the main process and accepted only from the window's top frame on the current SHOUT origin.

| Member | Purpose and limits |
|---|---|
| `platform`, `version`, `remote` | Platform, app version, and whether the server is on another computer |
| `chrome` | `{ titlebar: 'overlay' \| 'none' \| 'inset', overlayHeight, overlayWidth, insetLeft }`: the space the page leaves for window controls |
| `pickFolder({ title?, defaultPath? })` | Native directory chooser (can create folders); resolves a path or `null`. `defaultPath` must be absolute |
| `notify({ title, body?, sessionId? })` | Native notification (title ≤ 200, body ≤ 2,000 characters). Clicking it focuses the window and passes `sessionId` to `onOpenSession` |
| `revealPath(path)`, `openPath(path)` | Show in the file manager, or open a folder or plain file with its default app. Existing absolute paths only. `openPath` decides on the canonical path (symlinks and a trailing slash resolved): anything that could run (launcher files such as `.desktop`, `.app`, `.exe` and `.command`, executables, macOS bundles) is only shown in the file manager. It resolves `'opened'` or `'revealed'`. Both reject in remote mode |
| `setAttention(on)` | Flash the window frame while it is not focused |
| `setBadgeCount(n)` | 0–99,999; shown where the platform supports Electron badges |
| `setTheme('light' \| 'dark' \| 'system')` | Native theme and window background; saved |
| `showContextMenu(items, { x, y }?)` | Native menu; resolves the chosen `id` or `null`. Items `{ id, label, enabled?, destructive?, submenu? }` or `{ type: 'separator' }`; at most 64 per level, 3 levels, 200 in all |
| `showAppMenu(position?)` | Pops up the application menu |
| `serverInfo()` | `{ url, urls, owned, attached, remote, stateDir }` |
| `onMenuCommand(callback)` | Menu commands `new-thread`, `add-project`, `export-session`, `toggle-theme`, `toggle-sidebar`; returns an unsubscribe function |
| `onOpenSession(callback)` | A notification was clicked; returns an unsubscribe function |

The connection screen gets only `window.shoutConnect` (`state`, `act`, `onState`), and the main process accepts those two channels only from that file.

### Navigation and permissions

- Renderer: context isolation, sandbox, no Node integration, no `<webview>`.
- The window never leaves the SHOUT origin. Navigation elsewhere is cancelled and `http`/`https` links open in your default browser; other schemes are dropped. Redirects to another origin are blocked. `window.open` and `target=_blank` open externally and never make a second window.
- Permissions: notifications and clipboard read/write for the SHOUT origin; everything else is denied.
- Downloads (session exports) are accepted only from the SHOUT origin and go through the native save dialog.
- One instance: a second launch focuses the running window, and a second launch with `--server` switches it to that server.
- A crashed renderer is reloaded after half a second; after three crashes within a minute the app stops and says so (View › Reload tries again).

### Menus

| Menu | Items (Linux accelerators; `Cmd` on macOS) |
|---|---|
| File | New thread `Ctrl+N`, Add project… `Ctrl+O`, Export session… `Ctrl+Shift+E`, Change server…, Quit `Ctrl+Q` |
| Edit | Undo, Redo, Cut, Copy, Paste, Paste and match style, Delete, Select all |
| View | Toggle theme `Ctrl+Shift+L`, Toggle sidebar `Ctrl+B`, zoom, Reload `Ctrl+R`, Force reload `Ctrl+Shift+R`, developer tools, full screen |
| Window | Minimize, Close window `Ctrl+Shift+W` (closing the only window quits, and stops an owned server, so it is off `Ctrl+W`) |
| Help | A disabled status line naming the server and whether it is owned, attached or remote; Open data folder (the state directory the server reports) and Show server log (local server only); About SHOUT. On macOS the status line and About are in the application menu |

Until the page subscribes to menu commands, the app clicks the page's own buttons instead. Context menus for threads and projects are native in the app and a popover in a browser.

### Notifications and attention

The page watches the thread list from `/api/stream`. For a thread you are not looking at (another thread is open, or the window is not focused) it notifies when the thread starts needing approval or input ("Needs approval", "Needs input") and when its task ends ("Finished", "Failed"). The badge counts threads waiting for you, and the window frame flashes while any are waiting and the window is unfocused. Focusing the window clears both.

## Platforms

**Hyprland and other Wayland compositors.** Electron 44 runs as a native Wayland client with fractional scaling and text-input-v3 input methods (checked with `WAYLAND_DEBUG` on Hyprland), so no launch flags are needed. The window's app id and class is `shout` (`desktopName` in `package.json`, `StartupWMClass` in the launcher entry), for window rules. On tiling compositors (Hyprland, sway, niri and river, detected from `HYPRLAND_INSTANCE_SIGNATURE`, `SWAYSOCK`, `NIRI_SOCKET` or `XDG_CURRENT_DESKTOP`) the app keeps the normal frame, which those compositors draw without a title bar, keeps the Alt menu bar, sets no minimum window size (a compositor crops a window that insists on being larger than its tile, so the page's narrow layout takes whatever tile it gets), and does not save window size or maximized state, since the compositor decides them.

**Other Linux desktops.** The title bar is hidden and the window controls float over the page's top-right corner (a 40 px strip, 138 px wide); the page provides the drag region. `SHOUT_DESKTOP_TITLEBAR=none` keeps the native frame; `SHOUT_DESKTOP_TITLEBAR=overlay` forces the overlay on a tiling compositor. The window opens at 1280×860 (minimum 840×620), and its size, position and maximized state are restored when they fit a connected display. Whether notifications, badges and frame flashing show depends on the desktop.

**macOS: written but never run.** The launch scripts (`tools/start-desktop.sh`, `tools/start-gui.sh`) are written for bash 3.2, the macOS default, and `tools/setup-josh.sh` falls back to a lock directory and `shasum -a 256` where `flock` and `sha256sum` are missing. The app has macOS paths: an inset title bar with the traffic lights in the page's 40 px strip, the standard application menu (About, the server status line, Change server…, Services, Hide, Quit), the dock icon and badge, and staying open without windows until you quit. None of this has been tested. In the unpackaged build the application menu is titled "Electron".

## Client bundle for another computer

```sh
npm run desktop:package    # writes .cache/desktop-client/shout-desktop-client.tgz
```

The bundle is `apps/desktop` without `node_modules` and the icon script, plus a README. On the other computer (macOS or Linux, Node 22.12+):

```sh
tar xzf shout-desktop-client.tgz && cd shout-desktop-client
npm install
npm start -- --server http://HOST:4310    # HOST: the server's Tailscale name or IP, or its LAN IP
```

The first `npm start` downloads Electron (about 100 MB). Without `--server` the app asks for the address and remembers it; change it later with File › Change server… (the application menu on macOS). `SHOUT_SERVER_URL` works too; `--server` wins over it, and both win over the saved address.

Everything still runs on the server's computer: projects, files, agents, approvals and commands. Choose project folders with SHOUT's folder browser, which lists the server's folders; the native chooser and Reveal in file manager are unavailable in remote mode. The bridge trusts the server's origin for notifications, menus, theme and badge only. SHOUT has no login and serves plain HTTP, so connect only to a server you control, preferably over Tailscale.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "SHOUT refused this host name" | Connect with an address the server accepts (its Tailscale or LAN IP always works) or add the name to `SHOUT_ALLOWED_HOSTS` in the server's `.env` and restart it |
| "Nothing is accepting connections at this address" | Start SHOUT on that computer, check the port, and allow it in that computer's firewall for your LAN subnet or Tailscale interface |
| "Browsers block this port for safety" | Run SHOUT on another port (`PORT`) |
| "SHOUT could not start" | Choose **Show log**, or Help › Show server log (`logs/server.log` in the profile folder). A missing Node, a failed `npm ci` or a JOSH build error show up there |
| The launcher entry does nothing | Run `npm run desktop` in a terminal to see the error; move the checkout back or run `npm run desktop:install` again |
| Blank or flickering window | `SHOUT_ELECTRON_FLAGS=--disable-gpu npm run desktop` |
| Codex or Claude shows as unavailable | Sign in (`codex login`, `claude auth login`), then restart the server. An attached server (for example a user service) must be restarted where it runs |
| The window shows another checkout's data | The app attached to a SHOUT server already on the port; the Help menu's status line and About show which. Stop that server, or set a different `PORT` |

`npm run test:desktop` runs the unit tests in `test/` (address normalisation, process-group clean-up) and then exercises all of this with a hidden window (`SHOUT_SMOKE_HEADED=1` shows it), a temporary profile, state directory and port: the launch scripts' array expansions (and, with `SHOUT_TEST_BASH32` set to a bash 3.2 binary, a run of `start-gui.sh` under it), owned and attached servers, a busy port, a launch overtaken while starting, the bridge and its argument validation, `openPath` on bundles, symlinks and executables, menus, notifications, external links, permissions, theme, single instance, renderer crash reload, server crash restart, clean shutdown of the process group, window sizing on tiling and ordinary desktops, remote mode including an outage and reconnect, the connection screen, and the client bundle installed and started outside the checkout. The native folder chooser and notifications are stubbed in that test, and its "remote" server runs on this machine's own LAN address.
