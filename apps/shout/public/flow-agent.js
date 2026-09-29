// A sub-agent's dock tab: a header (name, state, model, tokens; the brief folded to one line) over the
// agent's own Flow canvas. Flow only: no Chat mode and no composer, since SHOUT does the steering.
import { createFlowCanvas } from './flow-canvas.js';
import { tokens } from './flow.js';
import { effortLabel } from './model-picker.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const STATE = { queued: 'queued', running: 'active', completed: 'ok', failed: 'failed', cancelled: 'stale', interrupted: 'stale' };
const MARK = { ok: 'M5 12.5l4.5 4.5L19 7.5', failed: 'M6.5 6.5l11 11M17.5 6.5l-11 11' };

/**
 * Builds the pane for `tab` ({ agent }). `session()` returns the current session snapshot (with `agents`),
 * `modelLabel(id)` names the model. `openFile` and `onSelect` go to the canvas.
 * Returns the pane element with `refresh()` (call after each snapshot) and `stop()`.
 */
export function createAgentPane(tab, { session, modelLabel = (id) => id, openFile, onSelect }) {
  const agentOf = () => session()?.agents?.find((item) => item.id === tab.agent) || null;
  const pane = el('div', 'agent-pane');
  const header = el('div', 'agent-header');
  const brief = el('button', 'agent-brief');
  brief.type = 'button';
  brief.setAttribute('aria-expanded', 'false');
  brief.addEventListener('click', () => brief.setAttribute('aria-expanded', String(brief.getAttribute('aria-expanded') !== 'true')));
  const error = el('p', 'agent-error');
  const stage = el('div', 'flow-stage agent-stage');
  const empty = el('p', 'empty-copy', 'Agent not found');
  pane.append(header, brief, error, stage, empty);
  const canvas = createFlowCanvas(stage, { anchor: 40, top: 20, openFile, onSelect });
  canvas.start(() => {
    const agent = agentOf();
    const current = session();
    return agent && current && {
      // The brief is the header's; the canvas starts with the agent's first step.
      session: { id: agent.id, messages: (agent.messages || []).filter((message, i) => i || message.role !== 'user'), runs: [], agents: [], revision: current.revision },
      events: agent.events || [], now: Date.now(), live: agent.status === 'running', actor: { name: agent.name, kind: 'agent' },
    };
  });
  let signature = '';
  function refresh() {
    const agent = agentOf();
    const next = JSON.stringify(agent && [agent.name, agent.status, agent.model, agent.effort, agent.usage, agent.brief, agent.error]);
    if (next === signature) return;
    signature = next;
    for (const node of [header, brief, stage]) node.hidden = !agent;
    empty.hidden = !!agent;
    error.hidden = !agent?.error;
    if (!agent) return;
    const state = STATE[agent.status] || 'stale';
    const mark = el('i', `fl-state ${state}`);
    if (MARK[state]) mark.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MARK[state]}"/></svg>`;
    mark.title = agent.status;
    mark.setAttribute('role', 'img');
    mark.setAttribute('aria-label', agent.status);
    const usage = tokens(agent.usage || {});
    header.replaceChildren(mark, el('strong', 'agent-name', agent.name), el('span', 'agent-meta', [modelLabel(agent.model), effortLabel(agent.effort), usage].filter(Boolean).join(' · ')));
    brief.textContent = agent.brief || '';
    error.textContent = agent.error || '';
  }
  refresh();
  return Object.assign(pane, { refresh, stop: () => canvas.stop(), canvas });
}
