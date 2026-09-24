import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CodexProvider } from '../src/provider.mjs';

// These exercise the subprocess/event-stream boundary, not model quality or VM behavior.
async function fakeCli(t, events) {
  const dir = await mkdtemp(resolve(tmpdir(), 'owned-provider-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = resolve(dir, 'fake-codex');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0] === '--version') { console.log('codex-cli 0.153.3'); process.exit(0); }
if(args[0] === 'debug') { console.log('{"models":[]}'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
fs.writeFileSync(args[args.indexOf('--output-last-message')+1], '{"value":{"answer":true}}');
process.stdout.write(${JSON.stringify(events)});
});
`, { mode: 0o700 });
  return new CodexProvider({ binary });
}
const request = { prompt: { system: 'Judge' }, schema: { type: 'object', properties: { answer: { type: 'boolean' } }, required: ['answer'], additionalProperties: false } };

test('provider rejects zero-exit structured result without a completed turn', async t => {
  const provider = await fakeCli(t, '{"type":"item.completed","item":{"type":"agent_message"}}\n');
  await assert.rejects(provider.judge(request), /without turn.completed/);
});

test('provider checks trailing tool events even when no newline is emitted', async t => {
  const provider = await fakeCli(t, '{"type":"turn.completed","usage":{}}\n{"type":"item.completed","item":{"type":"command_execution"}}');
  await assert.rejects(provider.judge(request), /unsupported item/);
});

test('provider rejects malformed trailing stream content', async t => {
  const provider = await fakeCli(t, '{"type":"turn.completed"}\n{"truncated":');
  await assert.rejects(provider.judge(request), SyntaxError);
});

test('provider accepts valid completed stream without a final newline', async t => {
  const provider = await fakeCli(t, '{"type":"turn.completed","usage":{"input_tokens":12}}');
  assert.deepEqual(await provider.judge(request), { answer: true });
});
