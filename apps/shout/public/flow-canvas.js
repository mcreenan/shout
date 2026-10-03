// Flow canvas: a session drawn as top-to-bottom phases of cards on a pannable canvas.
// Each instance owns its stage and is fed by its own source (the chat's Flow mode; sub-agent tabs can
// mount more). Leaf cards are selected, and their detail shows elsewhere through `onSelect`; only
// structure expands in place: a loop group shows one iteration's cards in a frame, a stack lists its steps.
import { phases, toolKind } from './flow-graph.js';
import { renderMarkdown } from './markdown-dom.js';
import { buildFlow, formatDuration, modelTask, modelOutput, toolResult, stepFailed, failureLine, plural, tokens, clip, issueLabel } from './flow.js';

const MAX_ROW = 980; // rows wrap past this width (or the stage width, if narrower)
const GAP_X = 18, GAP_Y = 16, MIN_CARD = 230;
// Space above a row: tight within a causal chain, more where edges fan out or in, loose at a new turn.
// It is never proportional to time; a long pause gets a marker (IDLE_PAD above and below it) instead.
const GAP = { chain: 18, fan: 36, turn: 70 };
const IDLE_PAD = 12, PILE = 9; // PILE: the retry sheets showing under a card
const FRAME = { head: { run: 34, loop: 34, group: 14 }, foot: 16, side: 20, nest: 14 };
const TOP_INSET = 58; // by default the Chat/Flow switch and the Inspector button float over the stage's top edge
const ICON = { ok: 'M5 12.5l4.5 4.5L19 7.5', no: 'M6.5 6.5l11 11M17.5 6.5l-11 11', chevron: 'M9 6l6 6-6 6', prev: 'M14.5 6l-6 6 6 6' };
// What a call does (toolKind), drawn on compact cards, burst rows and input chips.
const KIND_ICON = {
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.6-4.6"/>',
  read: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  list: '<path d="M3 7.5a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  write: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>',
  test: '<path d="M7 4h10M9 4v5l-4.5 8.5A2 2 0 006.3 20.5h11.4a2 2 0 001.8-3L15 9V4"/><path d="M7 15h10"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-7 3-11.5 8.5"/>',
  agent: '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="19" r="2.4"/><circle cx="19" cy="19" r="2.4"/><path d="M12 7.4V12M12 12l-6.2 4.8M12 12l6.2 4.8"/>',
  run: '<path d="M5 7l5 5-5 5M12.5 17H19"/>',
  tool: '<circle cx="12" cy="12" r="3.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
};
const AMBIENT = new Set(['search', 'read', 'list', 'git']);
const TILE_LIMIT = 12; // more iterations than this draw as numbered cells
const PIP_LIMIT = 80;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgIcon(path, className = 'fl-icon') {
  const span = el('span', className);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  return span;
}
function kindIcon(kind, className = `fl-kind${AMBIENT.has(kind) ? ' ambient' : ''}`) {
  const span = el('span', className);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${KIND_ICON[kind] || KIND_ICON.tool}</svg>`;
  return span;
}
// The verb a call reads as: its kind, or the tool's own name when it has none.
const verbOf = (label) => (toolKind(label) === 'tool' ? label : toolKind(label));
const basename = (path) => String(path).split('/').filter(Boolean).pop() || String(path);
// Retried requests show the attempts behind them as a pile of sheets.
const piled = (node) => node.step?.attempts?.length > 1;
function button(className, act, ...children) {
  const node = el('button', className);
  node.type = 'button';
  if (act) node.dataset.act = act;
  node.append(...children.filter(Boolean));
  return node;
}
const isLive = (status) => status === 'active' || status === 'waiting';
// Exponential easing: always approaches, never overshoots.
const ease = (current, target, dt, tau) => current + (target - current) * (1 - Math.exp(-dt / tau));
// The latest matching event: after a retry, the last attempt's.
const eventOf = (step, type) => (step.attempts?.at(-1)?.events ?? step.events).findLast((event) => event.type === type);
// Model prose on one or two card lines: Markdown punctuation only gets in the way.
const plain = (text) => String(text).replace(/```[\s\S]*?```/g, ' ').replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '').replace(/\*\*|__|`/g, '');

/* Cards: content only. State is carried by treatment (glow, colour, icon), never by words.
   Always visible: kind dot, title, outcome, one result line, error, live timer. Everything else is
   on hover (short durations, full paths, start time) or in the selected step's detail. */
// Durations tick while running; under a second they wait for hover or focus.
function timer(start, end) {
  const span = el('span', 'fl-time');
  if (!Number.isFinite(start)) return span;
  Object.assign(span, { start, end: end ?? null });
  span.title = new Date(start).toLocaleTimeString();
  return span;
}
// A pause between rows, roughly: `18m`, `2h 5m`, `3d`.
function idleText(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `${Math.round(minutes / 1440)}d`;
}
function head(title, ...extra) {
  const row = el('div', 'fl-head');
  row.append(el('i', 'fl-dot'), el('strong', 'fl-title', title), ...extra.filter(Boolean));
  return row;
}
// Retried requests (answers that failed validation) are one card: `attempt 2` while it runs, `2 attempts` after.
function attemptChip(node) {
  const attempts = node.step.attempts;
  if (!attempts || attempts.length < 2) return null;
  return el('span', 'fl-chip retry', isLive(node.status) ? `attempt ${attempts.at(-1).attempt}` : `${attempts.length} attempts`);
}
const issueText = (issues) => issues.map((issue) => `${issue.path || '/'} ${issueLabel(issue)}`).join(' · ');
// A judgment's timer also carries its token count, for hover.
function usageTimer(step) {
  const time = timer(step.start, step.end);
  const usage = step.events.filter((event) => event.usage).reduce((sum, event) => ({ input_tokens: sum.input_tokens + (event.usage.input_tokens || 0), output_tokens: sum.output_tokens + (event.usage.output_tokens || 0) }), { input_tokens: 0, output_tokens: 0 });
  if (tokens(usage) && time.title) time.title += ` · ${tokens(usage)}`;
  return time;
}
function outcome(e, ok, tone = ok ? 'pass' : 'fail') {
  e.classList.add(tone);
  return svgIcon(ok ? ICON.ok : ICON.no);
}
function stateMark(status) {
  const mark = el('i', `fl-state ${status}`);
  if (status === 'ok') mark.append(svgIcon(ICON.ok, ''));
  if (status === 'failed' || status === 'declined') mark.append(svgIcon(ICON.no, ''));
  return mark;
}
function failCount(count) {
  const mark = el('span', 'fl-fails');
  mark.append(stateMark('failed'), String(count));
  return mark;
}
// One pip per step, coloured by kind; long strips merge neighbours, keeping the most telling one.
const RANK = { x: 4, w: 3, m: 2, t: 1, ok: 1, a: 0 };
function pips(list) {
  const bar = el('span', 'fl-pips');
  const size = Math.ceil(list.length / PIP_LIMIT);
  for (let i = 0; i < list.length; i += size) {
    const bucket = list.slice(i, i + size);
    const live = bucket.find((pip) => pip.endsWith('live'));
    bar.append(el('i', live || bucket.reduce((best, pip) => (RANK[pip] > RANK[best] ? pip : best))));
  }
  return bar;
}
function fullArg(step) {
  const input = eventOf(step, 'tool.started')?.input;
  if (Array.isArray(input?.args)) return input.args.join(' ');
  if (Array.isArray(input?.paths)) return input.paths.join('\n');
  return step.detail;
}

function renderHub(e, node) {
  const { step } = node;
  if (step.pair === 'chat') {
    // SHOUT's agent thinking between actions: the action it chose next, if any.
    const next = eventOf(step, 'chat.completed')?.tool;
    e.append(head('Agent', next && el('span', 'fl-chip strong', next.replace(/_/g, ' ')), usageTimer(step)));
    return;
  }
  const failed = eventOf(step, 'model.failed');
  // Every answer failed the output type (the program took its Err branch): say why, not what was said.
  const rejected = !failed && step.attempts?.at(-1)?.status === 'rejected' && !isLive(node.status);
  const out = modelOutput(rejected ? null : eventOf(step, 'model.completed')?.value);
  const findings = out.items.filter((item) => item.tone !== 'edit').length;
  const edited = out.items.length - findings;
  const fact = out.files.length ? plural(out.files.length, 'files') : findings ? plural(findings, 'findings') : edited ? plural(edited, 'files') : '';
  e.append(head('Model', (failed || rejected) && outcome(e, false), attemptChip(node), fact && el('span', 'fl-chip', fact), usageTimer(step)));
  if (failed) e.append(el('div', 'fl-text error clamp2', failed.error?.message || failed.message || 'Failed'));
  else if (rejected) { const issues = step.attempts.findLast((attempt) => attempt.issues.length)?.issues || []; if (issues.length) e.append(el('div', 'fl-text error clamp2', issueText(issues))); }
  else if (isLive(node.status)) { const { task } = modelTask(eventOf(step, 'model.started')?.prompt); if (task) e.append(el('div', 'fl-text muted clamp1', task)); }
  else if (node.outcome || out.text) e.append(el('div', 'fl-text clamp2', plain(node.outcome || out.text)));
  else if (out.items[0]) e.append(el('div', 'fl-text clamp1', out.items[0].title));
  if (node.inputs?.length) e.append(inputsRow(node.inputs));
}
// The reads a judgment consumed: a quiet footer of chips inside its card. Each selects its step.
function inputName(step) {
  const input = eventOf(step, 'tool.started')?.input || {};
  const kind = toolKind(step.label);
  if (kind === 'search') return `"${clip(input.query ?? input.pattern ?? step.detail, 24)}"`;
  if (Array.isArray(input.paths) && input.paths.length > 1) return `${basename(input.paths[0])} +${input.paths.length - 1}`;
  if (!step.detail) return step.label.split('.').pop();
  return clip(kind === 'read' && !/\s/.test(step.detail) ? basename(step.detail) : step.detail, 32);
}
function inputsRow(steps) {
  const row = el('div', 'fl-inputs');
  for (const step of steps) {
    const chip = button(`fl-in${stepFailed(step) ? ' fail' : ''}`, 'row', kindIcon(toolKind(step.label), ''), inputName(step));
    chip.dataset.step = step.id;
    chip.title = `${step.label}${fullArg(step) ? ` ${fullArg(step)}` : ''}`;
    row.append(chip);
  }
  return row;
}
// A settled secondary or ambient call: one line, sized to its content.
function renderCompact(e, node) {
  const { step } = node;
  const value = eventOf(step, 'tool.completed')?.value || {};
  const tested = typeof value.passed === 'boolean' && !value.skipped;
  const result = toolResult(step);
  // A call with no argument reads as its tool's name.
  const arg = el('span', 'fl-cmp-arg', step.detail || step.label);
  arg.title = `${step.label}${fullArg(step) ? ` ${fullArg(step)}` : ''}`;
  e.classList.add('compact');
  e.append(...[kindIcon(toolKind(step.label)), step.detail && el('span', 'fl-cmp-verb', verbOf(step.label)), arg, result && !['passed', 'failed'].includes(result) && el('span', 'fl-cmp-res', result),
    timer(step.start, step.end), tested ? outcome(e, value.passed) : stateMark(step.status === 'stale' ? 'stale' : 'ok')].filter(Boolean));
}
function renderTool(e, node) {
  if (node.tier > 1) return renderCompact(e, node);
  const { step } = node;
  const value = eventOf(step, 'tool.completed')?.value || {};
  const failure = eventOf(step, 'tool.failed');
  // Outcomes are icons: a check for passing tests, a cross for failures.
  const icon = failure || stepFailed(step) ? outcome(e, false) : typeof value.passed === 'boolean' && !value.skipped ? outcome(e, true) : null;
  const result = failure ? '' : toolResult(step);
  e.append(head(step.label, icon, result && !['passed', 'failed'].includes(result) && el('span', 'fl-chip', result), timer(step.start, step.end)));
  if (step.detail) { const arg = el('div', 'fl-code', step.detail); arg.title = fullArg(step); e.append(arg); }
  const problem = failure ? failure.error?.message || 'Failed' : failureLine(step);
  if (problem) e.append(el('div', 'fl-text error clamp2', problem));
}
function renderApproval(e, node) {
  const { step } = node;
  const asked = eventOf(step, 'user.question') || {};
  const value = eventOf(step, 'user.answered')?.value;
  if (step.label === 'Approval' && value && !isLive(node.status)) {
    // Answered: one line, what you decided and how long it waited.
    const question = asked.title || asked.command || asked.summary;
    const text = question && el('span', 'fl-cmp-arg', question);
    if (text) text.title = question;
    e.classList.add('compact', 'answered');
    e.append(...[stateMark(value.accept === false ? 'declined' : 'ok'), el('strong', 'fl-cmp-title', value.accept === false ? 'Declined' : value.accept === true ? 'Approved' : 'Answered'), text, timer(step.start, step.end)].filter(Boolean));
    return;
  }
  const icon = value?.accept === true ? outcome(e, true) : value?.accept === false ? outcome(e, false, 'declined') : null;
  e.append(head(step.label, icon, attemptChip(node), timer(step.start, step.end)));
  const text = asked.title || asked.command || asked.prompt?.system || asked.summary;
  if (text) e.append(el('div', 'fl-text clamp2', text));
}
function renderNote(e, node) {
  const { step } = node;
  if (node.tier > 1) {
    e.classList.add('compact');
    e.append(...[el('i', 'fl-dot'), el('strong', 'fl-cmp-title', step.label), step.detail && el('span', 'fl-cmp-arg muted', step.detail)].filter(Boolean));
    return;
  }
  e.append(head(step.label));
  if (step.detail) e.append(el('div', `fl-text clamp2${step.status === 'failed' ? ' error' : ''}`, step.detail));
}
function renderMessage(e, node, ctx) {
  const { message } = node;
  if (message.role === 'user') return e.append(el('div', 'fl-text', message.content));
  // Earlier replies are clamped here and read in full from the detail; the closing one is the answer.
  const body = el('div', `fl-md${node.final ? '' : ' clamped'}`);
  ctx.markdown(body, message.content);
  e.append(body);
}
// A structure's header toggles it; the whole row is the target, the title is the keyboard control.
function structureHead(node, title, count, ...extra) {
  const top = el('div', 'fl-head');
  top.dataset.act = 'toggle';
  // A loop's header is code; a stack of one tool is named by the tool.
  const toggle = button('fl-toggle', 'toggle', el('i', 'fl-dot'), el('strong', `fl-title${node.bare ? '' : ' code'}`, title), el('span', 'fl-count', count));
  toggle.setAttribute('aria-expanded', String(node.open !== null && node.open !== false));
  top.append(...[toggle, node.failed && failCount(node.failed), ...extra, timer(node.start, node.end), svgIcon(ICON.chevron, 'fl-chevron')].filter(Boolean));
  return top;
}
// A loop whose iterations take several steps: one tile per iteration; the open one's cards follow in a frame.
function renderGroup(e, node) {
  const count = node.iterations.length;
  const at = node.iterations.findIndex((iteration) => iteration.index === node.open);
  const stepper = at >= 0 && el('span', 'fl-stepper');
  if (stepper) {
    const prev = button('fl-step', 'prev', svgIcon(ICON.prev, ''));
    const next = button('fl-step next', 'next', svgIcon(ICON.prev, ''));
    prev.setAttribute('aria-label', 'Previous iteration');
    next.setAttribute('aria-label', 'Next iteration');
    prev.disabled = at === 0;
    next.disabled = at === count - 1;
    stepper.append(prev, el('span', '', `#${node.open}`), next);
  }
  e.append(structureHead(node, node.title, node.ended ? `${count}×` : String(count), stepper));
  const compact = count > TILE_LIMIT;
  const grid = el('div', `fl-tiles${compact ? ' compact' : ''}`);
  for (const iteration of node.iterations) {
    const tile = button(`fl-tile ${iteration.status}${node.open === iteration.index ? ' open' : ''}`, 'iter');
    tile.dataset.index = iteration.index;
    tile.setAttribute('aria-pressed', String(node.open === iteration.index));
    if (compact) { tile.append(el('span', 'fl-tile-n', String(iteration.index))); tile.title = iteration.activity; }
    else {
      const top = el('span', 'fl-tile-top');
      top.append(stateMark(iteration.status), el('span', 'fl-tile-n', `#${iteration.index}`), timer(iteration.start, iteration.end));
      tile.append(top, el('span', 'fl-tile-now', iteration.activity), pips(iteration.pips));
    }
    grid.append(tile);
  }
  e.append(grid);
}
// `kinded` rows (a burst's) lead with what the call does: an icon and a verb, then its argument.
function stepRow(step, bare, kinded = false) {
  const status = step.status === 'active' && step.pair === 'user' ? 'waiting' : step.status;
  const row = button(`fl-row ${status}${stepFailed(step) ? ' fail' : ''}`, 'row');
  row.dataset.step = step.id;
  const label = kinded ? step.detail || step.label : bare ? step.detail || step.label : step.pair === 'model' ? 'Model' : `${step.label}${step.detail ? ` ${step.detail}` : ''}`;
  const result = step.pair === 'tool' && !stepFailed(step) ? toolResult(step) : step.attempts?.length > 1 ? `${step.attempts.length} attempts` : '';
  const arg = el('span', 'fl-row-arg', label);
  arg.title = kinded ? `${step.label}${fullArg(step) ? ` ${fullArg(step)}` : ''}` : fullArg(step) || label;
  const lead = kinded ? [kindIcon(toolKind(step.label)), el('span', 'fl-cmp-verb', verbOf(step.label))] : [el('i', `fl-row-dot ${step.pair === 'user' ? 'user' : step.kind}`)];
  row.append(...lead, arg, el('span', 'fl-row-result', ['passed', 'failed'].includes(result) ? '' : result), timer(step.start, step.end), stateMark(isLive(status) || status === 'stale' ? status : stepFailed(step) ? 'failed' : 'ok'));
  const item = el('li');
  item.append(row);
  return item;
}
// A loop that takes one step per iteration: a count and a strip; expanded, one row per step.
function renderStack(e, node) {
  const count = node.steps.length;
  e.append(structureHead(node, node.title, node.ended ? `×${count}` : String(count)));
  if (!node.open) {
    const line = node.bare ? node.outcome : node.activity;
    if (line) e.append(el('div', node.bare && node.steps[0].pair === 'model' ? 'fl-text clamp1' : 'fl-code', line));
    e.append(pips(node.pips));
    return;
  }
  const list = el('ol', `fl-rows${node.bare ? ' bare' : ''}`);
  for (const step of node.steps) list.append(stepRow(step, node.bare));
  e.append(list);
}
// One task of an await block: its steps in order.
function renderTrack(e, node) {
  e.append(head(node.title, node.failed && failCount(node.failed), timer(node.start, node.end)));
  const list = el('ol', 'fl-rows');
  for (const step of node.steps) list.append(stepRow(step, false));
  e.append(list);
}
/* Bursts: consecutive calls as one card. Open (a row per call) while it holds the live step or you pin it;
   otherwise one line keeping what matters: the count, the kinds, failures and files written as chips, the strip. */
const MIX = [['read', 'reads'], ['edit', 'edits'], ['test', 'tests'], ['run', 'commands'], ['other', 'other calls']];
const mixText = (mix) => MIX.filter(([key]) => mix[key]).map(([key, noun]) => plural(mix[key], noun)).join(', ');
function burstChips(node) {
  const chips = node.fails.map(({ label, count }) => { const chip = el('span', 'fl-xchip'); chip.append(svgIcon(ICON.no, ''), `${label} · ${count} failed`); return chip; });
  if (node.writes.length) {
    const chip = el('span', 'fl-wchip');
    chip.title = node.writes.join('\n');
    chip.append(kindIcon('edit', ''), node.writes[0]);
    if (node.writes.length > 1) chip.append(el('em', '', ` +${node.writes.length - 1}`));
    chips.push(chip);
  }
  return chips;
}
function renderBurst(e, node) {
  const count = node.steps.length;
  const top = el('div', 'fl-head');
  const title = el('strong', 'fl-title', plural(count, 'calls'));
  if (node.current) top.append(el('i', 'fl-dot'), title);
  else {
    // Folded or pinned, the header is the toggle.
    top.dataset.act = 'toggle';
    const toggle = button('fl-toggle', 'toggle', svgIcon(ICON.chevron, 'fl-chevron'), title);
    toggle.setAttribute('aria-expanded', String(node.open));
    top.append(toggle);
  }
  if (!node.current) top.append(el('span', 'fl-mix', mixText(node.mix)));
  if (!node.open) {
    top.append(...burstChips(node), pips(node.pips), timer(node.start, node.end));
    e.classList.add('collapsed');
    e.append(top);
    return;
  }
  top.append(timer(node.start, node.end));
  const list = el('ol', 'fl-rows burst');
  for (const step of node.steps) {
    list.append(stepRow(step, false, true));
    const problem = stepFailed(step) && (eventOf(step, 'tool.failed')?.error?.message || failureLine(step));
    if (problem) list.append(el('li', 'fl-row-err', problem));
  }
  e.append(top, list);
}
/* Sub-agents: a fan-out is one fleet card with a tile per agent (Flow B of the sub-agent design). */
const AGENT_STATE = { queued: 'queued', running: 'active', completed: 'ok', failed: 'failed', cancelled: 'stale', interrupted: 'stale' };
const FLEET_PIPS = 8;
const agentsOf = (node, ctx) => (ctx.session?.agents || []).filter((agent) => agent.group === node.group);
// What a tile says: the running agent's current step (tool calls take milliseconds, so the latest one
// stands in while the model thinks), the first line of a report, or the error.
function agentLine(agent) {
  if (agent.status === 'failed') return agent.error || 'Failed';
  if (agent.status === 'completed') return clip(String(agent.report || '').replace(/^[#>*\s-]+/gm, '').split('\n').find((line) => line.trim()) || '', 90);
  if (agent.status !== 'running') return '';
  if (agent.activity && agent.activity !== 'Thinking') return agent.activity;
  const call = agent.events?.findLast((event) => event.type === 'tool.started');
  const input = call?.input || {};
  const arg = input.path || (input.query && `"${input.query}"`) || (Array.isArray(input.args) && input.args[0]) || '';
  return call ? `${call.tool}${arg ? ` ${arg}` : ''}` : agent.activity || 'Thinking';
}
// The agent's latest steps, coloured by kind; empty slots until it has taken that many.
function agentPips(agent) {
  // Built live while the agent runs, so its open step stays active (and pulses) rather than stale.
  const steps = buildFlow(agent.events || [], { live: agent.status === 'running' }).flatMap((segment) => segment.steps).filter((step) => step.pair === 'chat' || step.pair === 'tool');
  const pips = steps.slice(-FLEET_PIPS).map((step) => (stepFailed(step) ? 'x' : step.pair === 'chat' ? 'm' : 't') + (step.status === 'active' ? ' live' : ''));
  const bar = el('span', 'fl-pips');
  for (let i = 0; i < FLEET_PIPS; i++) bar.append(el('i', pips[i] || 'empty'));
  return bar;
}
function renderFleet(e, node, ctx) {
  const agents = agentsOf(node, ctx);
  const input = eventOf(node.step, 'tool.started')?.input || {};
  const count = agents.length || input.agents?.length || 0;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const top = head(`${count} agent${count === 1 ? '' : 's'}`, input.purpose && el('span', 'fl-role', input.purpose), failed && failCount(failed), timer(node.step.start, node.step.end));
  e.append(top);
  const grid = el('div', 'fl-tiles fleet');
  for (const agent of agents) {
    const status = AGENT_STATE[agent.status] || 'stale';
    const tile = button(`fl-tile fleet-tile ${status}`, 'agent');
    tile.dataset.agent = agent.id;
    const top = el('span', 'fl-tile-top');
    top.append(stateMark(status), el('span', 'fl-tile-n', agent.name));
    if (agent.startedAt) top.append(timer(Date.parse(agent.startedAt), agent.endedAt ? Date.parse(agent.endedAt) : null));
    tile.append(top, el('span', 'fl-tile-now', agentLine(agent)), agentPips(agent));
    tile.title = agent.brief || '';
    grid.append(tile);
  }
  e.append(grid);
}
const leafSig = (node) => [node.status, node.step?.events.length, node.step?.end, node.message?.id, node.message?.content.length, node.final];
const stepsSig = (steps) => steps.map((step) => `${step.id}:${step.status}:${step.events.length}`).join();
/**
 * Node types. Each is { render(e, node, ctx), sig(node, ctx), select?(node), act?(node, control, ctx) }:
 * `render` fills the card, `sig` lists what it depends on (it re-renders when that changes), `select`
 * makes it a selectable leaf, and `act` handles clicks on its own `[data-act]` controls. A later type
 * (e.g. a fleet of sub-agents) is added with `createFlowCanvas(stage, { types: { fleet: {...} } })`.
 */
export const NODE_TYPES = {
  msg: { render: renderMessage, sig: leafSig, select: (node) => node.message.role !== 'user' },
  hub: { render: renderHub, sig: leafSig, select: () => true },
  tool: { render: renderTool, sig: leafSig, select: () => true },
  approval: { render: renderApproval, sig: leafSig, select: () => true },
  note: { render: renderNote, sig: leafSig, select: () => true },
  group: { render: renderGroup, sig: (node) => [node.status, node.open, node.ended, node.failed, node.title, node.iterations.map((it) => [it.index, it.status, it.pips.join(), it.activity, it.end])] },
  stack: { render: renderStack, sig: (node) => [node.status, node.open, node.ended, node.failed, node.title, node.activity, node.open ? stepsSig(node.steps) : node.pips.join()] },
  track: { render: renderTrack, sig: (node) => [node.status, node.title, node.failed, stepsSig(node.steps)] },
  burst: { render: renderBurst, sig: (node) => [node.status, node.open, node.current, stepsSig(node.steps)] },
  // Tiles open their agent (the canvas's `openAgent` option).
  fleet: {
    render: renderFleet,
    sig: (node, ctx) => [node.status, node.step.end, agentsOf(node, ctx).map((agent) => [agent.id, agent.status, agent.calls, agentLine(agent), agent.events?.length, agent.endedAt])],
    act: (node, control, ctx) => { if (control.dataset.act === 'agent') ctx.options.openAgent?.(control.dataset.agent); },
  },
};

/**
 * Mounts a canvas in `stage`. Call `start(source)` with a function returning
 * { session, events, now, live } (or null) each frame. `anchor` is the gap in px between the
 * stage bottom and the followed card's bottom edge: a number, or a function for UI floating over
 * the stage (it is re-read every frame and eased, so the canvas glides when that UI resizes).
 * `onSelect(selection | null)` hears the selected step or message: { id, step | message, segment, node, session },
 * again whenever it changes. `top` is the px kept clear at the stage's top edge (for floating controls).
 * `openAgent(id)` opens a sub-agent from its fleet tile. `types` adds or
 * overrides node types. The source may also give `actor` ({ name, kind }) when it shows a sub-agent.
 */
export function createFlowCanvas(stage, options = {}) {
  const { anchor = 120, top: topInset = TOP_INSET, openFile, onSelect = () => {}, types: extraTypes = {} } = options;
  const types = { ...NODE_TYPES, ...extraTypes };
  // A node type nobody registered still shows as a plain card.
  const typeOf = (node) => types[node.type] || { render: (e) => e.append(head(node.title || node.step?.label || node.type)), sig: leafSig };
  stage.classList.add('flow-stage');
  const world = el('div', 'fl-world');
  const framesLayer = el('div', 'fl-frames');
  const edgesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgesLayer.setAttribute('class', 'fl-edges');
  const nodesLayer = el('div', 'fl-nodes');
  const marksLayer = el('div', 'fl-marks');
  // Frames sit above the edges so an edge passes under a frame's label rather than through its text;
  // so do the markers of long pauses.
  world.append(edgesLayer, framesLayer, marksLayer, nodesLayer);
  const followButton = el('button', 'fl-follow');
  followButton.type = 'button';
  followButton.hidden = true;
  followButton.setAttribute('aria-label', 'Follow');
  followButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  stage.append(world, followButton);

  const anchorTarget = () => Math.max(0, typeof anchor === 'function' ? anchor() : anchor);
  const s = {
    anchor: anchorTarget(), sim: new Map(), frames: new Map(), marks: new Map(), rows: [], rowOf: new Map(), edges: [], index: new Map(), focus: null,
    follow: true, locked: null, snap: true, cam: { x: 0, y: 0, z: 1 }, sig: '', last: 0, top: 0, rowWidth: MAX_ROW, session: null, now: Date.now(),
    ui: { open: new Map(), stacks: new Set(), bursts: new Set() }, uiRev: 0, selected: null, selectionSig: '', dirty: true, moving: true, paint: true, edgesDirty: true, ticking: new Set(),
  };
  let source = null;
  let raf = 0;
  // What renderers get besides their node: Markdown, the session being drawn, and the canvas's options
  // (so a type can reach its own callbacks, e.g. opening a sub-agent).
  const ctx = { markdown: (container, text) => renderMarkdown(container, text, { openFile }), get session() { return s.session; }, options };
  const selectable = (node) => !!typeOf(node).select?.(node);

  // Cards can change size after rendering (fonts loading, markdown settling); layout and the follow
  // position always use their current size.
  const cardSizes = new ResizeObserver((records) => {
    for (const record of records) {
      const entry = record.target.entry;
      if (!entry || (entry.w === record.target.offsetWidth && entry.h === record.target.offsetHeight)) continue;
      entry.w = record.target.offsetWidth;
      entry.h = record.target.offsetHeight;
      fade(entry);
      s.dirty = true;
    }
  });
  // An earlier reply is clamped; it fades out only where its text is actually cut off.
  function fade(entry) {
    const body = entry.node?.type === 'msg' && entry.el.querySelector('.fl-md.clamped');
    if (body) body.classList.toggle('clipped', body.scrollHeight > body.clientHeight + 1);
  }
  // Natural sizes: every width is cleared before any is read, so a whole batch costs one reflow.
  function measure(entries) {
    for (const entry of entries) entry.el.style.width = '';
    for (const entry of entries) { Object.assign(entry, { natural: entry.el.offsetWidth, w: entry.el.offsetWidth, h: entry.el.offsetHeight }); fade(entry); }
  }
  function paintTimers(entry, now) {
    for (const time of entry.timers) {
      const value = (time.end ?? now) - time.start;
      time.textContent = formatDuration(value);
      time.classList.toggle('short', time.end !== null && value < 1000);
    }
    entry.live = entry.timers.filter((time) => time.end === null);
    if (entry.live.length) s.ticking.add(entry); else s.ticking.delete(entry);
  }
  // Re-rendering keeps keyboard focus on the same control.
  function focusKey(target, card) {
    if (target === card) return ':scope';
    if (target.dataset.step) return `[data-step="${CSS.escape(target.dataset.step)}"]`;
    if (target.dataset.act === 'iter') return `[data-act="iter"][data-index="${target.dataset.index}"]`;
    return target.dataset.act ? `button[data-act="${target.dataset.act}"]` : null;
  }
  function renderNode(entry, node) {
    const e = entry.el;
    const type = typeOf(node);
    const focused = e.contains(document.activeElement) ? focusKey(document.activeElement, e) : null;
    const pick = selectable(node);
    const expanded = node.open !== undefined && node.open !== null && node.open !== false;
    // Docked: an approval flush under the action it gates (`docked`), and that action (`dock-top`).
    const place = `${node.tier ? ` tier-${node.tier}` : ''}${node.dock ? ' docked' : ''}${node.docked ? ' dock-top' : ''}${piled(node) ? ' pile' : ''}`;
    e.className = `fl-card ${node.type} ${node.kind} ${node.status}${place}${node.final ? ' final' : ''}${pick ? ' selectable' : ''}${expanded ? ' expanded' : ''}${s.selected === node.id ? ' selected' : ''}${entry.placed ? '' : ' enter'}`;
    if (pick) { e.tabIndex = 0; e.setAttribute('role', 'button'); e.setAttribute('aria-pressed', String(s.selected === node.id)); }
    else { e.removeAttribute('tabindex'); e.removeAttribute('role'); e.removeAttribute('aria-pressed'); }
    e.replaceChildren();
    // The branch that led here sits on the card's top edge, where its incoming edge arrives.
    if (node.chip) { const chip = el('span', 'fl-branch', node.chip.label); chip.title = node.chip.title; e.append(chip); }
    type.render(e, node, ctx);
    entry.timers = [...e.querySelectorAll('.fl-time')].filter((time) => time.start !== undefined);
    paintTimers(entry, s.now);
    markRows(entry);
    if (focused) (focused === ':scope' ? e : e.querySelector(focused))?.focus({ preventScroll: true });
  }
  function markRows(entry) {
    for (const row of entry.el.querySelectorAll('[data-step]')) row.classList.toggle('selected', row.dataset.step === s.selected);
  }
  function markSelection() {
    for (const entry of s.sim.values()) {
      const on = entry.node.id === s.selected;
      if (entry.el.classList.contains('selected') !== on) { entry.el.classList.toggle('selected', on); if (entry.el.hasAttribute('aria-pressed')) entry.el.setAttribute('aria-pressed', String(on)); }
      if (entry.node.steps || entry.node.inputs) markRows(entry);
    }
  }
  // Tells the listener about the selection when it changes or its step records something new.
  function notifySelection() {
    const item = s.selected && s.index.get(s.selected);
    const sig = item ? JSON.stringify([s.selected, item.step?.events.length, item.step?.status, item.message?.content.length, s.session?.id]) : '';
    if (sig === s.selectionSig) return;
    s.selectionSig = sig;
    onSelect(item ? { id: s.selected, ...item, session: s.session } : null);
  }
  function select(id) {
    if (id && !s.index.has(id)) id = null;
    if (s.selected === id) return;
    s.selected = id;
    markSelection();
    notifySelection();
  }

  /* Scene: keyed cards and frames laid out in rows. New cards fade in where they belong; moves ease with no overshoot. */
  function sync(graph) {
    const seen = new Set();
    const rendered = [];
    for (const node of graph.nodes) {
      seen.add(node.id);
      let entry = s.sim.get(node.id);
      if (!entry) {
        entry = { el: el('div'), x: 0, y: 0, placed: false, sig: '', timers: [], live: [], transform: '' };
        entry.el.entry = entry;
        nodesLayer.append(entry.el);
        cardSizes.observe(entry.el, { box: 'border-box' });
        s.sim.set(node.id, entry);
      }
      entry.node = node;
      const sig = JSON.stringify([node.type, node.kind, node.chip?.label, node.tier, node.dock, node.docked, node.outcome, node.inputs && stepsSig(node.inputs), typeOf(node).sig?.(node, ctx)]);
      if (sig !== entry.sig) { entry.sig = sig; renderNode(entry, node); rendered.push(entry); }
    }
    measure(rendered);
    for (const [id, entry] of s.sim) if (!seen.has(id)) { cardSizes.unobserve(entry.el); entry.el.remove(); s.sim.delete(id); s.ticking.delete(entry); }
    // Cards sit in the DOM in reading order, so Tab moves down the canvas.
    const order = graph.nodes.map((node) => s.sim.get(node.id).el);
    if (order.some((node, i) => nodesLayer.children[i] !== node)) {
      const focused = document.activeElement;
      nodesLayer.append(...order);
      if (focused && nodesLayer.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    const keys = new Set();
    for (const frame of graph.frames) {
      keys.add(frame.key);
      let box = s.frames.get(frame.key);
      if (!box) { box = { el: el('div'), sig: '', box: null, target: null, style: '' }; framesLayer.append(box.el); s.frames.set(frame.key, box); }
      box.frame = frame;
      const className = `fl-frame ${frame.kind} ${frame.state || ''}`;
      if (box.el.className !== className) box.el.className = className;
      const sig = JSON.stringify([frame.label, frame.count, frame.ended]);
      if (sig !== box.sig) {
        box.sig = sig;
        box.el.replaceChildren();
        if (frame.label) {
          const label = el('span', 'fl-frame-label', frame.label);
          if (frame.count) label.append(el('span', 'fl-count', frame.ended ? `${frame.count}×` : String(frame.count)));
          box.el.append(label);
        }
      }
    }
    for (const [key, box] of s.frames) if (!keys.has(key)) { box.el.remove(); s.frames.delete(key); }
    // A long pause before a row: a quiet marker in the gap, not space in proportion to the time.
    const pauses = new Set();
    for (const row of graph.rows) {
      if (!row.idle) continue;
      pauses.add(row.key);
      let mark = s.marks.get(row.key);
      if (!mark) { mark = { el: el('div', 'fl-gap'), text: '', y: 0, ty: 0, placed: false, transform: '' }; marksLayer.append(mark.el); s.marks.set(row.key, mark); }
      const text = `${idleText(row.idle)} later`;
      if (text !== mark.text) {
        mark.text = text;
        mark.el.replaceChildren(kindIcon('clock', ''), text);
        Object.assign(mark, { w: mark.el.offsetWidth, h: mark.el.offsetHeight });
      }
    }
    for (const [key, mark] of s.marks) if (!pauses.has(key)) { mark.el.remove(); s.marks.delete(key); }
    s.rows = graph.rows;
    s.rowOf = new Map(graph.rows.flatMap((row) => row.ids.map((id) => [id, row.key])));
    s.edges = graph.edges.filter((edge) => s.sim.has(edge.from) && s.sim.has(edge.to));
    s.focus = graph.focus;
    s.index = graph.index;
    s.dirty = s.edgesDirty = true;
    if (s.selected && !s.index.has(s.selected)) s.selected = null;
    markSelection();
    notifySelection();
  }
  function layout() {
    let y = 0;
    const tops = new Map();
    const bottoms = new Map();
    // Siblings share one line where they can: cards narrow (to a floor) rather than wrap, and only as far
    // as the siblings that will actually share a line need. A docked approval and the card above it share
    // one width. All widths are written, then all sizes read.
    const widths = new Map();
    s.rows.forEach((row, r) => {
      const entries = row.ids.map((id) => s.sim.get(id)).filter(Boolean);
      const perLine = Math.min(entries.length, Math.max(1, Math.floor((s.rowWidth + GAP_X) / (MIN_CARD + GAP_X))));
      const fit = perLine > 1 ? Math.floor((s.rowWidth - GAP_X * (perLine - 1)) / perLine) : null;
      for (const entry of entries) widths.set(entry, fit && fit < entry.natural ? fit : null);
      const above = row.gap === 'dock' && s.sim.get(s.rows[r - 1]?.ids[0]);
      if (above && entries.length === 1) { const width = Math.min(s.rowWidth, Math.max(above.natural, entries[0].natural)); widths.set(above, width); widths.set(entries[0], width); }
    });
    const resized = [];
    for (const [entry, width] of widths) {
      const value = width ? `${width}px` : '';
      if (entry.el.style.width !== value) { entry.el.style.width = value; resized.push(entry); }
    }
    for (const entry of resized) { entry.w = entry.el.offsetWidth; entry.h = entry.el.offsetHeight; }
    let prev = null;
    for (const row of s.rows) {
      if (prev && row.gap === 'dock') y -= 1; // flush: the two borders overlap
      else if (prev) {
        let gap = Math.max(GAP[row.gap] ?? GAP.chain, row.ids.length > 1 || prev.ids.length > 1 ? GAP.fan : 0);
        if (prev.ids.some((id) => piled(s.sim.get(id)?.node || {}))) gap += PILE;
        const mark = row.idle && s.marks.get(row.key);
        if (mark) { gap = Math.max(gap, mark.h + IDLE_PAD * 2); mark.ty = y + (gap - mark.h) / 2; }
        y += gap;
      }
      prev = row;
      for (const key of row.open) { tops.set(key, y); y += FRAME.head[s.frames.get(key)?.frame.kind] ?? FRAME.head.group; }
      const entries = row.ids.map((id) => s.sim.get(id)).filter(Boolean);
      if (entries.length) {
        const cell = Math.max(...entries.map((entry) => entry.w));
        const cols = Math.max(1, Math.floor((s.rowWidth + GAP_X) / (cell + GAP_X)));
        for (let i = 0; i < entries.length; i += cols) {
          const line = entries.slice(i, i + cols);
          const height = Math.max(...line.map((entry) => entry.h));
          // Rows centre on one axis, so consecutive single cards line up.
          const span = line.length * (cell + GAP_X) - GAP_X;
          line.forEach((entry, c) => { entry.tx = -span / 2 + c * (cell + GAP_X) + cell / 2; entry.ty = y + entry.h / 2; });
          y += height + GAP_Y;
        }
        y -= GAP_Y;
      }
      for (const key of row.close) { y += FRAME.foot; bottoms.set(key, y); }
    }
    // Frames wrap their members sideways (wider for each frame nested inside) and their rows vertically.
    for (const [key, box] of s.frames) {
      const members = box.frame.members.map((id) => s.sim.get(id)).filter(Boolean);
      if (!members.length || !tops.has(key)) { box.target = null; continue; }
      const pad = FRAME.side + FRAME.nest * box.frame.below;
      box.target = { x0: Math.min(...members.map((m) => m.tx - m.w / 2)) - pad, x1: Math.max(...members.map((m) => m.tx + m.w / 2)) + pad, y0: tops.get(key), y1: bottoms.get(key) };
    }
    const entries = [...s.sim.values()];
    s.top = entries.length ? Math.min(...entries.map((entry) => entry.ty - entry.h / 2), ...[...s.frames.values()].filter((box) => box.target).map((box) => box.target.y0)) : 0;
  }
  function move(dt) {
    if (s.dirty) { layout(); s.dirty = false; s.moving = true; }
    // Cards are repainted while anything moves, and once more as it settles; idle frames touch only timers.
    s.paint = s.moving;
    if (!s.moving) return;
    let moving = false;
    const step = (value, target) => { const next = ease(value, target, dt, 140); if (Math.abs(next - target) < 0.05) return target; moving = true; return next; };
    for (const entry of s.sim.values()) {
      if (!entry.placed) {
        Object.assign(entry, { x: entry.tx, y: entry.ty, placed: true });
        requestAnimationFrame(() => entry.el.classList.remove('enter'));
        moving = true;
        continue;
      }
      entry.x = step(entry.x, entry.tx);
      entry.y = step(entry.y, entry.ty);
    }
    for (const box of s.frames.values()) {
      if (!box.target) { box.box = null; continue; }
      if (!box.box) { box.box = { ...box.target }; moving = true; continue; }
      for (const side of ['x0', 'x1', 'y0', 'y1']) box.box[side] = step(box.box[side], box.target[side]);
    }
    for (const mark of s.marks.values()) {
      if (!mark.placed) { Object.assign(mark, { y: mark.ty, placed: true }); moving = true; continue; }
      mark.y = step(mark.y, mark.ty);
    }
    s.moving = moving;
    s.edgesDirty = true;
  }

  function edgePath(a, b) {
    const x1 = a.x, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y - b.h / 2;
    const c = Math.max(14, (y2 - y1) / 2);
    return `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`;
  }
  // Many sources feeding many targets meet at one knot instead of crossing every pair.
  function edgePaths() {
    const groups = new Map();
    for (const edge of s.edges) {
      const key = s.rowOf.get(edge.to);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(edge);
    }
    const paths = [];
    // Weight: the spine is firm, a branch to a secondary card beside others quiet, a pause dotted.
    const cls = (edge) => { const b = s.sim.get(edge.to); return `le ${b.node.kind} ${edge.weight || 'spine'}${edge.idle ? ' idle' : ''}${isLive(b.node.status) ? ` hot ${b.node.status}` : ''}`; };
    for (const edges of groups.values()) {
      const sources = [...new Set(edges.map((edge) => edge.from))].map((id) => s.sim.get(id));
      const targets = [...new Set(edges.map((edge) => edge.to))];
      if (sources.length > 1 && targets.length > 1) {
        const bottom = Math.max(...sources.map((a) => a.y + a.h / 2));
        const top = Math.min(...targets.map((id) => s.sim.get(id).y - s.sim.get(id).h / 2));
        const xs = targets.map((id) => s.sim.get(id).x);
        const knot = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (bottom + top) / 2, w: 0, h: 0 };
        for (const a of sources) paths.push(`<path d="${edgePath(a, knot)}" class="le"/>`);
        for (const id of targets) paths.push(`<path d="${edgePath(knot, s.sim.get(id))}" class="${cls(edges.find((edge) => edge.to === id))}"/>`);
        paths.push(`<circle cx="${knot.x}" cy="${knot.y}" r="4" class="le-knot"/>`);
      } else for (const edge of edges) paths.push(`<path d="${edgePath(s.sim.get(edge.from), s.sim.get(edge.to))}" class="${cls(edge)}"/>`);
    }
    return paths;
  }

  // Following pins the focus card: its bottom edge `anchor` px above the stage bottom, unless everything
  // fits, in which case the first card starts just below the floating controls. Sideways the view stays on
  // the axis rows centre on, and moves only to bring a card of a wide row into view.
  function focusCamera(focus, height, width = stage.clientWidth) {
    const halfH = height / 2 / s.cam.z, halfW = width / 2 / s.cam.z;
    const x = Math.abs(focus.x) + focus.w / 2 <= halfW - 16 ? 0 : Math.max(-Math.abs(focus.x), Math.min(Math.abs(focus.x), focus.x + Math.sign(-focus.x) * Math.max(0, halfW - focus.w / 2 - 16)));
    return { x, y: Math.max(focus.y + focus.h / 2 + s.anchor / s.cam.z - halfH, s.top - topInset / s.cam.z + halfH) };
  }
  // Manual panning stays within the cards. Sideways: their extent (centred if they all fit).
  // Up and down: the floating controls' height above the first card, and at the bottom the follow
  // position, so scrolling to the end resumes following. Content shorter than the stage can't be scrolled out of view.
  function clampView(width = stage.clientWidth, height = stage.clientHeight) {
    if (!s.sim.size) return;
    const entries = [...s.sim.values()];
    const margin = 32 / s.cam.z;
    const left = Math.min(...entries.map((e) => e.tx - e.w / 2)) - margin;
    const right = Math.max(...entries.map((e) => e.tx + e.w / 2)) + margin;
    const halfW = width / 2 / s.cam.z;
    s.cam.x = right - left <= halfW * 2 ? (left + right) / 2 : Math.min(right - halfW, Math.max(left + halfW, s.cam.x));
    const top = s.top - topInset / s.cam.z;
    const bottom = Math.max(...entries.map((e) => e.ty + e.h / 2)) + s.anchor / s.cam.z;
    const halfH = height / 2 / s.cam.z;
    const a = top + halfH, b = bottom - halfH;
    s.cam.y = Math.min(Math.max(a, b), Math.max(Math.min(a, b), s.cam.y));
  }
  function stopFollowing() {
    s.follow = false;
    followButton.hidden = false;
  }
  function resumeFollowing() {
    s.follow = true;
    s.locked = null;
    followButton.hidden = true;
  }
  // Scrolling back to where the focus card belongs resumes following, like returning to the bottom of a chat.
  function maybeResume() {
    const focus = s.sim.get(s.focus);
    if (!focus) return;
    const target = focusCamera(focus, stage.clientHeight);
    if (Math.abs(s.cam.y - target.y) * s.cam.z < 40) resumeFollowing();
  }
  // Keyboard focus on a card out of view pans to it.
  function reveal(entry) {
    const z = s.cam.z, halfW = stage.clientWidth / 2 / z, halfH = stage.clientHeight / 2 / z;
    const top = s.cam.y - halfH + topInset / z, bottom = s.cam.y + halfH - s.anchor / z;
    const inside = entry.ty - entry.h / 2 >= top && entry.ty + entry.h / 2 <= bottom && Math.abs(entry.tx - s.cam.x) + entry.w / 2 <= halfW;
    if (inside) return;
    stopFollowing();
    s.cam.x = entry.tx;
    s.cam.y = entry.ty - entry.h / 2 - topInset / z + halfH - 12 / z;
    if (entry.h > bottom - top) s.cam.y = entry.ty - entry.h / 2 + halfH - topInset / z;
    clampView();
  }
  function draw(dt, now) {
    const width = stage.clientWidth, height = stage.clientHeight;
    s.anchor = ease(s.anchor, anchorTarget(), dt, 160);
    followButton.style.bottom = `${s.anchor - 8}px`;
    const px = (value) => Math.round(value * 10) / 10;
    if (s.paint) for (const entry of s.sim.values()) {
      const transform = `translate(${px(entry.x - entry.w / 2)}px,${px(entry.y - entry.h / 2)}px)`;
      if (entry.transform !== transform) { entry.transform = transform; entry.el.style.transform = transform; }
    }
    for (const entry of s.ticking) paintTimers(entry, now);
    if (s.edgesDirty) { edgesLayer.innerHTML = edgePaths().join(''); s.edgesDirty = false; }
    // Frames wrap their members; their colour, not a label, says whether the run is live.
    if (s.paint) for (const box of s.frames.values()) {
      const b = box.box;
      const style = b ? `translate(${px(b.x0)}px,${px(b.y0)}px)|${px(b.x1 - b.x0)}|${px(b.y1 - b.y0)}` : 'none';
      if (style === box.style) continue;
      box.style = style;
      box.el.hidden = !b;
      if (b) Object.assign(box.el.style, { transform: `translate(${px(b.x0)}px,${px(b.y0)}px)`, width: `${px(b.x1 - b.x0)}px`, height: `${px(b.y1 - b.y0)}px` });
    }
    if (s.paint) for (const mark of s.marks.values()) {
      const transform = `translate(${px(-mark.w / 2)}px,${px(mark.y)}px)`;
      if (mark.transform !== transform) { mark.transform = transform; mark.el.style.transform = transform; }
    }
    // When the focus changes the canvas scrolls once to the new card, then locks to it again.
    const focus = s.sim.get(s.focus);
    if (s.follow && focus) {
      const target = focusCamera(focus, height, width);
      if (s.locked === s.focus || s.snap) { Object.assign(s.cam, target); s.snap = false; s.locked = s.focus; }
      else {
        s.cam.x = ease(s.cam.x, target.x, dt, 180);
        s.cam.y = ease(s.cam.y, target.y, dt, 180);
        if (Math.hypot(s.cam.x - target.x, s.cam.y - target.y) < 0.5) s.locked = s.focus;
      }
    }
    // Zooming or cards moving can change the bounds while you're looking around.
    if (!s.follow) clampView(width, height);
    const transform = `translate(${px(width / 2 - s.cam.x * s.cam.z)}px,${px(height / 2 - s.cam.y * s.cam.z)}px) scale(${s.cam.z})`;
    if (world.style.transform !== transform) world.style.transform = transform;
  }

  function frame(time) {
    // A canvas whose pane was removed stops; start() brings it back.
    if (!stage.isConnected) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    const dt = Math.min(64, time - (s.last || time)) || 16;
    s.last = time;
    const view = source?.(dt);
    // Hidden canvases (another tab in front, or Chat mode) skip the work but keep their state.
    if (!view || !stage.offsetParent) return;
    s.session = view.session;
    s.now = view.now;
    const signature = `${view.session.id}:${view.session.revision ?? ''}:${view.events.length}:${view.events.at(-1)?.id}:${view.session.messages?.length}:${view.live}:${s.uiRev}`;
    if (signature !== s.sig) { s.sig = signature; sync(phases({ ...view, ui: s.ui })); }
    move(dt);
    draw(dt, view.now);
  }

  // Cards narrow with the stage; natural sizes are re-measured when it resizes.
  const resize = new ResizeObserver(() => {
    const rowWidth = Math.max(MIN_CARD, Math.min(MAX_ROW, stage.clientWidth - 48));
    if (rowWidth === s.rowWidth) return;
    s.rowWidth = rowWidth;
    stage.style.setProperty('--row-width', `${rowWidth}px`);
    measure([...s.sim.values()]);
    s.locked = null;
    s.dirty = true;
  });
  resize.observe(stage);

  // Structure controls: group headers and tiles, the iteration stepper, stack headers and step rows.
  function act(node, target) {
    const { open, stacks } = s.ui;
    const at = node.iterations?.findIndex((iteration) => iteration.index === node.open) ?? -1;
    const fallback = () => (node.iterations.findLast((iteration) => iteration.status === 'failed') || node.iterations.at(-1)).index;
    switch (target.dataset.act) {
      case 'toggle':
        if (node.type === 'stack') { if (stacks.has(node.id)) stacks.delete(node.id); else stacks.add(node.id); }
        // A burst pins open, and a second click lets it fold again.
        else if (node.type === 'burst') { if (s.ui.bursts.has(node.id)) s.ui.bursts.delete(node.id); else s.ui.bursts.add(node.id); }
        else open.set(node.id, node.open === null ? fallback() : null);
        break;
      case 'iter': { const index = Number(target.dataset.index); open.set(node.id, node.open === index ? null : index); break; }
      case 'prev': case 'next': open.set(node.id, node.iterations[Math.max(0, Math.min(node.iterations.length - 1, at + (target.dataset.act === 'next' ? 1 : -1)))].index); break;
      case 'row': select(s.selected === target.dataset.step ? null : target.dataset.step); return;
      // Other controls belong to their node type (e.g. a fleet's agent tiles).
      default: typeOf(node).act?.(node, target, ctx); return;
    }
    s.uiRev++;
  }

  // Drag or scroll to pan (like a page); Ctrl+scroll zooms. Either pauses following.
  let drag = null;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, a, .fl-card.msg')) return;
    drag = { x: event.clientX, y: event.clientY, cx: s.cam.x, cy: s.cam.y, id: event.pointerId, moved: false };
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; stage.setPointerCapture(drag.id); stopFollowing(); }
    if (drag.moved) { s.cam.x = drag.cx - dx / s.cam.z; s.cam.y = drag.cy - dy / s.cam.z; clampView(); }
  });
  const endDrag = () => { if (drag?.moved) { maybeResume(); s.justDragged = true; setTimeout(() => { s.justDragged = false; }, 0); } drag = null; };
  // Clicking a leaf card selects it (again: clears); structure controls act; empty canvas clears.
  stage.addEventListener('click', (event) => {
    if (s.justDragged || event.target.closest('a') || getSelection()?.toString()) return;
    const card = event.target.closest('.fl-card');
    if (!card) { if (!event.target.closest('button')) select(null); return; }
    const control = event.target.closest('[data-act]');
    if (control && !control.disabled) return act(card.entry.node, control);
    if (card.classList.contains('selectable')) select(s.selected === card.entry.node.id ? null : card.entry.node.id);
  });
  stage.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && s.selected) { event.stopPropagation(); select(null); return; }
    const card = event.target.classList?.contains('fl-card') ? event.target : null;
    if (card?.classList.contains('selectable') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      select(s.selected === card.entry.node.id ? null : card.entry.node.id);
    }
  });
  nodesLayer.addEventListener('focusin', (event) => {
    const entry = event.target.closest('.fl-card')?.entry;
    if (entry && event.target.matches(':focus-visible')) reveal(entry);
  });
  // Focus must never scroll the stage itself; the camera does the moving.
  stage.addEventListener('scroll', () => { stage.scrollTop = 0; stage.scrollLeft = 0; });
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    stopFollowing();
    if (event.ctrlKey) s.cam.z = Math.min(1.6, Math.max(0.3, s.cam.z * Math.exp(-event.deltaY * 0.004)));
    else { s.cam.x += event.deltaX / s.cam.z; s.cam.y += event.deltaY / s.cam.z; }
    clampView();
    if (!event.ctrlKey && event.deltaY > 0) maybeResume();
  }, { passive: false });
  followButton.addEventListener('click', resumeFollowing);

  return {
    start(fn) { source = fn; if (!raf) raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    // Clears the scene (new session, or a replay jumping backwards) and follows again.
    reset() {
      for (const entry of s.sim.values()) { cardSizes.unobserve(entry.el); entry.el.remove(); }
      for (const box of s.frames.values()) box.el.remove();
      for (const mark of s.marks.values()) mark.el.remove();
      s.sim.clear();
      s.frames.clear();
      s.marks.clear();
      s.ticking.clear();
      s.index = new Map();
      s.ui = { open: new Map(), stacks: new Set(), bursts: new Set() };
      s.sig = '';
      s.snap = true; // the first frame jumps straight to the focus rather than scrolling from the origin
      select(null);
      resumeFollowing();
    },
    // Rebuilds from the next frame's data without clearing (e.g. after scrubbing).
    invalidate() { s.sig = ''; },
    // Selects a step or message by id (null clears); the card, or the row showing it, is marked.
    select,
    get selected() { return s.selected; },
    // Scrolls to a run's frame and stops following there.
    showRun(runId) {
      const box = s.frames.get(`run:${runId}`)?.target;
      if (!box) return;
      stopFollowing();
      s.cam.x = 0; // rows centre on x = 0
      s.cam.y = box.y0 - topInset / s.cam.z + stage.clientHeight / 2 / s.cam.z;
    },
  };
}
