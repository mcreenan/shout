import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { query as sdkQuery, tool, createSdkMcpServer, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { settlesWithin } from './agent.mjs';

const require = createRequire(import.meta.url);
const SERVER = 'shout';
// Claude Code features that would put anything besides SHOUT's instructions and tools in front of the model.
// (Claude Code still adds its environment note and a reminder with the account email and date; nothing turns those off.)
// MCP_NO_PREFIX gives SHOUT's tools their own names, as the instructions use them.
const ISOLATION_ENV = { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false', ENABLE_TOOL_SEARCH: 'false', CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1', CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'shout/0.1.0' };
// switchModelsOnFlag: a flagged request ends in a refusal instead of continuing on another model.
const ISOLATION_SETTINGS = { switchModelsOnFlag: false, disableClaudeAiConnectors: true, disableBundledSkills: true, autoMemoryEnabled: false,
  enabledPlugins: { 'agents-md@builtin': false } };
const bare = name => name.replace(/^mcp__.+?__/, '');

/** The Claude Code CLI the SDK drives: CLAUDE_BIN, else the build pinned by the SDK package. Either uses the normal `claude` login. */
export function claudeBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  for (const libc of ['', '-musl']) {
    try { return require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/claude${process.platform === 'win32' ? '.exe' : ''}`); } catch {}
  }
  return null;
}

/**
 * Query options every SHOUT call to Claude shares: none of Claude Code's own tools, and none of the
 * user's settings, CLAUDE.md or AGENTS.md files, memory, hooks, plugins, skills or MCP servers.
 * The login in the user's Claude config directory is used as it is.
 */
export function isolatedOptions({ binary, cwd, model, effort }) {
  const env = { ...process.env, ...ISOLATION_ENV };
  delete env.CLAUDE_CODE_EFFORT_LEVEL; // It would override the chosen effort.
  return { cwd, env, tools: [], settingSources: [], skills: [], strictMcpConfig: true, verbatimPrompts: true, settings: ISOLATION_SETTINGS, title: 'SHOUT',
    ...(binary ? { pathToClaudeCodeExecutable: binary } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

const refused = detail => {
  const category = detail?.api_refusal_category ?? detail?.category;
  return Object.assign(new Error(`Claude declined this request${category ? ` (flagged: ${category})` : ''}.`), { code: 'refusal' });
};
/** Result usage as SHOUT counts it: input includes cached input. */
export const usageOf = usage => ({ inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
  cachedInputTokens: usage?.cache_read_input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 });

/**
 * Reads one query to its end and resolves its successful result message. A failed turn rejects with
 * Claude Code's error; a refusal rejects with `code: 'refusal'`. `onMessage` sees the other messages.
 */
export async function drain(stream, onMessage = () => {}) {
  let result = null; let failure = null;
  try {
    for await (const message of stream) {
      if (message.type === 'result') result = message;
      else if (message.type === 'system' && /^model_refusal/.test(message.subtype)) {
        failure ??= refused(message);
        // After a fallback Claude Code carries on with another model; SHOUT's model is fixed, so stop there.
        if (message.subtype === 'model_refusal_fallback') { stream.close?.(); break; }
      } else if (message.type === 'assistant' && message.message?.stop_reason === 'refusal') failure ??= refused(message.message.stop_details);
      else onMessage(message);
    }
  } catch (error) { if (!result && !failure) throw error; }
  if (failure || result?.stop_reason === 'refusal') throw failure ?? refused();
  if (!result) throw new Error('Claude Code ended without a result');
  if (result.subtype !== 'success' || result.is_error) throw new Error(result.errors?.join('; ') || result.result || `Claude Code stopped: ${result.subtype}`);
  return result;
}

/**
 * SHOUT's conversational agent on Claude: one persistent Claude Code session per SHOUT session. The
 * session is created under the thread ID on its first turn and resumed on every later one, also after
 * a restart. Each turn is one SDK query. The instructions and session context are the system prompt,
 * which Claude Code records with the session; the model acts only through SHOUT's tools, served in
 * process.
 */
export class ClaudeAgent {
  /** `stopWaitMs`: how long a new turn waits for a cancelled turn's Claude Code process on the same thread to stop. */
  constructor({ query = sdkQuery, sessionInfo = getSessionInfo, binary = claudeBinary(), stopWaitMs = 10_000 } = {}) {
    this.query = query; this.sessionInfo = sessionInfo; this.binary = binary; this.stopWaitMs = stopWaitMs; this.threads = new Map();
  }
  /** The thread ID is the Claude Code session ID; the session itself is created by the first turn. */
  async startThread() { return randomUUID(); }
  /**
   * Sends one user message and resolves `{ status, threadId }` when the model's turn ends. Tool calls go to
   * `onToolCall({ tool, input })`, which returns the result text (a thrown error is a failed call).
   * `thread` ({ cwd, instructions, context, tools }) must be the same on every turn of a thread.
   */
  async turn(threadId, text, { onToolCall, onEvent = () => {}, signal, model, effort, thread }) {
    if (!thread) throw new Error('A Claude turn needs its thread options');
    const previous = this.threads.get(threadId);
    // A cancelled turn counts as stopping from the moment its signal fires, even before its own caller has seen it end.
    if (previous?.active && !previous.controller.signal.aborted) throw new Error('This thread already has a turn in progress');
    signal?.throwIfAborted();
    const controller = new AbortController(); const state = { active: true, controller };
    this.threads.set(threadId, state);
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    // An interrupted turn resolves at once; its Claude Code process may take a moment to stop, and the next turn waits for it (up to `stopWaitMs`).
    const done = (async () => {
      if (previous && !(await settlesWithin(previous.done, this.stopWaitMs))) throw new Error('The previous turn is still stopping; try again shortly');
      return this.run(threadId, text, { onToolCall, onEvent, model, effort, thread, controller });
    })();
    state.done = done.then(() => {}, () => {}).finally(() => { if (this.threads.get(threadId) === state) this.threads.delete(threadId); });
    const interrupted = new Promise(resolveTurn => signal?.addEventListener('abort', () => resolveTurn({ status: 'interrupted' }), { once: true }));
    try { return await Promise.race([done, interrupted]); }
    finally { state.active = false; signal?.removeEventListener('abort', stop); }
  }
  async run(threadId, text, { onToolCall, onEvent, model, effort, thread, controller }) {
    // A session with a transcript is resumed; one whose first turn never reached Claude Code starts again.
    const resume = Boolean(await this.sessionInfo(threadId, { dir: thread.cwd }));
    controller.signal.throwIfAborted();
    const names = new Set(thread.tools.map(item => item.name));
    const server = createSdkMcpServer({ name: SERVER, version: '0.1.0', alwaysLoad: true,
      tools: thread.tools.map(({ name, description, inputSchema }) => tool(name, description, z.fromJSONSchema(inputSchema).shape, async input => {
        try { return { content: [{ type: 'text', text: String(await onToolCall({ tool: name, input })) }] }; }
        catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
      })) });
    const stream = this.query({ prompt: text, options: { ...isolatedOptions({ binary: this.binary, cwd: thread.cwd, model, effort }),
      systemPrompt: `${thread.instructions}\n\n${thread.context}`, mcpServers: { [SERVER]: server }, abortController: controller,
      // Claude Code's own tools are off; anything else that asks is refused.
      canUseTool: async (name, input, { mcpServer } = {}) => (names.has(bare(name)) && (!mcpServer || (mcpServer.source === 'sdk' && mcpServer.name === SERVER))
        ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `${name} is not one of SHOUT's tools` }),
      ...(resume ? { resume: threadId } : { sessionId: threadId }) } });
    const result = await drain(stream, message => {
      if (message.type !== 'assistant' || message.parent_tool_use_id || message.error || message.aborted) return;
      const said = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      if (said.trim()) onEvent({ type: 'message', text: said });
    });
    onEvent({ type: 'usage', usage: usageOf(result.usage) });
    return { status: 'completed', threadId: result.session_id ?? threadId };
  }
  close() { for (const { controller } of this.threads.values()) controller.abort(); }
}
