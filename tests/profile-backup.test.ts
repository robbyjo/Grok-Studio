import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupProfile, verifyProfileBackup } from '../electron/profile-backup';
import { compatibility, supportedNativeRevision } from '../electron/portable-update';
test('migration backup preserves durable files and consistent SQLite WAL contents, excludes browser caches, detects tampering', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'workbench-backup-')),
    home = join(profile, 'grok'),
    updates = join(profile, 'updates');
  await mkdir(home);
  await mkdir(join(profile, 'GPUCache'));
  await writeFile(join(profile, 'GPUCache', 'ignored'), 'cache');
  await writeFile(join(profile, 'state.json'), 'private state');
  await writeFile(join(home, 'auth.json'), 'FAKE_AUTH_FIXTURE_ONLY');
  const db = new DatabaseSync(join(profile, 'history.sqlite'));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE test(value TEXT); INSERT INTO test VALUES ('committed WAL value')",
  );
  try {
    const result = await backupProfile(profile, home, updates, { sourceVersion: '0.8.0' }),
      manifest = await verifyProfileBackup(result.folder, result.manifestHash);
    assert.ok(!manifest.files.some((row: any) => row.path.includes('GPUCache')));
    assert.ok(!manifest.files.some((row: any) => row.path.endsWith('-wal')));
    const copy = new DatabaseSync(join(result.folder, 'profile', 'history.sqlite'));
    assert.equal(
      (copy.prepare('SELECT value FROM test').get() as any).value,
      'committed WAL value',
    );
    copy.close();
    assert.equal(
      await readFile(join(result.folder, 'profile', 'grok', 'auth.json'), 'utf8'),
      'FAKE_AUTH_FIXTURE_ONLY',
    );
    await writeFile(join(result.folder, 'profile', 'state.json'), 'tampered');
    await assert.rejects(verifyProfileBackup(result.folder, result.manifestHash), /verification/);
    assert.equal(await readFile(join(profile, 'state.json'), 'utf8'), 'private state');
  } finally {
    db.close();
  }
});
test('migration backup rejects external native homes and hard-linked credentials without touching originals', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'workbench-backup-')),
    home = join(profile, 'grok');
  await mkdir(home);
  const external = await mkdtemp(join(tmpdir(), 'workbench-external-'));
  await assert.rejects(
    backupProfile(profile, external, join(profile, 'updates'), {}),
    /private Grok home/,
  );
  await writeFile(join(home, 'auth.json'), 'fake');
  await link(join(home, 'auth.json'), join(profile, 'xai-api-key.bin'));
  await assert.rejects(backupProfile(profile, home, join(profile, 'updates'), {}), /unsupported/);
  assert.equal(await readFile(join(home, 'auth.json'), 'utf8'), 'fake');
});
test('engine migration permits only the explicit pinned native-format contract, rejects ABI/schema/unknown engine formats', () => {
  const manifest = {
    format: 2,
    product: 'Grok Workbench',
    version: '0.9.0',
    platform: 'win32-x64',
    stateSchema: 1,
    historySchema: 1,
    bindingVersion: '0.6.0',
    engineSha256: 'b'.repeat(64),
    sha256: 'c'.repeat(64),
    bytes: 42,
    migration: 'same-native-format-v1',
    nativeRevision: supportedNativeRevision,
    nativeStorageContract: 'pinned-grok-2bdd1d6a-v1',
  };
  assert.equal(compatibility(manifest, '0.9.0', 'a'.repeat(64)), manifest);
  for (const invalid of [
    { format: 1 },
    { bindingVersion: '0.7.0' },
    { stateSchema: 2 },
    { historySchema: 2 },
    { nativeStorageContract: 'unknown' },
    { nativeRevision: 'd'.repeat(40) },
    { migration: 'run-remote-script' },
  ])
    assert.throws(
      () => compatibility({ ...manifest, ...invalid }, '0.9.0', 'a'.repeat(64)),
      /version gates/,
    );
});
