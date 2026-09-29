// Desktop shell adapter. Inside the SHOUT desktop app `desktop` is the Electron bridge (window.shoutDesktop);
// in a normal browser it is null and every helper degrades to a harmless browser equivalent or no-op.
export const desktop = globalThis.shoutDesktop ?? null;
export const isDesktop = desktop !== null;
export const chrome = desktop?.chrome ?? Object.freeze({ titlebar: 'none', overlayHeight: 0, overlayWidth: 0, insetLeft: 0 });
// Remote: the app shows a SHOUT server on another computer. Project paths live there, so the native folder chooser
// and file manager do not apply (revealPath/openPath reject); use SHOUT's server-side directory browser instead.
export const isRemote = desktop?.remote === true;
export const canPickFolder = isDesktop && !isRemote;
export const canRevealPath = isDesktop && !isRemote;
// Commands the application menu sends through onMenuCommand.
export const menuCommands = Object.freeze(['new-thread', 'add-project', 'export-session', 'toggle-theme', 'toggle-sidebar']);

const sessionOpeners = new Set();
const noop = () => {};

// Native folder chooser; resolves an absolute path, or null when cancelled or outside the desktop app.
export const pickFolder = (options = {}) => desktop ? desktop.pickFolder(options) : Promise.resolve(null);

// Native notification in the app; a Web Notification in the browser when permission was already granted.
// Clicking it focuses SHOUT and calls the onOpenSession handlers with sessionId.
export async function notify({ title, body = '', sessionId } = {}) {
  if (desktop) return desktop.notify({ title, body, ...(sessionId ? { sessionId } : {}) });
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const notification = new Notification(title, { body, icon: '/shout-wordmark.png' });
  notification.onclick = () => { globalThis.focus?.(); if (sessionId) for (const open of sessionOpeners) open(sessionId); notification.close(); };
  return true;
}

export const onOpenSession = callback => {
  if (desktop) return desktop.onOpenSession(callback);
  sessionOpeners.add(callback);
  return () => sessionOpeners.delete(callback);
};
export const onMenuCommand = callback => desktop ? desktop.onMenuCommand(callback) : noop;
export const revealPath = path => desktop ? desktop.revealPath(path) : Promise.resolve();
export const openPath = path => desktop ? desktop.openPath(path) : Promise.resolve();
export const setAttention = on => desktop ? desktop.setAttention(Boolean(on)) : Promise.resolve();
export const setBadgeCount = count => desktop ? desktop.setBadgeCount(count) : Promise.resolve(false);
export const setTheme = theme => desktop ? desktop.setTheme(theme) : Promise.resolve();
// Resolves the chosen item id or null; in a browser there is no native menu, so it resolves null.
export const showContextMenu = (items, position) => desktop ? desktop.showContextMenu(items, position) : Promise.resolve(null);
export const showAppMenu = position => desktop ? desktop.showAppMenu(position) : Promise.resolve();
export const serverInfo = () => desktop ? desktop.serverInfo() : Promise.resolve(null);
