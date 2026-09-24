import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JoshTransport } from './transport.mjs';
import { callbackSchema, validate, record, textField, chatSchema } from './schema.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = { name: 'owned-allen-prototype', version: '0.1.0' };
const limits = { max_frame_bytes: 1048576, max_active_requests: 64, max_loaded_programs: 1,
  max_total_executions: 1, max_catalog_tools: 1, max_catalog_bytes: 1048576 };
const tool = { name: 'review_draft', version: '1.0.0', description: 'Write one synthetic review draft into this run scratch directory. No external issue is changed.',
  input_schema: record({ ticket_id: textField, reason: textField }), output_schema: record({ text: textField }),
  error_schema: record({ message: textField }), effects: [], idempotency: 'non_idempotent' };
const terminal = state => ['completed', 'failed', 'cancelled', 'stopped', 'interrupted'].includes(state);

export class Run extends EventEmitter {
  constructor({ provider, source, input, scratchRoot, wallMs = 180000 }) {
    super();
    this.id = `run-${randomUUID()}`; this.state = 'starting'; this.provider = provider;
    this.source = source; this.input = input; this.wallMs = wallMs;
    this.scratch = resolve(scratchRoot, this.id); this.effects = new Map(); this.events = [];
    this.counters = { modelJudgments: 0, nativeToolCalls: 0, userQuestions: 0, providerRequests: 0, automaticProviderReplies: 0, deterministicTransitions: 0, modelForwardingEnvelopes: 0 };
    this.abort = new AbortController();
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
  }
  event(type, detail = {}) {
    const event = { sequence: this.events.length + 1, time: new Date().toISOString(), run: this.id, type, ...detail };
    this.events.push(event); this.counters.deterministicTransitions++;
    this.emit('event', event); return event;
  }
  snapshot() {
    return { id: this.id, state: this.state, counters: { ...this.counters }, pending: [...this.effects.values()].map(e => ({
      id: e.id, method: e.method, state: e.state, ...(e.method === 'user/ask' ? { prompt: e.params.prompt, schema: e.schema } : {})
    })), ...(this.result ? { result: this.result } : {}) };
  }
  async start() {
    this.event('run.started', { sourceBytes: Buffer.byteLength(this.source) });
    this.timer = setTimeout(() => this.finish('failed', { outcome: 'failed', error: 'Host wall-time budget expired' }), this.wallMs);
    try {
      await mkdir(this.scratch, { recursive: true });
      if (terminal(this.state)) return;
      this.transport = new JoshTransport({ onRequest: frame => this.dispatch(frame),
        onNotification: frame => {
          if (terminal(this.state)) return;
          if (frame.kind === 'cancel') {
            const effect = this.effects.get(`${this.id}:${frame.id}`);
            if (effect) { effect.abort.abort(); this.effects.delete(effect.id); this.event('effect.cancelled', { id: effect.id }); }
          } else this.event('vm.event', { method: frame.method, detail: frame.params });
        }, onFailure: error => this.finish('interrupted', { outcome: 'interrupted', error: error.message }) });
      await this.transport.ready;
      await this.transport.request('initialize', { host, protocol_versions: ['josh/1.6'], language_versions: ['>=0.1.0, <0.2.0'],
        execution_mode: 'unattended', invoking_session_id: null, standard_capabilities: [], limits, extensions: [] });
      const metadata = { source: host.name, source_revision: host.version, observed_at_unix_ms: Date.now(), freshness: 'current', complete: true };
      await this.transport.request('host/project', { profile: 'josh.host-projection/0.1', projection_id: this.id,
        host, session_binding: 'none', sections: ['tools', 'resources', 'attachments', 'transcript', 'models', 'user_interaction', 'agents', 'roots', 'permissions', 'telemetry'].map(kind => ({
          kind, ...metadata, item_count: kind === 'tools' ? 1 : 0 })) });
      await this.transport.request('catalog/set', { schema_dialect: 'https://json-schema.org/draft/2020-12/schema', metadata, tools: [tool] });
      const loaded = await this.transport.request('program/load', { format: 'source_bundle', files: [{ path: 'src/main.allen', encoding: 'utf8', content: this.source }] });
      if (!Array.isArray(loaded.required_tools) || loaded.required_tools.some(name => name !== tool.name)) throw new Error('Program requests an unauthorized tool');
      this.state = 'running'; this.event('program.loaded', { artifactDigest: loaded.artifact_digest, tools: loaded.required_tools });
      const result = await this.transport.request('execution/start', { execution_id: this.id, program_id: loaded.program_id,
        artifact_digest: loaded.artifact_digest, entry: 'main', input: this.input, working_directory: null,
        granted_capabilities: [], granted_tools: loaded.required_tools, allowed_http_origins: [], granted_exec: [], granted_exec_environment: [], limits: { wall_ms: this.wallMs } });
      const state = result.outcome === 'completed' ? 'completed' : result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'stopped' ? 'stopped' : 'failed';
      this.finish(state, result);
    } catch (error) { this.finish('failed', { outcome: 'failed', error: error.message }); }
  }
  async dispatch(frame) {
    if (terminal(this.state)) return;
    const { id: wireId, method, params } = frame;
    if (params.execution_id !== this.id) throw new Error('Cross-execution provider request');
    const id = `${this.id}:${wireId}`;
    if (this.effects.has(id)) throw new Error('Duplicate provider request');
    const effect = { id, wireId, method, params, state: 'pending', abort: new AbortController() };
    this.effects.set(id, effect); this.counters.providerRequests++;
    this.event('effect.requested', { id, method });
    try {
      if (method === 'model/request') {
        if (this.counters.modelJudgments >= 3) throw new Error('Model judgment budget exhausted (3 per run)');
        this.counters.modelJudgments++; effect.schema = callbackSchema(params.response_schema.descriptor);
        this.event('model.started', { id, prompt: params.prompt });
        const value = await this.provider.judge({ prompt: params.prompt, schema: effect.schema, signal: effect.abort.signal,
          onEvent: detail => { if (!terminal(this.state)) this.event('model.worker', detail); } });
        if (!this.isPending(effect)) return;
        validate(effect.schema, value);
        this.event('model.completed', { id, value }); this.respond(effect, { value });
      } else if (method === 'tool/invoke') {
        if (params.tool !== tool.name) throw new Error('Unknown host tool');
        validate(tool.input_schema, params.input);
        if (this.counters.nativeToolCalls >= 16) throw new Error('Native tool budget exhausted (16 per run)');
        this.counters.nativeToolCalls++;
        const text = `Review ${params.input.ticket_id}: ${params.input.reason}`;
        await writeFile(resolve(this.scratch, `draft-${createHash('sha256').update(effect.id).digest('hex').slice(0, 16)}.txt`), text + '\n', { flag: 'wx', mode: 0o600 });
        if (!this.isPending(effect)) return;
        this.event('tool.completed', { id, tool: tool.name, artifact: resolve(this.scratch, `draft-${createHash('sha256').update(effect.id).digest('hex').slice(0, 16)}.txt`) });
        this.respond(effect, { outcome: 'ok', value: { text } });
      } else if (method === 'user/ask') {
        effect.schema = callbackSchema(params.response_schema.descriptor);
        if (this.counters.userQuestions >= 8) throw new Error('User question budget exhausted (8 per run)');
        this.counters.userQuestions++; this.state = 'waiting_user';
        this.event('user.question', { id, prompt: params.prompt, schema: effect.schema });
      } else {
        this.rejectEffect(effect, `${method.split('/')[0] === 'agent' ? 'agent' : 'request'}.${method.startsWith('agent/') ? 'unavailable' : 'method_not_found'}`, 'Provider not implemented by this prototype');
      }
    } catch (error) {
      if (this.isPending(effect)) {
        this.event('effect.failed', { id, message: error.message });
        // Provider failures fail this run. No guessed values and no silent fallback.
        this.finish('failed', { outcome: 'failed', error: error.message });
      }
    }
  }
  isPending(effect) { return !terminal(this.state) && this.effects.get(effect.id) === effect && !effect.abort.signal.aborted; }
  respond(effect, result) {
    if (!this.isPending(effect)) return;
    this.effects.delete(effect.id); this.counters.automaticProviderReplies++;
    this.transport.send({ kind: 'response', id: effect.wireId, result });
    this.state = [...this.effects.values()].some(e => e.method === 'user/ask') ? 'waiting_user' : 'running';
    this.event('effect.resolved', { id: effect.id, method: effect.method });
  }
  rejectEffect(effect, code, message) {
    if (!this.isPending(effect)) return;
    this.effects.delete(effect.id);
    this.transport.send({ kind: 'response', id: effect.wireId, error: { code, message } });
    this.event('effect.rejected', { id: effect.id, code });
  }
  answer(id, value, origin = 'user') {
    const effect = this.effects.get(id);
    if (!effect || effect.method !== 'user/ask' || !this.isPending(effect)) throw new Error('Unknown, expired, duplicate, or cross-run question ID');
    validate(effect.schema, value);
    this.event('user.answered', { id, origin, value }); this.respond(effect, { value });
  }
  cancel() {
    if (terminal(this.state)) return this.snapshot();
    this.finish('cancelled', { outcome: 'cancelled', reason: 'Cancelled by session owner' });
    return this.snapshot();
  }
  finish(state, result) {
    if (terminal(this.state)) return;
    this.state = state; this.result = result; clearTimeout(this.timer); this.abort.abort();
    for (const effect of this.effects.values()) effect.abort.abort();
    this.effects.clear(); this.transport?.close();
    this.event('run.terminal', { state, result, counters: { ...this.counters } });
    this.resolveDone(this.snapshot());
  }
}

export class Session extends EventEmitter {
  constructor({ provider, scratchRoot = resolve(packageRoot, '.scratch'), wallMs } = {}) {
    super(); this.id = `session-${randomUUID()}`; this.provider = provider; this.scratchRoot = scratchRoot; this.wallMs = wallMs;
    this.runs = new Map(); this.history = []; this.chatCalls = 0; this.chat = null; this.generation = 0; this.closed = false;
  }
  start({ source, input = null }) {
    if (this.closed) throw new Error('Session closed');
    if (typeof source !== 'string' || Buffer.byteLength(source) > 65536) throw new Error('Source must be at most 64 KiB');
    if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error('Input must be at most 64 KiB');
    if ([...this.runs.values()].some(run => !terminal(run.state))) throw new Error('One active run per session in this prototype');
    const run = new Run({ provider: this.provider, source, input, scratchRoot: this.scratchRoot, wallMs: this.wallMs });
    this.runs.set(run.id, run); this.active = run;
    run.on('event', event => this.emit('event', event));
    run.done.then(result => { this.history.push({ role: 'tool', content: { run: run.id, result } }); });
    void run.start(); return run;
  }
  async runFile(path, inputPath) {
    const generation = this.generation;
    const source = await readFile(resolve(path), 'utf8');
    const input = inputPath ? JSON.parse(await readFile(resolve(inputPath), 'utf8')) : null;
    if (generation !== this.generation || this.closed) throw new Error('Program launch cancelled');
    return this.start({ source, input });
  }
  async review(goal) {
    const generation = this.generation;
    const source = await readFile(resolve(packageRoot, 'fixtures/review.allen'), 'utf8');
    const input = JSON.parse(await readFile(resolve(packageRoot, 'fixtures/review.json'), 'utf8'));
    if (generation !== this.generation || this.closed) throw new Error('Review launch cancelled');
    if (goal) input.goal = goal;
    return this.start({ source, input });
  }
  status() {
    return { session: this.id, chat: this.chat ? 'thinking' : 'idle', chatCalls: this.chatCalls,
      historyMessages: this.history.length, runs: [...this.runs.values()].map(run => run.snapshot()) };
  }
  cancel() {
    this.generation++;
    this.chat?.abort(); this.chat = null;
    return this.active?.cancel() ?? this.status();
  }
  answer(id, value, origin) {
    const run = [...this.runs.values()].find(run => id.startsWith(`${run.id}:`));
    if (!run) throw new Error('Unknown question ID');
    run.answer(id, value, origin);
  }
  async message(text) {
    if (this.closed) throw new Error('Session closed');
    if (this.chat) throw new Error('A chat decision is already running; /status and /cancel remain available');
    this.history.push({ role: 'user', content: text });
    const controller = new AbortController(); this.chat = controller; this.chatCalls++;
    this.emit('event', { type: 'chat.started', session: this.id });
    try {
      const value = await this.provider.judge({ schema: chatSchema, signal: controller.signal,
        prompt: { system: 'You are the chat component of a small ALLEN harness. Choose action review only when the user asks to review/triage the supplied synthetic tickets or execute the registered review workflow. Choose reply for conversation, explanation or status questions. Your text is a concise human response. You cannot perform other actions. The harness deterministically routes the chosen action. Never invent task completion. Status is supplied below.',
          context: { tag: 'Some', value: this.status() }, data: { tag: 'Some', value: this.history.slice(-12) } },
        onEvent: detail => this.emit('event', { type: 'chat.worker', ...detail }) });
      if (controller.signal.aborted) throw new Error('Chat cancelled');
      validate(chatSchema, value); this.history.push({ role: 'assistant', content: value.text });
      this.emit('event', { type: 'chat.reply', ...value });
      if (value.action === 'review') {
        if (this.active && !terminal(this.active.state)) throw new Error('A run is already active; answer or cancel it first');
        return { ...value, run: (await this.review(text)).id };
      }
      return value;
    } finally { if (this.chat === controller) this.chat = null; }
  }
  close() { this.closed = true; this.cancel(); }
}
