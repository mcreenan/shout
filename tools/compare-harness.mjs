#!/usr/bin/env node
// Runs one coding prompt through SHOUT and through a stock Codex CLI session on
// identical workspace copies, then compares timing, model usage, transcripts and
// independently re-run test results.
//
//   npm run compare -- prepare [example]      two fresh copies + the prompt to paste
//   npm run compare -- codex <run-dir>        stock `codex exec` on the codex copy, live
//   npm run compare -- report <run-dir> [--session <thread id>]
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { models, providers, modelInfo } from '../apps/shout/src/models.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplesRoot = resolve(repo, 'apps/shout/examples');
const compareRoot = resolve(repo, '.runs/compare');
const stateRoot = resolve(process.env.SHOUT_STATE_DIR || resolve(repo, '.runs/shout'));
const codexBin = process.env.CODEX_BIN || 'codex';
const examples = { 'ledger-import': { testCommand: 'node --test' } };

const exists = path => access(path).then(() => true, () => false);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const secs = ms => `${(ms / 1000).toFixed(1)}s`;
const clip = (text, length = 160) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=compare', '-c', 'user.email=compare@localhost', ...args], { cwd, encoding: 'utf8' });
const isTestCommand = command => /node --test|npm (run )?test/.test(command ?? '');

function runTests(cwd, command) {
  return new Promise(resolveDone => {
    const started = Date.now();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const child = spawn('/bin/bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolveDone({ passed: code === 0, ms: Date.now() - started, ...testCounts(output), failing: failingNames(output) }));
  });
}
function testCounts(output = '') {
  const count = name => Number(new RegExp(`^ℹ ${name} (\\d+)`, 'm').exec(output)?.[1] ?? NaN);
  return { total: count('tests'), pass: count('pass'), fail: count('fail') };
}
const failingNames = (output = '') => [...new Set([...output.matchAll(/^✖ (.+?) \(\d/gm)].map(match => match[1]))];
const testLabel = tests => Number.isNaN(tests.total) ? (tests.passed ? 'passed' : 'failed') : `${tests.pass}/${tests.total} pass`;

async function loadRun(dir) {
  const runDir = resolve(dir);
  if (!(await exists(resolve(runDir, 'meta.json')))) throw new Error(`${runDir} is not a comparison run. Create one with: npm run compare -- prepare`);
  return { runDir, meta: await readJson(resolve(runDir, 'meta.json')), prompt: await readFile(resolve(runDir, 'prompt.md'), 'utf8') };
}

async function prepare(example = 'ledger-import') {
  if (!examples[example]) throw new Error(`Unknown example ${example}. Available: ${Object.keys(examples).join(', ')}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const runDir = resolve(compareRoot, `${example}-${stamp}`);
  for (const side of ['shout', 'codex']) {
    const workspace = resolve(runDir, side);
    await cp(resolve(examplesRoot, example), workspace, { recursive: true, errorOnExist: true });
    // A baseline commit lets both sides be diffed identically afterwards. SHOUT never reads .git.
    git(workspace, 'init', '-q'); git(workspace, 'add', '-A'); git(workspace, 'commit', '-qm', 'baseline');
  }
  const prompt = await readFile(resolve(examplesRoot, `${example}.prompt.md`), 'utf8');
  await writeFile(resolve(runDir, 'prompt.md'), prompt);
  const { testCommand } = examples[example];
  const baseline = await runTests(resolve(runDir, 'shout'), testCommand);
  await writeFile(resolve(runDir, 'meta.json'), JSON.stringify({ example, testCommand, createdAt: new Date().toISOString(), baseline }, null, 2));
  let copied = false;
  try { execFileSync('wl-copy', { input: prompt, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 }); copied = true; } catch {}
  console.log(`Comparison run: ${runDir}
Baseline tests: ${testLabel(baseline)} (${baseline.fail} failing is expected; they reproduce the ticket)

SHOUT, in the desktop app or a browser
  1. Add project → ${resolve(runDir, 'shout')}
     It opens with a new thread. Right-click the thread → Project settings → Test command: ${testCommand}
  2. In the model picker choose a Codex model (${models.filter(model => model.provider === 'codex').map(model => model.label).join(' or ')}).
     Stock Codex uses the model in your Codex config; pick the same one to compare like with like.
  3. Paste the prompt below${copied ? ' (already on your clipboard)' : ''} and send it.
  4. Review each proposed change, then Approve.

Stock Codex, in a terminal (run it after SHOUT finishes if you want clean timings)
  npm run compare -- codex ${runDir}

Side-by-side report
  npm run compare -- report ${runDir}

──── prompt ────
${prompt}`);
}

async function codex(dir) {
  const { runDir, meta, prompt } = await loadRun(dir);
  const workspace = resolve(runDir, 'codex');
  const transcriptPath = resolve(runDir, 'codex-transcript.jsonl');
  if (await exists(transcriptPath)) throw new Error(`Codex already ran for ${runDir}. Prepare a new run to repeat it.`);
  const version = execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim();
  // Stock agent behaviour: the user's normal config, rules and AGENTS.md apply; only the sandbox is set so it can edit headlessly.
  const args = ['exec', '--json', '--sandbox', 'workspace-write', '--cd', workspace, '--output-last-message', resolve(runDir, 'codex-final.md'), '-'];
  console.log(`${version}: codex ${args.join(' ')}\n`);
  const transcript = createWriteStream(transcriptPath);
  const started = Date.now();
  const itemStarts = new Map();
  const result = { version, startedAt: new Date(started).toISOString(), commands: [], fileChanges: [], usage: {}, threadId: null, messages: [] };
  const child = spawn(codexBin, args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let stderr = '';
  const handle = line => {
    if (!line.trim()) return;
    const t = Date.now() - started;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    transcript.write(`${JSON.stringify({ t, ...event })}\n`);
    const at = `+${secs(t).padStart(6)}`;
    const item = event.item;
    if (event.type === 'thread.started') result.threadId = event.thread_id;
    if (event.type === 'turn.completed') for (const [key, value] of Object.entries(event.usage ?? {})) result.usage[key] = (result.usage[key] ?? 0) + value;
    if (event.type === 'turn.failed' || event.type === 'error') console.log(`${at}  error: ${clip(event.error?.message ?? event.message ?? line, 300)}`);
    if (!item) return;
    if (event.type === 'item.started') {
      itemStarts.set(item.id, t);
      if (item.type === 'command_execution') console.log(`${at}  $ ${clip(item.command, 140)}`);
      return;
    }
    if (event.type !== 'item.completed') return;
    if (item.type === 'reasoning') console.log(`${at}  thinking: ${clip(item.text, 140)}`);
    else if (item.type === 'command_execution') {
      result.commands.push({ t: itemStarts.get(item.id) ?? t, command: item.command, exitCode: item.exit_code, output: String(item.aggregated_output ?? '').slice(-4000) });
      console.log(`${at}    ↳ exit ${item.exit_code}`);
    } else if (item.type === 'file_change') {
      result.fileChanges.push({ t, changes: item.changes });
      console.log(`${at}  edited ${item.changes?.map(change => `${change.path.replace(`${workspace}/`, '')} (${change.kind})`).join(', ')}`);
    } else if (item.type === 'agent_message') {
      result.messages.push({ t, text: item.text });
      console.log(`${at}  codex: ${clip(item.text, 400)}`);
    } else console.log(`${at}  ${item.type}`);
  };
  child.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) !== -1) { handle(buffer.slice(0, end)); buffer = buffer.slice(end + 1); } });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.stdin.end(prompt);
  const exitCode = await new Promise(resolveExit => child.on('close', resolveExit));
  handle(buffer);
  result.wallMs = Date.now() - started;
  result.exitCode = exitCode;
  transcript.end();
  if (exitCode !== 0) console.log(`\ncodex exited ${exitCode}: ${stderr.trim().split('\n').slice(-5).join('\n')}`);
  result.finalTests = await runTests(workspace, meta.testCommand);
  await writeFile(resolve(runDir, 'codex-result.json'), JSON.stringify(result, null, 2));
  console.log(`\nCodex finished in ${secs(result.wallMs)} · independent test re-run: ${testLabel(result.finalTests)}`);
  console.log(`Transcript: ${transcriptPath}${result.threadId ? `\nResume it interactively: codex resume ${result.threadId}` : ''}`);
  console.log(`\nnpm run compare -- report ${runDir}`);
}

// A thread by ID, else the latest thread with messages on the SHOUT copy (its project's new, empty threads are skipped).
async function findSession(workspace, id) {
  const directory = resolve(stateRoot, 'sessions');
  const sessions = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    try { sessions.push(await readJson(resolve(directory, name))); } catch {}
  }
  if (id) return sessions.find(session => session.id === id) ?? null;
  return sessions.filter(session => resolve(session.workspace) === workspace && session.messages?.length).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

// Pairs start/end events by effect ID (or by order when the pair has none).
function spans(events, startType, endTypes) {
  const open = []; const result = [];
  for (const event of events) {
    if (event.type === startType) open.push(event);
    else if (endTypes.includes(event.type)) {
      const index = event.effectId ? open.findIndex(start => start.effectId === event.effectId) : 0;
      if (index === -1 || !open.length) continue;
      const [start] = open.splice(index, 1);
      result.push({ start, end: event, ms: Date.parse(event.time) - Date.parse(start.time) });
    }
  }
  return result;
}

// A task ends with a run's end, a cancel or an error, or with the agent's turn closing (a step that called no tool).
const endsTask = event => ['run.terminal', 'session.cancelled', 'session.error'].includes(event.type) || (event.type === 'chat.completed' && !event.tool && !event.thread);
const failure = result => result?.error?.message ?? result?.error ?? result?.reason ?? JSON.stringify(result ?? {});

function shoutMetrics(session) {
  const { events } = session;
  const first = events.find(event => event.type === 'chat.started' || event.type === 'command.routed');
  const last = events.findLast(endsTask) ?? events.at(-1);
  const sent = first && session.messages.filter(message => message.role === 'user' && message.time <= first.time).at(-1);
  const startTime = Date.parse(sent?.time ?? first?.time ?? session.createdAt);
  const wallMs = first && last ? Date.parse(last.time) - startTime : 0;
  const approvals = spans(events, 'user.question', ['user.answered']);
  const humanMs = approvals.reduce((sum, span) => sum + span.ms, 0);
  // The agent thread's steps (its model time between tool calls) and the programs' model.request judgments.
  const turns = spans(events, 'chat.started', ['chat.completed']);
  const judgments = spans(events, 'model.started', ['model.completed', 'effect.failed']);
  // The agent's own read tools and the programs' host tools. Writes and shell commands wait for your approval inside the call.
  const tools = spans(events, 'tool.started', ['tool.completed', 'tool.failed', 'effect.failed']);
  for (const span of tools) span.busyMs = span.ms - approvals.filter(item => item.start.time >= span.start.time && item.end.time <= span.end.time).reduce((sum, item) => sum + item.ms, 0);
  // Sub-agents keep their steps on their own records, with their usage totalled there.
  const usage = {};
  for (const item of [...events, ...(session.agents ?? [])]) if (item.usage) for (const [key, value] of Object.entries(item.usage)) usage[key] = (usage[key] ?? 0) + value;
  const testRuns = tools.filter(span => span.end.type === 'tool.completed' && (span.start.tool === 'tests.run' ? !span.end.value?.skipped : span.start.tool === 'shell.run' && span.end.value?.approved && isTestCommand(span.start.input?.command)))
    .map(span => ({ ...span, ...testCounts(span.end.value.output), passed: span.end.value.passed ?? span.end.value.exit_code === 0 }));
  const modelMs = [...turns, ...judgments].reduce((sum, span) => sum + span.ms, 0);
  const toolMs = tools.reduce((sum, span) => sum + span.busyMs, 0);
  const state = last?.state ?? { 'session.cancelled': 'cancelled', 'session.error': 'failed' }[last?.type] ?? session.runs.at(-1)?.state ?? session.status;
  return { first, startTime, wallMs, humanMs, machineMs: wallMs - humanMs, approvals, turns, judgments, tools, testRuns, usage, firstWrite: events.find(event => event.type === 'workspace.changed'), modelMs, toolMs, state };
}

// One line per tool call. The agent's own read tools record no result, so their input is shown.
function toolDetail({ start, end }) {
  if (end.type !== 'tool.completed') return `failed: ${clip(end.error?.message ?? end.message, 120)}`;
  const input = start.input ?? {}; const value = end.value ?? {};
  switch (start.tool) {
    case 'workspace.inspect': return clip(value.summary?.replace(/ in \/.*/, ''), 80);
    case 'workspace.read': return input.path;
    case 'workspace.read_many': return `${value.files?.length ?? input.paths?.length} files`;
    case 'workspace.search': return `“${clip(input.query, 60)}”`;
    case 'git.run': return `git ${clip(input.args?.join(' '), 80)}`;
    case 'workspace.edit': case 'workspace.write': return value.problem ? `edits did not apply: ${clip(value.problem, 120)}` : value.accepted ? `wrote ${value.changed?.join(', ')}` : 'declined';
    case 'tests.run': return value.skipped ? 'skipped (no test command)' : testLabel({ ...testCounts(value.output), passed: value.passed });
    case 'shell.run': return `\`${clip(input.command, 100)}\` → ${value.approved ? `exit ${value.exit_code}` : 'declined'}`;
    case 'agents.spawn': return `${input.agents?.length} sub-agents: ${value.completed} completed, ${value.failed} failed`;
    default: return '';
  }
}
// What a judgment returned, for /code's two kinds: the files to read, and snippet edits with a summary.
function judged(value) {
  const what = Array.isArray(value?.edits) ? (value.edits.length ? `edits to ${[...new Set(value.edits.map(edit => edit.path))].join(', ')}` : 'no edits')
    : Array.isArray(value?.paths) ? `chose ${clip(value.paths.join(', '), 160)}` : '';
  return `${what ? ` → ${what}` : ''}${typeof value?.summary === 'string' ? `: “${clip(value.summary, 200)}”` : ''}`;
}

function shoutTimeline(session, metrics) {
  const t0 = metrics.startTime;
  const at = time => `+${secs(Date.parse(time) - t0).padStart(6)}`;
  const lines = [];
  for (const message of session.messages) {
    // Your approvals are recorded as messages too (`echo`); their approval lines below say more.
    if (Date.parse(message.time) < t0 || message.echo) continue;
    lines.push([message.time, message.role === 'user' ? `**You:** ${clip(message.content, 220)}` : `*${message.role === 'assistant' ? 'SHOUT' : message.role}:* ${clip(message.content, 220)}`]);
  }
  const byStart = new Map();
  for (const span of [...metrics.turns, ...metrics.judgments, ...metrics.tools, ...metrics.approvals]) byStart.set(span.start.id, span);
  let judgment = 0;
  for (const event of session.events) {
    const span = byStart.get(event.id);
    if (event.type === 'chat.started' && span) {
      lines.push([event.time, span.end.thread ? `Agent thread started (${secs(span.ms)})` : `Agent step (${secs(span.ms)}) → ${span.end.tool ? `calls \`${span.end.tool}\`` : 'replies'}`]);
    } else if (event.type === 'program.loaded') {
      const run = session.runs.find(item => item.id === event.run);
      const name = run?.skill ? `\`/${run.skill}\`` : run?.generated ? 'a program the agent wrote' : 'a program';
      lines.push([event.time, `ALLEN loads ${name} (${event.artifactDigest?.slice(0, 19)}…) · tools: ${event.tools?.join(', ') || 'none'}`]);
    } else if (event.type === 'tool.started' && span) {
      const detail = toolDetail(span);
      lines.push([event.time, `Tool \`${event.tool}\`${detail ? ` → ${detail}` : ''} (${secs(span.busyMs)})`]);
    } else if (event.type === 'model.started' && span) {
      judgment += 1;
      const done = span.end;
      // Sessions recorded before workers carried their effect ID match the worker inside the judgment's span.
      const worker = session.events.slice(session.events.indexOf(event), session.events.indexOf(done)).find(item => item.type === 'model.worker' && (item.effectId ?? event.effectId) === event.effectId)?.usage;
      const workerTokens = worker ? ` · ${worker.input_tokens} in / ${worker.output_tokens} out${worker.reasoning_output_tokens ? ` (${worker.reasoning_output_tokens} reasoning)` : ''}` : '';
      lines.push([event.time, `Model judgment #${judgment} (${secs(span.ms)}${workerTokens})${done.type === 'effect.failed' ? ` → failed: ${clip(done.message, 160)}` : judged(done.value)}`]);
    } else if (event.type === 'user.question' && span) {
      const value = span.end.value;
      const asked = event.title ? `Approval requested: ${event.title}${event.command ? ` \`${clip(event.command, 100)}\`` : event.paths?.length ? ` (${event.paths.join(', ')})` : ''}` : 'Question asked';
      lines.push([event.time, `${asked}; you answered ${typeof value?.accept === 'boolean' ? `**${value.accept ? 'approve' : 'decline'}**` : `\`${clip(JSON.stringify(value), 80)}\``} after ${secs(span.ms)}`]);
    } else if (event.type === 'run.terminal') {
      // /code's result record is summarised; any other program's output is the reply that follows.
      const output = event.result?.output;
      const coded = output && typeof output === 'object' && 'attempts' in output;
      lines.push([event.time, `Run ${event.state}${coded ? ` · attempts ${output.attempts} · files changed ${output.changed} · tests ${output.passed ? 'passed' : 'not passed'}` : event.state === 'completed' ? '' : ` · ${clip(failure(event.result), 160)}`}`]);
    } else if (event.type === 'session.error' || event.type === 'session.cancelled') lines.push([event.time, `${event.type} ${clip(event.message ?? '', 160)}`]);
  }
  return lines.sort((a, b) => a[0].localeCompare(b[0])).map(([time, text]) => `- \`${at(time)}\` ${text}`).join('\n');
}

function codexTimeline(result, prompt) {
  const lines = [{ t: 0, text: `**You:** ${clip(prompt, 220)}` }];
  for (const command of result.commands) lines.push({ t: command.t, text: `\`$ ${clip(command.command, 150)}\` → exit ${command.exitCode}${isTestCommand(command.command) ? (command.exitCode === 0 ? ' · tests pass' : ' · tests fail') : ''}` });
  for (const change of result.fileChanges) lines.push({ t: change.t, text: `Edited ${change.changes.map(item => `${item.path.replace(/^.*\/codex\//, '')} (${item.kind})`).join(', ')}` });
  for (const message of result.messages) lines.push({ t: message.t, text: `*Codex:* ${clip(message.text, 400)}` });
  lines.push({ t: result.wallMs, text: `Codex exited ${result.exitCode}` });
  return lines.sort((a, b) => a.t - b.t).map(line => `- \`+${secs(line.t).padStart(6)}\` ${line.text}`).join('\n');
}

const diffStat = workspace => { try { return git(workspace, 'diff', '--stat', 'HEAD').trimEnd() || '(no changes)'; } catch (error) { return `(git diff failed: ${error.message})`; } };
const touchedTests = workspace => { try { return git(workspace, 'diff', '--name-only', 'HEAD').split('\n').filter(path => /(^|\/)test\//.test(path) || /\.test\./.test(path)); } catch { return []; } };
const tokenCell = usage => usage && Object.keys(usage).length ? `${usage.input_tokens ?? 0} in (${usage.cached_input_tokens ?? 0} cached) / ${usage.output_tokens ?? 0} out (${usage.reasoning_output_tokens ?? 0} reasoning)` : 'n/a';

async function report(dir, { session: sessionId } = {}) {
  const { runDir, meta, prompt } = await loadRun(dir);
  const shoutWorkspace = resolve(runDir, 'shout');
  const codexWorkspace = resolve(runDir, 'codex');
  const session = await findSession(shoutWorkspace, sessionId);
  const codexResult = await exists(resolve(runDir, 'codex-result.json')) ? await readJson(resolve(runDir, 'codex-result.json')) : null;
  if (!session && !codexResult) throw new Error(`Nothing to compare yet. Add ${shoutWorkspace} as a SHOUT project and send the prompt in its thread, and/or run: npm run compare -- codex ${runDir}`);
  const [shoutTests, codexTests] = await Promise.all([runTests(shoutWorkspace, meta.testCommand), codexResult ? runTests(codexWorkspace, meta.testCommand) : null]);
  const s = session ? shoutMetrics(session) : null;
  const model = modelInfo(session?.model);
  const modelName = model ? `${model.label} (${providers.find(provider => provider.id === model.provider)?.label})` : session?.model ?? 'an unknown model';
  const codexTestRuns = codexResult?.commands.filter(command => isTestCommand(command.command)) ?? [];
  const firstEdit = codexResult?.fileChanges[0]?.t;
  const na = '—';
  const rows = [
    ['Outcome (tests re-run now)', testLabel(shoutTests), codexTests ? testLabel(codexTests) : na],
    ['Wall clock, prompt → done', s ? secs(s.wallMs) : na, codexResult ? secs(codexResult.wallMs) : na],
    ['… waiting on you (approvals)', s ? `${secs(s.humanMs)} (${s.approvals.length} approval${s.approvals.length === 1 ? '' : 's'})` : na, '0.0s (none asked)'],
    ['… machine time (wall − waiting)', s ? secs(s.machineMs) : na, codexResult ? secs(codexResult.wallMs) : na],
    ['Model time', s ? `${secs(s.modelMs)} (agent ${secs(s.turns.reduce((a, b) => a + b.ms, 0))} + ${s.judgments.length} judgment${s.judgments.length === 1 ? '' : 's'})` : na, codexResult ? 'not separable; almost all of the wall clock' : na],
    ['Tool calls', s ? `${s.tools.length} typed tool calls (${secs(s.toolMs)})` : na, codexResult ? `${codexResult.commands.length} shell commands, ${codexResult.fileChanges.length} edit batches` : na],
    ['Test runs during the task', s ? String(s.testRuns.length) : na, codexResult ? String(codexTestRuns.length) : na],
    ['First edit written at', s ? (s.firstWrite ? `+${secs(Date.parse(s.firstWrite.time) - s.startTime)} (after approval)` : 'never') : na, firstEdit === undefined ? (codexResult ? 'never' : na) : `+${secs(firstEdit)}`],
    ['Tokens', s ? tokenCell(s.usage) : na, codexResult ? tokenCell(codexResult.usage) : na],
    ['Tests edited by the agent', touchedTests(shoutWorkspace).join(', ') || 'none', codexResult ? touchedTests(codexWorkspace).join(', ') || 'none' : na],
  ];
  const table = ['| | SHOUT | Stock Codex |', '| --- | --- | --- |', ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
  const failing = (label, tests) => tests && tests.failing.length ? `\n\n${label} still failing: ${tests.failing.map(name => `\`${name}\``).join(', ')}` : '';
  const markdown = `# ${meta.example}: SHOUT vs stock Codex

Run \`${basename(runDir)}\` · baseline ${testLabel(meta.baseline)} · test command \`${meta.testCommand}\`
SHOUT thread: ${session ? `\`${session.id}\` (${modelName}, ${session.effort} effort, ${s.state})` : 'none found for this workspace yet'} · Codex: ${codexResult ? `${codexResult.version}${codexResult.threadId ? `, thread \`${codexResult.threadId}\`` : ''}` : 'not run yet'}

${table}${failing('SHOUT', shoutTests)}${failing('Codex', codexTests)}

Read the timings with care. SHOUT's wall clock includes the time you spent reviewing each proposal, so compare **machine time** against Codex's wall clock; SHOUT's tool time leaves out those waits too. ${session ? `SHOUT ran on ${modelName}` : 'SHOUT runs on the thread\'s model'}; stock Codex runs on the model in your Codex config. SHOUT's agent thread sees only SHOUT's instructions and typed tools. Its edits and test runs happen in ALLEN programs, whose tool-less judgments each see one bounded snapshot of the files, so SHOUT's model time is its agent's steps plus those judgments. Codex runs as its normal agent with a shell and file edits; it explores and runs tests itself. \`codex exec\` reports each shell command only after it finishes, so its command durations and pure model time can't be separated from outside.

## SHOUT transcript

${s ? shoutTimeline(session, s) : '_No SHOUT thread yet._'}

## Stock Codex transcript

${codexResult ? codexTimeline(codexResult, prompt) : `_Not run yet: \`npm run compare -- codex ${runDir}\`_`}

## Resulting changes

**SHOUT** (\`${shoutWorkspace}\`)
\`\`\`
${diffStat(shoutWorkspace)}
\`\`\`

**Codex** (\`${codexWorkspace}\`)
\`\`\`
${codexResult ? diffStat(codexWorkspace) : 'not run'}
\`\`\`

Full diffs: \`git -C ${shoutWorkspace} diff\` and \`git -C ${codexWorkspace} diff\`. Raw data: the SHOUT thread's Export session (⋯ menu) and \`codex-transcript.jsonl\`.
`;
  await writeFile(resolve(runDir, 'report.md'), markdown);
  console.log(markdown);
  console.log(`Saved ${resolve(runDir, 'report.md')}`);
}

const [command, ...rest] = process.argv.slice(2);
const option = name => { const index = rest.indexOf(name); return index === -1 ? undefined : rest.splice(index, 2)[1]; };
try {
  if (command === 'prepare') await prepare(rest[0]);
  else if (command === 'codex' && rest[0]) await codex(rest[0]);
  else if (command === 'report') { const session = option('--session'); if (!rest[0]) throw new Error('report needs a run directory'); await report(rest[0], { session }); }
  else {
    console.error('Usage:\n  npm run compare -- prepare [example]\n  npm run compare -- codex <run-dir>\n  npm run compare -- report <run-dir> [--session <thread id>]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
