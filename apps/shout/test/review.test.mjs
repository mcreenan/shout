import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, cp, symlink, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SessionStore } from '../src/session.mjs';
import { ScriptedAgent } from './doubles.mjs';

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('built-in skills are found when the install path contains spaces', async t => {
  const base = await mkdtemp(join(tmpdir(), 'shout skills '));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'install dir');
  for (const part of ['apps/shout/src', 'apps/shout/skills', 'prototypes/owned/src']) await cp(join(repo, part), join(root, part), { recursive: true });
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'));
  const skills = await import(pathToFileURL(join(root, 'apps/shout/src/skills.mjs')).href);
  assert.equal(skills.builtinSkillsDir, join(root, 'apps/shout/skills'));
  assert.ok((await stat(join(skills.builtinSkillsDir, 'code.allen'))).isFile());
  assert.match(await skills.skillGuide(), /## Tool catalog/);
});

test('/review of a change too large for one diff lists every file it could not fetch as not reviewed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shout-review-'));
  const workspace = join(dir, 'project'); await mkdir(workspace);
  const previousHome = process.env.SHOUT_HOME; process.env.SHOUT_HOME = join(dir, 'home');
  const judged = [];
  const store = await new SessionStore({ stateRoot: join(dir, 'state'), agent: new ScriptedAgent(),
    providerFactory: () => ({ async judge({ prompt }) { judged.push(prompt.data?.value?.all_changed_paths ?? []); return { summary: 'Looks fine.', findings: [] }; } }) }).init();
  t.after(async () => { await store.close(); if (previousHome === undefined) delete process.env.SHOUT_HOME; else process.env.SHOUT_HOME = previousHome; await rm(dir, { recursive: true, force: true }); });
  const names = Array.from({ length: 105 }, (_, index) => `f${String(index).padStart(3, '0')}.txt`);
  const body = mark => Array.from({ length: 100 }, (_, line) => `${mark} line ${line} ${'x'.repeat(70)}`).join('\n') + '\n';
  for (const name of names) await writeFile(join(workspace, name), body('old'));
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: workspace, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'init');
  for (const name of names) await writeFile(join(workspace, name), body('new'));
  const session = await store.create({ workspace });
  store.send(session.data.id, '/review'); await session.task;
  assert.equal(session.data.status, 'completed', session.data.messages.at(-1).content);
  const report = session.data.messages.at(-1).content;
  for (const name of names.slice(100)) assert.match(report, new RegExp(`${name.replace('.', '\\.')} \\(over the 100-file limit\\)`));
  assert.doesNotMatch(report, /f099\.txt \(over the 100-file limit\)/);
  assert.ok(judged.length > 0 && judged.every(paths => paths.includes('f104.txt')), 'every batch is told about the files that were not fetched');
});
