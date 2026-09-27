// The only surface the SHOUT page gets from the desktop shell. Every call is re-validated in the main process.
const { contextBridge, ipcRenderer } = require('electron');

const config = (() => {
  try { return JSON.parse(process.argv.find(arg => arg.startsWith('--shout-desktop='))?.slice(16) ?? '{}'); } catch { return {}; }
})();

const subscribe = (channel, name) => callback => {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback function');
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener); ipcRenderer.send('shout:subscribe', name, true);
  return () => {
    ipcRenderer.removeListener(channel, listener);
    if (!ipcRenderer.listenerCount(channel)) ipcRenderer.send('shout:subscribe', name, false);
  };
};

contextBridge.exposeInMainWorld('shoutDesktop', Object.freeze({
  platform: process.platform,
  version: String(config.version ?? ''),
  chrome: Object.freeze({ titlebar: config.chrome?.titlebar === 'overlay' ? 'overlay' : 'none', overlayHeight: Number(config.chrome?.overlayHeight) || 0, overlayWidth: Number(config.chrome?.overlayWidth) || 0 }),
  pickFolder: (options = {}) => ipcRenderer.invoke('shout:pick-folder', options),
  notify: options => ipcRenderer.invoke('shout:notify', options),
  revealPath: path => ipcRenderer.invoke('shout:reveal-path', path),
  openPath: path => ipcRenderer.invoke('shout:open-path', path),
  setAttention: on => ipcRenderer.invoke('shout:attention', on),
  setBadgeCount: count => ipcRenderer.invoke('shout:badge', count),
  setTheme: theme => ipcRenderer.invoke('shout:theme', theme),
  showContextMenu: (items, position) => ipcRenderer.invoke('shout:context-menu', items, position),
  showAppMenu: position => ipcRenderer.invoke('shout:app-menu', position),
  serverInfo: () => ipcRenderer.invoke('shout:server-info'),
  onMenuCommand: subscribe('shout:menu-command', 'menu-command'),
  onOpenSession: subscribe('shout:open-session', 'open-session'),
}));

// Until the page calls setTheme itself, native chrome follows the theme the page applies to <html data-theme>.
window.addEventListener('DOMContentLoaded', () => {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  const root = document.documentElement;
  const report = () => ipcRenderer.invoke('shout:theme', ['light', 'dark'].includes(root.dataset.theme) ? root.dataset.theme : 'system').catch(() => {});
  report(); new MutationObserver(report).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
});
