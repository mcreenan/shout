// Builds the Flow canvas graph: the session so far as top-to-bottom phases.
// Events become steps (flow.js); a run's steps become a control-flow tree from their `origin` (scopeTree);
// the tree becomes rows of nodes, edges and frames (phases). The canvas lays each row out left to right
// under the previous one, using measured card sizes.
import { buildFlow, LOOPS, loopTitle, stepFailed, toolResult, branchLabel, spanText, programShape, clip } from './flow.js';

const READ_TOOL = /read|inspect|search|list|git\.run|find|guide|check/;
const isContext = (step) => step.kind === 'tool' && READ_TOOL.test(step.label) && !/edit|apply|write|test|commit/.test(step.label);
const isHub = (step) => step.pair === 'model' || step.pair === 'chat';
const shown = (message) => message.role === 'user' || message.role === 'assistant';
const taskOf = (step) => step.events.find((event) => event.type === 'model.started')?.prompt?.system?.slice(0, 120) || step.pair;
// A construct compiled more than once (an arm body under an or-pattern) keeps its span: the span, not the id, is the construct.
const where = (entry) => (Number.isInteger(entry.start) ? `${entry.start}-${entry.end}` : entry.construct ?? `${entry.line}:${entry.column}`);
const spanOf = (entry) => ({ line: entry.line, column: entry.column, endLine: entry.end_line, endColumn: entry.end_column });
const shortName = (name) => String(name || '').split('::').pop();
const isLive = (status) => status === 'active' || status === 'waiting';
const statusOf = (step) => (step.status === 'active' && step.pair === 'user' ? 'waiting' : step.status);
// Canvas-worthy steps: calls and questions, errors, cancellations and resumes after a restart. Effect placeholders, the agent
// thread's start, program loading, routing and workspace-change notes are noise or shown elsewhere.
const visible = (step) => !step.orphan && (step.pair
  ? step.pair !== 'effect' && !(step.pair === 'chat' && step.events.some((event) => event.type === 'chat.completed' && event.thread))
  : ['session.error', 'session.cancelled', 'run.resuming'].includes(step.instant));

/* Control flow: a run's steps as a tree of loops (one container per iteration), parallel blocks (one
   track per task) and steps. Pure; everything degrades to a flat list when steps carry no origin. */

// The loops and parallel blocks around a step, outermost first, keyed by the whole path (calls included)
// so a loop entered again, as a new instance or from another call site, is a new group. An await block's
// track is the task spawned directly in it, or else the task running the block; a task spawned outside
// any await block opens a block of its own where it was spawned. `at` is the entry's scope index.
function structure(origin) {
  const path = [];
  let prefix = '';
  let task = 0;
  let block = null;
  origin.scope.forEach((entry, at) => {
    if (entry.kind === 'call') prefix += `/${entry.instruction ?? where(entry)}`;
    else if (LOOPS.has(entry.kind)) {
      const key = `${prefix}/${entry.kind}${where(entry)}#${entry.instance ?? 1}`;
      const iteration = entry.iteration ?? 1;
      path.push({ type: 'loop', key, entry, at, iteration });
      prefix = `${key}.${iteration}`;
    } else if (entry.kind === 'await_block') {
      block = { type: 'parallel', key: `${prefix}/await${where(entry)}`, entry, at, track: task, owner: task, spawn: null };
      path.push(block);
      prefix = block.key;
    } else if (entry.kind === 'spawn') {
      const task_ = entry.task ?? task + 1;
      if (block && !block.spawn && block.owner === task) Object.assign(block, { track: task_, spawn: entry });
      else { block = { type: 'parallel', key: `${prefix}/spawned`, spawned: true, entry, at, track: task_, owner: task, spawn: entry }; path.push(block); prefix = block.key; }
      task = task_;
      prefix += `@${task}`;
    }
  });
  return path;
}
// The if/match branches between a container's own entry and an item. The innermost one the previous
// item in that container was not already inside becomes the item's chip.
function chipFor(container, origin, to) {
  if (!origin) return null;
  const taken = origin.scope.slice(container.at + 1, Math.max(container.at + 1, to)).filter((entry) => entry.kind === 'if' || entry.kind === 'match');
  const keys = taken.map((entry) => `${where(entry)}:${entry.branch ?? entry.arm}`);
  const before = container.branches || [];
  container.branches = keys;
  return taken.filter((_, i) => !before.includes(keys[i])).at(-1) || null;
}
// A track is named by the function its task runs: the spawn that started it, or the first call inside.
function trackName(origin, part) {
  const call = part.spawn || origin?.scope.slice(part.at + 1).find((entry) => entry.kind === 'call');
  const name = call?.function || origin?.site?.function;
  return { name: name ? shortName(name) : part.track ? `task ${part.track}` : 'main', call };
}
// Tracks running the same function are told apart by their call as written, e.g. `size_of("a.mjs")`.
function trackTitles(tracks, source) {
  const names = tracks.map((track) => track.name);
  return tracks.map((track) => {
    if (names.indexOf(track.name) === names.lastIndexOf(track.name)) return track.name;
    const text = (track.call ? spanText(source, spanOf(track.call)) : '').replace(/\s+/g, ' ').replace(/^(spawn|await)\s+/, '').replace(/;\s*$/, '').trim();
    return text.startsWith(track.name) ? clip(text, 48) : `${track.name} · ${track.task}`;
  });
}
function enter(container, part, step) {
  const last = container.items.at(-1);
  if (part.type === 'loop') {
    let loop = last?.type === 'loop' && last.key === part.key ? last : null;
    if (!loop) container.items.push(loop = { type: 'loop', key: part.key, entry: part.entry, iterations: [], chip: chipFor(container, step.origin, part.at) });
    let iteration = loop.iterations.at(-1);
    if (iteration?.index !== part.iteration) loop.iterations.push(iteration = { index: part.iteration, items: [], at: part.at });
    return iteration;
  }
  let block = last?.type === 'parallel' && last.key === part.key ? last : null;
  if (!block) container.items.push(block = { type: 'parallel', key: part.key, spawned: !!part.spawned, until: part.until, tracks: [], chip: chipFor(container, step.origin, part.at) });
  let track = block.tracks.find((candidate) => candidate.task === part.track);
  if (!track) block.tracks.push(track = { task: part.track, key: `${part.key}@${part.track}`, ...trackName(step.origin, part), items: [], at: part.at });
  return track;
}
// A block with one track was not parallel after all: its steps rejoin the surrounding sequence.
function settle(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'loop') for (const iteration of item.iterations) iteration.items = settle(iteration.items);
    if (item.type !== 'parallel') { out.push(item); continue; }
    for (const track of item.tracks) track.items = settle(track.items);
    if (item.tracks.length > 1) { out.push(item); continue; }
    const inner = item.tracks[0].items;
    if (inner[0] && !inner[0].chip) inner[0].chip = item.chip;
    out.push(...inner);
  }
  return out;
}
/**
 * A run's steps (in order) as a control-flow tree. Items:
 *   { type: 'step', step, chip }                       chip: the if/match entry this step entered, if any
 *   { type: 'loop', key, entry, chip, iterations: [{ index, items }] }
 *   { type: 'parallel', key, chip, tracks: [{ task, key, name, call, items }] }
 * Steps without an origin (host approvals) stay where the step before them was. While tasks spawned
 * outside an await block are still going, the spawner's own steps join their block as its track.
 */
export function scopeTree(steps) {
  const root = { items: [], at: -1 };
  let path = [];
  const paths = steps.map((step) => (path = step.origin ? structure(step.origin) : path));
  const until = new Map();
  paths.forEach((parts, i) => { for (const part of parts) if (part.spawned) until.set(part.key, Math.max(until.get(part.key) ?? 0, steps[i].end ?? Infinity)); });
  steps.forEach((step, i) => {
    let container = root;
    const parts = paths[i];
    for (let depth = 0; depth <= parts.length; depth++) {
      const part = parts[depth];
      const last = container.items.at(-1);
      if (last?.spawned && last.key !== part?.key && step.start < last.until && last.tracks.some((track) => track.task !== (part?.owner ?? step.origin?.task))) {
        container = enter(container, { type: 'parallel', key: last.key, at: container.at, track: part?.owner ?? step.origin?.task ?? 0 }, step);
      }
      if (part) container = enter(container, { ...part, until: until.get(part.key) }, step);
    }
    container.items.push({ type: 'step', step, chip: chipFor(container, step.origin, step.origin?.scope.length ?? 0) });
  });
  return settle(root.items);
}
export function leaves(items) {
  return items.flatMap((item) => (item.type === 'step' ? [item.step] : item.type === 'loop' ? item.iterations.flatMap((iteration) => leaves(iteration.items)) : item.tracks.flatMap((track) => leaves(track.items))));
}

/* Graph */
function stepNode(step) {
  // A fan-out to sub-agents is one fleet card; its agents are found by `group`, the spawn's effect ID.
  if (step.pair === 'tool' && step.label === 'agents.spawn') return { id: step.id, type: 'fleet', kind: 'agent', status: statusOf(step), step, group: step.events.find((event) => event.type === 'tool.started')?.effectId ?? null };
  const type = isHub(step) ? 'hub' : step.pair === 'user' ? 'approval' : step.kind === 'tool' ? 'tool' : 'note';
  return { id: step.id, type, kind: step.pair === 'user' ? 'user' : step.kind, status: statusOf(step), step };
}
// Replies are SHOUT's, or the sub-agent's whose canvas this is (`actor`).
function messageNode(message, actor) {
  return { id: message.id, type: 'msg', kind: message.role === 'user' ? 'user' : actor?.kind || 'harness', status: 'ok', message };
}
const chipOf = (entry, ctx) => entry && { ...branchLabel(entry, ctx), line: entry.line };
// What a step came to, in a few words: a tool's result or argument, a judgment's summary, a question's title.
function outcomeOf(step) {
  if (!step) return '';
  if (step.pair === 'model') {
    // Only the latest attempt's answer: a retry in progress has none yet.
    const value = (step.attempts?.at(-1)?.events ?? step.events).findLast((event) => event.type === 'model.completed')?.value;
    const text = [value?.summary, value?.markdown, value?.text].find((candidate) => typeof candidate === 'string' && candidate.trim());
    return text ? clip(text.replace(/\*\*|`/g, ''), 90) : '';
  }
  return (step.pair === 'tool' && toolResult(step)) || step.detail || '';
}
// One line for a step inside a tile: what it is and how it came out.
const activity = (step) => (step ? `${step.label}${outcomeOf(step) ? ` · ${outcomeOf(step)}` : ''}` : '');
function pip(step) {
  const kind = stepFailed(step) ? 'x' : isHub(step) ? 'm' : step.pair === 'user' ? 'w' : 't';
  return isLive(statusOf(step)) ? `${kind} live` : kind;
}
// Iterations, stacks and tracks summarise their steps the same way. An iteration or a task failed if any
// of its steps did; a stack (one step per iteration) reads as failed only when its latest step did.
function summary(steps, { any = true } = {}) {
  const start = Math.min(...steps.map((step) => step.start));
  const end = steps.every((step) => step.end !== null) ? Math.max(...steps.map((step) => step.end)) : null;
  const statuses = steps.map(statusOf);
  const failed = steps.filter(stepFailed).length;
  const status = statuses.includes('waiting') ? 'waiting' : statuses.includes('active') ? 'active' : (any ? failed : stepFailed(steps.at(-1))) ? 'failed' : statuses.every((value) => value === 'stale') ? 'stale' : 'ok';
  const current = steps.find((step) => isLive(statusOf(step))) || steps.at(-1);
  return { start, end, status, failed, activity: activity(current), outcome: outcomeOf(current), pips: steps.map(pip) };
}

// The prose older sessions recorded for an answer (session.mjs `answer`).
const ECHO_PROSE = /^(?:Apply these changes(?: and run the configured tests)?\.|Decline these changes\.|Decline this command\.|Run `[\s\S]+`\.|Answered: [\s\S]+)$/;
// Messages and run blocks in time order; your message sorts before the run it triggered, replies after.
function timeline(session, segments, now) {
  const items = [];
  const runs = segments.filter((segment) => segment.run);
  // Answering a question also records the answer in the chat as `message.echo`; the approval card
  // already shows it. Sessions from before `echo` have only its prose, recorded just after the answer:
  // those are hidden only when both the words and the moment match.
  const answers = segments.flatMap((segment) => segment.steps.flatMap((step) => step.events)).filter((event) => event.type === 'user.answered').map((event) => Date.parse(event.time));
  const echo = (message, time) => !!message.echo || (!('echo' in message) && message.role === 'user' && ECHO_PROSE.test(String(message.content).trim()) && answers.some((at) => time >= at && time - at < 2000));
  (session.messages || []).forEach((message, order) => {
    const time = Date.parse(message.time);
    if (!shown(message) || time > now || echo(message, time)) return;
    // Runs are drawn whole: anything said while one was going sorts after it.
    const inside = runs.find((segment) => time > segment.start && time < (segment.end ?? Infinity));
    items.push({ time: inside?.end ?? time, rank: message.role === 'user' ? 0 : 2, message, order });
  });
  for (const segment of segments) {
    if (segment.run) items.push({ time: segment.start, rank: 1, run: segment });
    else for (const step of segment.steps) if (visible(step)) items.push({ time: step.start, rank: 1, step, segment });
  }
  // Messages stamped in the same millisecond keep the order they were said in.
  return items.sort((a, b) => a.time - b.time || (a.message && b.message ? a.order - b.order : a.rank - b.rank));
}

/**
 * Phases: the session as rows of nodes. Without control-flow data, reads fan in to the judgment they
 * inform and edits, approvals and tests fan out of it; consecutive same-task judgments share a row.
 * With it, steps follow their program: loops become stacks (one step per iteration) or groups (tiles,
 * one iteration expanded in a frame), await blocks become parallel tracks, branches become chips.
 * `ui` holds the canvas's choices: `open` (group id → iteration index, or null once closed by hand)
 * and `stacks` (ids of stacks listing their steps). `actor` ({ name, kind }) says whose replies these
 * are when the canvas shows a sub-agent. A fan-out to sub-agents (`agents.spawn`) is a fleet node alone in its row.
 * Returns { rows: [{ key, kind, ids, open, close }], nodes, edges, frames, focus, index } where rows
 * name the frames that start before / end after them and `index` maps step and message ids to
 * { step | message, segment, node } (node: the id of the card showing it).
 */
export function phases({ session, events, now = Date.now(), live = false, ui = {}, actor = null }) {
  const choices = ui.open || new Map();
  const stacks = ui.stacks || new Set();
  const nodes = [];
  const edges = [];
  const rows = [];
  const frames = [];
  const index = new Map();
  const filling = []; // frames being filled, outermost first
  let opening = []; // frames that start with the next row
  let anchors = [];
  let open = null; // the row still accepting nodes
  const close = () => { if (open) { anchors = open.ids; open = null; } };
  const row = (kind, extra = {}) => { close(); open = { key: `row${rows.length}`, kind, ids: [], from: anchors, open: opening, close: [], ...extra }; opening = []; rows.push(open); return open; };
  const add = (node, target) => {
    nodes.push(node);
    target.ids.push(node.id);
    for (const frame of filling) frame.members.push(node.id);
    for (const source of target.from) edges.push({ from: source, to: node.id });
    return node;
  };
  const framed = (frame, fill) => {
    close();
    Object.assign(frame, { members: [], below: 0 });
    frames.push(frame);
    filling.push(frame);
    opening.push(frame.key);
    fill();
    close();
    filling.pop();
    if (!frame.members.length) { frames.splice(frames.indexOf(frame), 1); opening = opening.filter((key) => key !== frame.key); return; }
    rows.at(-1).close.push(frame.key);
    if (filling.length) filling.at(-1).below = Math.max(filling.at(-1).below, frame.below + 1);
  };
  const leaf = (step, segment, chip, heuristic) => {
    const node = stepNode(step);
    if (chip) node.chip = chip;
    index.set(step.id, { step, segment, node: node.id });
    if (!heuristic || node.type === 'fleet') return add(node, row(node.type === 'fleet' ? 'fleet' : 'step'));
    if (isHub(step)) {
      const task = taskOf(step);
      // Another batch of the same judgment joins its siblings' row, fed by the same inputs.
      return add(node, open?.kind === 'hub' && open.task === task ? open : row('hub', { task }));
    }
    if (isContext(step)) return add(node, open?.kind === 'context' ? open : row('context'));
    // Actions fan out of the same judgment until something else happens.
    return add(node, open?.kind === 'action' ? open : row('action'));
  };
  const hide = (steps, ctx, id) => { for (const step of steps) index.set(step.id, { step, segment: ctx.segment, node: id }); };
  const single = (items) => items.length === 1 && items[0].type === 'step';

  function groupNode(id, item, title, ctx) {
    const iterations = item.iterations.map((iteration) => {
      const steps = leaves(iteration.items);
      hide(steps, ctx, id);
      return { index: iteration.index, ...summary(steps), items: iteration.items, steps };
    });
    const running = ctx.running ? iterations.find((iteration) => iteration.steps.includes(ctx.last)) : null;
    const choice = choices.get(id);
    // Closed unless chosen; while it runs, the live iteration shows.
    const openIndex = choice === undefined ? running?.index ?? null : iterations.some((iteration) => iteration.index === choice) ? choice : null;
    const all = iterations.flatMap((iteration) => iteration.steps);
    const { start, end, status } = summary(all, { any: false });
    return {
      id, type: 'group', kind: 'vm', title, loop: item.entry.kind, status: isLive(status) ? status : iterations.at(-1).status === 'failed' ? 'failed' : status === 'stale' ? 'stale' : 'ok',
      start, end, ended: !running, failed: iterations.filter((iteration) => iteration.failed).length, open: openIndex, chip: chipOf(item.chip, ctx),
      iterations: iterations.map(({ items, steps, ...rest }) => rest),
    };
  }
  function stackNode(id, item, title, ctx) {
    const steps = item.iterations.map((iteration) => iteration.items[0].step);
    hide(steps, ctx, id);
    const labels = new Set(steps.map((step) => step.label));
    return {
      id, type: 'stack', kind: steps[0].pair === 'user' ? 'user' : steps[0].kind, title: labels.size === 1 ? steps[0].label : title, bare: labels.size === 1,
      steps, ...summary(steps, { any: false }), ended: !(ctx.running && steps.includes(ctx.last)), open: stacks.has(id), chip: chipOf(item.chip, ctx),
    };
  }
  function placeItem(item, ctx) {
    if (item.type === 'step') return leaf(item.step, ctx.segment, chipOf(item.chip, ctx), false);
    if (item.type === 'parallel') {
      const target = row('tracks');
      const titles = trackTitles(item.tracks, ctx.source);
      item.tracks.forEach((track, i) => {
        const id = `${ctx.segment.run}${track.key}`;
        const steps = leaves(track.items);
        hide(steps, ctx, id);
        add({ id, type: 'track', kind: 'vm', title: titles[i], steps, ...summary(steps), chip: i ? null : chipOf(item.chip, ctx) }, target);
      });
      return close();
    }
    const id = `${ctx.segment.run}${item.key}`;
    const title = loopTitle(ctx.source, item.entry);
    const { iterations } = item;
    if (iterations.length === 1) {
      const [only] = iterations;
      if (single(only.items)) return placeItem({ ...only.items[0], chip: only.items[0].chip || item.chip }, ctx);
      // A loop that has run once so far reads as its body, framed under its header.
      if (item.chip && !only.items[0].chip) only.items[0] = { ...only.items[0], chip: item.chip };
      const going = ctx.running && leaves(only.items).includes(ctx.last);
      return framed({ key: `frame:${id}`, kind: 'loop', label: title, count: 1, ended: !going, state: going ? 'active' : '' }, () => place(only.items, ctx));
    }
    if (iterations.every((iteration) => single(iteration.items))) return add(stackNode(id, item, title, ctx), row('stack'));
    const node = groupNode(id, item, title, ctx);
    if (node.open === null) return add(node, row('group'));
    return framed({ key: `frame:${id}`, kind: 'group', state: isLive(node.status) ? 'active' : '' }, () => {
      add(node, row('group'));
      close();
      place(iterations.find((iteration) => iteration.index === node.open).items, ctx);
    });
  }
  function place(items, ctx) { for (const item of items) placeItem(item, ctx); }

  for (const item of timeline(session, buildFlow(events, { live, now }), now)) {
    if (item.message) {
      const node = messageNode(item.message, actor);
      index.set(node.id, { message: item.message, node: node.id });
      add(node, row('message'));
      close();
      continue;
    }
    if (item.run) {
      const segment = item.run;
      const steps = segment.steps.filter(visible);
      if (!steps.length) continue;
      const run = session.runs?.find((candidate) => candidate.id === segment.run);
      const ctx = { segment, source: run?.source, shape: programShape(segment.program), running: segment.end === null, last: steps.at(-1) };
      const label = run?.skill ? `/${run.skill}` : run?.generated ? 'program' : '';
      framed({ key: `run:${segment.run}`, kind: 'run', run: segment.run, label, state: segment.end === null ? 'active' : segment.state }, () => {
        if (steps.some((step) => step.origin)) place(scopeTree(steps), ctx);
        else for (const step of steps) leaf(step, segment, null, true);
      });
      continue;
    }
    leaf(item.step, item.segment, null, true);
  }
  // SHOUT's closing reply, once the run is over, is the answer: it renders in full.
  const last = nodes.at(-1);
  if (!live && last?.type === 'msg' && last.message.role === 'assistant') last.final = true;
  const active = nodes.filter((node) => isLive(node.status));
  return { rows: rows.map(({ key, kind, ids, open: starts, close: ends }) => ({ key, kind, ids, open: starts, close: ends })), nodes, edges, frames, focus: (active.at(-1) || nodes.at(-1))?.id, index };
}
