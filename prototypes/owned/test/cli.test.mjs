import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { packageRoot } from '../src/kernel.mjs';

test('interactive CLI handles wait/status/wrong answer/answer/cancel with a real VM', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ['src/cli.mjs', '--fixture'], { cwd: packageRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = ''; let stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  const until = async check => {
    const start = Date.now();
    while (!check()) { if (Date.now() - start > 4000) throw new Error(`CLI wait timeout: ${output.slice(-2000)} ${stderr}`); await delay(10); }
  };
  await until(() => output.includes('Owned ALLEN harness'));
  child.stdin.write('/review\n');
  await until(() => output.includes('"type": "user.question"'));
  const question = /"type": "user.question",\s+"id": "([^"]+)"/.exec(output)[1];
  child.stdin.write('/status\n');
  await until(() => output.includes('"state": "waiting_user"'));
  child.stdin.write(`/answer wrong {"accept":true}\n`);
  await until(() => output.includes('Unknown question ID'));
  child.stdin.write(`/answer ${question} {"accept":true}\n`);
  await until(() => output.includes('"state": "completed"'));
  const previousQuestions = output.match(/"type": "user.question"/g).length;
  child.stdin.write('/review\n');
  await until(() => (output.match(/"type": "user.question"/g) || []).length > previousQuestions);
  child.stdin.write('/cancel\n');
  await until(() => output.includes('"state": "cancelled"'));
  const closed = new Promise(resolve => child.on('close', resolve));
  child.stdin.write('/quit\n');
  assert.equal(await closed, 0); assert.equal(stderr, '');
});
