// Projects: adding one (the native folder chooser in the desktop app, a server-side folder browser otherwise),
// the settings dialog, removal and the project context menu.
import * as shell from './desktop.js';
import { el, icon, iconButton, copyText } from './dom.js';
import { showMenu, confirmAction } from './menu.js';
import { abbreviatePath, splitPath, navigation } from './sidebar-logic.js';

const $ = (id) => document.getElementById(id);
// ctx: { state, api, toast, deselect(), render(), newThread(projectId), openProject(project, existing, before), renameProject?(id) }
let ctx;
let add = null;
let settings = null;
export function initProjects(context) { ctx = context; }

// The desktop app can use native folders only when the server runs on the same computer.
const flag = (value) => (typeof value === 'function' ? value() : value);
export const canPickFolder = () => flag(shell.canPickFolder) ?? (shell.isDesktop && shell.desktop.remote !== true);
export const canRevealPath = () => flag(shell.canRevealPath) ?? (shell.isDesktop && shell.desktop.remote !== true);
const find = (id) => ctx.state.projects.find((project) => project.id === id) ?? null;
export function upsertProject(project) {
  const { existing: _existing, ...info } = project;
  const index = ctx.state.projects.findIndex((item) => item.id === info.id);
  if (index >= 0) ctx.state.projects[index] = { ...ctx.state.projects[index], ...info }; else ctx.state.projects.push(info);
}

/** Asks whether to create a missing folder (the static #create-folder-dialog); resolves true to create it. */
export function confirmFolder(path) {
  const dialog = $('create-folder-dialog');
  $('create-folder-path').textContent = path;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'create'), { once: true });
    dialog.showModal();
    $('create-folder-confirm').focus();
  });
}

/** The project for a folder, added unless it exists (`existing`); a missing folder is offered for creation. Null when declined. */
async function register(path, createWorkspace = false) {
  try {
    return await ctx.api('/projects', { method: 'POST', body: { path, ...(createWorkspace ? { createWorkspace } : {}) } });
  } catch (error) {
    if (error.code === 'workspace_missing' && !createWorkspace) return (await confirmFolder(error.path)) ? register(path, true) : null;
    throw error;
  }
}
// A new project gets a new thread; an existing one opens its latest thread; neither if the user moved since `before`.
async function open(project, before) {
  upsertProject(project);
  ctx.render();
  await ctx.openProject(find(project.id) ?? project, Boolean(project.existing), before);
}
export async function addProject() {
  if (!canPickFolder()) return openAddDialog();
  const path = await shell.pickFolder({ title: 'Add project', ...(ctx.state.config?.home ? { defaultPath: ctx.state.config.home } : {}) }).catch(() => null);
  if (!path) return;
  const before = navigation(ctx.state);
  try { const project = await register(path); if (project) await open(project, before); } catch (error) { ctx.toast(error.message); }
}

/* Browser: a typed path with a folder list under it. */
function buildAddDialog() {
  const dialog = el('dialog', 'project-dialog');
  dialog.id = 'add-project-dialog';
  dialog.setAttribute('aria-labelledby', 'add-project-title');
  const form = el('form');
  const heading = el('div', 'dialog-heading');
  const title = el('h2', '', 'Add project');
  title.id = 'add-project-title';
  const close = iconButton('x', 'Close', 'icon-button');
  heading.append(title, close);
  const label = el('label', '', 'Workspace path');
  label.htmlFor = 'workspace-input';
  const field = el('div', 'path-field');
  const parent = iconButton('up', 'Parent folder', 'icon-button');
  const input = el('input');
  Object.assign(input, { id: 'workspace-input', autocomplete: 'off', spellcheck: false });
  input.setAttribute('aria-controls', 'dir-list');
  field.append(input, parent);
  const list = el('div', 'dir-list');
  list.id = 'dir-list';
  list.setAttribute('aria-label', 'Folders');
  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const footer = el('div', 'dialog-footer');
  const cancel = el('button', 'secondary-button', 'Cancel');
  cancel.type = 'button';
  const confirm = el('button', 'primary-button', 'Add');
  confirm.type = 'submit';
  footer.append(cancel, confirm);
  form.append(heading, label, field, list, error, footer);
  dialog.append(form);
  document.body.append(dialog);
  const state = { dialog, input, list, error, confirm, parent, listing: null, token: 0, timer: 0, cache: new Map() };
  const go = (path) => { input.value = path.endsWith('/') ? path : `${path}/`; browse(); input.focus(); };
  close.addEventListener('click', () => dialog.close());
  cancel.addEventListener('click', () => dialog.close());
  parent.addEventListener('click', () => state.listing?.parent && go(state.listing.parent));
  input.addEventListener('input', () => { clearTimeout(state.timer); state.timer = setTimeout(browse, 90); });
  input.addEventListener('keydown', (event) => {
    const first = list.querySelector('.dir-item');
    if (event.key === 'Tab' && !event.shiftKey && splitPath(input.value).prefix && first) { event.preventDefault(); go(first.dataset.path); }
    else if (event.key === 'ArrowDown' && first) { event.preventDefault(); first.focus(); }
  });
  list.addEventListener('click', (event) => { const item = event.target.closest('.dir-item'); if (item) go(item.dataset.path); });
  list.addEventListener('keydown', (event) => {
    const items = [...list.querySelectorAll('.dir-item')];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') items[Math.min(items.length - 1, index + 1)]?.focus();
    else if (event.key === 'ArrowUp') (index > 0 ? items[index - 1] : input).focus();
    else return;
    event.preventDefault();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim().replace(/(.)\/+$/, '$1');
    if (!value) return input.focus();
    confirm.disabled = true;
    error.hidden = true;
    let project = null;
    const before = navigation(ctx.state);
    try { project = await register(value); } catch (failure) { error.textContent = failure.message; error.hidden = false; } finally { confirm.disabled = false; }
    if (!project) return;
    dialog.close();
    await open(project, before);
  });
  return state;
}
function listDirs(path) {
  if (!add.cache.has(path)) add.cache.set(path, ctx.api(`/fs/dirs?path=${encodeURIComponent(path)}`).catch((error) => { add.cache.delete(path); throw error; }));
  return add.cache.get(path);
}
async function browse() {
  const value = add.input.value.trim();
  const { dir, prefix } = splitPath(value);
  const token = ++add.token;
  const [listing, target] = await Promise.all([dir ? listDirs(dir).catch(() => null) : null, prefix && dir ? listDirs(value).catch(() => null) : null]);
  if (token !== add.token) return;
  add.listing = listing;
  const exists = prefix ? target?.exists : listing?.exists;
  add.confirm.textContent = value && exists === false ? 'Create & add' : 'Add';
  add.parent.disabled = !listing?.parent;
  const wanted = prefix.toLowerCase();
  const dirs = (listing?.dirs ?? []).filter((item) => item.name.toLowerCase().startsWith(wanted)).slice(0, 300);
  add.list.replaceChildren(...dirs.map((item) => {
    const button = el('button', 'dir-item');
    button.type = 'button';
    button.dataset.path = item.path;
    button.append(icon('folder'), el('span', '', item.name));
    return button;
  }));
  add.list.hidden = !dirs.length;
}
function openAddDialog() {
  add ??= buildAddDialog();
  add.cache.clear();
  add.error.hidden = true;
  const home = ctx.state.config?.home;
  add.input.value = home ? `${home.replace(/\/$/, '')}/` : '/';
  add.dialog.showModal();
  add.input.focus();
  add.input.setSelectionRange(add.input.value.length, add.input.value.length);
  browse();
}

/* Settings: name, test command, default model, folder; removal. */
function buildSettingsDialog() {
  const dialog = el('dialog', 'project-dialog');
  dialog.id = 'project-dialog';
  dialog.setAttribute('aria-labelledby', 'project-dialog-title');
  const form = el('form');
  const heading = el('div', 'dialog-heading');
  const title = el('h2', '', 'Project settings');
  title.id = 'project-dialog-title';
  const close = iconButton('x', 'Close', 'icon-button');
  heading.append(title, close);
  const field = (id, text, control) => { const label = el('label', '', text); label.htmlFor = id; control.id = id; return [label, control]; };
  const name = el('input');
  name.autocomplete = 'off';
  const test = el('input', 'mono');
  Object.assign(test, { autocomplete: 'off', spellcheck: false, placeholder: 'npm test' });
  const model = el('select');
  const effort = el('select');
  effort.setAttribute('aria-label', 'Default effort');
  const models = el('div', 'model-fields');
  models.append(model, effort);
  const folder = el('div', 'folder-field');
  const path = el('code', 'folder-path');
  const reveal = el('button', 'secondary-button', 'Reveal');
  reveal.type = 'button';
  folder.append(path, reveal);
  const folderLabel = el('div', 'field-label', 'Folder');
  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const footer = el('div', 'dialog-footer');
  const remove = el('button', 'danger-text-button', 'Remove project');
  remove.type = 'button';
  const cancel = el('button', 'secondary-button', 'Cancel');
  cancel.type = 'button';
  const save = el('button', 'primary-button', 'Save');
  save.type = 'submit';
  footer.append(remove, cancel, save);
  const modelLabel = el('label', '', 'Default model');
  modelLabel.htmlFor = 'project-model';
  model.id = 'project-model';
  form.append(heading, ...field('project-name', 'Name', name), ...field('project-test', 'Test command', test), modelLabel, models, folderLabel, folder, error, footer);
  dialog.append(form);
  document.body.append(dialog);
  const state = { dialog, name, test, model, effort, path, reveal, error, save, id: null };
  const fillEfforts = (choice) => {
    const info = ctx.state.config?.models?.find((item) => item.id === model.value);
    effort.hidden = !info;
    effort.replaceChildren(...(info?.efforts ?? []).map((item) => new Option(({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[item] || item, item)));
    if (info) effort.value = info.efforts.includes(choice) ? choice : info.efforts.includes(ctx.state.config.defaultModel?.effort) ? ctx.state.config.defaultModel.effort : info.efforts[0];
  };
  state.fillEfforts = fillEfforts;
  model.addEventListener('change', () => fillEfforts(effort.value));
  close.addEventListener('click', () => dialog.close());
  cancel.addEventListener('click', () => dialog.close());
  reveal.addEventListener('click', () => shell.revealPath(find(state.id)?.path).catch((failure) => ctx.toast(failure.message)));
  remove.addEventListener('click', async () => { if (await removeProject(state.id)) dialog.close(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    error.hidden = true;
    try {
      const body = { name: name.value, testCommand: test.value, defaultModel: model.value ? { model: model.value, effort: effort.value } : null };
      upsertProject(await ctx.api(`/projects/${encodeURIComponent(state.id)}`, { method: 'POST', body }));
      ctx.render();
      dialog.close();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; } finally { save.disabled = false; }
  });
  return state;
}
export function projectSettings(id, { rename = false } = {}) {
  const project = find(id);
  if (!project) return;
  settings ??= buildSettingsDialog();
  const { config } = ctx.state;
  settings.id = id;
  settings.error.hidden = true;
  settings.name.value = project.name;
  settings.test.value = project.testCommand ?? '';
  const fallback = config?.models?.find((item) => item.id === config.defaultModel?.model);
  settings.model.replaceChildren(new Option(fallback ? `Default (${fallback.label})` : 'Default', ''), ...(config?.providers ?? []).map((provider) => {
    const group = el('optgroup');
    group.label = provider.label;
    group.append(...config.models.filter((item) => item.provider === provider.id).map((item) => new Option(item.label, item.id)));
    return group;
  }));
  settings.model.value = project.defaultModel?.model ?? '';
  settings.fillEfforts(project.defaultModel?.effort);
  settings.path.textContent = abbreviatePath(project.path, config?.home);
  settings.path.title = project.path;
  settings.reveal.hidden = !canRevealPath();
  settings.dialog.showModal();
  settings.name.focus();
  if (rename) settings.name.select();
}

/** Confirms, then removes the project and its threads' histories. Resolves true when removed. */
export async function removeProject(id) {
  const project = find(id);
  if (!project) return false;
  const count = ctx.state.sessions.filter((thread) => thread.projectId === id).length;
  const ok = await confirmAction({
    title: `Remove ${project.name}?`,
    lines: [{ code: project.path }, `${count ? `Deletes its ${count} thread${count === 1 ? '' : 's'}. ` : ''}${project.sample ? 'The sample’s scratch copy is deleted too.' : 'The folder’s files are not touched.'}`],
    confirm: 'Remove',
    destructive: true,
  });
  if (!ok) return false;
  try { await ctx.api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (error) { ctx.toast(error.message); return false; }
  ctx.state.projects = ctx.state.projects.filter((item) => item.id !== id);
  ctx.state.sessions = ctx.state.sessions.filter((thread) => thread.projectId !== id);
  if (ctx.state.session?.projectId === id) ctx.deselect();
  ctx.render();
  return true;
}

/** The project context menu: from the scope list and group headers. */
export async function projectMenu(id, position) {
  const project = find(id);
  if (!project) return;
  const choice = await showMenu([
    { id: 'new-thread', label: 'New thread' },
    { id: 'rename', label: 'Rename' },
    { type: 'separator' },
    { id: 'copy-path', label: 'Copy path' },
    ...(canRevealPath() ? [{ id: 'reveal', label: 'Reveal in file manager' }] : []),
    { id: 'settings', label: 'Project settings' },
    { type: 'separator' },
    { id: 'remove', label: 'Remove', destructive: true },
  ], position);
  if (choice === 'new-thread') ctx.newThread(id);
  else if (choice === 'rename') { if (!ctx.renameProject?.(id)) projectSettings(id, { rename: true }); }
  else if (choice === 'copy-path') ctx.toast((await copyText(project.path)) ? 'Path copied' : project.path);
  else if (choice === 'reveal') shell.revealPath(project.path).catch((error) => ctx.toast(error.message));
  else if (choice === 'settings') projectSettings(id);
  else if (choice === 'remove') removeProject(id);
}
