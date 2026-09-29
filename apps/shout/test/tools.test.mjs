import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, stat, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolHandler } from '../src/tools.mjs';
import { Workspace } from '../src/workspace.mjs';
import { ToolError } from '../../../prototypes/owned/src/kernel.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A committed repository, a probe program that only creates a marker file (and exits at once), and a tool handler whose approvals are recorded.
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'shout-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'); await mkdir(root);
  await writeFile(join(root, 'notes.txt'), 'needle\nalpha\n');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  const marker = join(dir, 'marker'); const probe = join(dir, 'probe.sh');
  await writeFile(probe, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); await chmod(probe, 0o755);
  const approvals = [];
  const handlerFor = async path => {
    const handler = createToolHandler({ workspace: await new Workspace(path).init(), approve: async request => { approvals.push(request); return true; }, changed: () => {} });
    return (name, input) => handler(name, input, { signal: new AbortController().signal });
  };
  const ran = async () => { const found = await stat(marker).then(() => true, () => false); await rm(marker, { force: true }); return found; };
  return { dir, root, probe, call: await handlerFor(root), handlerFor, ran, approvals };
}

test('git.run refuses option abbreviations and anything outside each subcommand\'s allowlist, without running it', async t => {
  const { dir, probe, call, ran } = await setup(t);
  const refused = [
    ['grep', `--open-files-in-page=${probe}`, 'needle'], ['grep', `--open-files-in-pa=${probe}`, 'needle'], ['grep', `--open=${probe}`, 'needle'],
    ['grep', `--open-files-in-pager=${probe}`, 'needle'], ['grep', `-O${probe}`, 'needle'], ['grep', '-O', probe, 'needle'], ['grep', `-iO${probe}`, 'needle'],
    ['grep', '-f', 'notes.txt'], ['grep', '--no-index', 'needle'], ['grep', '--recurse-submodules', 'needle'],
    ['diff', '--ext-diff'], ['diff', '--ext-d'], ['log', '-p', '--textconv'], ['show', '--textc'], ['blame', '--textconv', 'notes.txt'],
    ['diff', `--output=${join(dir, 'out')}`], ['log', '--out=out.txt'], ['diff', '-Oorder.txt'], ['diff', '--no-index', 'a', 'b'], ['diff', '--submodule=diff'],
    ['-c', `core.pager=${probe}`, 'log'], ['--config-env=core.pager=HOME', 'log'], ['--exec-path=/tmp', 'log'], ['log', '--exec-path'], ['log', '--help'],
    ['log', '--show-signature'], ['log', '--format=%G?'], ['log', '--pretty=format:%GS'], ['log', '--pretty=myalias'], ['shortlog', '--group=format:%GK', 'HEAD'],
    ['branch', '--format=%(signature)'], ['blame', '--contents', 'notes.txt', 'notes.txt'], ['blame', '--ignore-revs-file=/etc/passwd', 'notes.txt'],
    ['branch', '-D', 'main'], ['branch', 'new-branch'], ['branch', '--edit-description'], ['branch', '--', 'x'], ['status', '-v'], ['status', '--ignore-submodules=none'],
    ['ls-files', `--exclude-from=${probe}`], ['ls-files', '-X', 'x'], ['show', 'HEAD:../secret'], ['diff', '/etc/passwd'], ['log', '--relative=../x'], ['push'],
  ];
  for (const args of refused) await assert.rejects(call('git.run', { args }), error => error instanceof ToolError, args.join(' '));
  assert.equal(await ran(), false, 'nothing was executed');
  await assert.rejects(call('git.run', { args: ['grep', '--open-files-in-page=x', 'needle'] }), /git grep does not accept --open-files-in-page=x[\s\S]*--ignore-case/);
});

test('git.run still runs everyday read-only forms, spelled in full or as short flag clusters', async t => {
  const { root, call } = await setup(t);
  const allowed = [['status', '-sb'], ['status', '--short', '--untracked-files=all'], ['status', '--porcelain=v1'], ['log', '--oneline', '-5'], ['log', '-n', '1', '--format=%h %s'],
    ['log', '-n1', '--pretty=oneline', '--author=t'], ['log', '-p', '-1', '--stat', '--', 'notes.txt'], ['diff', 'HEAD', '--stat'], ['diff', 'HEAD', '--name-only'], ['diff', '--cached', '-U1'],
    ['show', 'HEAD:notes.txt'], ['show', '--stat', 'HEAD'], ['grep', '-n', '-e', 'needle'], ['grep', '-in', 'needle', '--', 'notes.txt'], ['grep', '-C', '1', 'needle'], ['blame', '-L', '1,1', 'notes.txt'],
    ['ls-files', '--others', '--exclude-standard'], ['ls-files', '-s'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['rev-parse', '--show-toplevel'], ['describe', '--always', '--dirty'],
    ['branch', '--show-current'], ['branch', '-a', '--format=%(refname:short)'], ['shortlog', '-sn', 'HEAD']];
  for (const args of allowed) {
    const result = await call('git.run', { args });
    assert.equal(result.exit_code, 0, `${args.join(' ')}: ${result.output}`);
  }
  assert.match((await call('git.run', { args: ['grep', '-n', 'needle'] })).output, /notes\.txt:1:needle/);
  // Every short option that takes a value works attached and as the next argument, with the same result.
  await writeFile(join(root, 'notes.txt'), 'needle\nalpha2\nbeta\n'); git(root, 'commit', '-qam', 'two');
  await writeFile(join(root, 'notes.txt'), 'needle\nalpha3\nbeta\n');
  const pairs = [
    [['log', '-p', '-1', '-U1'], ['log', '-p', '-1', '-U', '1']], [['show', '-U0'], ['show', '-U', '0']], [['diff', '-U0'], ['diff', '-U', '0']],
    [['log', '--oneline', '-Salpha'], ['log', '--oneline', '-S', 'alpha']], [['log', '--oneline', '-Galpha2'], ['log', '--oneline', '-G', 'alpha2']], [['log', '--oneline', '-n1'], ['log', '--oneline', '-n', '1']],
    [['show', '--oneline', '-n1'], ['show', '--oneline', '-n', '1']], [['diff', 'HEAD~1', '-Salpha2'], ['diff', 'HEAD~1', '-S', 'alpha2']], [['diff', 'HEAD~1', '-Galpha'], ['diff', 'HEAD~1', '-G', 'alpha']],
    [['ls-files', '-o', '-xfoo'], ['ls-files', '-o', '-x', 'foo']], [['blame', '-L1,2', 'notes.txt'], ['blame', '-L', '1,2', 'notes.txt']],
    [['grep', '-eneedle'], ['grep', '-e', 'needle']], [['grep', '-A1', 'needle'], ['grep', '-A', '1', 'needle']], [['grep', '-B1', 'beta'], ['grep', '-B', '1', 'beta']],
    [['grep', '-C1', 'alpha3'], ['grep', '-C', '1', 'alpha3']], [['grep', '-m1', 'a'], ['grep', '-m', '1', 'a']],
  ];
  for (const [attached, separate] of pairs) {
    const [one, other] = [await call('git.run', { args: attached }), await call('git.run', { args: separate })];
    assert.equal(one.exit_code, 0, `${attached.join(' ')}: ${one.output}`);
    assert.deepEqual(other, one, `${separate.join(' ')} reads like ${attached.join(' ')}`);
  }
  assert.match((await call('git.run', { args: ['diff', '-U', '0'] })).output, /^@@ -2 \+2 @@.*\n-alpha2\n\+alpha3\n$/m, 'no context lines');
  // -U also stands alone (default context) when a revision rather than a number follows, as git reads it.
  assert.deepEqual(await call('git.run', { args: ['diff', '-U', 'HEAD~1'] }), await call('git.run', { args: ['diff', 'HEAD~1'] }));
});

test('git.run ignores programs named by the repository\'s own config: filters, textconv, diff drivers, pager, fsmonitor, hooks and signature checks', async t => {
  const { dir, root, probe, call, ran } = await setup(t);
  // A commit carrying a (fake) signature, so a signature check would run gpg.program.
  const tree = git(root, 'rev-parse', 'HEAD^{tree}').trim();
  await writeFile(join(dir, 'signed.txt'), `tree ${tree}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned\n`);
  git(root, 'update-ref', 'refs/heads/signed', git(root, 'hash-object', '-t', 'commit', '-w', join(dir, 'signed.txt')).trim());
  const hooks = join(dir, 'hooks'); await mkdir(hooks);
  for (const hook of ['post-index-change', 'reference-transaction']) { await writeFile(join(hooks, hook), `#!/bin/sh\nexec '${probe}'\n`); await chmod(join(hooks, hook), 0o755); }
  for (const [key, value] of [['filter.evil.clean', probe], ['filter.evil.smudge', probe], ['filter.evil.process', probe], ['diff.evil.textconv', probe], ['diff.evil.command', probe],
    ['diff.external', probe], ['core.pager', probe], ['pager.log', probe], ['core.fsmonitor', probe], ['core.hooksPath', hooks], ['gpg.program', probe], ['gpg.ssh.program', probe],
    ['log.showSignature', 'true'], ['format.pretty', 'format:%G? %h']]) git(root, 'config', key, value);
  // An included config file counts as the repository's own too.
  await writeFile(join(dir, 'included.cfg'), `[filter "other.x"]\n\tclean = ${probe}\n`);
  git(root, 'config', 'include.path', join(dir, 'included.cfg'));
  await writeFile(join(root, '.git', 'info', 'attributes'), 'notes.txt filter=evil diff=evil\nextra.txt filter=other.x\n');
  await writeFile(join(root, 'notes.txt'), 'needle\nalpha\nbeta\n'); await writeFile(join(root, 'extra.txt'), 'x\n');
  const forms = [['status'], ['status', '--short'], ['diff'], ['diff', 'HEAD'], ['diff', '--stat'], ['log', '-p', '-1'], ['log', '-1', 'signed'], ['log', '--format=%h', '-1', 'signed'],
    ['show', 'HEAD'], ['show', 'signed'], ['show', 'HEAD:notes.txt'], ['blame', 'notes.txt'], ['grep', 'needle'], ['grep', '--cached', 'needle'], ['ls-files', '-m'], ['describe', '--always', '--dirty'], ['shortlog', '-s', 'HEAD']];
  for (const args of forms) {
    await call('git.run', { args });
    assert.equal(await ran(), false, `git ${args.join(' ')} ran a program from the repository's config`);
  }
  assert.match((await call('git.run', { args: ['diff'] })).output, /\+beta/, 'the diff itself still works');
});

test('git.run never fetches: a partial clone\'s missing objects do not start the configured transport', async t => {
  const { dir, root, probe, ran, handlerFor } = await setup(t);
  const bare = join(dir, 'bare.git');
  git(dir, 'init', '-q', '--bare', bare); git(bare, 'config', 'uploadpack.allowfilter', 'true');
  git(root, 'push', '-q', bare, 'HEAD:refs/heads/main');
  git(dir, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${bare}`, 'partial');
  const partial = join(dir, 'partial');
  git(partial, 'config', 'remote.origin.url', `ext::${probe}`); git(partial, 'config', 'protocol.ext.allow', 'always');
  const call = await handlerFor(partial);
  for (const args of [['show', 'origin/main:notes.txt'], ['log', '-p', '-1', 'origin/main'], ['grep', 'needle', 'origin/main']]) {
    const result = await call('git.run', { args });
    assert.notEqual(result.exit_code, 0, `${args.join(' ')} cannot read a missing object`);
    assert.equal(await ran(), false, `git ${args.join(' ')} started the remote transport`);
  }
});

test('file reads, snapshots and searches stay within one tool result once JSON-encoded', async t => {
  const { root, call } = await setup(t);
  await writeFile(join(root, 'control.txt'), '\x01'.repeat(200 * 1024));
  await assert.rejects(call('workspace.read', { path: 'control.txt' }), error => error instanceof ToolError && /control\.txt is \d+ KiB once encoded, over the 700 KiB limit/.test(error.message));
  await assert.rejects(call('workspace.inspect', {}), error => error instanceof ToolError && /workspace\.list and workspace\.read_many/.test(error.message));
  await rm(join(root, 'control.txt'));
  await writeFile(join(root, 'lines.txt'), `needle${'\x01'.repeat(390)}\n`.repeat(400));
  const found = await call('workspace.search', { query: 'needle', max_results: 500 });
  assert.equal(found.truncated, true);
  assert.ok(found.matches.length > 100 && found.matches.length < 401);
  assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 700 * 1024);
  assert.equal((await call('workspace.read', { path: 'notes.txt' })).content, 'needle\nalpha\n');
});

test('change sets that could not be applied are refused before the user is asked', async t => {
  const { root, call, approvals } = await setup(t);
  const many = await call('workspace.edit', { summary: 'Many files', edits: Array.from({ length: 33 }, (_, index) => ({ path: `new-${index}.txt`, find: '', replace: 'x\n' })) });
  assert.equal(many.accepted, false); assert.match(many.problem, /at most 32 files; this one touches 33/);
  const big = await call('workspace.edit', { summary: 'Big file', edits: [{ path: 'big.txt', find: '', replace: 'a'.repeat(257 * 1024) }] });
  assert.equal(big.accepted, false); assert.match(big.problem, /bounded text/);
  await assert.rejects(call('workspace.write', { summary: 'Big file', changes: [{ path: 'big.txt', before: '', after: 'a'.repeat(257 * 1024) }] }), /bounded text/);
  await assert.rejects(call('workspace.write', { summary: 'Stale', changes: [{ path: 'notes.txt', before: 'not what is there', after: 'x' }] }), /Stale patch/);
  assert.equal(approvals.length, 0, 'the user was never asked');
  const ok = await call('workspace.edit', { summary: 'Small', edits: Array.from({ length: 32 }, (_, index) => ({ path: `new-${index}.txt`, find: '', replace: 'x\n' })) });
  assert.deepEqual([ok.accepted, ok.changed.length, ok.problem, approvals.length], [true, 32, '', 1]);
  await stat(join(root, 'new-31.txt'));
});
