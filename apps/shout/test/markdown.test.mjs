import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, linkTarget } from '../public/markdown.js';

const types = (blocks) => blocks.map((block) => block.type);

test('block structure covers headings, lists, quotes, tables, rules and fences', () => {
  const blocks = parseBlocks('# Title\n\nText\n\n- a\n- b\n\n> quoted\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n---\n\n```js\nlet x;\n```');
  assert.deepEqual(types(blocks), ['heading', 'paragraph', 'list', 'quote', 'table', 'rule', 'code']);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[4].align, ['', 'right']);
  assert.deepEqual(blocks[6], { type: 'code', lang: 'js', text: 'let x;' });
});

test('lists nest, track tightness and task state, and stop at a different list type', () => {
  const [bullets, numbers] = parseBlocks('- a\n  - nested\n- [x] done\n\n3. three\n4. four');
  assert.equal(bullets.tight, true);
  assert.deepEqual(types(bullets.items[0].children), ['paragraph', 'list']);
  assert.equal(bullets.items[1].checked, true);
  assert.equal(numbers.ordered, true);
  assert.equal(numbers.start, 3);
  assert.equal(parseBlocks('- a\n\n- b')[0].tight, false);
});

test('an unclosed fence runs to the end so streamed replies render as code', () => {
  assert.deepEqual(parseBlocks('Intro\n```py\nprint(1)'), [
    { type: 'paragraph', children: [{ type: 'text', text: 'Intro' }] },
    { type: 'code', lang: 'py', text: 'print(1)' },
  ]);
});

test('fenced code keeps its tabs verbatim, at the top level and inside a list; tabs still indent structure', () => {
  const recipe = 'all:\n\techo "hi"\n\t\tmake -C sub';
  assert.equal(parseBlocks(`\`\`\`make\n${recipe}\n\`\`\``)[0].text, recipe);
  const [list] = parseBlocks(`- build:\n\n  \`\`\`make\n  all:\n  \techo "hi"\n  \`\`\``);
  assert.deepEqual(list.items[0].children.at(-1), { type: 'code', lang: 'make', text: 'all:\n\techo "hi"' });
  const [outer] = parseBlocks('- a\n\t- nested');
  assert.deepEqual(types(outer.items[0].children), ['paragraph', 'list']);
});

test('inline emphasis, code and line breaks', () => {
  assert.deepEqual(parseInline('**bold `a*b`** and _em_ in snake_case_name ~~gone~~\nnext'), [
    { type: 'strong', children: [{ type: 'text', text: 'bold ' }, { type: 'code', text: 'a*b' }] },
    { type: 'text', text: ' and ' },
    { type: 'em', children: [{ type: 'text', text: 'em' }] },
    { type: 'text', text: ' in snake_case_name ' },
    { type: 'strike', children: [{ type: 'text', text: 'gone' }] },
    { type: 'break' },
    { type: 'text', text: 'next' },
  ]);
  assert.deepEqual(parseInline('2 * 3 and \\*literal\\*'), [{ type: 'text', text: '2 * 3 and *literal*' }]);
});

test('links: explicit, bare URLs without trailing punctuation, and safe targets only', () => {
  const [link, , bare] = parseInline('[docs](https://example.com/a) see https://example.com/x_(y).');
  assert.equal(link.href, 'https://example.com/a');
  assert.equal(bare.href, 'https://example.com/x_(y)');
  assert.equal(linkTarget('javascript:alert(1)'), null);
  assert.equal(linkTarget('data:text/html,hi'), null);
  assert.equal(linkTarget('#anchor'), null);
  assert.deepEqual(linkTarget('https://example.com'), { kind: 'url', href: 'https://example.com' });
  assert.deepEqual(linkTarget('./src/app.js#L12'), { kind: 'file', path: 'src/app.js' });
  assert.deepEqual(linkTarget('src/app.js:40'), { kind: 'file', path: 'src/app.js' });
});
