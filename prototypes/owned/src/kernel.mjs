import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { JoshTransport } from './transport.mjs';
import { callbackCodec, validate, schemaErrors, SchemaRejection, record, textField, chatSchema } from './schema.mjs';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = { name: 'owned-allen-prototype', version: '0.1.0' };
const limits = { max_frame_bytes: 1048576, max_active_requests: 64, max_loaded_programs: 1,
  max_total_executions: 1, max_catalog_tools: 1, max_catalog_bytes: 1048576 };
const tool = { name: 'review_draft', version: '1.0.0', description: 'Write one synthetic review draft into this run scratch directory. No external issue is changed.',
  input_schema: record({ ticket_id: textField, reason: textField }), output_schema: record({ text: textField }),
  error_schema: record({ message: textField }), effects: [], idempotency: 'non_idempotent' };
/** Thrown by a tool handler to return the tool's declared `{ message }` error to the program. */
export class ToolError extends Error {}
// Leaves room for the response envelope inside the negotiated max_frame_bytes.
const maxToolResultBytes = limits.max_frame_bytes - 64 * 1024;
const terminal = state => ['completed', 'failed', 'cancelled', 'stopped', 'interrupted'].includes(state);
// JOSH sends at most 16 validation issues with 256-byte paths; the events keep the same bound.
const boundedIssues = issues => (Array.isArray(issues) ? issues : []).slice(0, 16)
  .map(issue => ({ path: String(issue?.path ?? '').slice(0, 256), code: String(issue?.code ?? '').slice(0, 64) }));
// Sent to JOSH for an answer that is not JSON at all. It decodes as no ALLEN type (no record field
// or enum tag starts with $, and Bytes is exactly {"$bytes": ...}), so JOSH rejects it and re-asks.
const UNPARSEABLE = Object.freeze({ $unparseable: true });
/**
 * The answer inside a provider failure that only means the answer was invalid: a SchemaRejection
 * of the callback schema, or of a provider's {value} envelope around it, or an error with
 * code 'invalid_answer' (UNPARSEABLE when it has no value). Anything else is not an answer (null).
 */
function rejectedAnswer(error, schema) {
  if (error instanceof SchemaRejection) {
    if (error.schema === schema) return error.value;
    const envelope = error.value;
    return envelope !== null && typeof envelope === 'object' && 'value' in envelope ? envelope.value : UNPARSEABLE;
  }
  if (error?.code === 'invalid_answer') return 'value' in error ? error.value : UNPARSEABLE;
  return null;
}
// `{ span }` at an effect's source site (from its origin), in the shape of a runtime error's span; else {}.
const siteSpan = origin => {
  const site = origin?.site;
  if (!site || typeof site !== 'object' || !Number.isInteger(site.line)) return {};
  return { span: Object.fromEntries(['source', 'start', 'end', 'line', 'column', 'end_line', 'end_column'].filter(key => key in site).map(key => [key, site[key]])) };
};
const issueText = { type: 'wrong type', required: 'missing', unknown: 'not allowed here', range: 'out of range',
  fields: 'wrong set of fields', length: 'wrong number of items', encoding: 'not valid base64', tag: 'unknown variant tag',
  // The kernel sorts map entries into JOSH's key order, so an order issue is a repeated key.
  order: 'repeated key (map keys must be distinct)' };
// The model sees why its previous answer was rejected, as part of the instructions for this attempt.
function withRetryNote(prompt, attempt, issues, unparseable) {
  const reasons = unparseable ? ['- the answer was not a JSON value']
    : issues.map(issue => `- ${issue.path || '(the whole answer)'}: ${issueText[issue.code] ?? issue.code}`);
  return { ...prompt, system: `${prompt.system}\n\nThis is attempt ${attempt} of ${prompt.policy?.max_attempts ?? attempt}. `
    + `The previous answer was rejected because it does not match the required output type:\n${reasons.join('\n')}\n`
    + 'Answer again with a value that matches the output schema exactly.' };
}

export const DEFAULT_RUN_WALL_MS = 30 * 60 * 1000;

export class Run extends EventEmitter {
  constructor({ provider, source, input, scratchRoot, wallMs = DEFAULT_RUN_WALL_MS, tools = [tool], toolHandler, maxModelJudgments = 3, maxToolCalls = 16, maxUserQuestions = 8 }) {
    super();
    if (wallMs !== null && (!Number.isInteger(wallMs) || wallMs < 1 || wallMs > 2 * 60 * 60 * 1000)) throw new Error('Wall-time budget must be 1–7200000 ms or null');
    if (!Number.isInteger(maxModelJudgments) || maxModelJudgments < 0 || maxModelJudgments > 64) throw new Error('Model budget must be 0–64');
    if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > 256) throw new Error('Tool budget must be 0–256');
    if (!Number.isInteger(maxUserQuestions) || maxUserQuestions < 0 || maxUserQuestions > 64) throw new Error('Question budget must be 0–64');
    if (!Array.isArray(tools) || tools.length > 256) throw new Error('Invalid host tool catalog');
    this.tools = structuredClone(tools).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    this.toolMap = new Map();
    const validator = new Ajv({ strict: true, allErrors: true });
    for (const definition of this.tools) {
      if (typeof definition.name !== 'string' || !definition.name || this.toolMap.has(definition.name)) throw new Error('Invalid or duplicate tool name');
      for (const key of ['input_schema', 'output_schema', 'error_schema']) {
        if (!definition[key] || typeof definition[key] !== 'object') throw new Error(`Missing tool ${key}`);
        validator.compile(definition[key]);
      }
      this.toolMap.set(definition.name, definition);
    }
    if (toolHandler !== undefined && typeof toolHandler !== 'function') throw new Error('Tool handler must be a function');
    if (this.tools.some(definition => definition.name !== tool.name) && !toolHandler) throw new Error('Custom tools require a tool handler');
    this.toolHandler = toolHandler; this.maxModelJudgments = maxModelJudgments; this.maxToolCalls = maxToolCalls; this.maxUserQuestions = maxUserQuestions;
    this.id = `run-${randomUUID()}`; this.state = 'starting'; this.provider = provider;
    this.source = source; this.input = input; this.wallMs = wallMs;
    this.scratch = resolve(scratchRoot, this.id); this.effects = new Map(); this.events = [];
    // interaction_id -> the effect of its latest attempt, to link JOSH's re-asks to rejected answers.
    this.interactions = new Map();
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
    if (this.started) throw new Error('A run may start only once');
    this.started = true;
    this.event('run.started', { sourceBytes: Buffer.byteLength(this.source), wallMs: this.wallMs });
    this.timer = this.wallMs === null ? null : setTimeout(() => this.finish('failed', {
      outcome: 'failed', error: `Host wall-time budget expired after ${this.wallMs} ms (${this.wallMs / 1000} seconds)`,
    }), this.wallMs);
    try {
      await mkdir(this.scratch, { recursive: true });
      if (terminal(this.state)) return;
      this.transport = new JoshTransport({ onRequest: frame => this.dispatch(frame),
        onNotification: frame => {
          if (terminal(this.state)) return;
          if (frame.kind === 'cancel') {
            const effect = this.effects.get(`${this.id}:${frame.id}`);
            if (effect) {
              effect.abort.abort(); this.effects.delete(effect.id); this.settleState();
              this.event('effect.cancelled', { id: effect.id });
            }
          } else this.event('vm.event', { method: frame.method, detail: frame.params });
        }, onFailure: error => this.finish('interrupted', { outcome: 'interrupted', error: error.message }) });
      await this.transport.ready;
      await this.transport.request('initialize', { host, protocol_versions: ['josh/1.8'], language_versions: ['>=0.1.0, <0.2.0'],
        execution_mode: 'unattended', invoking_session_id: null, standard_capabilities: [], limits: { ...limits, max_catalog_tools: Math.max(1, this.tools.length) }, extensions: [] });
      const metadata = { source: host.name, source_revision: host.version, observed_at_unix_ms: Date.now(), freshness: 'current', complete: true };
      await this.transport.request('host/project', { profile: 'josh.host-projection/0.1', projection_id: this.id,
        host, session_binding: 'none', sections: ['tools', 'resources', 'attachments', 'transcript', 'models', 'user_interaction', 'agents', 'roots', 'permissions', 'telemetry'].map(kind => ({
          kind, ...metadata, item_count: kind === 'tools' ? this.tools.length : 0 })) });
      await this.transport.request('catalog/set', { schema_dialect: 'https://json-schema.org/draft/2020-12/schema', metadata, tools: this.tools });
      const loaded = await this.transport.request('program/load', { format: 'source_bundle', files: [{ path: 'src/main.allen', encoding: 'utf8', content: this.source }] });
      if (!Array.isArray(loaded.required_tools) || loaded.required_tools.some(name => !this.toolMap.has(name))) throw new Error('Program requests an unauthorized tool');
      // With debug information JOSH also returns the program's static construct and effect-site
      // tables; `origin.scope[].construct` and `origin.site.id` refer to them.
      const tables = loaded.debug ? { sites: loaded.debug.effect_sites, constructs: loaded.debug.constructs } : {};
      this.state = 'running'; this.event('program.loaded', { artifactDigest: loaded.artifact_digest, tools: loaded.required_tools, ...tables });
      const result = await this.transport.request('execution/start', { execution_id: this.id, program_id: loaded.program_id,
        artifact_digest: loaded.artifact_digest, entry: 'main', input: this.input, working_directory: null,
        granted_capabilities: [], granted_tools: loaded.required_tools, allowed_http_origins: [], granted_exec: [], granted_exec_environment: [], limits: this.wallMs === null ? {} : { wall_ms: this.wallMs } });
      const state = result.outcome === 'completed' ? 'completed' : result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'stopped' ? 'stopped' : 'failed';
      this.finish(state, result);
    } catch (error) {
      // A source program that does not compile fails program/load with the compiler's diagnostics.
      const diagnostics = error.wire?.data?.diagnostics;
      if (Array.isArray(diagnostics) && diagnostics.length) {
        const shown = diagnostics.slice(0, 5).map(d => `${d.source}:${d.line}:${d.column}: error[${d.code}]: ${d.message}`);
        this.finish('failed', { outcome: 'failed', error: `Program does not compile:\n${shown.join('\n')}`, diagnostics });
      } else this.finish('failed', { outcome: 'failed', error: error.message });
    }
  }
  async dispatch(frame) {
    if (terminal(this.state)) return;
    const { id: wireId, method, params } = frame;
    if (params.execution_id !== this.id) throw new Error('Cross-execution provider request');
    const id = `${this.id}:${wireId}`;
    if (this.effects.has(id)) throw new Error('Duplicate provider request');
    const effect = { id, wireId, method, params, state: 'pending', abort: new AbortController() };
    this.effects.set(id, effect); this.counters.providerRequests++;
    // Where the effect came from: its source site, enclosing loops (with iterations), branches, calls and task.
    const origin = params.origin && typeof params.origin === 'object' ? { origin: params.origin } : {};
    // Typed responses: JOSH validates each answer itself and, while the prompt's max_attempts allows,
    // asks again with the same interaction_id, the next attempt and the validation issues.
    const typed = method === 'model/request' || method === 'user/ask';
    const attempt = typed && Number.isInteger(params.attempt) ? params.attempt : 1;
    const previous = typed && attempt > 1 ? this.interactions.get(params.interaction_id) : undefined;
    // Issue paths point into the rejected answer as it was given (the model shape), not JOSH's wire form.
    const wireIssues = typed && attempt > 1 ? boundedIssues(params.validation_issues) : [];
    const issues = previous?.codec ? previous.codec.modelIssues(wireIssues, previous.answer) : wireIssues;
    const retry = typed ? { interaction: params.interaction_id, attempt, ...(attempt > 1 ? { issues } : {}) } : {};
    if (typed) this.interactions.set(params.interaction_id, { id, attempt, unparseable: false });
    if (method === 'model/request' && previous) this.event('model.rejected', { id: previous.id, interaction: params.interaction_id, attempt: previous.attempt, issues });
    this.event('effect.requested', { id, method, ...origin, ...retry });
    try {
      if (method === 'model/request') {
        // Every attempt is one model judgment.
        if (this.counters.modelJudgments >= this.maxModelJudgments) throw new Error(`Model judgment budget exhausted (${this.maxModelJudgments} per run)`);
        this.counters.modelJudgments++; effect.codec = callbackCodec(params.response_schema.descriptor); effect.schema = effect.codec.schema;
        this.event('model.started', { id, prompt: params.prompt, ...origin, ...retry });
        const prompt = attempt > 1 ? withRetryNote(params.prompt, attempt, issues, previous?.unparseable) : params.prompt;
        let value;
        try {
          value = await this.provider.judge({ prompt, schema: effect.schema, signal: effect.abort.signal, attempt, issues,
            onEvent: detail => { if (!terminal(this.state)) this.event('model.worker', { ...detail, id }); } });
        } catch (error) {
          if (!this.isPending(effect)) return;
          value = rejectedAnswer(error, effect.schema);
          if (value === null) {
            // A refusal is JOSH's model.denied: the program's Err branch handles it. Transport
            // failures, timeouts and budgets still fail the run with their message.
            if (error?.code !== 'refusal') throw error;
            this.rejectEffect(effect, 'model.denied', error.message);
            return;
          }
        }
        if (!this.isPending(effect)) return;
        // JOSH is the authority on validity. An invalid answer is still sent, so that JOSH re-asks
        // with its validation issues or, after the last attempt, returns Err to the program.
        const unparseable = value === UNPARSEABLE || value === undefined;
        Object.assign(this.interactions.get(params.interaction_id), { unparseable, codec: effect.codec, answer: value });
        const valid = !unparseable && !schemaErrors(effect.schema, value);
        this.event('model.completed', { id, value: unparseable ? null : value, ...(valid ? {} : { valid: false }) });
        this.respond(effect, { value: unparseable ? UNPARSEABLE : effect.codec.toWire(value) });
      } else if (method === 'tool/invoke') {
        const definition = this.toolMap.get(params.tool);
        if (!definition) throw new Error('Unknown host tool');
        validate(definition.input_schema, params.input);
        if (this.counters.nativeToolCalls >= this.maxToolCalls) throw new Error(`Native tool budget exhausted (${this.maxToolCalls} per run)`);
        this.counters.nativeToolCalls++;
        this.event('tool.started', { id, tool: params.tool, input: params.input, ...origin });
        let value; let artifact;
        if (this.toolHandler) {
          try { value = await this.toolHandler(params.tool, params.input, { signal: effect.abort.signal, effectId: id }); }
          catch (error) {
            // A declared tool error is ordinary program data (the generated Error.Declared
            // variant); any other handler failure still fails the run.
            if (!(error instanceof ToolError) || !this.isPending(effect)) throw error;
            const declared = { message: error.message.slice(0, 2048) || 'Tool failed' };
            validate(definition.error_schema, declared);
            this.event('tool.failed', { id, tool: params.tool, error: declared });
            this.respond(effect, { outcome: 'error', error: declared });
            return;
          }
        } else {
          const text = `Review ${params.input.ticket_id}: ${params.input.reason}`;
          artifact = resolve(this.scratch, `draft-${createHash('sha256').update(effect.id).digest('hex').slice(0, 16)}.txt`);
          await writeFile(artifact, text + '\n', { flag: 'wx', mode: 0o600 });
          value = { text };
        }
        if (!this.isPending(effect)) return;
        validate(definition.output_schema, value);
        // A result that cannot fit one JOSH frame would stall the transport; return it as the
        // tool's declared error when the tool has the common { message } error contract.
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (bytes > maxToolResultBytes) {
          const declared = { message: `Tool result too large (${bytes} bytes; limit ${maxToolResultBytes}). Request less data.` };
          if (!new Ajv({ strict: true }).validate(definition.error_schema, declared)) throw new Error(declared.message);
          this.event('tool.failed', { id, tool: params.tool, error: declared });
          this.respond(effect, { outcome: 'error', error: declared });
          return;
        }
        this.event('tool.completed', { id, tool: params.tool, value, ...(artifact ? { artifact } : {}) });
        this.respond(effect, { outcome: 'ok', value });
      } else if (method === 'user/ask') {
        effect.codec = callbackCodec(params.response_schema.descriptor); effect.schema = effect.codec.schema;
        if (this.counters.userQuestions >= this.maxUserQuestions) throw new Error(`User question budget exhausted (${this.maxUserQuestions} per run)`);
        this.counters.userQuestions++; this.state = 'waiting_user';
        this.event('user.question', { id, prompt: params.prompt, schema: effect.schema, ...origin, ...retry });
      } else {
        this.rejectEffect(effect, `${method.split('/')[0] === 'agent' ? 'agent' : 'request'}.${method.startsWith('agent/') ? 'unavailable' : 'method_not_found'}`, 'Provider not implemented by this prototype');
      }
    } catch (error) {
      if (this.isPending(effect)) {
        this.event('effect.failed', { id, message: error.message });
        // Provider failures fail this run. No guessed values and no silent fallback. The span is the
        // effect's source site, like a trap's error span.
        this.finish('failed', { outcome: 'failed', error: error.message, ...siteSpan(params.origin) });
      }
    }
  }
  isPending(effect) { return !terminal(this.state) && this.effects.get(effect.id) === effect && !effect.abort.signal.aborted; }
  // While any question is open the run waits for its user.
  settleState() {
    if (!terminal(this.state)) this.state = [...this.effects.values()].some(e => e.method === 'user/ask') ? 'waiting_user' : 'running';
  }
  // The response frame is encoded before the effect leaves the pending set. One that cannot be
  // sent (larger than a JOSH frame) throws with the effect still pending: dispatch then fails the
  // run, and answer() leaves the question open for another answer.
  respond(effect, result) {
    if (!this.isPending(effect)) return;
    this.commit(effect, this.transport.encode({ kind: 'response', id: effect.wireId, result }));
  }
  commit(effect, frame) {
    this.effects.delete(effect.id); this.counters.automaticProviderReplies++;
    this.transport.write(frame);
    this.settleState();
    this.event('effect.resolved', { id: effect.id, method: effect.method });
  }
  rejectEffect(effect, code, message) {
    if (!this.isPending(effect)) return;
    const text = String(message).slice(0, 1024);
    const frame = this.transport.encode({ kind: 'response', id: effect.wireId, error: { code, message: text } });
    this.effects.delete(effect.id);
    this.transport.write(frame);
    this.event('effect.rejected', { id: effect.id, code, message: text });
  }
  answer(id, value, origin = 'user') {
    const effect = this.effects.get(id);
    if (!effect || effect.method !== 'user/ask' || !this.isPending(effect)) throw new Error('Unknown, expired, duplicate, or cross-run question ID');
    // The form's answer must match the schema here, so the user corrects it at once instead of
    // being asked again by JOSH.
    validate(effect.schema, value);
    let frame;
    try { frame = this.transport.encode({ kind: 'response', id: effect.wireId, result: { value: effect.codec ? effect.codec.toWire(value) : value } }); }
    catch (error) { throw new Error(`Answer not sent: ${error.message}. The question is still open.`); }
    const interaction = this.interactions.get(effect.params.interaction_id);
    if (interaction) Object.assign(interaction, { codec: effect.codec, answer: value });
    this.event('user.answered', { id, origin, value }); this.commit(effect, frame);
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
