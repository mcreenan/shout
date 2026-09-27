// Test doubles for SHOUT's two model boundaries: the agent thread and model.request judgments.
// The compiler, VM, workspace tools, approvals and tests they drive are real.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOLUTIONS = fileURLToPath(new URL('../scenarios/solutions/', import.meta.url));
const scenarioFiles = { pricing: 'pricing.mjs', slug: 'slug.mjs', validation: 'validators.mjs' };

/** The checked-in solution for a scenario as a before/after change, or [] once it is applied. */
export async function solutionChanges(scenarioId, files) {
  const filename = scenarioFiles[scenarioId];
  if (!filename) throw new Error(`No solution for scenario: ${scenarioId}`);
  const current = files.find(file => file.path === filename);
  if (!current) throw new Error(`Scenario file missing: ${filename}`);
  const after = await readFile(`${SOLUTIONS}${scenarioId}.mjs`, 'utf8');
  return current.content === after ? [] : [{ path: filename, before: current.content, after }];
}

/**
 * Stands in for CodexAgent and ClaudeAgent. `script({ text, call, say, usage, turn, threadId, thread, signal })`
 * plays one turn: `call(tool, input)` invokes a SHOUT tool and resolves to its result text (rejecting if
 * the call failed), `say(text)` is a model message and `usage(counts)` reports token usage. `thread` is
 * the turn's thread options, so a script can tell SHOUT's thread from a sub-agent's (its instructions
 * and tools). Whatever the script resolves is merged into the turn's result. The default script just
 * replies. Each turn's `thread` option is kept in `threadOptions`. Turns may run concurrently.
 */
export class ScriptedAgent {
  constructor(script = async ({ say }) => say('Hello from the scripted agent.')) {
    this.script = script; this.threads = []; this.turns = []; this.threadOptions = [];
  }
  async startThread(options) { this.threads.push(options); return `thread-${this.threads.length}`; }
  async turn(threadId, text, { onToolCall, onEvent = () => {}, signal, model, effort, thread }) {
    this.turns.push({ threadId, text, model, effort }); this.threadOptions.push(thread);
    const call = (tool, input) => onToolCall({ tool, input });
    const say = message => onEvent({ type: 'message', text: message });
    const usage = counts => onEvent({ type: 'usage', usage: counts });
    const interrupted = new Promise(resolve => signal?.addEventListener('abort', () => resolve({ status: 'interrupted' }), { once: true }));
    return Promise.race([interrupted, this.script({ text, call, say, usage, turn: this.turns.length, threadId, thread, signal }).then(value => ({ status: 'completed', ...value }))]);
  }
  close() {}
}

/** An agent that sends every message to the /code skill, as a model would for a scenario's prompt. */
export const codeAgent = () => new ScriptedAgent(async ({ text, call, say }) => {
  say('I’ll run /code for that.');
  await call('run_skill', { name: 'code', args: text }).catch(error => say(error.message));
  say('Done.');
});

/** model.request judgments for the /code skill on a scenario workspace: its checked-in solution. */
export const scenarioProvider = scenario => ({
  async judge({ prompt, schema, signal, onEvent = () => {} }) {
    signal?.throwIfAborted();
    onEvent({ provider: 'test', label: 'Scripted judgment' });
    const data = prompt.data?.value;
    const files = data?.files ?? data?.workspace?.files ?? [];
    const changes = await solutionChanges(scenario, files);
    const summary = changes.length ? 'Scripted patch for the scenario.' : 'The scenario change is already present.';
    if (schema?.properties?.edits) return { summary, edits: changes.map(change => ({ path: change.path, find: change.before, replace: change.after })) };
    return { summary, changes };
  },
});
