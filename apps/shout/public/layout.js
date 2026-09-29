// Tab/split layout tree for a session's dock. Pure data operations; rendering lives in app.js.
// A node is either { type: 'group', id, tabs: [tabId], active } or { type: 'split', id, dir: 'row' | 'col', children, sizes }.
export const CHAT = 'chat';
const TAB_KINDS = new Set(['chat', 'file', 'viz', 'program', 'skill', 'agent']);
const VIEWS = new Set(['trace', 'changes']);
let counter = 0;
export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

function group(tabs = []) { return { type: 'group', id: uid('g'), tabs: [...tabs], active: tabs[0] ?? null }; }
export function createLayout() {
  const root = group([CHAT]);
  return { root, tabs: { [CHAT]: { id: CHAT, kind: 'chat' } }, focus: root.id };
}
export function groups(node, out = []) {
  if (node.type === 'group') out.push(node);
  else for (const child of node.children) groups(child, out);
  return out;
}
export const findGroup = (layout, id) => groups(layout.root).find((candidate) => candidate.id === id);
export const groupOfTab = (layout, tabId) => groups(layout.root).find((candidate) => candidate.tabs.includes(tabId));
export const focusedGroup = (layout) => findGroup(layout, layout.focus) || groups(layout.root)[0];
function parentOf(node, id) {
  if (node.type !== 'split') return null;
  for (const child of node.children) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}
function detach(layout, tabId) {
  const owner = groupOfTab(layout, tabId);
  if (!owner) return;
  const index = owner.tabs.indexOf(tabId);
  owner.tabs.splice(index, 1);
  if (owner.active === tabId) owner.active = owner.tabs[Math.min(index, owner.tabs.length - 1)] ?? null;
}
export function activate(layout, tabId) {
  const owner = groupOfTab(layout, tabId);
  if (!owner) return false;
  owner.active = tabId;
  layout.focus = owner.id;
  return true;
}
export function addTab(layout, tab, groupId = layout.focus, index) {
  layout.tabs[tab.id] = tab;
  const target = findGroup(layout, groupId) || focusedGroup(layout);
  detach(layout, tab.id);
  target.tabs.splice(index ?? target.tabs.length, 0, tab.id);
  target.active = tab.id;
  layout.focus = target.id;
  return normalize(layout);
}
export function moveTab(layout, tabId, groupId, index) {
  const target = findGroup(layout, groupId);
  if (!target || !layout.tabs[tabId]) return layout;
  const from = target.tabs.indexOf(tabId);
  if (from >= 0 && index !== undefined && from < index) index--;
  detach(layout, tabId);
  target.tabs.splice(Math.min(index ?? target.tabs.length, target.tabs.length), 0, tabId);
  target.active = tabId;
  layout.focus = target.id;
  return normalize(layout);
}
export function closeTab(layout, tabId) {
  if (tabId === CHAT || !layout.tabs[tabId]) return false;
  detach(layout, tabId);
  delete layout.tabs[tabId];
  normalize(layout);
  return true;
}
// Place a tab in a new group beside `targetGroupId`. The tab moves if it already belongs to a group.
export function splitWith(layout, tabId, targetGroupId, side = 'right') {
  const target = findGroup(layout, targetGroupId);
  if (!target || !layout.tabs[tabId]) return layout;
  if (target.tabs.length === 1 && target.tabs[0] === tabId) return layout;
  detach(layout, tabId);
  const created = group([tabId]);
  const dir = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  const parent = parentOf(layout.root, target.id);
  if (parent && parent.dir === dir) {
    const index = parent.children.indexOf(target);
    const half = parent.sizes[index] / 2;
    parent.sizes[index] = half;
    parent.children.splice(before ? index : index + 1, 0, created);
    parent.sizes.splice(before ? index : index + 1, 0, half);
  } else {
    const split = { type: 'split', id: uid('s'), dir, children: before ? [created, target] : [target, created], sizes: [1, 1] };
    if (parent) parent.children[parent.children.indexOf(target)] = split;
    else layout.root = split;
  }
  layout.focus = created.id;
  return normalize(layout);
}
function clean(node) {
  if (node.type === 'group') return node.tabs.length ? node : null;
  const children = [];
  const sizes = [];
  node.children.forEach((child, index) => {
    const kept = clean(child);
    if (!kept) return;
    const size = node.sizes[index] > 0 ? node.sizes[index] : 1;
    if (kept.type === 'split' && kept.dir === node.dir) {
      const total = kept.sizes.reduce((sum, value) => sum + value, 0) || 1;
      kept.children.forEach((grandchild, j) => { children.push(grandchild); sizes.push(size * kept.sizes[j] / total); });
    } else { children.push(kept); sizes.push(size); }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  node.children = children;
  node.sizes = sizes;
  return node;
}
export function normalize(layout) {
  layout.root = clean(layout.root) || group([]);
  const all = groups(layout.root);
  const placed = new Set(all.flatMap((candidate) => candidate.tabs));
  for (const id of Object.keys(layout.tabs)) if (!placed.has(id)) delete layout.tabs[id];
  if (!layout.tabs[CHAT]) {
    layout.tabs[CHAT] = { id: CHAT, kind: 'chat' };
    all[0].tabs.unshift(CHAT);
    all[0].active ??= CHAT;
  }
  for (const candidate of all) if (!candidate.tabs.includes(candidate.active)) candidate.active = candidate.tabs[0];
  if (!all.some((candidate) => candidate.id === layout.focus)) layout.focus = all[0].id;
  return layout;
}
export function resize(split, index, fraction) {
  // Moves the boundary before child `index`, keeping the pair's combined size.
  const pair = split.sizes[index - 1] + split.sizes[index];
  const left = Math.min(Math.max(fraction, 0.12), 0.88) * pair;
  split.sizes[index - 1] = left;
  split.sizes[index] = pair - left;
}
export function serialize(layout) {
  const tabs = Object.fromEntries(Object.values(layout.tabs).map(({ id, kind, path, view, run, name, agent }) => [id, { id, kind, path, view, run, name, agent }]));
  return JSON.stringify({ root: layout.root, tabs, focus: layout.focus });
}
function validNode(node, seen) {
  if (!node || typeof node !== 'object' || typeof node.id !== 'string') return false;
  if (node.type === 'group') return Array.isArray(node.tabs) && node.tabs.every((id) => typeof id === 'string' && !seen.has(id) && seen.add(id));
  return node.type === 'split' && ['row', 'col'].includes(node.dir) && Array.isArray(node.children) && Array.isArray(node.sizes)
    && node.children.length === node.sizes.length && node.sizes.every((size) => Number.isFinite(size)) && node.children.every((child) => validNode(child, seen));
}
export function restore(text) {
  try {
    const raw = JSON.parse(text);
    if (!raw || !validNode(raw.root, new Set())) return createLayout();
    const tabs = {};
    for (const [id, tab] of Object.entries(raw.tabs || {})) {
      if (tab?.id !== id || !TAB_KINDS.has(tab.kind) || (tab.kind === 'chat') !== (id === CHAT)) continue;
      if (tab.kind === 'file' && typeof tab.path !== 'string') continue;
      if (tab.kind === 'viz' && !VIEWS.has(tab.view)) continue;
      if (tab.kind === 'skill' && typeof tab.name !== 'string') continue;
      if (tab.kind === 'agent' && typeof tab.agent !== 'string') continue;
      tabs[id] = { id, kind: tab.kind, ...(tab.kind === 'file' ? { path: tab.path } : {}), ...(tab.kind === 'viz' ? { view: tab.view } : {}), ...(tab.kind === 'program' ? { run: typeof tab.run === 'string' ? tab.run : '' } : {}), ...(tab.kind === 'skill' ? { name: tab.name } : {}), ...(tab.kind === 'agent' ? { agent: tab.agent } : {}) };
    }
    const layout = { root: raw.root, tabs, focus: raw.focus };
    for (const candidate of groups(layout.root)) candidate.tabs = candidate.tabs.filter((id) => tabs[id]);
    return normalize(layout);
  } catch { return createLayout(); }
}
