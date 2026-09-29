// Markdown to DOM, used by the chat and the Flow canvas. Built from nodes only; model output cannot become HTML.
import { parseBlocks, linkTarget } from './markdown.js';
import { languageFor, highlightLines, renderTokens } from './highlight.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function codeBlock(text, lang) {
  const pre = el('pre', 'code-block');
  const code = el('code');
  renderTokens(code, highlightLines(text, lang).flatMap((tokens, i) => (i ? [['', '\n'], ...tokens] : tokens)));
  pre.append(code);
  return pre;
}
function appendInline(container, nodes, options) {
  for (const node of nodes) {
    if (node.type === 'text') container.append(node.text);
    else if (node.type === 'break') container.append(el('br'));
    else if (node.type === 'code') container.append(el('code', 'inline-code', node.text));
    else if (node.type === 'link') {
      const target = linkTarget(node.href);
      let link;
      if (target?.kind === 'url') {
        link = el('a');
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else if (target?.kind === 'file') {
        link = el('a', 'file-link');
        link.href = '#';
        link.title = target.path;
        link.addEventListener('click', (event) => { event.preventDefault(); options.openFile?.(target.path); });
      } else link = el('span');
      appendInline(link, node.children, options);
      container.append(link);
    } else {
      const tag = { strong: 'strong', em: 'em', strike: 'del' }[node.type];
      const wrap = el(tag);
      appendInline(wrap, node.children, options);
      container.append(wrap);
    }
  }
}
function appendBlocks(container, blocks, options, tight = false) {
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const node = el(tight ? 'div' : 'p');
      appendInline(node, block.children, options);
      container.append(node);
    } else if (block.type === 'heading') {
      const node = el(`h${Math.min(6, block.level + 2)}`, `md-heading level-${block.level}`);
      appendInline(node, block.children, options);
      container.append(node);
    } else if (block.type === 'code') {
      if (block.lang) container.append(el('div', 'code-language', block.lang));
      container.append(codeBlock(block.text, languageFor(`x.${block.lang || 'txt'}`)));
    } else if (block.type === 'quote') {
      const node = el('blockquote');
      appendBlocks(node, block.children, options);
      container.append(node);
    } else if (block.type === 'list') {
      const list = el(block.ordered ? 'ol' : 'ul', block.tight ? 'tight' : '');
      if (block.ordered && block.start !== 1) list.start = block.start;
      for (const item of block.items) {
        const li = el('li');
        if (item.checked !== undefined) {
          li.className = 'task';
          const box = el('input');
          box.type = 'checkbox';
          box.checked = item.checked;
          box.disabled = true;
          li.append(box);
        }
        appendBlocks(li, item.children, options, block.tight);
        list.append(li);
      }
      container.append(list);
    } else if (block.type === 'table') {
      const scroll = el('div', 'md-table');
      const table = el('table');
      const row = (cells, tag) => {
        const tr = el('tr');
        cells.forEach((cell, index) => {
          const td = el(tag);
          if (block.align[index]) td.style.textAlign = block.align[index];
          appendInline(td, cell, options);
          tr.append(td);
        });
        return tr;
      };
      const head = el('thead');
      head.append(row(block.header, 'th'));
      const body = el('tbody');
      for (const cells of block.rows) body.append(row(cells, 'td'));
      table.append(head, body);
      scroll.append(table);
      container.append(scroll);
    } else if (block.type === 'rule') container.append(el('hr'));
  }
}
/** Renders Markdown into `container`; `openFile(path)` handles links to workspace files. */
export function renderMarkdown(container, text, options = {}) {
  container.classList.add('markdown');
  appendBlocks(container, parseBlocks(text), options);
}
