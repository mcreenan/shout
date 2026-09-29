// Menus and confirmations. Context menus are native in the desktop app (showContextMenu) and a DOM popover
// with the same items in a browser. Items: { id, label, enabled?, destructive?, checked? } or { type: 'separator' | 'heading' }.
import * as shell from './desktop.js';
import { el, icon } from './dom.js';

let closeOpen = null;

/** Resolves the chosen item's id, or null. `native: false` keeps the DOM menu (for checkable items). */
export async function showMenu(items, position = {}, { native = true } = {}) {
  closeOpen?.(null);
  const at = { x: Math.max(0, Math.round(position.x ?? 0)), y: Math.max(0, Math.round(position.y ?? 0)) };
  if (native && shell.isDesktop) {
    const plain = tidy(items.filter((item) => item.type !== 'heading')).map(({ id, label, enabled, destructive, type }) => (type === 'separator' ? { type } : { id, label, ...(enabled === false ? { enabled } : {}), ...(destructive ? { destructive } : {}) }));
    try { return await shell.showContextMenu(plain, at); } catch { /* fall back to the DOM menu */ }
  }
  return domMenu(tidy(items), at);
}
// No separator at either end or next to another.
function tidy(items) {
  const out = [];
  for (const item of items) if (item.type !== 'separator' || (out.length && out.at(-1).type !== 'separator')) out.push(item);
  while (out.at(-1)?.type === 'separator') out.pop();
  return out;
}
function domMenu(items, { x, y }) {
  return new Promise((resolve) => {
    const invoker = document.activeElement;
    const menu = el('div', 'ctx-menu');
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.type === 'separator') { const line = el('div', 'ctx-sep'); line.setAttribute('role', 'separator'); menu.append(line); continue; }
      if (item.type === 'heading') { menu.append(el('div', 'ctx-heading', item.label)); continue; }
      const button = el('button', `ctx-item${item.destructive ? ' destructive' : ''}`);
      button.type = 'button';
      button.tabIndex = -1;
      button.dataset.id = item.id;
      button.disabled = item.enabled === false;
      button.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio');
      if (item.checked !== undefined) button.setAttribute('aria-checked', String(Boolean(item.checked)));
      button.append(el('span', 'ctx-label', item.label));
      if (item.checked) button.append(icon('check', 'ctx-check'));
      menu.append(button);
    }
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - box.width - 4))}px`;
    menu.style.top = `${Math.max(4, y + box.height > innerHeight - 4 ? y - box.height : y)}px`;
    const buttons = [...menu.querySelectorAll('.ctx-item:not(:disabled)')];
    const outside = (event) => { if (!menu.contains(event.target)) done(null); };
    const dismiss = () => done(null);
    function done(value) {
      if (closeOpen !== done) return;
      closeOpen = null;
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      menu.remove();
      if (invoker?.isConnected) invoker.focus({ preventScroll: true });
      resolve(value);
    }
    closeOpen = done;
    menu.addEventListener('click', (event) => {
      const button = event.target.closest('.ctx-item');
      if (button && !button.disabled) done(button.dataset.id);
    });
    menu.addEventListener('contextmenu', (event) => event.preventDefault());
    menu.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(document.activeElement);
      const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 }[event.key];
      if (move !== undefined) buttons[(move + buttons.length) % buttons.length]?.focus();
      else if (event.key === 'Escape' || event.key === 'Tab') done(null);
      else if ((event.key === 'Enter' || event.key === ' ') && index >= 0) done(buttons[index].dataset.id);
      else return;
      event.preventDefault();
      event.stopPropagation();
    });
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    (menu.querySelector('.ctx-item[aria-checked=true]:not(:disabled)') || buttons[0] || menu).focus({ preventScroll: true });
  });
}

/** A modal yes/no. `lines` are strings, or { code } for a path; destructive confirmations focus Cancel. */
export function confirmAction({ title, lines = [], confirm = 'OK', destructive = false }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'confirm-dialog');
    const form = el('form');
    form.method = 'dialog';
    const heading = el('h2', '', title);
    heading.id = `confirm-${Date.now()}`;
    dialog.setAttribute('aria-labelledby', heading.id);
    form.append(heading);
    for (const line of lines.filter(Boolean)) {
      const paragraph = el('p');
      if (typeof line === 'string') paragraph.textContent = line; else paragraph.append(el('code', '', line.code));
      form.append(paragraph);
    }
    const footer = el('div', 'dialog-footer');
    const cancel = Object.assign(el('button', 'secondary-button', 'Cancel'), { value: 'cancel' });
    const ok = Object.assign(el('button', destructive ? 'danger-button' : 'primary-button', confirm), { value: 'ok' });
    footer.append(cancel, ok);
    form.append(footer);
    dialog.append(form);
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'ok'); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    (destructive ? cancel : ok).focus();
  });
}
