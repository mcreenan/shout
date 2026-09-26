import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore, appRoot } from './session.mjs';
import { scenarios } from './workspace.mjs';

const exec = promisify(execFile);
async function modelStatus() {
  try {
    const binary = process.env.CODEX_BIN || 'codex';
    const { stdout } = await exec(binary, ['--version'], { timeout: 5000 });
    const version = stdout.trim();
    if (version !== 'codex-cli 0.153.3') return { available: false, version, error: 'The verified model adapter requires Codex CLI 0.153.3.' };
    await exec(binary, ['login', 'status'], { timeout: 5000 });
    return { available: true, version, error: null };
  } catch { return { available: false, version: null, error: 'Sign in with the supported Codex CLI to use live models. Guided demo mode works offline.' }; }
}
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 65536) throw new Error('Request exceeds 64 KiB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function startServer({ port = Number(process.env.PORT || 4310), stateRoot = process.env.SHOUT_STATE_DIR, defaultWorkspace = process.env.SHOUT_WORKSPACE || process.cwd(), providerFactory, checkProvider = modelStatus } = {}) {
  const store = await new SessionStore({ stateRoot, defaultWorkspace, providerFactory }).init();
  const provider = await checkProvider();
  const streams = new Set();
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(response, 403, { error: 'SHOUT accepts local requests only' });
      const url = new URL(request.url, `http://${host}`);
      if (request.headers.origin && request.headers.origin !== url.origin) return json(response, 403, { error: 'Cross-origin requests are not allowed' });
      if (request.method === 'POST' && request.headers['x-shout-client'] !== '1') return json(response, 403, { error: 'Missing SHOUT client header' });
      if (url.pathname === '/api/config' && request.method === 'GET') return json(response, 200, { cwd: process.cwd(), defaultWorkspace: store.defaultWorkspace, provider, scenarios });
      if (url.pathname === '/api/sessions') {
        if (request.method === 'GET') return json(response, 200, store.list());
        if (request.method === 'POST') {
          const input = await body(request);
          if ((input.mode ?? 'live') === 'live' && !provider.available) throw new Error(provider.error);
          const session = await store.create(input); return json(response, 201, session.snapshot());
        }
      }
      const match = /^\/api\/sessions\/(session-[a-f0-9-]+)(?:\/(messages|answer|cancel|events|export|files|file))?$/.exec(url.pathname);
      if (match) {
        const session = store.get(match[1]); const action = match[2];
        if (request.method === 'GET') {
          if (!action || action === 'export') {
            if (action === 'export') response.setHeader('Content-Disposition', `attachment; filename="shout-${session.data.id}.json"`);
            return json(response, 200, session.snapshot());
          }
          if (action === 'files') return json(response, 200, { files: await session.workspace.list() });
          if (action === 'file') { const path = url.searchParams.get('path'); return json(response, 200, { path, content: await session.workspace.read(path) }); }
          if (action === 'events') {
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            const send = snapshot => { if (!response.destroyed) response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`); };
            send(session.snapshot()); session.on('snapshot', send); streams.add(response);
            const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
            request.on('close', () => { clearInterval(heartbeat); session.off('snapshot', send); streams.delete(response); });
            return;
          }
        }
        if (request.method === 'POST') {
          const input = await body(request);
          if (action === 'messages') return json(response, 202, store.send(session.data.id, input.text));
          if (action === 'answer') return json(response, 200, session.answer(input.id, input.value));
          if (action === 'cancel') return json(response, 200, session.cancel());
        }
      }
      if (request.method !== 'GET') return json(response, 404, { error: 'Route not found' });
      const files = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/styles.css': 'style.css' };
      const file = files[url.pathname];
      if (!file) return json(response, 404, { error: 'Route not found' });
      const bytes = await readFile(resolve(appRoot, 'public', file));
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] + '; charset=utf-8', 'Cache-Control': 'no-cache' }); response.end(bytes);
    } catch (error) { if (!response.headersSent) json(response, /not found/i.test(error.message) ? 404 : 400, { error: error.message }); else response.end(); }
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, store, url, async close() { for (const stream of streams) stream.end(); await store.close(); await new Promise(resolveClosed => server.close(resolveClosed)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  console.log(`\nSHOUT is running at ${app.url}\nOpen that address in your browser. Ctrl+C stops the app.\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
