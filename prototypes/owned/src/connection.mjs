import { createHash, randomUUID } from 'node:crypto';
import { JoshTransport } from './transport.mjs';

export const host = { name: 'owned-allen-prototype', version: '0.1.0' };
/** What this host asks JOSH for. JOSH grants the lower of each and its own ceiling (32 programs, 1,024 executions). */
export const limits = Object.freeze({ max_frame_bytes: 1048576, max_active_requests: 64, max_loaded_programs: 1,
  max_total_executions: 1, max_catalog_tools: 1, max_catalog_bytes: 1048576 });
const sourceBundle = source => ({ format: 'source_bundle', files: [{ path: 'src/main.allen', encoding: 'utf8', content: source }] });

/**
 * One `josh serve` process: handshaken once with a frozen tool catalog, then used for `program/check`,
 * or attached to one run at a time (JOSH allows one active execution per connection). Loaded programs
 * are cached by source sha256, so a connection that runs the same program again skips `program/load`.
 * Frames that belong to no attached execution are dropped and logged.
 *
 * `release({ clean })` hands the connection back through `onRelease` when the owner pools connections;
 * without one (the one-shot default) a release always closes it.
 */
export class JoshConnection {
  constructor({ tools, limits: requested = {}, projectionId = `projection-${randomUUID()}`, onRelease = null, log = message => console.warn(message) }) {
    // JOSH takes the catalog sorted by name bytes.
    this.tools = [...tools].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))); this.onRelease = onRelease; this.log = log;
    this.run = null; this.programs = 0; this.executions = 0; this.cache = new Map(); this.checks = 0; this.handshaken = false;
    this.closed = false; this.failure = null; this.onClose = null;
    this.transport = new JoshTransport({
      onRequest: frame => {
        const run = this.run;
        if (run && frame.params?.execution_id === run.executionId) return run.onRequest(frame);
        this.stray(frame);
      },
      onNotification: frame => {
        const run = this.run;
        // Cancels name a wire request id, which only the attached run can match to its own effects.
        if (run && (frame.kind === 'cancel' || frame.params?.execution_id === undefined || frame.params.execution_id === run.executionId)) run.onNotification(frame);
        else this.stray(frame);
      },
      onFailure: error => {
        this.failure = error; this.closed = true;
        const run = this.run; this.run = null;
        run?.onFailure(error);
        this.onClose?.(this, error);
      },
    });
    this.pid = this.transport.child.pid;
    // Settles once the process has exited and its output is drained (its stderr tail is complete).
    this.exited = new Promise(resolveExit => this.transport.child.once('close', () => resolveExit()));
    this.ready = this.handshake({ ...limits, ...requested, max_catalog_tools: Math.max(1, this.tools.length) }, projectionId);
    // The handshake keeps Node running; a connection that is then idle does not.
    this.ready.then(() => { this.handshaken = true; this.refresh(); }, () => {});
  }
  /** Opens a connection and waits for its handshake. */
  static async open(options) {
    const connection = new JoshConnection(options);
    try { await connection.ready; } catch (error) { connection.retire(); throw error; }
    return connection;
  }
  async handshake(negotiated, projectionId) {
    await this.transport.ready;
    const initialized = await this.transport.request('initialize', { host, protocol_versions: ['josh/1.8'], language_versions: ['>=0.1.0, <0.2.0'],
      execution_mode: 'unattended', invoking_session_id: null, standard_capabilities: [], limits: negotiated, extensions: [] });
    this.limits = initialized?.limits ?? negotiated;
    const metadata = { source: host.name, source_revision: host.version, observed_at_unix_ms: Date.now(), freshness: 'current', complete: true };
    await this.transport.request('host/project', { profile: 'josh.host-projection/0.1', projection_id: projectionId,
      host, session_binding: 'none', sections: ['tools', 'resources', 'attachments', 'transcript', 'models', 'user_interaction', 'agents', 'roots', 'permissions', 'telemetry'].map(kind => ({
        kind, ...metadata, item_count: kind === 'tools' ? this.tools.length : 0 })) });
    await this.transport.request('catalog/set', { schema_dialect: 'https://json-schema.org/draft/2020-12/schema', metadata, tools: this.tools });
  }
  /** `program/load`, cached by source: `{ program_id, artifact_digest, required_tools, debug, cached }`. */
  async load(source) {
    const key = createHash('sha256').update(source).digest('hex');
    const known = this.cache.get(key);
    if (known) return { ...known, cached: true };
    const loaded = await this.transport.request('program/load', sourceBundle(source));
    this.programs++;
    const { program_id, artifact_digest, required_tools, debug } = loaded;
    this.cache.set(key, { program_id, artifact_digest, required_tools, debug });
    return { program_id, artifact_digest, required_tools, debug, cached: false };
  }
  /** `program/check`: compiles and verifies without loading. */
  async check(source) {
    this.checks++; this.refresh();
    try { return await this.transport.request('program/check', sourceBundle(source)); }
    finally { this.checks--; this.refresh(); }
  }
  /** Routes this connection's requests, notifications and failure to one run: `{ executionId, onRequest, onNotification, onFailure }`. */
  attach(run) {
    if (this.run) throw new Error('JOSH connection is already attached to a run');
    if (this.closed) { run.onFailure(this.failure ?? new Error('JOSH connection closed')); return this; }
    this.run = run; this.refresh();
    return this;
  }
  detach() { if (this.run) { this.run = null; this.refresh(); } }
  /** `execution/start`; resolves with the execution's result. Its request id is kept for `cancel()`. */
  async start(params) {
    this.executions++;
    for (let attempt = 1; ; attempt++) {
      const result = this.transport.request('execution/start', params);
      this.executionRequest = this.transport.lastRequestId;
      try { return await result; } catch (error) {
        // JOSH sends an execution's result just before it frees the connection's execution slot, so
        // a start sent at once on a reused connection can find the slot still taken. It is refused
        // with nothing started, and sent again.
        if (error.wire?.code !== 'request.invalid_state' || this.executions === 1 || attempt > 3 || this.closed) throw error;
        await new Promise(resolveDelay => setTimeout(resolveDelay, 20 * attempt));
      }
    }
  }
  /** Asks JOSH to cancel a request (by default the running execution). */
  cancel(requestId = this.executionRequest) { if (!this.closed && requestId) this.transport.send({ kind: 'cancel', id: requestId }); }
  encode(message) { return this.transport.encode(message); }
  write(frame) { this.transport.write(frame); }
  /**
   * The attached run is done with this connection. `clean` means JOSH finished the execution (its
   * `execution/start` result arrived), so the connection can serve another run; anything else retires it.
   */
  release({ clean = false } = {}) {
    this.detach();
    if (this.closed) return;
    if (this.onRelease) this.onRelease(this, { clean });
    else this.retire();
  }
  retire() {
    this.detach();
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
    this.onClose?.(this, null);
  }
  /**
   * A connection keeps Node running during its handshake, a check, or a run; an idle one does not
   * (`josh serve` exits with Node, when its input closes).
   */
  refresh() {
    if (this.closed) return;
    const busy = !this.handshaken || this.run !== null || this.checks > 0;
    const { child } = this.transport;
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) busy ? handle?.ref?.() : handle?.unref?.();
  }
  stray(frame) {
    this.log(`JOSH ${this.pid}: dropped a ${frame.kind}${frame.method ? ` ${frame.method}` : ''} for ${frame.params?.execution_id ?? 'no execution'}${this.run ? ` while attached to ${this.run.executionId}` : ''}`);
  }
}
