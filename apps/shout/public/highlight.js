// Small dependency-free syntax highlighter. It produces [className, text] tokens only;
// callers render them with textContent, so file content can never become markup.
const C_KEYWORDS = 'as async await break case catch class const continue crate debugger default defer delete do dyn else enum export extends extern false finally fn for from func function go if impl implements import in instanceof interface let loop manifest match mod move mut namespace new of package private protected pub public readonly record ref return returns effects select self static struct super switch this throw trait try type typeof use var void where while with yield'.split(' ');
const ALLEN_KEYWORDS = 'as async await capabilities effects else entry enum export false fn for if import in let loop manifest match mut prompt record return returns stop tools true type while'.split(' ');
const PY_KEYWORDS = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield'.split(' ');
const SH_KEYWORDS = 'case do done elif else esac exit export fi for function if in local readonly return set shift source then unset until while'.split(' ');
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity', 'Self', 'Some', 'Ok', 'Err']);
const STRING_DQ = '"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?';
const STRING_SQ = "'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?";
const NUMBER = '\\b(?:0[xob][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)n?\\b';
const IDENT = '[A-Za-z_$][\\w$]*';

const grammars = {
  c: { keywords: C_KEYWORDS, rules: [['com', '\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))'], ['com', '\\/\\/[^\\n]*'], ['str', '`(?:\\\\[\\s\\S]|[^`\\\\])*`?'], ['str', STRING_DQ], ['str', STRING_SQ], ['num', NUMBER], ['ident', IDENT]] },
  allen: { keywords: ALLEN_KEYWORDS, rules: [['com', '\\/\\/[^\\n]*'], ['str', STRING_DQ], ['num', NUMBER], ['ident', IDENT]] },
  py: { keywords: PY_KEYWORDS, rules: [['com', '#[^\\n]*'], ['str', '"""[\\s\\S]*?(?:"""|(?![\\s\\S]))'], ['str', "'''[\\s\\S]*?(?:'''|(?![\\s\\S]))"], ['str', STRING_DQ], ['str', STRING_SQ], ['kw', '@[\\w.]+'], ['num', NUMBER], ['ident', IDENT]] },
  sh: { keywords: SH_KEYWORDS, rules: [['com', '(?:^|(?<=\\s))#[^\\n]*'], ['str', STRING_DQ], ['str', "'[^']*'?"], ['prop', '\\$\\{[^}\\n]*\\}|\\$[\\w@#?*!-]+'], ['num', NUMBER], ['ident', '[A-Za-z_][\\w-]*']] },
  conf: { keywords: [], rules: [['com', '(?:^|(?<=\\s))[#;][^\\n]*'], ['prop', '^[ \\t-]*[\\w.$"\'-]+(?=[ \\t]*[:=])'], ['kw', '^\\s*\\[[^\\]\\n]*\\]'], ['str', STRING_DQ], ['str', STRING_SQ], ['num', NUMBER], ['ident', IDENT]] },
  json: { keywords: [], rules: [['prop', '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)'], ['str', STRING_DQ], ['num', '-?' + NUMBER], ['ident', IDENT]] },
  css: { keywords: [], rules: [['com', '\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))'], ['str', STRING_DQ], ['str', STRING_SQ], ['kw', '@[\\w-]+'], ['prop', '(?<=[{;]\\s*)-{0,2}[a-zA-Z][\\w-]*(?=\\s*:)'], ['num', '#[\\da-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:%|[a-z]+)?']] },
  html: { keywords: [], rules: [['com', '<!--[\\s\\S]*?(?:-->|(?![\\s\\S]))'], ['kw', '<\\/?[\\w:-]+|\\/?>'], ['prop', '[\\w:-]+(?==)'], ['str', STRING_DQ], ['str', STRING_SQ]] },
  md: { keywords: [], rules: [['str', '```[\\s\\S]*?(?:```|(?![\\s\\S]))'], ['kw', '^#{1,6}[^\\n]*'], ['str', '`[^`\\n]+`'], ['type', '\\*\\*[^*\\n]+\\*\\*'], ['fn', '\\[[^\\]\\n]*\\]\\([^)\\n]*\\)'], ['com', '^>[^\\n]*'], ['prop', '^\\s*(?:[-*+]|\\d+\\.)(?=\\s)']] },
};
const extensions = {
  js: 'c', mjs: 'c', cjs: 'c', jsx: 'c', ts: 'c', tsx: 'c', mts: 'c', cts: 'c', rs: 'c', go: 'c', java: 'c', kt: 'c', swift: 'c', c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cs: 'c', allen: 'allen', josh: 'allen', scala: 'c', dart: 'c', php: 'c',
  py: 'py', pyi: 'py', rb: 'sh', sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', env: 'conf',
  json: 'json', jsonc: 'c', json5: 'c', lock: 'json', yml: 'conf', yaml: 'conf', toml: 'conf', ini: 'conf', cfg: 'conf', conf: 'conf', properties: 'conf', gitignore: 'conf', npmrc: 'conf', dockerignore: 'conf', editorconfig: 'conf',
  css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', md: 'md', markdown: 'md', mdx: 'md',
};
const names = { makefile: 'sh', dockerfile: 'sh', '.env': 'conf', '.gitignore': 'conf' };
const labels = { allen: 'ALLEN', c: 'Code', py: 'Python', sh: 'Shell', conf: 'Config', json: 'JSON', css: 'CSS', html: 'Markup', md: 'Markdown', text: 'Plain text' };
const specific = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', rs: 'Rust', go: 'Go', java: 'Java', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', allen: 'ALLEN', yml: 'YAML', yaml: 'YAML', toml: 'TOML', rb: 'Ruby', scss: 'SCSS', svg: 'SVG', xml: 'XML' };
const compiled = new Map();

export function languageFor(nameOrPath = '') {
  const base = String(nameOrPath).split('/').pop().toLowerCase();
  if (names[base]) return names[base];
  const ext = base.includes('.') ? base.split('.').pop() : base;
  return extensions[ext] || 'text';
}
export function languageLabel(nameOrPath = '') {
  const base = String(nameOrPath).split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : base;
  return specific[ext] || labels[languageFor(nameOrPath)];
}
function regexFor(lang) {
  if (!compiled.has(lang)) compiled.set(lang, new RegExp(grammars[lang].rules.map(([, source]) => `(${source})`).join('|'), 'gm'));
  return compiled.get(lang);
}
export function tokenize(text, lang) {
  const source = String(text);
  const grammar = grammars[lang];
  if (!grammar) return [['', source]];
  const keywords = new Set(grammar.keywords);
  const regex = regexFor(lang);
  const tokens = [];
  let last = 0;
  regex.lastIndex = 0;
  for (let match; (match = regex.exec(source));) {
    if (!match[0]) { regex.lastIndex++; continue; }
    if (match.index > last) tokens.push(['', source.slice(last, match.index)]);
    let kind = grammar.rules[match.slice(1).findIndex((group) => group !== undefined)][0];
    if (kind === 'ident') {
      const word = match[0];
      const after = source.slice(regex.lastIndex).match(/^\s*(.)/)?.[1];
      kind = keywords.has(word) ? 'kw' : LITERALS.has(word) ? 'lit' : after === '(' ? 'fn' : /^[A-Z][a-z]/.test(word) ? 'type' : '';
    }
    tokens.push([kind, match[0]]);
    last = regex.lastIndex;
  }
  if (last < source.length) tokens.push(['', source.slice(last)]);
  return tokens;
}
// Splits tokens into per-line token lists so multi-line comments and strings keep their color on every line.
export function highlightLines(text, lang) {
  const lines = [[]];
  for (const [kind, value] of tokenize(text, lang)) {
    const parts = value.split('\n');
    parts.forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines.at(-1).push([kind, part]);
    });
  }
  return lines;
}
export function renderTokens(parent, tokens) {
  for (const [kind, value] of tokens) {
    if (!kind) { parent.append(document.createTextNode(value)); continue; }
    const span = document.createElement('span');
    span.className = `tok-${kind}`;
    span.textContent = value;
    parent.append(span);
  }
  return parent;
}
