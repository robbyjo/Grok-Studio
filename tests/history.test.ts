import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/store';
import { Diagnostics } from '../electron/diagnostics';
import { validateShortcuts, defaultShortcuts } from '../shared/shortcuts';

function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'grok-index-'));
  const file = join(folder, 'state.json');
  const store = new Store(file);
  store.openProject(folder, 'History fixture');
  return { folder, file, store, project: store.state.projects[0] };
}
test('indexed literal search pages Unicode/punctuation and removes obsolete index rows', () => {
  const { store, project, folder } = setup();
  const thread = store.create(project.id, folder);
  thread.entries = Array.from({ length: 240 }, (_, n) => ({
    id: `e${n}`,
    type: 'assistant' as const,
    text: `CAFÉ 東京 [a.*] exact-${n}`,
  }));
  store.flush();
  const options = { archived: true, hidden: true };
  const first = store.history.search(undefined, 'café 東京', options);
  assert.equal(first.hits.length, 100);
  assert.equal(first.nextOffset, 100);
  const second = store.history.search(undefined, 'café 東京', { ...options, offset: 100 });
  assert.equal(second.hits[0].entryId, 'e100');
  assert.equal(store.history.search(undefined, '[a.*]', options).hits.length, 100);
  assert.equal(store.history.search(undefined, '東京', options).hits.length, 100);
  assert.equal(store.history.search(undefined, 'exact-239', options).hits[0].entryId, 'e239');
  assert.equal(
    store.page(thread.id, undefined, 'e1').entries.some((e) => e.id === 'e1'),
    true,
  );
  thread.entries = [{ id: 'replacement', type: 'assistant', text: 'replacement only' }];
  store.flush();
  assert.equal(store.history.search(undefined, 'café 東京', options).hits.length, 0);
  assert.equal(store.page(thread.id).total, 1);
  thread.archived = true;
  store.flush();
  assert.equal(
    store.history.search(undefined, 'replacement', { ...options, archived: false }).hits.length,
    0,
  );
  store.prune([thread.id], true);
  assert.equal(store.history.stats().entries, 0);
  store.history.db.close();
});
test('bounded cache and IPC preserve complete stored transcripts and recover latest transactional metadata', () => {
  const { store, project, folder, file } = setup();
  const t = store.create(project.id, folder);
  t.entries = Array.from({ length: 500 }, (_, n) => ({
    id: `e${n}`,
    type: 'assistant' as const,
    text: 'content '.repeat(2500),
  }));
  store.flush();
  assert.ok(store.cacheStats().entries <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(store.snapshot())) < 1024 * 1024);
  assert.equal(store.fullHistory(t.id).length, 500);
  assert.equal(store.fullHistory(t.id)[0].text.length, 20000);
  const latest = store.create(project.id, folder);
  latest.queue = [{ id: 'q', text: 'retained', state: 'queued' }];
  latest.status = 'running';
  store.flush();
  store.drafts({ composer: { [t.id]: 'unsent text' } });
  store.history.db.close();
  writeFileSync(file, '{corrupt');
  const restored = new Store(file);
  assert.equal(restored.thread(latest.id).status, 'interrupted');
  assert.equal(restored.thread(latest.id).queue![0].state, 'paused');
  assert.equal(restored.fullHistory(t.id).length, 500);
  assert.equal(restored.history.value('drafts').composer[t.id], 'unsent text');
  assert.equal(
    readFileSync(
      join(
        folder,
        readdirSync(folder).find((f) => f.includes('.corrupt-'))!,
      ),
      'utf8',
    ),
    '{corrupt',
  );
  restored.history.db.close();
});
test('bulk organization validates the entire mutation; native roster normalizes and scopes IDs', () => {
  const { store, project, folder } = setup();
  assert.throws(
    () => store.organization({ projectIds: [project.id], pinned: true, order: ['foreign'] }),
    /every project/,
  );
  assert.equal(project.pinned, undefined);
  store.organization({ projectIds: [project.id], pinned: true, group: 'Core' });
  const t = store.create(project.id, folder);
  t.sessionId = 'owner';
  store.vendorUpdate(t.id, {
    sessionUpdate: 'subagents_snapshot',
    subagents: [
      {
        subagentId: 'child',
        parentSessionId: 'owner',
        tokensUsed: 42,
        subagentType: 'explore',
        toolCallCount: 2,
      },
      { subagentId: 'foreign', parentSessionId: 'other' },
    ],
  });
  assert.equal(t.subagents!.length, 1);
  assert.equal(t.subagents![0].tokens_used, 42);
  assert.equal(t.subagents![0].subagent_type, 'explore');
  t.status = 'running';
  assert.throws(() => store.bulkChats([t.id], { archived: true }), /Stop active/);
  assert.equal(t.archived, false);
  store.flush();
  store.history.db.close();
});
test('diagnostics rotate bounded safe events and shortcut validation reserves editor bindings', () => {
  const { folder, store } = setup();
  store.history.db.close();
  const logs = new Diagnostics(folder);
  for (let i = 0; i < 12000; i++)
    logs.record('probe', {
      method: 'm'.repeat(160),
      code: 'ghp_secretValue',
      prompt: 'private message',
    });
  const files = readdirSync(folder).filter((f) => f.startsWith('events.jsonl'));
  assert.ok(files.length <= 4);
  assert.ok(
    files.reduce((n, f) => n + statSync(join(folder, f)).size, 0) < 4 * (512 * 1024 + 1024),
  );
  assert.equal(logs.list().length, 1000);
  assert.ok(!JSON.stringify(logs.list()).includes('private message'));
  assert.ok(!JSON.stringify(logs.list()).includes('ghp_secretValue'));
  assert.throws(() => validateShortcuts({ ...defaultShortcuts, search: 'Ctrl+S' }), /reserved/);
  assert.throws(() => validateShortcuts({ ...defaultShortcuts, search: 'Ctrl+N' }), /distinct/);
});
