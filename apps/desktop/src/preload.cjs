// The only surface pages get from the desktop shell. Every call is re-validated in the main process.
const { contextBridge, ipcRenderer } = require('electron');

// Read per page load, so `remote` stays right after switching servers.
const config = (() => { try { return ipcRenderer.sendSync('shout:desktop-config') ?? {}; } catch { return {}; } })();
const web = location.protocol === 'http:' || location.protocol === 'https:';

const subscribe = (channel, name) => callback => {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback function');
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener); ipcRenderer.send('shout:subscribe', name, true);
  return () => {
    ipcRenderer.removeListener(channel, listener);
    if (!ipcRenderer.listenerCount(channel)) ipcRenderer.send('shout:subscribe', name, false);
  };
};

if (web) {
  const chrome = config.chrome ?? {};
  contextBridge.exposeInMainWorld('shoutDesktop', Object.freeze({
    platform: process.platform,
    version: String(config.version ?? ''),
    // Remote: the SHOUT server runs on another computer, so project paths are not local paths.
    remote: config.remote === true,
    chrome: Object.freeze({
      titlebar: ['overlay', 'inset'].includes(chrome.titlebar) ? chrome.titlebar : 'none',
      overlayHeight: Number(chrome.overlayHeight) || 0, overlayWidth: Number(chrome.overlayWidth) || 0, insetLeft: Number(chrome.insetLeft) || 0,
    }),
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
    const root = document.documentElement;
    const report = () => ipcRenderer.invoke('shout:theme', ['light', 'dark'].includes(root.dataset.theme) ? root.dataset.theme : 'system').catch(() => {});
    report(); new MutationObserver(report).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  });
} else if (location.protocol === 'file:') {
  // The bundled connection screen (loading.html): status updates in, retry/connect choices out.
  contextBridge.exposeInMainWorld('shoutConnect', Object.freeze({
    state: () => ipcRenderer.invoke('shout:screen-state'),
    act: (action, value) => ipcRenderer.invoke('shout:screen-action', action, value),
    onState: callback => { if (typeof callback === 'function') ipcRenderer.on('shout:screen', (_event, state) => callback(state)); },
  }));
}
