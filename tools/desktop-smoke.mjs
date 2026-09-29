// Drives the real Electron shell with Playwright. Every launch uses a temporary profile, state directory and port,
// so real sessions are never touched. The window stays unmapped unless SHOUT_SMOKE_HEADED=1.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
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

// wait=false returns as soon as the first window exists (for runs that start on the connection screen).
async function launch(name, port, extraEnv = {}, { args = [], wait = true, executable = executablePath, appDir = desktop, cwd = root } = {}) {
  const env = { ...process.env, PORT: String(port), SHOUT_STATE_DIR: join(work, name, 'state'), SHOUT_DESKTOP_HIDDEN: process.env.SHOUT_SMOKE_HEADED === '1' ? '0' : '1', SHOUT_SERVER_URL: undefined, ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  delete env.SHOUT_WATCH;
  const profile = join(work, name, 'profile');
  const app = await electron.launch({ executablePath: executable, args: [appDir, `--user-data-dir=${profile}`, ...args], cwd, env, timeout: 60000 });
  cleanups.push(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  if (wait) await appReady(page);
  return { app, page, env, profile, state: () => app.evaluate(() => globalThis.shoutDesktopState()) };
}
async function appReady(page) {
  await page.waitForURL(url => url.protocol === 'http:', { timeout: 90000 });
  await page.locator('#new-session').waitFor({ timeout: 30000 });
}
// A SHOUT server started on its own, the way `npm start` would; the desktop app must only ever connect to it.
async function startShout(name, port) {
  port ??= await freePort();
  const env = { ...process.env, PORT: String(port), SHOUT_STATE_DIR: join(work, name, 'state') };
  delete env.SHOUT_WATCH; delete env.SHOUT_SERVER_URL;
  const child = spawn('bash', [join(root, 'tools/start-gui.sh')], { cwd: root, env, stdio: 'ignore', detached: true });
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    await until(() => !alive(child.pid), `${name} server exit`, 10000).catch(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
  };
  cleanups.push(stop);
  const url = `http://127.0.0.1:${port}`;
  await until(() => answers(url), `${name} SHOUT server`, 90000);
  return { port, url, pid: child.pid, stop };
}
// Every process below pid, so a run can prove it spawned no server of its own.
function descendants(pid) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([, child, parent, args]) => ({ pid: Number(child), ppid: Number(parent), args }));
  const found = [], walk = parent => { for (const row of rows) if (row.ppid === parent) { found.push(row); walk(row.pid); } };
  walk(pid); return found;
}
// The native menu item with this id (label, enabled), or null when the menu does not have it.
const menuItem = (app, id) => app.evaluate(({ Menu }, itemId) => { const item = Menu.getApplicationMenu().getMenuItemById(itemId); return item && { label: item.label, enabled: item.enabled }; }, id);
const noServerBelow = app => assert.deepEqual(descendants(app.process().pid).filter(row => /server\.mjs|start-gui\.sh/.test(row.args)).map(row => row.args), []);
const screen = page => page.evaluate(() => ({ title: document.getElementById('title')?.textContent, url: document.getElementById('url')?.textContent, error: document.getElementById('error')?.hidden ? '' : document.getElementById('error')?.textContent, form: !document.getElementById('connect-form')?.hidden, actions: [...document.querySelectorAll('[data-action]')].filter(button => !button.hidden).map(button => button.dataset.action) }));
const lan = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address ?? '127.0.0.1';

try {
  // The browser build of the adapter is inert.
  assert.equal(browserAdapter.isDesktop, false); assert.equal(browserAdapter.desktop, null);
  assert.equal(await browserAdapter.pickFolder(), null); assert.equal(await browserAdapter.notify({ title: 'x' }), false);
  assert.equal(typeof browserAdapter.onMenuCommand(() => {}), 'function');
  ok('desktop.js is inert outside the desktop app');

  const unit = spawnSync(process.execPath, ['--test', join(desktop, 'test/backend.test.mjs')], { encoding: 'utf8' });
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);
  ok(`backend unit tests: ${/ℹ pass (\d+)/.exec(unit.stdout)?.[1]} passed (explicit ports, process group cleared even past SIGTERM)`);

  // macOS ships bash 3.2, where "${a[@]}" on an empty array aborts under set -u; the launch scripts use ${a[@]+"${a[@]}"}.
  for (const script of ['tools/start-gui.sh', 'tools/start-desktop.sh']) {
    const bare = (await readFile(join(root, script), 'utf8')).split('\n').filter(line => !line.trimStart().startsWith('#') && /(?<!\+)"\$\{\w+\[@\]\}"/.test(line));
    assert.deepEqual(bare, [], `${script} has array expansions that bash 3.2 rejects when empty`);
  }
  // With SHOUT_TEST_BASH32 pointing at a bash 3.2 binary, start-gui.sh also runs under it (a stub node records the arguments).
  if (process.env.SHOUT_TEST_BASH32) {
    const stub = join(work, 'stub-bin');
    await mkdir(stub, { recursive: true });
    await writeFile(join(stub, 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    for (const [watch, args] of [['', []], ['1', ['--extra', 'two words']]]) {
      const run = spawnSync(process.env.SHOUT_TEST_BASH32, [join(root, 'tools/start-gui.sh'), ...args], { encoding: 'utf8', env: { ...process.env, JOSH_BIN: '/bin/true', SHOUT_WATCH: watch, PATH: `${stub}:${process.env.PATH}` } });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.stdout.trim().split('\n'), [...(watch ? ['--watch', '--watch-preserve-output'] : []), `--env-file-if-exists=${root}/.env`, `${root}/apps/shout/src/server.mjs`, ...args]);
    }
    ok('start-gui.sh runs under bash 3.2 with and without SHOUT_WATCH and extra arguments');
  }

  // 1. The preferred port is taken by something that is not SHOUT, so the app starts its own server on another port.
  const decoy = createServer((_request, response) => { response.writeHead(404); response.end('not shout'); });
  const busyPort = await freePort();
  await new Promise(resolveListen => decoy.listen(busyPort, '0.0.0.0', resolveListen));
  cleanups.push(() => new Promise(resolveClose => decoy.close(resolveClose)));
  // Named as a tiling desktop (as this machine's Hyprland is) so the tiling window rules are checked on any Linux host.
  const { app, page, env, profile, state } = await launch('owned', busyPort, { XDG_CURRENT_DESKTOP: 'Hyprland' });
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
  // The state directory comes from the server's own /api/config, so the data folder is the one it really uses.
  assert.equal(info.stateDir, env.SHOUT_STATE_DIR);
  assert.deepEqual(await menuItem(app, 'server-status'), { label: `Server ${origin} (owned, started by this app)`, enabled: false });
  assert.deepEqual(await menuItem(app, 'open-data-folder'), { label: 'Open &data folder', enabled: true });
  ok(`window.shoutDesktop is frozen, has no Node globals, exposes ${bridgeFunctions.length} functions; chrome=${bridge.chrome.titlebar}; /desktop.js sees it`);

  // Native folder chooser, stubbed in the main process.
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async (_window, options) => { globalThis.smokeDialog = options; return { canceled: false, filePaths: ['/tmp/picked-project'] }; }; });
  assert.equal(await page.evaluate(() => window.shoutDesktop.pickFolder({ title: 'Pick a project', defaultPath: '/tmp' })), '/tmp/picked-project');
  const dialogOptions = await app.evaluate(() => globalThis.smokeDialog);
  assert.deepEqual(dialogOptions.properties, ['openDirectory', 'createDirectory']); assert.equal(dialogOptions.title, 'Pick a project');
  ok('pickFolder uses the native directory chooser (create-directory enabled)');

  const fakeApp = join(work, 'Fake.app'); // a macOS bundle is a folder, and opening it would launch it
  await mkdir(fakeApp, { recursive: true });
  const rejected = await page.evaluate(async bundlePath => {
    const api = window.shoutDesktop;
    const calls = {
      relativeDefault: () => api.pickFolder({ defaultPath: 'relative/path' }), numericTitle: () => api.notify({ title: 42 }), badSession: () => api.notify({ title: 'Hi', sessionId: '../x' }),
      relativeOpen: () => api.openPath('relative'), missingReveal: () => api.revealPath('/definitely/not/here'), 
      attention: () => api.setAttention('yes'), badge: () => api.setBadgeCount(-1), theme: () => api.setTheme('purple'),
      emptyMenu: () => api.showContextMenu([]), badPosition: () => api.showContextMenu([{ id: 'a', label: 'A' }], { x: -1, y: 0 }), noLabel: () => api.showContextMenu([{ id: 'a' }]),
      callback: () => { api.onMenuCommand('not a function'); return Promise.resolve(); },
    };
    const out = {};
    for (const [name, call] of Object.entries(calls)) out[name] = await Promise.resolve().then(call).then(() => 'resolved', error => error.message);
    return out;
  }, fakeApp);
  for (const [name, result] of Object.entries(rejected)) assert.notEqual(result, 'resolved', `${name} should be rejected`);
  ok(`bridge validates arguments (${Object.keys(rejected).length} bad calls rejected)`);

  // openPath checks what would really be opened: a trailing slash or a harmlessly named symlink must not hide a bundle
  // or an executable. Those are only revealed in the file manager. Both shell calls are stubbed, so nothing opens.
  const files = join(work, 'files');
  await mkdir(join(files, 'folder'), { recursive: true });
  await writeFile(join(files, 'notes.md'), '# notes\n');
  await writeFile(join(files, 'run.sh'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
  await symlink(fakeApp, join(files, 'docs'));
  await symlink(join(files, 'run.sh'), join(files, 'readme.txt'));
  await app.evaluate(({ shell }) => {
    globalThis.smokeShell = [];
    shell.openPath = async target => { globalThis.smokeShell.push(['open', target]); return ''; };
    shell.showItemInFolder = target => { globalThis.smokeShell.push(['reveal', target]); };
  });
  const openResults = await page.evaluate(async paths => {
    const out = [];
    for (const path of paths) out.push(await window.shoutDesktop.openPath(path).catch(error => `error: ${error.message}`));
    return out;
  }, [fakeApp, `${fakeApp}/`, join(files, 'docs'), join(files, 'run.sh'), join(files, 'readme.txt'), '/usr/bin/env', join(files, 'folder'), join(files, 'notes.md')]);
  assert.deepEqual(openResults, ['revealed', 'revealed', 'revealed', 'revealed', 'revealed', 'revealed', 'opened', 'opened']);
  assert.deepEqual(await app.evaluate(() => globalThis.smokeShell), [
    ['reveal', fakeApp], ['reveal', fakeApp], ['reveal', fakeApp], ['reveal', join(files, 'run.sh')], ['reveal', join(files, 'run.sh')], ['reveal', realpathSync('/usr/bin/env')],
    ['open', join(files, 'folder')], ['open', join(files, 'notes.md')],
  ]);
  ok('openPath uses the canonical path: bundles (even as "X.app/" or behind a symlink) and executables are only revealed');

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

  // Menu commands: the page subscribes as it loads and handles them (the shell's fallbacks only click page controls).
  const clickMenu = id => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu().getMenuItemById(itemId).click(), id);
  await until(async () => { const now = await state(); return now.subscriptions.includes('menu-command') && now.subscriptions.includes('open-session'); }, 'page subscriptions');
  await clickMenu('export-session');
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Open a thread'));
  const collapsed = () => page.evaluate(() => document.getElementById('app').classList.contains('sidebar-collapsed'));
  const startCollapsed = await collapsed();
  await clickMenu('toggle-sidebar');
  await until(async () => (await collapsed()) !== startCollapsed, 'sidebar toggled by the menu');
  await delay(450); // the same command twice within 400 ms runs once (accelerator and page shortcut)
  await clickMenu('toggle-sidebar');
  await until(async () => (await collapsed()) === startCollapsed, 'sidebar toggled back');
  const pageTheme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  const startTheme = await pageTheme();
  await clickMenu('toggle-theme');
  await until(async () => (await pageTheme()) !== startTheme && ['light', 'dark'].includes(await pageTheme()), 'theme toggled by the menu');
  // Add project: the native folder chooser (stubbed), then a project for that folder.
  const picked = join(work, 'picked-project');
  await mkdir(picked, { recursive: true });
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async (_window, options) => { globalThis.smokeDialog = options; return { canceled: false, filePaths: [path] }; }; }, picked);
  await clickMenu('add-project');
  await until(async () => (await (await fetch(`${origin}/api/projects`)).json()).some(project => project.path === picked), 'a project from the native folder chooser');
  assert.equal((await app.evaluate(() => globalThis.smokeDialog)).title, 'Add project');
  // Other subscribers get the commands too; unsubscribing leaves the page's subscription.
  await page.evaluate(() => { window.smokeCommands = []; window.smokeStop = window.shoutDesktop.onMenuCommand(command => window.smokeCommands.push(command)); });
  await delay(450);
  for (const id of ['toggle-sidebar', 'toggle-sidebar']) { await clickMenu(id); await delay(450); }
  await page.waitForFunction(() => window.smokeCommands.length === 2);
  assert.equal(await collapsed(), startCollapsed);
  await page.evaluate(() => window.smokeStop());
  assert.ok((await state()).subscriptions.includes('menu-command'));
  ok('menu commands reach the page (export, sidebar, theme, add project through the native chooser) and other subscribers');
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

  // Change server… then Cancel while the first server is still starting: the superseded launch must stop its own
  // server and never the newer one, leaving exactly one server, owned and tracked.
  const race = await launch('race', busyPort, { XDG_CURRENT_DESKTOP: 'Hyprland' }, { wait: false });
  let racing;
  await until(async () => { const now = await race.state(); if (now.serverPid && now.view === 'screen' && now.launching) racing = now; return Boolean(racing); }, 'the first server to be starting', 30000);
  await race.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('change-server').click());
  await race.page.evaluate(() => window.shoutConnect.act('cancel'));
  await appReady(race.page);
  const settled = await race.state();
  assert.equal(settled.owned, true); assert.notEqual(settled.serverPid, racing.serverPid); assert.equal(settled.launching, 0);
  await until(() => !alive(racing.serverPid), 'the superseded server to stop', 10000);
  assert.deepEqual(descendants(race.app.process().pid).filter(row => /apps\/shout\/src\/server\.mjs/.test(row.args)).map(row => row.pid), [settled.serverPid]);
  await race.app.close();
  await until(() => !alive(settled.serverPid), 'the owned server to stop on quit', 10000);
  ok(`a launch superseded while starting (server ${racing.serverPid}) stops only itself; the newer server ${settled.serverPid} is the one owned, and quitting stops it`);

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
  // Tiling desktop sizing: no minimum window size (a larger one is cropped by a smaller tile), and the page
  // relayouts for each size. Rendered offscreen, because an unmapped Wayland window gets no frame callbacks and
  // Chromium then applies only its first resizes (mapped windows on Hyprland followed every tile change).
  const sizing = await launch('sizing', port, { XDG_CURRENT_DESKTOP: 'Hyprland', SHOUT_DESKTOP_HIDDEN: 'offscreen' });
  const sizingWindow = (method, ...args) => sizing.app.evaluate(({ BrowserWindow }, [name, values]) => BrowserWindow.getAllWindows()[0][name](...values), [method, args]);
  assert.deepEqual(await sizingWindow('getMinimumSize'), [0, 0]);
  for (const width of [1000, 800, 600]) {
    await sizingWindow('setContentSize', width, 500);
    await until(async () => (await sizing.page.evaluate(() => innerWidth)) === width, `the page to be ${width} px wide`, 10000);
  }
  await sizing.app.close();
  ok('tiling desktop: no minimum window size, and the page width follows setContentSize down to 600 px');

  const attached = await launch('attached', port, ordinary);
  assert.deepEqual(await attached.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize()), [840, 620]);
  const attachedState = await attached.state();
  assert.equal(attachedState.owned, false); assert.equal(attachedState.serverPid, null); assert.equal(attachedState.url, externalUrl);
  const attachedInfo = await attached.page.evaluate(() => window.shoutDesktop.serverInfo());
  assert.equal(attachedInfo.attached, true); assert.ok(attachedInfo.urls.includes(`http://127.0.0.1:${port}`));
  // The app's own SHOUT_STATE_DIR differs; the data folder must be the one the attached server reports.
  assert.notEqual(attached.env.SHOUT_STATE_DIR, join(work, 'attached', 'server-state'));
  assert.equal(attachedInfo.stateDir, join(work, 'attached', 'server-state'));
  assert.deepEqual(await menuItem(attached.app, 'server-status'), { label: `Server ${externalUrl} (attached, already running)`, enabled: false });
  assert.equal((await menuItem(attached.app, 'open-data-folder')).enabled, true);
  const chrome = await attached.page.evaluate(() => ({ chrome: window.shoutDesktop.chrome, overlay: navigator.windowControlsOverlay?.visible ?? false }));
  assert.deepEqual(chrome, { chrome: { titlebar: 'overlay', overlayHeight: 40, overlayWidth: 138, insetLeft: 0 }, overlay: true });
  assert.deepEqual(await attached.app.evaluate(({ BrowserWindow }) => { const { width, height } = BrowserWindow.getAllWindows()[0].getBounds(); return { width, height }; }), { width: 1100, height: 760 });
  await attached.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
  await attached.app.close(); cleanups.pop();
  const remembered = JSON.parse(await readFile(windowState, 'utf8'));
  assert.equal(remembered.bounds.width, 1200); assert.equal(remembered.bounds.height, 800); assert.equal(remembered.maximized, false);
  ok('ordinary desktop: 840×620 minimum, overlay window controls are shown, and window size is restored and saved');
  assert.ok(await answers(externalUrl)); assert.ok(alive(external.pid));
  ok(`attached to the SHOUT server already on port ${port}, used the state directory it reports, and left it running on quit`);

  // 3. Remote mode: --server names a SHOUT server started separately, reached through this machine's LAN address.
  const remoteServer = await startShout('remote-server');
  const remoteUrl = `http://${lan}:${remoteServer.port}`;
  const remote = await launch('remote', await freePort(), {}, { args: ['--server', remoteUrl] });
  const remoteState = await remote.state();
  assert.equal(remoteState.mode, 'remote'); assert.equal(remoteState.owned, false); assert.equal(remoteState.serverPid, null); assert.equal(remoteState.url, remoteUrl);
  assert.equal(new URL(remote.page.url()).origin, remoteUrl);
  noServerBelow(remote.app);
  const remoteBridge = await remote.page.evaluate(async () => {
    const adapter = await import('/desktop.js');
    const attempt = call => call.then(() => 'resolved', error => error.message);
    return {
      remote: window.shoutDesktop.remote, info: await window.shoutDesktop.serverInfo(), adapter: { isRemote: adapter.isRemote, canPickFolder: adapter.canPickFolder, canRevealPath: adapter.canRevealPath },
      reveal: await attempt(window.shoutDesktop.revealPath('/tmp')), open: await attempt(window.shoutDesktop.openPath('/tmp')), theme: await attempt(window.shoutDesktop.setTheme('system')),
    };
  });
  assert.equal(remoteBridge.remote, true);
  assert.deepEqual(remoteBridge.info, { url: remoteUrl, urls: [remoteUrl], owned: false, attached: true, remote: true, stateDir: null });
  assert.equal(await menuItem(remote.app, 'open-data-folder'), null);
  assert.deepEqual(await menuItem(remote.app, 'server-status'), { label: `Server ${remoteUrl} (remote, on another computer)`, enabled: false });
  assert.deepEqual(remoteBridge.adapter, { isRemote: true, canPickFolder: false, canRevealPath: false });
  assert.match(remoteBridge.reveal, /server/); assert.match(remoteBridge.open, /server/); assert.equal(remoteBridge.theme, 'resolved');
  ok(`remote mode: --server ${remoteUrl} loads the remote UI, spawns no server, bridge trusts that origin, pickFolder/revealPath unavailable`);
  // The page follows the flags: Add project opens the server-side folder dialog, and no menu offers Reveal.
  await remote.app.evaluate(({ dialog, Menu }) => {
    globalThis.nativeDialogs = 0; dialog.showOpenDialog = async () => { globalThis.nativeDialogs += 1; return { canceled: true, filePaths: [] }; };
    Menu.prototype.popup = function (options) { globalThis.remoteMenu = this.items.map(item => item.label); options.callback?.(); };
  });
  await remote.page.evaluate(() => document.getElementById('add-project').click());
  await remote.page.waitForFunction(() => document.getElementById('add-project-dialog')?.open && document.getElementById('workspace-input'));
  await remote.page.evaluate(() => document.getElementById('add-project-dialog').close());
  const remoteFolder = join(work, 'remote-project');
  await mkdir(remoteFolder, { recursive: true });
  const remoteProject = await (await fetch(`${remoteUrl}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shout-Client': '1' }, body: JSON.stringify({ path: remoteFolder }) })).json();
  await remote.page.waitForFunction(() => document.getElementById('app').classList.contains('has-projects'));
  await remote.page.evaluate(id => {
    document.getElementById('project-scope').click();
    document.querySelector(`#scope-options [data-value="${id}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 140 }));
  }, remoteProject.id);
  await until(() => remote.app.evaluate(() => Boolean(globalThis.remoteMenu)), 'the native project menu');
  const remoteMenu = await remote.app.evaluate(() => globalThis.remoteMenu);
  assert.ok(remoteMenu.includes('Copy path') && !remoteMenu.includes('Reveal in file manager'), remoteMenu.join(', '));
  assert.equal(await remote.app.evaluate(() => globalThis.nativeDialogs), 0);
  ok('remote mode UI: Add project uses the server-side folder dialog, not the native chooser; menus offer no Reveal');

  // The server goes away: the health check notices, the connection screen retries with backoff, and the app comes back.
  await remoteServer.stop();
  await remote.page.waitForURL(url => url.protocol === 'file:', { timeout: 30000 });
  await remote.page.waitForFunction(expected => document.getElementById('url')?.textContent === expected, remoteUrl, { timeout: 15000 });
  const remoteAgain = await startShout('remote-server', remoteServer.port);
  await until(async () => (await remote.state()).view === 'app', 'reconnect after the server returned', 30000);
  await appReady(remote.page);
  ok('remote server outage shows the connection screen and reconnects on its own when the server returns');
  await remote.app.close();
  assert.ok(await answers(remoteAgain.url)); assert.ok(alive(remoteAgain.pid));
  ok('quitting the remote-mode app leaves the server running');

  // 4. An unreachable --server shows the connection screen; Retry connects once the server is up; bad addresses are refused.
  const laterPort = await freePort();
  const laterUrl = `http://127.0.0.1:${laterPort}`;
  const waiting = await launch('unreachable', await freePort(), {}, { args: [`--server=${laterUrl}/#session-123`], wait: false });
  await waiting.page.waitForFunction(() => document.getElementById('error') && !document.getElementById('error').hidden, null, { timeout: 30000 });
  const down = await screen(waiting.page);
  assert.equal(down.title, 'SHOUT is not reachable'); assert.equal(down.url, laterUrl); assert.match(down.error, /Nothing is accepting connections/); assert.deepEqual(down.actions, ['retry', 'change']);
  noServerBelow(waiting.app);
  await startShout('later-server', laterPort);
  await waiting.page.evaluate(() => document.querySelector('[data-action="retry"]').click());
  await appReady(waiting.page);
  assert.equal(new URL(waiting.page.url()).origin, laterUrl);
  await waiting.app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('change-server').click());
  await waiting.page.waitForFunction(() => !document.getElementById('connect-form')?.hidden, null, { timeout: 15000 });
  assert.equal(await waiting.page.inputValue('#server-input'), laterUrl);
  await waiting.page.fill('#server-input', 'ftp://example.com');
  await waiting.page.evaluate(() => document.getElementById('connect-form').requestSubmit());
  await waiting.page.waitForFunction(() => !document.getElementById('form-error').hidden);
  assert.match(await waiting.page.textContent('#form-error'), /Only http/);
  await waiting.page.evaluate(() => document.querySelector('[data-action="cancel"]').click());
  await appReady(waiting.page);
  await waiting.app.close();
  ok('unreachable server: connection screen with URL, reason and Retry; Retry connects once it is up; Change server rejects ftp:// and Cancel returns');

  // 5. The client bundle runs on its own from a directory with no SHOUT checkout around it.
  const bundleTar = execFileSync('bash', [join(root, 'tools/package-desktop-client.sh')], { encoding: 'utf8' }).trim();
  const unpack = join(work, 'client');
  await mkdir(unpack, { recursive: true });
  execFileSync('tar', ['-xzf', bundleTar, '-C', unpack]);
  const bundle = join(unpack, 'shout-desktop-client');
  assert.ok(existsSync(join(bundle, 'README.md'))); assert.ok(!existsSync(join(bundle, 'node_modules')));
  execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: bundle, stdio: 'ignore' });
  const bundleElectron = createRequire(join(bundle, 'package.json'))('electron');
  // `npm start -- --server URL`, exactly as the README says.
  const started = spawn('npm', ['start', '--', '--server', remoteUrl, `--user-data-dir=${join(work, 'client-npm-profile')}`], { cwd: bundle, env: { ...process.env, SHOUT_DESKTOP_HIDDEN: '1', SHOUT_SERVER_URL: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => { try { process.kill(-started.pid, 'SIGKILL'); } catch { /* gone */ } });
  let startedOutput = '';
  started.stdout.on('data', chunk => { startedOutput += chunk; }); started.stderr.on('data', chunk => { startedOutput += chunk; });
  await until(() => startedOutput.includes(`SHOUT desktop connected to ${remoteUrl}`), 'npm start in the bundle to connect', 60000);
  process.kill(-started.pid, 'SIGTERM');
  await until(() => !alive(started.pid), 'npm start to exit', 15000);
  ok('client bundle: npm install + npm start -- --server URL connects from outside the checkout');

  // Without a server setting and no checkout around it, the app asks for an address and remembers it.
  const client = await launch('client', await freePort(), {}, { wait: false, executable: bundleElectron, appDir: bundle, cwd: bundle });
  await client.page.waitForFunction(() => document.getElementById('connect-form') && !document.getElementById('connect-form').hidden, null, { timeout: 30000 });
  const setup = await screen(client.page);
  assert.equal(setup.title, 'Connect to a SHOUT server'); assert.deepEqual(setup.actions, []);
  await client.page.fill('#server-input', `${lan}:${remoteServer.port}`);
  await client.page.evaluate(() => document.getElementById('connect-form').requestSubmit());
  await appReady(client.page);
  assert.equal(new URL(client.page.url()).origin, remoteUrl);
  noServerBelow(client.app);
  await client.app.close();
  assert.deepEqual(JSON.parse(await readFile(join(client.profile, 'settings.json'), 'utf8')), { serverUrl: remoteUrl });
  const clientAgain = await launch('client', await freePort(), {}, { executable: bundleElectron, appDir: bundle, cwd: bundle });
  assert.equal(new URL(clientAgain.page.url()).origin, remoteUrl);
  await clientAgain.app.close();
  ok('client bundle without a server setting shows the connect form, and the saved address is used on the next launch');

  console.log('PASS desktop: own/attach/fallback/remote server lifecycle, connection screen, client bundle, UI, bridge, validation, navigation safety, menus, theme, single instance, crash recovery, clean quit.');
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(work, { recursive: true, force: true });
}
