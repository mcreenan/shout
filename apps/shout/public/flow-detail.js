// Flow step detail: everything one selected Flow card recorded, shown over the side panel.
// The canvas decides what is selected; this view only renders it and offers the way back to the raw
// events and the program source. It takes over its host (the side panel) until it is closed.
import { renderMarkdown } from './markdown-dom.js';
import { formatDuration, modelTask, modelOutput, toolResult, stepFailed, tokens, scopePath, sourceLine, branchLabel, programShape, issueLabel } from './flow.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function iconButton(label, path, onClick) {
  const button = el('button', 'icon-button small');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  button.addEventListener('click', onClick);
  return button;
}
// The latest matching event: after a retry, the last attempt's.
const eventOf = (step, type) => (step.attempts?.at(-1)?.events ?? step.events).findLast((event) => event.type === type);
const clock = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
function pre(text, lines = 400) {
  const all = String(text).split('\n');
  return el('pre', 'fd-pre', all.length > lines ? `${all.slice(0, lines).join('\n')}\n… +${all.length - lines}` : String(text));
}
const json = (value) => pre(JSON.stringify(value, null, 2), 200);

/**
 * Mounts the detail view in `host`. `show(selection)` renders { id, step | message, segment, session }
 * from the canvas's `onSelect`; `hide()` clears it. `reveal(open)` opens or closes the host when the
 * view needs it; the view closes the host again only if it was the one to open it.
 * `openEvent(runId, eventId)`, `openSource(runId, line)` and `openFile(path)` link out; `onClose()` clears the selection.
 */
export function createFlowDetail(host, { openEvent, openSource, openFile, onClose, reveal }) {
  const view = el('section', 'flow-detail');
  view.hidden = true;
  view.setAttribute('aria-label', 'Step detail');
  view.tabIndex = -1;
  host.append(view);
  let opened = false;
  let shownId = null;

  const section = (label, ...content) => {
    const block = el('section', 'fd-section');
    block.append(el('h4', 'fd-label', label), ...content.filter(Boolean));
    return block;
  };
  function files(paths) {
    const row = el('div', 'fd-files');
    for (const path of paths) {
      const chip = el('button', 'fd-file', path);
      chip.type = 'button';
      chip.addEventListener('click', () => openFile?.(path));
      row.append(chip);
    }
    return row;
  }
  function chips(values) {
    const row = el('div', 'fd-chips');
    for (const value of values.filter(Boolean)) row.append(el('span', 'fd-chip', value));
    return row.children.length ? row : document.createDocumentFragment();
  }
  const markdown = (text) => { const body = el('div', 'fd-md'); renderMarkdown(body, text, { openFile }); return body; };

  // Where the step came from: the breadcrumb through calls, loops and branches, and the exact source line.
  function origin(step, run, segment) {
    const out = [];
    const source = run?.source;
    const shape = programShape(segment?.program);
    const path = scopePath(step.origin, source, shape);
    if (path.length > 1) {
      const crumbs = el('nav', 'fd-path');
      crumbs.setAttribute('aria-label', 'Scope');
      path.forEach((item, i) => {
        if (i) crumbs.append(el('span', 'fd-sep', '›'));
        const crumb = el('span', `fd-crumb ${item.kind}`, item.label);
        if (item.title) crumb.title = `${item.line}: ${item.title}`;
        crumbs.append(crumb);
      });
      out.push(crumbs);
    }
    // The conditions behind each branch taken, as written.
    for (const entry of (step.origin?.scope || []).filter((item) => item.kind === 'if' || item.kind === 'match')) {
      const branch = branchLabel(entry, { shape, source });
      if (!branch.title) continue;
      const row = el('div', 'fd-condition');
      row.append(el('span', 'fd-chip branch', branch.label), el('code', '', branch.title.replace(/\s*\{\s*$/, '')));
      out.push(row);
    }
    const line = step.origin?.site?.line;
    if (line && run) {
      const link = el('button', 'fd-source');
      link.type = 'button';
      link.append(el('span', 'fd-source-at', `${run.skill ? `${run.skill}.allen` : 'program'}:${line}`));
      const text = sourceLine(source, line).trim();
      if (text) link.append(el('code', '', text));
      link.addEventListener('click', () => openSource?.(run.id, line));
      out.push(link);
    }
    return out;
  }
  function renderTool(body, step) {
    const input = eventOf(step, 'tool.started')?.input;
    const value = eventOf(step, 'tool.completed')?.value || {};
    const failure = eventOf(step, 'tool.failed');
    if (failure) body.append(el('p', 'fd-error', failure.error?.message || 'Failed'));
    if (Array.isArray(input?.args)) body.append(section('Arguments', pre(input.args.join(' '))));
    else if (input && typeof input === 'object' && Object.keys(input).length) body.append(section('Input', json(input)));
    const result = toolResult(step);
    if (result && !failure) body.append(chips([result]));
    const paths = [
      ...(Array.isArray(value.files) ? value.files.map((file) => (typeof file === 'string' ? file : file?.path)) : []),
      ...(Array.isArray(value.changed) ? value.changed : []),
      ...(Array.isArray(input?.paths) ? input.paths : typeof input?.path === 'string' ? [input.path] : []),
      ...(Array.isArray(input?.edits || input?.changes) ? (input.edits || input.changes).map((edit) => edit?.path) : []),
    ].filter((path) => typeof path === 'string');
    if (paths.length) body.append(section('Files', files([...new Set(paths)].slice(0, 400))));
    if (failure?.problems) body.append(section('Diagnostics', pre(failure.problems)));
    if (Array.isArray(value.matches) && value.matches.length) body.append(section('Matches', pre(value.matches.map((match) => `${match.path}:${match.line}  ${match.text}`).join('\n'))));
    const output = value.output ?? value.test_output ?? value.stdout;
    if (typeof output === 'string' && output.trim()) body.append(section('Output', pre(output)));
    if (typeof value.stderr === 'string' && value.stderr.trim()) body.append(section('Errors', pre(value.stderr)));
  }
  function renderModel(body, step) {
    const prompt = eventOf(step, 'model.started')?.prompt;
    const task = modelTask(prompt);
    const failed = eventOf(step, 'model.failed');
    const out = modelOutput(eventOf(step, 'model.completed')?.value);
    if (failed) body.append(el('p', 'fd-error', failed.error?.message || failed.message || 'Failed'));
    if (task.role) body.append(el('p', 'fd-role', task.role));
    if (task.task) body.append(el('p', 'fd-task', task.task));
    body.append(chips(task.inputs));
    if (out.text) body.append(section('Output', markdown(out.text)));
    if (out.files.length) body.append(section('Files', files(out.files)));
    if (out.items.length) {
      const list = el('ul', 'fd-items');
      for (const item of out.items) {
        const li = el('li', `fd-item ${item.tone || ''}`);
        li.append(el('strong', '', item.title));
        if (item.meta) li.append(el('span', 'fd-item-meta', item.meta));
        if (item.detail) li.append(el('p', '', item.detail));
        list.append(li);
      }
      body.append(section(out.items.some((item) => item.tone !== 'edit') ? 'Findings' : 'Edits', list));
    }
    if (prompt?.system) {
      const details = el('details', 'fd-details');
      details.append(el('summary', '', 'Prompt'), pre(prompt.system));
      body.append(details);
    }
  }
  function renderApproval(body, step) {
    const asked = eventOf(step, 'user.question') || {};
    const value = eventOf(step, 'user.answered')?.value;
    const title = asked.title || asked.prompt?.system;
    if (title) body.append(el('p', 'fd-task', title));
    if (asked.summary && asked.summary !== title) body.append(el('p', 'fd-muted', asked.summary));
    if (asked.command) body.append(pre(asked.command));
    if (Array.isArray(asked.paths) && asked.paths.length) body.append(section('Files', files(asked.paths)));
    if (value && typeof value.accept === 'boolean') body.append(chips([value.accept ? 'Approved' : 'Declined']));
    else if (value !== undefined) body.append(section('Answer', json(value)));
  }
  function renderAgent(body, step) {
    const done = eventOf(step, 'chat.completed');
    if (step.events[0]?.label) body.append(el('p', 'fd-muted', step.events[0].label));
    if (done?.text) body.append(markdown(done.text));
    body.append(chips([done?.tool && done.tool.replace(/_/g, ' ')]));
  }
  // Every attempt of a retried request: how long it took, why it was rejected, and what it answered.
  function attemptList(step) {
    const list = el('ol', 'fd-attempts');
    for (const attempt of step.attempts) {
      const item = el('li', `fd-attempt ${attempt.status}`);
      const top = el('div', 'fd-attempt-head');
      const mark = el('i', `fd-mark ${attempt.status}`);
      mark.title = attempt.status;
      top.append(mark, el('strong', '', `#${attempt.attempt}`), el('span', 'fd-meta', attempt.end !== null && attempt.end > attempt.start ? formatDuration(attempt.end - attempt.start) : ''));
      item.append(top);
      if (attempt.issues?.length) {
        const issues = el('ul', 'fd-issues');
        for (const issue of attempt.issues) {
          // A JSON Pointer into the answer as given, and what was wrong there (the raw code is in the events).
          const line = el('li');
          line.append(el('code', '', String(issue?.path || '/')), el('span', '', issueLabel(issue)));
          issues.append(line);
        }
        item.append(issues);
      }
      const answer = attempt.events.findLast((event) => event.type === 'model.completed' || event.type === 'user.answered')?.value;
      if (answer !== undefined && attempt !== step.attempts.at(-1)) {
        const details = el('details', 'fd-details');
        const text = modelOutput(answer).text;
        details.append(el('summary', '', 'Output'), text ? markdown(text) : json(answer));
        item.append(details);
      }
      list.append(item);
    }
    return section('Attempts', list);
  }
  // The raw events behind the step, each opening in the Events view.
  function eventList(step, runId) {
    const list = el('ol', 'fd-events');
    for (const event of step.events) {
      const item = el('li');
      const link = el('button', 'fd-event');
      link.type = 'button';
      link.append(el('span', 'fd-seq', `#${event.sequence ?? ''}`), el('span', '', event.type));
      link.addEventListener('click', () => openEvent?.(runId, event.id));
      item.append(link);
      list.append(item);
    }
    return section('Events', list);
  }

  function render(selection) {
    const { step, message, session } = selection;
    const run = session?.runs?.find((candidate) => candidate.id === (step?.run || selection.segment?.run));
    const kind = message ? (message.role === 'user' ? 'user' : 'harness') : step.pair === 'user' ? 'user' : step.kind;
    const title = message ? (message.role === 'user' ? 'You' : 'SHOUT') : step.label || step.pair;
    const head = el('header', 'fd-head');
    head.dataset.kind = kind;
    head.append(el('i', 'fd-dot'), el('strong', 'fd-title', title));
    if (step) {
      const failed = stepFailed(step);
      if (step.status === 'active' || failed) head.append(el('span', `fd-state ${failed ? 'failed' : 'active'}`));
    }
    head.append(el('span', 'fd-spacer'), iconButton('Close step details', 'M6 6l12 12M18 6L6 18', () => onClose?.()));
    const body = el('div', 'fd-body');
    const start = step ? step.start : Date.parse(message.time);
    const usage = step?.events.filter((event) => event.usage).reduce((sum, event) => ({ input_tokens: sum.input_tokens + (event.usage.input_tokens || 0), output_tokens: sum.output_tokens + (event.usage.output_tokens || 0) }), { input_tokens: 0, output_tokens: 0 });
    const meta = [clock(start), step && step.end !== null && step.end > step.start ? formatDuration(step.end - step.start) : '', step?.status === 'active' ? 'running' : '', tokens(usage)].filter(Boolean);
    body.append(el('div', 'fd-meta', meta.join(' · ')));
    if (step) body.append(...origin(step, run, selection.segment));
    if (message) body.append(message.role === 'user' ? el('p', 'fd-text', message.content) : markdown(message.content));
    else if (step.pair === 'tool') renderTool(body, step);
    else if (step.pair === 'model') renderModel(body, step);
    else if (step.pair === 'user') renderApproval(body, step);
    else if (step.pair === 'chat') renderAgent(body, step);
    else if (step.detail) body.append(el('p', step.status === 'failed' ? 'fd-error' : 'fd-text', step.events[0]?.message || step.detail));
    if (step?.attempts?.length > 1) body.append(attemptList(step));
    if (step) body.append(eventList(step, step.run));
    return [head, body];
  }

  function show(selection) {
    if (!selection) return hide();
    // A new selection opens the panel if it was closed; updates to the same one never reopen it.
    if (host.hidden && selection.id !== shownId) { opened = true; reveal?.(true); }
    const scroller = view.querySelector('.fd-body');
    const keep = selection.id === shownId ? scroller?.scrollTop || 0 : 0;
    const hadFocus = view.contains(document.activeElement);
    view.replaceChildren(...render(selection));
    view.querySelector('.fd-body').scrollTop = keep;
    shownId = selection.id;
    view.hidden = false;
    host.classList.add('showing-step');
    if (hadFocus) view.focus({ preventScroll: true });
  }
  function hide() {
    if (view.hidden) return;
    const hadFocus = view.contains(document.activeElement);
    view.hidden = true;
    view.replaceChildren();
    shownId = null;
    host.classList.remove('showing-step');
    if (opened) { opened = false; reveal?.(false); }
    if (hadFocus) document.querySelector('.fl-card.selectable:focus-visible, #flow-stage')?.focus?.({ preventScroll: true });
  }
  view.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose?.(); } });
  // Escape with nothing else focused also clears the selection.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || view.hidden || event.defaultPrevented) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    onClose?.();
  });
  return { show, hide, get shown() { return !view.hidden; } };
}
