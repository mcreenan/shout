import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function joshBinary() {
  if (process.env.JOSH_BIN) return process.env.JOSH_BIN;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const git = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const binary = resolve(dirname(git), '.cache/josh-allen/target/debug/josh');
  if (!existsSync(binary)) throw new Error('JOSH missing. Run bash tools/setup-josh.sh from the repository root, or set JOSH_BIN.');
  return binary;
}

export class JoshTransport {
  constructor({ onRequest, onNotification, onFailure }) {
    this.pending = new Map(); this.nextId = 0; this.buffer = Buffer.alloc(0); this.closed = false;
    this.child = spawn(joshBinary(), ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.ready.catch(() => {});
    this.fail = error => {
      if (this.closed) return;
      this.closed = true; this.readyReject(error);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear(); this.child.kill('SIGKILL'); onFailure(error);
    };
    this.child.on('error', this.fail);
    this.child.stdin.on('error', this.fail);
    this.child.on('exit', code => { if (!this.closed) this.fail(new Error(`JOSH exited unexpectedly (${code})`)); });
    // Drain diagnostics, retain a bounded tail for local troubleshooting without flooding traces.
    this.diagnostics = '';
    this.child.stderr.on('data', chunk => { this.diagnostics = (this.diagnostics + chunk).slice(-8192); });
    this.child.stdout.on('data', chunk => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end === -1) { if (this.buffer.length > 8192) throw new Error('Oversize JOSH header'); break; }
          const header = this.buffer.subarray(0, end).toString('ascii');
          const match = /^Content-Length: ([1-9][0-9]*)\r\nContent-Type: application\/josh\+json; charset=utf-8$/.exec(header);
          if (!match || Number(match[1]) > 1048576) throw new Error('Invalid JOSH frame');
          const length = Number(match[1]);
          if (this.buffer.length < end + 4 + length) break;
          const frame = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString('utf8'));
          this.buffer = this.buffer.subarray(end + 4 + length);
          if (frame.protocol !== 'josh/1') throw new Error('Invalid JOSH protocol');
          if (frame.kind === 'notification') {
            if (frame.method === 'runtime/ready') this.readyResolve(frame.params);
            else onNotification(frame);
          } else if (frame.kind === 'response') {
            const pending = this.pending.get(frame.id);
            if (!pending) throw new Error('Unknown JOSH response');
            this.pending.delete(frame.id);
            if (frame.error) pending.reject(new Error(JSON.stringify(frame.error)));
            else pending.resolve(frame.result);
          } else if (frame.kind === 'request') {
            Promise.resolve(onRequest(frame)).catch(this.fail);
          } else if (frame.kind === 'cancel') {
            // Runtime cancellation owns the effect; kernel aborts its matching provider.
            onNotification(frame);
          } else throw new Error('Unknown JOSH message kind');
        }
      } catch (error) { this.fail(error); }
    });
  }
  send(message) {
    if (this.closed) throw new Error('JOSH connection closed');
    const body = Buffer.from(JSON.stringify({ protocol: 'josh/1', ...message }));
    if (body.length > 1048576) throw new Error('JOSH request exceeds frame limit');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/josh+json; charset=utf-8\r\n\r\n`), body]));
  }
  request(method, params) {
    const id = `host-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ kind: 'request', id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyReject(new Error('JOSH closed'));
    for (const pending of this.pending.values()) pending.reject(new Error('JOSH closed'));
    this.pending.clear(); this.child.stdin.end(); this.child.kill('SIGTERM');
    const kill = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 300);
    kill.unref();
  }
}
