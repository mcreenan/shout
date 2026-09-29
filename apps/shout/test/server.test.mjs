import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from '../src/server.mjs';
import { ScriptedAgent } from './doubles.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
const within = (promise, ms, what) => Promise.race([promise, delay(ms).then(() => { throw new Error(`${what} took longer than ${ms} ms`); })]);
async function serve(t, options = {}) {
  const dir = await realpath(await mkdtemp(resolve(tmpdir(), 'shout-server-')));
  const app = await startServer({ port: 0, allowedHosts: new Set(['127.0.0.1']), stateRoot: dir, defaultWorkspace: dir, agent: new ScriptedAgent(), checkProvider: async () => ({ available: true, version: 'test' }), ...options });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { app, dir, close: async () => { closed = true; await app.close(); } };
}
// Opens an event stream, reads until the first event, then stops reading. `resume()` reads to the end; `text()` is what arrived.
function stalledStream(url) {
  return new Promise((resolveStream, reject) => {
    const chunks = [];
    const request = get(url, response => {
      response.once('data', chunk => { chunks.push(chunk); response.pause(); resolveStream({ request, response, resume: () => response.resume(), text: () => Buffer.concat(chunks).toString('utf8') }); });
      response.on('data', chunk => { if (chunks.length) chunks.push(chunk); });
    });
    request.on('error', reject);
  });
}

test('an event stream client that stops reading gets the latest snapshot when it resumes, not every one in between', async t => {
  const { app } = await serve(t);
  const session = await app.store.create({});
  const stream = await stalledStream(`${app.url}/api/sessions/${session.data.id}/events`);
  t.after(() => stream.request.destroy());
  session.data.filler = 'x'.repeat(256 * 1024);
  for (let index = 0; index < 200; index++) { session.data.marker = index; session.emit('snapshot', session.snapshot()); }
  stream.resume();
  await within((async () => { while (!stream.text().includes('"marker":199')) await delay(20); })(), 20000, 'the latest snapshot');
  const received = stream.text().split('event: snapshot').length - 1;
  assert.ok(received < 60, `${received} snapshots were sent to a client that had stopped reading`);
});

test('a stream client that stays stalled is disconnected', async t => {
  const { app } = await serve(t, { streamStallMs: 200 });
  const session = await app.store.create({});
  const stream = await stalledStream(`${app.url}/api/sessions/${session.data.id}/events`);
  t.after(() => stream.request.destroy());
  const connections = () => new Promise(resolveCount => app.server.getConnections((_, count) => resolveCount(count)));
  assert.equal(await connections(), 1);
  // Activity continues until the socket buffers are full and nothing drains any more.
  session.data.filler = 'x'.repeat(512 * 1024);
  await within((async () => { for (let index = 0; await connections() > 0; index++) { session.data.marker = index; session.emit('snapshot', session.snapshot()); await delay(25); } })(), 6000, 'disconnecting the stalled client');
});

test('shutdown stops accepting first, so a stream opened while the store closes cannot hold it open', async t => {
  const { app, close } = await serve(t);
  const early = new AbortController(); t.after(() => early.abort());
  const opened = await fetch(`${app.url}/api/stream`, { signal: early.signal });
  assert.equal(opened.status, 200);
  const storeClose = app.store.close.bind(app.store);
  let cleaning; const started = new Promise(r => { cleaning = r; });
  app.store.close = async () => { cleaning(); await delay(300); return storeClose(); };
  const closing = close();
  await started;
  const late = new AbortController(); t.after(() => late.abort());
  const status = await fetch(`${app.url}/api/stream`, { signal: late.signal }).then(response => response.status, () => 'refused');
  assert.notEqual(status, 200, 'no new stream opens during shutdown');
  await within(closing, 5000, 'shutdown');
  const reader = opened.body.getReader();
  await within((async () => { while (!(await reader.read()).done); })(), 2000, 'ending the stream opened before shutdown');
});
