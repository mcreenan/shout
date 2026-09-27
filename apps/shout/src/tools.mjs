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

const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'blame', 'grep', 'rev-parse', 'shortlog', 'describe']);
// Options that write files, run configured external programs, or read outside the repository.
const UNSAFE_GIT_ARG = /^(?:--output|--ext-diff|--textconv|--exec|--upload-pack|--open-files-in-pager|-O|--no-index|--contents)/;
// `git branch` writes with any positional argument or most options; only listing forms are allowed.
const BRANCH_LIST_ARG = /^(?:-a|-r|-v|-vv|-l|--all|--remotes|--list|--verbose|--show-current|--no-color|--(?:contains|no-contains|merged|no-merged|sort|format|points-at)=.+)$/;
const escapesWorkspace = arg => arg.startsWith('/') || arg.startsWith('~') || arg.split(/[/:]/).includes('..');
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
  const applyApproved = async (summary, changes, signal) => {
    if (!changes.length) return { accepted: true, changed: [] };
    const accepted = await host.approve({ title: `Apply ${changes.length} file change${changes.length === 1 ? '' : 's'}?`, summary, changes, signal });
    if (!accepted) return { accepted: false, changed: [] };
    const result = await workspace.apply(changes, { signal });
    host.changed?.(changes, result.changed);
    return { accepted: true, changed: result.changed };
  };
  return (name, input, { signal }) => guard(async () => {
    signal.throwIfAborted();
    switch (name) {
      case 'workspace.list': return workspace.list({ limit: 5000 });
      case 'workspace.read': return { content: await workspace.read(input.path) };
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
      case 'workspace.search': return workspace.search(input.query, { maxResults: input.max_results });
      case 'workspace.inspect': return workspace.inspect();
      case 'workspace.write': return applyApproved(input.summary, input.changes, signal);
      case 'workspace.edit': {
        // Unmatched edits are expected model mistakes; report them as data the program can feed back.
        let changes;
        try { changes = await workspace.planEdits(input.edits); }
        catch (error) { return { accepted: false, changed: [], problem: error.message }; }
        return { ...(await applyApproved(input.summary, changes, signal)), problem: '' };
      }
      case 'tests.run': {
        const result = await workspace.test({ signal });
        return { exit_code: clamp(result.exitCode), output: result.output, passed: Boolean(result.passed), skipped: Boolean(result.skipped) };
      }
      case 'git.run': {
        const [subcommand, ...rest] = input.args;
        if (!READ_ONLY_GIT.has(subcommand)) throw new ToolError(`git ${subcommand} is not allowed; git.run is read-only (${[...READ_ONLY_GIT].join(', ')})`);
        if (rest.some(arg => UNSAFE_GIT_ARG.test(arg))) throw new ToolError('That git option is not allowed in git.run');
        if (rest.some(escapesWorkspace)) throw new ToolError('git.run arguments cannot name paths outside the workspace');
        if (subcommand === 'branch' && rest.some(arg => !BRANCH_LIST_ARG.test(arg))) throw new ToolError('git.run only lists branches; creating, deleting or configuring branches is not allowed');
        try {
          const { stdout, stderr } = await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.noprefix=false', subcommand, ...(['diff', 'show', 'log'].includes(subcommand) ? ['--no-ext-diff', '--no-textconv'] : []), ...rest],
            { cwd: workspace.path, signal, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, env: { ...process.env, GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '' } });
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
