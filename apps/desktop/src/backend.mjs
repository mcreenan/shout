import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { accessSync, constants, createWriteStream, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

// Settings resolve like the server's own: the real environment wins over the repo .env that start-gui.sh loads.
export function readSettings(env = process.env, root = repoRoot) {
  let file = {};
  try { file = parseEnv(readFileSync(join(root, '.env'), 'utf8')); } catch { /* .env is optional */ }
  return name => env[name] ?? file[name];
}

// The window always talks to the server over loopback unless SHOUT is bound to one specific address.
export const connectHost = bind => !bind || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind.includes(':') ? `[${bind}]` : bind;

// 'shout' when a SHOUT server answers, 'free' when nothing listens, 'busy' when something else owns the port.
export async function probe(origin, timeout = 2000) {
  try {
    const response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    const config = await response.json().catch(() => null);
    return response.ok && Array.isArray(config?.scenarios) && typeof config?.provider === 'object' && 'defaultWorkspace' in config ? 'shout' : 'busy';
  } catch (error) { return error.cause?.code === 'ECONNREFUSED' ? 'free' : 'busy'; }
}

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

  // SIGTERM lets the server close sessions; the process group catches setup steps and leftover agent processes.
  async stop(timeout = 5000) {
    const child = this.child; if (!child) return; this.stopping = true;
    const exited = once(child, 'exit');
    const kill = (target, signal) => { try { process.kill(target, signal); } catch { /* already gone */ } };
    kill(this.ready ? child.pid : -child.pid, 'SIGTERM');
    if (await Promise.race([exited.then(() => false), delay(timeout).then(() => true)])) { kill(-child.pid, 'SIGKILL'); await exited; }
    kill(-child.pid, 'SIGTERM');
  }
}
