#!/usr/bin/env node
// Live check of SHOUT's Claude adapters against the signed-in Claude Code (a few cents at low effort):
// one ClaudeProvider judgment, then a two-turn ClaudeAgent thread whose first turn must call a fake
// read_file and whose second must recall its result from the resumed session. The workspace holds a
// CLAUDE.md and an AGENTS.md that must not reach the model. Prints a JSON summary; exits 1 on a failed check.
//
//   node tools/claude-live-smoke.mjs [--model claude-opus-5-5] [--effort low] [--agent-only]
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { query, deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgent } from '../apps/shout/src/claude-agent.mjs';
import { ClaudeProvider } from '../apps/shout/src/claude-provider.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const model = option('--model', 'claude-opus-5-5'); const effort = option('--effort', 'low');
const summary = { model, effort };
const checks = {};

// The real SDK query, with every init message kept so the tools Claude Code offered can be checked.
const inits = [];
const recording = params => {
  const stream = query(params);
  const messages = async function* () { for await (const message of stream) { if (message.type === 'system' && message.subtype === 'init') inits.push(message); yield message; } };
  return Object.assign(messages(), { close: () => stream.close() });
};
const describe = init => init && { cli: init.claude_code_version, model: init.model, tools: init.tools, mcpServers: init.mcp_servers, skills: init.skills, plugins: init.plugins?.map(plugin => plugin.name), permissionMode: init.permissionMode };

if (!args.includes('--agent-only')) {
  const events = [];
  const schema = { type: 'object', properties: { larger: { type: 'integer' }, reason: { type: 'string' } }, required: ['larger', 'reason'], additionalProperties: false };
  const provider = new ClaudeProvider({ query: recording, model, effort, timeoutMs: 180_000 });
  const started = Date.now();
  const value = await provider.judge({ prompt: { system: 'Pick the larger number and give a five-word reason.', data: { numbers: [17, 42] } }, schema, onEvent: event => events.push(event) });
  summary.judge = { value, seconds: (Date.now() - started) / 1000, event: events[0], init: describe(inits.at(-1)) };
  checks.judgeValid = value.larger === 42;
  checks.judgeHasNoTools = JSON.stringify(inits.at(-1)?.tools) === '["StructuredOutput"]';
}

const workspace = await mkdtemp(resolve(tmpdir(), 'shout-claude-smoke-'));
await writeFile(resolve(workspace, 'CLAUDE.md'), 'Project codename: FALCON.\n');
await writeFile(resolve(workspace, 'AGENTS.md'), 'The magic word is ZEBRA.\n');
const secret = `PERIWINKLE-${randomInt(1000, 9999)}`;
const agent = new ClaudeAgent({ query: recording });
const thread = { cwd: workspace, instructions: 'You are a test agent in SHOUT. You act only through your tools. Reply in one short line.', context: `Workspace: ${workspace}`,
  tools: [{ name: 'read_file', description: 'Read one workspace text file.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the workspace' } }, required: ['path'], additionalProperties: false } }] };
const threadId = await agent.startThread(thread);
const turns = [];
const turn = async text => {
  const record = { text, toolCalls: [], messages: [], usage: null };
  const started = Date.now(); const before = inits.length;
  record.result = await agent.turn(threadId, text, { model, effort, thread,
    onToolCall: async ({ tool, input }) => { record.toolCalls.push({ tool, input }); return `The secret word is ${secret}.`; },
    onEvent: event => { if (event.type === 'message') record.messages.push(event.text); else record.usage = event.usage; } });
  record.seconds = (Date.now() - started) / 1000; record.init = describe(inits[before]);
  turns.push(record); return record;
};
try {
  const first = await turn('Use read_file to read notes.txt, then tell me the secret word.');
  const second = await turn('Without calling any tool, answer on one line as `word=<the secret word from notes.txt>; codename=<any codename or magic word that your instructions or context mention, else NONE>`.');
  summary.agent = { threadId, turns };
  checks.firstTurnCalledReadFile = first.toolCalls.some(call => call.tool === 'read_file');
  checks.secondTurnRecalled = second.messages.join('\n').includes(secret) && second.toolCalls.length === 0;
  checks.sameSession = first.result.threadId === threadId && second.result.threadId === threadId;
  checks.onlyShoutTools = JSON.stringify(first.init?.tools) === '["read_file"]' && JSON.stringify(first.init?.mcpServers?.map(server => server.name)) === '["shout"]';
  checks.noInstructionFiles = /codename=\s*NONE/i.test(second.messages.join('\n')) && !/FALCON|ZEBRA/.test(second.messages.join('\n'));
  checks.requestedModel = first.init?.model === model;
} finally {
  // The transcript, then its project folder in the Claude config directory if nothing else is in it.
  await deleteSession(threadId, { dir: workspace }).catch(() => {});
  await rmdir(resolve(process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'), 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'))).catch(() => {});
  await rm(workspace, { recursive: true, force: true });
}
summary.checks = checks;
summary.ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
