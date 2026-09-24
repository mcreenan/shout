import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function project(track) {
  const integrated = resolve(root, 'prototypes', track);
  return existsSync(resolve(integrated, 'src/cli.mjs'))
    ? integrated
    : resolve(root, '.worktrees', track, 'prototypes', track);
}

function terminal(event) {
  return event.type === 'execution.terminal' || event.type === 'run.terminal';
}

async function exercise(track, cancel) {
  const child = spawn(process.execPath, ['src/cli.mjs', ...(track === 'owned' ? ['--fixture'] : [])], {
    cwd: project(track), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  const events = [];
  let buffer = '', current = '', depth = 0, inString = false, escaped = false, stderr = '';
  let waiter, exited = false;
  const exit = new Promise(resolveExit => child.on('close', (code, signal) => {
    exited = true; resolveExit({ code, signal }); waiter?.();
  }));
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.stdout.on('data', data => {
    buffer += data.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      // Both CLIs print JSON objects, either compact or indented, between human text lines.
      if (!current && !line.startsWith('{')) continue;
      current += line + '\n';
      for (const char of line) {
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') inString = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') depth--;
      }
      if (depth === 0 && !inString) {
        try { events.push(JSON.parse(current)); } catch {}
        current = ''; waiter?.();
      }
    }
  });
  const send = command => child.stdin.write(command + '\n');
  const waitFor = (predicate, after = 0) => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => {
      waiter = undefined;
      reject(new Error(`${track}: interactive timeout; stderr=${stderr}; last events=${JSON.stringify(events.slice(-3))}`));
    }, 15000);
    const check = () => {
      const found = events.slice(after).find(predicate);
      if (found || exited) {
        clearTimeout(timer); waiter = undefined;
        found ? resolveWait(found) : reject(new Error(`${track}: exited before expected event: ${stderr}`));
      }
    };
    waiter = check; check();
  });
  try {
    send(track === 'native' ? '/run' : '/review');
    const question = await waitFor(event => event.type === 'user.question');
    assert.equal(typeof question.id, 'string');
    send('/status');
    await waitFor(event => track === 'native'
      ? event.state === 'waiting'
      : event.runs?.some(run => run.state === 'waiting_user'));
    const answer = track === 'native' ? 'true' : '{"accept":true}';
    let cursor = events.length;
    send(`/answer wrong-question ${answer}`);
    await waitFor(event => typeof event.error === 'string', cursor);
    if (cancel) send('/cancel');
    else send(`/answer ${question.id} ${answer}`);
    const finished = await waitFor(terminal);
    const outcome = track === 'native' ? finished.outcome.outcome : finished.state;
    assert.equal(outcome, cancel ? 'cancelled' : 'completed');
    cursor = events.length;
    send(`/answer ${question.id} ${answer}`);
    await waitFor(event => typeof event.error === 'string', cursor);
    send('/quit');
    const result = await Promise.race([exit, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${track}: did not exit after /quit`)), 5000);
      timer.unref();
    })]);
    assert.equal(result.code, 0);
    console.log(`PASS ${track}: interactive ${cancel ? 'cancellation + late answer' : 'answer + duplicate rejection'}, responsive status, wrong-ID rejection (fixture model)`);
  } finally {
    if (!exited) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    }
  }
}

for (const track of ['native', 'owned']) {
  await exercise(track, false);
  await exercise(track, true);
}
