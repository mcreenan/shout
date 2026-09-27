#!/usr/bin/env node
// Runs one SHOUT chat message (usually `/skill args`) in a throwaway session and
// prints the transcript. Approvals and typed questions are answered from flags.
//
//   node tools/run-skill.mjs [--workspace DIR] [--approve|--decline] [--model ID] [--effort LEVEL]
//     [--answer JSON]... [--test-command CMD] [--events] -- "/review auth"
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore } from '../apps/shout/src/session.mjs';

const args = process.argv.slice(2);
const options = { workspace: process.cwd(), approve: null, answers: [], testCommand: '', events: false, model: undefined, effort: undefined };
while (args.length && args[0] !== '--') {
  const flag = args.shift();
  if (flag === '--workspace') options.workspace = args.shift();
  else if (flag === '--approve') options.approve = true;
  else if (flag === '--decline') options.approve = false;
  else if (flag === '--answer') options.answers.push(JSON.parse(args.shift()));
  else if (flag === '--test-command') options.testCommand = args.shift();
  else if (flag === '--events') options.events = true;
  else if (flag === '--model') options.model = args.shift();
  else if (flag === '--effort') options.effort = args.shift();
  else { args.unshift(flag); break; }
}
if (args[0] === '--') args.shift();
const text = args.join(' ');
if (!text) { console.error('Usage: node tools/run-skill.mjs [options] -- "/skill args"'); process.exit(2); }

const stateRoot = await mkdtemp(resolve(tmpdir(), 'shout-run-skill-'));
const store = await new SessionStore({ stateRoot }).init();
const session = await store.create({ workspace: options.workspace, testCommand: options.testCommand, ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) });
let printed = 0;
const flush = () => {
  for (const message of session.data.messages.slice(printed)) console.log(`\n[${message.role}]\n${message.content}`);
  printed = session.data.messages.length;
};
session.on('snapshot', () => {
  flush();
  const question = session.data.question;
  if (!question || question.handled) return;
  question.handled = true;
  console.log(`\n[question:${question.kind}] ${question.title ?? question.prompt?.system ?? ''}${question.command ? `\n$ ${question.command}` : ''}`);
  for (const change of question.prompt?.data?.value?.changes ?? []) console.log(`  change: ${change.path} (${change.before.length} → ${change.after.length} chars)`);
  let value;
  if (question.kind === 'approval' && options.approve !== null) value = { accept: options.approve };
  else if (question.kind === 'ask' && options.answers.length) value = options.answers.shift();
  if (value === undefined) { console.log('  (no answer supplied; cancelling)'); setImmediate(() => session.cancel()); return; }
  console.log(`  answer: ${JSON.stringify(value)}`);
  setImmediate(() => { try { session.answer(question.id, value); } catch (error) { console.log(`  answer rejected: ${error.message}`); session.cancel(); } });
});
store.send(session.data.id, text);
await session.task;
flush();
if (options.events) for (const event of session.data.events) console.log(JSON.stringify({ type: event.type, tool: event.tool, error: event.error, message: event.message, value: event.value }).slice(0, 8000));
const run = session.data.runs.at(-1);
console.log(`\n[status] ${session.data.status}${run ? ` · run ${run.state} · model ${run.counters?.modelJudgments ?? 0} · tools ${run.counters?.nativeToolCalls ?? 0}` : ''}`);
await store.close();
await rm(stateRoot, { recursive: true, force: true });
process.exit(['completed', 'idle'].includes(session.data.status) ? 0 : 1);
