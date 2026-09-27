import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, symlink, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const VERSION = 'codex-cli 0.157.1';
// Codex features that would give the model tools of its own. SHOUT's agent only gets SHOUT's tools.
const DISABLED = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use',
  'image_generation', 'view_image', 'hooks', 'code_mode', 'code_mode_host', 'goals', 'memories'];

/**
 * SHOUT's conversational agent: one persistent `codex app-server` thread per session. The
 * instructions go in once, at thread start; each message after that is just the user's text,
 * and the thread carries the history. The model acts only through SHOUT's dynamic tools.
 *
 * Codex runs with its own CODEX_HOME under SHOUT's state directory, so the user's Codex
 * config, AGENTS.md, MCP servers and plugins never reach the thread. Only the login is shared.
 */
export class CodexAgent {
  constructor({ home, binary = process.env.CODEX_BIN || 'codex' }) {
    this.home = home; this.binary = binary;
    this.child = null; this.ready = null; this.nextId = 0;
    this.pending = new Map(); this.turns = new Map(); this.loaded = new Set();
  }
  async prepare() {
    const version = (await exec(this.binary, ['--version'], { timeout: 5000 })).stdout.trim();
    if (version !== VERSION) throw new Error(`SHOUT's agent requires ${VERSION}; found ${version}`);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const auth = resolve(this.home, 'auth.json');
    if (!(await lstat(auth).catch(() => null))) await symlink(resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'auth.json'), auth);
    await writeFile(resolve(this.home, 'config.toml'), '');
    // Bundled model metadata with Codex's own tools and code mode switched off, so dynamic tools are called directly.
    const catalog = JSON.parse((await exec(this.binary, ['debug', 'models', '--bundled'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4194304 })).stdout);
    for (const model of catalog.models) {
      Object.assign(model, { apply_patch_tool_type: null, experimental_supported_tools: [], shell_type: 'disabled', supports_search_tool: false });
      delete model.tool_mode;
    }
    const catalogPath = resolve(this.home, 'models.json');
    await writeFile(catalogPath, JSON.stringify(catalog));
    return catalogPath;
  }
  ensure() {
    this.ready ??= this.launch().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async launch() {
    const catalogPath = await this.prepare();
    // Codex's sandbox locks down its own tools (all off); its permissions note would tell the model it cannot write at all.
    const options = { approval_policy: 'never', web_search: 'disabled', 'apps._default.enabled': false, 'agents.enabled': false,
      'tools.experimental_request_user_input.enabled': false, 'tools.update_plan.enabled': false, 'skills.include_instructions': false,
      project_doc_max_bytes: 0, model_catalog_json: catalogPath, include_permissions_instructions: false };
    const args = ['app-server', '--strict-config', ...Object.entries(options).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
      ...DISABLED.flatMap(name => ['--disable', name])];
    const child = spawn(this.binary, args, { env: { ...process.env, CODEX_HOME: this.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.loaded = new Set();
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', line => { if (line.trim()) this.receive(line); });
    const stopped = error => {
      if (this.child !== child) return;
      this.child = null; this.ready = null;
      for (const { reject } of this.pending.values()) reject(error);
      for (const turn of this.turns.values()) turn.reject(error);
      this.pending.clear(); this.turns.clear();
    };
    child.on('error', error => stopped(new Error(`Codex app-server failed: ${error.message}`)));
    child.on('exit', code => stopped(new Error(`Codex app-server exited (${code ?? 'signal'})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`)));
    await this.request('initialize', { clientInfo: { name: 'shout', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.send({ method: 'initialized' });
  }
  send(message) { this.child?.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params) {
    if (!this.child) return Promise.reject(new Error('Codex app-server is not running'));
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => { this.pending.set(id, { resolve: resolveRequest, reject }); this.send({ id, method, params }); });
  }
  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message ?? JSON.stringify(message.error))); else pending?.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    const turn = this.turns.get(params.threadId);
    if (message.id !== undefined) {
      if (message.method === 'item/tool/call' && turn) return void this.toolCall(message.id, params, turn);
      return this.send({ id: message.id, error: { code: -32601, message: `SHOUT does not handle ${message.method}` } });
    }
    if (!turn) return;
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.text) turn.onEvent({ type: 'message', text: params.item.text, phase: params.item.phase });
    else if (message.method === 'thread/tokenUsage/updated') turn.onEvent({ type: 'usage', usage: params.tokenUsage?.last });
    else if (message.method === 'error' && !params.willRetry) turn.error = params.error?.message;
    else if (message.method === 'turn/completed') {
      this.turns.delete(params.threadId);
      const { status, error } = params.turn;
      if (status === 'failed') turn.reject(new Error(error?.message || turn.error || 'The model turn failed'));
      else turn.resolve({ status });
    }
  }
  async toolCall(id, { tool, arguments: input }, turn) {
    let text; let success = true;
    try { text = await turn.onToolCall({ tool, input: input ?? {} }); }
    catch (error) { text = error.message; success = false; }
    this.send({ id, result: { success, contentItems: [{ type: 'inputText', text: String(text) }] } });
  }
  /** Starts a thread with the instructions it keeps for its lifetime. Returns the thread ID. */
  async startThread({ cwd, instructions, context, tools }) {
    await this.ensure();
    const { thread } = await this.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: false,
      baseInstructions: instructions, developerInstructions: context,
      dynamicTools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) });
    this.loaded.add(thread.id);
    return thread.id;
  }
  /**
   * Sends one user message to the thread and resolves when the model's turn ends. Tool calls go
   * to `onToolCall({ tool, input })`, which returns the result text (a thrown error is a failed call).
   * `model` and `effort` override the thread's model for this turn and the turns after it. The `thread`
   * option (the startThread arguments, which ClaudeAgent needs on every turn) is ignored: Codex keeps them with the thread.
   */
  async turn(threadId, text, { onToolCall, onEvent = () => {}, signal, model, effort }) {
    await this.ensure();
    // After an app or app-server restart the thread (history and tools) is reloaded from disk.
    if (!this.loaded.has(threadId)) { await this.request('thread/resume', { threadId, excludeTurns: true }); this.loaded.add(threadId); }
    signal?.throwIfAborted();
    if (this.turns.has(threadId)) throw new Error('This thread already has a turn in progress');
    return new Promise((resolveTurn, reject) => {
      const turn = { onToolCall, onEvent, id: null, error: null,
        resolve: value => { signal?.removeEventListener('abort', abort); resolveTurn(value); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); } };
      const abort = () => { if (turn.id) void this.request('turn/interrupt', { threadId, turnId: turn.id }).catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      this.turns.set(threadId, turn);
      this.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
        .then(({ turn: started }) => { turn.id = started.id; if (signal?.aborted) abort(); })
        .catch(error => { this.turns.delete(threadId); turn.reject(error); });
    });
  }
  close() { const child = this.child; this.child = null; this.ready = null; child?.kill(); }
}
