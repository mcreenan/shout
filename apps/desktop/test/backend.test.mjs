// Plain-Node tests for the server lifecycle and address handling in src/backend.mjs (run by tools/desktop-smoke.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OwnedServer, normalizeServerUrl } from '../src/backend.mjs';

test('normalizeServerUrl keeps an explicit port and gives a bare host SHOUT’s default 4310', () => {
  for (const [input, expected] of [
    ['my-server', 'http://my-server:4310'], ['my-server:80', 'http://my-server'], ['my-server:4310', 'http://my-server:4310'], ['my-server:8080/#session-1', 'http://my-server:8080'],
    ['192.0.2.10', 'http://192.0.2.10:4310'], ['192.0.2.10:80', 'http://192.0.2.10'], ['[::1]', 'http://[::1]:4310'], ['[::1]:80', 'http://[::1]'],
    ['http://my-server', 'http://my-server'], ['https://my-server', 'https://my-server'], ['HTTP://My-Server:80/', 'http://my-server'],
  ]) assert.equal(normalizeServerUrl(input), expected, input);
  for (const bad of ['', 'ftp://my-server', 'http://user:pass@my-server', 'http://', 'my server']) assert.throws(() => normalizeServerUrl(bad), undefined, bad);
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const gone = async (pid, timeout = 3000) => { for (const end = Date.now() + timeout; Date.now() < end; await delay(50)) if (!alive(pid)) return true; return false; };

// A stand-in for tools/start-gui.sh: it leaves a helper that ignores SIGTERM in the process group (as a stuck agent CLI
// might), then execs a "server" that reports ready over IPC and exits on SIGTERM.
async function fakeCheckout(t) {
  const root = await mkdtemp(join(tmpdir(), 'shout-desktop-backend-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tools'));
  await writeFile(join(root, 'tools/start-gui.sh'), `#!/usr/bin/env bash
( trap '' TERM; exec sleep 300 ) &
echo $! > "$HELPER_PID_FILE"
exec "$NODE_BIN" -e "process.send({ type: 'ready', url: 'http://127.0.0.1:9', urls: [] }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"
`);
  const pidFile = join(root, 'helper.pid');
  const server = new OwnedServer({ env: { ...process.env, HELPER_PID_FILE: pidFile, NODE_BIN: process.execPath }, port: 0, root, echo: false });
  await server.start();
  const leader = server.child.pid; // spawned detached, so it leads its own process group
  t.after(() => { try { process.kill(-leader, 'SIGKILL'); } catch { /* already gone */ } });
  return { server, leader, helper: Number(await readFile(pidFile, 'utf8')) };
}

test('stop() kills a process-group member that ignores SIGTERM after the server itself exits', async t => {
  const { server, leader, helper } = await fakeCheckout(t);
  assert.ok(alive(helper));
  await server.stop(500);
  assert.ok(await gone(leader), 'server process');
  assert.ok(await gone(helper), 'SIGTERM-ignoring helper');
});

test('stop() still clears the process group when the server already died on its own', async t => {
  const { server, leader, helper } = await fakeCheckout(t);
  const exited = new Promise(resolveExit => server.child.once('exit', resolveExit));
  process.kill(leader, 'SIGKILL');
  await exited;
  assert.ok(alive(helper));
  await server.stop(500);
  assert.ok(await gone(helper), 'SIGTERM-ignoring helper');
});
