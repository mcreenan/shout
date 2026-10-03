import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from '../apps/shout/src/server.mjs';
import { codeAgent, scenarioProvider, ScriptedAgent } from '../apps/shout/test/doubles.mjs';

const stateRoot = await mkdtemp(resolve(tmpdir(), 'shout-browser-'));
// Scripted agent and judgments; the compiler, VM, workspace, approvals and tests are real.
const app = await startServer({ port: 0, stateRoot, agent: codeAgent(), providerFactory: data => scenarioProvider(data.scenario), checkProvider: async () => ({ available: true, version: 'scripted' }) });
let browser;
try {
  const executablePath = process.env.CHROMIUM_BIN || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const screenshotDir = resolve('.cache/shout-ui'); await mkdir(screenshotDir, { recursive: true });
  await page.goto(app.url);
  // Welcome: a sample starts its thread directly, with its prompt in the composer.
  await page.getByRole('list', { name: 'Samples' }).getByRole('button', { name: 'Fix a checkout calculation' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#session-'));
  assert.ok((await page.getByLabel('Message SHOUT').inputValue()).includes('checkout'));
  const id = await page.evaluate(() => location.hash.slice(1));
  // Model picker: models grouped by provider; before the first message any available model can be chosen.
  const models = page.getByRole('listbox', { name: 'Model' });
  await page.getByRole('button', { name: /^Model:/ }).click();
  await models.waitFor();
  assert.equal(await models.getByRole('option', { name: 'Opus 5.5' }).getAttribute('aria-disabled'), 'false');
  assert.equal(await models.getByRole('option', { selected: true }).count(), 1);
  assert.ok(await page.locator('#model-lock-note').isHidden());
  await page.keyboard.press('Escape');
  assert.ok(await models.isHidden());
  // Keyboard: arrows open it on the current model and move; Escape closes and returns focus.
  await page.getByRole('button', { name: /^Model:/ }).focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '6 Sol');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'model-button');
  // Effort lists the model's efforts and is saved on the session.
  await page.getByRole('button', { name: /^Reasoning effort:/ }).click();
  await page.getByRole('listbox', { name: 'Reasoning effort' }).getByRole('option', { name: 'High', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#effort-button').textContent.includes('High'));
  assert.equal(app.store.get(id).data.effort, 'high');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  assert.ok(!(await page.locator('#question-area').innerText()).includes('[object Object]'));
  // Locked after the first message: the picker still opens, every other model is disabled and says why.
  await page.getByRole('button', { name: /^Model:/ }).click();
  assert.equal(await models.getByRole('option', { name: 'Opus 5.5' }).getAttribute('aria-disabled'), 'true');
  assert.equal(await models.getByRole('option', { name: '6 Astra' }).getAttribute('aria-disabled'), 'false');
  assert.match(await page.locator('#model-lock-note').innerText(), /Locked after the first message/);
  await models.getByRole('option', { name: 'Opus 5.5' }).click({ force: true });
  assert.ok(await models.isVisible(), 'a disabled model cannot be chosen');
  await page.keyboard.press('Escape');
  assert.equal(app.store.get(id).data.model, 'gpt-6-astra');
  // Each proposed file is a chip with its diffstat; it opens Changes at that file.
  await page.locator('#question-area').getByRole('button', { name: 'pricing.mjs' }).click();
  await page.locator('.diff-file').waitFor();
  assert.match(await page.locator('.diff-title').innerText(), /pricing.mjs/);
  // Changes open beside the chat, so the approval card stays visible.
  assert.equal(await page.locator('#dock .group').count(), 2);
  assert.ok(await page.getByRole('button', { name: 'Approve', exact: true }).isVisible());
  assert.ok(await page.locator('.diff-line .tok-kw').count() > 0);
  assert.equal(app.store.get(id).data.status, 'waiting_user');
  await page.getByRole('button', { name: 'More options' }).click();
  assert.equal(await page.getByRole('menuitemcheckbox', { name: 'No time limits' }).getAttribute('aria-disabled'), 'true', 'time limits are fixed while a run is active');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#status-text').textContent.includes('idle'));
  assert.match(await page.locator('#messages').innerText(), /Tests passed/);
  assert.equal(app.store.get(id).data.runs[0].result.output.passed, true);
  // The recorded approval renders as a chip, not a chat bubble.
  assert.equal(await page.locator('#messages .message.echo .echo-chip.approved').count(), 1);
  // The overflow menu: the time-limit toggle (while idle) and the session export.
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'No time limits' }).click();
  await page.waitForFunction(() => document.querySelector('#more-menu [role=menuitemcheckbox]').getAttribute('aria-checked') === 'true');
  assert.equal(app.store.get(id).data.timeBudgetsEnabled, false);
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'No time limits' }).click();
  await page.waitForFunction(() => document.querySelector('#more-menu [role=menuitemcheckbox]').getAttribute('aria-checked') === 'false');
  await page.getByRole('button', { name: 'More options' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export session' }).click()]);
  assert.equal(download.suggestedFilename(), `shout-${id}.json`);
  // The executed ALLEN program is reachable from the chat and annotated with the run's effects.
  assert.equal(await page.locator('.run-card').count(), 1);
  assert.ok(await page.locator('.run-card .run-step').count() >= 4);
  await page.locator('.run-card').getByRole('button', { name: 'View program' }).click();
  await page.getByRole('tab', { name: /Program · Run 1/ }).waitFor();
  assert.match(await page.locator('.program-view').innerText(), /manifest/);
  assert.match(await page.locator('.program-view .inlay').first().innerText(), /^\d+×$/);
  assert.ok(await page.locator('.program-view .tok-kw').count() > 0);
  await page.screenshot({ path: resolve(screenshotDir, 'session-program.png') });
  // A skill run's name opens the skill's source in a tab.
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.locator('.run-card').getByRole('button', { name: 'Open skill /code' }).click();
  await page.getByRole('tab', { name: '/code', exact: true }).waitFor();
  assert.match(await page.locator('#dock .skill-view').innerText(), /manifest/);
  // Flow mode: the chat pane becomes a canvas of phase cards; the composer stays underneath.
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.locator('.run-card').getByRole('button', { name: 'Flow', exact: true }).click();
  await page.locator('#flow-stage .fl-card.hub').first().waitFor();
  assert.equal(await page.getByRole('radio', { name: 'Flow' }).getAttribute('aria-checked'), 'true');
  assert.ok(await page.locator('#messages').isHidden());
  assert.ok(await page.locator('#flow-stage .fl-card').count() >= 5);
  assert.match(await page.locator('#flow-stage .fl-card.tool .fl-time').first().innerText(), /\d+(ms|s)/);
  assert.ok(await page.locator('#flow-stage .fl-card.tool.pass .fl-icon').count() > 0, 'passing tests show a check');
  assert.ok(await page.locator('#flow-stage .fl-card.msg.final .fl-md').count() === 1, 'the closing reply renders in full');
  assert.ok(await page.getByLabel('Message SHOUT').isVisible());
  assert.ok(!(await page.locator('#flow-stage').innerText()).includes('Workspace changed'), 'bookkeeping stays off the canvas');
  await page.waitForTimeout(700); // cards fade in and the camera settles
  await page.screenshot({ path: resolve(screenshotDir, 'session-flow-chat.png') });
  // Selecting a card shows its whole record in the side panel; Escape clears it. Cards take keyboard focus.
  await page.locator('#flow-stage .fl-card.tool.pass').first().dispatchEvent('click');
  await page.locator('#side-panel .flow-detail').waitFor();
  assert.match(await page.locator('#side-panel .flow-detail').innerText(), /tests\.run[\s\S]*tool\.completed/);
  assert.equal(await page.locator('#flow-stage .fl-card.selected').count(), 1);
  await page.locator('#flow-stage .fl-card.selected').focus();
  await page.keyboard.press('Escape');
  await page.locator('#side-panel .flow-detail').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#flow-stage .fl-card.selected').count(), 0);
  await page.locator('#flow-stage .fl-card.hub.selectable').first().focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#flow-stage .fl-card.hub.selected').count(), 1);
  await page.getByRole('button', { name: 'Close step details' }).click();
  assert.equal(await page.locator('#flow-stage .fl-card.selected').count(), 0);
  await page.getByRole('radio', { name: 'Chat' }).click();
  await page.locator('.run-card').first().waitFor();
  await page.getByRole('button', { name: 'Open Events in a tab' }).click();
  await page.locator('.trace-event', { hasText: 'program.loaded' }).first().click();
  assert.ok(await page.getByRole('button', { name: 'Open ALLEN program' }).isVisible());
  await page.getByRole('button', { name: 'Close event details' }).click();
  await page.getByRole('button', { name: 'Open Events below' }).click();
  assert.equal(await page.locator('#dock .split.col').count(), 1);
  await page.screenshot({ path: resolve(screenshotDir, 'session-desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'pricing.mjs', exact: true }).click();
  await page.getByRole('tab', { name: 'pricing.mjs' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('#dock .code-view')].some((view) => view.textContent.includes('checkoutTotal')));
  assert.ok(await page.locator('#dock .code-view .tok-kw').count() > 0);
  await page.screenshot({ path: resolve(screenshotDir, 'session-tabs.png') });
  const tabsBeforeReload = await page.locator('#dock .tab').count();
  await page.getByRole('tab', { name: 'Chat' }).click();
  await page.getByLabel('Message SHOUT').fill('/test');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.message.assistant').length >= 4 && document.querySelector('#status-text').textContent.includes('completed'));
  assert.equal(app.store.get(id).data.runs.length, 2);
  assert.equal(app.store.get(id).data.runs[1].counters.modelJudgments, 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#status-text').textContent.includes('completed'));
  assert.match(await page.locator('#messages').innerText(), /Tests passed/);
  assert.equal(await page.locator('#dock .tab').count(), tabsBeforeReload, 'tab layout persists across reloads');
  // Add project (browser): a typed path; a missing folder is offered for creation: Nevermind keeps the form, Create makes it.
  const newFolder = resolve(stateRoot, 'made-by-dialog', 'project');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Workspace path').fill(newFolder);
  await page.getByRole('button', { name: 'Create & add' }).click();
  await page.getByRole('heading', { name: 'Create this folder?' }).waitFor();
  assert.equal(await page.locator('#create-folder-path').innerText(), newFolder);
  await page.getByRole('button', { name: 'Nevermind' }).click();
  assert.ok(await page.locator('#add-project-dialog').isVisible(), 'the add-project form stays open');
  assert.equal(existsSync(newFolder), false);
  await page.getByRole('button', { name: 'Create & add' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction((previous) => !document.querySelector('#add-project-dialog').open && location.hash.length > 1 && location.hash.slice(1) !== previous, id);
  assert.ok(existsSync(newFolder), 'the folder was created');
  const made = app.store.list().find((summary) => summary.workspace === newFolder);
  assert.ok(made, 'a thread opened in the new project');
  assert.equal(await page.evaluate(() => location.hash.slice(1)), made.id);
  // A new thread takes a message at once and its model can still be chosen.
  assert.equal(await page.evaluate(() => document.activeElement.id), 'message-input');
  assert.ok(await page.getByRole('button', { name: /^Model:/ }).isEnabled(), 'the model picker is enabled on a new empty thread');
  // The folder list under the path: pick a folder, add it; adding it again opens its thread.
  const existing = resolve(stateRoot, 'browse-me', 'existing-project');
  await mkdir(existing, { recursive: true });
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Workspace path').fill(`${resolve(stateRoot, 'browse-me')}/exi`);
  await page.locator('#dir-list').getByRole('button', { name: 'existing-project' }).click();
  assert.equal(await page.getByLabel('Workspace path').inputValue(), `${existing}/`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction((previous) => !document.querySelector('#add-project-dialog').open && location.hash.slice(1) !== previous, made.id);
  const kept = app.store.list().find((summary) => summary.workspace === existing);
  assert.ok(kept && app.store.projectList().some((project) => project.path === existing));
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.getByLabel('Workspace path').fill(existing);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#add-project-dialog').open);
  assert.equal(app.store.projectList().filter((project) => project.path === existing).length, 1);
  assert.equal(await page.evaluate(() => location.hash.slice(1)), kept.id);
  // Sidebar: project scope, search, rename, sleep and wake, delete, group by project.
  await page.locator('#project-scope').click();
  await page.getByRole('option', { name: /existing-project/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('#session-list .sb-thread').length === 1);
  assert.match(await page.locator('#project-scope').innerText(), /existing-project/);
  await page.locator('#project-scope').click();
  await page.getByRole('option', { name: /All projects/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('#session-list .sb-thread').length >= 3);
  await page.getByLabel('Search threads').fill('checkout');
  await page.waitForFunction(() => document.querySelectorAll('#session-list .sb-thread').length === 1);
  await page.getByLabel('Search threads').press('Escape');
  assert.equal(await page.getByLabel('Search threads').inputValue(), '');
  await page.locator(`.sb-thread[data-id="${made.id}"] .sb-open`).dblclick();
  await page.getByLabel('Thread title').fill('Renamed thread');
  await page.getByLabel('Thread title').press('Enter');
  await page.waitForFunction((thread) => document.querySelector(`.sb-thread[data-id="${thread}"] .sb-title`)?.textContent === 'Renamed thread', made.id);
  assert.equal(app.store.get(made.id).data.title, 'Renamed thread');
  await page.locator(`.sb-thread[data-id="${made.id}"]`).hover();
  await page.getByRole('button', { name: 'Sleep: Renamed thread' }).click();
  await page.waitForFunction((thread) => !document.querySelector(`.sb-thread.card[data-id="${thread}"]`), made.id);
  assert.equal(app.store.get(made.id).data.sleeping, true);
  await page.getByRole('button', { name: /^Sleeping/ }).click();
  await page.locator(`.sb-thread.slim[data-id="${made.id}"]`).hover();
  await page.getByRole('button', { name: 'Wake: Renamed thread' }).click();
  await page.locator(`.sb-thread.card[data-id="${made.id}"]`).waitFor();
  assert.equal(app.store.get(made.id).data.sleeping, false);
  await page.locator(`.sb-thread[data-id="${kept.id}"] .sb-open`).click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: 'Reveal in file manager' }).count(), 0, 'a browser cannot reveal server folders');
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: /^Delete/ }).getByRole('button', { name: 'Delete' }).click();
  await page.waitForFunction((thread) => !document.querySelector(`.sb-thread[data-id="${thread}"]`), kept.id);
  assert.equal(app.store.list().some((summary) => summary.id === kept.id), false);
  // Slow requests never pull the user off a thread they opened meanwhile. Deleting the open thread, then opening
  // another before the DELETE returns, leaves the user there.
  const spare = await page.evaluate((projectId) => fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shout-Client': '1' }, body: JSON.stringify({ projectId }) }).then((response) => response.json()), made.projectId);
  await page.locator(`.sb-thread[data-id="${spare.id}"] .sb-open`).click();
  await page.waitForFunction((thread) => location.hash === `#${thread}`, spare.id);
  let releaseDelete; const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  await page.route(`**/api/sessions/${spare.id}`, async (route) => { if (route.request().method() === 'DELETE') await deleteGate; await route.continue(); });
  await page.locator(`.sb-thread[data-id="${spare.id}"] .sb-open`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: /^Delete/ }).getByRole('button', { name: 'Delete' }).click();
  await page.locator(`.sb-thread[data-id="${id}"] .sb-open`).click();
  await page.waitForFunction((thread) => location.hash === `#${thread}`, id);
  releaseDelete();
  await page.waitForFunction((thread) => !document.querySelector(`.sb-thread[data-id="${thread}"]`), spare.id);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => location.hash.slice(1)), id, 'a slow delete leaves the user on the thread they opened meanwhile');
  await page.unroute(`**/api/sessions/${spare.id}`);
  // A new thread whose request is slow is still returned, but does not take over a thread opened meanwhile.
  let releaseCreate; const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  await page.route('**/api/sessions', async (route) => { if (route.request().method() === 'POST') await createGate; await route.continue(); });
  await page.evaluate((projectId) => { window.smokeNewThread = import('/sidebar.js').then((sidebar) => sidebar.newThread(projectId)); }, made.projectId);
  await page.locator(`.sb-thread[data-id="${made.id}"] .sb-open`).click();
  await page.waitForFunction((thread) => location.hash === `#${thread}`, made.id);
  releaseCreate();
  const later = await page.evaluate(() => window.smokeNewThread.then((thread) => thread && { id: thread.id, projectId: thread.projectId }));
  assert.ok(later?.id, 'newThread resolves the thread it made');
  assert.equal(later.projectId, made.projectId);
  await page.locator(`.sb-thread[data-id="${later.id}"]`).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => location.hash.slice(1)), made.id, 'the new thread does not take over the thread the user opened meanwhile');
  await page.unroute('**/api/sessions');
  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemradio', { name: 'Group by project' }).click();
  const madeGroup = page.locator(`.sb-group[data-project="${made.projectId}"] .sb-group-head`);
  assert.equal(await madeGroup.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator(`.sb-thread.nested[data-id="${made.id}"]`).count(), 1);
  await page.locator(`.sb-group[data-project="${app.store.get(id).data.projectId}"] .sb-group-head`).click();
  assert.equal(await page.locator(`.sb-group[data-project="${app.store.get(id).data.projectId}"] .sb-group-head`).getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator(`.sb-thread.nested[data-id="${id}"]`).count(), 0, 'a collapsed project hides threads that are not open');
  await page.locator(`.sb-group[data-project="${app.store.get(id).data.projectId}"] .sb-group-head`).click();
  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemradio', { name: 'Single list' }).click();
  await page.locator(`.sb-thread.card[data-id="${id}"]`).waitFor();
  // Samples live on the welcome screen now; the slug scenario is created through the API.
  const slug = await page.evaluate(() => fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shout-Client': '1' }, body: JSON.stringify({ scenario: 'slug' }) }).then((response) => response.json()));
  await page.goto(`${app.url}/#${slug.id}`);
  await page.reload();
  await page.waitForFunction((title) => document.title.startsWith(title), slug.title);
  await page.getByLabel('Message SHOUT').fill(slug.suggestedPrompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  // With another thread open, the slug thread's row says it needs approval.
  await page.locator(`.sb-thread[data-id="${id}"] .sb-open`).click();
  await page.waitForFunction((checkout) => location.hash === `#${checkout}`, id);
  assert.equal(await page.locator(`.sb-thread[data-id="${slug.id}"] .sb-status`).innerText(), 'Approval');
  await page.locator(`.sb-thread[data-id="${slug.id}"] .sb-open`).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await page.waitForFunction(() => document.querySelector('#status-text').textContent.includes('cancelled'));
  assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
  // Navigation never loses or misroutes text: a draft survives Home; a prompt typed while a send is pending stays;
  // a late reply after Home does not reopen the thread; a welcome send overtaken by opening a thread is not sent.
  const hold = async (pattern) => {
    let release, passed; const held = new Promise((resolve) => { release = resolve; }), through = new Promise((resolve) => { passed = resolve; });
    await page.route(pattern, async (route) => { if (route.request().method() !== 'POST') return route.continue(); await held; await route.continue(); passed(); });
    return async () => { release(); await through; await page.unroute(pattern); };
  };
  const composer = page.getByLabel('Message SHOUT');
  const openSlug = async () => { await page.locator(`.sb-thread[data-id="${slug.id}"] .sb-open`).click(); await page.waitForFunction((thread) => location.hash === `#${thread}`, slug.id); };
  await composer.fill('kept draft');
  await page.locator('.sb-brand').click();
  await openSlug();
  assert.equal(await composer.inputValue(), 'kept draft', 'Home keeps the thread draft');
  let release = await hold(`**/api/sessions/${slug.id}/messages`);
  await composer.fill(slug.suggestedPrompt);
  await composer.press('Enter');
  await composer.fill('the next prompt');
  await release();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  assert.equal(await composer.inputValue(), 'the next prompt', 'text typed while a send is pending stays');
  release = await hold(`**/api/sessions/${slug.id}/answer`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.locator('.sb-brand').click();
  const answered = page.waitForResponse((response) => response.url().endsWith('/answer'));
  await release(); await answered; await page.waitForTimeout(200);
  assert.equal(await page.title(), 'SHOUT', 'a late reply does not reopen the thread');
  assert.equal(await page.locator('#messages .message').count(), 0);
  await composer.fill('welcome text');
  release = await hold('**/api/sessions');
  await composer.press('Enter');
  await openSlug();
  await release(); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => location.hash.slice(1)), slug.id);
  assert.match(await composer.inputValue(), /^welcome text/, 'the overtaken send is kept in the composer');
  assert.ok(!app.store.list().some((summary) => app.store.get(summary.id).data.messages.some((message) => message.content === 'welcome text')), 'nothing was sent');
  // user.ask answer types: an optional field, a variant with its payload, a Float and a map. A re-ask keeps the
  // rejected answer and marks the field JOSH named; the fixed answer reaches the program decoded.
  const askProject = resolve(stateRoot, 'ask-project');
  await mkdir(resolve(askProject, '.shout', 'skills'), { recursive: true });
  await writeFile(resolve(askProject, '.shout', 'skills', 'pick.allen'), `manifest { language: "0.1" entry: main capabilities: [user.ask] }
enum Shape { Dot Line(Int, String) }
record Pick { owner: Option<String> shape: Shape ratio: Float counts: Map<String, Int> }
export async fn main(args: String) returns Pick effects [user.ask] {
  match await user.ask<Pick>(prompt { system: "Pick" output: Pick policy: { max_attempts: 2 } }) { Ok(answer) => answer Err(error) => stop(error.code) }
}`);
  const asking = await app.store.create({ workspace: askProject });
  await page.goto(`${app.url}/#${asking.data.id}`);
  await page.reload();
  app.store.send(asking.data.id, '/pick');
  const ask = page.locator('#question-area');
  await ask.getByRole('button', { name: 'Submit' }).click();
  assert.equal(await ask.getByRole('radiogroup', { name: 'Shape' }).getAttribute('aria-invalid'), 'true', 'a missing variant is marked here');
  const firstAsk = asking.data.question;
  asking.answer(firstAsk.id, { owner: { tag: 'Some', value: 'Ada' }, shape: { tag: 'Line', value: { 0: 7, 1: 'seven' } }, ratio: 0.5, counts: [{ key: 'a', value: 1 }, { key: 'a', value: 2 }] });
  const repeated = ask.getByLabel('Counts key').nth(1);
  await repeated.waitFor();
  assert.equal(await ask.getByLabel('Line 2').inputValue(), 'seven', 'the rejected answer is kept');
  assert.equal(await page.locator(`#${await repeated.getAttribute('aria-describedby')}`).innerText(), 'Duplicate key');
  await repeated.fill('b');
  await ask.getByRole('button', { name: 'Submit' }).click();
  await page.waitForFunction(() => document.querySelector('#status-text').textContent.includes('completed'));
  assert.deepEqual(asking.data.runs.at(-1).result.output, { owner: { tag: 'Some', value: 'Ada' }, shape: { tag: 'Line', value: [7, 'seven'] }, ratio: 0.5, counts: [['a', 1], ['b', 2]] });
  // A run that traps says where: "failed at line 3" on its card opens the Program tab with that row marked.
  const trapProject = resolve(stateRoot, 'trap-project');
  await mkdir(resolve(trapProject, '.shout', 'skills'), { recursive: true });
  await writeFile(resolve(trapProject, '.shout', 'skills', 'divide.allen'), `manifest { language: "0.1" entry: main capabilities: [] }
export fn main(args: String) returns Int {
  10 / length(args)
}
`);
  const trapping = await app.store.create({ workspace: trapProject });
  app.store.send(trapping.data.id, '/divide'); await trapping.task;
  await page.goto(`${app.url}/#${trapping.data.id}`);
  await page.reload();
  if (await page.getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked') !== 'true') await page.getByRole('radio', { name: 'Chat' }).click();
  assert.match(await page.locator('#messages .message').last().innerText(), /failed at line 3: division by zero/);
  await page.locator('.run-card').getByRole('button', { name: 'failed at line 3' }).click();
  const failedRow = page.locator('#dock .program-view .code-line.error-line');
  await failedRow.waitFor();
  assert.equal(await failedRow.count(), 1);
  assert.equal(await failedRow.locator('.ln').innerText(), '3');
  assert.equal(await failedRow.locator('.error-inlay').innerText(), 'division by zero');
  await page.screenshot({ path: resolve(screenshotDir, 'session-failed-line.png') });
  await page.getByRole('tab', { name: 'Chat' }).click();
  assert.ok(await page.locator('#messages .message').last().getByRole('button', { name: 'Open the program at line 3' }).isVisible());
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await page.locator('#sidebar .sb-thread').first().waitFor();
  await page.locator('#sidebar-toggle').click();
  await page.locator('#sidebar').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  assert.ok(await page.locator('#side-panel').isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: resolve(screenshotDir, 'session-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  // Sub-agents: a fan-out is one fleet card; a tile opens that agent's Flow in one tab (Flow only, no composer).
  const fleetRoot = await mkdtemp(resolve(tmpdir(), 'shout-fleet-'));
  await mkdir(resolve(fleetRoot, 'project'));
  const fleetAgent = new ScriptedAgent(async ({ call, say, thread }) => {
    const child = /^You are ([a-z][a-z0-9-]*), a sub-agent of SHOUT/.exec(thread.instructions)?.[1];
    if (child && !thread.tools.some((tool) => tool.name === 'spawn_agents')) { await call('list_files', {}); say(`Report from ${child}.`); return; }
    await call('spawn_agents', { purpose: 'survey', agents: ['alpha', 'beta', 'gamma'].map((name) => ({ name, brief: `Survey the project as ${name}.` })) });
    say('All three reported.');
  });
  const fleetApp = await startServer({ port: 0, stateRoot: resolve(fleetRoot, 'state'), agent: fleetAgent, checkProvider: async () => ({ available: true, version: 'scripted' }) });
  try {
    const fleet = await fleetApp.store.create({ workspace: resolve(fleetRoot, 'project') });
    fleetApp.store.send(fleet.data.id, 'Fan out'); await fleet.task;
    const fleetPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    fleetPage.on('pageerror', error => errors.push(error.message));
    await fleetPage.addInitScript(() => localStorage.setItem('shout.chatMode', 'flow'));
    await fleetPage.goto(`${fleetApp.url}/#${fleet.data.id}`);
    await fleetPage.locator('#flow-stage .fl-card.fleet .fleet-tile').first().waitFor();
    assert.equal(await fleetPage.locator('#flow-stage .fleet-tile').count(), 3);
    await fleetPage.locator('.fleet-tile', { hasText: 'beta' }).dispatchEvent('click');
    await fleetPage.getByRole('tab', { name: 'beta' }).waitFor();
    await fleetPage.locator('.fleet-tile', { hasText: 'beta' }).dispatchEvent('click');
    assert.equal(await fleetPage.getByRole('tab', { name: 'beta' }).count(), 1, 'a second click focuses the open tab');
    const agentPane = fleetPage.locator('#dock .agent-pane');
    await agentPane.locator('.flow-stage .fl-card').first().waitFor();
    assert.equal(await agentPane.locator('textarea').count(), 0);
    await fleetPage.waitForTimeout(700); // the chat pane narrows and cards settle
    await fleetPage.screenshot({ path: resolve(screenshotDir, 'session-fleet.png') });
    await fleetPage.close();
  } finally { await fleetApp.close(); await rm(fleetRoot, { recursive: true, force: true }); }
  console.log('PASS browser: scenario → chat → exact diff → approve → real ALLEN edit/tests → VIZ/source → tabs/splits → highlighted file tab → /test → reload → cancellation → mobile; no uncaught page errors.');
} finally {
  await browser?.close(); await app.close(); await rm(stateRoot, { recursive: true, force: true });
}
