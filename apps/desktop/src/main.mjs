import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, screen, session, shell } from 'electron';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedServer, connectHost, findNode, probe, readSettings, repoRoot, serverEnv } from './backend.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const icon = join(here, '../assets/icons/512.png');
const setting = readSettings();
const hidden = process.env.SHOUT_DESKTOP_HIDDEN === '1'; // automated checks keep the window unmapped
const sessionPattern = /^session-[a-f0-9-]{1,64}$/;
const themes = ['light', 'dark', 'system'];

// Tiling compositors draw no title bar, and a native frame there keeps the Alt menu bar that frameless windows lose.
const desktopName = process.env.ORIGINAL_XDG_CURRENT_DESKTOP || process.env.XDG_CURRENT_DESKTOP || '';
const tiling = process.platform === 'linux' && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.SWAYSOCK || process.env.NIRI_SOCKET || /hyprland|sway|niri|river/i.test(desktopName));
const titlebar = ['overlay', 'none'].includes(process.env.SHOUT_DESKTOP_TITLEBAR) ? process.env.SHOUT_DESKTOP_TITLEBAR : tiling || process.platform === 'darwin' ? 'none' : 'overlay';
const chrome = titlebar === 'overlay' ? { titlebar, overlayHeight: 40, overlayWidth: 138 } : { titlebar, overlayHeight: 0, overlayWidth: 0 };
const overlay = () => ({ color: '#01000000', height: 40, symbolColor: nativeTheme.shouldUseDarkColors ? '#f8fafc' : '#1f2937' }); // fully transparent is ignored on Linux
const background = () => nativeTheme.shouldUseDarkColors ? '#0f0f11' : '#ffffff';

// ~/.config/shout already holds SHOUT's own user config, so Chromium profile data lives beside it.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'shout-desktop'));

const statePath = join(app.getPath('userData'), 'window-state.json');
const logFile = join(app.getPath('userData'), 'logs', 'server.log');
let saved = {};
try { saved = JSON.parse(readFileSync(statePath, 'utf8')) ?? {}; } catch { /* first launch */ }
const persist = patch => {
  saved = { ...saved, ...patch };
  try { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, `${JSON.stringify(saved, null, 2)}\n`); } catch { /* best effort */ }
};
nativeTheme.themeSource = themes.includes(saved.theme) ? saved.theme : 'system';

let win = null, server = null, appOrigin = null, host = '127.0.0.1', serverUrls = [], owned = false;
let quitting = false, restarting = false, waiting = false, upSince = 0, restartDelay = 500, loadingText = '';
const subscriptions = new Set(), notifications = new Set(), crashes = [];
const stateDir = () => resolve(repoRoot, setting('SHOUT_STATE_DIR') || '.runs/shout');
const sameApp = url => { try { return Boolean(appOrigin) && new URL(url).origin === appOrigin; } catch { return false; } };
const onApp = () => Boolean(win) && sameApp(win.webContents.getURL());
const trusted = event => Boolean(win) && event.sender === win.webContents && Boolean(event.senderFrame) && !event.senderFrame.parent && sameApp(event.senderFrame.url);
const openExternal = url => { try { if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch { /* not a URL */ } };
const page = script => onApp() && win.webContents.executeJavaScript(script).catch(() => {});
globalThis.shoutDesktopState = () => ({ url: appOrigin, owned, serverPid: server?.child?.pid ?? null, subscriptions: [...subscriptions] });

// ---- window -------------------------------------------------------------------------------

function restoreBounds(bounds) {
  if (!bounds || ![bounds.width, bounds.height].every(Number.isFinite)) return { width: 1280, height: 860 };
  const size = { width: Math.max(840, Math.round(bounds.width)), height: Math.max(620, Math.round(bounds.height)) };
  const visible = [bounds.x, bounds.y].every(Number.isFinite) && screen.getAllDisplays().some(({ workArea: area }) =>
    bounds.x < area.x + area.width - 64 && bounds.x + size.width > area.x + 64 && bounds.y >= area.y - 8 && bounds.y < area.y + area.height - 64);
  return visible ? { ...size, x: Math.round(bounds.x), y: Math.round(bounds.y) } : size;
}

function createWindow() {
  win = new BrowserWindow({
    ...restoreBounds(saved.bounds), minWidth: 840, minHeight: 620, show: false, title: 'SHOUT', icon, backgroundColor: background(), autoHideMenuBar: true,
    ...(titlebar === 'overlay' ? { titleBarStyle: 'hidden', titleBarOverlay: overlay() } : {}),
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, spellcheck: true,
      additionalArguments: [`--shout-desktop=${JSON.stringify({ version: app.getVersion(), chrome })}`],
    },
  });
  win.once('ready-to-show', () => { if (hidden) return; if (saved.maximized && !tiling) win.maximize(); win.show(); });
  // Tiling compositors size the window themselves and report tiled windows as maximized, so geometry is not kept there.
  win.on('close', () => { if (!tiling) persist({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }); });
  win.on('closed', () => { win = null; });
  win.on('focus', () => { win.flashFrame(false); app.setBadgeCount(0); });
  const contents = win.webContents;
  contents.on('will-navigate', (event, legacyUrl) => { const url = event.url ?? legacyUrl; if (!sameApp(url)) { event.preventDefault(); openExternal(url); } });
  contents.on('will-redirect', (event, legacyUrl) => { if (!sameApp(event.url ?? legacyUrl)) event.preventDefault(); });
  contents.on('did-navigate', () => subscriptions.clear());
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => { if (isMainFrame && code !== -3 && sameApp(url) && !restarting) waitForServer(); });
  // A dead renderer leaves a blank window while agents keep running, so reload it; a boot-time crash loop stops after 3 tries a minute.
  contents.on('render-process-gone', (_event, details) => {
    subscriptions.clear();
    if (details.reason === 'clean-exit' || quitting) return;
    const now = Date.now(); crashes.splice(0, crashes.length, ...crashes.filter(time => now - time < 60000));
    if (crashes.length >= 3) return showLoading('The SHOUT window keeps crashing. Choose View › Reload to try again.');
    crashes.push(now); setTimeout(() => { if (win && !quitting) appOrigin ? loadApp() : showLoading(loadingText); }, 500);
  });
}

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!hidden) win.show();
  win.focus();
}

function showLoading(text) {
  loadingText = text;
  win?.loadFile(join(here, 'loading.html')).then(() => status(loadingText), () => {});
}

function status(text) {
  if (!win || !win.webContents.getURL().startsWith('file:')) return;
  win.webContents.executeJavaScript(`{ const node = document.getElementById('status'); if (node) node.textContent = ${JSON.stringify(String(text).slice(0, 300))}; }`).catch(() => {});
}

const loadApp = () => win?.loadURL(`${appOrigin}/`).catch(() => {});
const reload = force => { if (!win) return; if (appOrigin && !onApp()) return loadApp(); force ? win.webContents.reloadIgnoringCache() : win.webContents.reload(); };

function paintChrome() {
  if (!win) return;
  win.setBackgroundColor(background());
  if (titlebar === 'overlay') win.setTitleBarOverlay(overlay());
}
nativeTheme.on('updated', paintChrome);
function applyTheme(theme) {
  if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  if (saved.theme !== theme) persist({ theme });
  paintChrome();
}

// ---- server -------------------------------------------------------------------------------

async function connect() {
  host = connectHost(setting('SHOUT_HOST'));
  const preferred = Number(setting('PORT') || 4310);
  const origin = `http://${host}:${preferred}`;
  for (;;) {
    const found = await probe(origin);
    // Two servers would share one state directory, so a running SHOUT is reused and never stopped by this app.
    if (found === 'shout') { appOrigin = origin; owned = false; console.log(`SHOUT desktop attached to ${origin}`); return loadApp(); }
    try { return await launch(found === 'free' ? preferred : 0); }
    catch (error) {
      if (quitting) return;
      console.error(`${error.message}\n${error.output ?? ''}`);
      if (hidden) return app.exit(1);
      const { response } = await dialog.showMessageBox(win, {
        type: 'error', title: 'SHOUT could not start', message: error.message, buttons: ['Retry', 'Show log', 'Quit'], defaultId: 0, cancelId: 2, noLink: true,
        detail: error.output ? `${error.output.split('\n').slice(-12).join('\n')}\n\nFull log: ${logFile}` : undefined,
      });
      if (response === 1) shell.openPath(logFile);
      if (response !== 0) return app.quit();
      showLoading('Starting SHOUT…');
    }
  }
}

async function launch(port) {
  const node = findNode(process.env);
  if (!node) throw new Error('SHOUT needs Node.js to run its server, and none was found on PATH or through mise. Install Node 26 (for example `mise use -g node@26`) and try again.');
  mkdirSync(dirname(logFile), { recursive: true });
  const env = serverEnv(process.env, node);
  const begin = next => { server = next; next.on('line', status); return next.start(); };
  let info;
  try { info = await begin(new OwnedServer({ env, port, logFile })); }
  catch (error) {
    if (!port || quitting || !/EADDRINUSE/.test(error.output ?? '')) throw error;
    info = await begin(new OwnedServer({ env, port: 0, logFile }));
  }
  const current = server;
  current.on('crash', () => restart(current));
  appOrigin = `http://${host}:${new URL(info.url).port}`; serverUrls = info.urls; owned = true; upSince = Date.now();
  console.log(`SHOUT desktop started its server at ${appOrigin}`);
  loadApp();
}

// An owned server that dies is restarted with backoff (0.5 s doubling to 10 s) on the same port, then the window reloads.
async function restart(crashed) {
  if (quitting || server !== crashed || restarting) return;
  restarting = true;
  if (Date.now() - upSince > 30000) restartDelay = 500;
  const port = Number(new URL(appOrigin).port);
  showLoading('The SHOUT server stopped. Restarting…');
  while (!quitting) {
    await delay(restartDelay); restartDelay = Math.min(restartDelay * 2, 10000);
    if (quitting) break;
    try { await launch(port); break; }
    catch (error) { console.error(error.message); status(`Restart failed, retrying in ${restartDelay / 1000} s: ${error.message}`); }
  }
  restarting = false;
}

// An attached server can go away (for example a watch-mode restart); wait for it rather than leaving an error page.
async function waitForServer() {
  if (waiting || quitting) return;
  waiting = true;
  showLoading(`Waiting for the SHOUT server at ${appOrigin}…`);
  while (!quitting && win && await probe(appOrigin) !== 'shout') await delay(2000);
  waiting = false;
  if (!quitting && win) loadApp();
}

async function serverInfo() {
  if (!appOrigin) return null;
  if (!owned && !serverUrls.length) {
    try {
      const { networkHosts, accessUrls } = await import('../../shout/src/network.mjs');
      serverUrls = accessUrls(await networkHosts(setting('SHOUT_ALLOWED_HOSTS') || ''), Number(new URL(appOrigin).port), setting('SHOUT_HOST') || '0.0.0.0');
    } catch { serverUrls = [appOrigin]; }
  }
  return { url: appOrigin, urls: [...serverUrls], owned, attached: !owned, stateDir: stateDir() };
}

// ---- menus and commands -----------------------------------------------------------------------

async function pickFolder({ title, defaultPath } = {}) {
  const result = await dialog.showOpenDialog(win, { title: title ?? 'Choose a project folder', defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

// Used only until the page subscribes with onMenuCommand; they drive the existing web controls.
const fallbackCommands = {
  'new-thread': () => page(`document.getElementById('new-session')?.click()`),
  'add-project': async () => {
    const path = await pickFolder();
    if (path) page(`{ document.getElementById('new-session')?.click(); const input = document.getElementById('workspace-input'); if (input) { input.value = ${JSON.stringify(path)}; input.dispatchEvent(new Event('input', { bubbles: true })); } }`);
  },
  'toggle-theme': () => page(`{ const root = document.documentElement; const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; document.querySelector('[data-theme-choice="' + (dark ? 'light' : 'dark') + '"]')?.click(); }`),
  'export-session': () => {
    const id = onApp() ? decodeURIComponent(new URL(win.webContents.getURL()).hash.slice(1)) : '';
    if (sessionPattern.test(id)) win.webContents.downloadURL(`${appOrigin}/api/sessions/${id}/export`);
  },
};

function menuCommand(name) {
  if (!win) return;
  if (subscriptions.has('menu-command')) win.webContents.send('shout:menu-command', name);
  else fallbackCommands[name]?.();
}

function openSession(id) {
  if (subscriptions.has('open-session')) win?.webContents.send('shout:open-session', id);
  else page(`history.replaceState(null, '', '/#' + ${JSON.stringify(encodeURIComponent(id))}); location.reload()`);
}

async function openFolder(path, missing) {
  const error = await shell.openPath(path);
  if (error) dialog.showMessageBox(win, { type: 'warning', title: 'SHOUT', message: missing, detail: `${path}\n${error}` });
}

async function about() {
  const info = await serverInfo();
  dialog.showMessageBox(win, {
    type: 'info', title: 'About SHOUT', message: 'SHOUT', icon, buttons: ['OK'],
    detail: [
      `Desktop ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
      info ? `Server ${info.url} (${info.owned ? 'started by this app' : 'already running, attached'})` : 'Server starting…',
      ...(info?.urls ?? []).filter(url => url !== info.url).map(url => `  ${url}`),
      `Data ${stateDir()}`,
    ].join('\n'),
  });
}

function buildMenu() {
  const command = (label, name, accelerator) => ({ id: name, label, accelerator, click: () => menuCommand(name) });
  return Menu.buildFromTemplate([
    { label: '&File', submenu: [
      command('&New thread', 'new-thread', 'CmdOrCtrl+N'), command('&Add project…', 'add-project', 'CmdOrCtrl+O'), { type: 'separator' },
      command('&Export session…', 'export-session', 'CmdOrCtrl+Shift+E'), { type: 'separator' }, { role: 'quit', label: '&Quit', accelerator: 'CmdOrCtrl+Q' },
    ] },
    { label: '&Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] },
    { label: '&View', submenu: [
      command('Toggle &theme', 'toggle-theme', 'CmdOrCtrl+Shift+L'), command('Toggle &sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'), { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' },
      { label: '&Reload', accelerator: 'CmdOrCtrl+R', click: () => reload(false) }, { label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => reload(true) },
      { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    // Closing the only window quits and stops an owned server, so it is kept off the easy-to-hit Ctrl+W.
    { label: '&Window', submenu: [{ role: 'minimize' }, { label: 'Close window', accelerator: 'CmdOrCtrl+Shift+W', click: () => win?.close() }] },
    { label: '&Help', submenu: [
      { label: 'Open &data folder', click: () => openFolder(stateDir(), 'The SHOUT data folder does not exist yet.') },
      { label: 'Show server &log', click: () => openFolder(logFile, 'This app has not started a SHOUT server, so there is no server log.') },
      { type: 'separator' }, { label: '&About SHOUT', click: about },
    ] },
  ]);
}

function popupMenu(items, position) {
  let choose, count = 0;
  const build = (list, depth) => {
    if (!Array.isArray(list) || !list.length || list.length > 64 || depth > 3) throw new TypeError('Menu items must be a non-empty array of at most 64 items, nested at most 3 deep');
    return list.map(item => {
      if (++count > 200) throw new TypeError('A menu can have at most 200 items');
      const { id, label, enabled, destructive, type, submenu } = objectArg(item);
      if (type === 'separator') return { type: 'separator' };
      if (type !== undefined) throw new TypeError('Menu item type must be "separator" when given');
      if (![enabled, destructive].every(flag => flag === undefined || typeof flag === 'boolean')) throw new TypeError('enabled and destructive must be booleans');
      const entry = { label: text(label, 'label', 200).replaceAll('&', '&&'), enabled: enabled !== false };
      if (submenu !== undefined) return { ...entry, submenu: build(submenu, depth + 1) };
      const value = text(id, 'id', 100);
      return { ...entry, click: () => choose(value) };
    });
  };
  const template = build(items, 1);
  return new Promise(resolveChoice => {
    let done = false;
    choose = value => { if (!done) { done = true; resolveChoice(value); } };
    // The close callback can run before the click handler, so a dismissal resolves null a moment later.
    Menu.buildFromTemplate(template).popup({ window: win, ...position, callback: () => setTimeout(() => choose(null), 50) });
  });
}

// ---- bridge -----------------------------------------------------------------------------------

function objectArg(value, optional = false) {
  if (optional && (value === undefined || value === null)) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object');
  return value;
}
function text(value, name, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new TypeError(`${name} must be a string of at most ${max} characters`);
  return value;
}
function absolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\0')) throw new TypeError('Expected an absolute path');
  return value;
}
function existing(value) {
  const path = absolutePath(value);
  try { return { path, stat: statSync(path) }; } catch { throw new Error(`No such file or folder: ${path}`); }
}
// Renderer positions are CSS pixels; popup() wants window points, so page zoom is applied.
function point(value) {
  if (value === undefined || value === null) return {};
  const { x, y } = objectArg(value);
  if (![x, y].every(n => Number.isFinite(n) && n >= 0 && n < 100000)) throw new TypeError('Position needs finite, non-negative x and y');
  const zoom = win.webContents.getZoomFactor();
  return { x: Math.round(x * zoom), y: Math.round(y * zoom) };
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error('Only the SHOUT window may use the desktop bridge');
    return fn(...args);
  });
  handle('shout:pick-folder', value => {
    const { title, defaultPath } = objectArg(value, true);
    return pickFolder({ title: text(title, 'title', 200, true), defaultPath: defaultPath === undefined ? undefined : absolutePath(defaultPath) });
  });
  handle('shout:notify', value => {
    const { title, body, sessionId } = objectArg(value);
    const content = { title: text(title, 'title', 200), body: text(body, 'body', 2000, true) ?? '' };
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionPattern.test(sessionId))) throw new TypeError('sessionId must be a SHOUT session id');
    if (!Notification.isSupported()) return false;
    const notification = new Notification({ ...content, icon });
    notifications.add(notification); // held so click handlers survive garbage collection
    const release = () => notifications.delete(notification);
    notification.on('click', () => { release(); focusWindow(); if (sessionId) openSession(sessionId); });
    notification.on('close', release); notification.on('failed', release);
    notification.show();
    return true;
  });
  handle('shout:reveal-path', value => { shell.showItemInFolder(existing(value).path); });
  handle('shout:open-path', async value => {
    const { path, stat } = existing(value);
    if (!stat.isDirectory() && (!stat.isFile() || stat.mode & 0o111 || /\.desktop$/i.test(path))) throw new Error('Only folders and non-executable files can be opened');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  handle('shout:attention', value => {
    if (typeof value !== 'boolean') throw new TypeError('setAttention expects a boolean');
    if (!(value && win.isFocused())) win.flashFrame(value);
  });
  handle('shout:badge', value => {
    if (!Number.isInteger(value) || value < 0 || value > 99999) throw new TypeError('setBadgeCount expects a whole number from 0 to 99999');
    return app.setBadgeCount(win.isFocused() ? 0 : value);
  });
  handle('shout:theme', value => {
    if (!themes.includes(value)) throw new TypeError('setTheme expects "light", "dark" or "system"');
    applyTheme(value);
  });
  handle('shout:context-menu', (items, position) => popupMenu(items, point(position)));
  handle('shout:app-menu', position => { Menu.getApplicationMenu()?.popup({ window: win, ...point(position) }); });
  handle('shout:server-info', () => serverInfo());
  ipcMain.on('shout:subscribe', (event, name, on) => {
    if (!trusted(event) || !['menu-command', 'open-session'].includes(name)) return;
    if (on === true) subscriptions.add(name); else subscriptions.delete(name);
  });
}

function installSecurity() {
  const allowed = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowed.has(permission) && sameApp(details.requestingUrl || contents.getURL())));
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => allowed.has(permission) && sameApp(origin || contents?.getURL()));
  // Session exports are attachment downloads; they go through the native save dialog.
  session.defaultSession.on('will-download', (_event, item) => {
    if (!sameApp(item.getURL()) && !item.getURL().startsWith('data:')) return item.cancel();
    item.setSaveDialogOptions({ title: 'Save', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => { if (!sameApp(url)) openExternal(url); return { action: 'deny' }; });
  });
}

// ---- lifecycle --------------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', focusWindow);
  app.whenReady().then(() => {
    installSecurity(); registerIpc(); Menu.setApplicationMenu(buildMenu()); createWindow();
    showLoading('Starting SHOUT…');
    return connect();
  }).catch(error => { console.error(error); dialog.showErrorBox('SHOUT', error.stack || String(error)); app.exit(1); });
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
// Never stop a server this app only attached to; an owned one gets SIGTERM, a grace period, then SIGKILL.
app.on('will-quit', event => {
  if (!server?.child) return;
  event.preventDefault();
  const stopping = server; server = null;
  stopping.stop().finally(() => app.quit());
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
