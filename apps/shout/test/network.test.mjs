import test from 'node:test';
import assert from 'node:assert/strict';
import { requestUrl, accessUrls } from '../src/network.mjs';
import { startServer } from '../src/server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { get } from 'node:http';

const status = (url, headers) => new Promise((resolveStatus, reject) => {
  get(url, { headers }, response => { response.resume(); resolveStatus(response.statusCode); }).on('error', reject);
});

test('LAN and Tailscale hosts permit same-origin requests without weakening foreign-host protection', () => {
  const hosts = new Set(['192.168.1.20', '100.64.0.20', 'desktop.tailnet.ts.net', 'fd7a:115c:a1e0::1']);
  for (const host of ['192.168.1.20', '100.64.0.20', 'desktop.tailnet.ts.net', '[fd7a:115c:a1e0::1]']) {
    const origin = `http://${host}:4310`;
    assert.equal(requestUrl({ url: '/api/config', headers: { host: `${host}:4310`, origin } }, hosts, 4310).origin, origin);
  }
  for (const [host, origin, url] of [
    ['evil.example:4310', null, '/api/config'],
    ['192.168.1.20:4310', 'https://evil.example', '/api/config'],
    ['192.168.1.20:9999', null, '/api/config'],
    ['192.168.1.20:4310', null, 'http://evil.example/api/config'],
    ['192.168.1.20:4310@evil.example', null, '/api/config'],
  ]) assert.throws(() => requestUrl({ url, headers: { host, ...(origin ? { origin } : {}) } }, hosts, 4310));
  assert.ok(accessUrls(hosts, 4310, '0.0.0.0').includes('http://desktop.tailnet.ts.net:4310'));
});

test('server defaults to all IPv4 interfaces and accepts an allowed network hostname', async t => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'shout-network-'));
  const app = await startServer({ port: 0, stateRoot, allowedHosts: new Set(['127.0.0.1', 'desktop.tailnet.ts.net']), checkProvider: async () => ({ available: false }) });
  t.after(async () => { await app.close(); await rm(stateRoot, { recursive: true, force: true }); });
  assert.equal(app.server.address().address, '0.0.0.0');
  const port = app.server.address().port;
  const headers = { Host: `desktop.tailnet.ts.net:${port}`, Origin: `http://desktop.tailnet.ts.net:${port}` };
  assert.equal(await status(`${app.url}/api/config`, headers), 200);
  assert.equal(await status(`${app.url}/api/config`, { Host: `evil.example:${port}` }), 403);
});
