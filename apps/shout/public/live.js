// Live list state and getting the user's attention. One EventSource on /api/stream brings projects and thread
// summaries after every list-level change; the attention watcher turns changes into notifications, a badge count
// and a flashing window in the desktop app (in a browser those are no-ops, or a Web Notification if already allowed).
import * as shell from './desktop.js';
import { notices, attentionCount } from './sidebar-logic.js';

/** Calls onState({ projects, sessions }) on connect and after each change; reconnects with backoff (1 s doubling to 30 s). */
export function connectLists(onState, { onStatus = () => {} } = {}) {
  let source = null, timer = 0, delay = 1000, closed = false;
  const connect = () => {
    source = new EventSource('/api/stream');
    source.addEventListener('state', (event) => {
      delay = 1000;
      onStatus(true);
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      onState(data);
    });
    source.onerror = () => {
      if (closed) return;
      source.close();
      onStatus(false);
      clearTimeout(timer);
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30000);
    };
  };
  connect();
  return () => { closed = true; clearTimeout(timer); source?.close(); };
}

/** Returns update(threads, openId): call it with every new thread list. The first call only records the state. */
export function watchAttention() {
  let previous = null, count = 0, badge = -1, flashing = null;
  const focused = () => document.visibilityState === 'visible' && document.hasFocus();
  const push = () => {
    if (count !== badge) { badge = count; shell.setBadgeCount(count).catch(() => {}); }
    const flash = count > 0 && !focused();
    if (flash !== flashing) { flashing = flash; shell.setAttention(flash).catch(() => {}); }
  };
  // The shell clears the badge and flashing when the window gains focus; they come back when it loses it.
  window.addEventListener('focus', () => { badge = -1; flashing = false; });
  window.addEventListener('blur', () => { badge = -1; push(); });
  return function update(threads, openId) {
    if (previous) for (const notice of notices(previous, threads, focused() ? openId : null)) shell.notify({ title: notice.title, body: notice.body, sessionId: notice.id }).catch(() => {});
    previous = new Map(threads.map((thread) => [thread.id, thread]));
    count = attentionCount(threads);
    push();
  };
}
