// The sidebar (after T3 Code's): threads as an inbox of cards, or grouped by project; the project scope, search and
// view menu; thread actions, renaming and context menus; resizing and collapsing; keyboard shortcuts and the desktop
// app's menu commands; the welcome screen. app.js passes a context in initSidebar and calls renderSidebar.
import * as shell from './desktop.js';
import { providerGlyph } from './model-picker.js';
import { el, icon, iconButton, monogramTile, copyText, reconcile } from './dom.js';
import { showMenu, confirmAction } from './menu.js';
import { connectLists, watchAttention } from './live.js';
import { initProjects, addProject, projectSettings, projectMenu, confirmFolder, canRevealPath, upsertProject } from './projects.js';
import { STATUS, threadStatus, topStatus, relativeTime, activityTime, isBusy, summarize, sortThreads, visibleThreads, groupThreads, capThreads, recentProject, abbreviatePath, stepThread, navigation, stillHere, afterDelete } from './sidebar-logic.js';

export { addProject };
const $ = (id) => document.getElementById(id);
const KEY = { width: 'shout.sidebar.width', collapsed: 'shout.sidebar.collapsed', scope: 'shout.sidebar.scope', view: 'shout.sidebar.view', sort: 'shout.sidebar.sort', expanded: 'shout.sidebar.expanded', visited: 'shout.sidebar.visited', sleeping: 'shout.sleepingOpen' };
const WIDTH = { initial: 256, min: 208, main: 640 };
const CAP = 6;
const load = (key, fallback) => { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
const mac = shell.desktop?.platform === 'darwin' || /Mac|iPhone|iPad/.test(navigator.platform);
const mod = (event) => (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
const narrow = () => matchMedia('(max-width:760px)').matches;
const typing = (node) => node instanceof Element && Boolean(node.closest('input, textarea, select, [contenteditable]'));

// ctx: { state, api, toast, select(id), deselect(), applySnapshot(snapshot), focusComposer(), toggleTheme() }
let ctx = null;
let scope = null;
const ui = { query: '', scope: null, view: 'flat', sort: 'activity', width: WIDTH.initial, sleepingOpen: false, sleepingShown: 10, expanded: {}, showAll: new Set(), visited: {}, visitTimer: 0, renaming: false, rows: new Map(), used: new Set() };

export function initSidebar(context) {
  ctx = context;
  ctx.state.projects ??= [];
  Object.assign(ui, {
    scope: load(KEY.scope, null), view: load(KEY.view, 'flat') === 'grouped' ? 'grouped' : 'flat', sort: load(KEY.sort, 'activity') === 'created' ? 'created' : 'activity',
    sleepingOpen: Boolean(load(KEY.sleeping, 0)), expanded: load(KEY.expanded, {}), visited: load(KEY.visited, {}),
  });
  initProjects({ ...ctx, render: renderSidebar, newThread, openProject, renameProject });
  if (shell.isDesktop) {
    const root = document.documentElement;
    root.dataset.desktop = shell.desktop.platform || 'desktop';
    root.dataset.titlebar = shell.chrome.titlebar || 'none';
    if (shell.chrome.insetLeft) root.style.setProperty('--chrome-inset-left', `${shell.chrome.insetLeft}px`);
    if (shell.chrome.overlayHeight) root.style.setProperty('--chrome-top', `${shell.chrome.overlayHeight}px`);
  }
  for (const node of document.querySelectorAll('.sidebar [data-icon]')) node.prepend(icon(node.dataset.icon));
  $('menu-button')?.replaceChildren(icon('sidebar'));
  $('new-session').title = `New thread (${mac ? '⌘N' : shell.isDesktop ? 'Ctrl+N' : 'N'})`;
  $('sidebar-toggle').title = `Toggle sidebar (${mac ? '⌘B' : 'Ctrl+B'})`;
  setWidth(load(KEY.width, WIDTH.initial), false);
  $('app').classList.toggle('sidebar-collapsed', load(KEY.collapsed, false) === true);
  wireHeader();
  wireList();
  wireRail();
  shell.onMenuCommand(command);
  shell.onOpenSession((id) => { if (findThread(id)) open(id); });
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? renderSidebar() : flushVisited()));
  window.addEventListener('pagehide', flushVisited);
  setInterval(renderSidebar, 30000);
}

/* Lists: projects and thread summaries */
const projectMap = () => new Map((ctx?.state.projects ?? []).map((project) => [project.id, project]));
const findThread = (id) => ctx.state.sessions.find((thread) => thread.id === id) ?? null;
const home = () => ctx.state.config?.home;
const modelLabel = (id) => ctx.state.config?.models?.find((model) => model.id === id)?.label ?? id ?? '';
export function upsert(summary) {
  if (!summary?.id) return;
  const index = ctx.state.sessions.findIndex((thread) => thread.id === summary.id);
  if (index >= 0) ctx.state.sessions[index] = { ...ctx.state.sessions[index], ...summary }; else ctx.state.sessions.unshift(summary);
}
/** New lists from the server (the initial fetch or /api/stream). */
export function setLists({ projects, sessions } = {}) {
  const { state } = ctx;
  if (Array.isArray(projects)) state.projects = projects;
  if (Array.isArray(sessions)) {
    state.sessions = sessions;
    // The open thread's own snapshot can be newer than the list.
    const own = state.session && summarize(state.session);
    const index = own ? sessions.findIndex((thread) => thread.id === own.id) : -1;
    if (index >= 0 && String(own.updatedAt) > String(sessions[index].updatedAt)) sessions[index] = { ...sessions[index], ...own };
    const ids = new Set(sessions.map((thread) => thread.id));
    for (const id of Object.keys(ui.visited)) if (!ids.has(id)) delete ui.visited[id];
  }
  $('app').classList.toggle('has-projects', state.projects.length > 0);
  renderSidebar();
}
/** Keeps the lists live over /api/stream and turns their changes into notifications, the badge and window attention. */
export function startLive() {
  const attention = watchAttention();
  attention(ctx.state.sessions, ctx.state.session?.id);
  connectLists((data) => { setLists(data); attention(ctx.state.sessions, ctx.state.session?.id); });
}
function applyThread(snapshot) {
  if (snapshot?.id && snapshot.id === ctx.state.session?.id) ctx.applySnapshot(snapshot);
  else { upsert(summarize(snapshot)); renderSidebar(); }
}

/* Unread: when each thread was last seen, kept in localStorage */
function touchOpen() {
  const id = ctx.state.session?.id;
  if (!id || document.visibilityState !== 'visible') return;
  ui.visited[id] = new Date().toISOString();
  clearTimeout(ui.visitTimer);
  ui.visitTimer = setTimeout(flushVisited, 500);
}
function flushVisited() { clearTimeout(ui.visitTimer); save(KEY.visited, ui.visited); }

/* Opening and creating threads */
function open(id) {
  if (!id) return null;
  if (id === ctx.state.session?.id) { $('app').classList.remove('menu-open'); return null; }
  return Promise.resolve(ctx.select(id)).catch((error) => ctx.toast(error.message));
}
function defaultProject() {
  const projects = projectMap();
  return projects.get(ui.scope) ?? projects.get(ctx.state.session?.projectId) ?? recentProject(ctx.state.projects, ctx.state.sessions);
}
// Opens a thread an action just made, unless the user opened or closed something while it was on its way (`before`).
async function openMade(id, before, typed = '') {
  if (!stillHere(before, navigation(ctx.state))) return false;
  try { if (id !== ctx.state.session?.id) await ctx.select(id); } catch (error) { ctx.toast(error.message); }
  if (ctx.state.session?.id !== id) return false;
  const input = $('message-input');
  if (typed && input && !input.value) input.value = typed;
  ctx.focusComposer();
  return true;
}
/**
 * A thread in the project (the scoped one, the open thread's, or the latest), reusing its empty thread. Resolves the
 * thread (a snapshot) once it exists, whether or not it was opened: it is not opened if the user moved meanwhile.
 * With no project it starts Add project and resolves null. `before` is where the user was when the request began.
 */
export async function newThread(projectId = defaultProject()?.id, { createWorkspace = false, before = navigation(ctx.state) } = {}) {
  if (!projectId) { await addProject(); return null; }
  const typed = ctx.state.session ? '' : $('message-input')?.value ?? '';
  let session;
  try {
    session = await ctx.api('/sessions', { method: 'POST', body: { projectId, ...(createWorkspace ? { createWorkspace } : {}) } });
  } catch (error) {
    if (error.code === 'workspace_missing' && !createWorkspace) return (await confirmFolder(error.path)) ? newThread(projectId, { createWorkspace: true, before }) : null;
    ctx.toast(error.message);
    return null;
  }
  upsert(summarize(session));
  renderSidebar();
  await openMade(session.id, before, typed);
  return session;
}
/** A sample's thread (a fresh copy of it); the composer is prefilled with the sample's prompt. */
export async function startSample(id) {
  const before = navigation(ctx.state);
  try {
    const session = await ctx.api('/sessions', { method: 'POST', body: { scenario: id } });
    upsert(summarize(session));
    renderSidebar();
    await openMade(session.id, before);
    return session;
  } catch (error) { ctx.toast(error.message); return null; }
}
// After Add project: a new project gets a new thread, a known one opens its latest thread (if the user hasn't moved).
async function openProject(project, existing, before = navigation(ctx.state)) {
  if (ui.scope && ui.scope !== project.id) setScope(null);
  const latest = existing ? sortThreads(ctx.state.sessions.filter((thread) => thread.projectId === project.id))[0] : null;
  if (!latest) return newThread(project.id, { before });
  await openMade(latest.id, before);
  return null;
}
function exportThread() {
  const id = ctx.state.session?.id;
  if (!id) return ctx.toast('Open a thread to export it');
  const link = el('a');
  link.href = `/api/sessions/${encodeURIComponent(id)}/export`;
  link.download = `shout-${id}.json`;
  document.body.append(link);
  link.click();
  link.remove();
}

/* Thread actions */
async function setSleeping(id, sleeping) {
  try { applyThread(await ctx.api(`/sessions/${encodeURIComponent(id)}/sleep`, { method: 'POST', body: { sleeping } })); } catch (error) { ctx.toast(error.message); }
}
const threadOrder = () => [...$('session-list').querySelectorAll('.sb-thread')].map((node) => node.dataset.id);
async function deleteThread(id) {
  const thread = findThread(id);
  if (!thread) return;
  const ok = await confirmAction({ title: `Delete ${thread.title || 'this thread'}?`, lines: ['Its conversation is deleted. Files in the project are not touched.'], confirm: 'Delete', destructive: true });
  if (!ok) return;
  const ids = threadOrder();
  const next = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1] ?? null;
  const before = navigation(ctx.state);
  try { await ctx.api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (error) { ctx.toast(error.message); return; }
  ctx.state.sessions = ctx.state.sessions.filter((item) => item.id !== id);
  delete ui.visited[id];
  // Decided now, not before the request: the user may have opened another thread while it ran.
  const then = afterDelete({ deleted: id, next, before, after: navigation(ctx.state) });
  if (then?.open) open(then.open); else if (then?.deselect) ctx.deselect();
  renderSidebar();
}
function inlineRename(node, value, label, commit) {
  ui.renaming = true;
  const input = el('input', 'sb-rename');
  Object.assign(input, { value, maxLength: 120, spellcheck: false });
  input.setAttribute('aria-label', label);
  node.classList.add('renaming');
  node.append(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = async (keep) => {
    if (finished) return;
    finished = true;
    const next = input.value.replace(/\s+/g, ' ').trim();
    const refocus = document.activeElement === input;
    ui.renaming = false;
    ui.rows.delete(node.dataset.key);
    input.remove();
    node.classList.remove('renaming');
    if (keep && next && next !== value) { try { await commit(next); } catch (error) { ctx.toast(error.message); } }
    renderSidebar();
    // Back to the row, unless the user put focus somewhere else while the rename was saving.
    if (refocus && (!document.activeElement || document.activeElement === document.body)) $('session-list').querySelector(`[data-key="${CSS.escape(node.dataset.key)}"] [data-nav]`)?.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); finish(true); } else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  for (const type of ['click', 'dblclick', 'contextmenu']) input.addEventListener(type, (event) => event.stopPropagation());
}
function startRename(id) {
  const thread = findThread(id);
  const node = thread && $('session-list').querySelector(`.sb-thread[data-id="${CSS.escape(id)}"]`);
  if (!node || ui.renaming) return;
  inlineRename(node, thread.title || '', 'Thread title', async (title) => applyThread(await ctx.api(`/sessions/${encodeURIComponent(id)}/title`, { method: 'POST', body: { title } })));
}
// Inline on its group header when the list shows one; otherwise the caller opens the settings dialog.
function renameProject(id) {
  const node = $('session-list').querySelector(`.sb-group[data-project="${CSS.escape(id)}"]`);
  const project = projectMap().get(id);
  if (!node || !project || ui.renaming) return false;
  inlineRename(node, project.name, 'Project name', async (name) => upsertProject(await ctx.api(`/projects/${encodeURIComponent(id)}`, { method: 'POST', body: { name } })));
  return true;
}
async function threadMenu(id, position) {
  const thread = findThread(id);
  if (!thread) return;
  const busy = isBusy(thread);
  const choice = await showMenu([
    { id: 'rename', label: 'Rename' },
    ...(thread.unavailable ? [] : [thread.sleeping ? { id: 'wake', label: 'Wake' } : { id: 'sleep', label: 'Sleep', enabled: !busy }]),
    { type: 'separator' },
    { id: 'copy-path', label: 'Copy path' },
    { id: 'copy-id', label: 'Copy thread ID' },
    ...(canRevealPath() && !thread.unavailable ? [{ id: 'reveal', label: 'Reveal in file manager' }] : []),
    { type: 'separator' },
    ...(projectMap().has(thread.projectId) ? [{ id: 'project', label: 'Project settings' }, { type: 'separator' }] : []),
    { id: 'delete', label: 'Delete', destructive: true, enabled: !busy },
  ], position);
  if (choice === 'rename') startRename(id);
  else if (choice === 'sleep' || choice === 'wake') setSleeping(id, choice === 'sleep');
  else if (choice === 'copy-path') ctx.toast((await copyText(thread.workspace)) ? 'Path copied' : thread.workspace);
  else if (choice === 'copy-id') ctx.toast((await copyText(id)) ? 'Thread ID copied' : id);
  else if (choice === 'reveal') shell.revealPath(thread.workspace).catch((error) => ctx.toast(error.message));
  else if (choice === 'project') projectSettings(thread.projectId);
  else if (choice === 'delete') deleteThread(id);
}
function menuPosition(event) {
  if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
  const box = (event.target.closest('[data-nav], [role=option]') ?? event.target).getBoundingClientRect();
  return { x: box.left + 16, y: box.bottom - 6 };
}

/* Rendering */
function row(key, signature, build) {
  ui.used.add(key);
  const hit = ui.rows.get(key);
  if (hit?.signature === signature) return hit.node;
  const node = build();
  node.dataset.key = key;
  ui.rows.set(key, { signature, node });
  return node;
}
export function renderSidebar() {
  if (!ctx) return;
  touchOpen();
  renderScope();
  if (ui.renaming) return;
  ui.used = new Set();
  const nodes = ui.view === 'grouped' ? groupedRows() : flatRows();
  for (const key of ui.rows.keys()) if (!ui.used.has(key)) ui.rows.delete(key);
  reconcile($('session-list'), nodes);
  $('session-list').classList.toggle('grouped', ui.view === 'grouped');
}
function lists() {
  const projects = projectMap();
  const current = projects.has(ui.scope) ? ui.scope : null;
  return { projects, scope: current, ...visibleThreads(ctx.state.sessions, projects, { scope: current, query: ui.query, sort: ui.sort }) };
}
const noMatches = () => row('empty', ui.query, () => el('p', 'sb-empty', 'No matches'));
function flatRows() {
  const { projects, awake, sleeping } = lists();
  const rows = [...awake.map((thread) => threadRow(thread, 'card', projects)), ...shelf(sleeping, projects)];
  return rows.length || !ui.query.trim() ? rows : [noMatches()];
}
function groupedRows() {
  const { projects, scope: current, awake, sleeping } = lists();
  const openId = ctx.state.session?.id;
  const rows = [];
  // Grouped, a project lists all its threads: the sleeping ones after the rest.
  for (const { project, threads } of groupThreads([...awake, ...sleeping], projects, { scope: current, query: ui.query })) {
    const expanded = Boolean(ui.query.trim()) || ui.expanded[project.id] !== false;
    rows.push(groupRow(project, threads, expanded));
    const all = ui.showAll.has(project.id);
    const { shown, hidden } = expanded ? capThreads(threads, { cap: CAP, all, openId }) : { shown: threads.filter((thread) => thread.id === openId), hidden: 0 };
    rows.push(...shown.map((thread) => threadRow(thread, 'nested', projects)));
    if (expanded && (hidden || (all && threads.length > CAP))) rows.push(row(`more:${project.id}`, String(all), () => moreRow(project.id, all ? 'Show less' : 'Show more', 'more')));
  }
  return rows.length || !ui.query.trim() ? rows : [noMatches()];
}
function statusLabel(status) {
  const label = el('span', `sb-status ${status}`);
  label.append(icon(status), el('span', '', STATUS[status]));
  return label;
}
function action(name, label, id) {
  const button = iconButton(name, label, 'sb-action');
  button.dataset.action = id;
  button.tabIndex = -1;
  return button;
}
function threadRow(thread, variant, projects) {
  const project = projects.get(thread.projectId) ?? null;
  const status = threadStatus(thread, ui.visited[thread.id]);
  const active = thread.id === ctx.state.session?.id;
  const time = relativeTime(activityTime(thread));
  const model = modelLabel(thread.model);
  const signature = JSON.stringify([variant, thread.title, project?.name, status, time, active, model, thread.provider, thread.sleeping, thread.unavailable, isBusy(thread)]);
  return row(`t:${thread.id}`, signature, () => {
    const title = thread.title || 'Untitled thread';
    const node = el('div', `sb-thread ${variant}${active ? ' active' : ''}${thread.sleeping ? ' sleeping' : ''}${thread.unavailable ? ' unavailable' : ''}${status ? ` is-${status}` : ''}`);
    node.dataset.id = thread.id;
    const openButton = el('button', 'sb-open');
    openButton.type = 'button';
    openButton.dataset.nav = 'open';
    openButton.title = thread.unavailable ? `${title}\nFolder missing` : title;
    openButton.setAttribute('aria-label', status ? `${title}, ${STATUS[status]}` : title);
    if (project || thread.unavailable) openButton.setAttribute('aria-description', [project?.name, thread.unavailable && 'folder missing'].filter(Boolean).join(', '));
    if (active) openButton.setAttribute('aria-current', 'page');
    const slot = el('span', 'sb-slot');
    slot.append(status ? statusLabel(status) : el('span', 'sb-time', time));
    // A thread whose folder is gone is read-only history: hovering says why, in place of its age.
    if (thread.unavailable) slot.append(el('span', 'sb-missing', 'Folder missing'));
    const tile = () => (project ? monogramTile(project.name) : icon('folder', 'sb-tile'));
    if (variant === 'card') {
      const top = el('span', 'sb-line sb-top');
      top.append(tile(), el('span', 'sb-project', project?.name ?? ''), slot);
      const meta = el('span', 'sb-line sb-meta');
      meta.append(providerGlyph(thread.provider), el('span', 'sb-model', model));
      openButton.append(top, el('span', 'sb-title', title), meta);
    } else {
      if (variant === 'slim') openButton.append(tile());
      openButton.append(el('span', 'sb-title', title), slot);
    }
    const actions = el('span', 'sb-actions');
    // No Sleep or Wake for a thread whose folder is gone.
    if (thread.unavailable) actions.hidden = true;
    else if (thread.sleeping) actions.append(action('sun', `Wake: ${title}`, 'wake'));
    else if (!isBusy(thread)) actions.append(action('moon', `Sleep: ${title}`, 'sleep'));
    node.classList.toggle('has-actions', actions.childElementCount > 0);
    node.append(openButton, actions);
    return node;
  });
}
function groupRow(project, threads, expanded) {
  const status = expanded ? null : topStatus(threads.map((thread) => threadStatus(thread, ui.visited[thread.id])));
  return row(`g:${project.id}`, JSON.stringify([project.name, project.path, expanded, status]), () => {
    const node = el('div', `sb-group${expanded ? ' open' : ''}${status ? ` is-${status}` : ''}`);
    node.dataset.project = project.id;
    const head = el('button', 'sb-group-head');
    head.type = 'button';
    head.dataset.nav = 'group';
    head.dataset.action = 'group';
    head.setAttribute('aria-expanded', String(expanded));
    head.title = abbreviatePath(project.path, home());
    const mark = el('span', 'sb-chevron');
    mark.append(icon('chevron-right'));
    if (status) mark.append(el('span', `sb-dot ${status}`));
    head.append(mark, monogramTile(project.name), el('span', 'sb-group-name', project.name));
    const actions = el('span', 'sb-actions');
    actions.append(action('compose', `New thread in ${project.name}`, 'project-new'));
    node.append(head, actions);
    return node;
  });
}
function moreRow(projectId, label, id) {
  const node = el('div', 'sb-more-row');
  if (projectId) node.dataset.project = projectId;
  const button = el('button', 'sb-more', label);
  button.type = 'button';
  button.dataset.nav = id;
  button.dataset.action = id;
  node.append(button);
  return node;
}
function shelf(sleeping, projects) {
  if (!sleeping.length) return [];
  const open = ui.sleepingOpen || Boolean(ui.query.trim());
  const rows = [row('shelf', JSON.stringify([sleeping.length, open]), () => {
    const node = el('div', 'sb-shelf');
    const button = el('button', `sb-shelf-head${open ? ' open' : ''}`);
    button.type = 'button';
    button.dataset.nav = 'shelf';
    button.dataset.action = 'shelf';
    button.setAttribute('aria-expanded', String(open));
    button.append(el('span', '', 'Sleeping'), el('span', 'sb-count', String(sleeping.length)), el('span', 'sb-rule'), icon('chevron-down'));
    node.append(button);
    return node;
  })];
  const current = sleeping.find((thread) => thread.id === ctx.state.session?.id);
  if (!open) return current ? [...rows, threadRow(current, 'slim', projects)] : rows;
  rows.push(...sleeping.slice(0, ui.sleepingShown).map((thread) => threadRow(thread, 'slim', projects)));
  const more = sleeping.length - ui.sleepingShown;
  if (more > 0) rows.push(row('shelf-more', String(more), () => moreRow(null, `${more} more`, 'shelf-more')));
  return rows;
}

/* Header: search, scope, view menu */
function renderScope() {
  const project = projectMap().get(ui.scope);
  const button = $('project-scope');
  const signature = project ? `${project.id}\n${project.name}` : '';
  if (button.dataset.signature === signature && button.childElementCount) return;
  button.dataset.signature = signature;
  button.replaceChildren(project ? monogramTile(project.name) : icon('folder'), el('span', 'sb-scope-label', project?.name ?? 'All projects'), icon('chevron-down', 'sb-scope-chevron'));
}
function setScope(id) {
  ui.scope = id;
  save(KEY.scope, id);
  renderSidebar();
}
function clearSearch() {
  $('thread-search').value = '';
  ui.query = '';
  $('thread-search-clear').hidden = true;
  renderSidebar();
}
function wireHeader() {
  const search = $('thread-search');
  search.addEventListener('input', () => { ui.query = search.value; $('thread-search-clear').hidden = !search.value; renderSidebar(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); clearSearch(); } else if (event.key === 'ArrowDown') { event.preventDefault(); $('session-list').querySelector('[data-nav]')?.focus(); }
  });
  $('thread-search-clear').addEventListener('click', () => { clearSearch(); search.focus(); });
  $('sidebar-toggle').addEventListener('click', () => toggleSidebar());
  $('menu-button')?.addEventListener('click', () => toggleSidebar());
  $('scrim').addEventListener('click', () => $('app').classList.remove('menu-open'));
  // The wordmark goes home (the welcome screen) without reloading the app.
  document.querySelector('.sb-brand').addEventListener('click', (event) => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); $('app').classList.remove('menu-open'); if (ctx.state.session) ctx.deselect(); });
  $('new-session').addEventListener('click', () => newThread());
  $('add-project').addEventListener('click', () => addProject());
  $('project-scope').addEventListener('click', () => (scope && !scope.panel.hidden ? closeScope(true) : openScope()));
  $('project-scope').addEventListener('keydown', (event) => { if (event.key === 'ArrowDown') { event.preventDefault(); openScope(); } });
  $('sidebar-view').addEventListener('click', (event) => openViewMenu(event.currentTarget));
  $('provider-status').addEventListener('click', (event) => { const item = event.target.closest('[data-error]'); if (item) ctx.toast(item.dataset.error); });
}
function openScope() {
  scope ??= buildScope();
  scope.panel.hidden = false;
  $('project-scope').setAttribute('aria-expanded', 'true');
  scope.input.value = '';
  fillScope();
  scope.input.focus();
  document.addEventListener('pointerdown', scopeOutside, true);
}
function closeScope(refocus) {
  if (!scope || scope.panel.hidden) return;
  scope.panel.hidden = true;
  $('project-scope').setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', scopeOutside, true);
  if (refocus) $('project-scope').focus();
}
function scopeOutside(event) {
  if (!scope.panel.contains(event.target) && !$('project-scope').contains(event.target) && !event.target.closest?.('.ctx-menu, dialog')) closeScope(false);
}
function buildScope() {
  const panel = el('div', 'sb-popover');
  panel.id = 'scope-popover';
  const input = el('input', 'sb-popover-search');
  Object.assign(input, { type: 'search', placeholder: 'Search projects', autocomplete: 'off', spellcheck: false });
  input.setAttribute('aria-label', 'Search projects');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'scope-options');
  input.setAttribute('aria-expanded', 'true');
  const list = el('div', 'sb-options');
  list.id = 'scope-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Projects');
  panel.append(input, list);
  $('sidebar-header').append(panel);
  const options = () => [...list.querySelectorAll('[role=option]')];
  input.addEventListener('input', fillScope);
  input.addEventListener('keydown', (event) => {
    const all = options();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); scope.active = (scope.active + (event.key === 'ArrowDown' ? 1 : -1) + all.length) % Math.max(1, all.length); markScope(); }
    else if (event.key === 'Enter') { event.preventDefault(); if (all[scope.active]) chooseScope(all[scope.active].dataset.value || null); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeScope(true); }
    else if (event.key === 'Tab') closeScope(false);
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const gear = event.target.closest('[data-action=settings]');
    if (gear) { closeScope(false); projectSettings(gear.dataset.project); return; }
    const option = event.target.closest('[role=option]');
    if (option) chooseScope(option.dataset.value || null);
  });
  list.addEventListener('pointermove', (event) => {
    const index = options().indexOf(event.target.closest('[role=option]'));
    if (index >= 0 && index !== scope.active) { scope.active = index; markScope(false); }
  });
  list.addEventListener('contextmenu', (event) => {
    const option = event.target.closest('[role=option]');
    if (!option?.dataset.value) return;
    event.preventDefault();
    projectMenu(option.dataset.value, menuPosition(event));
  });
  return { panel, input, list, active: 0 };
}
function scopeOption(project, count) {
  const selected = (project?.id ?? null) === (projectMap().has(ui.scope) ? ui.scope : null);
  const option = el('div', 'sb-option');
  option.setAttribute('role', 'option');
  option.id = `scope-${project?.id ?? 'all'}`;
  option.dataset.value = project?.id ?? '';
  option.setAttribute('aria-selected', String(selected));
  const text = el('span', 'sb-option-text');
  if (project) {
    text.append(el('span', 'sb-option-name', project.name), el('span', 'sb-option-path', abbreviatePath(project.path, home())));
    text.title = project.path;
    const gear = action('settings', `Project settings: ${project.name}`, 'settings');
    gear.dataset.project = project.id;
    option.append(monogramTile(project.name), text, el('span', 'sb-option-count', String(count)), gear);
  } else {
    text.append(el('span', 'sb-option-name', 'All projects'));
    option.append(icon('folder'), text, el('span', 'sb-option-count', String(count)));
  }
  return option;
}
function fillScope() {
  const query = scope.input.value.trim().toLowerCase();
  const counts = new Map();
  const latest = new Map();
  for (const thread of ctx.state.sessions) {
    counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
    if (activityTime(thread) > (latest.get(thread.projectId) ?? '')) latest.set(thread.projectId, activityTime(thread));
  }
  const projects = ctx.state.projects.filter((project) => !query || `${project.name}\n${project.path}`.toLowerCase().includes(query))
    .sort((a, b) => String(latest.get(b.id) ?? '').localeCompare(String(latest.get(a.id) ?? '')) || a.name.localeCompare(b.name));
  const own = projects.filter((project) => !project.sample);
  const samples = projects.filter((project) => project.sample);
  const nodes = [];
  if (!query) nodes.push(scopeOption(null, ctx.state.sessions.length));
  nodes.push(...own.map((project) => scopeOption(project, counts.get(project.id) ?? 0)));
  if (samples.length) nodes.push(el('div', 'sb-divider', 'Samples'), ...samples.map((project) => scopeOption(project, counts.get(project.id) ?? 0)));
  if (!projects.length && query) nodes.push(el('p', 'sb-empty', 'No projects'));
  scope.list.replaceChildren(...nodes);
  const options = [...scope.list.querySelectorAll('[role=option]')];
  scope.active = query ? 0 : Math.max(0, options.findIndex((option) => option.getAttribute('aria-selected') === 'true'));
  markScope();
}
function markScope(scroll = true) {
  const options = [...scope.list.querySelectorAll('[role=option]')];
  options.forEach((option, index) => option.classList.toggle('active', index === scope.active));
  const active = options[scope.active];
  if (active) scope.input.setAttribute('aria-activedescendant', active.id); else scope.input.removeAttribute('aria-activedescendant');
  if (scroll) active?.scrollIntoView({ block: 'nearest' });
}
function chooseScope(id) {
  setScope(id);
  closeScope(true);
}
async function openViewMenu(button) {
  const box = button.getBoundingClientRect();
  const choice = await showMenu([
    { type: 'heading', label: 'View' },
    { id: 'view:flat', label: 'Single list', checked: ui.view === 'flat' },
    { id: 'view:grouped', label: 'Group by project', checked: ui.view === 'grouped' },
    { type: 'separator' },
    { type: 'heading', label: 'Sort' },
    { id: 'sort:activity', label: 'Recent activity', checked: ui.sort === 'activity' },
    { id: 'sort:created', label: 'Created', checked: ui.sort === 'created' },
  ], { x: box.left, y: box.bottom + 4 }, { native: false });
  const [kind, value] = String(choice ?? '').split(':');
  if (kind === 'view') { ui.view = value; save(KEY.view, value); } else if (kind === 'sort') { ui.sort = value; save(KEY.sort, value); } else return;
  renderSidebar();
}

/* The list: clicks, context menus and keys, delegated */
function wireList() {
  const list = $('session-list');
  list.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action], .sb-open');
    if (!target || !list.contains(target)) return;
    const threadId = target.closest('.sb-thread')?.dataset.id;
    const projectId = target.closest('[data-project]')?.dataset.project;
    const kind = target.dataset.action ?? 'open';
    // A double-click renames: its second click must not open the thread again.
    if (kind === 'open') { if (event.detail === 2) startRename(threadId); else if (event.detail < 2) open(threadId); }
    else if (kind === 'sleep' || kind === 'wake') setSleeping(threadId, kind === 'sleep');
    else if (kind === 'group') setGroup(projectId, ui.expanded[projectId] === false);
    else if (kind === 'project-new') newThread(projectId);
    else if (kind === 'more') { if (!ui.showAll.delete(projectId)) ui.showAll.add(projectId); renderSidebar(); }
    else if (kind === 'shelf') { ui.sleepingOpen = !ui.sleepingOpen; ui.sleepingShown = 10; save(KEY.sleeping, ui.sleepingOpen ? 1 : 0); renderSidebar(); }
    else if (kind === 'shelf-more') { ui.sleepingShown += 25; renderSidebar(); }
  });
  list.addEventListener('contextmenu', (event) => {
    const thread = event.target.closest('.sb-thread');
    const group = event.target.closest('.sb-group');
    if (!thread && !group) return;
    event.preventDefault();
    if (thread) threadMenu(thread.dataset.id, menuPosition(event)); else projectMenu(group.dataset.project, menuPosition(event));
  });
  list.addEventListener('keydown', (event) => {
    const items = [...list.querySelectorAll('[data-nav]')];
    const index = items.indexOf(document.activeElement);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    const current = items[index];
    const projectId = current.dataset.nav === 'group' ? current.closest('.sb-group').dataset.project : null;
    if (move !== undefined) { event.preventDefault(); if (move < 0) $('thread-search').focus(); else items[Math.min(move, items.length - 1)].focus(); }
    else if (event.key === 'F2' && current.dataset.nav === 'open') { event.preventDefault(); startRename(current.closest('.sb-thread').dataset.id); }
    else if (projectId && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) { event.preventDefault(); setGroup(projectId, event.key === 'ArrowRight'); }
  });
}
function setGroup(id, expanded) {
  if (expanded) delete ui.expanded[id]; else ui.expanded[id] = false;
  save(KEY.expanded, ui.expanded);
  renderSidebar();
}

/* Collapsing and resizing */
export function toggleSidebar() {
  const app = $('app');
  if (narrow()) { app.classList.toggle('menu-open'); return; }
  save(KEY.collapsed, app.classList.toggle('sidebar-collapsed'));
}
function setWidth(value, persist = true) {
  const max = Math.max(WIDTH.min, innerWidth - WIDTH.main);
  ui.width = Math.round(Math.min(max, Math.max(WIDTH.min, Number(value) || WIDTH.initial)));
  $('app').style.setProperty('--sb-w', `${ui.width}px`);
  $('sidebar-rail').setAttribute('aria-valuenow', String(ui.width));
  if (persist) save(KEY.width, ui.width);
}
function wireRail() {
  const rail = $('sidebar-rail');
  rail.setAttribute('aria-valuemin', String(WIDTH.min));
  rail.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    rail.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, width: ui.width };
    document.body.classList.add('sb-resizing');
    const move = (moveEvent) => setWidth(start.width + moveEvent.clientX - start.x, false);
    const up = () => {
      document.body.classList.remove('sb-resizing');
      rail.removeEventListener('pointermove', move);
      rail.removeEventListener('pointerup', up);
      rail.removeEventListener('pointercancel', up);
      save(KEY.width, ui.width);
    };
    rail.addEventListener('pointermove', move);
    rail.addEventListener('pointerup', up);
    rail.addEventListener('pointercancel', up);
  });
  rail.addEventListener('dblclick', () => setWidth(WIDTH.initial));
  rail.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
    if (step) { event.preventDefault(); setWidth(ui.width + step); }
  });
  window.addEventListener('resize', () => setWidth(load(KEY.width, WIDTH.initial), false));
}

/* Shortcuts and the desktop app's menu commands */
const lastRun = new Map();
/** Runs a menu command; the same command twice within 400 ms runs once (an accelerator and the page shortcut can both fire). */
export function command(name) {
  const now = Date.now();
  if (now - (lastRun.get(name) ?? 0) < 400) return;
  lastRun.set(name, now);
  ({ 'new-thread': () => newThread(), 'add-project': () => addProject(), 'toggle-sidebar': toggleSidebar, 'export-session': exportThread, 'toggle-theme': () => ctx.toggleTheme?.() })[name]?.();
}
function step(delta) { const id = stepThread(threadOrder(), ctx.state.session?.id, delta); if (id) open(id); }
/** Global keys: Mod+B sidebar, Mod+N (or N outside text fields) new thread, Mod+Shift+[ / ] previous/next thread, Mod+1…9 jump. */
export function handleShortcut(event) {
  if (event.defaultPrevented || event.isComposing || event.altKey) return;
  const key = event.key.toLowerCase();
  if (mod(event) && !event.shiftKey && key === 'b') { event.preventDefault(); command('toggle-sidebar'); }
  else if (mod(event) && !event.shiftKey && key === 'n') { event.preventDefault(); command('new-thread'); }
  else if (mod(event) && event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) { event.preventDefault(); step(event.code === 'BracketLeft' ? -1 : 1); }
  else if (mod(event) && !event.shiftKey && /^[1-9]$/.test(event.key)) { event.preventDefault(); open(threadOrder()[Number(event.key) - 1]); }
  else if (key === 'n' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !typing(event.target) && !document.querySelector('dialog[open]')) { event.preventDefault(); newThread(); }
  else if (event.key === 'Escape' && $('app').classList.contains('menu-open')) $('app').classList.remove('menu-open');
}

/* Footer and welcome screen */
export function renderProviders(config) {
  const box = $('provider-status');
  if (!config) { box.replaceChildren(el('span', 'sb-provider off', 'Disconnected')); return; }
  box.replaceChildren(...(config.providers ?? []).map((provider) => {
    if (provider.available) {
      const item = el('span', 'sb-provider ok', provider.label);
      item.title = [provider.label, provider.version].filter(Boolean).join(' ');
      return item;
    }
    const item = el('button', 'sb-provider off', provider.label);
    item.type = 'button';
    item.title = provider.error || `${provider.label} is unavailable`;
    item.dataset.error = item.title;
    item.setAttribute('aria-label', `${provider.label} unavailable: ${item.title}`);
    return item;
  }));
}
function wordmark() {
  const frame = el('div', 'welcome-wordmark wordmark');
  for (const [className, src, alt] of [['wordmark-light', '/shout-wordmark.png', 'SHOUT!'], ['wordmark-dark', '/shout-wordmark-dark.png', '']]) {
    const image = el('img', className);
    Object.assign(image, { src, alt, width: 1983, height: 793 });
    frame.append(image);
  }
  return frame;
}
/** No thread open: the wordmark, Add project (and New thread) and the samples. An empty thread: its project. */
export function renderWelcome() {
  const wrapper = el('div', 'welcome');
  if (!ctx) return wrapper;
  const { state } = ctx;
  if (state.session) {
    const project = projectMap().get(state.session.projectId);
    wrapper.classList.add('thread-start');
    if (project) {
      const chip = el('div', 'welcome-project');
      chip.append(monogramTile(project.name), el('span', 'welcome-project-name', project.name), el('span', 'welcome-project-path', abbreviatePath(project.path, home())));
      wrapper.append(chip);
    }
    return wrapper;
  }
  const actions = el('div', 'welcome-actions');
  const addButton = el('button', 'primary-button');
  addButton.type = 'button';
  addButton.append(icon('folder-plus'), 'Add project');
  addButton.addEventListener('click', () => addProject());
  const next = el('button', 'secondary-button welcome-new');
  next.type = 'button';
  next.append(icon('compose'), 'New thread');
  next.addEventListener('click', () => newThread());
  actions.append(addButton, next);
  wrapper.append(wordmark(), actions);
  const scenarios = state.config?.scenarios ?? [];
  if (scenarios.length) {
    const list = el('ul', 'welcome-samples');
    list.setAttribute('aria-label', 'Samples');
    for (const scenario of scenarios) {
      const item = el('li');
      const button = el('button', 'welcome-sample');
      button.type = 'button';
      button.append(el('span', '', scenario.title), icon('chevron-right'));
      button.addEventListener('click', () => startSample(scenario.id));
      item.append(button);
      list.append(item);
    }
    wrapper.append(list);
  }
  return wrapper;
}
