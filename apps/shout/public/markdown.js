// Small dependency-free Markdown parser for chat messages. It returns a plain block/inline tree;
// callers build DOM from it with textContent, so model output can never become markup.
// Covers what models actually write: fences, headings, lists (nested, tasks), quotes, tables,
// rules, and inline code, emphasis, strikethrough, links and bare URLs. Unclosed fences run to
// the end so partially streamed replies render sensibly.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/;

const indentOf = (line) => line.match(/^ */)[0].length;
const blank = (line) => !line.trim();

function splitRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  let ticks = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '`') ticks = !ticks;
    if (c === '|' && !ticks) { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_DELIMITER.test(lines[i + 1])
    && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

// A line that ends a paragraph without a blank line in between.
function interrupts(lines, i) {
  const line = lines[i];
  const item = line.match(ITEM);
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || isTableStart(lines, i)
    || Boolean(item && item[4].trim() && (!/\d/.test(item[2]) || item[2].startsWith('1')));
}

export function parseBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const [, marker, lang] = fence;
      const strip = indentOf(line);
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].slice(Math.min(strip, indentOf(lines[i]))));
        i++;
      }
      i++;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2] || '') });
      i++;
      continue;
    }

    if (RULE.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || !interrupts(lines, i))) {
        body.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      blocks.push({ type: 'quote', children: parseBlocks(body.join('\n')) });
      continue;
    }

    const first = line.match(ITEM);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const delimiter = first[2].slice(-1);
      const list = { type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
      let loose = false;
      const sameList = (source) => {
        const match = source?.match(ITEM);
        return match && /\d/.test(match[2]) === ordered && match[2].slice(-1) === delimiter ? match : null;
      };
      while (i < lines.length) {
        const match = sameList(lines[i]);
        if (!match) break;
        const contentIndent = match[1].length + match[2].length + Math.min(Math.max(match[3].length, 1), 4);
        const body = [match[4]];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const next = lines[i];
          if (blank(next)) {
            let j = i;
            while (j < lines.length && blank(lines[j])) j++;
            if (j < lines.length && indentOf(lines[j]) >= contentIndent) { body.push(...lines.slice(i, j)); i = j; sawBlank = true; continue; }
            break;
          }
          if (indentOf(next) >= contentIndent) { body.push(next.slice(contentIndent)); i++; continue; }
          if (sawBlank || ITEM.test(next) || interrupts(lines, i)) break;
          body.push(next.trimStart()); // lazy paragraph continuation
          i++;
        }
        let j = i;
        while (j < lines.length && blank(lines[j])) j++;
        if (j > i && sameList(lines[j]) && indentOf(lines[j]) < contentIndent) { loose = true; i = j; }
        if (sawBlank) loose = true;
        const task = body[0].match(/^\[([ xX])\]\s+/);
        if (task) body[0] = body[0].slice(task[0].length);
        list.items.push({ checked: task ? task[1] !== ' ' : undefined, children: parseBlocks(body.join('\n')) });
        if (j > i) break;
      }
      list.tight = !loose;
      blocks.push(list);
      continue;
    }

    if (isTableStart(lines, i)) {
      const align = splitRow(lines[i + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : ''));
      const width = align.length;
      const row = (source) => {
        const cells = splitRow(source).slice(0, width);
        while (cells.length < width) cells.push('');
        return cells.map(parseInline);
      };
      const header = row(lines[i]);
      const rows = [];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|') && !interrupts(lines, i)) rows.push(row(lines[i++]));
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    const body = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines, i)) body.push(lines[i++].trim());
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
}

// Finds the closing delimiter for emphasis opened at `from`, skipping code spans.
function findClose(src, from, delim) {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') {
      const run = src.slice(i).match(/^`+/)[0];
      const end = src.indexOf(run, i + run.length);
      if (end !== -1) { i = end + run.length - 1; continue; }
    }
    if (!src.startsWith(delim, i) || /\s/.test(src[i - 1])) continue;
    if (delim.length === 1 && (src[i + 1] === delim || src[i - 1] === delim)) { if (src[i + 1] === delim) i++; continue; }
    if (delim[0] === '_' && /[\p{L}\p{N}]/u.test(src[i + delim.length] || '')) continue;
    return i;
  }
  return -1;
}

function linkAt(src, i) {
  let depth = 0;
  let close = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === '[') depth++;
    else if (src[j] === ']' && --depth === 0) { close = j; break; }
  }
  if (close === -1 || src[close + 1] !== '(') return null;
  depth = 0;
  for (let j = close + 1; j < src.length; j++) {
    if (src[j] === '\n') return null;
    if (src[j] === '(') depth++;
    else if (src[j] === ')' && --depth === 0) {
      const target = src.slice(close + 2, j).trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, '').replace(/^<(.*)>$/, '$1');
      return { label: src.slice(i + 1, close), href: target, end: j + 1 };
    }
  }
  return null;
}

export function parseInline(src) {
  src = String(src ?? '');
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push({ type: 'text', text }); text = ''; } };
  const push = (node) => { flush(); out.push(node); };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && ESCAPABLE.test(src[i + 1] || '')) { text += src[i + 1]; i += 2; continue; }
    if (c === '\\' && src[i + 1] === '\n') { push({ type: 'break' }); i += 2; continue; }
    if (c === '\n') { text = text.replace(/ +$/, ''); push({ type: 'break' }); i++; while (src[i] === ' ') i++; continue; }

    if (c === '`') {
      const run = src.slice(i).match(/^`+/)[0];
      let end = src.indexOf(run, i + run.length);
      while (end !== -1 && src[end + run.length] === '`') end = src.indexOf(run, end + run.length + 1);
      if (end !== -1) {
        let code = src.slice(i + run.length, end).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        push({ type: 'code', text: code });
        i = end + run.length;
      } else { text += run; i += run.length; }
      continue;
    }

    if (c === '[') {
      const link = linkAt(src, i);
      if (link) { push({ type: 'link', href: link.href, children: parseInline(link.label) }); i = link.end; continue; }
    }

    if (c === '<') {
      const auto = src.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i);
      if (auto) { push({ type: 'link', href: auto[1], children: [{ type: 'text', text: auto[1] }] }); i += auto[0].length; continue; }
    }

    if ((c === 'h' || c === 'w') && !/[\p{L}\p{N}]/u.test(src[i - 1] || '')) {
      const bare = src.slice(i).match(/^(?:https?:\/\/|www\.)[^\s<]+/i);
      if (bare) {
        let url = bare[0].replace(/[.,;:!?'"*_~]+$/, '');
        while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
        push({ type: 'link', href: url.startsWith('www.') ? `https://${url}` : url, children: [{ type: 'text', text: url }] });
        i += url.length;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const double = src[i + 1] === c;
      const delim = double ? c + c : c;
      const opensWord = !(c === '_' && /[\p{L}\p{N}]/u.test(src[i - 1] || ''));
      const next = src[i + delim.length];
      if ((c !== '~' || double) && opensWord && next && !/\s/.test(next) && !(delim.length === 1 && next === c)) {
        const end = findClose(src, i + delim.length, delim);
        if (end > i + delim.length) {
          const type = c === '~' ? 'strike' : double ? 'strong' : 'em';
          push({ type, children: parseInline(src.slice(i + delim.length, end)) });
          i = end + delim.length;
          continue;
        }
      }
      const run = src.slice(i).match(new RegExp(`^\\${c}+`))[0];
      text += run;
      i += run.length;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

// Links resolve to web URLs or workspace paths; anything else (javascript:, data:, …) stays text.
export function linkTarget(href) {
  const value = String(href ?? '').trim();
  if (/^(?:https?:|mailto:)/i.test(value)) return { kind: 'url', href: value };
  if (!value || /^[a-z][\w+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('#')) return null;
  const path = value.replace(/^\.\//, '').replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, '');
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch {}
  return decoded ? { kind: 'file', path: decoded } : null;
}
