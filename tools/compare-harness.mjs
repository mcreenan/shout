#!/usr/bin/env node
// Runs one coding prompt through SHOUT and through a stock Codex CLI session on
// identical workspace copies, then compares timing, model usage, transcripts and
// independently re-run test results.
//
//   npm run compare -- prepare [example]      two fresh copies + the prompt to paste
//   npm run compare -- codex <run-dir>        stock `codex exec` on the codex copy, live
//   npm run compare -- report <run-dir> [--session <id>]
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

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

SHOUT, in the browser
  1. New session → leave the samples unselected → Model provider: Live (Codex)
     Workspace path:  ${resolve(runDir, 'shout')}
     Test command:    ${testCommand}
  2. Paste the prompt below${copied ? ' (already on your clipboard)' : ''} and send it. Keep the Inspector open.
  3. Review the Changes tab, then Approve & continue.

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

async function findSession(workspace, id) {
  const directory = resolve(stateRoot, 'sessions');
  const sessions = [];
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    try { sessions.push(await readJson(resolve(directory, name))); } catch {}
  }
  if (id) return sessions.find(session => session.id === id) ?? null;
  return sessions.filter(session => resolve(session.workspace) === workspace).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

// Pairs start/end events by effect ID (or by order when the pair has none).
function spans(events, startType, endType) {
  const open = []; const result = [];
  for (const event of events) {
    if (event.type === startType) open.push(event);
    else if (event.type === endType) {
      const index = event.effectId ? open.findIndex(start => start.effectId === event.effectId) : 0;
      if (index === -1 || !open.length) continue;
      const [start] = open.splice(index, 1);
      result.push({ start, end: event, ms: Date.parse(event.time) - Date.parse(start.time) });
    }
  }
  return result;
}

function shoutMetrics(session) {
  const { events } = session;
  const first = events.find(event => event.type === 'chat.started' || event.type === 'command.routed');
  const terminals = events.filter(event => ['run.terminal', 'session.cancelled', 'session.error'].includes(event.type));
  const last = terminals.at(-1) ?? events.at(-1);
  const sent = first && session.messages.filter(message => message.role === 'user' && message.time <= first.time).at(-1);
  const startTime = Date.parse(sent?.time ?? first?.time ?? session.createdAt);
  const wallMs = first && last ? Date.parse(last.time) - startTime : 0;
  const approvals = spans(events, 'user.question', 'user.answered');
  const humanMs = approvals.reduce((sum, span) => sum + span.ms, 0);
  const routes = spans(events, 'chat.started', 'chat.completed');
  const judgments = spans(events, 'model.started', 'model.completed');
  const tools = spans(events, 'tool.started', 'tool.completed');
  const usage = {};
  for (const event of events) if (event.usage) for (const [key, value] of Object.entries(event.usage)) usage[key] = (usage[key] ?? 0) + value;
  const testRuns = tools.filter(span => span.start.tool === 'run_tests').map(span => ({ ...span, ...testCounts(span.end.value?.output), passed: span.end.value?.passed }));
  const proposals = events.filter(event => event.type === 'user.question').map(event => event.prompt?.data?.value?.changes?.map(change => change.path) ?? []);
  const output = [...terminals].reverse().find(event => event.result?.output)?.result?.output;
  const modelMs = [...routes, ...judgments].reduce((sum, span) => sum + span.ms, 0);
  const toolMs = tools.reduce((sum, span) => sum + span.ms, 0);
  return { first, startTime, wallMs, humanMs, machineMs: wallMs - humanMs, approvals, routes, judgments, tools, testRuns, usage, proposals, output, modelMs, toolMs, runs: session.runs, state: last?.state ?? last?.type ?? session.status };
}

function shoutTimeline(session, metrics) {
  const t0 = metrics.startTime;
  const at = time => `+${secs(Date.parse(time) - t0).padStart(6)}`;
  const lines = [];
  for (const message of session.messages) {
    if (Date.parse(message.time) < t0) continue;
    lines.push([message.time, message.role === 'user' ? `**You:** ${clip(message.content, 220)}` : `*${message.role === 'assistant' ? 'SHOUT' : message.role}:* ${clip(message.content, 220)}`]);
  }
  const byEffect = new Map();
  for (const span of [...metrics.judgments, ...metrics.tools, ...metrics.approvals]) byEffect.set(span.start.id, span);
  let judgment = 0;
  for (const event of session.events) {
    const span = byEffect.get(event.id);
    const usage = event.type === 'chat.completed' || event.type === 'model.completed'
      ? session.events.slice(0, session.events.indexOf(event)).reverse().find(item => item.usage)?.usage : null;
    const tokens = usage ? ` · ${usage.input_tokens} in / ${usage.output_tokens} out${usage.reasoning_output_tokens ? ` (${usage.reasoning_output_tokens} reasoning)` : ''}` : '';
    if (event.type === 'chat.completed') {
      const route = metrics.routes.find(item => item.end === event);
      lines.push([event.time, `Router model → **${event.action}** (${secs(route?.ms ?? 0)}${tokens})`]);
    } else if (event.type === 'program.loaded') {
      const run = session.runs.find(item => item.id === event.run);
      const name = run?.source?.includes('coding.inspect_failed') ? 'coding.allen' : 'verify.allen';
      lines.push([event.time, `ALLEN loads \`${name}\` (${event.artifactDigest?.slice(0, 19)}…) · tools: ${event.tools?.join(', ')}`]);
    } else if (event.type === 'tool.started' && span) {
      const value = span.end.value ?? {};
      const detail = event.tool === 'inspect_workspace' ? clip(value.summary?.replace(/ in \/.*/, ''), 80)
        : event.tool === 'apply_changes' ? `wrote ${value.changed?.join(', ')}`
        : event.tool === 'run_tests' ? testLabel({ ...testCounts(value.output), passed: value.passed }) : '';
      lines.push([event.time, `Tool \`${event.tool}\` → ${detail} (${secs(span.ms)})`]);
    } else if (event.type === 'model.started' && span) {
      judgment += 1;
      const done = span.end;
      const worker = session.events.slice(session.events.indexOf(event), session.events.indexOf(done)).find(item => item.usage)?.usage;
      const workerTokens = worker ? ` · ${worker.input_tokens} in / ${worker.output_tokens} out${worker.reasoning_output_tokens ? ` (${worker.reasoning_output_tokens} reasoning)` : ''}` : '';
      const files = done.value?.changes?.filter(change => change.before !== change.after).map(change => change.path) ?? [];
      lines.push([event.time, `Model judgment #${judgment} (${secs(span.ms)}${workerTokens}) → ${files.length ? `patch for ${files.join(', ')}` : 'no changes'}: “${clip(done.value?.summary, 200)}”`]);
    } else if (event.type === 'user.question' && span) {
      lines.push([event.time, `Approval requested; you answered **${span.end.value?.accept ? 'approve' : 'decline'}** after ${secs(span.ms)}`]);
    } else if (event.type === 'run.terminal') {
      const output = event.result?.output;
      lines.push([event.time, `Run ${event.state}${output ? ` · attempts ${output.attempts} · files changed ${output.changed} · tests ${output.passed ? 'passed' : 'not passed'}` : ` · ${clip(event.result?.reason ?? event.result?.error ?? '', 160)}`}`]);
    } else if (event.type === 'session.error' || event.type === 'session.cancelled') lines.push([event.time, `${event.type} ${clip(event.message ?? '', 160)}`]);
  }
  return lines.sort((a, b) => a[0].localeCompare(b[0])).map(([time, text]) => `- \`${at(time)}\` ${text}`).join('\n');
}

function codexTimeline(result, prompt) {
  const lines = [{ t: 0, text: `**You:** ${clip(prompt, 220)}` }];
  for (const command of result.commands) lines.push({ t: command.t, text: `\`$ ${clip(command.command, 150)}\` → exit ${command.exitCode}${/node --test|npm (run )?test/.test(command.command) ? (command.exitCode === 0 ? ' · tests pass' : ' · tests fail') : ''}` });
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
  if (!session && !codexResult) throw new Error(`Nothing to compare yet. Create a SHOUT session on ${shoutWorkspace} and/or run: npm run compare -- codex ${runDir}`);
  const [shoutTests, codexTests] = await Promise.all([runTests(shoutWorkspace, meta.testCommand), codexResult ? runTests(codexWorkspace, meta.testCommand) : null]);
  const s = session ? shoutMetrics(session) : null;
  const codexTestRuns = codexResult?.commands.filter(command => /node --test|npm (run )?test/.test(command.command)) ?? [];
  const firstEdit = codexResult?.fileChanges[0]?.t;
  const na = '—';
  const rows = [
    ['Outcome (tests re-run now)', testLabel(shoutTests), codexTests ? testLabel(codexTests) : na],
    ['Wall clock, prompt → done', s ? secs(s.wallMs) : na, codexResult ? secs(codexResult.wallMs) : na],
    ['… waiting on you (approvals)', s ? `${secs(s.humanMs)} (${s.approvals.length} approval${s.approvals.length === 1 ? '' : 's'})` : na, '0.0s (none asked)'],
    ['… machine time (wall − waiting)', s ? secs(s.machineMs) : na, codexResult ? secs(codexResult.wallMs) : na],
    ['Model time', s ? `${secs(s.modelMs)} (router ${secs(s.routes.reduce((a, b) => a + b.ms, 0))} + ${s.judgments.length} judgment${s.judgments.length === 1 ? '' : 's'})` : na, codexResult ? 'not separable; almost all of the wall clock' : na],
    ['Tool calls', s ? `${s.tools.length} typed tool calls (${secs(s.toolMs)})` : na, codexResult ? `${codexResult.commands.length} shell commands, ${codexResult.fileChanges.length} edit batches` : na],
    ['Test runs during the task', s ? String(s.testRuns.length) : na, codexResult ? String(codexTestRuns.length) : na],
    ['First edit written at', s ? (() => { const applied = s.tools.find(span => span.start.tool === 'apply_changes'); return applied ? `+${secs(Date.parse(applied.end.time) - s.startTime)} (after approval)` : 'never'; })() : na, firstEdit === undefined ? (codexResult ? 'never' : na) : `+${secs(firstEdit)}`],
    ['Tokens', s ? tokenCell(s.usage) : na, codexResult ? tokenCell(codexResult.usage) : na],
    ['Tests edited by the agent', touchedTests(shoutWorkspace).join(', ') || 'none', codexResult ? touchedTests(codexWorkspace).join(', ') || 'none' : na],
  ];
  const table = ['| | SHOUT | Stock Codex |', '| --- | --- | --- |', ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
  const failing = (label, tests) => tests && tests.failing.length ? `\n\n${label} still failing: ${tests.failing.map(name => `\`${name}\``).join(', ')}` : '';
  const markdown = `# ${meta.example}: SHOUT vs stock Codex

Run \`${basename(runDir)}\` · baseline ${testLabel(meta.baseline)} · test command \`${meta.testCommand}\`
SHOUT session: ${session ? `\`${session.id}\` (${session.mode}, ${s.state})` : 'none found for this workspace yet'} · Codex: ${codexResult ? `${codexResult.version}${codexResult.threadId ? `, thread \`${codexResult.threadId}\`` : ''}` : 'not run yet'}

${table}${failing('SHOUT', shoutTests)}${failing('Codex', codexTests)}

Read the timings with care. SHOUT's wall clock includes the time you spent reviewing the patch, so compare **machine time** against Codex's wall clock. Both use the same Codex binary and default model: SHOUT through a tool-less structured judgment worker, and Codex as its normal agent with a shell and file edits. SHOUT's model sees one bounded snapshot of the files per judgment. Codex explores and runs tests itself. \`codex exec\` reports each shell command only after it finishes, so its command durations and pure model time can't be separated from outside.

## SHOUT transcript

${s ? shoutTimeline(session, s) : '_No SHOUT session yet._'}

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

Full diffs: \`git -C ${shoutWorkspace} diff\` and \`git -C ${codexWorkspace} diff\`. Raw data: the SHOUT session export and \`codex-transcript.jsonl\`.
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
    console.error('Usage:\n  npm run compare -- prepare [example]\n  npm run compare -- codex <run-dir>\n  npm run compare -- report <run-dir> [--session <id>]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
