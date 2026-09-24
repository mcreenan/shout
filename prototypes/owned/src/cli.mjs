#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Session, packageRoot } from './kernel.mjs';
import { FixtureProvider, CodexProvider } from './provider.mjs';

const fixture = process.argv.includes('--fixture');
const demo = process.argv.includes('--demo');
const session = new Session({ provider: fixture ? new FixtureProvider() : new CodexProvider() });
const print = value => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
const trace = [];
session.on('event', event => { trace.push(event); print(event); });
process.on('SIGINT', () => { session.close(); process.exitCode = 130; process.stdin.destroy(); });
process.on('SIGTERM', () => { session.close(); process.exitCode = 143; process.stdin.destroy(); });

if (demo) {
  print(`${fixture ? 'OFFLINE FIXTURE' : 'LIVE MODEL'} demo. Human answer is explicitly scripted fixture accept=true; no external issue will be changed.`);
  session.on('event', event => {
    if (event.type === 'user.question') queueMicrotask(() => session.answer(event.id, { accept: true }, 'scripted-fixture'));
  });
  const run = await session.review();
  const result = await run.done;
  await mkdir(resolve(packageRoot, '.scratch'), { recursive: true });
  const evidence = resolve(packageRoot, '.scratch', fixture ? 'offline-demo.json' : 'live-demo.json');
  await writeFile(evidence, JSON.stringify({ profile: fixture ? 'offline-fixture' : 'live-codex-judgment', scriptedUserAnswer: true, result, trace }, null, 2));
  print({ result, evidence });
  if (result.state !== 'completed') process.exitCode = 1;
  session.close();
} else {
  print(`Owned ALLEN harness (${fixture ? 'OFFLINE FIXTURE MODEL' : 'live Codex judgment'}).\nSpeak normally, or /review [goal], /run file.allen [input.json], /status, /answer QUESTION_ID JSON, /cancel, /trace, /quit.\nUser answers require the exact displayed question ID; status/cancel work while a model or user is pending.`);
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  readline.on('line', line => {
    void (async () => {
      const text = line.trim(); if (!text) return;
      if (text === '/quit') { session.close(); readline.close(); process.stdin.destroy(); return; }
      if (text === '/status') { print(session.status()); return; }
      if (text === '/cancel') { print(session.cancel()); return; }
      if (text === '/trace') { print(session.active?.events ?? []); return; }
      if (text.startsWith('/answer ')) {
        const match = /^\/answer\s+(\S+)\s+([\s\S]+)$/.exec(text);
        if (!match) throw new Error('Usage: /answer QUESTION_ID {"accept":true}');
        session.answer(match[1], JSON.parse(match[2]), 'user'); return;
      }
      if (text === '/review' || text.startsWith('/review ')) { const run = await session.review(text.slice(8).trim()); print({ started: run.id }); return; }
      if (text.startsWith('/run ')) {
        const parts = text.slice(5).trim().split(/\s+/);
        if (parts.length < 1 || parts.length > 2) throw new Error('Usage: /run file.allen [input.json] (paths without spaces)');
        print({ started: (await session.runFile(parts[0], parts[1])).id }); return;
      }
      if (text.startsWith('/')) throw new Error('Unknown command');
      print(await session.message(text));
    })().catch(error => print({ error: error.message }));
  });
  readline.on('close', () => session.close());
}
