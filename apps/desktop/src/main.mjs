import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, screen, session, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedServer, check, connectHost, findNode, localServerAvailable, normalizeServerUrl, readSettings, serverEnv } from './backend.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const icon = join(here, '../assets/icons/512.png');
const screenFile = join(here, 'loading.html');
const setting = readSettings();
const mac = process.platform === 'darwin';
// Automated checks keep the window unmapped. An unmapped Wayland window gets no frame callbacks, so Chromium applies
// only its first resizes; 'offscreen' also renders offscreen, where every resize applies without a compositor.
const hidden = ['1', 'offscreen'].includes(process.env.SHOUT_DESKTOP_HIDDEN);
const sessionPattern = /^session-[a-f0-9-]{1,64}$/;
const themes = ['light', 'dark', 'system'];

// macOS keeps its traffic lights inset in the page. Tiling compositors draw no title bar, and a native frame there
// keeps the Alt menu bar that frameless windows lose; other desktops get floating window controls over the page.
const desktopName = process.env.ORIGINAL_XDG_CURRENT_DESKTOP || process.env.XDG_CURRENT_DESKTOP || '';
const tiling = process.platform === 'linux' && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.SWAYSOCK || process.env.NIRI_SOCKET || /hyprland|sway|niri|river/i.test(desktopName));
// A tiling compositor sizes the window itself and crops a surface that insists on being larger than its tile
// (even a 300 px minimum height was cropped in a short Hyprland tile), so there the page, which has its own
// narrow layout, always takes exactly the tile it is given.
const minSize = tiling ? { width: 0, height: 0 } : { width: 840, height: 620 };
const titlebar = ['overlay', 'none'].includes(process.env.SHOUT_DESKTOP_TITLEBAR) ? process.env.SHOUT_DESKTOP_TITLEBAR : mac ? 'inset' : tiling ? 'none' : 'overlay';
const chrome = { titlebar, overlayHeight: titlebar === 'none' ? 0 : 40, overlayWidth: titlebar === 'overlay' ? 138 : 0, insetLeft: titlebar === 'inset' ? 80 : 0 };
const overlay = () => ({ color: '#01000000', height: 40, symbolColor: nativeTheme.shouldUseDarkColors ? '#f8fafc' : '#1f2937' }); // fully transparent is ignored on Linux
const background = () => nativeTheme.shouldUseDarkColors ? '#0f0f11' : '#ffffff';

// ~/.config/shout already holds SHOUT's own user config, so Chromium profile data lives beside it.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'shout-desktop'));

// window-state.json keeps window geometry and theme; settings.json keeps the chosen server.
const statePath = join(app.getPath('userData'), 'window-state.json');
const settingsPath = join(app.getPath('userData'), 'settings.json');
const logFile = join(app.getPath('userData'), 'logs', 'server.log');
const readJson = path => { try { const value = JSON.parse(readFileSync(path, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
const writeJson = (path, value) => { try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); } catch { /* best effort */ } };
let saved = readJson(statePath), settings = readJson(settingsPath);
const persist = patch => { saved = { ...saved, ...patch }; writeJson(statePath, saved); };
const saveSettings = patch => { settings = { ...settings, ...patch }; writeJson(settingsPath, settings); };
nativeTheme.themeSource = themes.includes(saved.theme) ? saved.theme : 'system';

// mode: 'local' (this checkout's server, attached or owned), 'remote' (a server URL) or 'setup' (asking for one).
// generation increases whenever the target changes, so stale connect/retry loops stop.
let win = null, server = null, appOrigin = null, host = '127.0.0.1', serverUrls = [], owned = false, mode = null, generation = 0;
let quitting = false, restarting = false, reconnecting = 0, upSince = 0, restartDelay = 500, view = 'screen', retryNow = () => {};
let screenState = { title: 'Starting SHOUT…', busy: true, actions: [] };
const subscriptions = new Set(), notifications = new Set(), crashes = [];
// The state directory a local server reports in /api/config; null while unknown and always in remote mode.
let serverStateDir = null;
// Opening a path must never launch anything: macOS .app bundles are folders, and launcher files run commands.
const launcherPattern = /\.(app|bundle|prefpane|workflow|action|command|tool|terminal|webloc|fileloc|inetloc|url|desktop|appimage|jar|pkg|mpkg|scpt|applescript|exe|msi|bat|cmd|lnk)$/i;
const sameApp = url => { try { return Boolean(appOrigin) && new URL(url).origin === appOrigin; } catch { return false; } };
const onApp = () => Boolean(win) && sameApp(win.webContents.getURL());
const isScreen = url => { try { return new URL(url).protocol === 'file:' && fileURLToPath(url) === screenFile; } catch { return false; } };
const onScreen = () => Boolean(win) && isScreen(win.webContents.getURL());
const fromWindow = event => Boolean(win) && event.sender === win.webContents && Boolean(event.senderFrame) && !event.senderFrame.parent;
const trusted = event => fromWindow(event) && sameApp(event.senderFrame.url);
const openExternal = url => { try { if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch { /* not a URL */ } };
const page = script => onApp() && win.webContents.executeJavaScript(script).catch(() => {});
globalThis.shoutDesktopState = () => ({ url: appOrigin, mode, owned, serverPid: server?.child?.pid ?? null, launching: starting.size, subscriptions: [...subscriptions], view, screen: screenState });

// --server <url> or --server=<url>; the second-instance event passes the other launch's argv here too.
function argServer(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--server') return argv[index + 1] ?? '';
    if (argv[index].startsWith('--server=')) return argv[index].slice(9);
  }
  return undefined;
}

// ---- window -------------------------------------------------------------------------------

function restoreBounds(bounds) {
  if (!bounds || ![bounds.width, bounds.height].every(Number.isFinite)) return { width: 1280, height: 860 };
  const size = { width: Math.max(minSize.width, Math.round(bounds.width)), height: Math.max(minSize.height, Math.round(bounds.height)) };
  const visible = [bounds.x, bounds.y].every(Number.isFinite) && screen.getAllDisplays().some(({ workArea: area }) =>
    bounds.x < area.x + area.width - 64 && bounds.x + size.width > area.x + 64 && bounds.y >= area.y - 8 && bounds.y < area.y + area.height - 64);
  return visible ? { ...size, x: Math.round(bounds.x), y: Math.round(bounds.y) } : size;
}

function createWindow() {
  win = new BrowserWindow({
    ...restoreBounds(saved.bounds), minWidth: minSize.width, minHeight: minSize.height, show: false, title: 'SHOUT', icon, backgroundColor: background(), autoHideMenuBar: true,
    ...(titlebar === 'overlay' ? { titleBarStyle: 'hidden', titleBarOverlay: overlay() } : {}),
    // The 12 px traffic lights sit centred in the 40 px strip the page reserves (chrome.overlayHeight / insetLeft).
    ...(titlebar === 'inset' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } } : {}),
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, spellcheck: true, offscreen: process.env.SHOUT_DESKTOP_HIDDEN === 'offscreen' },
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
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => { if (isMainFrame && code !== -3 && sameApp(url) && !restarting) reconnect(generation); });
  // With a hidden title bar macOS has no other handle, so a thin drag strip stays until the page adds its own
  // regions and marks <html data-drag-region>.
  contents.on('dom-ready', () => {
    if (titlebar === 'inset' && onApp()) contents.insertCSS('html:not([data-drag-region]) body::before{content:"";position:fixed;top:0;left:0;right:0;height:12px;-webkit-app-region:drag;z-index:2147483647}').catch(() => {});
  });
  // A dead renderer leaves a blank window while agents keep running, so reload it; a boot-time crash loop stops after 3 tries a minute.
  contents.on('render-process-gone', (_event, details) => {
    subscriptions.clear();
    if (details.reason === 'clean-exit' || quitting) return;
    const now = Date.now(); crashes.splice(0, crashes.length, ...crashes.filter(time => now - time < 60000));
    if (crashes.length >= 3) return showScreen({ title: 'The SHOUT window keeps crashing', detail: 'Choose View › Reload to try again.' });
    crashes.push(now); setTimeout(() => { if (win && !quitting) restoreView(); }, 500);
  });
}

// macOS keeps running without windows; the dock, a notification or a second launch brings one back.
function focusWindow() {
  if (!win) { if (!app.isReady() || quitting) return; createWindow(); restoreView(); }
  if (win.isMinimized()) win.restore();
  if (!hidden) win.show();
  win.focus();
}

const restoreView = () => view === 'app' && appOrigin ? loadApp() : showScreen(screenState, true);

// The connection screen (loading.html) shows progress, errors and the server form; it pulls this state when it loads.
let screenLoading = false;
function showScreen(next, fresh = false) {
  screenState = { title: '', hint: '', url: '', error: '', detail: '', busy: false, form: null, actions: [], ...next };
  view = 'screen';
  if (!win) return;
  if (onScreen() && !fresh) win.webContents.send('shout:screen', screenState);
  else if (!screenLoading || fresh) { screenLoading = true; win.loadFile(screenFile).catch(() => {}).finally(() => { screenLoading = false; }); }
}
// Server output while it starts (npm installs, the first JOSH build) streams into the status line.
const status = text => { if (view === 'screen' && screenState.busy) showScreen({ ...screenState, detail: String(text).slice(0, 300) }); };

const loadApp = () => { view = 'app'; return win?.loadURL(`${appOrigin}/`).catch(() => {}); };
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

// Order: --server, SHOUT_SERVER_URL, the saved choice; otherwise this checkout's own server, or the connect form.
function start() {
  const configured = argServer(process.argv) ?? (process.env.SHOUT_SERVER_URL || undefined) ?? settings.serverUrl;
  if (configured !== undefined) return useRemote(configured);
  if (localServerAvailable) return useLocal();
  return showSetup();
}

// Servers still starting, with the generation that launched them, so switching away or quitting stops them too.
const starting = new Map();
const stopStale = () => { for (const [instance, run] of starting) if (run !== generation) instance.stop(); };

// Stops a server this app started; switching away from it (or quitting) is the only time that happens.
async function releaseOwned() {
  const stopping = server; server = null; owned = false; restartDelay = 500;
  stopStale();
  if (stopping) await stopping.stop();
}

function setMode(next) { mode = next; serverStateDir = null; Menu.setApplicationMenu(buildMenu()); aboutPanel(); }

// Records what the connected server reports, then refreshes the menu status line and About text.
function connected(config) {
  const dir = config?.stateDir;
  serverStateDir = mode !== 'remote' && typeof dir === 'string' && isAbsolute(dir) ? dir : null;
  Menu.setApplicationMenu(buildMenu()); aboutPanel();
}

async function useRemote(input) {
  let origin;
  try { origin = normalizeServerUrl(input); } catch (error) { return showSetup(error.message, typeof input === 'string' ? input : ''); }
  const run = ++generation; retryNow();
  await releaseOwned();
  if (run !== generation) return;
  appOrigin = origin; serverUrls = [origin]; setMode('remote');
  console.log(`SHOUT desktop connecting to ${origin}`);
  return reconnect(run);
}

async function useLocal() {
  const run = ++generation; retryNow(); stopStale();
  setMode('local');
  if (server?.ready && server.child) { owned = true; return loadApp(); } // this app's own server is still running
  appOrigin = null;
  host = connectHost(setting('SHOUT_HOST'));
  const preferred = Number(setting('PORT') || 4310);
  const origin = `http://${host}:${preferred}`;
  while (run === generation && !quitting) {
    showScreen({ title: 'Starting SHOUT…', busy: true, actions: ['change'] });
    const { state: found, config } = await check(origin);
    if (run !== generation) return;
    // Two servers would share one state directory, so a running SHOUT is reused and never stopped by this app.
    if (found === 'shout') { appOrigin = origin; owned = false; serverUrls = []; connected(config); console.log(`SHOUT desktop attached to ${origin}`); loadApp(); return monitor(run); }
    try { return await launch(found === 'free' ? preferred : 0, run); }
    catch (error) {
      if (quitting || run !== generation) return;
      console.error(`${error.message}\n${error.output ?? ''}`);
      if (hidden) return app.exit(1);
      showScreen({ title: 'SHOUT could not start', error: error.message, detail: error.output?.split('\n').at(-1) ?? '', actions: ['retry', 'log', 'change'] });
      await new Promise(resolveRetry => { retryNow = resolveRetry; });
    }
  }
}

async function launch(port, run = generation) {
  const node = findNode(process.env);
  if (!node) throw new Error('SHOUT needs Node.js to run its server, and none was found on PATH or through mise. Install Node 26 (for example `mise use -g node@26`) and try again.');
  mkdirSync(dirname(logFile), { recursive: true });
  const env = serverEnv(process.env, node);
  // Each attempt keeps its own instance: a newer launch may have replaced `server` by the time this one is ready.
  // It is published at once (while still current) so quitting or switching away can stop it while it starts.
  const begin = async instance => {
    starting.set(instance, run);
    if (run === generation) server = instance;
    instance.on('line', line => { if (run === generation) status(line); });
    try { return await instance.start(); }
    catch (error) { if (server === instance) server = null; throw error; }
    finally { starting.delete(instance); }
  };
  let instance = new OwnedServer({ env, port, logFile }), info;
  try { info = await begin(instance); }
  catch (error) {
    if (!port || quitting || run !== generation || !/EADDRINUSE/.test(error.output ?? '')) throw error;
    instance = new OwnedServer({ env, port: 0, logFile });
    info = await begin(instance);
  }
  if (run !== generation || quitting) { if (server === instance) server = null; return instance.stop(); } // switched away while it started
  server = instance;
  instance.on('crash', () => restart(instance));
  appOrigin = `http://${host}:${new URL(info.url).port}`; serverUrls = info.urls; owned = true; upSince = Date.now();
  const { config } = await check(appOrigin);
  if (run !== generation) return; // switching away already took over (and stopped this server if it had to)
  connected(config);
  console.log(`SHOUT desktop started its server at ${appOrigin}`);
  loadApp();
}

// An owned server that dies is restarted with backoff (0.5 s doubling to 10 s) on the same port, then the window reloads.
async function restart(crashed) {
  if (quitting || server !== crashed || restarting) return;
  restarting = true;
  await crashed.stop(); // clears whatever the dead server left in its process group
  const run = generation;
  if (Date.now() - upSince > 30000) restartDelay = 500;
  const port = Number(new URL(appOrigin).port);
  showScreen({ title: 'The SHOUT server stopped. Restarting…', busy: true });
  while (!quitting && run === generation) {
    await delay(restartDelay); restartDelay = Math.min(restartDelay * 2, 10000);
    if (quitting || run !== generation) break;
    try { await launch(port, run); break; }
    catch (error) { console.error(error.message); status(`Restart failed, retrying in ${restartDelay / 1000} s: ${error.message}`); }
  }
  restarting = false;
}

// Waits for a server that is not (or no longer) answering: remote servers and attached local ones.
// Backoff 0.5 s doubling to 10 s; "Retry now" skips the wait. A local server that stays away is replaced by starting one.
async function reconnect(run) {
  if (reconnecting === run || run !== generation || quitting) return;
  reconnecting = run;
  try {
    let wait = 500, error = '';
    for (let attempt = 0; run === generation && !quitting; attempt++) {
      showScreen({ title: error ? 'SHOUT is not reachable' : 'Connecting to SHOUT…', url: appOrigin, error, busy: true, detail: error ? 'Trying again…' : '', actions: error ? ['retry', 'change'] : ['change'] });
      const result = await check(appOrigin, 4000);
      if (run !== generation || quitting) return;
      if (result.state === 'shout') { connected(result.config); console.log(`SHOUT desktop connected to ${appOrigin}`); loadApp(); return monitor(run); }
      if (mode === 'local' && !owned && attempt >= 3) { reconnecting = 0; return useLocal(); }
      error = result.error;
      showScreen({ title: 'SHOUT is not reachable', url: appOrigin, error, detail: `Trying again in ${wait / 1000} s.`, actions: ['retry', 'change'] });
      await new Promise(resolveWait => { const timer = setTimeout(resolveWait, wait); retryNow = () => { clearTimeout(timer); resolveWait(); }; });
      wait = Math.min(wait * 2, 10000);
    }
  } finally { if (reconnecting === run) reconnecting = 0; }
}

// While the app is shown, a server that stops answering twice in a row (about 10 s) sends the window to reconnect.
function monitor(run) {
  let misses = 0, busy = false;
  const timer = setInterval(async () => {
    if (run !== generation || quitting || owned) return clearInterval(timer);
    if (view !== 'app' || !win || busy) return;
    busy = true;
    const { state } = await check(appOrigin, 3000);
    busy = false;
    misses = state === 'shout' ? 0 : misses + 1;
    if (misses >= 2 && run === generation && view === 'app') { clearInterval(timer); reconnect(run); }
  }, 5000);
}

function showSetup(error = '', value = '') {
  ++generation; retryNow(); setMode('setup');
  showScreen({
    title: 'Connect to a SHOUT server', error, form: { value },
    hint: 'Enter the address of the computer running SHOUT, for example http://my-computer:4310 on your LAN or Tailscale.',
    actions: localServerAvailable ? ['local'] : [],
  });
}

// Pauses any connection loop and shows the server form; Cancel returns to where the app was.
function changeServer() {
  const previous = { mode, run: ++generation }; retryNow();
  showScreen({
    title: 'Connect to a SHOUT server', form: { value: mode === 'remote' ? appOrigin : settings.serverUrl ?? '' },
    hint: 'The address of the computer running SHOUT, for example http://my-computer:4310. Your choice is remembered.',
    actions: [...(previous.mode && previous.mode !== 'setup' ? ['cancel'] : []), ...(localServerAvailable && previous.mode !== 'local' ? ['local'] : [])],
  });
  cancelChange = () => {
    if (previous.run !== generation) return;
    if (previous.mode === 'remote') return reconnect(++generation);
    if (owned && server?.ready) { ++generation; return loadApp(); }
    return useLocal();
  };
}
let cancelChange = () => {};

async function screenAction(action, value) {
  if (action === 'retry') retryNow();
  else if (action === 'change') changeServer();
  else if (action === 'cancel') cancelChange();
  else if (action === 'log') shell.openPath(logFile);
  else if (action === 'local' && localServerAvailable) { saveSettings({ serverUrl: undefined }); useLocal(); }
  else if (action === 'connect') {
    let origin;
    try { origin = normalizeServerUrl(value); } catch (error) { return { error: error.message }; }
    saveSettings({ serverUrl: origin });
    useRemote(origin);
  }
  return { ok: true };
}

async function serverInfo() {
  if (!appOrigin) return null;
  const remote = mode === 'remote';
  if (!owned && !remote && !serverUrls.length) {
    try {
      const { networkHosts, accessUrls } = await import('../../shout/src/network.mjs');
      serverUrls = accessUrls(await networkHosts(setting('SHOUT_ALLOWED_HOSTS') || ''), Number(new URL(appOrigin).port), setting('SHOUT_HOST') || '0.0.0.0');
    } catch { serverUrls = [appOrigin]; }
  }
  return { url: appOrigin, urls: [...serverUrls], owned, attached: !owned, remote, stateDir: remote ? null : serverStateDir };
}

// ---- menus and commands -----------------------------------------------------------------------

async function pickFolder({ title, defaultPath } = {}) {
  const result = await dialog.showOpenDialog(win, { title: title ?? 'Choose a project folder', defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

// Used only until the page subscribes with onMenuCommand (it does as it loads); they click the page's own controls.
const fallbackCommands = {
  'new-thread': () => page(`document.getElementById('new-session')?.click()`),
  'add-project': () => page(`document.getElementById('add-project')?.click()`),
  'toggle-sidebar': () => page(`document.getElementById('sidebar-toggle')?.click()`),
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

// Opens a folder or a plain file with its default app. Anything that could run (launcher files, executables, macOS
// bundles, including extension-less ones) is only revealed in the file manager. The decision uses the canonical
// path, so a trailing slash or a harmlessly named symlink cannot hide what would really be opened.
async function safeOpen(path) {
  const target = realpathSync(path), stat = statSync(target);
  const runnable = launcherPattern.test(target) || (stat.isDirectory() ? mac && existsSync(join(target, 'Contents', 'Info.plist')) : !stat.isFile() || Boolean(stat.mode & 0o111));
  if (runnable) { shell.showItemInFolder(target); return 'revealed'; }
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return 'opened';
}

async function openFolder(path, missing) {
  if (!path) return;
  try { await safeOpen(path); } catch (error) { dialog.showMessageBox(win, { type: 'warning', title: 'SHOUT', message: missing, detail: `${path}\n${error.message}` }); }
}

// Remote: a server on another computer. Owned: started (and stopped) by this app. Attached: already running here.
const serverKind = info => info.remote ? 'remote, on another computer' : info.owned ? 'owned, started by this app' : 'attached, already running';
const serverLine = info => !info ? 'Not connected to a server' : `Server ${info.url} (${serverKind(info)})`;
const connection = () => appOrigin ? { url: appOrigin, remote: mode === 'remote', owned } : null;

async function about() {
  const info = await serverInfo();
  dialog.showMessageBox(win, {
    type: 'info', title: 'About SHOUT', message: 'SHOUT', icon, buttons: ['OK'],
    detail: [
      `Desktop ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`, serverLine(info),
      ...(info?.urls ?? []).filter(url => url !== info.url).map(url => `  ${url}`),
      ...(info?.stateDir ? [`Data ${info.stateDir}`] : []),
    ].join('\n'),
  });
}

// macOS shows its standard About panel from the app menu; keep its text in step with the server in use.
function aboutPanel() {
  if (!mac) return;
  serverInfo().then(info => app.setAboutPanelOptions({ applicationName: 'SHOUT', applicationVersion: app.getVersion(), version: `Electron ${process.versions.electron}`, credits: serverLine(info), iconPath: icon }), () => {});
}

function buildMenu() {
  const command = (label, name, accelerator) => ({ id: name, label, accelerator, click: () => menuCommand(name) });
  const local = mode === 'local';
  const changeItem = { id: 'change-server', label: 'Change &server…', click: changeServer };
  const statusItem = { id: 'server-status', label: serverLine(connection()), enabled: false };
  const help = [
    ...(mac ? [] : [statusItem, { type: 'separator' }]),
    ...(local ? [
      { id: 'open-data-folder', label: 'Open &data folder', enabled: Boolean(serverStateDir), click: () => openFolder(serverStateDir, 'The SHOUT data folder does not exist yet.') },
      { label: 'Show server &log', click: () => openFolder(logFile, 'This app has not started a SHOUT server, so there is no server log.') },
    ] : []),
    ...(mac ? [] : [...(local ? [{ type: 'separator' }] : []), { label: '&About SHOUT', click: about }]),
  ];
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' }, statusItem, changeItem, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: '&File', submenu: [
      command('&New thread', 'new-thread', 'CmdOrCtrl+N'), command('&Add project…', 'add-project', 'CmdOrCtrl+O'), { type: 'separator' },
      command('&Export session…', 'export-session', 'CmdOrCtrl+Shift+E'), { type: 'separator' },
      ...(mac ? [{ role: 'close' }] : [changeItem, { type: 'separator' }, { role: 'quit', label: '&Quit', accelerator: 'CmdOrCtrl+Q' }]),
    ] },
    { label: '&Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' }] },
    { label: '&View', submenu: [
      command('Toggle &theme', 'toggle-theme', 'CmdOrCtrl+Shift+L'), command('Toggle &sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'), { type: 'separator' },
      { role: 'zoomIn' }, { role: 'zoomIn', accelerator: 'CmdOrCtrl+=', visible: false }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' },
      { label: '&Reload', accelerator: 'CmdOrCtrl+R', click: () => reload(false) }, { label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => reload(true) },
      { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    // Elsewhere closing the only window quits (and stops an owned server), so it stays off the easy-to-hit Ctrl+W.
    mac ? { role: 'windowMenu' } : { label: '&Window', submenu: [{ role: 'minimize' }, { label: 'Close window', accelerator: 'CmdOrCtrl+Shift+W', click: () => win?.close() }] },
    ...(help.length ? [{ role: 'help', label: '&Help', submenu: help }] : []),
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
  // With a remote server, paths the page knows about are on the server's computer, not this one.
  const localFiles = () => { if (mode === 'remote') throw new Error('Files are on the SHOUT server’s computer, so they cannot be opened here'); };
  handle('shout:reveal-path', value => { localFiles(); shell.showItemInFolder(existing(value).path); });
  // Resolves 'opened', or 'revealed' when the target could run and was only shown in the file manager.
  handle('shout:open-path', value => { localFiles(); return safeOpen(existing(value).path); });
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
  ipcMain.on('shout:desktop-config', event => { event.returnValue = fromWindow(event) ? { version: app.getVersion(), chrome, remote: mode === 'remote' } : {}; });
  // The bundled connection screen gets its own two channels and nothing else.
  const fromScreen = event => fromWindow(event) && isScreen(event.senderFrame.url);
  ipcMain.handle('shout:screen-state', event => { if (!fromScreen(event)) throw new Error('Only the SHOUT connection screen may ask'); return screenState; });
  ipcMain.handle('shout:screen-action', (event, action, value) => {
    if (!fromScreen(event)) throw new Error('Only the SHOUT connection screen may ask');
    if (!['retry', 'change', 'cancel', 'log', 'local', 'connect'].includes(action) || (value !== undefined && (typeof value !== 'string' || value.length > 2048))) throw new TypeError('Unknown connection screen action');
    return screenAction(action, value);
  });
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
  // A second launch focuses this window; one given --server switches this window to that server.
  app.on('second-instance', (_event, argv) => { const url = argServer(argv); if (url !== undefined) useRemote(url); focusWindow(); });
  app.whenReady().then(() => {
    if (mac) app.dock?.setIcon(icon); // unpackaged Electron would otherwise show its own dock icon
    installSecurity(); registerIpc(); Menu.setApplicationMenu(buildMenu()); createWindow();
    showScreen(screenState);
    return start();
  }).catch(error => { console.error(error); dialog.showErrorBox('SHOUT', error.stack || String(error)); app.exit(1); });
}

app.on('before-quit', () => { quitting = true; });
// macOS apps stay running with no windows and reopen one from the dock; elsewhere closing the window quits.
app.on('window-all-closed', () => { if (!mac) app.quit(); });
app.on('activate', () => { if (app.isReady() && !win) focusWindow(); });
// Never stop a server this app only attached to; an owned one gets SIGTERM, a grace period, then SIGKILL.
app.on('will-quit', event => {
  const running = [...new Set([server, ...starting.keys()])].filter(instance => instance?.child);
  if (!running.length) return;
  event.preventDefault(); server = null;
  Promise.allSettled(running.map(instance => instance.stop())).finally(() => app.quit());
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.quit());
