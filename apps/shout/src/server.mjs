import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore, appRoot } from './session.mjs';
import { scenarios } from './workspace.mjs';
import { listDirectories } from './projects.mjs';
import { commands } from './skills.mjs';
import { providers, models, efforts, defaultModel, modelInfo } from './models.mjs';
import { claudeBinary } from './claude-agent.mjs';
import { networkHosts, requestUrl, accessUrls } from './network.mjs';

const exec = promisify(execFile);
async function codexStatus() {
  try {
    const binary = process.env.CODEX_BIN || 'codex';
    const { stdout } = await exec(binary, ['--version'], { timeout: 5000 });
    const version = stdout.trim();
    if (version !== 'codex-cli 0.157.1') return { available: false, version, error: 'The verified model adapter requires Codex CLI 0.157.1.' };
    await exec(binary, ['login', 'status'], { timeout: 5000 });
    return { available: true, version, error: null };
  } catch { return { available: false, version: null, error: 'Sign in with the supported Codex CLI (codex login) to use Codex models.' }; }
}
async function claudeStatus() {
  const error = 'Sign in to Claude Code (claude auth login) to use Claude models.';
  const binary = claudeBinary();
  if (!binary) return { available: false, version: null, error: 'Claude Code is missing: run npm install, or set CLAUDE_BIN.' };
  try {
    const [version, auth] = await Promise.all([['--version'], ['auth', 'status']].map(async args => (await exec(binary, args, { timeout: 15000 })).stdout.trim()));
    return JSON.parse(auth).loggedIn === true ? { available: true, version, error: null } : { available: false, version, error };
  } catch { return { available: false, version: null, error }; }
}
async function modelStatus() { const [codex, claude] = await Promise.all([codexStatus(), claudeStatus()]); return { codex, claude }; }
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
const eventStream = response => response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
/**
 * Writes one server-sent event stream. Every event carries the whole state (a snapshot, the sidebar list), so
 * while a client is not reading only the latest is kept, rendered and sent once it drains; memory stays at
 * one event per client. A client that stays behind for `stallMs` is disconnected.
 */
function eventWriter(response, stallMs) {
  let latest = null; let stall = null;
  const open = () => !response.writableEnded && !response.destroyed;
  // Writing past the buffer starts the clock; the client has until it drains.
  const write = text => { if (!response.write(text)) stall ??= setTimeout(() => response.destroy(), stallMs); };
  const send = render => {
    if (!open()) return;
    if (response.writableNeedDrain) latest = render; else write(render());
  };
  response.on('drain', () => { clearTimeout(stall); stall = null; const render = latest; latest = null; if (render) send(render); });
  response.on('close', () => { clearTimeout(stall); latest = null; });
  return { send, beat: () => { if (open() && !response.writableNeedDrain) write(': heartbeat\n\n'); } };
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Expected application/json');
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 65536) throw new Error('Request exceeds 64 KiB'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value;
}

export async function startServer({ port = Number(process.env.PORT || 4310), host = process.env.SHOUT_HOST || '0.0.0.0', allowedHosts, stateRoot = process.env.SHOUT_STATE_DIR, defaultWorkspace = process.env.SHOUT_WORKSPACE || process.cwd(), providerFactory, agent, checkProvider = modelStatus, streamStallMs = 60_000 } = {}) {
  const hosts = allowedHosts ?? await networkHosts();
  // Per provider ({ codex, claude }); a single status applies to every provider.
  const checked = await checkProvider();
  const status = providers.map(item => ({ ...item, ...(('available' in checked ? checked : checked[item.id]) ?? { available: false, version: null, error: `${item.label} was not checked` }) }));
  const available = status.filter(item => item.available);
  // `provider` summarises them for older clients: available when any provider is.
  const provider = { available: available.length > 0, version: available[0]?.version ?? null, error: available.length ? null : status.map(item => item.error).filter(Boolean).join(' ') || 'No model provider is available.' };
  const providerOf = model => status.find(item => item.id === modelInfo(model)?.provider);
  const requireProvider = model => { const item = providerOf(model); if (item && !item.available) throw new Error(`${item.label} is unavailable. ${item.error ?? ''}`.trim()); };
  // New sessions start on the default model, or on the first model whose provider is available.
  const fallback = models.find(item => providerOf(item.id).available);
  const sessionDefault = providerOf(defaultModel.model).available || !fallback ? defaultModel : { model: fallback.id, effort: fallback.efforts.includes(defaultModel.effort) ? defaultModel.effort : fallback.efforts[0] };
  // A project's default model applies to its new threads while that model's provider is available.
  const store = await new SessionStore({ stateRoot, defaultWorkspace, providerFactory, agent, defaultModel: sessionDefault, modelAvailable: model => Boolean(providerOf(model)?.available) }).init();
  // Built-in programs shown by the Program view before a session has runs.
  const workflows = await Promise.all(['code.allen', 'test.allen'].map(async name => ({ name, source: await readFile(resolve(appRoot, 'skills', name), 'utf8') })));
  const streams = new Set();
  // The sidebar's stream (/api/stream): projects and thread summaries on connect, then after changes at most
  // every 100 ms, to each client only when they differ from what it last got.
  const lists = new Map(); let listTimer = null; let closing = false;
  const listState = () => JSON.stringify({ projects: store.projectList(), sessions: store.list() });
  const sendState = (response, state) => { const list = lists.get(response); if (list && list.state !== state) { list.state = state; list.stream.send(() => `event: state\ndata: ${state}\n\n`); } };
  store.on('change', () => {
    if (lists.size) listTimer ??= setTimeout(() => { listTimer = null; const state = listState(); for (const response of lists.keys()) sendState(response, state); }, 100);
  });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    // A kept-alive connection can still send a request while the server stops.
    if (closing) { response.setHeader('Connection', 'close'); return json(response, 503, { error: 'SHOUT is stopping' }); }
    try {
      let url;
      try { url = requestUrl(request, hosts, server.address().port); }
      catch (error) { return json(response, 403, { error: error.message }); }
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers['x-shout-client'] !== '1') return json(response, 403, { error: 'Missing SHOUT client header' });
      if (url.pathname === '/api/config' && request.method === 'GET') return json(response, 200, { cwd: process.cwd(), home: homedir(), stateDir: store.stateRoot, defaultWorkspace: store.defaultWorkspace, provider, providers: status, scenarios, workflows, models, efforts, defaultModel: sessionDefault });
      if (url.pathname === '/api/stream' && request.method === 'GET') {
        eventStream(response); const stream = eventWriter(response, streamStallMs);
        lists.set(response, { state: null, stream }); sendState(response, listState());
        const heartbeat = setInterval(stream.beat, 15000);
        response.on('close', () => { clearInterval(heartbeat); lists.delete(response); });
        return;
      }
      if (url.pathname === '/api/fs/dirs' && request.method === 'GET') return json(response, 200, await listDirectories(url.searchParams.get('path') || '~'));
      if (url.pathname === '/api/projects') {
        if (request.method === 'GET') return json(response, 200, store.projectList());
        if (request.method === 'POST') { const { project, existing } = await store.addProject(await body(request)); return json(response, existing ? 200 : 201, { ...store.projectInfo(project), existing }); }
      }
      const projectMatch = /^\/api\/projects\/(project-[a-f0-9-]+)$/.exec(url.pathname);
      if (projectMatch && request.method === 'POST') return json(response, 200, store.projectInfo(await store.updateProject(projectMatch[1], await body(request))));
      if (projectMatch && request.method === 'DELETE') return json(response, 200, await store.removeProject(projectMatch[1]));
      if (url.pathname === '/api/sessions') {
        if (request.method === 'GET') return json(response, 200, store.list());
        if (request.method === 'POST') {
          const input = await body(request);
          if (!provider.available) throw new Error(provider.error);
          if (input.model !== undefined) requireProvider(input.model);
          // An empty thread already waiting in the project comes back (200) instead of a new one (201).
          const { session, reused } = await store.newThread(input); return json(response, reused ? 200 : 201, session.snapshot());
        }
      }
      const skillMatch = /^\/api\/sessions\/(session-[a-f0-9-]+)\/skills(?:\/([a-z][a-z0-9-]*))?$/.exec(url.pathname);
      if (skillMatch && request.method === 'GET') {
        const session = store.get(skillMatch[1]);
        const strip = ({ entry: _entry, ...skill }) => skill;
        if (!skillMatch[2]) {
          const skills = (await store.skills.list(session.data.workspace)).map(strip);
          return json(response, 200, { skills: [...skills, ...commands.map(command => ({ ...command, scope: 'command', ok: true, diagnostics: [], capabilities: [], tools: [] }))] });
        }
        const skill = await store.skills.find(session.data.workspace, skillMatch[2], { withSource: true });
        if (!skill) return json(response, 404, { error: 'Skill not found' });
        return json(response, 200, strip(skill));
      }
      const match = /^\/api\/sessions\/(session-[a-f0-9-]+)(?:\/(messages|answer|cancel|budget|sleep|model|title|events|export|files|file))?$/.exec(url.pathname);
      if (match) {
        if (request.method === 'DELETE' && !match[2]) return json(response, 200, await store.delete(match[1]));
        const session = store.get(match[1]); const action = match[2];
        if (request.method === 'GET') {
          if (!action || action === 'export') {
            if (action === 'export') response.setHeader('Content-Disposition', `attachment; filename="shout-${session.data.id}.json"`);
            return json(response, 200, session.snapshot());
          }
          if (action === 'files') return json(response, 200, { files: session.data.unavailable ? [] : await session.workspace.list() });
          if (action === 'file') { const path = url.searchParams.get('path'); return json(response, 200, { path, content: await session.workspace.read(path) }); }
          if (action === 'events') {
            eventStream(response); const stream = eventWriter(response, streamStallMs);
            const send = snapshot => stream.send(() => `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
            const heartbeat = setInterval(stream.beat, 15000);
            const stop = () => { clearInterval(heartbeat); session.off('snapshot', send); session.off('deleted', deleted); streams.delete(response); };
            // A deleted thread's stream says so and ends, so the client doesn't reconnect.
            const deleted = ({ id }) => { stop(); response.end(`event: deleted\ndata: ${JSON.stringify({ id })}\n\n`); };
            send(session.snapshot()); session.on('snapshot', send); session.on('deleted', deleted); streams.add(response);
            request.on('close', stop);
            return;
          }
        }
        if (request.method === 'POST') {
          const input = await body(request);
          // A thread whose folder is gone reports that (from send) before any provider problem.
          if (action === 'messages') { if (!session.data.unavailable) requireProvider(session.data.model); return json(response, 202, store.send(session.data.id, input.text)); }
          if (action === 'answer') return json(response, 200, session.answer(input.id, input.value));
          if (action === 'cancel') return json(response, 200, session.cancel());
          if (action === 'budget') return json(response, 200, session.setTimeBudgets(input.enabled));
          if (action === 'sleep') return json(response, 200, session.setSleeping(input.sleeping));
          if (action === 'title') return json(response, 200, session.setTitle(input.title));
          if (action === 'model') { if (input.model !== session.data.model) requireProvider(input.model); return json(response, 200, session.setModel(input)); }
        }
      }
      if (request.method !== 'GET') return json(response, 404, { error: 'Route not found' });
      // Flat, fixed-extension names only: no path separators or dotfiles reach the filesystem.
      const file = url.pathname === '/' ? 'index.html' : url.pathname === '/styles.css' ? 'style.css' : /^\/([a-z0-9][a-z0-9-]*\.(?:html|js|css|png))$/.exec(url.pathname)?.[1];
      if (!file) return json(response, 404, { error: 'Route not found' });
      let bytes;
      try { bytes = await readFile(resolve(appRoot, 'public', file)); }
      catch { return json(response, 404, { error: 'Route not found' }); }
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[extname(file)], 'Cache-Control': 'no-cache' }); response.end(bytes);
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error.code === 'workspace_missing') return json(response, 409, { error: error.message, code: error.code, path: error.path });
      if (error.code === 'busy') return json(response, 409, { error: error.message, code: error.code });
      json(response, /not found/i.test(error.message) ? 404 : 400, { error: error.message });
    }
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, host, resolveReady); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const endStreams = () => { for (const stream of [...streams, ...lists.keys()]) stream.end(); streams.clear(); lists.clear(); clearTimeout(listTimer); };
  // Stopping: no new connections or requests, open streams end, sessions close, then any connection left is closed.
  // `suspend` (a signal or a desktop disconnect, so a restart) suspends running programs to resume on the next
  // start; otherwise they are cancelled.
  const close = async ({ suspend = false } = {}) => {
    closing = true;
    const stopped = new Promise(resolveClosed => server.close(resolveClosed));
    endStreams(); await (suspend ? store.suspend() : store.close()); endStreams(); server.closeAllConnections();
    await stopped;
  };
  return { server, store, url, urls: accessUrls(hosts, server.address().port, host), close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer();
  console.log(`\nSHOUT is running. Open one of these addresses:\n${app.urls.map(url => `  ${url}`).join('\n')}\nCtrl+C stops the app.\n`);
  let stopping = false;
  // A stop is usually a restart (watch mode, the service, the desktop app), so running programs suspend and resume on the next start.
  const stop = async () => { if (stopping) return; stopping = true; await app.close({ suspend: true }); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  // A launcher with an IPC channel (the desktop app) learns the bound URLs, and SHOUT stops if that launcher goes away.
  if (process.send) { process.send({ type: 'ready', url: app.url, urls: app.urls }); process.on('disconnect', stop); }
}
