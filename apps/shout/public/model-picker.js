// Composer popovers: the model and effort pickers (listboxes) and the overflow menu. DOM nodes only.
// Keyboard: arrows and Home/End move, Enter/Space choose, Escape and Tab close; a click outside closes.
const SVG = 'http://www.w3.org/2000/svg';
const ITEM = '[role=option],[role=menuitem],[role=menuitemcheckbox]';
const GLYPHS = {
  codex: '<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z"/><path d="M9 10l2.5 2L9 14M13 14.5h2.5"/>',
  claude: '<path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/>',
};
export const LOCKED = 'Locked after the first message. Start a new thread to switch models.';
export const effortLabel = (effort) => ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[effort] || effort;
let current = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(markup, className) {
  const node = document.createElementNS(SVG, 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  if (className) node.setAttribute('class', className);
  node.innerHTML = markup;
  return node;
}
const sprite = (name, className) => svg(`<use href="#${name}"/>`, className);
export const providerGlyph = (id) => svg(GLYPHS[id] || '<circle cx="12" cy="12" r="7"/>', `glyph glyph-${id}`);

/** Wires a trigger button to its popover panel; items are [role=option|menuitem|menuitemcheckbox] with a `choose()` method. */
export function popover(trigger, panel) {
  const items = () => [...panel.querySelectorAll(ITEM)];
  const usable = (item) => item.getAttribute('aria-disabled') !== 'true';
  const outside = (event) => { if (!trigger.parentElement.contains(event.target)) close(); };
  function open(focus = 'selected') {
    if (trigger.disabled) return;
    if (current && current !== api) current.close();
    current = api;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    const list = items();
    const target = focus === 'last' ? list.findLast(usable) : list.find((item) => item.getAttribute('aria-selected') === 'true') || list.find(usable);
    (target || panel).focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }
  function close(refocus = false) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (current === api) current = null;
    if (refocus) trigger.focus({ preventScroll: true });
  }
  function choose(item) {
    if (!item || !usable(item)) return;
    close(true);
    item.choose?.();
  }
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    open(event.key === 'ArrowUp' ? 'last' : 'selected');
  });
  panel.addEventListener('click', (event) => choose(event.target.closest(ITEM)));
  panel.addEventListener('keydown', (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement);
    const move = { ArrowDown: index + 1, ArrowUp: index < 0 ? list.length - 1 : index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined) list[(move + list.length) % list.length]?.focus();
    else if (event.key === 'Enter' || event.key === ' ') choose(list[index]);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') { close(); return; }
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  const api = { open, close, get isOpen() { return !panel.hidden; } };
  return api;
}

// Re-rendering an open panel keeps keyboard focus on the same position.
function refill(panel, children) {
  const index = [...panel.querySelectorAll(ITEM)].indexOf(document.activeElement);
  panel.replaceChildren(...children);
  if (index >= 0) (panel.querySelectorAll(ITEM)[index] || panel).focus({ preventScroll: true });
}
function option(label, { selected = false, disabled = false, title = '', choose, role = 'option' }) {
  const item = el('div', 'popover-item');
  item.setAttribute('role', role);
  item.tabIndex = -1;
  if (role === 'option') item.setAttribute('aria-selected', String(selected));
  item.setAttribute('aria-disabled', String(disabled));
  if (title) item.title = title;
  item.append(el('span', 'popover-label', label), sprite('i-check', 'popover-check'));
  item.choose = choose;
  return item;
}

/** Fills the model trigger and listbox: models grouped by provider; unavailable providers' and, once locked, all other models are disabled. */
export function renderModels(trigger, panel, { providers, models, model, locked, onPick }) {
  const info = models.find((item) => item.id === model) || models[0];
  const provider = providers.find((item) => item.id === info?.provider);
  trigger.replaceChildren(providerGlyph(info?.provider), el('span', 'picker-value', info?.label || model), sprite('i-chevron', 'picker-chevron'));
  trigger.setAttribute('aria-label', `Model: ${provider?.label || ''} ${info?.label || model}`.replace(/\s+/g, ' '));
  const groups = providers.map((item) => {
    const group = el('div', 'popover-group');
    group.setAttribute('role', 'group');
    const heading = el('div', 'popover-heading');
    heading.id = `model-group-${item.id}`;
    heading.append(providerGlyph(item.id), el('span', '', item.label));
    if (!item.available) {
      const note = el('span', 'popover-unavailable', 'Unavailable');
      note.title = item.error || '';
      heading.append(note);
    }
    group.setAttribute('aria-labelledby', heading.id);
    group.append(heading);
    for (const entry of models.filter((candidate) => candidate.provider === item.id)) {
      const lockedOut = locked && entry.id !== info?.id;
      group.append(option(entry.label, {
        selected: entry.id === info?.id,
        disabled: lockedOut || !item.available,
        title: lockedOut ? LOCKED : !item.available ? item.error || `${item.label} is unavailable` : '',
        choose: () => entry.id !== info?.id && onPick(entry.id),
      }));
    }
    return group;
  });
  const foot = el('div', 'popover-foot');
  foot.id = 'model-lock-note';
  foot.append(sprite('i-lock'), el('span', '', LOCKED));
  foot.hidden = !locked;
  refill(panel, [...groups, foot]);
  if (locked) panel.setAttribute('aria-describedby', foot.id); else panel.removeAttribute('aria-describedby');
}

export function renderEfforts(trigger, panel, { efforts, effort, onPick }) {
  trigger.replaceChildren(el('span', 'picker-value', effortLabel(effort)), sprite('i-chevron', 'picker-chevron'));
  trigger.setAttribute('aria-label', `Reasoning effort: ${effortLabel(effort)}`);
  refill(panel, efforts.map((item) => option(effortLabel(item), { selected: item === effort, choose: () => item !== effort && onPick(item) })));
}

/** The overflow menu: items are [label, { checked?, disabled?, icon?, choose }]. */
export function renderMenu(panel, entries) {
  refill(panel, entries.map(([label, { checked, disabled = false, icon, choose }]) => {
    const item = option(label, { disabled, choose, role: checked === undefined ? 'menuitem' : 'menuitemcheckbox' });
    if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
    if (icon) item.prepend(sprite(icon, 'popover-icon'));
    return item;
  }));
}
