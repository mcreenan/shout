#!/usr/bin/env node
// Live checks of SHOUT's sub-agents (spawn_agents) on real providers: a real CodingSession per check, in a
// small temporary workspace with a temporary state directory. Low effort and tiny files keep the cost down.
//   a. fanout:  a parent asked to investigate three questions with sub-agents calls spawn_agents; the children
//               run at once with read tools only, and the parent's reply uses their reports.
//   b. slow:    a spawn_agents call held open for --slow-minutes (default 5) still returns its result to the turn.
//   c. four:    four children at once (one codex app-server; or four Claude Code processes under one parent query),
//               with process counts, memory and start-up times.
//   d. cancel:  cancelling during a fan-out stops every child within a few seconds and leaves no running agent.
//   e. weight:  (no model) snapshot cost of a session holding 24 finished agents with full event logs.
//   f. resend:  a message sent right after cancelling a turn mid-tool-call runs on the same thread and completes.
// Prints a JSON summary per provider; exits 1 if a check fails.
//
//   JOSH_BIN="$(bash tools/setup-josh.sh)" node tools/subagents-live-smoke.mjs [--provider codex|claude|both]
//     [--effort low] [--slow-minutes 5] [--checks a,b,c,d,e] [--codex-model gpt-6-astra] [--claude-model claude-opus-5-5]
import { mkdtemp, mkdir, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../apps/shout/src/session.mjs';

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const providerArg = option('--provider', 'both');
const effort = option('--effort', 'low');
const slowMs = Number(option('--slow-minutes', '5')) * 60_000;
const checks = option('--checks', 'a,b,c,d,e,f').split(',');
const models = { codex: option('--codex-model', 'gpt-6-astra'), claude: option('--claude-model', 'claude-opus-5-5') };
const CODEX_VERSION = 'codex-cli 0.157.1';
const READ_TOOLS = new Set(['workspace.list', 'workspace.read', 'workspace.search', 'git.run']);
const mentions = (text, value) => text.toLowerCase().includes(String(value).toLowerCase());
const seconds = ms => Math.round(ms / 100) / 10;
// Plain words, not random tokens: a file holding one odd token to fetch reads like a capture-the-flag task, which Claude's classifier can refuse.
const pick = list => list[randomInt(list.length)];
const place = () => `${pick(['Amber', 'Basalt', 'Cedar', 'Juniper', 'Harbor', 'Willow', 'Maple', 'Linden'])} ${pick(['Cafe', 'Diner', 'Kitchen', 'Bistro', 'Canteen', 'Noodle Bar'])}`;
const colours = () => ['teal', 'crimson', 'ochre', 'lavender', 'olive', 'coral', 'navy', 'amber', 'mint', 'plum'].sort(() => Math.random() - 0.5);

/** SHOUT's agent requires this Codex CLI; mise installs it for this repo (mise.toml), ahead of any older `codex` on PATH. */
async function codexBinary() {
  const version = bin => exec(bin, ['--version'], { timeout: 5000 }).then(({ stdout }) => stdout.trim(), () => '');
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (await version('codex') === CODEX_VERSION) return 'codex';
  const mise = (await exec('mise', ['which', 'codex'], { cwd: repoRoot }).catch(() => ({ stdout: '' }))).stdout.trim();
  if (mise && await version(mise) === CODEX_VERSION) return mise;
  throw new Error(`No ${CODEX_VERSION} found (install it with mise, or set CODEX_BIN)`);
}

// This process's descendants, from ps: { pid, ppid, rss (KiB), comm }.
async function descendants() {
  const { stdout } = await exec('ps', ['-e', '-o', 'pid=,ppid=,rss=,comm=']);
  const rows = stdout.trim().split('\n').map(line => { const [pid, ppid, rss, ...comm] = line.trim().split(/\s+/); return { pid: +pid, ppid: +ppid, rss: +rss, comm: comm.join(' ') }; });
  const byParent = Map.groupBy(rows, row => row.ppid); const found = [];
  const walk = pid => { for (const row of byParent.get(pid) ?? []) { found.push(row); walk(row.pid); } };
  walk(process.pid); return found;
}
const byComm = list => Object.fromEntries([...Map.groupBy(list, row => row.comm)].map(([comm, rows]) => [comm, { count: rows.length, rssMB: Math.round(rows.reduce((sum, row) => sum + row.rss, 0) / 1024) }]));

/** Samples a session while a check runs: agent states, activity lines, snapshots, and (optionally) processes. */
function watch(session, { processes = false, extra = () => ({}) } = {}) {
  const state = { peakRunning: 0, activities: new Set(), snapshots: 0, revisions: session.data.revision ?? 0, processes: [], extra: [] };
  const onSnapshot = () => { state.snapshots++; };
  session.on('snapshot', onSnapshot);
  // Tool calls take milliseconds, so the activity line is read at each of the agent's events rather than polled.
  const agentEvent = session.agentEvent.bind(session);
  session.agentEvent = (agent, type, detail) => { if (agent.activity) state.activities.add(agent.activity); return agentEvent(agent, type, detail); };
  let stopped = false;
  const agentsLoop = (async () => {
    while (!stopped) {
      const agents = session.data.agents ?? [];
      state.peakRunning = Math.max(state.peakRunning, agents.filter(agent => agent.status === 'running').length);
      state.extra.push(extra());
      await sleep(100);
    }
  })();
  const processLoop = processes && (async () => { while (!stopped) { state.processes.push(await descendants().catch(() => [])); await sleep(500); } })();
  return async () => {
    stopped = true; await agentsLoop; if (processLoop) await processLoop;
    session.off('snapshot', onSnapshot); delete session.agentEvent;
    const peaks = {};
    for (const sample of state.processes) for (const [comm, { count, rssMB }] of Object.entries(byComm(sample))) {
      const peak = peaks[comm] ??= { count: 0, rssMB: 0 };
      peak.count = Math.max(peak.count, count); peak.rssMB = Math.max(peak.rssMB, rssMB);
    }
    return { peakRunning: state.peakRunning, activities: [...state.activities].slice(0, 40), snapshots: state.snapshots, changes: (session.data.revision ?? 0) - state.revisions,
      ...(processes ? { processPeaks: peaks } : {}), extra: state.extra };
  };
}
// The most agents whose [startedAt, endedAt] overlap at one moment.
function overlap(agents) {
  const points = agents.filter(agent => agent.startedAt).flatMap(agent => [[Date.parse(agent.startedAt), 1], [Date.parse(agent.endedAt ?? new Date().toISOString()), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0; let peak = 0; for (const [, step] of points) { now += step; peak = Math.max(peak, now); } return peak;
}
const agentSummary = agent => {
  const first = agent.events.find(event => event.type === 'tool.started' || event.type === 'chat.worker');
  return { name: agent.name, status: agent.status, seconds: agent.startedAt && seconds(Date.parse(agent.endedAt ?? new Date().toISOString()) - Date.parse(agent.startedAt)),
    firstStepSeconds: first && agent.startedAt ? seconds(Date.parse(first.time) - Date.parse(agent.startedAt)) : null, calls: agent.calls, usage: agent.usage,
    tools: agent.events.filter(event => event.type === 'tool.started').map(event => `${event.tool} ${JSON.stringify(event.input)}`), report: agent.report.slice(0, 300), error: agent.error };
};
const reply = session => session.data.messages.slice(session.data.messages.findLastIndex(message => message.role === 'user') + 1).filter(message => message.role === 'assistant').map(message => message.content).join('\n');
const spawnEvents = session => session.data.events.filter(event => event.tool === 'agents.spawn').map(event => ({ type: event.type, time: event.time, ...(event.value ? { value: event.value } : {}), ...(event.error ? { error: event.error } : {}) }));
const childTools = session => [...new Set((session.data.agents ?? []).flatMap(agent => agent.events.filter(event => event.type === 'tool.started').map(event => event.tool)))];
async function finish(session, limitMs) {
  const timer = setTimeout(() => session.cancel(), limitMs);
  try { await session.task; } finally { clearTimeout(timer); }
}

async function runProvider(provider) {
  const model = models[provider];
  const summary = { provider, model, effort, results: {} };
  if (provider === 'codex') process.env.CODEX_BIN = await codexBinary();
  const stateRoot = await mkdtemp(resolve(tmpdir(), `shout-subagents-${provider}-`));
  const store = await new SessionStore({ stateRoot }).init();
  const workspaces = []; const sessions = [];
  const workspace = async (name, files) => {
    const dir = resolve(stateRoot, 'workspaces', name); await mkdir(dir, { recursive: true }); workspaces.push(dir);
    for (const [path, content] of Object.entries(files)) await writeFile(resolve(dir, path), content);
    return dir;
  };
  const open = async (name, files) => { const session = await store.create({ workspace: await workspace(name, files), model, effort }); sessions.push(session); return session; };
  const agentOf = () => store.agentFor(provider);
  const run = async (key, fn) => {
    if (!checks.includes(key)) return;
    const started = Date.now();
    try { summary.results[key] = await fn(); } catch (error) { summary.results[key] = { ok: false, error: error.stack ?? String(error) }; }
    summary.results[key].seconds = seconds(Date.now() - started);
    console.error(`[${provider}] ${key}: ${summary.results[key].ok ? 'ok' : 'FAILED'} (${summary.results[key].seconds}s)`);
  };

  // b first: it holds its call open in the background while the other checks run.
  const slow = run('b', async () => {
    const code = place();
    const session = await open('slow', { 'notes.txt': `Team notes\n\nThis Friday the team lunch is at ${code}.\n` });
    const timing = {};
    const spawnAgents = session.spawnAgents.bind(session);
    session.spawnAgents = async (input, controller, current) => {
      timing.called = Date.now();
      const value = await spawnAgents(input, controller, current);
      timing.childrenDone = Date.now();
      await sleep(Math.max(0, timing.called + slowMs - Date.now()), undefined, { signal: controller.signal });
      timing.returned = Date.now();
      return value;
    };
    const stop = watch(session);
    store.send(session.data.id, 'Call spawn_agents once, with a single agent named probe whose brief is exactly: "Read notes.txt and report where the team lunch is this Friday." Do not read any file yourself. When the result arrives, tell me where the lunch is.');
    await finish(session, slowMs + 5 * 60_000);
    timing.turnEnded = Date.now();
    const observed = await stop();
    const text = reply(session);
    const result = { heldSeconds: timing.returned && seconds(timing.returned - timing.called), childSeconds: timing.childrenDone && seconds(timing.childrenDone - timing.called),
      turnEndedAfterReturnSeconds: timing.returned && seconds(timing.turnEnded - timing.returned), status: session.data.status, reply: text.slice(0, 400), spawn: spawnEvents(session),
      agents: session.data.agents.map(agentSummary), snapshots: observed.snapshots, errors: session.data.events.filter(event => event.type === 'session.error').map(event => event.message) };
    result.checks = { heldOpen: Boolean(timing.returned) && timing.returned - timing.called >= slowMs - 1000, turnWaitedForResult: Boolean(timing.returned) && timing.turnEnded >= timing.returned,
      replyUsesReport: mentions(text, code), completed: session.data.status === 'idle' && result.spawn.at(-1)?.type === 'tool.completed' };
    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  });

  await run('a', async () => {
    const answers = { port: String(randomInt(4000, 9999)), spread: `0.0${randomInt(100, 999)}`, codename: place().split(' ')[0] + ' Heron' };
    const session = await open('fanout', {
      'config.json': `{\n  "name": "tally",\n  "port": ${answers.port},\n  "region": "ap-southeast-2"\n}\n`,
      'rates.mjs': `export const DEFAULT_CURRENCY = 'NZD';\nexport const FX_SPREAD = ${answers.spread};\nexport const rate = (base, quote) => (base === quote ? 1 : null);\n`,
      'README.md': `# Tally\n\nA tiny ledger. Codename: ${answers.codename}.\n`,
      'ledger.mjs': `export function roundCents(value) {\n  return Math.round(value * 100) / 100;\n}\n` });
    const stop = watch(session);
    const started = Date.now();
    store.send(session.data.id, 'Use spawn_agents to answer these three independent questions about this workspace, one sub-agent per question, and do not read any file yourself: (1) Which port does the config set? (2) What is the FX spread in the rates module? (3) What codename does the README give? Then answer all three in a short list.');
    await finish(session, 8 * 60_000);
    const observed = await stop();
    const text = reply(session);
    const agents = session.data.agents;
    const parentTools = session.data.events.filter(event => event.type === 'tool.started').map(event => event.tool);
    const result = { seconds: seconds(Date.now() - started), status: session.data.status, reply: text.slice(0, 600), parentTools, childTools: childTools(session), overlap: overlap(agents),
      peakRunning: observed.peakRunning, activities: observed.activities, snapshots: observed.snapshots, changes: observed.changes, spawn: spawnEvents(session), agents: agents.map(agentSummary) };
    result.checks = { calledSpawnAgents: parentTools.includes('agents.spawn'), threeAgentsCompleted: agents.length === 3 && agents.every(agent => agent.status === 'completed'),
      ranConcurrently: result.overlap === 3, childrenReadOnly: result.childTools.length > 0 && result.childTools.every(tool => READ_TOOLS.has(tool)),
      reportsHoldAnswers: Object.values(answers).every(answer => agents.some(agent => mentions(agent.report, answer))), replyUsesReports: Object.values(answers).every(answer => mentions(text, answer)),
      activityLineUpdated: observed.activities.some(activity => activity === 'Thinking') && observed.activities.some(activity => /^(read_file|search_files|list_files|git)/.test(activity)),
      idle: session.data.status === 'idle' };
    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  });

  await run('c', async () => {
    const words = colours().slice(0, 4);
    const session = await open('four', Object.fromEntries(words.map((value, index) => [`part-${index + 1}.txt`, `Style guide, part ${index + 1}\n\nButtons in this part use the colour ${value}.\n`])));
    const baseline = byComm(await descendants());
    // Other checks' queries (b's parent, held open) count in the baseline.
    const baseThreads = provider === 'claude' ? agentOf().threads.size : 0;
    const stop = watch(session, { processes: true, extra: () => (provider === 'codex' ? agentOf().child?.pid ?? null : agentOf().threads.size - baseThreads) });
    const started = Date.now();
    store.send(session.data.id, 'Call spawn_agents once with exactly four agents named w1, w2, w3 and w4. The brief for agent wN is: "Read part-N.txt and report which colour its buttons use." (with N replaced by 1, 2, 3 or 4). Do not read any file yourself. Then list the four colours.');
    await finish(session, 8 * 60_000);
    const observed = await stop();
    const text = reply(session);
    const agents = session.data.agents;
    const result = { seconds: seconds(Date.now() - started), status: session.data.status, reply: text.slice(0, 300), overlap: overlap(agents), peakRunning: observed.peakRunning,
      baselineProcesses: baseline, processPeaks: observed.processPeaks, agents: agents.map(agentSummary), childTools: childTools(session) };
    if (provider === 'codex') result.appServerPids = [...new Set(observed.extra.filter(Boolean))];
    else result.peakClaudeThreads = Math.max(0, ...observed.extra);
    const claudeExtra = (observed.processPeaks.claude?.count ?? 0) - (baseline.claude?.count ?? 0);
    result.checks = { fourCompleted: agents.length === 4 && agents.every(agent => agent.status === 'completed'), fourAtOnce: result.overlap === 4 && observed.peakRunning === 4,
      replyUsesReports: words.every(value => mentions(text, value)),
      ...(provider === 'codex' ? { oneAppServer: result.appServerPids.length === 1 && (observed.processPeaks.codex?.count ?? 0) - (baseline.codex?.count ?? 0) <= 1 }
        : { fourChildQueriesUnderParent: result.peakClaudeThreads >= 5 && claudeExtra >= 5 }) };
    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  });

  await run('d', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`module-${index + 1}.mjs`, `// Module ${index + 1} of the ledger.\nexport const label${index + 1} = '${place()}';\nexport function part${index + 1}(value) { return value * ${index + 2}; }\n`]));
    const session = await open('cancel', files);
    const baseline = byComm(await descendants());
    const lateReads = [];
    const readTool = session.readTool.bind(session);
    let cancelAt = null;
    session.readTool = (...call) => { if (cancelAt) lateReads.push(call[0]); return readTool(...call); };
    const stop = watch(session, { processes: true });
    store.send(session.data.id, 'Call spawn_agents once with four agents named s1, s2, s3 and s4. Each brief: "List the files, then read every file one at a time, then search the workspace for the word ledger, then report one line per file." Do not read any file yourself.');
    const agents = () => session.data.agents ?? [];
    const ready = await Promise.race([(async () => { while (!(agents().filter(agent => agent.status === 'running').length >= 3 && agents().filter(agent => agent.calls >= 1).length >= 2) && !['idle', 'failed'].includes(session.data.status)) await sleep(100); return true; })(), sleep(5 * 60_000, false)]);
    cancelAt = Date.now();
    const before = agents().map(agent => ({ name: agent.name, status: agent.status, calls: agent.calls, activity: agent.activity }));
    session.cancel();
    const afterCancel = agents().map(agent => agent.status);
    const lengths = agents().map(agent => agent.events.length);
    await session.task;
    // Stopped: none of this session's threads (parent and children) has a turn left on the app-server, or a Claude
    // query in flight, and no Claude Code process beyond those that were running before the check.
    const threadIds = [session.data.threadId, ...agents().map(agent => agent.threadId)].filter(Boolean);
    const stopped = async () => {
      if (provider === 'codex') return !threadIds.some(id => agentOf().turns.has(id));
      const claude = (await descendants()).filter(row => row.comm === 'claude').length;
      return !threadIds.some(id => agentOf().threads.has(id)) && claude <= (baseline.claude?.count ?? 0);
    };
    while (!(await stopped()) && Date.now() - cancelAt < 60_000) await sleep(100);
    const stopSeconds = seconds(Date.now() - cancelAt);
    await sleep(5000);
    const observed = await stop();
    const result = { readyBeforeCancel: ready, before, afterCancel, stopSeconds, lateReads, lateEvents: agents().reduce((sum, agent, index) => sum + agent.events.length - lengths[index], 0),
      status: session.data.status, finalStatuses: agents().map(agent => agent.status), processPeaks: observed.processPeaks, agents: agents().map(agentSummary) };
    result.checks = { cancelledDuringFanOut: ready === true && before.filter(agent => agent.status === 'running').length >= 3,
      stoppedWithinFiveSeconds: stopSeconds <= 5, noRunningAgent: !result.finalStatuses.some(status => status === 'running' || status === 'queued') && !afterCancel.some(status => status === 'running' || status === 'queued'),
      nothingAfterCancel: lateReads.length === 0 && result.lateEvents === 0, sessionCancelled: session.data.status === 'cancelled' };
    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  });

  await run('f', async () => {
    const session = await open('resend', Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`note-${index + 1}.txt`, `Note ${index + 1}: the kitchen closes at ${index + 5} pm.\n`])));
    store.send(session.data.id, 'Read each note file one at a time with read_file, then summarize them in one line.');
    await Promise.race([(async () => { while (!session.data.events.some(event => event.type === 'tool.started') && ['thinking', 'running'].includes(session.data.status)) await sleep(50); })(), sleep(3 * 60_000)]);
    const thread = session.data.threadId; const first = session.task;
    const cancelledAt = Date.now();
    session.cancel();
    // At once, before Codex has confirmed the interrupt (or Claude Code has stopped): the new turn must wait for it, not fail.
    let sendError = null;
    try { store.send(session.data.id, 'Reply with just the word ready.'); } catch (error) { sendError = error.message; }
    await first; await finish(session, 3 * 60_000);
    const text = reply(session);
    const result = { sendError, secondTurnSeconds: seconds(Date.now() - cancelledAt), status: session.data.status, reply: text.slice(0, 200),
      errors: session.data.events.filter(event => event.type === 'session.error').map(event => event.message) };
    result.checks = { sentAtOnce: sendError === null, completed: session.data.status === 'idle' && result.errors.length === 0, sameThread: session.data.threadId === thread, replied: mentions(text, 'ready') };
    result.ok = Object.values(result.checks).every(Boolean);
    return result;
  });

  await run('e', async () => {
    const session = await open('weight', { 'a.txt': 'a\n' });
    const time = new Date().toISOString();
    const report = 'Findings: '.padEnd(2000, 'x');
    session.data.agents = Array.from({ length: 24 }, (_, index) => ({ id: `agent-${index}`, group: `g${index % 3}`, name: `agent-${index}`, brief: 'Review one module and report.'.padEnd(600, '.'),
      status: 'completed', threadId: `t${index}`, model, effort, startedAt: time, endedAt: time, calls: 40, activity: '', usage: { input_tokens: 90_000, cached_input_tokens: 60_000, output_tokens: 3000 },
      report, error: '', sequence: 400, messages: [{ id: 'm0', role: 'user', content: 'Review one module and report.', time }, { id: 'm1', role: 'assistant', content: report, time }],
      events: Array.from({ length: 400 }, (_, n) => ({ type: ['chat.started', 'chat.completed', 'tool.started', 'tool.completed'][n % 4], id: `e${index}-${n}`, effectId: `x${index}-${Math.floor(n / 2)}`, sequence: n + 1, time,
        tool: 'workspace.read', input: { path: `src/module-${n}.mjs` }, label: `agent-${index}` })) }));
    const rounds = 20; let bytes = 0; const started = performance.now();
    for (let i = 0; i < rounds; i++) bytes = JSON.stringify(session.snapshot()).length;
    const perSnapshotMs = Math.round((performance.now() - started) / rounds * 10) / 10;
    session.data.agents = [];
    return { agents: 24, eventsPerAgent: 400, snapshotBytes: bytes, perSnapshotMs, ok: true, note: 'clone + JSON of the whole session per snapshot; at most 20 snapshots a second after coalescing' };
  });

  await slow;
  // Claude Code keeps a transcript per query under the workspace's project folder; remove those this run made.
  if (provider === 'claude') {
    for (const session of sessions) {
      for (const id of [session.data.threadId, ...(session.data.agents ?? []).map(agent => agent.threadId)].filter(Boolean)) await deleteSession(id, { dir: session.data.workspace }).catch(() => {});
      await rmdir(resolve(process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'), 'projects', session.data.workspace.replace(/[^a-zA-Z0-9]/g, '-'))).catch(() => {});
    }
  }
  await store.close();
  // The killed app-server may still be writing its thread files for a moment.
  await sleep(1000);
  await rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(error => { summary.cleanup = error.message; });
  summary.ok = Object.values(summary.results).every(result => result.ok);
  return summary;
}

const providers = providerArg === 'both' ? ['codex', 'claude'] : [providerArg];
const summaries = [];
for (const provider of providers) {
  const summary = await runProvider(provider);
  summaries.push(summary);
  console.log(JSON.stringify(summary, (key, value) => (key === 'extra' ? undefined : value), 2));
}
process.exit(summaries.every(summary => summary.ok) ? 0 : 1);
