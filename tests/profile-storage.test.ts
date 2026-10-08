import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  utimes,
  symlink,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProfileStorage, profileBudget } from '../electron/profile-storage';
import type { Thread } from '../shared/types';
import { DatabaseSync } from 'node:sqlite';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grok-retention-')),
    desktop = join(root, 'desktop'),
    home = join(desktop, 'grok'),
    exports = join(root, 'exports'),
    id = randomUUID(),
    path = join(home, 'sessions', 'encoded-project', id);
  await mkdir(path, { recursive: true });
  await mkdir(exports);
  await writeFile(join(path, 'summary.json'), JSON.stringify({ id }));
  await writeFile(join(path, 'messages.json'), 'original history');
  await writeFile(join(home, 'auth.json'), 'private account fixture');
  const old = new Date(Date.now() - 40 * 86400000);
  for (const name of ['summary.json', 'messages.json']) await utimes(join(path, name), old, old);
  const threads = [{ id: 't', sessionId: id, archived: true, status: 'idle' } as Thread];
  return {
    storage: new ProfileStorage(desktop, home, () => threads),
    threads,
    path,
    id,
    root,
    desktop,
    home,
    exports,
  };
}
test('aggregate inventory counts nested profiles once; export/prune/restore preserves native content and credentials', async () => {
  const f = await fixture();
  const report = await f.storage.scan();
  assert.equal(report.files, 3);
  assert.equal(report.bytes, (await lstat(join(f.path, 'summary.json'))).size + 16 + 23);
  assert.equal(report.categories.nativeOther, 23);
  const review = await f.storage.preview([f.id], 30),
    result = await f.storage.exportPrune(review.revision, f.exports);
  assert.deepEqual(result.pruned, [f.id]);
  await assert.rejects(lstat(f.path));
  assert.equal(await readFile(join(f.home, 'auth.json'), 'utf8'), 'private account fixture');
  assert.deepEqual((await f.storage.restore(result.backup)).restored, [f.id]);
  assert.equal(await readFile(join(f.path, 'messages.json'), 'utf8'), 'original history');
  await assert.rejects(f.storage.restore(result.backup), /already exists/);
});
test('retention rejects active/unarchived owners, recent files, stale previews and exports inside profiles', async () => {
  const f = await fixture();
  f.threads[0].archived = false;
  await assert.rejects(f.storage.preview([f.id], 30), /exclusively/);
  f.threads[0].archived = true;
  f.threads[0].status = 'running';
  await assert.rejects(f.storage.preview([f.id], 30), /exclusively/);
  f.threads[0].status = 'idle';
  const review = await f.storage.preview([f.id], 30);
  await assert.rejects(f.storage.exportPrune(review.revision, f.desktop), /outside/);
  await writeFile(join(f.path, 'messages.json'), 'changed');
  await assert.rejects(f.storage.exportPrune(review.revision, f.exports), /newer|changed/);
  assert.equal(await readFile(join(f.path, 'messages.json'), 'utf8'), 'changed');
});
test('restore preflights hashes and paths before mutations; linked folders are never followed', async () => {
  const f = await fixture(),
    review = await f.storage.preview([f.id], 30),
    { backup } = await f.storage.exportPrune(review.revision, f.exports);
  const manifestPath = join(backup, 'workbench-export.json'),
    original = await readFile(manifestPath, 'utf8'),
    manifest = JSON.parse(original);
  manifest.sessions[0].files.push({ path: '../escape', sha256: 'a'.repeat(64) });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.storage.restore(backup), /path\/hash/);
  await assert.rejects(lstat(f.path));
  await writeFile(manifestPath, original);
  await writeFile(join(backup, f.id, 'messages.json'), 'tampered');
  await assert.rejects(f.storage.restore(backup), /verification/);
  await assert.rejects(lstat(f.path));
  await symlink(
    f.exports,
    join(f.home, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(f.storage.scan(), /linked/);
  for (const value of [255, 1.5, Infinity, '512']) assert.throws(() => profileBudget(value));
});
test(
  'Windows retention refuses a separately opened native writer lock',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = await fixture(),
      lock = join(f.path, 'summary.json.lock');
    await writeFile(lock, '');
    const old = new Date(Date.now() - 40 * 86400000);
    await utimes(lock, old, old);
    const review = await f.storage.preview([f.id], 30),
      held = await open(lock, 'r+');
    try {
      await assert.rejects(f.storage.exportPrune(review.revision, f.exports), /lock is in use/);
      assert.equal(await readFile(join(f.path, 'messages.json'), 'utf8'), 'original history');
    } finally {
      await held.close();
    }
    const result = await f.storage.exportPrune(review.revision, f.exports);
    await f.storage.restore(result.backup);
    assert.equal((await lstat(lock)).size, 0);
  },
);
test('local native retention evicts only selected v4 search-cache rows; unfamiliar formats preserve originals', async () => {
  const f = await fixture(),
    path = join(f.home, 'sessions', 'session_search.sqlite'),
    cache = new DatabaseSync(path);
  cache.exec(
    "CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('session_search_schema_version','4'); CREATE TABLE session_docs(session_id TEXT,content TEXT); CREATE VIRTUAL TABLE session_docs_fts USING fts5(content); CREATE TRIGGER remove_doc AFTER DELETE ON session_docs BEGIN DELETE FROM session_docs_fts WHERE rowid=old.rowid; END;",
  );
  cache.prepare('INSERT INTO session_docs VALUES(?,?)').run(f.id, 'selected');
  cache.prepare('INSERT INTO session_docs VALUES(?,?)').run('unrelated', 'preserved');
  cache.exec(
    "INSERT INTO session_docs_fts VALUES('selected'); INSERT INTO session_docs_fts VALUES('preserved');",
  );
  cache.close();
  const review = await f.storage.preview([f.id], 30),
    backup = await f.storage.exportPrune(review.revision, f.exports);
  const check = new DatabaseSync(path);
  assert.deepEqual(
    check
      .prepare('SELECT content FROM session_docs')
      .all()
      .map((r) => r.content),
    ['preserved'],
  );
  assert.deepEqual(
    check
      .prepare('SELECT content FROM session_docs_fts')
      .all()
      .map((r) => r.content),
    ['preserved'],
  );
  check.exec("UPDATE meta SET value='5'");
  check.close();
  await f.storage.restore(backup.backup);
  const old = new Date(Date.now() - 40 * 86400000);
  for (const name of ['summary.json', 'messages.json']) await utimes(join(f.path, name), old, old);
  const second = await f.storage.preview([f.id], 30);
  await assert.rejects(f.storage.exportPrune(second.revision, f.exports), /format is unsupported/);
  assert.equal(await readFile(join(f.path, 'messages.json'), 'utf8'), 'original history');
});
