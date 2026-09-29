import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { record, textField } from '../../../prototypes/owned/src/schema.mjs';
import { ToolError } from '../../../prototypes/owned/src/kernel.mjs';

const exec = promisify(execFile);
const list = (items, minItems, maxItems) => ({ type: 'array', items, minItems, maxItems });
const int = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const bool = { type: 'boolean' };
const fileContent = record({ path: textField, content: textField });
const change = record({ path: textField, before: textField, after: textField });
const tool = (name, description, input, output, idempotency = 'idempotent') => ({
  name, version: '1.0.0', description, input_schema: record(input), output_schema: record(output),
  error_schema: record({ message: textField }), effects: [], idempotency,
});

// SHOUT's host tool catalog for skills. It is frozen per run and doubles as the
// ALLEN compiler's tool contract: `tools.workspace.read.call({ path })`, effect
// `tool.workspace.read@1`. Writes, shell commands and edits require the user's
// approval inside the host, whatever the calling program does.
export const shoutTools = [
  tool('git.run', 'Run a read-only git subcommand (status, diff, log, show, branch, ls-files, blame, grep, rev-parse, shortlog, describe) in the workspace.',
    { args: list(textField, 1, 32) }, { exit_code: int(-1, 255), output: textField, truncated: bool }),
  tool('shell.run', 'Ask the user to approve one shell command, then run it in the workspace (120 s limit). Returns approved=false without running if declined.',
    { command: textField, reason: textField }, { approved: bool, exit_code: int(-1, 255), output: textField }, 'non_idempotent'),
  tool('skills.check', 'Compile ALLEN skill source against this catalog and return compiler diagnostics.',
    { source: textField }, { ok: bool, diagnostics: textField }),
  tool('skills.list', 'List the skills visible in this session (workspace, user and built-in), including ones that fail to compile.',
    {}, { skills: list(record({ name: textField, description: textField, args: textField, scope: textField, ok: bool }), 0, 500) }),
  tool('skills.guide', 'Return the SHOUT skill authoring guide: skill format, entry input, this tool catalog and ALLEN syntax essentials.',
    {}, { guide: textField }),
  tool('tests.run', 'Run the session\'s configured test command.',
    {}, { exit_code: int(-1, 255), output: textField, passed: bool, skipped: bool }, 'non_idempotent'),
  tool('workspace.edit', 'Propose exact snippet edits (each find text must occur once; empty find creates a file). Shows the diff for user approval and applies it if accepted. If the edits cannot be matched, nothing is shown and `problem` explains why (empty otherwise).',
    { summary: textField, edits: list(record({ path: textField, find: textField, replace: textField }), 1, 64) },
    { accepted: bool, changed: list(textField, 0, 64), problem: textField }, 'non_idempotent'),
  tool('workspace.inspect', 'Read every eligible text file in a small workspace (fails above 200 files or 512 KiB).',
    {}, { files: list(fileContent, 0, 256), summary: textField }),
  tool('workspace.list', 'List eligible text files in the workspace, relative paths in sorted order.',
    {}, { files: list(textField, 0, 5000), truncated: bool }),
  tool('workspace.read', 'Read one workspace text file.', { path: textField }, { content: textField }),
  tool('workspace.read_many', 'Read several workspace text files. Paths that cannot be read are listed in `skipped` with the reason.', { paths: list(textField, 1, 64) }, { files: list(fileContent, 0, 64), skipped: list(textField, 0, 64) }),
  tool('workspace.search', 'Literal, case-sensitive search of workspace text files; one match per line.',
    { query: textField, max_results: int(1, 500) },
    { matches: list(record({ path: textField, line: int(1, 10_000_000), text: textField }), 0, 500), truncated: bool }),
  tool('workspace.write', 'Propose full-file replacements (before must equal current content; empty for new files). Shows the diff for user approval and applies it if accepted.',
    { summary: textField, changes: list(change, 1, 32) }, { accepted: bool, changed: list(textField, 0, 32) }, 'non_idempotent'),
];

// git.run's subcommands and the options each accepts, by exact spelling: git also takes any unambiguous
// abbreviation (`--open-files-in-page` for `--open-files-in-pager`), so every other option is refused.
// `flags` stand alone (single-letter ones may be clustered, as in -sb); `values` take `--name=value`;
// `short` options take a value attached (-n5) or as the next argument (-n 5), except that git reads -U's
// optional value only attached: -U 3 is passed on as -U3; `count` allows -<n>.
const words = text => text.split(/\s+/).filter(Boolean);
const options = ({ flags = '', values = '', short = '', count = false, positional = true }) => ({ flags: new Set(words(flags)), values: new Set(words(values)), short: new Set(words(short)), count, positional });
const DIFF_FLAGS = `-p -u --patch -s --no-patch --raw --patch-with-raw --patch-with-stat --stat --numstat --shortstat --compact-summary --summary --name-only --name-status -z --no-color
  --word-diff --no-renames -M -C -D --find-renames --find-copies --find-copies-harder -w -b --ignore-all-space --ignore-space-change --ignore-blank-lines --ignore-space-at-eol
  --ignore-cr-at-eol --minimal --patience --histogram --full-index --binary -R -a --text --check -W --function-context --no-prefix --default-prefix --irreversible-delete
  --pickaxe-all --pickaxe-regex --relative --no-relative --no-ext-diff --no-textconv --abbrev`;
const DIFF_VALUES = '--stat --unified --inter-hunk-context --diff-filter --diff-algorithm --abbrev --word-diff --relative --find-renames --find-copies --src-prefix --dst-prefix --line-prefix --stat-width --stat-count';
const LOG_FLAGS = `--oneline --graph --decorate --no-decorate --all --branches --tags --remotes --first-parent --no-merges --merges --reverse --date-order --topo-order --author-date-order
  --follow --abbrev-commit --no-abbrev-commit --full-history --simplify-by-decoration --left-right --cherry-pick --cherry-mark --cherry --boundary --ancestry-path --source
  --use-mailmap --mailmap --no-notes --regexp-ignore-case -i --all-match --invert-grep -E -F -P --extended-regexp --fixed-strings --basic-regexp --perl-regexp --relative-date
  -m -c --cc --no-walk --do-walk --parents --children --walk-reflogs -g --dense --sparse --show-pulls --full-diff --pretty`;
const LOG_VALUES = '--author --committer --grep --since --after --until --before --max-count --skip --date --format --pretty --decorate --branches --tags --remotes --glob --exclude --diff-merges --max-parents --min-parents --grep-reflog --no-walk';
const history = options({ flags: `${DIFF_FLAGS} ${LOG_FLAGS}`, values: `${DIFF_VALUES} ${LOG_VALUES}`, short: '-U -S -G -n', count: true });
const GIT_OPTIONS = {
  status: options({ flags: '-s --short -b --branch --porcelain --long --show-stash -u --untracked-files -z --null --no-renames --renames --find-renames --ahead-behind --no-ahead-behind --ignored', values: '--porcelain --untracked-files --ignored --find-renames' }),
  diff: options({ flags: `${DIFF_FLAGS} --exit-code --quiet --cached --staged --merge-base`, values: DIFF_VALUES, short: '-U -S -G' }),
  log: history, show: history,
  // Any positional argument would create a branch, so `branch` only lists.
  branch: options({ flags: '-a -r -v -vv -l --all --remotes --list --verbose --show-current --no-color --contains --no-contains --merged --no-merged --omit-empty', values: '--contains --no-contains --merged --no-merged --sort --format --points-at', positional: false }),
  'ls-files': options({ flags: '-c --cached -d --deleted -m --modified -o --others -i --ignored -s --stage -u --unmerged -k --killed -z -t -v -f --exclude-standard --directory --no-empty-directory --full-name --eol --deduplicate --error-unmatch --abbrev --sparse', values: '--exclude --format --abbrev', short: '-x' }),
  blame: options({ flags: '-l -t -s -e -w -f -n -p -c -b -M -C --root --show-stats --show-name --show-number --show-email --porcelain --line-porcelain --incremental --minimal --no-textconv --reverse --first-parent --abbrev', values: '--date --abbrev --ignore-rev --since', short: '-L' }),
  grep: options({ flags: `-i --ignore-case -I -w --word-regexp -v --invert-match -h -H --full-name -E --extended-regexp -G --basic-regexp -F --fixed-strings -P --perl-regexp -n --line-number
    --column -l --files-with-matches --name-only -L --files-without-match -c --count -o --only-matching -p --show-function -W --function-context --cached --untracked --no-exclude-standard
    --exclude-standard -a --text --break --heading --all-match -q --quiet -z --null --no-color --no-textconv -r --recursive --no-recursive --and --or --not`,
  values: '--max-depth --context --after-context --before-context --max-count --threads', short: '-e -A -B -C -m', count: true }),
  'rev-parse': options({ flags: `--abbrev-ref --verify -q --quiet --symbolic --symbolic-full-name --show-toplevel --show-prefix --show-cdup --git-dir --absolute-git-dir --git-common-dir
    --is-inside-work-tree --is-inside-git-dir --is-bare-repository --is-shallow-repository --show-superproject-working-tree --show-object-format --all --branches --tags --remotes --short`,
  values: '--short --abbrev-ref --branches --tags --remotes --glob' }),
  shortlog: options({ flags: '-n --numbered -s --summary -e --email -c --committer --all --no-merges --merges --first-parent --branches --tags --remotes', values: '--group --format --since --after --until --before --author --committer --max-count --branches --tags --remotes' }),
  describe: options({ flags: '--tags --all --long --always --dirty --broken --first-parent --exact-match --contains', values: '--abbrev --match --exclude --candidates --dirty --broken' }),
};
const READ_ONLY_GIT = new Set(Object.keys(GIT_OPTIONS));
const escapesWorkspace = arg => arg.startsWith('/') || arg.startsWith('~') || arg.split(/[/:]/).includes('..');
// Built-in pretty formats; any other name could be a `pretty.<name>` alias from the repository's config.
const PRETTY = new Set(['oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'email', 'mboxrd', 'raw']);
function checkGitValue(name, value) {
  // Signature placeholders run a signature-verification program.
  if (['--format', '--pretty', '--group'].includes(name) && /%G|%\(signature/i.test(value)) throw new ToolError('Signature placeholders are not allowed in git.run formats');
  if (['--format', '--pretty'].includes(name) && !PRETTY.has(value) && !/^t?format:/.test(value) && !value.includes('%')) throw new ToolError(`Unknown git format ${value}; use a built-in format name or a format string`);
  if (name === '--relative' && escapesWorkspace(value)) throw new ToolError('git.run arguments cannot name paths outside the workspace');
}
// Short options whose value git reads only when attached; git takes them alone with a default otherwise.
const ATTACHED = new Set(['-U']);
/** Checks git.run's arguments against the subcommand's allowlist and returns them as git should get them. */
function checkGitArgs(subcommand, args) {
  const spec = GIT_OPTIONS[subcommand];
  const refuse = arg => new ToolError(`git ${subcommand} does not accept ${arg} in git.run. It accepts these read-only options, spelled in full: ${[...spec.flags, ...[...spec.values].map(name => `${name}=…`), ...[...spec.short].map(name => (ATTACHED.has(name) ? `${name}<n>` : `${name} …`)), ...(spec.count ? ['-<n>'] : [])].join(' ')}`);
  const checked = [];
  for (let index = 0, paths = false; index < args.length; index++) {
    const arg = args[index];
    checked.push(arg);
    if (paths || arg === '--' || !arg.startsWith('-') || arg === '-') {
      if (!spec.positional) throw new ToolError('git.run only lists branches; creating, deleting or configuring branches is not allowed');
      if (arg === '--' && !paths) { paths = true; continue; }
      if (escapesWorkspace(arg)) throw new ToolError('git.run arguments cannot name paths outside the workspace');
      continue;
    }
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 2) {
      if (!spec.values.has(arg.slice(0, equals))) throw refuse(arg);
      checkGitValue(arg.slice(0, equals), arg.slice(equals + 1));
    } else if (spec.flags.has(arg) || (spec.count && /^-\d+$/.test(arg))) continue;
    else if (/^-[A-Za-z]{2,}$/.test(arg) && [...arg.slice(1)].every(letter => spec.flags.has(`-${letter}`))) continue;
    else if (spec.short.has(arg.slice(0, 2))) {
      if (arg.length > 2) continue;
      if (ATTACHED.has(arg)) { if (/^\d+$/.test(args[index + 1] ?? '')) checked[checked.length - 1] = `${arg}${args[++index]}`; continue; }
      if (++index >= args.length) throw new ToolError(`${arg} needs a value`);
      checked.push(args[index]);
    } else throw refuse(arg);
  }
  return checked;
}
// Every git.run ignores programs the repository's own config names: pager, fsmonitor, hooks and signature
// checks here; textconv and external diff drivers by flag (GIT_FLAGS); filters as found (repositoryFilters).
// It never fetches, so a partial clone's missing objects cannot start a configured transport.
const GIT_CONFIG = [['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['core.pager', 'cat'], ['core.quotePath', 'false'], ['diff.mnemonicPrefix', 'false'], ['diff.noprefix', 'false'],
  ['diff.ignoreSubmodules', 'dirty'], ['status.submoduleSummary', 'false'], ['log.showSignature', 'false'], ...['gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program'].map(key => [key, '/dev/null'])];
const GIT_FLAGS = { diff: ['--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'], show: ['--no-ext-diff', '--no-textconv'], log: ['--no-ext-diff', '--no-textconv'], blame: ['--no-textconv'], grep: ['--no-textconv'], status: ['--ignore-submodules=dirty'] };
// Config goes in through the environment (no parsing of `-c name=value`); inherited GIT_* variables are dropped.
function gitEnv(config) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  config.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return { ...env, GIT_CONFIG_COUNT: String(config.length), GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none', GIT_TERMINAL_PROMPT: '0' };
}
const runGit = (args, { cwd, signal, env, timeout = 30_000 }) => {
  const running = exec('git', args, { cwd, signal, env, timeout, maxBuffer: 16 * 1024 * 1024 });
  running.child.stdin?.end(); // `shortlog` without a revision would otherwise wait for input
  return running;
};
// Filter programs (clean, smudge, process) that the repository's own config defines, including files it
// includes, are switched off; the user's global and system config are trusted.
async function repositoryFilters(cwd, signal) {
  const { stdout } = await runGit(['config', '--list', '--name-only', '--show-scope', '--includes', '-z'], { cwd, signal, env: gitEnv(GIT_CONFIG), timeout: 10_000 });
  const parts = stdout.split('\0'); const names = new Set();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const driver = /^filter\.(.+)\.(?:clean|smudge|process)$/.exec(parts[index + 1]);
    if (driver && ['local', 'worktree'].includes(parts[index])) names.add(driver[1]);
  }
  return [...names].flatMap(name => [...['clean', 'smudge', 'process'].map(key => [`filter.${name}.${key}`, '']), [`filter.${name}.required`, 'false']]);
}
// Tool results travel in one JOSH frame (1 MiB), so large text is capped by its encoded size.
const RESULT_TEXT_BYTES = 700 * 1024;
const encodedBytes = text => Buffer.byteLength(JSON.stringify(text));
function capText(text, budget = RESULT_TEXT_BYTES) {
  if (encodedBytes(text) <= budget) return text;
  let end = Math.min(text.length, budget);
  while (end > 0 && encodedBytes(text.slice(0, end)) > budget) end = Math.floor(end * 0.8);
  return text.slice(0, end);
}
const capGitOutput = (exit_code, text) => { const output = capText(text); return { exit_code, output, truncated: output.length < text.length }; };
const clamp = value => Math.max(-1, Math.min(255, value));
// JSON escaping can multiply text (a control character becomes six bytes), so whole results are measured encoded.
function refuseLarge(what, value, hint) {
  const bytes = encodedBytes(value);
  if (bytes > RESULT_TEXT_BYTES) throw new ToolError(`${what} is ${Math.ceil(bytes / 1024)} KiB once encoded, over the ${RESULT_TEXT_BYTES / 1024} KiB limit for one tool result${hint}`);
  return value;
}
// Listings and searches drop entries from the end instead, and say they were truncated.
function fitList(value, key) {
  let items = value[key];
  while (items.length && encodedBytes({ ...value, [key]: items }) > RESULT_TEXT_BYTES) items = items.slice(0, Math.floor(items.length * 0.9));
  return items.length === value[key].length ? value : { ...value, [key]: items, truncated: true };
}

/**
 * Builds the tool handler for one skill run. `host` supplies the workspace,
 * an approval gate, and skill checking/guide text.
 */
export function createToolHandler(host) {
  const { workspace } = host;
  const guard = async operation => {
    try { return await operation(); }
    catch (error) {
      if (error.name === 'AbortError' || error instanceof ToolError) throw error;
      throw new ToolError(error.message);
    }
  };
  // Changes are checked (count, sizes, paths, current content) before the user is asked, and again when applied.
  const applyApproved = async (summary, changes, signal) => {
    if (!changes.length) return { accepted: true, changed: [] };
    await workspace.preflight(changes, { signal });
    const accepted = await host.approve({ title: `Apply ${changes.length} file change${changes.length === 1 ? '' : 's'}?`, summary, changes, signal });
    if (!accepted) return { accepted: false, changed: [] };
    const result = await workspace.apply(changes, { signal });
    host.changed?.(changes, result.changed);
    return { accepted: true, changed: result.changed };
  };
  return (name, input, { signal }) => guard(async () => {
    signal.throwIfAborted();
    switch (name) {
      case 'workspace.list': return fitList(await workspace.list({ limit: 5000 }), 'files');
      case 'workspace.read': return refuseLarge(input.path, { content: await workspace.read(input.path) }, '; control characters and other escaped text take several bytes each');
      case 'workspace.read_many': {
        const results = await Promise.all(input.paths.map(async path => { try { return { path, content: await workspace.read(path) }; } catch (error) { return { path, error: error.message }; } }));
        const files = []; const skipped = []; let budget = RESULT_TEXT_BYTES;
        for (const file of results) {
          if (file.error) { skipped.push(`${file.path}: ${file.error}`); continue; }
          const bytes = encodedBytes(file.content) + encodedBytes(file.path) + 32;
          if (bytes > budget) { skipped.push(`${file.path}: over the ${RESULT_TEXT_BYTES / 1024} KiB result limit for one call; read it separately`); continue; }
          budget -= bytes; files.push(file);
        }
        return { files, skipped };
      }
      case 'workspace.search': return fitList(await workspace.search(input.query, { maxResults: input.max_results }), 'matches');
      case 'workspace.inspect': return refuseLarge('The workspace snapshot', await workspace.inspect(), '. Use workspace.list and workspace.read_many instead.');
      case 'workspace.write': return applyApproved(input.summary, input.changes, signal);
      case 'workspace.edit': {
        // Unmatched or unappliable edits are expected model mistakes; report them as data the program can feed back.
        let changes;
        try { changes = await workspace.planEdits(input.edits); if (changes.length) await workspace.preflight(changes, { signal }); }
        catch (error) { if (error.name === 'AbortError') throw error; return { accepted: false, changed: [], problem: error.message }; }
        return { ...(await applyApproved(input.summary, changes, signal)), problem: '' };
      }
      case 'tests.run': {
        const result = await workspace.test({ signal });
        return { exit_code: clamp(result.exitCode), output: result.output, passed: Boolean(result.passed), skipped: Boolean(result.skipped) };
      }
      case 'git.run': {
        const [subcommand, ...rest] = input.args;
        if (!READ_ONLY_GIT.has(subcommand)) throw new ToolError(`git ${subcommand} is not allowed; git.run is read-only (${[...READ_ONLY_GIT].join(', ')})`);
        const args = checkGitArgs(subcommand, rest);
        try {
          const filters = await repositoryFilters(workspace.path, signal);
          const { stdout, stderr } = await runGit(['--no-pager', subcommand, ...(GIT_FLAGS[subcommand] ?? []), ...args], { cwd: workspace.path, signal, env: gitEnv([...GIT_CONFIG, ...filters]) });
          return capGitOutput(0, stdout + stderr);
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          if (typeof error.code !== 'number') throw new ToolError(error.message);
          return capGitOutput(clamp(error.code), `${error.stdout ?? ''}${error.stderr ?? ''}`);
        }
      }
      case 'shell.run': {
        const approved = await host.approve({ title: 'Run shell command?', summary: input.reason, command: input.command, signal });
        if (!approved) return { approved: false, exit_code: -1, output: 'The user declined this command.' };
        const result = await workspace.run(input.command, { signal, timeoutMs: 120_000 });
        return { approved: true, exit_code: clamp(result.exitCode), output: result.output };
      }
      case 'skills.check': {
        const result = await host.checkSkill(input.source);
        return { ok: result.ok, diagnostics: result.ok ? '' : result.diagnostics.map(d => `${d.line}:${d.column}: error[${d.code}]: ${d.message}`).join('\n') };
      }
      case 'skills.guide': return { guide: await host.skillGuide() };
      case 'skills.list': return { skills: (await host.listSkills()).map(({ name, description, args, scope, ok }) => ({ name, description, args, scope, ok })) };
      default: throw new Error(`Unknown SHOUT tool: ${name}`);
    }
  });
}
