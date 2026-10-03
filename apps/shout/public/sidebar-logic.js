// Pure sidebar logic: thread status, times, project monograms, filtering, grouping and notifications.
// No DOM and no storage, so it runs under node:test as well as in the page.
export const STATUS = { working: 'Working', approval: 'Approval', input: 'Input', failed: 'Failed', done: 'Done' };
const PRIORITY = ['approval', 'input', 'working', 'failed', 'done'];
const WORKING = new Set(['starting', 'thinking', 'running', 'waiting_user', 'resuming', 'suspended']);
const FINISHED = new Set(['completed', 'idle']);
// Project monogram colours (Tailwind hues): 700 on light backgrounds, 400 on dark ones.
export const PALETTE = [
  ['#364153', '#99a1af'], ['#c10007', '#ff6467'], ['#ca3500', '#ff8904'], ['#bb4d00', '#ffb900'], ['#a65f00', '#fdc700'], ['#497d00', '#9ae600'],
  ['#008236', '#05df72'], ['#007a55', '#00d492'], ['#00786f', '#00d5be'], ['#007595', '#00d3f2'], ['#0069a8', '#00bcff'], ['#1447e6', '#51a2ff'],
  ['#432dd7', '#7c86ff'], ['#7008e7', '#a684ff'], ['#8200db', '#c27aff'], ['#a800b7', '#ed6aff'], ['#c6005c', '#fb64b6'], ['#c70036', '#ff637e'],
];

const normalize = (name) => String(name ?? '').normalize('NFKC').trim();
/** Two letters for a project: the first letter, then a digit from the first word, else the last word's initial, else the word's last letter. */
export function monogram(name) {
  const words = normalize(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = words[0];
  if (!first) return 'PR';
  const glyphs = Array.from(first);
  const second = glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ?? (words.length > 1 ? Array.from(words.at(-1))[0] : glyphs.at(-1)) ?? glyphs[0];
  return Array.from(`${glyphs[0]}${second}`.toUpperCase()).slice(0, 2).join('');
}
/** [light, dark] colours for a project's monogram, hashed from its name. */
export function monogramColor(name) {
  let index = 0;
  for (const glyph of normalize(name).toLocaleLowerCase('en-US') || 'project') index = (index * 31 + glyph.codePointAt(0)) % PALETTE.length;
  return PALETTE[index];
}

/** Compact age: "now", "5m", "3h", "2d", "3w", "4mo", "2y". */
export function relativeTime(value, now = Date.now()) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
/** When a thread last had activity: its last message, else when it was made. */
export const activityTime = (thread) => thread.lastMessageAt || thread.createdAt || thread.updatedAt || '';
export const isBusy = (thread) => WORKING.has(thread.status) || Boolean(thread.attention);

/** A thread finished (or was interrupted) after the user last looked at it. Never-visited threads are not unseen. */
export function unseen(thread, visitedAt) {
  if (!visitedAt || !thread.messageCount || !thread.lastMessageAt) return false;
  if (!FINISHED.has(thread.status) && thread.status !== 'interrupted') return false;
  const visited = Date.parse(visitedAt);
  return Number.isNaN(visited) || Date.parse(thread.lastMessageAt) > visited;
}
/** The state worth a label, or null: approval, input, working, failed, done (unseen completion). */
export function threadStatus(thread, visitedAt) {
  if (thread.attention === 'approval') return 'approval';
  if (thread.attention === 'ask') return 'input';
  if (WORKING.has(thread.status)) return 'working';
  if (thread.status === 'failed') return 'failed';
  if (unseen(thread, visitedAt)) return thread.status === 'interrupted' ? 'failed' : 'done';
  return null;
}
/** The most urgent of several statuses. */
export const topStatus = (statuses) => PRIORITY.find((status) => statuses.includes(status)) ?? null;

/** A sidebar summary from a full thread snapshot (summaries pass through), matching the server's summary(). */
export function summarize(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.messages)) return snapshot;
  const { id, title, projectId = null, workspace, status, question, createdAt, updatedAt, sleeping = false, model, effort, provider, modelLocked, messages, runs = [], unavailable = false, timeBudgetsEnabled } = snapshot;
  const attention = status === 'waiting_user' && question ? (question.kind === 'approval' ? 'approval' : 'ask') : null;
  return { id, title, projectId, workspace, status, attention, sleeping, model, effort, provider, modelLocked, createdAt, updatedAt, lastMessageAt: messages.at(-1)?.time ?? null, messageCount: messages.length, runCount: runs.length, unavailable, timeBudgetsEnabled };
}

const byTime = (key) => (a, b) => String(key(b)).localeCompare(String(key(a))) || String(a.id).localeCompare(String(b.id));
export function sortThreads(threads, sort = 'activity') {
  return [...threads].sort(byTime(sort === 'created' ? (thread) => thread.createdAt || '' : activityTime));
}
/** Every word of the query appears in the thread's title or its project's name. */
export function matches(thread, project, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${thread.title ?? ''}\n${project?.name ?? ''}`.toLowerCase();
  return words.every((word) => text.includes(word));
}
/** Sleeping threads, and threads whose folder is gone (read-only history), go on the Sleeping shelf. */
export const shelved = (thread) => Boolean(thread.sleeping || thread.unavailable);
/** Threads in scope (a project id or null for all) that match the query, split into awake and shelved, each sorted. */
export function visibleThreads(threads, projects, { scope = null, query = '', sort = 'activity' } = {}) {
  const shown = threads.filter((thread) => (!scope || thread.projectId === scope) && matches(thread, projects.get(thread.projectId), query));
  return { awake: sortThreads(shown.filter((thread) => !shelved(thread)), sort), sleeping: sortThreads(shown.filter(shelved), 'activity') };
}
/** Projects with their (already filtered and sorted) threads, most recently active first; a search hides projects without matches unless the name matches. */
export function groupThreads(threads, projects, { scope = null, query = '' } = {}) {
  const groups = [...projects.values()].filter((project) => !scope || project.id === scope).map((project) => ({ project, threads: threads.filter((thread) => thread.projectId === project.id) }));
  const latest = (group) => group.threads.reduce((max, thread) => (activityTime(thread) > max ? activityTime(thread) : max), '');
  return groups.filter((group) => !query.trim() || group.threads.length || matches({}, group.project, query))
    .sort((a, b) => latest(b).localeCompare(latest(a)) || String(a.project.name).localeCompare(String(b.project.name)));
}
/** The first `cap` threads (all when `all`), keeping the open thread visible; `hidden` counts the rest. */
export function capThreads(threads, { cap = 6, all = false, openId = null } = {}) {
  if (all || threads.length <= cap) return { shown: threads, hidden: 0 };
  const shown = threads.slice(0, cap);
  const open = threads.find((thread) => thread.id === openId);
  if (open && !shown.includes(open)) shown.push(open);
  return { shown, hidden: threads.length - shown.length };
}
/** The project a new thread goes to when none is named: the most recently active one, preferring the user's own over samples. */
export function recentProject(projects, threads) {
  const latest = new Map();
  for (const thread of threads) if (activityTime(thread) > (latest.get(thread.projectId) ?? '')) latest.set(thread.projectId, activityTime(thread));
  const rank = (project) => latest.get(project.id) ?? project.updatedAt ?? project.createdAt ?? '';
  return [...projects].sort((a, b) => Number(Boolean(a.sample)) - Number(Boolean(b.sample)) || String(rank(b)).localeCompare(String(rank(a))))[0] ?? null;
}

/** `~` for the home folder. */
export function abbreviatePath(path, home) {
  if (!path || !home || home === '/') return path ?? '';
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
/** A typed folder path split for browsing: the folder to list and the name prefix typed after its last slash. */
export function splitPath(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '~') return { dir: '~', prefix: '' };
  const cut = text.lastIndexOf('/');
  if (cut < 0) return { dir: '', prefix: text };
  return { dir: text.slice(0, cut) || '/', prefix: text.slice(cut + 1) };
}
/** The id `delta` places from `current` in `ids`, stopping at the ends; from nothing, the first (or last). */
export function stepThread(ids, current, delta) {
  if (!ids.length) return null;
  const index = ids.indexOf(current);
  if (index < 0) return delta < 0 ? ids.at(-1) : ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
}
export const attentionCount = (threads) => threads.filter((thread) => thread.attention).length;

/** Where the user is: the open thread and app.js's selection counter, which every open or close (even one still loading) bumps. */
export const navigation = (state) => ({ selection: state.selection ?? 0, open: state.session?.id ?? null });
/** An action that started at `before` may still move the user only if they have opened or closed nothing since. */
export const stillHere = (before, after) => before.selection === after.selection && before.open === after.open;
/** After deleting a thread: open `next` (or close) only if the user is still on the deleted thread and hasn't moved; else stay. */
export function afterDelete({ deleted, next, before, after }) {
  if (!stillHere(before, after) || after.open !== deleted) return null;
  return next && next !== deleted ? { open: next } : { deselect: true };
}

/**
 * Notifications for changes between two thread lists: newly needing approval or input, or a task that finished or failed.
 * `visibleId` is the thread the user is looking at (open in a focused window); it is never notified about.
 */
export function notices(previous, threads, visibleId = null) {
  const out = [];
  for (const thread of threads) {
    const before = previous.get(thread.id);
    if (!before || thread.id === visibleId) continue;
    let body = null;
    if (thread.attention && thread.attention !== before.attention) body = thread.attention === 'approval' ? 'Needs approval' : 'Needs input';
    else if (WORKING.has(before.status) && !WORKING.has(thread.status)) body = thread.status === 'failed' ? 'Failed' : FINISHED.has(thread.status) ? 'Finished' : null;
    if (body) out.push({ id: thread.id, title: thread.title || 'Untitled thread', body });
  }
  return out;
}
