import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/store';
import { searchTranscripts } from '../electron/search';
import type { State, Thread } from '../shared/types';

function fixture() {
  const state: State = {
    version: 1,
    settings: { executable: 'grok' },
    projects: [{ id: 'p', name: 'Project', path: '/repo' }],
    threads: [],
  };
  const chat: Thread = {
    id: 't',
    projectId: 'p',
    title: 'Feature chat',
    cwd: '/repo',
    status: 'idle',
    pinned: false,
    archived: false,
    createdAt: '2026-10-07',
    updatedAt: '2026-10-07',
    entries: [],
  };
  state.threads.push(chat);
  return { state, chat };
}
const scope = { archived: true, hidden: false };

test('search finds literal Unicode text, full tool output, plans and metadata, excluding session secrets', async () => {
  const { state, chat } = fixture();
  chat.session = { secret: 'credential-only' };
  chat.entries = [
    { id: 'u', type: 'user', text: 'Please fix [a.*] and CAFÉ 東京.' },
    { id: 'a', type: 'assistant', text: 'Working on café 東京.' },
    { id: 'r', type: 'thought', text: 'Reason about cancellation.' },
    { id: 'p', type: 'plan', text: 'Plan', data: { entries: [{ content: 'Verify recovery.' }] } },
    {
      id: 'tool',
      type: 'tool',
      text: 'Build',
      data: {
        rawOutput: 'x'.repeat(90_000) + ' unique-tail-match',
        secretExtra: 'unrendered-only',
      },
    },
    { id: 'notice', type: 'notice', text: 'Update', data: { detail: 'reconnected' } },
  ];
  assert.deepEqual(
    (await searchTranscripts(state, '[a.*]', scope)).hits.map((hit) => hit.entryId),
    ['u'],
  );
  const unicode = await searchTranscripts(state, 'café 東京', scope);
  assert.equal(unicode.hits.length, 2);
  assert.equal(unicode.hits[0].match, 'CAFÉ 東京');
  assert.equal(
    (await searchTranscripts(state, 'unique-tail-match', scope)).hits[0].entryId,
    'tool',
  );
  for (const [text, kind] of [
    ['Feature', 'chat'],
    ['recovery', 'plan'],
    ['cancellation', 'thought'],
    ['reconnected', 'notice'],
  ])
    assert.equal((await searchTranscripts(state, text, scope)).hits[0].kind, kind);
  assert.equal((await searchTranscripts(state, 'credential-only', scope)).hits.length, 0);
  assert.equal((await searchTranscripts(state, 'unrendered-only', scope)).hits.length, 0);
});

test('search scopes archived and removed projects explicitly, sorting by recent chat', async () => {
  const { state, chat } = fixture();
  chat.archived = true;
  chat.title = 'Match archived';
  state.projects.push({ id: 'hidden', name: 'Removed', path: '/hidden', hidden: true });
  state.threads.push({
    ...chat,
    id: 'hidden-chat',
    projectId: 'hidden',
    archived: false,
    title: 'Match removed',
    updatedAt: '2026-10-08',
  });
  assert.equal(
    (await searchTranscripts(state, 'match', { archived: false, hidden: false })).hits.length,
    0,
  );
  assert.deepEqual(
    (await searchTranscripts(state, 'match', scope)).hits.map((hit) => hit.threadId),
    ['t'],
  );
  const results = await searchTranscripts(state, 'match', { archived: true, hidden: true });
  assert.deepEqual(
    results.hits.map((hit) => hit.threadId),
    ['hidden-chat', 't'],
  );
  assert.equal(results.hits[0].hidden, true);
  assert.equal(results.hits[1].archived, true);
});

test('search caps results, reports truncation only with more matches, validates and bounds snippets', async () => {
  const { state, chat } = fixture();
  chat.entries = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
    type: 'user' as const,
    text: 'b'.repeat(10_000) + ' Needle ' + 'c'.repeat(10_000),
  }));
  const result = await searchTranscripts(state, 'needle', scope);
  assert.equal(result.hits.length, 100);
  assert.equal(result.truncated, false);
  assert.ok(result.hits[0].before.length <= 71 && result.hits[0].after.length <= 101);
  chat.entries.push({ id: 'more', type: 'user', text: 'needle' });
  assert.equal((await searchTranscripts(state, 'needle', scope)).truncated, true);
  assert.deepEqual(await searchTranscripts(state, '   ', scope), { hits: [], truncated: false });
  await assert.rejects(searchTranscripts(state, 'x'.repeat(513), scope), /512/);
  await assert.rejects(searchTranscripts(state, '\0', scope), /512/);
});

test('long search yields and discards results when superseded', async () => {
  const { state, chat } = fixture();
  chat.entries = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index),
    type: 'user' as const,
    text: 'unmatched',
  }));
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  const result = await searchTranscripts(state, 'not present', scope, () => cancelled);
  assert.equal(cancelled, true);
  assert.deepEqual(result, { hits: [], truncated: false });
});

test('project rename/remove/restore persists identities, transcripts, worktree paths and archive flags', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'grok-projects-'));
  const file = join(folder, 'state.json');
  const store = new Store(file);
  const project = store.openProject(folder, 'Original');
  const thread = store.create(project.id, join(folder, 'worktree'));
  thread.archived = true;
  thread.sessionId = 'resume-me';
  thread.entries.push({ id: 'saved', type: 'assistant', text: 'Retain this transcript.' });
  store.editProject(project.id, { name: ' Renamed ', hidden: true });
  const restored = new Store(file);
  assert.equal(restored.project(project.id).hidden, true);
  assert.equal(restored.project(project.id).name, 'Renamed');
  assert.deepEqual(restored.thread(thread.id), thread);
  // Reopening the canonical folder restores the original project, rather than duplicating it.
  const reopened = restored.openProject(folder, 'Ignored directory name');
  assert.equal(reopened.id, project.id);
  assert.equal(reopened.name, 'Renamed');
  assert.equal(reopened.hidden, false);
  assert.equal(restored.state.projects.length, 1);
  assert.deepEqual(new Store(file).thread(thread.id), thread);
});

test('project removal refuses active turns and invalid rename atomically', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'grok-project-guard-'));
  const file = join(folder, 'state.json');
  const store = new Store(file);
  const project = store.openProject(folder, 'Keep');
  const thread = store.create(project.id, folder);
  for (const status of ['running', 'approval', 'connecting'] as const) {
    thread.status = status;
    assert.throws(
      () => store.editProject(project.id, { name: 'Must not save', hidden: true }),
      /Stop active/,
    );
    assert.equal(project.name, 'Keep');
    assert.equal(project.hidden, false);
  }
  thread.status = 'idle';
  for (const name of ['', ' ', 'x'.repeat(121), '\0'])
    assert.throws(() => store.editProject(project.id, { name, hidden: true }), /project name/);
  store.flush();
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].hidden, false);
  assert.throws(() => store.editProject('foreign-id', { hidden: true }), /not found/);
});
