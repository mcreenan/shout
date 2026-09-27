// Folds the raw session event log into runs of timed steps for the Flow view.
// A step pairs a start event with its completion (by effect ID) and absorbs the
// effect/worker events around it, so each row is one thing that took time.

const PAIRS = {
  'tool.started': ['tool', 'tool'], 'model.started': ['model', 'model'], 'chat.started': ['chat', 'model'], 'user.question': ['user', 'user'],
};
const ENDS = {
  'tool.completed': ['tool', 'ok'], 'tool.failed': ['tool', 'failed'], 'model.completed': ['model', 'ok'], 'model.failed': ['model', 'failed'],
  'chat.completed': ['chat', 'ok'], 'chat.failed': ['chat', 'failed'], 'user.answered': ['user', 'ok'],
};
const INSTANT = {
  'program.loaded': ['vm', 'Program loaded'], 'command.routed': ['harness', 'Command'], 'workspace.changed': ['harness', 'Workspace changed'],
  'session.error': ['harness', 'Error'], 'session.cancelled': ['harness', 'Cancelled'],
};
export const LOOPS = new Set(['for', 'while', 'loop']);

export function kindOf(type = '') {
  if (type.startsWith('user.') || type.startsWith('message.user')) return 'user';
  if (type.startsWith('model.') || type.startsWith('provider.') || type.startsWith('chat.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('vm.') || type.startsWith('effect.') || type === 'program.loaded') return 'vm';
  return 'harness';
}

const ms = (event) => Date.parse(event.time);
export const clip = (text, max = 80) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const num = (...values) => values.find(Number.isInteger);

function toolDetail(tool, input = {}) {
  if (!input || typeof input !== 'object') return '';
  if (Array.isArray(input.args)) return clip(input.args.join(' '));
  if (Array.isArray(input.paths)) return input.paths.length === 1 ? input.paths[0] : `${input.paths.length} files`;
  if (Array.isArray(input.changes)) return input.changes.length === 1 ? input.changes[0]?.path || '1 file' : `${input.changes.length} files`;
  if (Array.isArray(input.edits)) return `${input.edits.length} edit${input.edits.length === 1 ? '' : 's'}`;
  for (const key of ['path', 'command', 'pattern', 'query', 'name', 'purpose']) if (typeof input[key] === 'string') return clip(input[key]);
  return '';
}
export function tokens(usage) {
  const total = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
  if (!total) return '';
  return total >= 1000 ? `${(total / 1000).toFixed(total >= 10000 ? 0 : 1)}k tokens` : `${total} tokens`;
}

function describe(step) {
  const start = step.events.find((event) => PAIRS[event.type]) || step.events[0];
  if (step.pair === 'tool') { step.label = start.tool || 'Tool'; step.detail = toolDetail(start.tool, start.input); }
  else if (step.pair === 'model') step.label = 'Model';
  else if (step.pair === 'chat') { step.label = 'Agent'; step.detail = start.label ? clip(start.label) : ''; }
  else if (step.pair === 'user') { step.label = start.host || start.schema?.properties?.accept ? 'Approval' : 'Question'; step.detail = clip(start.title || start.command || start.prompt?.system || ''); }
  else if (step.pair === 'effect') { step.label = start.method || 'Effect'; }
}

/**
 * The VM's control-flow position for an effect event, or null. Older sessions, host-created approvals and
 * the agent's own tool calls carry none; `user.answered` uses `origin` for who answered (a string).
 * Returns { task, site, scope } with scope ordered outermost first.
 */
export function originOf(event) {
  const origin = event?.origin;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin) || !(origin.site || origin.scope)) return null;
  const scope = Array.isArray(origin.scope) ? origin.scope.filter((entry) => entry && typeof entry === 'object' && typeof entry.kind === 'string') : [];
  const site = origin.site && typeof origin.site === 'object' ? origin.site : null;
  return { task: num(origin.task) ?? 0, site, scope };
}

const siteKind = (value = '') => (/model/.test(value) ? 'model' : /user|ask|question/.test(value) ? 'user' : /agent/.test(value) ? 'agent' : 'tool');
/**
 * Adapter for the static program shape a `program.loaded` event may carry: effect sites and control
 * constructs. Field names are read loosely so JOSH can settle on its own; every field is optional.
 * Returns { sites: [{ line, column, endLine, endColumn, kind, name, constructs }], constructs: Map(id → { id, kind, parent, line, … }) }.
 */
export function programShape(event) {
  const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);
  const span = (item) => {
    const at = item.span && typeof item.span === 'object' ? item.span : item.site && typeof item.site === 'object' ? item.site : item;
    return { line: num(at.line, at.start_line, at.startLine), column: num(at.column, at.start_column, at.startColumn), endLine: num(at.end_line, at.endLine), endColumn: num(at.end_column, at.endColumn) };
  };
  const sites = list(event?.sites ?? event?.effect_sites ?? event?.effectSites).map((item) => ({
    ...span(item), kind: siteKind(String(item.kind ?? item.effect ?? item.method ?? '')), name: String(item.name ?? item.tool ?? item.effect ?? item.method ?? ''),
    constructs: Array.isArray(item.constructs) ? item.constructs.filter(Number.isInteger) : [],
  })).filter((site) => site.line);
  const constructs = new Map();
  for (const item of list(event?.constructs ?? event?.scopes)) {
    const id = num(item.construct, item.id);
    if (id !== undefined) constructs.set(id, { id, kind: String(item.kind || ''), parent: num(item.parent) ?? null, ...span(item) });
  }
  return { sites, constructs };
}

/**
 * Groups events into segments (one per run; run-less events form "session" segments) of steps.
 * Each step: { id, kind, label, detail, start, end, status: 'active'|'ok'|'failed'|'instant'|'stale', events, origin }.
 * `live` says whether the session is still running, so unfinished steps are active rather than stale.
 */
export function buildFlow(events, { live = false, now = Date.now() } = {}) {
  const segments = [];
  const byRun = new Map();
  const open = new Map();
  let current = null;
  const segmentFor = (event) => {
    const key = event.run || null;
    if (key && byRun.has(key)) return byRun.get(key);
    if (!key && current && !current.run) return current;
    const segment = { run: key, start: ms(event), end: null, state: key ? 'running' : 'session', steps: [], events: [] };
    segments.push(segment);
    if (key) byRun.set(key, segment);
    return segment;
  };
  const addStep = (segment, event, fields) => {
    const step = { id: event.id, kind: kindOf(event.type), label: '', detail: '', start: ms(event), end: null, status: 'active', events: [event], origin: originOf(event), run: segment.run, ...fields };
    segment.steps.push(step);
    return step;
  };

  for (const event of events) {
    const segment = segmentFor(event);
    current = segment;
    const key = event.effectId ? `${event.run || ''}:${event.effectId}` : null;
    const type = event.type || '';

    if (type === 'run.started') { segment.start = ms(event); segment.events.push(event); continue; }
    if (type === 'run.terminal') { segment.end = ms(event); segment.state = event.state || 'completed'; segment.events.push(event); continue; }
    if (type === 'vm.event') { segment.events.push(event); continue; }
    if (type === 'program.loaded') segment.program = event;

    if (PAIRS[type]) {
      const [pair, kind] = PAIRS[type];
      const openKey = key || `${segment.run}:${pair}`;
      // An effect.requested placeholder for the same effect becomes this step.
      let step = key && open.get(key);
      if (step?.pair === 'effect') Object.assign(step, { pair, kind, id: event.id, wrapped: true, origin: originOf(event) || step.origin }).events.push(event);
      else step = addStep(segment, event, { pair, kind });
      describe(step);
      open.set(openKey, step);
      continue;
    }
    if (ENDS[type]) {
      const [pair, outcome] = ENDS[type];
      const openKey = key || `${segment.run}:${pair}`;
      const step = open.get(openKey);
      // An end without its start: the start fell off the front of a capped log.
      if (!step) { addStep(segment, event, { pair, label: event.tool || type, end: ms(event), status: outcome, orphan: true }); continue; }
      step.events.push(event);
      // Effect-wrapped steps stay open until effect.resolved; bare pairs (routing, host approvals) close here.
      if (step.wrapped) step.outcome = outcome;
      else { step.end = ms(event); step.status = outcome; open.delete(openKey); }
      continue;
    }
    if (type === 'effect.requested' && key) {
      const step = addStep(segment, event, { pair: 'effect', kind: 'vm' });
      describe(step);
      open.set(key, step);
      continue;
    }
    if (type.startsWith('effect.') && key) {
      const step = open.get(key);
      if (step) {
        step.events.push(event);
        if (type !== 'effect.requested') {
          step.end = ms(event);
          step.status = type === 'effect.resolved' ? (step.outcome || 'ok') : 'failed';
          open.delete(key);
        }
        continue;
      }
    }
    if (type.endsWith('.worker')) {
      const pair = type.startsWith('chat.') ? 'chat' : 'model';
      const step = [...segment.steps].reverse().find((candidate) => candidate.pair === pair);
      if (step) {
        step.events.push(event);
        if (event.usage) step.detail = tokens(event.usage) || step.detail;
        continue;
      }
    }
    const [kind, label] = INSTANT[type] || [kindOf(type), type];
    const detail = type === 'command.routed' ? `/${event.command || '?'}${event.args ? ` ${clip(event.args, 40)}` : ''}`
      : type === 'workspace.changed' ? clip((event.changed || []).join(', '))
        : type === 'session.error' ? clip(event.message) : '';
    addStep(segment, event, { kind, label, detail, end: ms(event), status: type === 'session.error' ? 'failed' : 'instant', instant: type });
  }

  // A step can only still be running in the newest run, and only while that run hasn't ended.
  const lastRun = segments.findLast((segment) => segment.run);
  for (const segment of segments) {
    const over = !live || segment.end !== null || (segment.run && segment !== lastRun);
    for (const step of segment.steps) if (step.status === 'active' && over) Object.assign(step, { status: 'stale', end: ms(step.events.at(-1)) });
    if (segment.run && segment !== lastRun && segment.end === null && segment.state === 'running') segment.state = 'interrupted';
  }
  for (const segment of segments) {
    if (segment.end === null) {
      const last = Math.max(segment.start, ...segment.steps.map((step) => step.end ?? step.start), ...segment.events.map(ms));
      segment.end = live && segment.steps.some((step) => step.status === 'active') ? null : last;
      if (segment.run && segment.state === 'running' && !live) segment.state = 'interrupted';
    }
    segment.duration = (segment.end ?? now) - segment.start;
  }
  return segments;
}

export function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 60_000) return `${Math.floor(value / 1000)}s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m ${String(Math.floor((value % 60_000) / 1000)).padStart(2, '0')}s`;
}

const optional = (value) => (value && typeof value === 'object' && (value.tag === 'Some' || value.tag === 'None') ? value.value : value);
export const plural = (count, noun) => `${count} ${count === 1 ? noun.replace(/(ch|sh|x|ss)es$/, '$1').replace(/([^s])s$/, '$1') : noun}`;

/** What a model call was asked to do: its role, first task sentence, and a short summary of its inputs. */
export function modelTask(prompt) {
  const sentences = String(prompt?.system || '').split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  const role = sentences[0]?.match(/^You are (?:an? |the )?(.+?)\.?$/i)?.[1]?.split(',')[0] || '';
  // "You review the diff." reads as an instruction: "Review the diff."
  const task = (sentences.find((sentence) => !/^You are /i.test(sentence)) || '').replace(/^You (\w)/, (_, letter) => letter.toUpperCase());
  const data = optional(prompt?.data);
  const inputs = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      const name = key.replace(/_/g, ' ').replace(/^all /, '');
      const inner = optional(value);
      if (Array.isArray(inner)) { if (inner.length) inputs.push(plural(inner.length, name)); }
      else if (typeof inner === 'number') inputs.push(`${name} ${inner}`);
      else if (typeof inner === 'string' && inner.trim()) inputs.push(name);
    }
  } else if (Array.isArray(data) && data.length) inputs.push(plural(data.length, 'items'));
  return { role, task: clip(task, 180), inputs };
}

/** The part of a model judgment worth reading: its prose, any findings or edits, and any files it chose. */
export function modelOutput(value) {
  if (!value || typeof value !== 'object') return { text: typeof value === 'string' ? value : '', items: [], files: [] };
  const text = [value.summary, value.markdown, value.text, value.reason, value.answer, value.explanation].find((candidate) => typeof candidate === 'string' && candidate.trim()) || '';
  const items = [];
  for (const finding of Array.isArray(value.findings) ? value.findings : []) {
    items.push({ title: clip(finding.title || finding.detail || 'Finding', 120), meta: [finding.severity, finding.file && `${finding.file}${finding.line ? `:${finding.line}` : ''}`].filter(Boolean).join(' · '), tone: finding.severity, detail: finding.title ? finding.detail || '' : '' });
  }
  const edits = Array.isArray(value.edits) ? value.edits : Array.isArray(value.changes) ? value.changes : [];
  const byPath = new Map();
  for (const edit of edits) if (edit?.path) byPath.set(edit.path, (byPath.get(edit.path) || 0) + 1);
  for (const [path, count] of byPath) items.push({ title: path, meta: plural(count, 'edits'), tone: 'edit' });
  // A selection judgment answers with the files it chose.
  const files = Array.isArray(value.paths) ? value.paths.filter((path) => typeof path === 'string') : [];
  return { text, items, files };
}

/** One-word outcome of a finished tool call, or '' when nothing notable. */
export function toolResult(step) {
  const done = step.events.find((event) => event.type === 'tool.completed' || event.type === 'tool.failed');
  if (!done) return '';
  if (done.type === 'tool.failed') return clip(done.error?.message || 'failed', 60);
  const value = done.value || {};
  if (typeof value.passed === 'boolean') return value.skipped ? 'skipped' : value.passed ? 'passed' : 'failed';
  if (Number.isInteger(value.exit_code ?? value.exitCode) && (value.exit_code ?? value.exitCode) !== 0) return `exit ${value.exit_code ?? value.exitCode}`;
  if (Array.isArray(value.matches)) return plural(value.matches.length, 'matches');
  if (Array.isArray(value.files)) return `${plural(value.files.length, 'files')}${value.truncated ? '+' : ''}`;
  if (Array.isArray(value.changed)) return `${plural(value.changed.length, 'files')} changed`;
  return '';
}

/** Whether a finished step went wrong: a failed call, failing tests or a non-zero exit. */
export function stepFailed(step) {
  if (step.status === 'failed') return true;
  const value = step.events.find((event) => event.type === 'tool.completed')?.value;
  if (!value || typeof value !== 'object') return false;
  if (value.passed === false && !value.skipped) return true;
  const code = value.exit_code ?? value.exitCode;
  return Number.isInteger(code) && code !== 0;
}

const lineCache = { source: null, lines: [] };
/** A 1-based line of a program's source, or ''. */
export function sourceLine(source, line) {
  if (typeof source !== 'string' || !Number.isInteger(line)) return '';
  if (lineCache.source !== source) Object.assign(lineCache, { source, lines: source.split('\n') });
  return lineCache.lines[line - 1] ?? '';
}
/** A loop's header as written, e.g. `for attempt in 0..3`, or its kind when the source is missing. */
export function loopTitle(source, entry) {
  const text = sourceLine(source, entry.line).slice(Math.max(0, (entry.column || 1) - 1)).replace(/\s*\{.*$/, '').trim();
  return clip(text, 56) || `${entry.kind} loop`;
}
/** The label of an if/match branch that was taken. `arm` is taken to be 0-based. */
export function branchLabel(entry) {
  if (entry.kind === 'match') return Number.isInteger(entry.arm) ? `arm ${entry.arm + 1}` : String(entry.arm ?? 'match');
  return String(entry.branch ?? 'then');
}
const shortName = (name) => String(name || '').split('::').pop();
/**
 * The breadcrumb of an effect: the entry function, then each call, loop iteration and branch around it,
 * e.g. [main, for attempt #2, apply_and_test]. Items: { label, kind, line, title }.
 */
export function scopePath(origin, source) {
  if (!origin) return [];
  const path = [{ label: 'main', kind: 'call' }];
  for (const entry of origin.scope) {
    const title = clip(sourceLine(source, entry.line).trim(), 120);
    if (entry.kind === 'call') { const name = shortName(entry.function); if (name && name !== path.at(-1).label) path.push({ label: name, kind: 'call', line: entry.line, title }); }
    else if (LOOPS.has(entry.kind)) path.push({ label: `${loopTitle(source, entry).split(/\s+in\s+/)[0]} #${entry.iteration ?? 1}`, kind: 'loop', line: entry.line, title });
    else if (entry.kind === 'if' || entry.kind === 'match') path.push({ label: branchLabel(entry), kind: 'branch', line: entry.line, title });
    else if (entry.kind === 'await_block') path.push({ label: 'await', kind: 'await', line: entry.line, title });
  }
  const site = shortName(origin.site?.function);
  if (site && site !== path.findLast((item) => item.kind === 'call').label) path.push({ label: site, kind: 'call' });
  return path;
}

/**
 * What a run did at each line of its program, for the Program tab: effect counts by site line (from
 * `origin.site`), which site is running or waiting, loop iteration totals by header line, and the static
 * sites from `program.loaded` when present. `origin` is false when no event carried control-flow data.
 */
export function programActivity(events, { live = false } = {}) {
  const lines = new Map();
  const loops = new Map();
  let origin = false;
  let last = null;
  let program = null;
  for (const segment of buildFlow(events, { live })) {
    program ||= segment.program;
    for (const step of segment.steps) {
      if (!step.origin) continue;
      origin = true;
      last = step;
      const line = num(step.origin.site?.line);
      if (line) {
        const entry = lines.get(line) || { kind: step.pair === 'model' ? 'model' : step.pair === 'user' ? 'user' : 'tool', count: 0, first: step.events[0]?.id, state: '' };
        entry.count++;
        if (step.status === 'active') entry.state = step.pair === 'user' ? 'waiting' : 'running';
        lines.set(line, entry);
      }
      for (const scope of step.origin.scope) {
        if (!LOOPS.has(scope.kind) || !Number.isInteger(scope.line)) continue;
        const loop = loops.get(scope.line) || { instances: new Map(), total: 0, live: false };
        const instance = scope.instance ?? 1;
        loop.instances.set(instance, Math.max(loop.instances.get(instance) || 0, scope.iteration ?? 1));
        loops.set(scope.line, loop);
      }
    }
  }
  for (const loop of loops.values()) loop.total = [...loop.instances.values()].reduce((sum, count) => sum + count, 0);
  // A loop is still going while the newest effect sits inside it.
  if (live && last) for (const scope of last.origin.scope) if (LOOPS.has(scope.kind) && loops.has(scope.line)) loops.get(scope.line).live = true;
  return { origin, lines, loops, sites: programShape(program).sites };
}
