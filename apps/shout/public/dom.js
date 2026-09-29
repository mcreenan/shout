// Small DOM helpers for the sidebar, project dialogs and menus: elements, icons, project monograms, copying,
// and a keyed list update that leaves unchanged rows (and their focus and hover) in place.
import { monogram, monogramColor } from './sidebar-logic.js';

const SVG = 'http://www.w3.org/2000/svg';
// Lucide-style 24×24 stroke icons.
const ICONS = {
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  compose: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3l-9 9-4 1 1-4z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
  'folder-plus': '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/><path d="M12 10v6M9 13h6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  settings: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  view: '<path d="M3 6h18M7 12h10M10 18h4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  up: '<path d="M14 9 9 4 4 9"/><path d="M20 20h-7a4 4 0 0 1-4-4V4"/>',
  working: '<path d="M10.1 2.2a10 10 0 0 1 3.8 0M13.9 21.8a10 10 0 0 1-3.8 0M17.6 3.7a10 10 0 0 1 2.7 2.7M2.2 13.9a10 10 0 0 1 0-3.8M20.3 17.6a10 10 0 0 1-2.7 2.7M21.8 10.1a10 10 0 0 1 0 3.8M3.7 6.4a10 10 0 0 1 2.7-2.7M6.4 20.3a10 10 0 0 1-2.7-2.7"/>',
  approval: '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  input: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  failed: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  done: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
};

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function icon(name, className = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ic ic-${name} ${className}`.trim());
  svg.innerHTML = ICONS[name] || '';
  return svg;
}
export function iconButton(name, label, className = 'sb-icon-button') {
  const button = el('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  return button;
}
/** The project's two-letter tile, 16px with a 25% radius, in its hashed colour for either theme. */
export function monogramTile(name, className = '') {
  const [light, dark] = monogramColor(name);
  const text = monogram(name);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `monogram ${className}`.trim());
  svg.style.color = `light-dark(${light}, ${dark})`;
  svg.innerHTML = `<rect width="16" height="16" rx="4" fill="currentColor" fill-opacity=".14"/><text x="8" y="10.8" text-anchor="middle" fill="currentColor" font-size="8.25" font-weight="700" textLength="${Array.from(text).length === 1 ? 6 : 12}" lengthAdjust="spacingAndGlyphs"></text>`;
  svg.querySelector('text').textContent = text;
  return svg;
}
/** Copies text; plain-HTTP LAN pages have no Clipboard API, so a hidden textarea is the fallback. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = el('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  const done = document.execCommand('copy');
  area.remove();
  return done;
}
/**
 * Puts `nodes` into `container` in order, moving only what differs. Nodes carry `data-key`; when the focused
 * row was rebuilt, focus goes to the same row's replacement.
 */
export function reconcile(container, nodes) {
  const active = document.activeElement;
  const key = container.contains(active) ? active.closest('[data-key]')?.dataset.key : null;
  const role = key ? active.dataset.nav ?? null : null;
  nodes.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null); });
  while (container.children.length > nodes.length) container.lastElementChild.remove();
  if (key && !container.contains(document.activeElement)) {
    const row = [...container.children].find((node) => node.dataset.key === key);
    (row?.querySelector(role ? `[data-nav="${CSS.escape(role)}"]` : '[data-nav]') || row?.querySelector('[data-nav]'))?.focus({ preventScroll: true });
  }
}
