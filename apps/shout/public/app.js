const $ = (id) => document.getElementById(id);
const state = { config: null, sessions: [], session: null, stream: null, tab: 'graph', selectedEvent: null, selectedScenario: null, messageSignature: '', questionSignature: '', busy: false, runFilter: '', eventFilter: '', drafts: new Map(), selection: 0 };
const terminal = new Set(['completed', 'failed', 'cancelled', 'canceled', 'interrupted', 'idle', 'ready']);
let toastTimer;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function isActive(session = state.session) {
  return !!session && !terminal.has(session.status) && !!session.status;
}
function scenarioCard(scenario, index, onClick) {
  const card = el('button', 'scenario-card');
  card.type = 'button';
  card.append(el('span', 'scenario-number', String(index + 1).padStart(2, '0')));
  const copy = el('div');
  copy.append(el('h3', '', scenario.title), el('p', '', scenario.description));
  card.append(copy, el('span', 'arrow', '↗'));
  card.addEventListener('click', onClick);
  return card;
}
function renderWelcome() {
  const wrapper = el('div', 'welcome');
  wrapper.append(el('div', 'welcome-icon', '↗'), el('div', 'eyebrow', 'JUDGMENT MEETS EXECUTION'));
  wrapper.append(el('h2', '', state.session ? 'Let’s make something work.' : 'More than a conversation.\nA visible way to build.'));
  wrapper.append(el('p', '', 'Talk through a change. Let the model make the judgment calls, then watch SHOUT and ALLEN carry out the work. Every model call, tool, and decision has a place in the session.'));
  wrapper.append(el('div', 'scenario-heading', 'TRY A GUIDED SCENARIO'));
  const grid = el('div', 'scenario-grid');
  (state.config?.scenarios || []).forEach((scenario, i) => grid.append(scenarioCard(scenario, i, () => openNewDialog(scenario.id))));
  wrapper.append(grid, el('div', 'welcome-footer', 'Each scenario starts in its own sample workspace.\nYou review proposed changes before they are applied.'));
  if (!state.config?.scenarios?.length) {
    const button = el('button', 'primary-button', 'Start a new session ↗');
    button.addEventListener('click', () => openNewDialog());
    grid.append(button);
  }
  return wrapper;
}
function appendContent(container, text) {
  // Fenced code only. Everything is textContent; model output cannot become HTML.
  const chunks = String(text).split(/```([^\n`]*)\n([\s\S]*?)```/g);
  for (let i = 0; i < chunks.length; i += 3) {
    if (chunks[i]) container.append(el('div', '', chunks[i]));
    if (i + 2 < chunks.length) {
      if (chunks[i + 1]) container.append(el('div', 'code-language', chunks[i + 1]));
      const pre = el('pre', 'code-block');
      pre.append(el('code', '', chunks[i + 2]));
      container.append(pre);
    }
  }
}
function renderMessages() {
  const messages = state.session?.messages || [];
  const signature = JSON.stringify([state.session?.id, messages]);
  if (signature === state.messageSignature) return;
  state.messageSignature = signature;
  const list = $('messages');
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  list.replaceChildren();
  if (!messages.length) list.append(renderWelcome());
  for (const message of messages) {
    const role = ['user', 'assistant', 'system', 'tool'].includes(message.role) ? message.role : 'system';
    const item = el('article', `message ${role}`);
    item.dataset.messageId = message.id;
    item.append(el('div', 'avatar', role === 'user' ? 'YOU' : role === 'assistant' ? 'S↗' : role === 'tool' ? '↳' : '·'));
    const body = el('div', 'message-body');
    const header = el('div', 'message-header', role === 'assistant' ? 'SHOUT' : role === 'user' ? 'You' : role === 'tool' ? 'Tool result' : 'Runtime');
    header.append(el('time', '', time(message.time)));
    const content = el('div', 'message-text');
    appendContent(content, message.content);
    body.append(header, content);
    item.append(body);
    list.append(item);
  }
  if (nearBottom || messages.length <= 1) list.scrollTop = list.scrollHeight;
}
function renderQuestion() {
  const question = state.session?.question;
  const signature = JSON.stringify([state.session?.id, question]);
  if (state.questionSignature === signature) return;
  state.questionSignature = signature;
  $('question-area').replaceChildren();
  if (!question) return;
  const card = el('section', 'question-card');
  card.setAttribute('aria-label', 'Review required');
  const prompt = typeof question.prompt === 'string' ? question.prompt : question.prompt?.system || 'Review this proposal before continuing.';
  card.append(el('h3', '', 'Your judgment is needed'), el('p', '', prompt));
  if (typeof question.prompt?.data?.value?.summary === 'string') card.append(el('p', '', question.prompt.data.value.summary));
  const actions = el('div', 'question-actions');
  const approve = el('button', 'approve-button', 'Approve & continue');
  const decline = el('button', 'decline-button', 'Decline changes');
  const changes = el('button', 'text-button', 'Inspect changes →');
  changes.addEventListener('click', () => setTab('changes'));
  for (const [button, accept] of [[approve, true], [decline, false]]) {
    button.addEventListener('click', async () => {
      approve.disabled = decline.disabled = true;
      try {
        const result = await api(`/sessions/${encodeURIComponent(state.session.id)}/answer`, { method: 'POST', body: { id: question.id, value: { accept } } });
        if (result.id) applySnapshot(result);
      } catch (error) {
        toast(error.message);
        approve.disabled = decline.disabled = false;
      }
    });
  }
  actions.append(approve, decline, changes);
  card.append(actions, el('div', 'question-id', `Correlated question · ${question.id}`));
  $('question-area').append(card);
}
function renderSidebar() {
  $('session-count').textContent = String(state.sessions.length);
  $('session-list').replaceChildren();
  if (!state.sessions.length) $('session-list').append(el('p', 'empty-copy', 'Your sessions will appear here.'));
  for (const session of state.sessions) {
    const button = el('button', `session-item${session.id === state.session?.id ? ' active' : ''}`);
    button.setAttribute('aria-current', session.id === state.session?.id ? 'page' : 'false');
    button.append(el('span', 'session-name', session.title || 'Untitled session'));
    const meta = el('span', 'session-meta');
    meta.append(el('span', '', `${session.mode === 'fixture' ? 'Fixture' : 'Live'} · ${session.status || 'ready'}`), el('span', '', time(session.updatedAt)));
    button.append(meta);
    button.addEventListener('click', () => selectSession(session.id).catch((error) => toast(error.message)));
    $('session-list').append(button);
  }
}
function renderStatus() {
  const session = state.session;
  const active = isActive(session);
  $('session-title').textContent = session?.title || 'Make the work visible.';
  $('workspace-path').textContent = session?.workspace || 'Start a session to build with SHOUT';
  $('workspace-path').title = session?.workspace || '';
  $('mode-badge').textContent = session ? session.mode === 'fixture' ? 'FIXTURE · NO MODEL' : 'LIVE MODEL' : 'READY';
  $('mode-badge').classList.toggle('fixture', session?.mode === 'fixture');
  $('export-button').disabled = !session;
  $('storage-warning').hidden = !session?.storageError;
  $('storage-warning').textContent = session?.storageError ? `Session could not be saved: ${typeof session.storageError === 'string' ? session.storageError : JSON.stringify(session.storageError)}. Export this session to keep a copy.` : '';
  $('files-button').disabled = !session;
  $('status-line').className = `status-line${session?.question ? ' question' : active ? ' active' : session?.status === 'failed' ? ' failed' : ''}`;
  const latest = session?.events?.at(-1);
  $('status-text').textContent = session?.question ? 'Waiting for your review' : active ? `${session.status} ${latest ? `· ${latest.type}` : ''}` : session ? `Session ${session.status || 'ready'}${session.mode === 'fixture' ? ' · scripted judgments' : ''}` : 'Ready when you are';
  $('cancel-button').hidden = !active;
  $('send-button').disabled = active || state.busy;
  $('message-input').placeholder = active ? 'The current run is in progress. You can draft your next message…' : 'Ask SHOUT to explore, fix, or build something…';
}
function classify(event) {
  const type = event.type || '';
  if (type.startsWith('user.') || type.startsWith('message.user')) return { lane: 0, kind: 'user' };
  if (type.startsWith('model.') || type.startsWith('provider.') || type.startsWith('chat.')) return { lane: 2, kind: 'model' };
  if (type.startsWith('tool.')) return { lane: 4, kind: 'tool' };
  if (type.startsWith('vm.') || type.startsWith('effect.') || type === 'program.loaded') return { lane: 3, kind: 'vm' };
  return { lane: 1, kind: 'harness' };
}
function filteredEvents() {
  return (state.session?.events || []).filter((event) => (!state.runFilter || event.run === state.runFilter) && (!state.eventFilter || JSON.stringify(event).toLowerCase().includes(state.eventFilter.toLowerCase())));
}
function shortLabel(event) {
  const labels = { 'run.started': 'Run start', 'run.terminal': 'Run end', 'program.loaded': 'Program', 'model.started': 'Judge', 'model.completed': 'Judgment', 'tool.started': 'Call tool', 'tool.completed': 'Result', 'user.question': 'Review', 'user.answered': 'Answer', 'chat.started': 'Route', 'chat.completed': 'Route result', 'vm.event': 'VM event', 'effect.requested': 'Suspend', 'effect.resolved': 'Resume' };
  return labels[event.type] || event.type.split('.').at(-1);
}
function selectEvent(event) {
  state.selectedEvent = event.id;
  renderInspector();
}
function renderEventDetail() {
  const detail = $('event-detail');
  const event = state.session?.events?.find((candidate) => candidate.id === state.selectedEvent);
  detail.hidden = !event || state.tab === 'changes' || state.tab === 'files';
  detail.replaceChildren();
  if (detail.hidden) return;
  const header = el('div', 'detail-header');
  header.append(el('strong', '', `#${event.sequence} · ${event.type}`));
  const close = el('button', 'icon-button', '×');
  close.setAttribute('aria-label', 'Close event details');
  close.addEventListener('click', () => { state.selectedEvent = null; renderInspector(); });
  header.append(close);
  detail.append(header, el('pre', '', JSON.stringify(event, null, 2)));
  if (event.type === 'program.loaded') {
    const run = state.session.runs?.find((candidate) => candidate.id === event.run);
    if (run?.source) detail.append(el('p', 'code-language', 'Executed ALLEN source'), el('pre', '', run.source));
  }
}
function renderGraph(container, events) {
  if (!events.length) return renderVizEmpty(container);
  const stats = el('div', 'flow-summary');
  for (const [label, type] of [[state.session?.mode === 'fixture' ? 'Scripted judgments' : 'Model calls', 'model.started'], ['Tool calls', 'tool.started'], ['VM runs', 'run.started']]) {
    const stat = el('div', 'flow-stat');
    stat.append(el('strong', '', String(events.filter((event) => event.type === type || type === 'model.started' && event.type === 'chat.started').length)), document.createTextNode(label));
    stats.append(stat);
  }
  container.append(stats);
  const lanes = el('div', 'lane-header');
  for (const [name, kind] of [['You', 'user'], ['SHOUT', 'harness'], [state.session?.mode === 'fixture' ? 'Fixture' : 'Model', 'model'], ['ALLEN', 'vm'], ['Tools', 'tool']]) lanes.append(el('span', kind, name));
  container.append(lanes);
  let lastRun;
  const effects = new Map();
  for (const event of events) {
    if (event.run && event.run !== lastRun) {
      container.append(el('div', 'flow-run-label', `RUN ${event.run}`));
      lastRun = event.run;
    }
    const row = el('div', 'flow-row');
    const { lane, kind } = classify(event);
    // A connector is drawn only when recorded events share a run + effect ID.
    const effectKey = event.effectId && event.run ? `${event.run}:${event.effectId}` : null;
    const previousLane = effectKey ? effects.get(effectKey) : undefined;
    if (previousLane !== undefined && previousLane !== lane) {
      const connector = el('div', 'flow-connector');
      connector.style.left = `${Math.min(previousLane, lane) * 20 + 10}%`;
      connector.style.width = `${Math.abs(previousLane - lane) * 20}%`;
      if (lane < previousLane) connector.style.transform = 'rotate(180deg)';
      connector.title = `Shared effect ${event.effectId}`;
      row.append(connector);
    }
    if (effectKey) effects.set(effectKey, lane);
    const node = el('button', `flow-node ${kind}${state.selectedEvent === event.id ? ' selected' : ''}`, shortLabel(event));
    node.style.gridColumn = String(lane + 1);
    node.title = `${event.type}${event.effectId ? ` · ${event.effectId}` : ''}`;
    node.setAttribute('aria-label', `Event ${event.sequence}: ${event.type}`);
    node.append(el('small', '', `#${event.sequence}`));
    node.addEventListener('click', () => selectEvent(event));
    row.append(node);
    container.append(row);
  }
  container.append(el('p', 'flow-note', 'Top to bottom: recorded event order. Horizontal lines connect events sharing an explicit run + effect ID. Select any node to inspect its payload.'));
}
function renderVizEmpty(container) {
  const empty = el('div', 'viz-empty');
  empty.append(el('div', 'empty-glyph', '⌘'), el('h3', '', state.session?.events?.length ? 'No matching events' : 'The runtime, unfolded.'), el('p', '', state.session?.events?.length ? 'Adjust the run or event filter to see more of this session.' : 'As your session runs, see judgment and execution move between the model, SHOUT, ALLEN, and tools.'));
  container.append(empty);
  if (!state.session?.events?.length) {
    const lanes = el('div', 'lane-header');
    for (const name of ['You', 'SHOUT', 'Model', 'ALLEN', 'Tools']) lanes.append(el('span', '', name));
    container.append(lanes);
  }
}
function renderTrace(container, events) {
  if (!events.length) return renderVizEmpty(container);
  for (const event of events) {
    const button = el('button', `trace-event${state.selectedEvent === event.id ? ' selected' : ''}`);
    button.append(el('span', 'trace-index', `#${event.sequence}`));
    const main = el('span', 'trace-event-main');
    main.append(el('strong', '', event.type), el('small', '', `${time(event.time)}${event.effectId ? ` · effect ${event.effectId}` : event.run ? ` · ${event.run}` : ''}`));
    button.append(main);
    button.addEventListener('click', () => selectEvent(event));
    container.append(button);
  }
}
function renderChanges(container) {
  const changes = state.session?.changes || [];
  container.append(el('p', 'empty-copy', changes.length ? 'Review the exact before and after contents. Changes may be proposed or already applied; check the run events for the outcome.' : 'Proposed file changes will appear here before approval.'));
  for (const change of changes) {
    const file = el('section', 'diff-file');
    file.append(el('div', 'diff-title', change.path), el('div', 'diff-label', 'BEFORE'), el('pre', 'diff-code before', change.before ?? '(new file)'), el('div', 'diff-label', 'AFTER'), el('pre', 'diff-code after', change.after ?? '(deleted)'));
    container.append(file);
  }
}
function renderInspector() {
  const container = $('inspector-content');
  const oldScroll = container.scrollTop;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 85;
  $('inspector-title').textContent = state.tab === 'files' ? 'Workspace files' : 'Session VIZ';
  $('event-count').textContent = String(state.session?.events?.length || 0);
  $('change-count').textContent = String(state.session?.changes?.length || 0);
  $('viz-toolbar').hidden = state.tab === 'changes' || state.tab === 'files';
  for (const tab of ['graph', 'trace', 'changes']) {
    $(`${tab}-tab`).classList.toggle('active', state.tab === tab);
    $(`${tab}-tab`).setAttribute('aria-selected', String(state.tab === tab));
  }
  $('files-button').setAttribute('aria-pressed', String(state.tab === 'files'));
  const runIds = [...new Set((state.session?.events || []).map((event) => event.run).filter(Boolean))];
  const optionsSignature = JSON.stringify(runIds);
  if ($('run-filter').dataset.signature !== optionsSignature) {
    $('run-filter').dataset.signature = optionsSignature;
    $('run-filter').replaceChildren(new Option('All runs', ''), ...runIds.map((id, i) => new Option(`Run ${i + 1} · ${id.slice(-8)}`, id)));
    $('run-filter').value = state.runFilter;
  }
  if (state.tab === 'files') return;
  container.replaceChildren();
  if (state.tab === 'graph') renderGraph(container, filteredEvents());
  else if (state.tab === 'trace') renderTrace(container, filteredEvents());
  else renderChanges(container);
  renderEventDetail();
  container.scrollTop = nearBottom && !state.selectedEvent && state.tab !== 'changes' ? container.scrollHeight : oldScroll;
}
function setTab(tab) {
  state.tab = tab;
  $('inspector').hidden = false;
  $('viz-button').setAttribute('aria-pressed', 'true');
  renderInspector();
  if (tab === 'files') loadFiles();
}
async function loadFiles() {
  const sessionId = state.session?.id;
  if (!sessionId) return;
  $('event-detail').hidden = true;
  $('inspector-content').replaceChildren(el('p', 'empty-copy', 'Loading workspace files…'));
  try {
    const { files } = await api(`/sessions/${encodeURIComponent(sessionId)}/files`);
    if (state.session?.id !== sessionId || state.tab !== 'files') return;
    const container = $('inspector-content');
    container.replaceChildren();
    if (!files.length) container.append(el('p', 'empty-copy', 'No readable files found in this workspace.'));
    for (const path of files) {
      const button = el('button', 'file-entry', path);
      button.addEventListener('click', () => loadFile(sessionId, path));
      container.append(button);
    }
  } catch (error) { toast(error.message); }
}
async function loadFile(sessionId, path) {
  try {
    const file = await api(`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`);
    if (state.session?.id !== sessionId || state.tab !== 'files') return;
    const container = $('inspector-content');
    const back = el('button', 'file-back', '← All workspace files');
    back.addEventListener('click', loadFiles);
    container.replaceChildren(back, el('div', 'diff-title', file.path), el('pre', 'code-block', file.content));
  } catch (error) { toast(error.message); }
}
function applySnapshot(session) {
  if (!session?.id || state.session && session.id !== state.session.id) return;
  state.session = session;
  const index = state.sessions.findIndex((candidate) => candidate.id === session.id);
  if (index >= 0) state.sessions[index] = session;
  else state.sessions.unshift(session);
  renderSidebar();
  renderMessages();
  renderQuestion();
  renderStatus();
  renderInspector();
}
async function selectSession(id) {
  const selection = ++state.selection;
  if (state.session) state.drafts.set(state.session.id, $('message-input').value);
  const session = await api(`/sessions/${encodeURIComponent(id)}`);
  if (selection !== state.selection) return;
  state.stream?.close();
  state.session = null;
  state.messageSignature = '';
  state.questionSignature = '';
  state.selectedEvent = null;
  state.runFilter = '';
  state.eventFilter = '';
  $('event-filter').value = '';
  state.tab = state.tab === 'files' ? 'graph' : state.tab;
  applySnapshot(session);
  $('message-input').value = state.drafts.get(id) || (session.messages.length ? '' : session.suggestedPrompt || '');
  resizeComposer();
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
  stream.onopen = () => {
    if (state.stream !== stream) return;
    $('connection-status').textContent = 'LIVE';
    $('connection-status').classList.remove('disconnected');
  };
  stream.onerror = () => {
    if (state.stream !== stream) return;
    $('connection-status').textContent = 'RECONNECTING';
    $('connection-status').classList.add('disconnected');
  };
  $('messages').scrollTop = $('messages').scrollHeight;
}
function renderDialogScenarios() {
  $('dialog-scenarios').replaceChildren();
  (state.config?.scenarios || []).forEach((scenario, i) => {
    const card = scenarioCard(scenario, i, () => {
      state.selectedScenario = state.selectedScenario === scenario.id ? null : scenario.id;
      renderDialogScenarios();
    });
    card.classList.toggle('selected', state.selectedScenario === scenario.id);
    card.setAttribute('aria-pressed', String(state.selectedScenario === scenario.id));
    $('dialog-scenarios').append(card);
  });
  $('workspace-input').disabled = !!state.selectedScenario;
  $('workspace-input').placeholder = state.selectedScenario ? 'Isolated sample workspace (created automatically)' : '/path/to/your/project';
  $('workspace-input').value = state.selectedScenario ? '' : state.config?.defaultWorkspace || state.config?.cwd || '';
  $('test-command-input').disabled = !!state.selectedScenario;
  $('create-button').textContent = state.selectedScenario ? 'Create scenario session ↗' : 'Create session ↗';
}
function openNewDialog(scenarioId = null) {
  state.selectedScenario = scenarioId;
  $('new-error').hidden = true;
  $('new-form').reset();
  renderDialogScenarios();
  $('new-dialog').showModal();
}
$('new-session').addEventListener('click', () => openNewDialog());
$('close-dialog').addEventListener('click', () => $('new-dialog').close());
$('blank-session').addEventListener('click', () => { state.selectedScenario = null; renderDialogScenarios(); });
$('new-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('create-button').disabled = true;
  $('new-error').hidden = true;
  try {
    const scenario = state.config?.scenarios.find((item) => item.id === state.selectedScenario);
    const session = await api('/sessions', { method: 'POST', body: { mode: $('mode-input').value, ...(scenario ? { scenario: scenario.id } : { workspace: $('workspace-input').value.trim(), testCommand: $('test-command-input').value.trim() || undefined }) } });
    await selectSession(session.id);
    $('new-dialog').close();
    $('message-input').value = scenario?.prompt || '';
    resizeComposer();
    $('message-input').focus();
    if (scenario) toast('Scenario ready. Send the prepared prompt to begin.');
  } catch (error) {
    $('new-error').textContent = error.message;
    $('new-error').hidden = false;
  } finally { $('create-button').disabled = false; }
});
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('message-input').value.trim();
  if (!text || state.busy || isActive()) return;
  if (!state.session) { openNewDialog(); return; }
  state.busy = true;
  renderStatus();
  try {
    const id = state.session.id;
    const session = await api(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text } });
    if (state.session?.id === id) {
      $('message-input').value = '';
      resizeComposer();
      if (session.id) applySnapshot(session);
      $('messages').scrollTop = $('messages').scrollHeight;
    }
  } catch (error) { toast(error.message); }
  finally { state.busy = false; renderStatus(); }
});
function resizeComposer() {
  $('message-input').style.height = 'auto';
  $('message-input').style.height = `${Math.min(190, $('message-input').scrollHeight)}px`;
}
$('message-input').addEventListener('input', resizeComposer);
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('cancel-button').addEventListener('click', async () => {
  $('cancel-button').disabled = true;
  try {
    const session = await api(`/sessions/${encodeURIComponent(state.session.id)}/cancel`, { method: 'POST', body: {} });
    if (session.id) applySnapshot(session);
  } catch (error) { toast(error.message); }
  finally { $('cancel-button').disabled = false; }
});
$('viz-button').addEventListener('click', () => {
  if (state.tab === 'files') { setTab('graph'); return; }
  $('inspector').hidden = !$('inspector').hidden;
  $('viz-button').setAttribute('aria-pressed', String(!$('inspector').hidden));
});
$('files-button').addEventListener('click', () => setTab(state.tab === 'files' ? 'graph' : 'files'));
for (const tab of ['graph', 'trace', 'changes']) $(`${tab}-tab`).addEventListener('click', () => setTab(tab));
$('run-filter').addEventListener('change', (event) => { state.runFilter = event.target.value; state.selectedEvent = null; renderInspector(); });
$('event-filter').addEventListener('input', (event) => { state.eventFilter = event.target.value; renderInspector(); });
$('export-button').addEventListener('click', async () => {
  if (!state.session) return;
  try {
    const data = await api(`/sessions/${encodeURIComponent(state.session.id)}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = el('a');
    link.href = url;
    link.download = `shout-${state.session.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
});
$('menu-button').addEventListener('click', () => $('app').classList.toggle('menu-open'));
$('about-button').addEventListener('click', () => $('about-dialog').showModal());
$('close-about').addEventListener('click', () => $('about-dialog').close());
document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('new-dialog').open && !$('about-dialog').open) { event.preventDefault(); openNewDialog(); }
});
window.addEventListener('beforeunload', () => state.stream?.close());

async function init() {
  if (window.matchMedia('(max-width:1000px)').matches) {
    $('inspector').hidden = true;
    $('viz-button').setAttribute('aria-pressed', 'false');
  }
  renderMessages();
  renderStatus();
  renderInspector();
  try {
    const [config, sessions] = await Promise.all([api('/config'), api('/sessions')]);
    state.config = config;
    state.sessions = Array.isArray(sessions) ? sessions : sessions.sessions || [];
    $('provider-status').textContent = config.provider?.available ? config.provider.version || 'Codex connected' : 'Live provider unavailable · fixture ready';
    if (!config.provider?.available) $('model-help').textContent = config.provider?.error || 'Live provider is unavailable. Choose fixture mode to explore without a model.';
    state.messageSignature = '';
    renderMessages();
    renderSidebar();
    const remembered = decodeURIComponent(location.hash.slice(1)) || localStorage.getItem('shout.session');
    if (remembered && state.sessions.some((session) => session.id === remembered)) await selectSession(remembered);
  } catch (error) {
    $('provider-status').textContent = 'Runtime connection failed';
    toast(`Cannot connect to SHOUT: ${error.message}`);
  }
}
init();
