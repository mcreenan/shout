import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { accessSync, constants, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');
const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
// A local server needs the SHOUT checkout around apps/desktop; the standalone client bundle has none.
export const localServerAvailable = existsSync(join(repoRoot, 'tools/start-gui.sh')) && existsSync(join(repoRoot, 'apps/shout/src/server.mjs')) && resolve(repoRoot, 'apps/desktop') === resolve(here, '..');

// Settings resolve like the server's own: the real environment wins over the repo .env that start-gui.sh loads.
export function readSettings(env = process.env, root = localServerAvailable ? repoRoot : null) {
  let file = {};
  if (root) try { file = parseEnv(readFileSync(join(root, '.env'), 'utf8')); } catch { /* .env is optional */ }
  return name => env[name] ?? file[name];
}

// The window always talks to the server over loopback unless SHOUT is bound to one specific address.
export const connectHost = bind => !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind.includes(':') ? `[${bind}]` : bind;

// Accepts what people paste ("host", "host:4310", "http://host:4310/#session-…") and returns the http(s) origin.
// SHOUT only serves from the root of its host, so path, query and fragment are dropped.
export function normalizeServerUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('Enter the address of a SHOUT server, for example http://my-computer:4310');
  if (raw.length > 2048) throw new Error('That address is too long');
  const schemeless = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try { url = new URL(schemeless ? `http://${raw}` : raw); } catch { throw new Error(`"${raw.slice(0, 200)}" is not a valid address`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// server addresses are supported');
  if (url.username || url.password) throw new Error('Server addresses cannot contain a user name or password');
  if (!url.hostname) throw new Error('The address needs a host name');
  // A bare host name means SHOUT's default port. URL drops a scheme's own default ("host:80" has port ''), so an
  // explicit port is read from what was typed.
  const explicitPort = /^(?:\[[^\]]*\]|[^/?#:[\]]*):\d+(?:[/?#]|$)/.test(raw);
  if (schemeless && !explicitPort) url.port = '4310';
  return url.origin;
}

const reasons = {
  ECONNREFUSED: 'Nothing is accepting connections at this address. Is SHOUT running there?',
  ENOTFOUND: 'The host name could not be found.', EAI_AGAIN: 'The host name could not be looked up (DNS is unavailable).',
  EHOSTUNREACH: 'The host is unreachable from this computer.', ENETUNREACH: 'The network is unreachable from this computer.',
  ECONNRESET: 'The connection was reset.', ETIMEDOUT: 'The connection timed out.',
};

// state is 'shout' when a SHOUT server answers, 'free' when nothing listens, 'busy' when something else answers or the check fails;
// error explains a failure in words a person can act on.
export async function check(origin, timeout = 2000) {
  let response;
  try { response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(timeout), redirect: 'error', headers: { accept: 'application/json' } }); }
  catch (error) {
    const code = error.cause?.code ?? error.name;
    const reason = reasons[code] ?? (code === 'TimeoutError' || code === 'AbortError' ? `The server did not answer within ${timeout / 1000} s.`
      : error.cause?.message === 'bad port' ? 'Browsers block this port for safety; run SHOUT on another port.' : error.cause?.message || error.message);
    return { state: code === 'ECONNREFUSED' ? 'free' : 'busy', error: reason };
  }
  const config = await response.json().catch(() => null);
  if (response.ok && Array.isArray(config?.scenarios) && typeof config?.provider === 'object' && 'defaultWorkspace' in config) return { state: 'shout', error: '', config };
  if (response.status === 403 && /host/i.test(config?.error ?? '')) return { state: 'busy', error: 'SHOUT refused this host name. Use an address the server accepts (its LAN or Tailscale IP or name), or add this one to SHOUT_ALLOWED_HOSTS on the server.' };
  return { state: 'busy', error: `This address answered, but not as a SHOUT server (HTTP ${response.status}${config?.error ? `: ${String(config.error).slice(0, 200)}` : ''}).` };
}
export const probe = async (origin, timeout) => (await check(origin, timeout)).state;

// The server spawns CLIs and SDKs that expect a real Node, never Electron's embedded one.
export function findNode(env = process.env) {
  const version = path => { try { return execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  for (const path of (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'node')).filter(executable)) {
    const found = version(path); if (/^v\d+\./.test(found ?? '')) return { path, version: found };
  }
  try {
    const path = execFileSync('mise', ['which', 'node'], { encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const found = path && version(path); if (/^v\d+\./.test(found ?? '')) return { path, version: found };
  } catch { /* mise is optional */ }
  return null;
}

// Undo what Electron adds to its own environment so the server sees the user's session unchanged.
export function serverEnv(env, node) {
  const next = { ...env, PATH: [dirname(node.path), env.PATH].filter(Boolean).join(delimiter) };
  if (next.ORIGINAL_XDG_CURRENT_DESKTOP) next.XDG_CURRENT_DESKTOP = next.ORIGINAL_XDG_CURRENT_DESKTOP;
  for (const key of ['ORIGINAL_XDG_CURRENT_DESKTOP', 'CHROME_DESKTOP', 'EGL_PLATFORM', 'FC_FONTATIONS', 'ELECTRON_RUN_AS_NODE', 'SHOUT_WATCH', 'PORT']) delete next[key];
  return next;
}

// One SHOUT server started through tools/start-gui.sh, so dependency checks, JOSH_BIN and .env stay in one place.
// It reports its bound URLs over the IPC channel and stops by itself if this process disappears.
export class OwnedServer extends EventEmitter {
  constructor({ env, port, logFile, root = repoRoot, echo = true }) {
    super(); Object.assign(this, { env, port, logFile, root, echo }); this.child = null; this.ready = false; this.tail = [];
  }

  start() {
    const log = this.logFile ? createWriteStream(this.logFile, { flags: 'a' }) : null;
    log?.on('error', () => {}); log?.write(`\n--- ${new Date().toISOString()} starting SHOUT on port ${this.port || 'auto'}\n`);
    const child = this.child = spawn('bash', [join(this.root, 'tools/start-gui.sh')], { cwd: this.root, env: { ...this.env, PORT: String(this.port) }, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.pgid = child.pid; // detached: the server leads its own process group, which can outlive it
    for (const [stream, echo] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let partial = '';
      stream.on('data', chunk => {
        log?.write(chunk); if (this.echo) try { echo.write(chunk); } catch { /* no terminal attached */ }
        const lines = (partial + chunk).split(/\r?\n|\r/); partial = lines.pop();
        for (const line of lines.map(text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()).filter(Boolean)) {
          this.tail.push(line); if (this.tail.length > 40) this.tail.shift(); this.emit('line', line);
        }
      });
    }
    return new Promise((resolveReady, reject) => {
      child.on('message', message => {
        if (this.ready || message?.type !== 'ready' || typeof message.url !== 'string') return;
        this.ready = true; this.url = message.url; this.urls = Array.isArray(message.urls) ? message.urls.filter(url => typeof url === 'string') : [];
        resolveReady({ url: this.url, urls: this.urls });
      });
      child.once('error', error => { error.output = this.tail.join('\n'); reject(error); });
      child.once('exit', (code, signal) => {
        this.child = null; log?.end(`--- exited (${signal || code})\n`);
        if (!this.ready) return reject(Object.assign(new Error(`The SHOUT server exited (${signal || `code ${code}`}) before it was ready.`), { output: this.tail.join('\n') }));
        if (!this.stopping) this.emit('crash', { code, signal });
      });
    });
  }

  // SIGTERM lets the server close sessions. The process group is then cleared on its own terms, because setup steps
  // and agent CLIs can outlive the server (or ignore SIGTERM): SIGTERM, a grace period, then SIGKILL.
  async stop(timeout = 5000) {
    const child = this.child, group = this.pgid; this.stopping = true;
    if (!group) return;
    if (child) {
      const exited = once(child, 'exit');
      signal(this.ready ? child.pid : -group, 'SIGTERM');
      if (await Promise.race([exited.then(() => false), delay(timeout).then(() => true)])) { signal(-group, 'SIGKILL'); await exited; }
    }
    signal(-group, 'SIGTERM');
    for (const end = Date.now() + Math.min(timeout, 2000); groupAlive(group) && Date.now() < end;) await delay(100);
    if (groupAlive(group)) signal(-group, 'SIGKILL');
  }
}

const signal = (target, name) => { try { process.kill(target, name); } catch { /* already gone */ } };
const groupAlive = group => { try { process.kill(-group, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
