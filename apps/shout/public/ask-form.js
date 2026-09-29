// The form for a user.ask answer, built from the kernel's model-shape JSON Schema (type, properties, required,
// additionalProperties, items, enum, anyOf). Records and lists nest; a tuple is an object keyed "0", "1", …; a
// payload-free enum is its variant's name; enums with payloads, Option and Result are anyOf tagged objects; a map is
// a list of {key, value}; a Float is a number or a named non-finite value; Bytes is {$bytes: base64}. Anything else
// falls back to a JSON text box. DOM nodes only; labels come from the schema's field names.

// Two or three words for each issue code (JOSH's and the form's own).
const REASONS = { type: 'Wrong type', required: 'Value missing', unknown: 'Not allowed', range: 'Out of range', fields: 'Wrong fields',
  length: 'Wrong length', encoding: 'Invalid encoding', tag: 'Unknown variant', order: 'Duplicate key' };
export const reason = (code) => REASONS[code] ?? 'Invalid value';

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tagOf = (branch) => {
  const tag = branch?.properties?.tag;
  return branch?.type === 'object' && tag?.type === 'string' && Array.isArray(tag.enum) && tag.enum.length === 1 ? tag.enum[0] : null;
};
const keysOf = (schema) => Object.keys(schema?.properties ?? {});
const payloadKeys = (branch) => keysOf(branch).filter((key) => key !== 'tag');
const isEntry = (items) => items?.type === 'object' && keysOf(items).length === 2 && 'key' in items.properties && 'value' in items.properties;
const SCALAR = new Set(['string', 'integer', 'number', 'float', 'bytes', 'enum', 'boolean']);

/** The control a schema gets. Pure, so it is tested without a DOM. */
export function kindOf(schema) {
  if (!plain(schema)) return 'json';
  if (Array.isArray(schema.anyOf)) {
    const [number, names] = schema.anyOf;
    if (schema.anyOf.length === 2 && number?.type === 'number' && names?.type === 'string' && Array.isArray(names.enum)) return 'float';
    const tags = schema.anyOf.map(tagOf);
    if (!tags.length || !tags.every((tag) => tag !== null) || new Set(tags).size !== tags.length) return 'json';
    const some = schema.anyOf[tags.indexOf('Some')];
    const none = schema.anyOf[tags.indexOf('None')];
    if (tags.length === 2 && some && none && payloadKeys(some).join() === 'value' && !payloadKeys(none).length) return 'option';
    return 'union';
  }
  switch (schema.type) {
    case 'null': case 'boolean': case 'integer': case 'number': return schema.type;
    case 'string': return Array.isArray(schema.enum) ? 'enum' : 'string';
    case 'array': return !plain(schema.items) ? 'json' : isEntry(schema.items) ? 'map' : 'list';
    case 'object': {
      const keys = keysOf(schema);
      if (!plain(schema.properties)) return 'json';
      if (keys.length === 1 && keys[0] === '$bytes' && schema.properties.$bytes?.type === 'string') return 'bytes';
      if (keys.length && keys.every((key, index) => key === String(index))) return 'tuple';
      return 'record';
    }
  }
  return 'json';
}

const pointer = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const TYPES = { null: (v) => v === null, boolean: (v) => typeof v === 'boolean', string: (v) => typeof v === 'string', integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v), array: Array.isArray, object: plain };
/** Where a value breaks the schema subset, as [{path, code}] (JSON Pointers); [] when it matches. */
export function schemaIssues(schema, value, path = '') {
  if (!plain(schema)) return [];
  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((branch) => schemaIssues(branch, value, path));
    if (results.some((issues) => !issues.length)) return [];
    // A tagged object is judged by the variant its tag names.
    const index = plain(value) ? schema.anyOf.findIndex((branch) => tagOf(branch) === value.tag) : -1;
    if (index >= 0) return results[index];
    return plain(value) && 'tag' in value ? [{ path: pointer(path, 'tag'), code: 'tag' }] : [{ path, code: 'type' }];
  }
  if (schema.type && !TYPES[schema.type]?.(value)) return [{ path, code: 'type' }];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [{ path, code: 'tag' }];
  if (schema.type === 'array') return plain(schema.items) ? value.flatMap((item, index) => schemaIssues(schema.items, item, pointer(path, index))) : [];
  if (schema.type !== 'object') return [];
  const issues = (schema.required ?? []).filter((key) => !(key in value)).map((key) => ({ path: pointer(path, key), code: 'required' }));
  for (const [key, item] of Object.entries(value)) {
    const sub = schema.properties?.[key];
    if (sub) issues.push(...schemaIssues(sub, item, pointer(path, key)));
    else if (schema.additionalProperties === false) issues.push({ path: pointer(path, key), code: 'unknown' });
  }
  return issues;
}

/* DOM */
let counter = 0;
const uid = () => `ask-${++counter}`;
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function sprite(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<use href="#${name}"/>`;
  return svg;
}
export function humanize(name) {
  const text = String(name).replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
const INPUT = 'input, textarea, select';
function focusWithin(node) {
  const target = node.matches(INPUT) ? node : node.querySelector(`input:checked, ${INPUT}`);
  target?.focus({ preventScroll: true });
}
// A field's label: a <label> for one control, else a text node the group names itself by.
function labelled(wrap, text, { control, hidden = false, optional = false } = {}) {
  const label = el(control ? 'label' : 'span', `ask-label${hidden ? ' sr-only' : ''}`, text);
  label.id = uid();
  if (control) label.htmlFor = control.id ||= uid();
  if (optional) label.append(el('span', 'optional', 'optional'));
  wrap.append(label);
  return label;
}
function group(node, label) {
  node.setAttribute('role', 'group');
  node.setAttribute('aria-labelledby', label.id);
  return node;
}

/**
 * One field. Every field is { node, target, read(issues), empty(), child(segment), focus() }: read() returns the value
 * and pushes { field, code } for what is wrong; child() follows one JSON Pointer segment for marking issues.
 * `row` lays it out in a list or map row (single-line text, the label for screen readers only).
 */
function field(schema, { label, required = true, initial, row = false, top = false, hideLabel = false }) {
  const kind = kindOf(schema);
  const quiet = hideLabel || row || top;
  if (kind === 'null') {
    const node = el('span');
    node.hidden = true;
    return base(node, node, () => null);
  }
  if (kind === 'record') return recordField(schema, { label, initial, top, bare: hideLabel || row });
  if (kind === 'tuple') return tupleField(schema, { label, initial, quiet, row });
  if (kind === 'list' || kind === 'map') return rowsField(schema, kind, { label, initial, quiet });
  if (kind === 'union' || (kind === 'option' && !SCALAR.has(kindOf(schema.anyOf.find((branch) => tagOf(branch) === 'Some').properties.value)))) {
    return unionField(schema, { label, initial, quiet });
  }
  if (kind === 'option') return optionField(schema, { label, initial, quiet });
  if (kind === 'enum' || kind === 'boolean' && row) return choiceField(kind === 'enum' ? schema.enum : [true, false], { label, initial, quiet, required, row });
  if (kind === 'boolean') return checkField({ label, initial });
  return textField(kind, schema, { label, required, initial, quiet, row, top });
}
function base(node, target, read, extra = {}) {
  return { node, target, read, empty: () => false, child: () => null, focus: () => focusWithin(target), ...extra };
}
function hint(wrap, schema) {
  if (typeof schema?.description === 'string' && schema.description) wrap.append(el('small', 'ask-hint', schema.description));
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Text, whole numbers, numbers, Floats (a number or a named value such as NaN) and Bytes (base64).
function textField(kind, schema, { label, required, initial, quiet, row, top }) {
  const multiline = kind === 'string' && !row;
  const input = el(multiline ? 'textarea' : 'input', `ask-input${kind === 'json' || kind === 'bytes' ? ' mono' : ''}${['integer', 'number', 'float'].includes(kind) ? ' ask-number' : ''}`);
  input.id = uid();
  if (multiline) {
    input.rows = top ? 3 : 1;
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(240, input.scrollHeight + 2)}px`; });
  } else {
    input.type = 'text';
    input.autocomplete = 'off';
  }
  if (kind === 'json') { input.rows = 3; input.placeholder = 'JSON'; }
  if (kind !== 'string') input.spellcheck = false;
  if (kind === 'integer') input.inputMode = 'numeric';
  if (kind === 'number' || kind === 'float') input.inputMode = 'decimal';
  const names = kind === 'float' ? schema.anyOf[1].enum : [];
  const wrap = el('div', 'ask-field');
  labelled(wrap, label, { control: input, hidden: quiet, optional: !required });
  wrap.append(input);
  hint(wrap, schema);
  if (initial !== undefined && initial !== null) {
    if (kind === 'bytes' && typeof initial?.$bytes === 'string') input.value = initial.$bytes;
    else if (kind === 'json') input.value = JSON.stringify(initial, null, 2);
    else if (typeof initial === (kind === 'string' ? 'string' : 'number') || names.includes(initial)) input.value = String(initial);
  }
  if (input.tagName === 'TEXTAREA' && input.value) input.rows = Math.max(input.rows, Math.min(10, input.value.split('\n').length));
  const self = base(wrap, input, (issues) => {
    const raw = kind === 'string' ? input.value : input.value.trim();
    if (!raw.trim()) {
      if (required) issues.push({ field: self, code: 'required' });
      return undefined;
    }
    const fail = (code) => { issues.push({ field: self, code }); return undefined; };
    if (kind === 'string') return raw;
    if (kind === 'bytes') return BASE64.test(raw) ? { $bytes: raw } : fail('encoding');
    if (kind === 'json') { try { return JSON.parse(raw); } catch { return fail('type'); } }
    if (names.includes(raw)) return raw;
    if (kind === 'integer') return !/^[-+]?\d+$/.test(raw) ? fail('type') : Number.isSafeInteger(Number(raw)) ? Number(raw) : fail('range');
    return NUMBER.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : fail(NUMBER.test(raw) ? 'range' : 'type');
  }, { empty: () => !input.value.trim(), input });
  return self;
}
function checkField({ label, initial }) {
  const input = el('input');
  input.type = 'checkbox';
  input.id = uid();
  input.checked = initial === true;
  const wrap = el('div', 'ask-field');
  const row = el('label', 'ask-check');
  row.htmlFor = input.id;
  row.append(input, label);
  wrap.append(row);
  return base(wrap, input, () => input.checked);
}
// A choice among names: a segmented control for a few short ones, a select otherwise (and whenever "none" is allowed).
function picker(values, labels, { none = false, onChange } = {}) {
  const segmented = !none && values.length <= 4 && labels.every((text) => text.length <= 14);
  let control;
  if (segmented) {
    control = el('div', 'ask-seg');
    control.setAttribute('role', 'radiogroup');
    const group = uid();
    values.forEach((value, index) => {
      const option = el('label');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = group;
      radio.value = String(index);
      radio.addEventListener('change', () => onChange?.());
      option.append(radio, el('span', '', labels[index]));
      control.append(option);
    });
  } else {
    control = el('select', 'ask-input');
    control.id = uid();
    if (none) control.append(new Option('—', ''));
    else control.append(Object.assign(new Option('', ''), { disabled: true, hidden: true }));
    values.forEach((_, index) => control.append(new Option(labels[index], String(index))));
    control.value = '';
    control.addEventListener('change', () => onChange?.());
  }
  return {
    control,
    segmented,
    get: () => {
      const index = segmented ? control.querySelector('input:checked')?.value : control.value;
      return index === undefined || index === '' ? undefined : values[Number(index)];
    },
    set(value) {
      const index = values.findIndex((candidate) => candidate === value);
      if (index < 0) return;
      if (segmented) control.querySelectorAll('input')[index].checked = true;
      else control.value = String(index);
    },
    label: (text) => control.setAttribute('aria-labelledby', text.id),
  };
}
function choiceField(values, { label, initial, quiet, required, row, none = false }) {
  const labels = values.map((value) => (value === true ? 'Yes' : value === false ? 'No' : String(value)));
  const choice = picker(values, labels, { none: none || !required });
  const wrap = el('div', 'ask-field');
  const text = labelled(wrap, label, { hidden: quiet || row, optional: !required && !none });
  choice.label(text);
  wrap.append(choice.control);
  choice.set(initial);
  const self = base(wrap, choice.control, (issues) => {
    const value = choice.get();
    if (value === undefined && required) issues.push({ field: self, code: 'required' });
    return value;
  }, { empty: () => choice.get() === undefined });
  return self;
}
// Option with a plain payload: an optional field; left empty it is None.
function optionField(schema, { label, initial, quiet }) {
  const some = schema.anyOf.find((branch) => tagOf(branch) === 'Some').properties.value;
  const kind = kindOf(some);
  const value = initial?.tag === 'Some' ? initial.value : undefined;
  const inner = kind === 'enum' || kind === 'boolean'
    ? choiceField(kind === 'enum' ? some.enum : [true, false], { label, initial: value, quiet, required: false })
    : textField(kind, some, { label, required: false, initial: value, quiet });
  return {
    ...inner,
    read(issues) { if (inner.empty()) return { tag: 'None' }; const item = inner.read(issues); return { tag: 'Some', value: item }; },
    child: (segment) => (segment === 'value' ? inner : null),
  };
}
// Enums with payloads, Result, and Option with a structured payload: pick the variant; its payload shows beneath.
function unionField(schema, { label, initial, quiet }) {
  const branches = schema.anyOf.map((branch) => ({ tag: tagOf(branch), schema: branch, payload: null }));
  const tags = branches.map((branch) => branch.tag);
  const wrap = el('div', 'ask-field ask-union');
  const text = labelled(wrap, label, { hidden: quiet });
  const payload = el('div', 'ask-payload');
  const choice = picker(tags, tags, { onChange: () => show() });
  choice.label(text);
  wrap.append(choice.control, payload);
  const current = () => branches.find((branch) => branch.tag === choice.get());
  function show() {
    for (const branch of branches) if (branch.payload) branch.payload.node.hidden = branch !== current();
    const branch = current();
    if (branch && !branch.payload && payloadKeys(branch.schema).length) {
      branch.payload = payloadOf(branch, initial?.tag === branch.tag ? initial : undefined);
      payload.append(branch.payload.node);
    }
    payload.hidden = !branch?.payload;
  }
  choice.set(initial?.tag);
  show();
  const self = base(wrap, choice.control, (issues) => {
    const branch = current();
    if (!branch) { issues.push({ field: self, code: 'required' }); return undefined; }
    return { tag: branch.tag, ...(branch.payload ? branch.payload.read(issues) : {}) };
  }, { child: (segment) => (segment === 'tag' ? self : current()?.payload?.child(segment) ?? null) });
  return self;
}
// A variant's payload fields (almost always one, `value`), labelled by the variant for screen readers.
function payloadOf(branch, initial) {
  const keys = payloadKeys(branch.schema);
  const node = el('div', 'ask-fields');
  const fields = keys.map((key) => [key, field(branch.schema.properties[key], { label: key === 'value' ? humanize(branch.tag) : humanize(key), initial: initial?.[key], hideLabel: key === 'value' })]);
  for (const [, item] of fields) node.append(item.node);
  return {
    node,
    read: (issues) => Object.fromEntries(fields.map(([key, item]) => [key, item.read(issues)])),
    child: (segment) => fields.find(([key]) => key === segment)?.[1] ?? null,
  };
}
function recordField(schema, { label, initial, top, bare }) {
  const required = new Set(schema.required ?? []);
  const box = el(top || bare ? 'div' : 'fieldset', 'ask-fields');
  if (!top && !bare) box.append(el('legend', '', label));
  else if (bare && label) box.setAttribute('aria-label', label);
  const fields = keysOf(schema).map((key) => [key, field(schema.properties[key], { label: humanize(key), required: required.has(key), initial: plain(initial) ? initial[key] : undefined })]);
  for (const [, item] of fields) box.append(item.node);
  const self = base(box, box, (issues) => {
    const value = {};
    for (const [key, item] of fields) {
      if (!required.has(key) && item.empty()) continue;
      value[key] = item.read(issues);
    }
    return value;
  }, {
    empty: () => fields.every(([, item]) => item.empty()),
    child: (segment) => fields.find(([key]) => key === segment)?.[1] ?? null,
    focus: () => (fields[0]?.[1] ?? { focus() {} }).focus(),
  });
  return self;
}
// Positional fields, side by side.
function tupleField(schema, { label, initial, quiet }) {
  const wrap = el('div', 'ask-field');
  const text = labelled(wrap, label, { hidden: quiet });
  const items = keysOf(schema).map((key, index) => field(schema.properties[key], { label: `${label} ${index + 1}`, initial: plain(initial) ? initial[key] : undefined, row: true }));
  const line = group(el('div', 'ask-tuple'), text);
  for (const item of items) line.append(item.node);
  wrap.append(line);
  return base(wrap, line, (issues) => Object.fromEntries(items.map((item, index) => [String(index), item.read(issues)])), {
    child: (segment) => items[Number(segment)] ?? null,
    focus: () => items[0]?.focus(),
  });
}
// Lists and maps: one row per item (a map row is a key and a value), with add and remove.
function rowsField(schema, kind, { label, initial, quiet }) {
  const wrap = el('div', 'ask-field ask-list');
  const text = labelled(wrap, label, { hidden: quiet });
  const list = group(el('div', 'ask-rows'), text);
  const rows = [];
  const itemSchema = kind === 'map' ? schema.items.properties : schema.items;
  function addRow(value, after) {
    const node = el('div', `ask-row${kind === 'map' ? ' map' : ''}`);
    const parts = kind === 'map'
      ? { key: field(itemSchema.key, { label: `${label} key`, initial: value?.key, row: true }), value: field(itemSchema.value, { label: `${label} value`, initial: value?.value, row: true }) }
      : { item: field(itemSchema, { label, initial: value, row: true }) };
    for (const part of Object.values(parts)) node.append(part.node);
    const row = { node, parts };
    const remove = el('button', 'icon-button small ask-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove from ${label}`);
    remove.append(sprite('i-x'));
    remove.addEventListener('click', () => drop(row));
    node.append(remove);
    // Single-line rows type like lines: Enter adds the next one, Backspace on an empty one removes it.
    const input = (parts.item ?? parts.value).input;
    if (input && input.tagName === 'INPUT') {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); addRow(undefined, row).focus(); }
        else if (event.key === 'Backspace' && !input.value && rows.length > 1 && !parts.key) { event.preventDefault(); const index = rows.indexOf(row); drop(row); rows[Math.max(0, index - 1)]?.focus(); }
      });
    }
    row.focus = () => (parts.key ?? parts.item).focus();
    row.child = (segment) => (kind === 'map' ? parts[segment] ?? null : null);
    const index = after ? rows.indexOf(after) + 1 : rows.length;
    rows.splice(index, 0, row);
    list.insertBefore(node, rows[index + 1]?.node ?? null);
    return row;
  }
  function drop(row) {
    rows.splice(rows.indexOf(row), 1);
    row.node.remove();
    list.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const add = el('button', 'ask-add');
  add.type = 'button';
  add.setAttribute('aria-label', `Add to ${label}`);
  add.append(sprite('i-plus'), 'Add');
  add.addEventListener('click', () => addRow().focus());
  wrap.append(list, add);
  if (Array.isArray(initial)) for (const value of initial) addRow(value);
  const self = base(wrap, list, (issues) => {
    if (kind === 'list') return rows.map((row) => row.parts.item.read(issues));
    const seen = new Set();
    return rows.map((row) => {
      const key = row.parts.key.read(issues);
      // Map keys must be distinct; JOSH would ask again otherwise.
      const id = JSON.stringify(key);
      if (key !== undefined && typeof key !== 'object' && seen.has(id)) issues.push({ field: row.parts.key, code: 'order' });
      seen.add(id);
      return { key, value: row.parts.value.read(issues) };
    });
  }, {
    empty: () => !rows.length,
    child: (segment) => {
      const row = rows[Number(segment)];
      return !row ? null : kind === 'list' ? row.parts.item : { ...row, target: row.node, node: row.node };
    },
    focus: () => (rows[0] ?? { focus: () => add.focus() }).focus(),
  });
  return self;
}

/* Marks: aria-invalid on the control, the reason just after it, cleared once the field is edited or the form re-read. */
const clears = new WeakMap();
function mark(target, holder, code) {
  clears.get(target)?.();
  const note = el('small', 'ask-issue', reason(code));
  note.id = uid();
  if (target !== holder && target.parentNode === holder) target.after(note); else holder.append(note);
  target.setAttribute('aria-invalid', 'true');
  const described = new Set((target.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)).add(note.id);
  target.setAttribute('aria-describedby', [...described].join(' '));
  const clear = () => {
    target.removeAttribute('aria-invalid');
    const rest = (target.getAttribute('aria-describedby') || '').split(' ').filter((id) => id && id !== note.id);
    if (rest.length) target.setAttribute('aria-describedby', rest.join(' ')); else target.removeAttribute('aria-describedby');
    note.remove();
    holder.removeEventListener('input', clear);
    holder.removeEventListener('change', clear);
    if (clears.get(target) === clear) clears.delete(target);
  };
  clears.set(target, clear);
  holder.addEventListener('input', clear);
  holder.addEventListener('change', clear);
}
const markField = (item, code) => mark(item.target, item.node, code);
// The deepest field a JSON Pointer reaches.
function resolve(root, path) {
  let item = root;
  for (const segment of String(path ?? '').split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    const next = item.child?.(segment);
    if (!next) break;
    item = next;
  }
  return item;
}

/**
 * The whole answer form. `initial` pre-fills it (a skill's defaults, or the answer JOSH rejected); `issues`
 * ([{path, code}] from JOSH) mark the fields they point at. `read()` returns { value } when the answer is complete and
 * matches the schema, else marks what is wrong, focuses it and returns null.
 */
export function askForm(schema, { initial, issues = [] } = {}) {
  const kind = kindOf(schema);
  const root = field(schema, { label: 'Answer', initial, top: true });
  const node = el('div', 'ask-answer');
  node.append(root.node);
  const markPath = (path, code) => {
    const item = resolve(root, path);
    if (item === root && kind !== 'record') markField(root, code);
    else if (item === root) mark(node, node, code);
    else markField(item, code);
  };
  for (const issue of Array.isArray(issues) ? issues : []) markPath(issue.path, issue.code);
  const focus = () => {
    const invalid = node.querySelector('[aria-invalid=true]');
    if (invalid) focusWithin(invalid); else root.focus();
  };
  return {
    node,
    focus,
    read() {
      // The form's own checks decide; marks from JOSH or an earlier try are cleared first.
      for (const target of node.querySelectorAll('[aria-invalid=true]')) clears.get(target)?.();
      if (node.getAttribute('aria-invalid') === 'true') clears.get(node)?.();
      const found = [];
      const value = root.read(found);
      for (const { field: item, code } of found) markField(item, code);
      if (!found.length) for (const issue of schemaIssues(schema, value)) markPath(issue.path, issue.code);
      if (node.querySelector('[aria-invalid=true]')) { focus(); return null; }
      return { value };
    },
  };
}
