import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, parseCommand } from '../src/session.mjs';
import { parseHeader, resolveLimits, buildInput, renderOutput, RUN_LIMIT_DEFAULTS } from '../src/skills.mjs';

const manifest = (tools = [], capabilities = []) => `manifest {
  language: "0.1"
  entry: main
  capabilities: [${capabilities.join(', ')}]
  tools: { required: [${tools.map(name => `{ name: "${name}", version: ">=1.0.0, <2.0.0" }`).join(', ')}] }
}
`;
const editSkill = `// Append a line to notes.txt
// args: <line>
${manifest(['workspace.edit'])}
export async fn main(args: String) returns String effects [tool.workspace.edit@1] {
  match await tools.workspace.edit.call({ summary: "Add a note", edits: [{ path: "notes.txt", find: "end", replace: string.concat(args, "\\nend") }] }) {
    Ok(result) => if (result.accepted && result.problem == "") { string.concat("changed ", string.join(result.changed, ",")) } else { "declined" }
    Err(_) => "edit failed"
  }
}
`;
const askSkill = `${manifest([], ['user.ask'])}
record Choice { name: String loud: Bool }
record Input { args: String workspace: String }
export async fn main(input: Input) returns String effects [user.ask] {
  let choice = match await user.ask<Choice>(prompt { system: "Pick a name" output: Choice }) {
    Ok(value) => value
    Err(_) => stop("no answer")
  };
  string.join([input.args, choice.name, if (choice.loud) { "!" } else { "." }], " ")
}
`;

async function waitFor(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Timed out waiting for session state');
}
async function setup(t, skills = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'shout-skills-'));
  const workspace = join(dir, 'project');
  await mkdir(join(workspace, '.shout', 'skills'), { recursive: true });
  await writeFile(join(workspace, 'notes.txt'), 'start\nend\n');
  for (const [name, source] of Object.entries(skills)) await writeFile(join(workspace, '.shout', 'skills', `${name}.allen`), source);
  const previousHome = process.env.SHOUT_HOME;
  process.env.SHOUT_HOME = join(dir, 'home');
  const store = await new SessionStore({ stateRoot: join(dir, 'state') }).init();
  const session = await store.create({ workspace });
  t.after(async () => { await store.close(); process.env.SHOUT_HOME = previousHome; if (previousHome === undefined) delete process.env.SHOUT_HOME; await rm(dir, { recursive: true, force: true }); });
  return { store, session, workspace, dir };
}

test('command parsing, header metadata, entry input and output rendering', () => {
  assert.deepEqual(parseCommand('/review  auth module\nplease'), { name: 'review', args: 'auth module\nplease' });
  assert.deepEqual(parseCommand('/test'), { name: 'test', args: '' });
  assert.equal(parseCommand('please /test'), null);
  assert.equal(parseCommand('/Path/to/file'), null);
  assert.deepEqual(parseHeader('// Do a thing.\n// More help.\n// args: <file>\nmanifest {'), { description: 'Do a thing.', help: 'Do a thing.\nMore help.', args: '<file>', limits: {}, limitLines: {}, limitErrors: [] });
  assert.equal(buildInput({ type: 'void' }, { args: 'x' }), null);
  assert.equal(buildInput({ type: 'string' }, { args: 'x' }), 'x');
  assert.deepEqual(buildInput({ type: 'record', fields: { args: {}, workspace: {} } }, { args: 'a', workspace: '/w', history: 'h' }), { args: 'a', workspace: '/w' });
  assert.equal(renderOutput('text'), 'text');
  assert.equal(renderOutput({ summary: 'done', passed: true }), 'done');
  assert.match(renderOutput({ count: 3 }), /```json/);
});

test('workspace skills shadow built-ins, compile errors block the run, unknown commands are explained', async t => {
  const { store, session } = await setup(t, {
    test: `// Workspace override\n${manifest()}\nexport fn main() returns String { "overridden" }\n`,
    broken: `// Broken\n${manifest()}\nexport fn main() returns String { 42 }\n`,
    wrongInput: `${manifest()}\nrecord In { secret: String }\nexport fn main(input: In) returns String { input.secret }\n`,
  });
  const skills = await store.skills.list(session.data.workspace);
  assert.equal(skills.find(skill => skill.name === 'test').scope, 'workspace');
  const broken = skills.find(skill => skill.name === 'broken');
  assert.equal(broken.ok, false); assert.equal(broken.diagnostics[0].line, 9);
  assert.ok(!skills.some(skill => skill.name === 'wrongInput'), 'file names must be lowercase commands');
  store.send(session.data.id, '/test'); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'overridden');
  store.send(session.data.id, '/broken'); await session.task;
  assert.equal(session.data.status, 'failed'); assert.match(session.data.messages.at(-1).content, /does not compile/);
  assert.equal(session.data.runs.length, 1);
  store.send(session.data.id, '/missing'); await session.task;
  assert.match(session.data.messages.at(-1).content, /no `\/missing` skill/);
  store.send(session.data.id, '/skills'); await session.task;
  assert.match(session.data.messages.at(-1).content, /Workspace skills[\s\S]*`\/broken` Broken \(has errors\)$/m);
  store.send(session.data.id, '/help'); await session.task;
  const help = session.data.messages.at(-1).content;
  assert.match(help, /read-only sub-agents\.\n\n\*\*Workspace skills\*\*[\s\S]*\*\*Built-in skills\*\*[\s\S]*\*\*Commands\*\*\n- `\/skills` List available skills\n- `\/help` /);
  assert.doesNotMatch(help, /panel/i);
});

test('unsupported entry input fields are reported before running', async t => {
  const { store, session } = await setup(t, { secret: `${manifest()}\nrecord In { secret: String }\nexport fn main(input: In) returns String { input.secret }\n` });
  const skill = await store.skills.find(session.data.workspace, 'secret');
  assert.equal(skill.ok, false); assert.match(skill.diagnostics[0].message, /Unsupported entry input field "secret"/);
});

test('workspace.edit waits for host approval, applies exactly on accept and leaves files on decline', async t => {
  const { store, session, workspace } = await setup(t, { note: editSkill });
  store.send(session.data.id, '/note first');
  const question = await waitFor(() => session.data.question);
  assert.equal(question.kind, 'approval'); assert.equal(question.title, 'Apply 1 file change?');
  assert.deepEqual(session.data.changes, [{ path: 'notes.txt', before: 'start\nend\n', after: 'start\nfirst\nend\n' }]);
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'start\nend\n');
  assert.throws(() => session.answer(question.id, { accept: 'yes' }), /Schema/);
  session.answer(question.id, { accept: true }); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'changed notes.txt');
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'start\nfirst\nend\n');
  assert.ok(session.data.events.some(event => event.type === 'workspace.changed'));
  assert.equal(session.data.runs.at(-1).skill, 'note');

  store.send(session.data.id, '/note second');
  session.answer((await waitFor(() => session.data.question)).id, { accept: false }); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'declined');
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'start\nfirst\nend\n');
});

test('cancelling during a host approval stops the run and writes nothing', async t => {
  const { store, session, workspace } = await setup(t, { note: editSkill });
  store.send(session.data.id, '/note never');
  const { id } = await waitFor(() => session.data.question);
  session.cancel(); await session.task;
  assert.equal(session.data.status, 'cancelled'); assert.equal(session.data.question, null);
  assert.equal(session.data.messages.at(-1).content, 'Cancelled.');
  assert.throws(() => session.answer(id, { accept: true }), /no longer pending/);
  await waitFor(() => session.pendingTools.size === 0);
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'start\nend\n');
});

test('cancelling after accepted file changes says they remain; an accepted command alone does not', async t => {
  const twoStep = `${manifest(['workspace.edit', 'shell.run'])}
export async fn main(args: String) returns String effects [tool.workspace.edit@1, tool.shell.run@1] {
  let edited = match await tools.workspace.edit.call({ summary: "Add a note", edits: [{ path: "notes.txt", find: "end", replace: "more\\nend" }] }) { Ok(result) => result.accepted Err(_) => false };
  let first = match await tools.shell.run.call({ command: "echo one", reason: "First" }) { Ok(result) => result.output Err(_) => "failed" };
  let second = match await tools.shell.run.call({ command: "echo two", reason: "Second" }) { Ok(result) => result.output Err(_) => "failed" };
  string.join([if (edited) { "edited" } else { "kept" }, first, second], "|")
}
`;
  const { store, session, workspace } = await setup(t, { two: twoStep });
  const next = async previous => waitFor(() => session.data.question?.id !== previous?.id && session.data.question);
  store.send(session.data.id, '/two');
  let question = await next(); session.answer(question.id, { accept: false });
  question = await next(question); session.answer(question.id, { accept: true });
  await next(question); session.cancel(); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'Cancelled.');
  await waitFor(() => session.pendingTools.size === 0);
  store.send(session.data.id, '/two');
  question = await next(); session.answer(question.id, { accept: true });
  await next(question); session.cancel(); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'Cancelled. Changes already written remain in the workspace.');
  await waitFor(() => session.pendingTools.size === 0);
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'start\nmore\nend\n');
});

test('typed user.ask questions get a schema and record-shaped entry input', async t => {
  const { store, session, workspace } = await setup(t, { greet: askSkill });
  store.send(session.data.id, '/greet hello');
  const question = await waitFor(() => session.data.question);
  assert.equal(question.kind, 'ask');
  assert.deepEqual(Object.keys(question.schema.properties).sort(), ['loud', 'name']);
  assert.throws(() => session.answer(question.id, { name: 'Ada' }), /Schema/);
  session.answer(question.id, { name: 'Ada', loud: true }); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'hello Ada !');
  assert.match(session.data.messages.at(-2).content, /Answered/);
  assert.ok(workspace);
});

test('approvals and answers are recorded as structured echoes beside plain prose', async t => {
  const shell = `${manifest(['shell.run'])}
export async fn main(args: String) returns String effects [tool.shell.run@1] {
  match await tools.shell.run.call({ command: args, reason: "Test" }) { Ok(result) => result.output Err(_) => "failed" }
}
`;
  const { store, session } = await setup(t, { note: editSkill, sh: shell, greet: askSkill });
  const answer = async (text, value, origin) => {
    store.send(session.data.id, text);
    const question = await waitFor(() => session.data.question);
    session.answer(question.id, value, origin); await session.task;
    return question;
  };
  assert.equal((await answer('/note one', { accept: true })).prompt.system, '', 'the title already says what approving does');
  await answer('/note two', { accept: false });
  assert.equal((await answer('/sh echo hi', { accept: true })).prompt.system, 'Runs with your user permissions.');
  await answer('/sh echo no', { accept: false }, 'auto-review');
  await answer('/greet hi', { name: 'Ada', loud: false });
  const long = { name: 'x'.repeat(600), loud: true };
  await answer('/greet hi', long, 'auto-review');
  assert.deepEqual(session.data.messages.filter(message => message.echo).map(({ role, content, echo }) => ({ role, content, echo })), [
    { role: 'user', content: 'Apply these changes.', echo: { kind: 'approval', accept: true, origin: 'user' } },
    { role: 'user', content: 'Decline these changes.', echo: { kind: 'approval', accept: false, origin: 'user' } },
    { role: 'user', content: 'Run `echo hi`.', echo: { kind: 'approval', accept: true, command: 'echo hi', origin: 'user' } },
    { role: 'system', content: '[auto-review] Decline this command.', echo: { kind: 'approval', accept: false, command: 'echo no', origin: 'auto-review' } },
    { role: 'user', content: 'Answered: {"name":"Ada","loud":false}', echo: { kind: 'answer', value: { name: 'Ada', loud: false }, origin: 'user' } },
    { role: 'system', content: `[auto-review] Answered: ${JSON.stringify(long).slice(0, 500)}`, echo: { kind: 'answer', value: `${JSON.stringify(long).slice(0, 499)}…`, truncated: true, origin: 'auto-review' } },
  ]);
  assert.match(session.history(40), /^user: Run `echo hi`\.$/m, 'skills still read the echoes as conversation');
});

test('git.run is read-only; declared tool errors reach the program instead of failing the run', async t => {
  const gitSkill = `${manifest(['git.run', 'workspace.read'])}
export async fn main(args: String) returns String effects [tool.git.run@1, tool.workspace.read@1] {
  let status = match await tools.git.run.call({ args: ["status", "--short"] }) { Ok(value) => value.output Err(_) => "status failed" };
  let push = match await tools.git.run.call({ args: ["push"] }) { Ok(_) => "pushed" Err(_) => "push refused" };
  let missing = match await tools.workspace.read.call({ path: "missing.txt" }) { Ok(_) => "found" Err(_) => "missing" };
  string.join([status, push, missing], "|")
}
`;
  const { store, session, workspace } = await setup(t, { gitcheck: gitSkill });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  store.send(session.data.id, '/gitcheck'); await session.task;
  assert.equal(session.data.status, 'completed', session.data.messages.at(-1).content);
  assert.equal(session.data.messages.at(-1).content, '?? .shout/\n?? notes.txt\n|push refused|missing');
  assert.equal(session.data.events.filter(event => event.type === 'tool.failed').length, 2);
});

test('shell.run asks before running and reports declined commands without running them', async t => {
  const shellSkill = `${manifest(['shell.run'])}
export async fn main(args: String) returns String effects [tool.shell.run@1] {
  match await tools.shell.run.call({ command: args, reason: "Test" }) {
    Ok(result) => if (result.approved) { result.output } else { "not run" }
    Err(_) => "failed"
  }
}
`;
  const { store, session, workspace } = await setup(t, { sh: shellSkill });
  store.send(session.data.id, '/sh echo ran > ran.txt; echo ok');
  let question = await waitFor(() => session.data.question);
  assert.equal(question.command, 'echo ran > ran.txt; echo ok');
  session.answer(question.id, { accept: false }); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'not run');
  await assert.rejects(readFile(join(workspace, 'ran.txt')));
  store.send(session.data.id, '/sh echo ran > ran.txt; echo ok');
  question = await waitFor(() => session.data.question);
  session.answer(question.id, { accept: true }); await session.task;
  assert.equal(session.data.messages.at(-1).content, 'ok\n');
  assert.equal(await readFile(join(workspace, 'ran.txt'), 'utf8'), 'ran\n');
});

test('every built-in skill compiles and has a description', async t => {
  const { store, session } = await setup(t);
  const builtins = (await store.skills.list(session.data.workspace)).filter(skill => skill.scope === 'builtin');
  assert.ok(builtins.length >= 8);
  for (const skill of builtins) {
    assert.equal(skill.ok, true, `${skill.name}: ${JSON.stringify(skill.diagnostics)}`);
    assert.ok(skill.description, `${skill.name} needs a // description line`);
  }
});

test('header limits: any subset, spacing and commas; duplicates, bad values and values over the ceiling are reported at their line', () => {
  const subset = parseHeader('// Count things.\n// args: <text>\n// limits: judgments=0  minutes = 5,questions=2\nmanifest {');
  assert.deepEqual([subset.description, subset.help, subset.limits, subset.limitLines, subset.limitErrors],
    ['Count things.', 'Count things.', { judgments: 0, minutes: 5, questions: 2 }, { judgments: 3, minutes: 3, questions: 3 }, []]);
  assert.deepEqual(resolveLimits(subset), { judgments: 0, tools: 128, questions: 2, minutes: 5 });
  assert.deepEqual(resolveLimits(parseHeader('// None.\nmanifest {')), RUN_LIMIT_DEFAULTS);
  const bad = parseHeader('// Bad.\n// limits: judgments=4 judgments=5\n// limits: tools=1.5 questions=17 minutes=0 minutes=121 speed=3 tools\n// limits:\nmanifest {');
  assert.deepEqual(bad.limits, { judgments: 4 });
  assert.deepEqual(bad.limitErrors.map(error => [error.line, error.message.split(/[,.(]/)[0]]), [
    [2, 'The judgments limit is set twice'],
    [3, 'The tools limit must be a whole number from 0 to 256 '],
    [3, 'The questions limit must be a whole number from 0 to 16 '],
    [3, 'The minutes limit must be a whole number from 1 to 120 '],
    [3, 'The minutes limit is set twice'],
    [3, 'Unknown limit "speed"'],
    [3, '"tools" is not key=value'],
    [4, 'The limits line sets nothing'],
  ]);
  // Only the leading comment block is the header.
  assert.deepEqual(parseHeader('// Doc.\nmanifest {\n// limits: judgments=99\n').limitErrors, []);
});

test('invalid limits are SHOUT008 and a zero limit for a declared effect is SHOUT009; a generated program cannot raise its limits', async t => {
  const judging = `${manifest([], ['model.request'])}
record Answer { answer: Bool }
export async fn main(args: String) returns Bool effects [model.request] {
  match await model.request<Answer>(prompt { system: "Judge" output: Answer }) { Ok(v) => v.answer Err(_) => false }
}
`;
  const { store, session } = await setup(t, {
    over: `// Over the ceiling\n// limits: judgments=33 tools=8\n${manifest()}\nexport fn main() returns String { "x" }\n`,
    judging: `// Judges with no judgments\n// args: <x>\n// limits: tools=0 judgments=0\n${judging}`,
    asking: `// Asks with no questions\n// limits: questions=0\n${askSkill}`,
    editing: `// Edits with no tool calls\n// limits: tools=0\n${editSkill.split('\n').slice(2).join('\n')}`,
    quiet: `// Fine\n// limits: judgments=0 questions=0 tools=3 minutes=2\n${manifest(['workspace.edit'])}\nexport fn main() returns String { "x" }\n`,
  });
  const skills = Object.fromEntries((await store.skills.list(session.data.workspace)).map(skill => [skill.name, skill]));
  const codes = name => skills[name].diagnostics.map(d => [d.code, d.line]);
  assert.deepEqual([skills.over.ok, codes('over'), skills.over.limits], [false, [['SHOUT008', 2]], null]);
  assert.match(skills.over.diagnostics[0].message, /judgments limit must be a whole number from 0 to 32/);
  assert.deepEqual([skills.judging.ok, codes('judging')], [false, [['SHOUT009', 3]]], 'only the zero limit the entry contradicts');
  assert.match(skills.judging.diagnostics[0].message, /judgments=0, but the entry makes model.request calls/);
  assert.deepEqual(codes('asking'), [['SHOUT009', 2]]);
  assert.deepEqual(codes('editing'), [['SHOUT009', 2]]);
  assert.deepEqual([skills.quiet.ok, skills.quiet.limits], [true, { judgments: 0, tools: 3, questions: 0, minutes: 2 }]);
  assert.deepEqual(skills.test.limits, { ...RUN_LIMIT_DEFAULTS, judgments: 0, questions: 0 }, 'built-ins declare theirs');
  // /skills marks them; running one says it does not compile.
  store.send(session.data.id, '/skills'); await session.task;
  assert.match(session.data.messages.at(-1).content, /`\/judging <x>` Judges with no judgments \(has errors\)/);
  // A generated program keeps lower limits and is held to the defaults above them.
  const raised = `// limits: judgments=32 tools=256 questions=16 minutes=120\n${manifest()}\nexport fn main() returns String { "x" }\n`;
  assert.deepEqual((await store.skills.validate(raised)).limits, { judgments: 32, tools: 256, questions: 16, minutes: 120 });
  assert.deepEqual((await store.skills.validate(raised, { generated: true })).limits, RUN_LIMIT_DEFAULTS);
  const lowered = raised.replace('judgments=32', 'judgments=2');
  assert.equal((await store.skills.validate(lowered, { generated: true })).limits.judgments, 2);
  assert.deepEqual((await store.skills.validate(`// limits: judgments=0\n${judging}`, { generated: true })).diagnostics.map(d => d.code), ['SHOUT009']);
});

test('git.run refuses branch writes, --no-index and paths outside the workspace', async t => {
  const { session, workspace } = await setup(t);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace });
  const { createToolHandler } = await import('../src/tools.mjs');
  const handler = createToolHandler({ workspace: session.workspace });
  const call = args => handler('git.run', { args }, { signal: new AbortController().signal });
  assert.match((await call(['branch', '--show-current'])).output, /main/);
  for (const args of [['branch', '-D', 'main'], ['branch', 'new-branch'], ['diff', '--no-index', 'a', 'b'], ['show', 'HEAD:../secret'], ['diff', '/etc/passwd'], ['blame', '--contents', 'x', 'notes.txt'], ['push']]) {
    await assert.rejects(call(args), undefined, args.join(' '));
  }
  assert.match(execFileSync('git', ['branch'], { cwd: workspace, encoding: 'utf8' }), /main/);
});

test('concurrent host approvals queue instead of replacing each other', async t => {
  const { session } = await setup(t);
  session.data.status = 'running';
  const signal = new AbortController().signal;
  const first = session.approve({ title: 'First?', summary: '', command: 'echo 1', signal }, () => true);
  const second = session.approve({ title: 'Second?', summary: '', command: 'echo 2', signal }, () => true);
  await waitFor(() => session.data.question);
  assert.equal(session.data.question.title, 'First?');
  session.answer(session.data.question.id, { accept: true });
  assert.equal(await first, true);
  await waitFor(() => session.data.question?.title === 'Second?');
  session.answer(session.data.question.id, { accept: false });
  assert.equal(await second, false);
});

test('large tool results stay under one JOSH frame: read_many skips and git.run flags truncation', async t => {
  const { session, workspace } = await setup(t);
  const { createToolHandler } = await import('../src/tools.mjs');
  const handler = createToolHandler({ workspace: session.workspace });
  const signal = new AbortController().signal;
  const paths = [];
  for (let i = 0; i < 5; i++) { paths.push(`big${i}.txt`); await writeFile(join(workspace, `big${i}.txt`), `${'x'.repeat(99)}\n`.repeat(2000)); }
  const read = await handler('workspace.read_many', { paths }, signal ? { signal } : {});
  assert.ok(read.files.length >= 2 && read.files.length < 5);
  assert.match(read.skipped.join('\n'), /result limit/);
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 1024 * 1024 - 64 * 1024);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: workspace });
  for (const path of paths) await writeFile(join(workspace, path), `${'y'.repeat(99)}\n`.repeat(2000));
  const diff = await handler('git.run', { args: ['diff', 'HEAD'] }, { signal });
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(diff)) < 1024 * 1024 - 64 * 1024);
  assert.equal((await handler('git.run', { args: ['status', '--short'] }, { signal })).truncated, false);
});
