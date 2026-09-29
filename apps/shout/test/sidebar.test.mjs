import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, PALETTE, shelved, monogram, monogramColor, relativeTime, activityTime, threadStatus, unseen, topStatus, summarize, sortThreads, matches, visibleThreads, groupThreads, capThreads, recentProject, abbreviatePath, splitPath, stepThread, attentionCount, notices, navigation, stillHere, afterDelete } from '../public/sidebar-logic.js';

const at = (iso) => Date.parse(iso);
const thread = (id, fields = {}) => ({ id, title: `Thread ${id}`, projectId: 'p1', status: 'idle', attention: null, sleeping: false, createdAt: '2026-09-01T00:00:00Z', lastMessageAt: null, messageCount: 0, ...fields });

test('monograms take the first letter, then a digit, the last word or the last letter', () => {
  assert.equal(monogram('Nebula'), 'NA');
  assert.equal(monogram('Silver Orchard'), 'SO');
  assert.equal(monogram('M7 Forge'), 'M7');
  assert.equal(monogram('shout-agent-whimsy-1790471148'), 'S1');
  assert.equal(monogram('x'), 'XX');
  assert.equal(monogram('  '), 'PR');
  assert.equal(monogram('élan vital'), 'ÉV');
});

test('monogram colours are stable per name, case-insensitive, and legible pairs from the palette', () => {
  assert.equal(PALETTE.length, 18);
  assert.deepEqual(monogramColor('shout'), monogramColor('SHOUT'));
  assert.deepEqual(monogramColor('shout'), monogramColor(' shout '));
  assert.ok(PALETTE.includes(monogramColor('experiments')));
  assert.notDeepEqual(monogramColor('three'), monogramColor('two'));
  for (const [light, dark] of PALETTE) assert.match(`${light}${dark}`, /^#[0-9a-f]{6}#[0-9a-f]{6}$/);
});

test('relative times are compact', () => {
  const now = at('2026-09-27T12:00:00Z');
  assert.equal(relativeTime('2026-09-27T11:59:30Z', now), 'now');
  assert.equal(relativeTime('2026-09-27T12:00:30Z', now), 'now');
  assert.equal(relativeTime('2026-09-27T11:55:00Z', now), '5m');
  assert.equal(relativeTime('2026-09-27T09:00:00Z', now), '3h');
  assert.equal(relativeTime('2026-09-25T12:00:00Z', now), '2d');
  assert.equal(relativeTime('2026-09-06T12:00:00Z', now), '3w');
  assert.equal(relativeTime('2026-05-27T12:00:00Z', now), '4mo');
  assert.equal(relativeTime('2024-09-01T12:00:00Z', now), '2y');
  assert.equal(relativeTime('not a date', now), '');
  assert.equal(relativeTime(null, now), '');
});

test('activity is the last message, else the creation time', () => {
  assert.equal(activityTime(thread('a', { lastMessageAt: '2026-09-02T00:00:00Z' })), '2026-09-02T00:00:00Z');
  assert.equal(activityTime(thread('a')), '2026-09-01T00:00:00Z');
});

test('status labels: approval, input, working, failed and unseen completions only', () => {
  const visited = '2026-09-10T00:00:00Z';
  assert.equal(threadStatus(thread('a', { status: 'waiting_user', attention: 'approval' }), visited), 'approval');
  assert.equal(threadStatus(thread('a', { status: 'waiting_user', attention: 'ask' }), visited), 'input');
  assert.equal(threadStatus(thread('a', { status: 'thinking' }), visited), 'working');
  assert.equal(threadStatus(thread('a', { status: 'running' }), visited), 'working');
  assert.equal(threadStatus(thread('a', { status: 'failed' }), visited), 'failed');
  const finished = thread('a', { status: 'completed', messageCount: 3, lastMessageAt: '2026-09-11T00:00:00Z' });
  assert.equal(threadStatus(finished, visited), 'done');
  assert.equal(threadStatus(finished, '2026-09-12T00:00:00Z'), null, 'seen since it finished');
  assert.equal(threadStatus(finished, undefined), null, 'never visited here: not unread');
  assert.equal(threadStatus({ ...finished, status: 'cancelled' }, visited), null, 'cancelled by the user');
  assert.equal(threadStatus({ ...finished, status: 'interrupted' }, visited), 'failed', 'interrupted while away');
  assert.equal(threadStatus(thread('a', { status: 'idle' }), visited), null, 'empty thread');
  assert.equal(STATUS.approval, 'Approval');
  assert.equal(unseen({ ...finished }, 'garbage'), true);
});

test('the most urgent status wins', () => {
  assert.equal(topStatus(['done', 'working', null, 'input']), 'input');
  assert.equal(topStatus(['failed', 'done']), 'failed');
  assert.equal(topStatus([null]), null);
});

test('a snapshot summarizes like the server, and summaries pass through', () => {
  const snapshot = { id: 's1', title: 'T', projectId: 'p1', workspace: '/w', status: 'waiting_user', question: { kind: 'approval' }, createdAt: 'c', updatedAt: 'u', sleeping: false, model: 'm', effort: 'e', provider: 'codex', modelLocked: true, messages: [{ time: 't1' }, { time: 't2' }], runs: [{}], unavailable: false, events: [{}] };
  const summary = summarize(snapshot);
  assert.equal(summary.attention, 'approval');
  assert.equal(summary.lastMessageAt, 't2');
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.runCount, 1);
  assert.equal('events' in summary, false);
  assert.equal(summarize({ ...snapshot, question: { kind: 'ask' } }).attention, 'ask');
  assert.equal(summarize({ ...snapshot, status: 'running' }).attention, null);
  assert.equal(summarize(summary), summary);
});

test('threads sort by activity or creation, filter by scope and query, and split out the sleeping ones', () => {
  const projects = new Map([['p1', { id: 'p1', name: 'shout' }], ['p2', { id: 'p2', name: 'Experiments' }]]);
  const threads = [
    thread('a', { title: 'Fix checkout', createdAt: '2026-09-01T00:00:00Z', lastMessageAt: '2026-09-05T00:00:00Z' }),
    thread('b', { title: 'Write docs', createdAt: '2026-09-03T00:00:00Z' }),
    thread('c', { title: 'Old idea', projectId: 'p2', createdAt: '2026-09-02T00:00:00Z', sleeping: true }),
  ];
  assert.deepEqual(sortThreads(threads).map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual(sortThreads(threads, 'created').map((item) => item.id), ['b', 'c', 'a']);
  assert.ok(matches(threads[0], projects.get('p1'), 'CHECK shout'));
  assert.ok(!matches(threads[0], projects.get('p1'), 'checkout docs'));
  assert.ok(matches(threads[2], projects.get('p2'), 'experiments'));
  const all = visibleThreads(threads, projects);
  assert.deepEqual(all.awake.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(all.sleeping.map((item) => item.id), ['c']);
  assert.deepEqual(visibleThreads(threads, projects, { scope: 'p2' }).sleeping.map((item) => item.id), ['c']);
  assert.deepEqual(visibleThreads(threads, projects, { scope: 'p2' }).awake, []);
  assert.deepEqual(visibleThreads(threads, projects, { query: 'docs' }).awake.map((item) => item.id), ['b']);
  // A thread whose folder is gone is history: it goes on the shelf with the sleeping ones.
  const gone = [...threads, thread('d', { title: 'Missing folder', unavailable: true, lastMessageAt: '2026-09-09T00:00:00Z' })];
  assert.deepEqual(visibleThreads(gone, projects).awake.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(visibleThreads(gone, projects).sleeping.map((item) => item.id), ['d', 'c']);
  assert.ok(shelved({ unavailable: true }) && shelved({ sleeping: true }) && !shelved({}));
});

test('groups order projects by their latest thread and keep empty ones last', () => {
  const projects = new Map([['p1', { id: 'p1', name: 'shout' }], ['p2', { id: 'p2', name: 'beta' }], ['p3', { id: 'p3', name: 'alpha' }]]);
  const threads = [thread('a', { projectId: 'p2', lastMessageAt: '2026-09-09T00:00:00Z' }), thread('b', { projectId: 'p1' })];
  assert.deepEqual(groupThreads(threads, projects).map((group) => [group.project.id, group.threads.length]), [['p2', 1], ['p1', 1], ['p3', 0]]);
  assert.deepEqual(groupThreads(threads, projects, { scope: 'p1' }).map((group) => group.project.id), ['p1']);
  assert.deepEqual(groupThreads([], projects, { query: 'alp' }).map((group) => group.project.id), ['p3'], 'a search keeps projects whose name matches');
});

test('groups cap their threads but keep the open one visible', () => {
  const threads = Array.from({ length: 9 }, (_, i) => thread(`t${i}`));
  assert.deepEqual(capThreads(threads.slice(0, 6)), { shown: threads.slice(0, 6), hidden: 0 });
  const capped = capThreads(threads, { openId: 't8' });
  assert.deepEqual(capped.shown.map((item) => item.id), ['t0', 't1', 't2', 't3', 't4', 't5', 't8']);
  assert.equal(capped.hidden, 2);
  assert.equal(capThreads(threads, { all: true }).shown.length, 9);
});

test('new threads go to the most recently active project, preferring your own over samples', () => {
  const projects = [{ id: 'sample', name: 'Fix a checkout calculation', sample: 'pricing', updatedAt: '2026-09-20T00:00:00Z' }, { id: 'p1', name: 'shout', updatedAt: '2026-09-01T00:00:00Z' }, { id: 'p2', name: 'two', updatedAt: '2026-09-02T00:00:00Z' }];
  assert.equal(recentProject(projects, [thread('a', { projectId: 'p1', lastMessageAt: '2026-09-25T00:00:00Z' }), thread('b', { projectId: 'sample', lastMessageAt: '2026-09-26T00:00:00Z' })]).id, 'p1');
  assert.equal(recentProject(projects, []).id, 'p2');
  assert.equal(recentProject([projects[0]], []).id, 'sample');
  assert.equal(recentProject([], []), null);
});

test('paths abbreviate the home folder and split for browsing', () => {
  assert.equal(abbreviatePath('/home/me/p/shout', '/home/me'), '~/p/shout');
  assert.equal(abbreviatePath('/home/me', '/home/me'), '~');
  assert.equal(abbreviatePath('/home/meadow/x', '/home/me'), '/home/meadow/x');
  assert.equal(abbreviatePath('/srv/x', undefined), '/srv/x');
  assert.deepEqual(splitPath('/home/me/p/sh'), { dir: '/home/me/p', prefix: 'sh' });
  assert.deepEqual(splitPath('/home/me/p/'), { dir: '/home/me/p', prefix: '' });
  assert.deepEqual(splitPath('/'), { dir: '/', prefix: '' });
  assert.deepEqual(splitPath('/home'), { dir: '/', prefix: 'home' });
  assert.deepEqual(splitPath('~/'), { dir: '~', prefix: '' });
  assert.deepEqual(splitPath('~'), { dir: '~', prefix: '' });
  assert.deepEqual(splitPath(''), { dir: '~', prefix: '' });
  assert.deepEqual(splitPath('relative'), { dir: '', prefix: 'relative' });
});

test('previous and next stop at the ends; from nothing they start at an end', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(stepThread(ids, 'b', 1), 'c');
  assert.equal(stepThread(ids, 'c', 1), 'c');
  assert.equal(stepThread(ids, 'a', -1), 'a');
  assert.equal(stepThread(ids, null, 1), 'a');
  assert.equal(stepThread(ids, 'gone', -1), 'c');
  assert.equal(stepThread([], 'a', 1), null);
});

test('notifications: new approvals and questions, finished and failed tasks, never the thread in view', () => {
  const before = new Map([
    ['a', thread('a', { status: 'running' })], ['b', thread('b', { status: 'running' })], ['c', thread('c', { status: 'thinking' })],
    ['d', thread('d', { status: 'running' })], ['e', thread('e', { status: 'running' })], ['f', thread('f', { status: 'waiting_user', attention: 'approval' })],
  ]);
  const after = [
    thread('a', { status: 'waiting_user', attention: 'approval' }), thread('b', { status: 'completed' }), thread('c', { status: 'failed' }),
    thread('d', { status: 'cancelled' }), thread('e', { status: 'waiting_user', attention: 'ask' }), thread('f', { status: 'waiting_user', attention: 'approval' }), thread('new', { status: 'running' }),
  ];
  assert.deepEqual(notices(before, after).map(({ id, body }) => [id, body]), [['a', 'Needs approval'], ['b', 'Finished'], ['c', 'Failed'], ['e', 'Needs input']]);
  assert.deepEqual(notices(before, after, 'a').map(({ id }) => id), ['b', 'c', 'e']);
  assert.equal(notices(before, after)[0].title, 'Thread a');
  assert.equal(attentionCount(after), 3);
});

test('actions that finish later never move a user who opened or closed a thread meanwhile', () => {
  const on = (id, selection) => navigation({ selection, session: id ? { id } : null });
  assert.deepEqual(on('a', 3), { selection: 3, open: 'a' });
  assert.deepEqual(navigation({}), { selection: 0, open: null });
  assert.ok(stillHere(on('a', 3), on('a', 3)), 'nothing happened: a new thread may still open');
  assert.ok(!stillHere(on('a', 3), on('a', 4)), 'opening another thread has started (still loading): stay put');
  assert.ok(!stillHere(on('a', 3), on('b', 4)), 'another thread is open');
  assert.ok(!stillHere(on('a', 3), on(null, 4)), 'the thread was closed');
  assert.ok(!stillHere(on(null, 0), on('b', 1)), 'from the welcome screen, the user opened a thread');
});

test('after a delete, the next thread opens only if the user is still on the deleted one', () => {
  const on = (id, selection) => navigation({ selection, session: id ? { id } : null });
  assert.deepEqual(afterDelete({ deleted: 'a', next: 'b', before: on('a', 1), after: on('a', 1) }), { open: 'b' });
  assert.deepEqual(afterDelete({ deleted: 'a', next: null, before: on('a', 1), after: on('a', 1) }), { deselect: true });
  assert.deepEqual(afterDelete({ deleted: 'a', next: 'a', before: on('a', 1), after: on('a', 1) }), { deselect: true });
  assert.equal(afterDelete({ deleted: 'a', next: 'b', before: on('a', 1), after: on('c', 2) }), null, 'the user opened C while the delete ran');
  assert.equal(afterDelete({ deleted: 'a', next: 'b', before: on('a', 1), after: on('a', 2) }), null, 'opening another thread is still loading');
  assert.equal(afterDelete({ deleted: 'a', next: 'b', before: on('c', 1), after: on('c', 1) }), null, 'the deleted thread was not open');
  assert.equal(afterDelete({ deleted: 'a', next: 'b', before: on('a', 1), after: on(null, 2) }), null, 'the thread was already closed (its stream said deleted)');
});
