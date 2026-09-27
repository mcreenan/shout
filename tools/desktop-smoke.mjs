// Drives the real Electron shell with Playwright. Every launch uses a temporary profile, state directory and port,
// so real sessions are never touched. The window stays unmapped unless SHOUT_SMOKE_HEADED=1.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as browserAdapter from '../apps/shout/public/desktop.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
if (!existsSync(join(desktop, 'node_modules/electron'))) execFileSync('npm', ['--prefix', desktop, 'ci', '--no-audit', '--no-fund'], { stdio: 'inherit' });
const executablePath = createRequire(join(desktop, 'package.json'))('electron');
const work = await mkdtemp(join(tmpdir(), 'shout-desktop-smoke-'));
const screenshot = join(root, '.cache/shout-ui/desktop-smoke.png');
const bridgeFunctions = ['notify', 'onMenuCommand', 'onOpenSession', 'openPath', 'pickFolder', 'revealPath', 'serverInfo', 'setAttention', 'setBadgeCount', 'setTheme', 'showAppMenu', 'showContextMenu'];
const cleanups = [];
const ok = message => console.log(`ok - ${message}`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, what, timeout = 30000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await delay(100)) if (await check()) return;
  throw new Error(`Timed out waiting for ${what}`);
};
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.once('error', reject);
  probe.listen(0, '0.0.0.0', () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
});
const answers = async url => { try { return (await fetch(`${url}/api/config`)).ok; } catch { return false; } };

async function launch(name, port, extraEnv = {}) {
  const env = { ...process.env, PORT: String(port), SHOUT_STATE_DIR: join(work, name, 'state'), SHOUT_DESKTOP_HIDDEN: process.env.SHOUT_SMOKE_HEADED === '1' ? '0' : '1', ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  delete env.SHOUT_WATCH;
  const profile = join(work, name, 'profile');
  const app = await electron.launch({ executablePath, args: [desktop, `--user-data-dir=${profile}`], cwd: root, env, timeout: 60000 });
  cleanups.push(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await page.waitForURL(url => url.protocol === 'http:', { timeout: 90000 });
  await page.locator('#new-session').waitFor({ timeout: 30000 });
  return { app, page, env, profile, state: () => app.evaluate(() => globalThis.shoutDesktopState()) };
}

try {
  // The browser build of the adapter is inert.
  assert.equal(browserAdapter.isDesktop, false); assert.equal(browserAdapter.desktop, null);
  assert.equal(await browserAdapter.pickFolder(), null); assert.equal(await browserAdapter.notify({ title: 'x' }), false);
  assert.equal(typeof browserAdapter.onMenuCommand(() => {}), 'function');
  ok('desktop.js is inert outside the desktop app');

  // 1. The preferred port is taken by something that is not SHOUT, so the app starts its own server on another port.
  const decoy = createServer((_request, response) => { response.writeHead(404); response.end('not shout'); });
  const busyPort = await freePort();
  await new Promise(resolveListen => decoy.listen(busyPort, '0.0.0.0', resolveListen));
  cleanups.push(() => new Promise(resolveClose => decoy.close(resolveClose)));
  const { app, page, env, profile, state } = await launch('owned', busyPort);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const first = await state();
  assert.equal(first.owned, true); assert.ok(first.serverPid > 0);
  const origin = new URL(page.url()).origin;
  assert.equal(origin, first.url); assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/); assert.notEqual(new URL(origin).port, String(busyPort));
  ok(`port ${busyPort} busy with a non-SHOUT server, so the app started its own at ${origin}`);

  assert.equal(await page.title(), 'SHOUT');
  for (const selector of ['#app', '.sidebar', '#new-session', '#session-list', '#provider-status']) assert.equal(await page.locator(selector).count(), 1, selector);
  ok('SHOUT UI loaded in the window (title, sidebar, session list, new-session button)');

  const bridge = await page.evaluate(() => {
    const api = window.shoutDesktop;
    return { frozen: Object.isFrozen(api), platform: api.platform, version: api.version, chrome: api.chrome, types: Object.fromEntries(Object.entries(api).map(([key, value]) => [key, typeof value])), node: typeof window.require === 'undefined' && typeof window.process === 'undefined' };
  });
  for (const name of bridgeFunctions) assert.equal(bridge.types[name], 'function', name);
  assert.equal(bridge.platform, process.platform); assert.equal(bridge.version, '0.0.0'); assert.ok(bridge.frozen); assert.ok(bridge.node);
  assert.ok(['overlay', 'none'].includes(bridge.chrome.titlebar));
  const adapter = await page.evaluate(async () => { const module = await import('/desktop.js'); return { isDesktop: module.isDesktop, same: module.desktop === window.shoutDesktop }; });
  assert.deepEqual(adapter, { isDesktop: true, same: true });
  const info = await page.evaluate(() => window.shoutDesktop.serverInfo());
  assert.equal(info.url, origin); assert.equal(info.owned, true); assert.equal(info.attached, false); assert.ok(info.urls.some(url => url.endsWith(`:${new URL(origin).port}`)));
  ok(`window.shoutDesktop is frozen, has no Node globals, exposes ${bridgeFunctions.length} functions; chrome=${bridge.chrome.titlebar}; /desktop.js sees it`);

  // Native folder chooser, stubbed in the main process.
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async (_window, options) => { globalThis.smokeDialog = options; return { canceled: false, filePaths: ['/tmp/picked-project'] }; }; });
  assert.equal(await page.evaluate(() => window.shoutDesktop.pickFolder({ title: 'Pick a project', defaultPath: '/tmp' })), '/tmp/picked-project');
  const dialogOptions = await app.evaluate(() => globalThis.smokeDialog);
  assert.deepEqual(dialogOptions.properties, ['openDirectory', 'createDirectory']); assert.equal(dialogOptions.title, 'Pick a project');
  ok('pickFolder uses the native directory chooser (create-directory enabled)');

  const rejected = await page.evaluate(async () => {
    const api = window.shoutDesktop;
    const calls = {
      relativeDefault: () => api.pickFolder({ defaultPath: 'relative/path' }), numericTitle: () => api.notify({ title: 42 }), badSession: () => api.notify({ title: 'Hi', sessionId: '../x' }),
      relativeOpen: () => api.openPath('relative'), missingReveal: () => api.revealPath('/definitely/not/here'), executableOpen: () => api.openPath('/usr/bin/env'),
      attention: () => api.setAttention('yes'), badge: () => api.setBadgeCount(-1), theme: () => api.setTheme('purple'),
      emptyMenu: () => api.showContextMenu([]), badPosition: () => api.showContextMenu([{ id: 'a', label: 'A' }], { x: -1, y: 0 }), noLabel: () => api.showContextMenu([{ id: 'a' }]),
      callback: () => { api.onMenuCommand('not a function'); return Promise.resolve(); },
    };
    const out = {};
    for (const [name, call] of Object.entries(calls)) out[name] = await Promise.resolve().then(call).then(() => 'resolved', error => error.message);
    return out;
  });
  for (const [name, result] of Object.entries(rejected)) assert.notEqual(result, 'resolved', `${name} should be rejected`);
  ok(`bridge validates arguments (${Object.keys(rejected).length} bad calls rejected)`);

  // Context menu: a stubbed popup reports its close before the click, as native menus may.
  await app.evaluate(({ Menu }) => {
    globalThis.smokePopup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) { globalThis.smokeMenu = { labels: this.items.map(item => item.label), x: options.x, y: options.y }; options.callback?.(); this.items.find(item => item.label === 'Rename').click(); };
  });
  const chosen = await page.evaluate(() => window.shoutDesktop.showContextMenu([{ id: 'rename', label: 'Rename' }, { type: 'separator' }, { id: 'delete', label: 'Delete', destructive: true }, { label: 'More', submenu: [{ id: 'copy', label: 'Copy id', enabled: false }] }], { x: 10, y: 20 }));
  assert.equal(chosen, 'rename');
  const shown = await app.evaluate(() => globalThis.smokeMenu);
  assert.deepEqual(shown.labels, ['Rename', '', 'Delete', 'More']); assert.ok(shown.x >= 10 && shown.y >= 20);
  await app.evaluate(({ Menu }) => { Menu.prototype.popup = function (options) { options.callback?.(); }; });
  assert.equal(await page.evaluate(() => window.shoutDesktop.showContextMenu([{ id: 'a', label: 'A' }])), null);
  await app.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.smokePopup; });
  ok('showContextMenu resolves the clicked id, or null when dismissed');

  // External links open in the default browser (stubbed) and never navigate or open windows.
  await app.evaluate(({ shell }) => { globalThis.smokeOpened = []; shell.openExternal = async url => { globalThis.smokeOpened.push(url); }; });
  const before = page.url();
  await page.evaluate(() => {
    const link = Object.assign(document.createElement('a'), { id: 'smoke-external', href: 'https://example.com/docs', textContent: 'external' });
    const blank = Object.assign(document.createElement('a'), { id: 'smoke-blank', href: 'https://example.org/', target: '_blank', textContent: 'blank' });
    document.body.append(link, blank);
  });
  // Clicked from inside the page: Playwright would otherwise wait for the navigation the shell cancels.
  await page.evaluate(() => { document.getElementById('smoke-external').click(); document.getElementById('smoke-blank').click(); });
  const opened = await page.evaluate(() => window.open('https://example.net/') === null);
  await page.evaluate(() => { location.href = 'file:///etc/passwd'; });
  await until(async () => (await app.evaluate(() => globalThis.smokeOpened.length)) >= 3, 'external opens');
  await delay(300);
  assert.equal(page.url(), before); assert.ok(opened);
  assert.deepEqual((await app.evaluate(() => globalThis.smokeOpened)).sort(), ['https://example.com/docs', 'https://example.net/', 'https://example.org/']);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  ok('external links (plain, target=_blank, window.open) go to the default browser; the window never leaves the app, file: is blocked');

  const permissions = await page.evaluate(async () => ({ notifications: Notification.permission, geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state }));
  assert.deepEqual(permissions, { notifications: 'granted', geolocation: 'denied' });
  ok('permissions: notifications allowed, everything else denied');

  // Menu commands: before the page subscribes, the shell drives the existing controls itself.
  const clickMenu = id => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id);
  await clickMenu('new-thread');
  await page.waitForFunction(() => document.getElementById('new-dialog').open);
  await page.evaluate(() => document.getElementById('new-dialog').close());
  await page.evaluate(() => { window.smokeCommands = []; window.smokeStop = window.shoutDesktop.onMenuCommand(command => window.smokeCommands.push(command)); });
  assert.deepEqual((await state()).subscriptions, ['menu-command']);
  for (const id of ['new-thread', 'add-project', 'export-session', 'toggle-theme', 'toggle-sidebar']) await clickMenu(id);
  await page.waitForFunction(() => window.smokeCommands.length === 5);
  assert.deepEqual(await page.evaluate(() => window.smokeCommands), ['new-thread', 'add-project', 'export-session', 'toggle-theme', 'toggle-sidebar']);
  assert.equal(await page.evaluate(() => document.getElementById('new-dialog').open), false);
  await page.evaluate(() => window.smokeStop());
  await until(async () => (await state()).subscriptions.length === 0, 'unsubscribe');
  ok('menu commands reach onMenuCommand subscribers; without one the shell falls back to the page controls');
  // Notifications: shown natively (stubbed here so nothing pops up); a click focuses SHOUT and opens the session.
  await app.evaluate(({ Notification }) => { globalThis.smokeNotes = []; Notification.prototype.show = function () { globalThis.smokeNotes.push(this); }; });
  await page.evaluate(() => { window.smokeSessions = []; window.smokeStopSessions = window.shoutDesktop.onOpenSession(id => window.smokeSessions.push(id)); });
  assert.equal(await page.evaluate(() => window.shoutDesktop.notify({ title: 'Run finished', body: 'Tests passed', sessionId: 'session-1234abcd' })), true);
  assert.deepEqual(await app.evaluate(() => { const note = globalThis.smokeNotes[0]; return { title: note.title, body: note.body }; }), { title: 'Run finished', body: 'Tests passed' });
  await app.evaluate(() => globalThis.smokeNotes[0].emit('click'));
  await page.waitForFunction(() => window.smokeSessions[0] === 'session-1234abcd');
  await page.evaluate(() => window.smokeStopSessions());
  ok('notify shows a native notification whose click routes the session to onOpenSession');

  // The page theme drives native chrome (nativeTheme, window background).
  const nativeTheme = () => app.evaluate(({ nativeTheme: theme, BrowserWindow }) => ({ source: theme.themeSource, background: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase() }));
  const choose = theme => page.evaluate(choice => document.querySelector(`[data-theme-choice="${choice}"]`).click(), theme);
  await choose('dark');
  await until(async () => (await nativeTheme()).source === 'dark', 'dark native theme');
  assert.equal((await nativeTheme()).background, '#0f0f11');
  await page.evaluate(() => window.shoutDesktop.setTheme('light'));
  assert.deepEqual(await nativeTheme(), { source: 'light', background: '#ffffff' });
  await choose('system');
  await until(async () => (await nativeTheme()).source === 'system', 'system native theme');
  assert.deepEqual(errors, []);
  ok('theme follows the page and setTheme (nativeTheme + background colour); no uncaught page errors so far');

  await mkdir(dirname(screenshot), { recursive: true });
  // capturePage also works while the window is unmapped, where CDP screenshots never get a frame.
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'));
  await writeFile(screenshot, Buffer.from(png, 'base64'));
  ok(`screenshot saved to ${screenshot}`);

  // A second launch with the same profile hands off to this instance and exits.
  await app.evaluate(({ app: electronApp }) => { globalThis.smokeSecond = 0; electronApp.on('second-instance', () => { globalThis.smokeSecond += 1; }); });
  const second = spawnSync(executablePath, [desktop, `--user-data-dir=${profile}`], { cwd: root, env, timeout: 30000, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  await until(async () => (await app.evaluate(() => globalThis.smokeSecond)) === 1, 'second-instance event');
  ok('single-instance lock: a second launch exits and signals the running window');

  // A crashed renderer is reloaded.
  // executeJavaScript never settles on a renderer that is dying, so each probe is time-boxed.
  const pageReady = () => app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    if (contents.isCrashed() || contents.isLoading() || !contents.getURL().startsWith(globalThis.shoutDesktopState().url)) return false;
    return Promise.race([contents.executeJavaScript('Boolean(document.getElementById("new-session"))').catch(() => false), new Promise(resolveLate => setTimeout(() => resolveLate(false), 1000))]);
  });
  const reason = await app.evaluate(({ BrowserWindow }) => new Promise(resolveGone => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.once('render-process-gone', (_event, details) => resolveGone(details.reason));
    contents.forcefullyCrashRenderer();
  }));
  await until(pageReady, 'renderer recovery');
  ok(`crashed renderer (${reason}) is reloaded`);

  // An owned server that dies is restarted on the same port and the window reloads.
  process.kill(first.serverPid, 'SIGKILL');
  await until(async () => { const now = await state(); return now.serverPid && now.serverPid !== first.serverPid && await pageReady(); }, 'server restart', 60000);
  const restarted = await state();
  assert.equal(restarted.url, origin); assert.ok(await answers(origin));
  ok(`killed server ${first.serverPid} was restarted as ${restarted.serverPid} on the same origin`);

  await app.close(); cleanups.pop();
  await until(() => !alive(restarted.serverPid), 'owned server exit', 10000);
  assert.equal(spawnSync('pgrep', ['-g', String(restarted.serverPid)]).status, 1, 'no process left in the server process group');
  assert.equal(await answers(origin), false);
  ok('quitting stopped the owned server and its process group');

  // 2. A SHOUT server already running on the port is attached to and left running on quit.
  const port = await freePort();
  const external = spawn('bash', [join(root, 'tools/start-gui.sh')], { cwd: root, env: { ...env, PORT: String(port), SHOUT_STATE_DIR: join(work, 'attached', 'server-state') }, stdio: 'ignore', detached: true });
  cleanups.push(() => { try { process.kill(-external.pid, 'SIGTERM'); } catch { /* gone */ } });
  const externalUrl = `http://127.0.0.1:${port}`;
  await until(() => answers(externalUrl), 'external SHOUT server', 90000);
  // This launch emulates an ordinary (non-tiling) desktop: overlay title bar controls and remembered window size.
  const ordinary = { HYPRLAND_INSTANCE_SIGNATURE: undefined, SWAYSOCK: undefined, NIRI_SOCKET: undefined, XDG_CURRENT_DESKTOP: 'GNOME', ORIGINAL_XDG_CURRENT_DESKTOP: undefined };
  const windowState = join(work, 'attached', 'profile', 'window-state.json');
  await mkdir(dirname(windowState), { recursive: true });
  await writeFile(windowState, JSON.stringify({ bounds: { width: 1100, height: 760 }, maximized: false }));
  const attached = await launch('attached', port, ordinary);
  const attachedState = await attached.state();
  assert.equal(attachedState.owned, false); assert.equal(attachedState.serverPid, null); assert.equal(attachedState.url, externalUrl);
  const attachedInfo = await attached.page.evaluate(() => window.shoutDesktop.serverInfo());
  assert.equal(attachedInfo.attached, true); assert.ok(attachedInfo.urls.includes(`http://127.0.0.1:${port}`));
  const chrome = await attached.page.evaluate(() => ({ chrome: window.shoutDesktop.chrome, overlay: navigator.windowControlsOverlay?.visible ?? false }));
  assert.deepEqual(chrome, { chrome: { titlebar: 'overlay', overlayHeight: 40, overlayWidth: 138 }, overlay: true });
  assert.deepEqual(await attached.app.evaluate(({ BrowserWindow }) => { const { width, height } = BrowserWindow.getAllWindows()[0].getBounds(); return { width, height }; }), { width: 1100, height: 760 });
  await attached.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
  await attached.app.close(); cleanups.pop();
  const remembered = JSON.parse(await readFile(windowState, 'utf8'));
  assert.equal(remembered.bounds.width, 1200); assert.equal(remembered.bounds.height, 800); assert.equal(remembered.maximized, false);
  ok('ordinary desktop: overlay window controls are shown, and window size is restored and saved');
  assert.ok(await answers(externalUrl)); assert.ok(alive(external.pid));
  ok(`attached to the SHOUT server already on port ${port} and left it running on quit`);

  console.log('PASS desktop: own/attach/fallback server lifecycle, UI, bridge, validation, navigation safety, menus, theme, single instance, crash recovery, clean quit.');
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(work, { recursive: true, force: true });
}
