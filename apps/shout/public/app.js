import { CHAT, uid, createLayout, groups, findGroup, groupOfTab, focusedGroup, activate, addTab, moveTab, closeTab, splitWith, normalize, resize, serialize, restore } from './layout.js';
import { languageFor, languageLabel, highlightLines, renderTokens } from './highlight.js';
import { codeBlock, renderMarkdown } from './markdown-dom.js';
import { createFlowCanvas } from './flow-canvas.js';
import { createFlowDetail } from './flow-detail.js';
import { createAgentPane } from './flow-agent.js';
import { programActivity, runFailure } from './flow.js';
import { popover, renderModels, renderEfforts, renderMenu } from './model-picker.js';
import { askForm, kindOf } from './ask-form.js';
import * as shell from './desktop.js';
import { initSidebar, renderSidebar, renderWelcome, renderProviders, setLists, startLive, upsert, handleShortcut, newThread } from './sidebar.js';
import { summarize } from './sidebar-logic.js';

const $ = (id) => document.getElementById(id);
const state = { chatMode: localStorage.getItem('shout.chatMode') === 'flow' ? 'flow' : 'chat', config: null, sessions: [], session: null, stream: null, messageSignature: '', questionSignature: '', busy: false, drafts: new Map(), selection: 0, opening: null, layout: createLayout(), side: 'summary', files: null, filesError: '', expanded: new Set(), lastStatus: null, skills: { sessionId: null, list: null, error: '', at: 0, pending: null } };
const terminal = new Set(['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'idle', 'ready']);
const VIEWS = { trace: { label: 'Events', icon: 'i-list' }, changes: { label: 'Changes', icon: 'i-diff' } };
const PROGRAM = { label: 'Program', icon: 'i-code' };
const ACTIVE_RUN = new Set(['starting', 'running', 'waiting_user']);
const LANES = [['You', 'user'], ['SHOUT', 'harness'], ['Model', 'model'], ['ALLEN', 'vm'], ['Tools', 'tool']];
const SCOPE_LABEL = { workspace: 'Workspace', user: 'User', builtin: 'Built-in', command: 'Command' };
// Panes for file and visualization tabs, keyed by tab ID. The chat pane is the static #chat-pane element.
const panes = new Map();
const scrollMemory = new WeakMap();
let toastTimer;
let dragPayload = null;
// Slash-command autocomplete state for the composer.
const slash = { items: [], index: 0, dismissed: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}
function iconButton(name, label, onClick, className = 'icon-button') {
  const button = el('button', className);
  button.type = 'button';
  button.append(icon(name));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', onClick);
  return button;
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Shout-Client': '1', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { code: data.code, path: data.path });
  return data;
}
function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function isActive(session = state.session) {
  return !!session && !terminal.has(session.status) && !!session.status;
}
const basename = (path) => path.split('/').pop();
function appendContent(container, text) {
  // Fenced code only. Everything is textContent; model output cannot become HTML.
  const chunks = String(text).split(/```([^\n`]*)\n([\s\S]*?)```/g);
  for (let i = 0; i < chunks.length; i += 3) {
    if (chunks[i]) container.append(el('div', '', chunks[i]));
    if (i + 2 < chunks.length) {
      const lang = chunks[i + 1].trim();
      if (lang) container.append(el('div', 'code-language', lang));
      container.append(codeBlock(chunks[i + 2], languageFor(`x.${lang || 'txt'}`)));
    }
  }
}
// Assistant replies render as Markdown built with DOM nodes only; model output cannot become HTML.
function appendMarkdown(container, text) {
  renderMarkdown(container, text, { openFile: (path) => openFile(path, { split: 'right' }) });
}
function runStart(run) {
  return state.session?.events?.find((event) => event.run === run.id)?.time;
}
// The effects a run performed, in order: the observable shape of the ALLEN program's execution.
function runSteps(run) {
  return (state.session?.events || []).filter((event) => event.run === run.id && ['tool.started', 'model.started', 'user.question'].includes(event.type))
    .map((event) => ({ event, label: event.type === 'tool.started' ? event.tool : event.type === 'model.started' ? 'model.request' : 'user.ask', kind: classify(event).kind }));
}
const stateText = (value) => (value || 'unknown').replace(/_/g, ' ');
// A dot for a run or session state; the words are its tooltip and accessible name.
function stateDot(kind, label) {
  const dot = el('span', `state-dot ${kind}`);
  dot.setAttribute('role', 'img');
  dot.setAttribute('aria-label', label);
  dot.title = label;
  return dot;
}
const runDot = (run) => stateDot(run.state === 'waiting_user' ? 'question' : runStateKind(run.state), `Run ${state.session.runs.indexOf(run) + 1} · ${stateText(run.state)}`);
const openRuns = new Set();
// Icon, name and status dot, then the latest steps in one muted line; expanded, every step.
function runCard(run) {
  const card = el('div', `run-card${openRuns.has(run.id) ? ' expanded' : ''}`);
  card.dataset.run = run.id;
  const title = el('span', 'run-card-title');
  // A skill's name opens its source in a tab; a program the agent wrote has no skill to open.
  let name = el('strong', '', runName(run));
  if (run.skill) {
    const open = el('button', 'run-skill');
    open.type = 'button';
    open.setAttribute('aria-label', `Open skill /${run.skill}`);
    open.append(name);
    open.addEventListener('click', () => openSkill(run.skill));
    name = open;
  }
  title.append(icon(run.skill ? 'i-skill' : 'i-code'), name, runDot(run));
  card.append(title);
  // A run that failed inside its program opens the Program tab on the failing line.
  const failure = runFailure(run);
  if (failure) {
    const at = el('button', 'run-state run-failed-at', `failed at line ${failure.line}`);
    at.type = 'button';
    if (failure.message) at.title = failure.message;
    at.addEventListener('click', () => showProgramLine(run.id, failure.line));
    card.append(at);
  } else if (['failed', 'interrupted', 'cancelled'].includes(run.state)) card.append(el('span', 'run-state', stateText(run.state)));
  const all = runSteps(run);
  const actions = el('div', 'run-card-actions');
  if (all.length) {
    const steps = el('ol', `run-steps${all.length > 6 ? ' long' : ''}`);
    if (all.length > 60) steps.append(el('li', 'run-step more', `+${all.length - 60}`));
    for (const step of all.slice(-60)) steps.append(el('li', `run-step ${step.kind}`, step.label));
    card.append(steps);
    const toggle = iconButton('i-chevron', 'Steps', () => {
      const open = !openRuns.delete(run.id);
      if (open) openRuns.add(run.id);
      card.classList.toggle('expanded', open);
      toggle.setAttribute('aria-expanded', String(open));
    }, 'icon-button small steps-toggle');
    toggle.setAttribute('aria-expanded', String(openRuns.has(run.id)));
    actions.append(toggle);
  }
  actions.append(iconButton('i-code', 'View program', () => openProgram(run.id, { beside: true }), 'icon-button small'), iconButton('i-flow', 'Flow', () => showFlowChat(run.id), 'icon-button small'));
  card.append(actions);
  return card;
}
const answerText = (value) => (typeof value === 'string' ? value : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : JSON.stringify(value));
// Approvals and answers the session records for you: `message.echo`, or in messages saved before it
// the prose ("Apply these changes.", "Run `npm test`.", "Answered: …").
function echoOf(message) {
  if (message.role !== 'user' && message.role !== 'system') return null;
  const echo = message.echo;
  if (echo?.kind === 'approval') return echo.accept ? { kind: 'approved', label: 'Approved', detail: echo.command } : { kind: 'declined', label: 'Declined' };
  if (echo?.kind === 'answer') return { kind: 'answered', label: 'Answered', detail: answerText(echo.value) };
  const text = String(message.content).replace(/^\[[\w-]+\] /, '');
  const command = /^Run `([\s\S]+)`\.$/.exec(text);
  const answer = /^Answered: ([\s\S]*)$/.exec(text);
  if (text === 'Apply these changes.' || command) return { kind: 'approved', label: 'Approved', detail: command?.[1] };
  if (text === 'Decline these changes.' || text === 'Decline this command.') return { kind: 'declined', label: 'Declined' };
  if (!answer) return null;
  let detail = answer[1];
  try { detail = answerText(JSON.parse(detail)); } catch {}
  return { kind: 'answered', label: 'Answered', detail };
}
function messageItem(message) {
  const role = ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : 'system';
  const echo = echoOf(message);
  const item = el('article', `message ${role}${echo ? ' echo' : ''}`);
  item.dataset.messageId = message.id;
  const stamp = el('time', 'message-time', time(message.time));
  if (echo) {
    const chip = el('span', `echo-chip ${echo.kind}`);
    chip.append(icon(echo.kind === 'approved' ? 'i-check' : echo.kind === 'declined' ? 'i-x' : 'i-chat'), echo.label);
    if (echo.detail) {
      const detail = el('span', 'echo-detail', echo.detail);
      if (echo.detail.length > 48) detail.title = echo.detail;
      chip.append(detail);
    }
    item.append(chip, stamp);
    return item;
  }
  const body = el('div', 'message-body');
  if (role === 'system' || role === 'tool') body.append(el('div', 'message-label', role === 'tool' ? 'Tool' : 'System'));
  const content = el('div', 'message-text');
  if (role === 'assistant') appendMarkdown(content, message.content); else appendContent(content, message.content);
  body.append(content);
  // A run's failure message links to the failing line.
  const failure = message.failure;
  if (failure && typeof failure.run === 'string' && Number.isInteger(failure.line)) {
    const link = el('button', 'message-line', `line ${failure.line}`);
    link.type = 'button';
    link.setAttribute('aria-label', `Open the program at line ${failure.line}`);
    link.addEventListener('click', () => showProgramLine(failure.run, failure.line));
    body.append(link);
  }
  item.append(body, stamp);
  return item;
}
function renderMessages() {
  const messages = state.session?.messages || [];
  const runs = state.session?.runs || [];
  // Flow mode draws the session on the canvas, which reads it every frame; the welcome stays in the list.
  const flow = state.chatMode === 'flow' && messages.length > 0;
  $('messages').hidden = flow;
  $('flow-stage').hidden = !flow;
  $('chat-pane').classList.toggle('flow-mode', flow);
  if (flow) return syncFlowCanvas();
  const signature = JSON.stringify([state.session?.id, messages, runs.map((run) => [run.id, run.state, runFailure(run)?.line, runSteps(run).map((step) => step.label)])]);
  if (signature === state.messageSignature) return;
  state.messageSignature = signature;
  const list = $('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  list.replaceChildren();
  if (!messages.length) list.append(renderWelcome());
  // Each run's card sits before the first message recorded after the run started.
  const pending = runs.map((run) => ({ run, start: runStart(run) })).filter((item) => item.start);
  const flushRuns = (before) => {
    while (pending.length && (before === undefined || pending[0].start < before)) list.append(runCard(pending.shift().run));
  };
  for (const message of messages) {
    flushRuns(message.time);
    list.append(messageItem(message));
  }
  flushRuns();
  if (nearBottom || messages.length <= 1) list.scrollTop = list.scrollHeight;
}
/* Flow mode: the chat pane shows the session as a canvas of phases, the composer stays underneath. */
let flowCanvas = null;
let flowDetail = null;
let detailCanvas = null; // the canvas whose selection the detail shows
function flowSource() {
  const session = state.session;
  return session?.messages?.length ? { session, events: session.events || [], now: Date.now(), live: isActive(session) } : null;
}
// Hook: a selected card's detail (flow-detail.js) takes over the side panel, opening it if it was closed.
// One detail serves every canvas (the chat's and each sub-agent tab's); a new selection clears the other's.
function flowSelect(canvas) {
  flowDetail ??= createFlowDetail($('side-panel'), {
    openFile: (path) => openFile(path, { split: 'right' }),
    openEvent: (run, id) => openViz('trace', { beside: true, apply: (tab) => Object.assign(tab, { runFilter: run || '', eventFilter: '', selectedEvent: id }) }),
    openSource: showProgramLine,
    onClose: () => detailCanvas?.select(null),
    reveal: (open) => { $('side-panel').hidden = !open; renderSide(); },
  });
  return (selection) => {
    if (!selection) { if (detailCanvas === canvas()) { detailCanvas = null; flowDetail.hide(); } return; }
    const previous = detailCanvas;
    detailCanvas = canvas();
    if (previous && previous !== detailCanvas) previous.select(null);
    flowDetail.show(selection);
  };
}
function syncFlowCanvas() {
  if (!flowCanvas) {
    // The composer floats over the canvas; the followed card sits just above it, whatever its height.
    flowCanvas = createFlowCanvas($('flow-stage'), { anchor: () => $('composer-area').offsetHeight + 20, openFile: (path) => openFile(path, { split: 'right' }), onSelect: flowSelect(() => flowCanvas), openAgent });
    flowCanvas.start(flowSource);
  }
  if (flowCanvas.sessionId !== state.session?.id) { flowCanvas.reset(); flowCanvas.sessionId = state.session?.id; }
}
/* Sub-agents: a fleet tile opens the agent's Flow in a tab beside the chat, or focuses it. */
function openAgent(id) {
  const existing = Object.values(state.layout.tabs).find((tab) => tab.kind === 'agent' && tab.agent === id);
  if (existing) activate(state.layout, existing.id);
  else place({ id: uid('agent'), kind: 'agent', agent: id }, { beside: true });
  commitLayout();
}
const agentOfTab = (tab) => state.session?.agents?.find((agent) => agent.id === tab.agent);
function agentPane(tab) {
  let pane = null;
  pane = createAgentPane(tab, { session: () => state.session, modelLabel: (id) => state.config?.models?.find((model) => model.id === id)?.label || id, openFile: (path) => openFile(path, { split: 'right' }), onSelect: flowSelect(() => pane.canvas) });
  return pane;
}
function renderAgentPanes() {
  for (const tab of Object.values(state.layout.tabs)) if (tab.kind === 'agent') panes.get(tab.id)?.refresh();
}
function setChatMode(mode) {
  state.chatMode = mode === 'flow' ? 'flow' : 'chat';
  localStorage.setItem('shout.chatMode', state.chatMode);
  for (const button of $('chat-mode').children) button.setAttribute('aria-checked', String(button.dataset.mode === state.chatMode));
  if (state.chatMode === 'chat') flowCanvas?.select(null);
  state.messageSignature = '';
  renderMessages();
  if (state.chatMode === 'chat') $('messages').scrollTop = $('messages').scrollHeight;
}
function showFlowChat(runId) {
  setChatMode('flow');
  activate(state.layout, CHAT);
  commitLayout();
  // The canvas lays the run out on its next frames; then scroll to it.
  if (runId) setTimeout(() => flowCanvas?.showRun(runId), 120);
}
// ALLEN Option values arrive as { tag: 'Some', value } / { tag: 'None' }; plain values pass through.
function optionValue(value) {
  if (value && typeof value === 'object' && (value.tag === 'Some' || value.tag === 'None') && Object.keys(value).every((key) => key === 'tag' || key === 'value')) return value.value;
  return value;
}
async function answerQuestion(question, value, controls) {
  for (const control of controls) control.disabled = true;
  const reply = replyGuard();
  try {
    reply(await api(`/sessions/${encodeURIComponent(state.session.id)}/answer`, { method: 'POST', body: { id: question.id, value } }));
  } catch (error) {
    toast(error.message);
    for (const control of controls) control.disabled = false;
  }
}
function questionDetails(question) {
  const parts = [['Context', optionValue(question.prompt?.context)], ['Data', optionValue(question.prompt?.data)]].filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!parts.length) return null;
  const details = el('details', 'question-details');
  details.append(el('summary', '', 'Details'));
  for (const [name, value] of parts) {
    if (parts.length > 1) details.append(el('div', 'details-label', name));
    details.append(typeof value === 'string' ? el('div', 'details-text', value) : codeBlock(JSON.stringify(value, null, 2), 'json'));
  }
  return details;
}
// Two lines; the rest on click, when there is more.
function clampedSummary(text) {
  const summary = el('p', 'question-summary', text);
  requestAnimationFrame(() => {
    if (summary.scrollHeight <= summary.clientHeight + 1) return;
    const toggle = () => summary.setAttribute('aria-expanded', String(summary.getAttribute('aria-expanded') !== 'true'));
    summary.tabIndex = 0;
    summary.setAttribute('role', 'button');
    summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', toggle);
    summary.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
  });
  return summary;
}
// One chip per proposed file with its diffstat; each opens Changes at that file.
function changeChips(changes) {
  const list = el('div', 'change-chips');
  const chip = (onClick) => {
    const button = el('button', 'change-chip');
    button.type = 'button';
    button.addEventListener('click', onClick);
    list.append(button);
    return button;
  };
  for (const change of changes.slice(0, 6)) {
    const button = chip(() => openViz('changes', { beside: true, apply: (tab) => { tab.focusPath = change.path; } }));
    button.append(el('span', 'chip-name', basename(change.path)), diffStat(changeStats(change)));
    button.setAttribute('aria-label', change.path);
    if (basename(change.path) !== change.path) button.title = change.path;
  }
  if (changes.length > 6) chip(() => openViz('changes', { beside: true })).textContent = `+${changes.length - 6}`;
  return list;
}
// Title, the command and what approving it means, a clamped summary, the files; then Approve or Decline.
function approvalCard(question, card) {
  const data = optionValue(question.prompt?.data);
  const command = typeof question.command === 'string' && question.command ? question.command : null;
  card.append(el('h3', '', typeof question.title === 'string' && question.title ? question.title : command ? 'Run this command?' : 'Approve these changes?'));
  if (command) {
    const note = el('div', 'question-note');
    note.append(icon('i-shield'), 'Runs with your user permissions.');
    card.append(codeBlock(command, 'sh'), note);
  }
  if (typeof question.prompt === 'string' && question.prompt) card.append(el('p', '', question.prompt));
  if (typeof data?.summary === 'string' && data.summary.trim()) card.append(clampedSummary(data.summary.trim()));
  const changes = Array.isArray(data?.changes) ? data.changes : command ? [] : state.session.changes || [];
  if (changes.length) card.append(changeChips(changes));
  const actions = el('div', 'question-actions');
  const approve = el('button', 'primary-button', 'Approve');
  const decline = el('button', 'secondary-button', 'Decline');
  approve.addEventListener('click', () => answerQuestion(question, { accept: true }, [approve, decline]));
  decline.addEventListener('click', () => answerQuestion(question, { accept: false }, [approve, decline]));
  actions.append(approve, decline);
  card.append(actions);
}
// The answer given last time a question JOSH asks again (same interaction), so only what was rejected needs fixing.
const askAnswers = new Map();
function previousAnswer(question) {
  if (typeof question.interaction !== 'string' || !(question.attempt > 1)) return undefined;
  const events = state.session.events || [];
  const asked = events.findLast((event) => event.type === 'user.question' && event.interaction === question.interaction && event.effectId !== question.id);
  const answered = asked && events.findLast((event) => event.type === 'user.answered' && event.effectId === asked.effectId);
  return answered ? answered.value : askAnswers.get(question.interaction);
}
function askCard(question, card) {
  const skill = (state.session.runs || []).findLast((run) => ACTIVE_RUN.has(run.state))?.skill;
  const title = typeof question.title === 'string' && question.title ? question.title : skill ? `/${skill}` : 'Question';
  const prompt = typeof question.prompt === 'string' ? question.prompt : question.prompt?.system;
  card.append(el('h3', '', title));
  if (prompt) card.append(el('p', '', prompt));
  const details = questionDetails(question);
  const schema = question.schema && typeof question.schema === 'object' ? question.schema : {};
  const actions = el('div', 'question-actions');
  if (kindOf(schema) === 'boolean') {
    const yes = el('button', 'primary-button', 'Yes');
    const no = el('button', 'secondary-button', 'No');
    yes.addEventListener('click', () => answerQuestion(question, true, [yes, no]));
    no.addEventListener('click', () => answerQuestion(question, false, [yes, no]));
    actions.append(yes, no);
    if (details) card.append(details);
    card.append(actions);
    return null;
  }
  const form = el('form', 'ask-form');
  // Asked again, the form keeps the rejected answer and marks why (question.issues). Otherwise a skill offers
  // editable defaults by putting same-named fields in the prompt's data.
  const data = question.prompt?.data;
  const retry = previousAnswer(question);
  const initial = retry !== undefined ? retry : data && typeof data === 'object' && data.tag === 'Some' ? data.value : data?.tag === 'None' ? undefined : data;
  const answer = askForm(schema, { initial, issues: question.issues });
  const body = el('div', 'ask-body');
  if (details) body.append(details);
  body.append(answer.node);
  const submit = el('button', 'primary-button', 'Submit');
  submit.type = 'submit';
  actions.append(submit);
  form.append(body, actions);
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Only an answer that matches the schema is sent; what is wrong is marked in place.
    const result = answer.read();
    if (!result) return;
    if (typeof question.interaction === 'string') askAnswers.set(question.interaction, result.value);
    answerQuestion(question, result.value, [submit, ...form.querySelectorAll('input, textarea, select, button')]);
  });
  card.append(form);
  return answer;
}
function renderQuestion() {
  const question = state.session?.question;
  const signature = JSON.stringify([state.session?.id, question]);
  if (state.questionSignature === signature) return;
  state.questionSignature = signature;
  $('question-area').replaceChildren();
  if (!question) return;
  const ask = question.kind === 'ask';
  const card = el('section', `question-card${ask ? ' ask' : ''}`);
  card.setAttribute('aria-label', ask ? 'Question' : 'Review required');
  const field = ask ? askCard(question, card) : approvalCard(question, card);
  $('question-area').append(card);
  // Move focus to a new question only when the user isn't typing somewhere else.
  if (field && [document.body, $('message-input')].includes(document.activeElement)) field.focus();
}
const modelEfforts = (id) => state.config.models.find((item) => item.id === id)?.efforts || state.config.efforts;
const pickers = [popover($('model-button'), $('model-list')), popover($('effort-button'), $('effort-list')), popover($('more-button'), $('more-menu'))];
let pickerSignature = '';
// Model and effort popovers and the ⋯ menu. Once the first message is sent the model picker still opens,
// with every other model disabled; effort changes while idle.
function renderModelPicker() {
  const { config, session, busy } = state;
  const active = isActive(session);
  const model = session?.model || config?.defaultModel?.model;
  const effort = session?.effort || config?.defaultModel?.effort;
  const signature = JSON.stringify([!!config?.models, session?.id, model, effort, !!session?.modelLocked, busy, active, session?.timeBudgetsEnabled]);
  if (signature === pickerSignature) return;
  pickerSignature = signature;
  $('model-button').disabled = !config?.models || !session || busy;
  $('effort-button').disabled = !config?.models || !session || busy || active;
  $('more-button').disabled = !session;
  if (config?.models) {
    renderModels($('model-button'), $('model-list'), { providers: config.providers || [], models: config.models, model, locked: !!session?.modelLocked, onPick: (id) => saveModel(id, effort) });
    renderEfforts($('effort-button'), $('effort-list'), { efforts: modelEfforts(model), effort, onPick: (value) => saveModel(model, value) });
  }
  renderMenu($('more-menu'), [
    ['No time limits', { checked: session?.timeBudgetsEnabled === false, disabled: !session || active || busy, choose: () => setTimeBudgets(session.timeBudgetsEnabled === false) }],
    ['Export session', { icon: 'i-download', disabled: !session, choose: exportSession }],
  ]);
  for (const picker of pickers) if (picker.isOpen && picker.trigger.disabled) picker.close();
}
async function saveModel(model, effort) {
  const session = state.session;
  if (!session) return;
  // An effort the newly chosen model lacks becomes its highest one.
  const efforts = modelEfforts(model);
  const reply = replyGuard();
  try {
    reply(await api(`/sessions/${encodeURIComponent(session.id)}/model`, { method: 'POST', body: { model, effort: efforts.includes(effort) ? effort : efforts.at(-1) } }));
  } catch (error) { toast(error.message); pickerSignature = ''; renderModelPicker(); }
}
async function setTimeBudgets(enabled) {
  const reply = replyGuard();
  try {
    reply(await api(`/sessions/${encodeURIComponent(state.session.id)}/budget`, { method: 'POST', body: { enabled } }));
  } catch (error) { toast(error.message); }
}
function exportSession() {
  if (!state.session) return;
  const link = el('a');
  link.href = `/api/sessions/${encodeURIComponent(state.session.id)}/export`;
  link.download = `shout-${state.session.id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
}
function statusKind(session) {
  if (session?.question) return 'question';
  if (isActive(session)) return 'active';
  return ['completed', 'failed', 'interrupted'].includes(session?.status) ? session.status : '';
}
function renderStatus() {
  const session = state.session;
  const active = isActive(session);
  document.title = session?.title ? `${session.title} · SHOUT` : 'SHOUT';
  // The server already words the error ("Session could not be saved: …").
  const storage = typeof session?.storageError === 'string' ? session.storageError : session?.storageError ? JSON.stringify(session.storageError) : '';
  $('storage-warning').hidden = !storage;
  $('storage-warning').textContent = !storage || /could not be saved/i.test(storage) ? storage : `Session could not be saved: ${storage}`;
  $('status-line').className = `status-line ${statusKind(session)}`;
  // Session state is shown by the composer's colour; the status text stays for screen readers.
  $('composer').dataset.state = statusKind(session);
  $('status-text').textContent = session?.question ? (session.question.kind === 'ask' ? 'Awaiting your answer' : 'Awaiting approval') : session?.status || 'Ready';
  $('cancel-button').hidden = !active;
  $('send-button').hidden = active;
  $('send-button').disabled = active || state.busy;
  renderModelPicker();
}

/* Visualization */
function classify(event) {
  const type = event.type || '';
  if (type.startsWith('user.') || type.startsWith('message.user')) return { lane: 0, kind: 'user' };
  if (type.startsWith('model.') || type.startsWith('provider.') || type.startsWith('chat.')) return { lane: 2, kind: 'model' };
  if (type.startsWith('tool.')) return { lane: 4, kind: 'tool' };
  if (type.startsWith('vm.') || type.startsWith('effect.') || type === 'program.loaded') return { lane: 3, kind: 'vm' };
  return { lane: 1, kind: 'harness' };
}
function filteredEvents(tab) {
  return (state.session?.events || []).filter((event) => (!tab.runFilter || event.run === tab.runFilter) && (!tab.eventFilter || JSON.stringify(event).toLowerCase().includes(tab.eventFilter.toLowerCase())));
}
// One line per event: #seq, lane dot (the lane is its tooltip), type, time. Ids live in the detail JSON.
function renderTrace(container, events, tab) {
  if (!events.length) return container.append(el('p', 'empty-copy', 'No events'));
  for (const event of events) {
    const { lane, kind } = classify(event);
    const button = el('button', `trace-event ${kind}${tab.selectedEvent === event.id ? ' selected' : ''}`);
    const dot = el('span', `trace-dot ${kind}`);
    dot.title = LANES[lane][0];
    button.append(el('span', 'trace-index', `#${event.sequence}`), dot, el('span', 'trace-type', event.type), el('time', 'trace-time', time(event.time)));
    button.addEventListener('click', () => selectEvent(tab, event));
    container.append(button);
  }
}
function changeStats(change) {
  const lines = diffLines(change.before ?? '', change.after ?? '');
  return { lines, added: lines.filter((line) => line.type === 'add').length, removed: lines.filter((line) => line.type === 'del').length };
}
function diffStat({ added, removed }) {
  const stat = el('span', 'diff-stat');
  stat.append(el('span', 'add', `+${added}`), el('span', 'del', `−${removed}`));
  return stat;
}
function renderChanges(container, tab) {
  const changes = state.session?.changes || [];
  if (!changes.length) container.append(el('p', 'empty-copy', 'No changes'));
  for (const change of changes) {
    const stats = changeStats(change);
    const lang = languageFor(change.path);
    const before = highlightLines(change.before ?? '', lang);
    const after = highlightLines(change.after ?? '', lang);
    const file = el('section', 'diff-file');
    file.dataset.path = change.path;
    const title = el('div', 'diff-title');
    const name = el('span', 'diff-name', change.path);
    name.append(changeBadge(change));
    const open = iconButton('i-open', `Open ${change.path}`, () => openFile(change.path), 'icon-button small');
    const titleEnd = el('span', 'diff-title-end');
    titleEnd.append(diffStat(stats));
    if (change.after != null) titleEnd.append(open);
    title.append(name, titleEnd);
    const body = el('div', 'diff-body');
    for (const line of collapseContext(stats.lines)) {
      if (line.type === 'gap') { body.append(el('div', 'diff-line gap', `${line.count} unchanged`)); continue; }
      const row = el('div', `diff-line ${line.type}`);
      const tokens = line.type === 'del' ? before[line.a] : after[line.b];
      row.append(el('span', 'ln', line.a === undefined ? '' : String(line.a + 1)), el('span', 'ln', line.b === undefined ? '' : String(line.b + 1)), el('span', 'sign', line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''));
      const code = el('span', 'code');
      if (tokens?.length) renderTokens(code, tokens); else code.textContent = ' ';
      row.append(code);
      body.append(row);
    }
    file.append(title, body);
    container.append(file);
  }
  if (tab.focusPath) {
    container.querySelector(`.diff-file[data-path="${CSS.escape(tab.focusPath)}"]`)?.scrollIntoView({ block: 'start' });
    tab.focusPath = null;
  }
}
// Line-level LCS diff. Workspace files are small and bounded; very large inputs fall back to remove-all/add-all.
// Each line records its 0-based index in the old (a) and new (b) text.
function diffLines(before, after) {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length * b.length > 4_000_000) return [...a.map((text, i) => ({ type: 'del', text, a: i })), ...b.map((text, j) => ({ type: 'add', text, b: j }))];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const result = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { result.push({ type: 'same', text: a[i], a: i++, b: j++ }); }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) result.push({ type: 'del', text: a[i], a: i++ });
    else result.push({ type: 'add', text: b[j], b: j++ });
  }
  while (i < a.length) result.push({ type: 'del', text: a[i], a: i++ });
  while (j < b.length) result.push({ type: 'add', text: b[j], b: j++ });
  return result;
}
function collapseContext(lines, context = 3) {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const output = [];
  for (let index = 0; index < lines.length; index++) {
    if (keep[index]) { output.push(lines[index]); continue; }
    let end = index;
    while (end < lines.length && !keep[end]) end++;
    output.push({ type: 'gap', count: end - index });
    index = end - 1;
  }
  return output;
}
function selectEvent(tab, event) {
  tab.selectedEvent = event.id;
  renderViz(tab);
}
function renderEventDetail(tab, detail) {
  const event = tab.view !== 'changes' && state.session?.events?.find((candidate) => candidate.id === tab.selectedEvent);
  detail.hidden = !event;
  detail.replaceChildren();
  if (!event) return;
  const header = el('div', 'detail-header');
  header.append(el('strong', '', `#${event.sequence} · ${event.type}`));
  header.append(iconButton('i-x', 'Close event details', () => { tab.selectedEvent = null; renderViz(tab); }, 'icon-button small'));
  detail.append(header, codeBlock(JSON.stringify(event, null, 2), 'json'));
  if (event.type === 'program.loaded') {
    const run = state.session.runs?.find((candidate) => candidate.id === event.run);
    if (run?.source) {
      const open = el('button', 'secondary-button detail-action');
      open.setAttribute('aria-label', 'Open ALLEN program');
      open.append(icon('i-code'), 'Program');
      open.addEventListener('click', () => openProgram(run.id, { beside: true }));
      detail.append(open);
    }
  }
}
// The tab names the view, so Events has only its two filters and Changes none.
function vizPane(tab) {
  const pane = el('div', 'viz-pane');
  const toolbar = el('div', 'viz-toolbar');
  const runFilter = el('select', 'run-filter');
  runFilter.setAttribute('aria-label', 'Filter by run');
  runFilter.addEventListener('change', () => { tab.runFilter = runFilter.value; tab.selectedEvent = null; renderViz(tab); });
  const eventFilter = el('input', 'event-filter');
  eventFilter.type = 'search';
  eventFilter.placeholder = 'Filter';
  eventFilter.setAttribute('aria-label', 'Filter events');
  eventFilter.addEventListener('input', () => { tab.eventFilter = eventFilter.value; renderViz(tab); });
  toolbar.append(runFilter, eventFilter);
  const main = el('div', 'viz-main');
  const content = el('div', 'viz-content keep-scroll');
  const detail = el('div', 'event-detail');
  detail.hidden = true;
  main.append(content, detail);
  pane.append(toolbar, main);
  Object.assign(pane, { toolbar, runFilter, eventFilter, content, detail });
  return pane;
}
function renderViz(tab) {
  const pane = panes.get(tab.id);
  if (!pane) return;
  pane.toolbar.hidden = tab.view === 'changes';
  const runs = (state.session?.runs || []).map((run, i) => [run.id, `${i + 1} · ${runName(run)}`]);
  const signature = JSON.stringify(runs);
  if (pane.runFilter.dataset.signature !== signature) {
    pane.runFilter.dataset.signature = signature;
    pane.runFilter.replaceChildren(new Option('All runs', ''), ...runs.map(([id, label]) => new Option(label, id)));
  }
  pane.runFilter.value = tab.runFilter || '';
  if (pane.eventFilter.value !== (tab.eventFilter || '')) pane.eventFilter.value = tab.eventFilter || '';
  const container = pane.content;
  const oldScroll = container.scrollTop;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 85;
  const sameView = container.dataset.view === tab.view;
  container.dataset.view = tab.view;
  container.replaceChildren();
  if (tab.view === 'trace') renderTrace(container, filteredEvents(tab), tab);
  else renderChanges(container, tab);
  renderEventDetail(tab, pane.detail);
  if (!sameView) container.scrollTop = tab.view === 'changes' ? 0 : container.scrollHeight;
  else if (container.isConnected && !pane.closest('.pane-store')) container.scrollTop = nearBottom && !tab.selectedEvent && tab.view !== 'changes' ? container.scrollHeight : oldScroll;
}
function renderVizPanes() {
  for (const tab of Object.values(state.layout.tabs)) if (tab.kind === 'viz') renderViz(tab);
}

/* ALLEN program */
function runStateKind(runState) {
  return ['completed', 'failed', 'interrupted'].includes(runState) ? runState : ACTIVE_RUN.has(runState) ? 'active' : '';
}
function workflowName(source) {
  return state.config?.workflows?.find((workflow) => workflow.source === source)?.name || 'ALLEN program';
}
function runName(run) {
  return run.skill ? `/${run.skill}` : run.generated ? 'program' : workflowName(run.source);
}
// Resolves what a program tab shows: a pinned run, the latest run, or a workflow file before any run.
function programTarget(tab) {
  const runs = state.session?.runs || [];
  if (tab.run?.startsWith('workflow:')) {
    const workflow = state.config?.workflows?.find((candidate) => candidate.name === tab.run.slice(9));
    return { source: workflow?.source, name: workflow?.name || 'ALLEN program', run: null };
  }
  const run = (tab.run && runs.find((candidate) => candidate.id === tab.run)) || runs.at(-1);
  if (run) return { source: run.source, name: runName(run), run };
  const workflow = state.config?.workflows?.[0];
  return { source: workflow?.source, name: workflow?.name || 'ALLEN program', run: null };
}
// Maps source lines that perform an effect to the key used for the run's recorded events.
function effectKey(line) {
  if (!/\bawait\b/.test(line)) return null;
  const tool = /tools\.([\w.]+)\.call\b/.exec(line);
  if (tool) return `tool:${tool[1]}`;
  if (/\bmodel\.request\b/.test(line)) return 'model';
  if (/\buser\.ask\b/.test(line)) return 'user';
  return null;
}
function eventEffectKey(event) {
  if (event.type.startsWith('tool.')) return `tool:${event.tool}`;
  if (event.type.startsWith('model.')) return 'model';
  if (event.type.startsWith('user.')) return 'user';
  return null;
}
function programPane(tab) {
  const pane = el('div', 'program-pane');
  const header = el('div', 'pane-header program-header');
  const select = el('select', 'program-run');
  select.setAttribute('aria-label', 'Program source');
  select.addEventListener('change', () => { tab.run = select.value; saveLayout(); renderTabStrips(); renderProgram(tab); });
  const status = el('span', 'status-pill');
  const flow = iconButton('i-flow', 'Flow', () => showFlowChat(programTarget(tab).run?.id), 'icon-button small');
  header.append(select, status, flow);
  const scroller = el('div', 'code-scroll keep-scroll');
  pane.append(header, scroller);
  Object.assign(pane, { select, status, flow, scroller });
  return pane;
}
// Opens a run's program at a line (from a Flow step's detail) and marks it.
function showProgramLine(run, line) {
  openProgram(run, { beside: true });
  const tab = Object.values(state.layout.tabs).find((candidate) => candidate.kind === 'program' && candidate.run === run);
  if (tab) { tab.focusLine = line; renderProgram(tab); }
}
// What the run did at each line: effect counts at their exact sites when events carry control-flow
// data (programActivity), otherwise at lines that look like effects (effectKey), counted by name.
function programMarks(pane, events, activity, active) {
  const marks = new Map();
  if (activity.origin || activity.sites.length) {
    for (const site of activity.sites) marks.set(site.line, { kind: site.kind, count: 0 });
    for (const [line, info] of activity.lines) marks.set(line, { ...marks.get(line), ...info });
    if (!activity.sites.length) pane.raw.forEach((text, i) => { const effect = effectKey(text); if (effect && !marks.has(i + 1)) marks.set(i + 1, { kind: effect.split(':')[0], count: 0 }); });
    return marks;
  }
  const starts = ['tool.started', 'model.started', 'user.question'];
  const counts = new Map();
  for (const event of events) {
    const effect = starts.includes(event.type) && eventEffectKey(event);
    if (effect) counts.set(effect, [(counts.get(effect)?.[0] || 0) + 1, counts.get(effect)?.[1] || event.id]);
  }
  const last = active ? events.filter((event) => eventEffectKey(event)).at(-1) : null;
  const current = last && starts.includes(last.type) ? eventEffectKey(last) : null;
  pane.raw.forEach((text, i) => {
    const effect = effectKey(text);
    if (effect) marks.set(i + 1, { kind: effect.split(':')[0], count: counts.get(effect)?.[0] || 0, first: counts.get(effect)?.[1], state: effect === current ? (effect === 'user' ? 'waiting' : 'running') : '' });
  });
  return marks;
}
function renderProgram(tab) {
  const pane = panes.get(tab.id);
  if (!pane) return;
  const runs = state.session?.runs || [];
  const target = programTarget(tab);
  const options = [['', 'Latest'], ...runs.map((run, i) => [run.id, `${i + 1} · ${runName(run)}`]), ...(state.config?.workflows || []).map((workflow) => [`workflow:${workflow.name}`, workflow.name])];
  const signature = JSON.stringify(options);
  if (pane.select.dataset.signature !== signature) {
    pane.select.dataset.signature = signature;
    pane.select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  }
  pane.select.value = options.some(([value]) => value === tab.run) ? tab.run : '';
  const runState = target.run ? (target.run.state || 'unknown').replace(/_/g, ' ') : '';
  pane.status.hidden = !target.run;
  pane.status.className = `status-pill ${runStateKind(target.run?.state)}`;
  pane.status.title = runState;
  pane.status.setAttribute('aria-label', runState);
  pane.flow.hidden = !target.run;
  if (!target.source) {
    pane.dataset.source = '';
    pane.scroller.replaceChildren(el('p', 'empty-copy', 'No program'));
    return;
  }
  const key = `${target.run?.id || target.name}:${target.source.length}`;
  if (pane.dataset.source !== key) {
    pane.dataset.source = key;
    const lines = highlightLines(target.source, 'allen');
    if (lines.length > 1 && !lines.at(-1).length) lines.pop();
    pane.raw = target.source.split('\n');
    const view = el('div', 'code-view program-view');
    view.style.setProperty('--gutter', `${String(lines.length).length + 1}ch`);
    pane.rows = lines.map((tokens, i) => {
      const row = el('div', 'code-line');
      const code = renderTokens(el('span', 'lc'), tokens);
      // Wrapped continuation lines hang at the statement's indentation.
      code.style.setProperty('--indent', /^ */.exec(pane.raw[i] || '')[0].length + 2);
      row.append(el('span', 'ln', String(i + 1)), code);
      view.append(row);
      return row;
    });
    Object.assign(pane, { inlays: new Map(), loopInlays: new Map(), marks: new Map(), currentLine: null });
    pane.scroller.replaceChildren(view);
  }
  // Annotate the source with what this run did: effect counts, the running site, loop iteration totals.
  const events = target.run ? (state.session?.events || []).filter((event) => event.run === target.run.id) : [];
  const active = !!target.run && ACTIVE_RUN.has(target.run.state);
  const activity = programActivity(events, { live: active });
  pane.marks = target.run ? programMarks(pane, events, activity, active) : new Map();
  pane.calls = activity.calls;
  if (tab.focusLine) { pane.focusLine = tab.focusLine; tab.focusLine = null; pane.rows[pane.focusLine - 1]?.scrollIntoView({ block: 'center' }); }
  // The line a failed run failed at, with the error beside it. It is scrolled to once, unless a line has focus.
  const failure = target.run ? runFailure(target.run) : null;
  const failed = failure && pane.rows[failure.line - 1] ? failure : null;
  const shown = failed ? `${key}:${failed.line}` : '';
  if (failed && pane.failureShown !== shown && !pane.focusLine) pane.rows[failed.line - 1].scrollIntoView({ block: 'center' });
  pane.failureShown = shown;
  let currentLine = null;
  pane.rows.forEach((row, i) => {
    const line = i + 1;
    const mark = pane.marks.get(line);
    const loop = target.run && activity.loops.get(line);
    if (mark?.state) currentLine = line;
    row.classList.toggle('effect-line', !!mark);
    row.classList.toggle('model', mark?.kind === 'model');
    row.classList.toggle('user', mark?.kind === 'user');
    row.classList.toggle('current', !!mark?.state);
    row.classList.toggle('waiting', mark?.state === 'waiting');
    // Sites a finished run never reached are dimmed; there is nothing to count there.
    row.classList.toggle('unreached', !!mark && !mark.count && !active);
    row.classList.toggle('loop-line', !!loop);
    row.classList.toggle('focus', line === pane.focusLine);
    const failedHere = line === failed?.line;
    row.classList.toggle('error-line', failedHere);
    let errorInlay = row.querySelector(':scope > .error-inlay');
    if (failedHere && !errorInlay) errorInlay = row.appendChild(el('span', 'diag-inlay error-inlay'));
    if (errorInlay) {
      errorInlay.hidden = !failedHere;
      errorInlay.textContent = failedHere ? failed.message || 'failed here' : '';
      row.title = failedHere ? errorInlay.textContent : '';
    }
    // A helper's call line counts the effects beneath it, more quietly than an effect site.
    const call = target.run && !mark ? activity.calls.get(line) : null;
    const counted = mark && (mark.count || mark.state) ? mark : call;
    let inlay = pane.inlays.get(line);
    if (counted && !inlay) {
      inlay = el('button', 'inlay');
      inlay.addEventListener('click', () => {
        const { run } = programTarget(tab);
        const first = pane.marks.get(line)?.first || pane.calls?.get(line)?.first;
        openViz('trace', { beside: true, apply: (viz) => { viz.runFilter = run?.id || ''; viz.eventFilter = ''; viz.selectedEvent = first || null; } });
      });
      pane.inlays.set(line, inlay);
      row.append(inlay);
    }
    if (inlay) { inlay.hidden = !counted; inlay.classList.toggle('call', !!call); inlay.textContent = `${counted?.count || 0}×`; inlay.title = counted?.attempts > counted?.count ? `${counted.attempts} attempts` : ''; }
    let loopInlay = pane.loopInlays.get(line);
    if (loop && !loopInlay) {
      loopInlay = el('span', 'inlay loop');
      loopInlay.append(icon('i-loop'), el('span'));
      pane.loopInlays.set(line, loopInlay);
      row.append(loopInlay);
    }
    if (loopInlay) { loopInlay.hidden = !loop; loopInlay.lastChild.textContent = loop ? String(loop.total) : ''; loopInlay.classList.toggle('live', !!loop?.live); }
  });
  if (currentLine && currentLine !== pane.currentLine) pane.rows[currentLine - 1]?.scrollIntoView({ block: 'nearest' });
  pane.currentLine = currentLine;
}
function renderProgramPanes() {
  for (const tab of Object.values(state.layout.tabs)) if (tab.kind === 'program') renderProgram(tab);
}
function openProgram(run = '', { split, beside } = {}) {
  if (!state.session) return;
  let tab = !split && Object.values(state.layout.tabs).find((candidate) => candidate.kind === 'program');
  if (tab) { tab.run = run; activate(state.layout, tab.id); }
  else {
    tab = { id: uid('program'), kind: 'program', run };
    place(tab, { split, beside });
  }
  commitLayout();
  renderProgram(tab);
  if (window.matchMedia('(max-width:1040px)').matches && !$('side-panel').hidden) showSide(state.side);
}

/* Files */
function filePane(tab) {
  const pane = el('div', 'file-pane');
  const header = el('div', 'pane-header');
  const crumbs = el('div', 'crumbs');
  const parts = tab.path.split('/');
  parts.forEach((part, i) => {
    if (i) crumbs.append(el('span', 'crumb-sep', '/'));
    crumbs.append(el('span', i === parts.length - 1 ? 'crumb-file' : 'crumb', part));
  });
  const meta = el('span', 'pane-meta', languageLabel(tab.path));
  header.append(crumbs, meta, iconButton('i-refresh', 'Reload file', () => loadFileInto(tab), 'icon-button small'));
  const scroller = el('div', 'code-scroll keep-scroll');
  scroller.append(el('p', 'empty-copy', 'Loading…'));
  pane.append(header, scroller);
  Object.assign(pane, { meta, scroller });
  return pane;
}
async function loadFileInto(tab) {
  const pane = panes.get(tab.id);
  const sessionId = state.session?.id;
  if (!pane || !sessionId) return;
  try {
    const file = await api(`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(tab.path)}`);
    if (state.session?.id !== sessionId || panes.get(tab.id) !== pane) return;
    const lines = highlightLines(file.content, languageFor(tab.path));
    if (lines.length > 1 && !lines.at(-1).length && file.content.endsWith('\n')) lines.pop();
    const view = el('div', 'code-view');
    view.style.setProperty('--gutter', `${String(lines.length).length + 1}ch`);
    lines.forEach((tokens, i) => {
      const row = el('div', 'code-line');
      row.append(el('span', 'ln', String(i + 1)), renderTokens(el('span', 'lc'), tokens));
      view.append(row);
    });
    pane.meta.textContent = languageLabel(tab.path);
    const { scrollTop, scrollLeft } = pane.scroller;
    pane.scroller.replaceChildren(view);
    pane.scroller.scrollTop = scrollTop;
    pane.scroller.scrollLeft = scrollLeft;
  } catch (error) {
    if (panes.get(tab.id) === pane) pane.scroller.replaceChildren(el('p', 'empty-copy', error.message));
  }
}
function reloadFilePanes() {
  for (const tab of Object.values(state.layout.tabs)) if (tab.kind === 'file' && panes.has(tab.id)) loadFileInto(tab);
}
async function loadFiles() {
  const sessionId = state.session?.id;
  if (!sessionId) return;
  try {
    const { files } = await api(`/sessions/${encodeURIComponent(sessionId)}/files`);
    if (state.session?.id !== sessionId) return;
    if (!state.files) {
      // Expand everything for small workspaces; otherwise start with top-level folders collapsed.
      const dirs = new Set(files.flatMap((path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
      state.expanded = files.length <= 40 ? dirs : new Set();
    }
    state.files = files;
    state.filesError = '';
  } catch (error) {
    if (state.session?.id !== sessionId) return;
    state.filesError = error.message;
  }
  if (state.side === 'files') renderSide();
}
function fileTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    parts.slice(0, -1).forEach((part, i) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    });
    node.files.push(path);
  }
  return root;
}
function renderTreeNode(container, node, depth, openPaths) {
  for (const [name, dir] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const open = state.expanded.has(dir.path);
    const row = el('button', `tree-row tree-dir${open ? ' open' : ''}`);
    row.style.setProperty('--depth', depth);
    row.setAttribute('aria-expanded', String(open));
    row.append(icon('i-chevron'), el('span', 'tree-name', name));
    row.addEventListener('click', () => {
      if (open) state.expanded.delete(dir.path); else state.expanded.add(dir.path);
      renderSide();
    });
    container.append(row);
    if (open) renderTreeNode(container, dir, depth + 1, openPaths);
  }
  for (const path of [...node.files].sort((a, b) => basename(a).localeCompare(basename(b)))) {
    const item = el('div', `tree-file${openPaths.active === path ? ' active' : openPaths.all.has(path) ? ' open' : ''}`);
    item.style.setProperty('--depth', depth);
    const row = el('button', 'tree-row');
    row.draggable = true;
    row.append(icon('i-file'), el('span', 'tree-name', basename(path)));
    row.setAttribute('aria-label', path);
    row.addEventListener('click', () => openFile(path));
    row.addEventListener('dragstart', (event) => startDrag(event, { file: path }));
    row.addEventListener('dragend', endDrag);
    item.append(row, iconButton('i-split-right', `Open ${basename(path)} to the side`, () => openFile(path, { split: 'right' }), 'icon-button small tree-side'));
    container.append(item);
  }
}
function renderFilesPanel(container) {
  if (!state.session) return;
  if (state.filesError) return container.append(el('p', 'empty-copy', state.filesError));
  if (!state.files) return container.append(el('p', 'empty-copy', 'Loading…'));
  if (!state.files.length) return container.append(el('p', 'empty-copy', 'No files'));
  const tabs = Object.values(state.layout.tabs).filter((tab) => tab.kind === 'file');
  const focusedTab = state.layout.tabs[focusedGroup(state.layout).active];
  const tree = el('div', 'file-tree');
  tree.setAttribute('role', 'tree');
  renderTreeNode(tree, fileTree(state.files), 0, { all: new Set(tabs.map((tab) => tab.path)), active: focusedTab?.kind === 'file' ? focusedTab.path : null });
  container.append(tree);
}

/* Skills */
// The list is cheap to fetch and skills can change on disk at any time, so callers refresh freely within a short cache.
function loadSkills({ force = false } = {}) {
  const sessionId = state.session?.id;
  if (!sessionId) return Promise.resolve(null);
  if (state.skills.sessionId !== sessionId) state.skills = { sessionId, list: null, error: '', at: 0, pending: null };
  const skills = state.skills;
  if (skills.pending) return skills.pending;
  if (!force && Date.now() - skills.at < 2000) return Promise.resolve(skills.list);
  skills.pending = api(`/sessions/${encodeURIComponent(sessionId)}/skills`).then((data) => {
    skills.list = Array.isArray(data?.skills) ? data.skills : [];
    skills.error = '';
  }, (error) => { skills.error = error.message; }).then(() => {
    skills.pending = null;
    skills.at = Date.now();
    if (state.skills !== skills) return null;
    updateSlash();
    return skills.list;
  });
  return skills.pending;
}
function skillBadges(skill) {
  const badges = [];
  if (skill.ok === false) {
    const count = Array.isArray(skill.diagnostics) ? skill.diagnostics.length : 0;
    badges.push(el('span', 'skill-error', count > 1 ? `${count} errors` : 'has errors'));
  }
  return badges;
}
// Puts `/name ` at the start of the composer, keeping any draft text as the skill's arguments.
function useSkill(name) {
  if (!state.session) return;
  const input = $('message-input');
  const rest = input.value.replace(/^\/\S*[ \t]*/, '');
  input.value = `/${name} ${rest}`;
  activate(state.layout, CHAT);
  commitLayout();
  if (window.matchMedia('(max-width:1040px)').matches && !$('side-panel').hidden) showSide(state.side);
  resizeComposer();
  input.focus();
  input.setSelectionRange(name.length + 2, name.length + 2);
}
function skillPane(tab) {
  const pane = el('div', 'skill-pane');
  const header = el('div', 'pane-header');
  const crumbs = el('div', 'crumbs');
  const crumb = el('span', 'crumb-file', `/${tab.name}`);
  crumbs.append(crumb);
  // "Use" puts /name in the composer; it does not run anything by itself.
  const run = el('button', 'pane-button', 'Use');
  run.type = 'button';
  run.addEventListener('click', () => useSkill(tab.name));
  header.append(crumbs, run, iconButton('i-refresh', 'Reload skill', () => loadSkillInto(tab), 'icon-button small'));
  const scroller = el('div', 'code-scroll keep-scroll');
  scroller.append(el('p', 'empty-copy', 'Loading…'));
  pane.append(header, scroller);
  Object.assign(pane, { crumb, run, scroller });
  return pane;
}
function chipList(values, kindOf) {
  if (!Array.isArray(values) || !values.length) return el('span', 'skill-none', 'None');
  const list = el('span', 'chips');
  for (const value of values) list.append(el('span', `chip ${kindOf(String(value))}`, String(value)));
  return list;
}
async function loadSkillInto(tab) {
  const pane = panes.get(tab.id);
  const sessionId = state.session?.id;
  if (!pane || !sessionId) return;
  try {
    const skill = await api(`/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(tab.name)}`);
    if (state.session?.id !== sessionId || panes.get(tab.id) !== pane) return;
    const source = typeof skill.source === 'string' ? skill.source : '';
    const diagnostics = Array.isArray(skill.diagnostics) ? skill.diagnostics : [];
    const summary = el('div', 'skill-summary');
    if (skill.description) summary.append(el('p', 'skill-description', skill.description));
    const facts = el('dl', 'skill-facts');
    const fact = (name, value) => { facts.append(el('dt', '', name)); const dd = el('dd'); dd.append(value); facts.append(dd); };
    if (skill.args) fact('Arguments', el('code', 'skill-path', `/${skill.name} ${skill.args}`));
    // Scope and path on demand, on the name.
    pane.crumb.title = [SCOPE_LABEL[skill.scope] || skill.scope, skill.path].filter(Boolean).join(' · ');
    fact('Capabilities', chipList(skill.capabilities, (value) => (value.startsWith('model') ? 'model' : value.startsWith('user') ? 'user' : 'vm')));
    fact('Tools', chipList(skill.tools, () => 'tool'));
    // The run's budgets: the defaults unless the header's `// limits:` line sets them.
    const limits = skill.limits;
    if (limits && typeof limits === 'object') {
      fact('Limits', el('span', 'skill-limits', [`${limits.judgments} judgments`, `${limits.tools} tool calls`, `${limits.questions} questions`, `${limits.minutes} min`].join(' · ')));
    }
    summary.append(facts);
    const lines = highlightLines(source, 'allen');
    if (lines.length > 1 && !lines.at(-1).length) lines.pop();
    const raw = source.split('\n');
    const view = el('div', 'code-view program-view skill-view');
    view.style.setProperty('--gutter', `${String(lines.length).length + 1}ch`);
    const rows = lines.map((tokens, i) => {
      const row = el('div', 'code-line');
      const code = renderTokens(el('span', 'lc'), tokens);
      code.style.setProperty('--indent', /^ */.exec(raw[i] || '')[0].length + 2);
      row.append(el('span', 'ln', String(i + 1)), code);
      view.append(row);
      return row;
    });
    if (skill.ok === false || diagnostics.length) {
      const box = el('div', 'skill-diagnostics');
      box.append(el('h4', '', diagnostics.length ? `${diagnostics.length} compile error${diagnostics.length === 1 ? '' : 's'}` : 'This skill does not compile'));
      const list = el('ol');
      for (const diagnostic of diagnostics) {
        const line = Number(diagnostic.line);
        const row = Number.isInteger(line) && line >= 1 ? rows[line - 1] : null;
        const item = el('li');
        const button = el('button', 'diag-item');
        button.type = 'button';
        const location = row ? `${line}${diagnostic.column ? `:${diagnostic.column}` : ''}` : '—';
        button.append(el('span', 'diag-loc', location));
        if (diagnostic.code) button.append(el('span', 'diag-code', String(diagnostic.code)));
        button.append(el('span', 'diag-message', String(diagnostic.message ?? '')));
        button.disabled = !row;
        button.addEventListener('click', () => row?.scrollIntoView({ block: 'center' }));
        item.append(button);
        list.append(item);
        if (row) {
          row.classList.add('diag');
          const note = row.querySelector('.diag-inlay') || row.appendChild(el('span', 'diag-inlay'));
          note.textContent = note.textContent ? `${note.textContent} · ${diagnostic.message}` : String(diagnostic.message ?? diagnostic.code ?? 'error');
          row.title = note.textContent;
        }
      }
      if (diagnostics.length) box.append(list);
      summary.append(box);
    }
    const { scrollTop } = pane.scroller;
    pane.scroller.replaceChildren(summary, source ? view : el('p', 'empty-copy', 'No source'));
    pane.scroller.scrollTop = scrollTop;
  } catch (error) {
    if (panes.get(tab.id) === pane) pane.scroller.replaceChildren(el('p', 'empty-copy', error.message));
  }
}
function reloadSkillPanes() {
  for (const tab of Object.values(state.layout.tabs)) if (tab.kind === 'skill' && panes.has(tab.id)) loadSkillInto(tab);
}
function openSkill(name, options = {}) {
  if (!state.session) return;
  const existing = Object.values(state.layout.tabs).find((tab) => tab.kind === 'skill' && tab.name === name);
  if (existing && !options.split) activate(state.layout, existing.id);
  else place({ id: uid('skill'), kind: 'skill', name }, { beside: !options.split, ...options });
  commitLayout();
  if (window.matchMedia('(max-width:1040px)').matches) showSide(state.side);
}

/* Inspector summary */
function summarySection(title) {
  const section = el('section', 'summary-section');
  section.append(el('h3', 'summary-heading', title));
  return section;
}
function viewLauncher(view, meta) {
  const info = view === 'program' ? PROGRAM : VIEWS[view];
  const openIt = (options) => (view === 'program' ? openProgram('', options) : openViz(view, options));
  const row = el('div', 'view-launcher');
  const open = el('button', 'view-open');
  open.draggable = true;
  open.append(icon(info.icon), el('span', 'view-name', info.label), el('span', 'view-meta', meta));
  open.setAttribute('aria-label', `Open ${info.label} in a tab`);
  open.addEventListener('click', () => openIt());
  open.addEventListener('dragstart', (event) => startDrag(event, { view }));
  open.addEventListener('dragend', endDrag);
  row.append(open, iconButton('i-split-right', `Open ${info.label} to the side`, () => openIt({ split: 'right' }), 'icon-button small'), iconButton('i-split-down', `Open ${info.label} below`, () => openIt({ split: 'bottom' }), 'icon-button small'));
  return row;
}
const changeBadge = (change) => (change.before == null ? el('span', 'badge new', 'new') : change.after == null ? el('span', 'badge deleted', 'deleted') : '');
// View launchers, the latest runs and the proposed changes; everything else lives in the views.
function renderSummary(container) {
  const session = state.session;
  if (!session) return;
  const events = session.events || [];
  const changes = session.changes || [];
  const runs = session.runs || [];
  const views = el('div', 'view-launchers');
  const latest = runs.at(-1);
  views.append(viewLauncher('program', latest ? runName(latest) : state.config?.workflows?.[0]?.name || ''), viewLauncher('trace', String(events.length)), viewLauncher('changes', changes.length ? String(changes.length) : ''));
  container.append(views);
  if (runs.length) {
    const section = summarySection('Runs');
    runs.slice(-5).reverse().forEach((run) => {
      const index = runs.indexOf(run);
      const row = el('button', 'summary-row');
      row.append(runDot(run), el('span', 'summary-name', runName(run)));
      if (['failed', 'interrupted', 'cancelled'].includes(run.state)) row.append(el('span', 'summary-row-meta', stateText(run.state)));
      row.addEventListener('click', () => showFlowChat(run.id));
      const item = el('div', 'summary-run');
      item.append(row, iconButton('i-code', `Open Run ${index + 1} program`, () => openProgram(run.id), 'icon-button small'));
      section.append(item);
    });
    container.append(section);
  }
  if (changes.length) {
    const section = summarySection('Changes');
    for (const change of changes) {
      const row = el('button', 'summary-row');
      row.append(el('span', 'summary-path', change.path), changeBadge(change), diffStat(changeStats(change)));
      row.title = change.path;
      row.addEventListener('click', () => openViz('changes', { beside: true, apply: (tab) => { tab.focusPath = change.path; } }));
      section.append(row);
    }
    container.append(section);
  }
}
// Side panel views by name; other views (e.g. Flow step detail) can register here.
const sideViews = { files: renderFilesPanel, summary: renderSummary };
function renderSide() {
  const open = !$('side-panel').hidden;
  // Without a session there is nothing to show: the panel and its toggle hide.
  $('side-panel').classList.toggle('no-session', !state.session);
  $('viz-button').hidden = !state.session;
  $('viz-button').setAttribute('aria-pressed', String(open && state.side === 'summary'));
  for (const tab of $('side-tabs').querySelectorAll('[data-side]')) tab.setAttribute('aria-selected', String(state.side === tab.dataset.side));
  $('side-refresh').hidden = state.side !== 'files';
  if (!open) return;
  const container = $('side-content');
  const scroll = container.scrollTop;
  container.replaceChildren(...container.querySelectorAll(':scope > .flow-detail'));
  (sideViews[state.side] || renderSummary)(container);
  container.scrollTop = scroll;
}
function showSide(side) {
  const open = !$('side-panel').hidden;
  if (open && state.side === side) { $('side-panel').hidden = true; localStorage.setItem('shout.side', 'closed'); renderSide(); return; }
  state.side = side;
  $('side-panel').hidden = false;
  localStorage.setItem('shout.side', side);
  if (side === 'files' && !state.files) loadFiles();
  renderSide();
}

/* Dock: tab groups in resizable splits */
function saveLayout() {
  if (state.session) try { localStorage.setItem(`shout.layout.${state.session.id}`, serialize(state.layout)); } catch {}
}
function commitLayout() {
  normalize(state.layout);
  saveLayout();
  renderDock();
  if (state.side !== 'summary') renderSide();
}
function tabInfo(tab) {
  // Only a file tab has a title: its full path.
  if (tab.kind === 'chat') return { label: 'Chat', icon: 'i-chat' };
  if (tab.kind === 'file') return { label: basename(tab.path), icon: 'i-file', title: tab.path };
  if (tab.kind === 'skill') return { label: `/${tab.name}`, icon: 'i-skill' };
  // A sub-agent's tab is named for the agent; its brief is a hover away.
  if (tab.kind === 'agent') { const agent = agentOfTab(tab); return { label: agent?.name || 'Agent', icon: 'i-agents', title: agent?.brief }; }
  if (tab.kind === 'program') {
    const index = (state.session?.runs || []).findIndex((run) => run.id === tab.run);
    return { label: index >= 0 ? `Program · Run ${index + 1}` : tab.run?.startsWith('workflow:') ? tab.run.slice(9) : PROGRAM.label, icon: PROGRAM.icon };
  }
  return { label: VIEWS[tab.view].label, icon: VIEWS[tab.view].icon };
}
function paneFor(tab) {
  if (tab.kind === 'chat') return $('chat-pane');
  if (!panes.has(tab.id)) {
    const pane = tab.kind === 'file' ? filePane(tab) : tab.kind === 'program' ? programPane(tab) : tab.kind === 'skill' ? skillPane(tab) : tab.kind === 'agent' ? agentPane(tab) : vizPane(tab);
    panes.set(tab.id, pane);
    if (tab.kind === 'file') loadFileInto(tab); else if (tab.kind === 'program') renderProgram(tab); else if (tab.kind === 'skill') loadSkillInto(tab); else if (tab.kind !== 'agent') renderViz(tab);
  }
  return panes.get(tab.id);
}
function renderDock() {
  for (const node of document.querySelectorAll('#dock .keep-scroll, #dock #messages')) scrollMemory.set(node, [node.scrollTop, node.scrollLeft]);
  $('pane-store').append($('chat-pane'), ...panes.values());
  for (const [id, pane] of panes) if (!state.layout.tabs[id]) { pane.stop?.(); pane.remove(); panes.delete(id); }
  $('dock').replaceChildren(renderNode(state.layout.root));
  for (const node of document.querySelectorAll('#dock .keep-scroll, #dock #messages')) {
    const saved = scrollMemory.get(node);
    if (saved) [node.scrollTop, node.scrollLeft] = saved;
  }
}
function renderNode(node) {
  if (node.type === 'group') return renderGroup(node);
  const box = el('div', `split ${node.dir}`);
  node.children.forEach((child, i) => {
    if (i) box.append(resizer(node, i));
    const cell = renderNode(child);
    cell.style.flex = `${node.sizes[i]} 1 0`;
    box.append(cell);
  });
  return box;
}
function canSplit(group) {
  const tab = state.layout.tabs[group.active];
  return group.tabs.length > 1 || (tab && tab.kind !== 'chat');
}
function splitActive(group, side) {
  const tab = state.layout.tabs[group.active];
  if (!tab) return;
  if (group.tabs.length > 1) splitWith(state.layout, tab.id, group.id, side);
  else if (tab.kind !== 'chat') {
    // A lone tab is duplicated so both panes show it; viz filters carry over.
    const copy = { ...tab, id: uid(tab.kind) };
    state.layout.tabs[copy.id] = copy;
    splitWith(state.layout, copy.id, group.id, side);
  }
  commitLayout();
}
function renderTab(group, tab, index) {
  const info = tabInfo(tab);
  const active = group.active === tab.id;
  const item = el('div', `tab${active ? ' active' : ''}`);
  item.dataset.tab = tab.id;
  item.draggable = true;
  const label = el('button', 'tab-label');
  label.setAttribute('role', 'tab');
  label.setAttribute('aria-selected', String(active));
  if (info.title) label.title = info.title;
  label.append(icon(info.icon), el('span', 'tab-text', info.label));
  if (tab.kind === 'chat') label.append(el('span', `tab-dot ${statusKind(state.session)}`));
  if (tab.kind === 'agent') label.append(el('span', `tab-dot ${({ running: 'active', failed: 'failed' })[agentOfTab(tab)?.status] || ''}`));
  if (tab.kind === 'viz' && tab.view === 'changes' && state.session?.changes?.length) label.append(el('span', 'count', String(state.session.changes.length)));
  label.addEventListener('click', () => { activate(state.layout, tab.id); commitLayout(); });
  item.append(label);
  if (tab.kind !== 'chat') {
    item.append(iconButton('i-x', `Close ${info.label}`, () => { closeTab(state.layout, tab.id); commitLayout(); }, 'tab-close'));
    item.addEventListener('auxclick', (event) => { if (event.button === 1) { event.preventDefault(); closeTab(state.layout, tab.id); commitLayout(); } });
  }
  item.addEventListener('dragstart', (event) => startDrag(event, { tab: tab.id }));
  item.addEventListener('dragend', endDrag);
  item.addEventListener('dragover', (event) => {
    if (!dragPayload) return;
    event.preventDefault();
    event.stopPropagation();
    const box = item.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    item.classList.toggle('drop-before', !after);
    item.classList.toggle('drop-after', after);
  });
  item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
  item.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const after = item.classList.contains('drop-after');
    item.classList.remove('drop-before', 'drop-after');
    const id = tabForPayload(dragPayload);
    if (id) { moveTab(state.layout, id, group.id, index + (after ? 1 : 0)); commitLayout(); }
  });
  return item;
}
function renderTabStrips() {
  // Refreshes tab labels and badges in place, without reparenting panes (keeps composer focus).
  for (const strip of document.querySelectorAll('#dock .tab-list')) {
    const group = findGroup(state.layout, strip.dataset.group);
    if (group) strip.replaceChildren(...group.tabs.map((id, i) => renderTab(group, state.layout.tabs[id], i)));
  }
}
function renderGroup(group) {
  const box = el('div', `group${group.id === state.layout.focus ? ' focused' : ''}`);
  box.dataset.group = group.id;
  box.addEventListener('pointerdown', () => focusGroup(group.id), true);
  box.addEventListener('focusin', () => focusGroup(group.id));
  const strip = el('div', 'tab-strip');
  const list = el('div', 'tab-list');
  list.dataset.group = group.id;
  list.setAttribute('role', 'tablist');
  group.tabs.forEach((id, i) => list.append(renderTab(group, state.layout.tabs[id], i)));
  const actions = el('div', 'group-actions');
  const splittable = canSplit(group);
  for (const [side, name, label] of [['right', 'i-split-right', 'Split right'], ['bottom', 'i-split-down', 'Split down']]) {
    const button = iconButton(name, label, () => splitActive(group, side), 'icon-button small');
    button.disabled = !splittable;
    actions.append(button);
  }
  strip.append(list, actions);
  strip.addEventListener('dragover', (event) => { if (dragPayload) event.preventDefault(); });
  strip.addEventListener('drop', (event) => {
    event.preventDefault();
    const id = tabForPayload(dragPayload);
    if (id) { moveTab(state.layout, id, group.id); commitLayout(); }
  });
  const body = el('div', 'group-body');
  const tab = state.layout.tabs[group.active];
  if (tab) body.append(paneFor(tab));
  const overlay = el('div', 'drop-overlay');
  body.append(overlay);
  const zoneOf = (event) => {
    const box = body.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const edges = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]].sort((a, b) => a[1] - b[1]);
    return edges[0][1] < 0.25 ? edges[0][0] : 'center';
  };
  body.addEventListener('dragover', (event) => {
    if (!dragPayload) return;
    event.preventDefault();
    overlay.dataset.zone = zoneOf(event);
  });
  body.addEventListener('dragleave', (event) => { if (!body.contains(event.relatedTarget)) delete overlay.dataset.zone; });
  body.addEventListener('drop', (event) => {
    event.preventDefault();
    const zone = zoneOf(event);
    delete overlay.dataset.zone;
    const id = tabForPayload(dragPayload);
    if (!id) return;
    if (zone === 'center') moveTab(state.layout, id, group.id);
    else splitWith(state.layout, id, group.id, zone);
    commitLayout();
  });
  box.append(strip, body);
  return box;
}
function resizer(split, index) {
  const handle = el('div', `resizer ${split.dir}`);
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', split.dir === 'row' ? 'vertical' : 'horizontal');
  handle.setAttribute('aria-label', 'Resize panes');
  handle.tabIndex = 0;
  const apply = () => {
    handle.previousElementSibling.style.flexGrow = String(split.sizes[index - 1]);
    handle.nextElementSibling.style.flexGrow = String(split.sizes[index]);
  };
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    const horizontal = split.dir === 'row';
    const a = handle.previousElementSibling.getBoundingClientRect();
    const b = handle.nextElementSibling.getBoundingClientRect();
    const start = horizontal ? a.left : a.top;
    const total = horizontal ? b.right - a.left : b.bottom - a.top;
    const move = (moveEvent) => { resize(split, index, ((horizontal ? moveEvent.clientX : moveEvent.clientY) - start) / total); apply(); };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      saveLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[event.key];
    if (!step) return;
    event.preventDefault();
    const pair = split.sizes[index - 1] + split.sizes[index];
    resize(split, index, split.sizes[index - 1] / pair + step);
    apply();
    saveLayout();
  });
  return handle;
}
function focusGroup(id) {
  if (state.layout.focus === id) return;
  state.layout.focus = id;
  for (const node of document.querySelectorAll('#dock .group')) node.classList.toggle('focused', node.dataset.group === id);
  saveLayout();
  if (state.side !== 'summary') renderSide();
}
function startDrag(event, payload) {
  dragPayload = payload;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', payload.file || payload.view || payload.tab);
  document.body.classList.add('dragging-tab');
}
function endDrag() {
  dragPayload = null;
  document.body.classList.remove('dragging-tab');
  for (const node of document.querySelectorAll('.drop-overlay[data-zone]')) delete node.dataset.zone;
}
// Resolves a drag payload to a registered tab ID. New tabs are registered but not yet placed.
function tabForPayload(payload) {
  if (!payload) return null;
  if (payload.tab) return state.layout.tabs[payload.tab] ? payload.tab : null;
  if (!state.session) return null;
  if (payload.file) {
    const existing = Object.values(state.layout.tabs).find((tab) => tab.kind === 'file' && tab.path === payload.file);
    if (existing) return existing.id;
    const tab = { id: uid('file'), kind: 'file', path: payload.file };
    state.layout.tabs[tab.id] = tab;
    return tab.id;
  }
  if (payload.view === 'program') {
    const tab = { id: uid('program'), kind: 'program', run: '' };
    state.layout.tabs[tab.id] = tab;
    return tab.id;
  }
  if (payload.view) {
    const tab = { id: uid('viz'), kind: 'viz', view: payload.view };
    state.layout.tabs[tab.id] = tab;
    return tab.id;
  }
  return null;
}
function place(tab, { split, beside } = {}) {
  const layout = state.layout;
  layout.tabs[tab.id] = tab;
  if (split) return splitWith(layout, tab.id, focusedGroup(layout).id, split);
  if (beside) {
    // Prefer an existing pane that isn't showing the chat; otherwise open one to the right of it.
    const other = groups(layout.root).find((candidate) => !candidate.tabs.includes(CHAT));
    if (other) return addTab(layout, tab, other.id);
    return splitWith(layout, tab.id, groupOfTab(layout, CHAT).id, 'right');
  }
  return addTab(layout, tab);
}
function openFile(path, options = {}) {
  if (!state.session) return;
  const existing = Object.values(state.layout.tabs).find((tab) => tab.kind === 'file' && tab.path === path);
  if (existing && !options.split) activate(state.layout, existing.id);
  else place(existing && options.split ? { ...existing, id: uid('file') } : { id: uid('file'), kind: 'file', path }, options);
  commitLayout();
  if (window.matchMedia('(max-width:1040px)').matches) showSide(state.side);
}
function openViz(view, { split, beside, apply } = {}) {
  let tab = !split && Object.values(state.layout.tabs).find((candidate) => candidate.kind === 'viz' && candidate.view === view);
  if (tab) activate(state.layout, tab.id);
  else {
    tab = { id: uid('viz'), kind: 'viz', view };
    place(tab, { split, beside });
  }
  apply?.(tab);
  commitLayout();
  renderViz(tab);
  if (window.matchMedia('(max-width:1040px)').matches && !$('side-panel').hidden) showSide(state.side);
}

// Snapshots of the open thread (its stream, mutation replies, the sidebar). One for any other thread, or arriving
// with no thread open, is dropped: only selectSession opens a thread.
function applySnapshot(session) {
  if (!session?.id || session.id !== state.session?.id) return;
  // A POST response can arrive after a newer SSE snapshot; never step back to an older revision.
  const revision = (snapshot) => snapshot.revision ?? snapshot.sequence ?? 0;
  if (revision(session) < revision(state.session)) return;
  showSnapshot(session);
}
// A mutation's reply is shown only if its thread is still open and nothing navigated in between; true when shown.
function replyGuard() {
  const id = state.session?.id, nav = state.selection;
  return (snapshot) => {
    if (!snapshot?.id || snapshot.id !== id || state.selection !== nav) return false;
    applySnapshot(snapshot);
    return true;
  };
}
function showSnapshot(session) {
  const wasActive = isActive(state.session);
  state.session = session;
  upsert(summarize(session));
  renderSidebar();
  renderMessages();
  renderQuestion();
  renderStatus();
  renderTabStrips();
  renderVizPanes();
  renderProgramPanes();
  renderAgentPanes();
  if (state.side === 'summary') renderSide();
  // Approved patches change files on disk; refresh open file views once a run settles.
  if (wasActive && !isActive(session)) { reloadFilePanes(); loadFiles(); loadSkills({ force: true }); reloadSkillPanes(); }
}
// Composer drafts per thread; '' is the welcome screen's.
const draftKey = () => state.session?.id ?? '';
function setComposer(value) {
  $('message-input').value = value;
  resizeComposer();
}
// Puts text back without losing anything typed since: into the composer while its thread is on screen, else into its draft.
function restoreDraft(key, text) {
  const shown = key === draftKey();
  const current = shown ? $('message-input').value : state.drafts.get(key) ?? '';
  const value = current.trim() ? `${text}\n\n${current}` : text;
  if (shown) setComposer(value); else state.drafts.set(key, value);
}
async function selectSession(id) {
  const selection = ++state.selection;
  state.opening = id;
  let session;
  try { session = await api(`/sessions/${encodeURIComponent(id)}`); }
  finally { if (selection === state.selection) state.opening = null; }
  if (selection !== state.selection) return;
  // The composer's text is filed at the switch itself, so edits made while this thread loaded are kept. Text typed on
  // the welcome screen comes along into a thread whose composer would otherwise be empty.
  const leaving = draftKey(), typed = $('message-input').value;
  const draft = state.drafts.has(id) ? state.drafts.get(id) : session.messages.length ? '' : session.suggestedPrompt || '';
  const carry = leaving === '' && Boolean(typed.trim()) && !draft.trim();
  state.drafts.set(leaving, carry ? '' : typed);
  state.stream?.close();
  state.session = null;
  state.messageSignature = '';
  state.questionSignature = '';
  state.files = null;
  state.filesError = '';
  state.skills = { sessionId: id, list: null, error: '', at: 0, pending: null };
  closeSlash();
  for (const pane of panes.values()) pane.remove();
  panes.clear();
  state.layout = restore(localStorage.getItem(`shout.layout.${id}`));
  showSnapshot(session);
  renderDock();
  renderSide();
  if (state.side === 'files' && !$('side-panel').hidden) loadFiles();
  loadSkills();
  setComposer(carry ? typed : draft);
  localStorage.setItem('shout.session', id);
  history.replaceState(null, '', `/#${encodeURIComponent(id)}`);
  $('app').classList.remove('menu-open');
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
  state.stream = stream;
  stream.addEventListener('snapshot', (event) => {
    try {
      if (state.session?.id === id) applySnapshot(JSON.parse(event.data));
    } catch (error) { toast(`Could not read runtime update: ${error.message}`); }
  });
  // Connected is the normal state and shows nothing; only a lost stream shows "Reconnecting".
  stream.onopen = () => { if (state.stream === stream) $('connection-status').hidden = true; };
  stream.onerror = () => { if (state.stream === stream) $('connection-status').hidden = false; };
  stream.addEventListener('deleted', () => { if (state.session?.id === id) clearSession(); state.drafts.delete(id); });
  $('messages').scrollTop = $('messages').scrollHeight;
}
// No thread open: the welcome screen; the lists stay live.
function clearSession() {
  ++state.selection;
  state.opening = null;
  state.drafts.set(draftKey(), $('message-input').value);
  state.stream?.close();
  state.stream = null;
  state.session = null;
  state.messageSignature = '';
  state.questionSignature = '';
  state.files = null;
  state.filesError = '';
  state.skills = { sessionId: null, list: null, error: '', at: 0, pending: null };
  closeSlash();
  for (const pane of panes.values()) pane.remove();
  panes.clear();
  state.layout = createLayout();
  setComposer(state.drafts.get('') ?? '');
  localStorage.removeItem('shout.session');
  history.replaceState(null, '', '/');
  $('connection-status').hidden = true;
  renderDock();
  renderMessages();
  renderQuestion();
  renderStatus();
  renderTabStrips();
  renderSide();
  renderSidebar();
}
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = $('message-input').value, text = raw.trim();
  if (!text || state.busy || isActive()) return;
  // Locked before anything is awaited. The text leaves the composer now, so the next prompt can be typed while this
  // one is sent; it comes back if the send fails or is overtaken.
  state.busy = true;
  setComposer('');
  renderStatus();
  let id = state.session?.id;
  try {
    if (!id) {
      // From the welcome screen a thread is made first; opening another thread (or Home) meanwhile cancels the send
      // and the text goes where the user went.
      const created = await newThread();
      if (!created || created.id !== state.session?.id || state.opening) { restoreDraft(state.opening ?? draftKey(), raw); return; }
      id = created.id;
      // A sample thread opens with its suggested prompt; this message replaces it.
      if (created.suggestedPrompt && $('message-input').value === created.suggestedPrompt) setComposer('');
    }
    const reply = replyGuard();
    if (reply(await api(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text } }))) $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    toast(error.message);
    restoreDraft(id ?? draftKey(), raw);
  } finally { state.busy = false; renderStatus(); }
});
function resizeComposer() {
  $('message-input').style.height = 'auto';
  $('message-input').style.height = `${Math.min(190, $('message-input').scrollHeight)}px`;
}
// The slash token under edit: the first word of the message while the caret is still inside it.
function slashToken() {
  const input = $('message-input');
  if (!state.session || document.activeElement !== input || input.selectionStart !== input.selectionEnd) return null;
  if (!/^\/\S*$/.test(input.value.slice(0, input.selectionStart))) return null;
  return /^\/\S*/.exec(input.value)[0];
}
function skillMatches(query) {
  const q = query.toLowerCase();
  const byName = (a, b) => a.name.localeCompare(b.name);
  const list = (state.skills.list || []).filter((skill) => typeof skill?.name === 'string');
  const prefix = list.filter((skill) => skill.name.toLowerCase().startsWith(q)).sort(byName);
  const rest = q ? list.filter((skill) => !prefix.includes(skill) && `${skill.name}\n${skill.description || ''}`.toLowerCase().includes(q)).sort(byName) : [];
  return [...prefix, ...rest];
}
function closeSlash() {
  slash.items = [];
  $('slash-menu').hidden = true;
  $('slash-menu').replaceChildren();
  $('message-input').setAttribute('aria-expanded', 'false');
  $('message-input').removeAttribute('aria-activedescendant');
}
function markSlashActive() {
  const options = $('slash-menu').children;
  for (let i = 0; i < options.length; i++) {
    options[i].classList.toggle('active', i === slash.index);
    options[i].setAttribute('aria-selected', String(i === slash.index));
  }
  const active = options[slash.index];
  if (active) {
    $('message-input').setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }
}
function updateSlash() {
  const token = slashToken();
  if (slash.dismissed !== null && token !== slash.dismissed) slash.dismissed = null;
  if (token === null || token === slash.dismissed) return closeSlash();
  // Refresh the list each time the menu is about to open; loadSkills re-renders the menu when it lands.
  if ($('slash-menu').hidden) loadSkills();
  const previous = slash.items[slash.index]?.name;
  const items = skillMatches(token.slice(1));
  if (!items.length) return closeSlash();
  const changed = items.length !== slash.items.length || items.some((skill, i) => skill !== slash.items[i]);
  slash.items = items;
  slash.index = Math.max(0, items.findIndex((skill) => skill.name === previous));
  if (changed || $('slash-menu').hidden) {
    $('slash-menu').replaceChildren(...items.map((skill, i) => {
      const option = el('div', `slash-option${skill.ok === false ? ' broken' : ''}`);
      option.id = `slash-option-${i}`;
      option.setAttribute('role', 'option');
      const head = el('span', 'skill-row-head');
      head.append(el('span', 'slash-name', `/${skill.name}`));
      if (skill.args) head.append(el('span', 'slash-args', skill.args));
      head.append(...skillBadges(skill));
      option.append(head, el('span', 'slash-scope', SCOPE_LABEL[skill.scope] || 'Command'));
      if (skill.description) option.append(el('span', 'slash-desc', skill.description));
      // Keep focus in the composer while clicking an option.
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => completeSlash(skill));
      option.addEventListener('mousemove', () => { if (slash.index !== i) { slash.index = i; markSlashActive(); } });
      return option;
    }));
  }
  $('slash-menu').hidden = false;
  $('message-input').setAttribute('aria-expanded', 'true');
  markSlashActive();
}
function completeSlash(skill) {
  const input = $('message-input');
  const rest = input.value.slice((/^\/\S*/.exec(input.value)?.[0] || '').length);
  input.value = `/${skill.name}${/^\s/.test(rest) ? rest : ` ${rest}`}`;
  input.focus();
  input.setSelectionRange(skill.name.length + 2, skill.name.length + 2);
  resizeComposer();
  closeSlash();
}
// Returns true when the key was consumed by the open menu.
function slashKeydown(event) {
  if ($('slash-menu').hidden || !slash.items.length || event.isComposing) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    slash.index = (slash.index + (event.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
    markSlashActive();
  } else if (event.key === 'Escape') {
    slash.dismissed = slashToken();
    closeSlash();
  } else if (event.key === 'Tab' && !event.shiftKey) {
    completeSlash(slash.items[slash.index]);
  } else if (event.key === 'Enter' && !event.shiftKey) {
    // An already complete command name sends; anything else completes the highlighted skill.
    const token = slashToken();
    if (slash.items.some((skill) => `/${skill.name}` === token)) { closeSlash(); return false; }
    completeSlash(slash.items[slash.index]);
  } else return false;
  event.preventDefault();
  return true;
}
$('message-input').addEventListener('input', () => { resizeComposer(); updateSlash(); });
$('message-input').addEventListener('keydown', (event) => {
  if (slashKeydown(event)) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('message-input').addEventListener('keyup', (event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateSlash(); });
$('message-input').addEventListener('click', updateSlash);
$('message-input').addEventListener('focus', updateSlash);
$('message-input').addEventListener('blur', closeSlash);
$('cancel-button').addEventListener('click', async () => {
  $('cancel-button').disabled = true;
  const reply = replyGuard();
  try {
    reply(await api(`/sessions/${encodeURIComponent(state.session.id)}/cancel`, { method: 'POST', body: {} }));
  } catch (error) { toast(error.message); }
  finally { $('cancel-button').disabled = false; }
});
$('viz-button').addEventListener('click', () => showSide('summary'));
for (const tab of $('side-tabs').querySelectorAll('[data-side]')) tab.addEventListener('click', () => { if (state.side !== tab.dataset.side) showSide(tab.dataset.side); });
$('side-close').addEventListener('click', () => showSide(state.side));
$('side-refresh').addEventListener('click', () => {
  loadFiles();
  reloadFilePanes();
});
function applyTheme(choice) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('shout.theme', choice); } catch {}
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-checked', String(button.dataset.themeChoice === choice));
  shell.setTheme(choice === 'light' || choice === 'dark' ? choice : 'system').catch(() => {});
}
const darkTheme = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
for (const button of document.querySelectorAll('[data-theme-choice]')) button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
applyTheme(document.documentElement.dataset.theme || 'system');
document.addEventListener('keydown', handleShortcut);
window.addEventListener('beforeunload', () => state.stream?.close());

async function init() {
  initSidebar({
    state, api, toast,
    select: selectSession,
    deselect: clearSession,
    applySnapshot,
    focusComposer: () => { const input = $('message-input'); resizeComposer(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); },
    toggleTheme: () => applyTheme(darkTheme() ? 'light' : 'dark'),
  });
  const side = localStorage.getItem('shout.side');
  state.side = side === 'files' ? 'files' : 'summary';
  $('side-panel').hidden = side === 'closed' || window.matchMedia('(max-width:1040px)').matches;
  for (const button of $('chat-mode').children) {
    button.setAttribute('aria-checked', String(button.dataset.mode === state.chatMode));
    button.addEventListener('click', () => setChatMode(button.dataset.mode));
  }
  renderDock();
  renderMessages();
  renderStatus();
  renderSide();
  try {
    const [config, sessions, projects] = await Promise.all([api('/config'), api('/sessions'), api('/projects')]);
    state.config = config;
    setLists({ projects, sessions });
    renderProviders(config);
    state.messageSignature = '';
    renderModelPicker();
    renderMessages();
    renderSidebar();
    renderProgramPanes();
    startLive();
    const remembered = decodeURIComponent(location.hash.slice(1)) || localStorage.getItem('shout.session');
    if (remembered && state.sessions.some((session) => session.id === remembered)) await selectSession(remembered);
  } catch (error) {
    renderProviders(null);
    toast(`Cannot connect to SHOUT: ${error.message}`);
  }
}
init();
