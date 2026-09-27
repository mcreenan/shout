import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ClaudeAgent } from '../src/claude-agent.mjs';
import { ClaudeProvider } from '../src/claude-provider.mjs';

// Stand-in for the SDK's query(): `script(call, index)` is an async generator of SDK messages for each call.
const fakeQuery = script => {
  const calls = [];
  const query = ({ prompt, options }) => { const call = { prompt, options }; calls.push(call); return script(call, calls.length); };
  return Object.assign(query, { calls });
};
// Talks to the in-process MCP server the way Claude Code does.
const connect = async server => {
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(local);
  const client = new Client({ name: 'claude-code-double', version: '1.0.0' });
  await client.connect(remote); return client;
};
const init = { type: 'system', subtype: 'init', claude_code_version: '2.1.283', tools: [] };
const said = (text, extra = {}) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], stop_reason: null }, ...extra });
const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 };
const success = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '', stop_reason: 'end_turn', usage, ...extra });
// Aborting a real query makes its iterator throw a moment later.
const aborted = signal => new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Claude Code process aborted by user')), 30), { once: true }));
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tools = [
  { name: 'read_file', description: 'Read one workspace text file.', inputSchema: object({ path: { type: 'string', description: 'Path relative to the workspace' } }) },
  { name: 'git', description: 'Run git.', inputSchema: object({ args: { type: 'array', items: { type: 'string' }, description: 'Arguments' } }) },
];
const thread = { cwd: '/work/space', instructions: 'You are SHOUT.', context: 'Workspace: /work/space', tools };

test('ClaudeAgent serves SHOUT tools by name, refuses anything else, and resumes its session on later turns', async () => {
  const sessions = new Set(); const seen = {};
  const query = fakeQuery(async function* ({ options }, index) {
    yield init;
    if (index === 1) {
      const client = await connect(options.mcpServers.shout);
      seen.tools = (await client.listTools()).tools.map(({ name, inputSchema }) => ({ name, required: inputSchema.required, properties: Object.keys(inputSchema.properties) }));
      seen.read = await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } });
      seen.git = await client.callTool({ name: 'git', arguments: { args: ['push'] } });
      const context = { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'r1' };
      seen.permissions = await Promise.all([['read_file', { name: 'shout', source: 'sdk' }], ['mcp__shout__git', { name: 'shout', source: 'sdk' }], ['Bash', undefined],
        ['read_file', { name: 'shout', source: 'user' }], ['mcp__other__read_file', { name: 'other', source: 'sdk' }]]
        .map(async ([name, mcpServer]) => (await options.canUseTool(name, {}, { ...context, mcpServer })).behavior));
      sessions.add(options.sessionId);
      yield said('Found it.');
    } else yield said('Still here.');
    yield { ...said('Subagent text'), parent_tool_use_id: 'toolu_9' };
    yield success({ session_id: options.resume ?? options.sessionId });
  });
  const agent = new ClaudeAgent({ query, sessionInfo: async (id, { dir }) => (dir === '/work/space' && sessions.has(id) ? { sessionId: id } : undefined), binary: '/opt/claude' });
  const threadId = await agent.startThread(thread);
  assert.match(threadId, /^[0-9a-f-]{36}$/);
  const events = []; const calls = [];
  const onToolCall = async ({ tool, input }) => { calls.push([tool, input]); if (tool === 'git') throw new Error('git push is not allowed'); return 'alpha\nbeta'; };
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  try {
    assert.deepEqual(await agent.turn(threadId, 'Read notes', { onToolCall, onEvent: event => events.push(event), model: 'claude-opus-5-5', effort: 'low', thread }), { status: 'completed', threadId });
  } finally { delete process.env.CLAUDE_CODE_EFFORT_LEVEL; }
  assert.deepEqual(calls, [['read_file', { path: 'notes.txt' }], ['git', { args: ['push'] }]]);
  assert.deepEqual(seen.tools, [{ name: 'read_file', required: ['path'], properties: ['path'] }, { name: 'git', required: ['args'], properties: ['args'] }]);
  assert.deepEqual(seen.read, { content: [{ type: 'text', text: 'alpha\nbeta' }] });
  assert.deepEqual(seen.git, { content: [{ type: 'text', text: 'git push is not allowed' }], isError: true });
  assert.deepEqual(seen.permissions, ['allow', 'allow', 'deny', 'deny', 'deny']);
  assert.deepEqual(events, [{ type: 'message', text: 'Found it.' }, { type: 'usage', usage: { inputTokens: 115, cachedInputTokens: 100, outputTokens: 7 } }]);
  const [first] = query.calls;
  assert.equal(first.prompt, 'Read notes');
  assert.equal(first.options.systemPrompt, 'You are SHOUT.\n\nWorkspace: /work/space');
  assert.deepEqual([first.options.sessionId, first.options.resume, first.options.cwd, first.options.model, first.options.effort], [threadId, undefined, '/work/space', 'claude-opus-5-5', 'low']);
  assert.deepEqual([first.options.tools, first.options.settingSources, first.options.skills, first.options.strictMcpConfig, first.options.verbatimPrompts], [[], [], [], true, true]);
  assert.deepEqual(Object.keys(first.options.mcpServers), ['shout']);
  assert.equal(first.options.pathToClaudeCodeExecutable, '/opt/claude');
  assert.equal(first.options.settings.switchModelsOnFlag, false);
  assert.equal(first.options.env.CLAUDE_CODE_EFFORT_LEVEL, undefined, "the user's effort override is dropped");
  assert.equal(first.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(first.options.persistSession, undefined, 'the conversation is saved so it can be resumed');
  await agent.turn(threadId, 'And now?', { onToolCall, onEvent: event => events.push(event), model: 'claude-opus-5-5', effort: 'high', thread });
  assert.deepEqual([query.calls[1].options.resume, query.calls[1].options.sessionId, query.calls[1].options.effort], [threadId, undefined, 'high']);
  assert.equal(query.calls[1].options.systemPrompt, first.options.systemPrompt);
});

test('ClaudeAgent refuses a second turn on a busy thread, and an abort interrupts promptly', async () => {
  let release;
  const query = fakeQuery(async function* ({ options }, index) {
    yield init;
    if (index === 1) await aborted(options.abortController.signal);
    if (index === 2) await new Promise(resolve => { release = resolve; });
    yield said(`turn ${index}`); yield success({ session_id: 's' });
  });
  const agent = new ClaudeAgent({ query, sessionInfo: async () => undefined, binary: null });
  const controller = new AbortController();
  const running = agent.turn('s', 'long', { onToolCall: async () => '', signal: controller.signal, thread });
  await assert.rejects(agent.turn('s', 'again', { onToolCall: async () => '', thread }), /already has a turn in progress/);
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now(); controller.abort();
  assert.deepEqual(await running, { status: 'interrupted' });
  assert.ok(Date.now() - started < 20, 'the turn does not wait for the process to stop');
  assert.equal(query.calls[0].options.abortController.signal.aborted, true);
  assert.equal(query.calls[0].options.pathToClaudeCodeExecutable, undefined);
  const events = [];
  const next = agent.turn('s', 'next', { onToolCall: async () => '', onEvent: event => events.push(event), thread });
  await new Promise(resolve => setTimeout(resolve, 60));
  release();
  assert.deepEqual(await next, { status: 'completed', threadId: 's' });
  assert.deepEqual(events[0], { type: 'message', text: 'turn 2' });
  await assert.rejects(agent.turn('s', 'x', { onToolCall: async () => '', signal: AbortSignal.abort(), thread }), /abort/i);
  await assert.rejects(agent.turn('s', 'x', { onToolCall: async () => '' }), /needs its thread options/);
});

test('ClaudeAgent rejects failed turns and refusals with a clear message', async () => {
  const endings = {
    failed: [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Invalid model: claude-nope'], stop_reason: null }],
    apiError: [said('API Error: 401 authentication_error', { error: 'authentication_failed' }), success({ is_error: true, result: 'API Error: 401 authentication_error' })],
    refused: [{ type: 'assistant', parent_tool_use_id: null, message: { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } } }, success({ stop_reason: 'refusal' })],
    noFallback: [{ type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'bio', content: 'declined' }, success({ stop_reason: 'refusal' })],
    fallback: [{ type: 'system', subtype: 'model_refusal_fallback', api_refusal_category: 'cyber', original_model: 'claude-fable-5-1', fallback_model: 'claude-opus-4-8' }, said('continued elsewhere'), success()],
  };
  const closed = [];
  const query = ({ prompt }) => {
    const messages = [init, ...endings[prompt]];
    const stream = (async function* () {
      yield* messages;
      if (endings[prompt][0].subtype === 'error_during_execution') throw new Error('Claude Code returned an error result: error_during_execution');
    })();
    return Object.assign(stream, { close: () => closed.push(prompt) });
  };
  const agent = new ClaudeAgent({ query, sessionInfo: async () => undefined, binary: null });
  const events = [];
  const turn = prompt => agent.turn('t', prompt, { onToolCall: async () => '', onEvent: event => events.push(event), thread });
  await assert.rejects(turn('failed'), /^Error: Invalid model: claude-nope$/);
  await assert.rejects(turn('apiError'), /API Error: 401/);
  await assert.rejects(turn('refused'), error => error.code === 'refusal' && error.message === 'Claude declined this request (flagged: cyber).');
  await assert.rejects(turn('noFallback'), /declined this request \(flagged: bio\)/);
  await assert.rejects(turn('fallback'), /declined this request \(flagged: cyber\)/);
  assert.deepEqual(closed, ['fallback']);
  assert.deepEqual(events, [], 'no error text, refused or fallback output reaches the conversation');
});

const answerOf = value => ({ type: 'object', properties: { value }, required: ['value'], additionalProperties: false });

test('ClaudeProvider returns a validated structured answer from one isolated, unsaved query', async () => {
  const query = fakeQuery(async function* () { yield init; yield success({ structured_output: { value: { pick: 'T-100' } }, stop_reason: 'tool_use' }); });
  const provider = new ClaudeProvider({ query, binary: null, model: 'claude-fable-5-1', effort: 'low' });
  const schema = { type: 'object', properties: { pick: { type: 'string' } }, required: ['pick'], additionalProperties: false };
  const events = [];
  assert.deepEqual(await provider.judge({ prompt: { system: 'Pick one', data: [1] }, schema, onEvent: event => events.push(event) }), { pick: 'T-100' });
  const [{ prompt, options }] = query.calls;
  assert.equal(prompt, JSON.stringify({ system: 'Pick one', data: [1] }));
  assert.deepEqual(options.outputFormat, { type: 'json_schema', schema: answerOf(schema) });
  assert.deepEqual([options.persistSession, options.model, options.effort, options.tools, options.settingSources, options.mcpServers], [false, 'claude-fable-5-1', 'low', [], [], undefined]);
  assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny');
  assert.deepEqual(events, [{ provider: 'claude-agent-sdk', version: '2.1.283', usage: { input_tokens: 115, cached_input_tokens: 100, output_tokens: 7 }, mode: 'structured', attempts: 1, acceptedToolEvents: 0, profile: 'restricted-no-tools-v1' }]);
});

test('ClaudeProvider falls back to JSON in the prompt, with one corrective retry', async () => {
  const replies = [null, 'Here you go: {"value": 5}', '```json\n{"value": "five"}\n```'];
  const query = fakeQuery(async function* (_call, index) {
    yield init;
    if (index === 1) { yield { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: ['no valid output'], stop_reason: null, usage }; throw new Error('Claude Code returned an error result'); }
    yield success({ result: replies[index - 1] });
  });
  const events = [];
  const provider = new ClaudeProvider({ query, binary: null });
  assert.equal(await provider.judge({ prompt: { system: 'Spell it' }, schema: { type: 'string' }, onEvent: event => events.push(event) }), 'five');
  assert.equal(query.calls.length, 3);
  assert.equal(query.calls[1].options.outputFormat, undefined);
  assert.match(query.calls[1].prompt, /^\{"system":"Spell it"\}\n\nReply with only a JSON object \{"value": \.\.\.\} whose value matches this JSON Schema, and nothing else:\n\{"type":"string"\}$/);
  assert.match(query.calls[2].prompt, /Your previous reply was rejected \(Schema rejected response: \/value type\):\nHere you go: \{"value": 5\}\n\nReply again/);
  assert.deepEqual([events[0].mode, events[0].attempts, events[0].usage.output_tokens], ['json', 3, 14]);

  const stubborn = fakeQuery(async function* (_call, index) { yield init; yield index === 1 ? success() : success({ result: 'not json' }); });
  await assert.rejects(new ClaudeProvider({ query: stubborn, binary: null }).judge({ prompt: {}, schema: { type: 'string' } }), /The reply is not a JSON object/);
  assert.equal(stubborn.calls.length, 3, 'structured, JSON, one retry');
});

test('ClaudeProvider honours refusals, cancellation and its time budget without retrying', async () => {
  const refusing = fakeQuery(async function* () { yield init; yield { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: null }; yield success({ stop_reason: 'refusal' }); });
  await assert.rejects(new ClaudeProvider({ query: refusing, binary: null }).judge({ prompt: {}, schema: { type: 'string' } }), /^Error: Claude declined this request\.$/);
  assert.equal(refusing.calls.length, 1);
  const hanging = fakeQuery(async function* ({ options }) { yield init; await aborted(options.abortController.signal); });
  await assert.rejects(new ClaudeProvider({ query: hanging, binary: null, timeoutMs: 40 }).judge({ prompt: {}, schema: { type: 'string' } }), /time budget exceeded after 40 ms/);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
  await assert.rejects(new ClaudeProvider({ query: hanging, binary: null, timeoutMs: null }).judge({ prompt: {}, schema: { type: 'string' }, signal: controller.signal }), /Model worker cancelled/);
  assert.equal(hanging.calls.length, 2, 'no fallback after a timeout or cancellation');
  await assert.rejects(new ClaudeProvider({ query: hanging, binary: null }).judge({ prompt: {}, schema: {}, signal: AbortSignal.abort() }), /abort/i);
  assert.throws(() => new ClaudeProvider({ timeoutMs: 0 }), /positive integer or null/);
});
