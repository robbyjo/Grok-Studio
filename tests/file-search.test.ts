import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFiles } from '../electron/file-search';
test('literal project search pages Unicode matches and excludes metadata, secrets, binary and hard links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-search-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'node_modules'));
  for (const file of ['.git/config', 'node_modules/cache', '.env', 'auth.json'])
    await writeFile(join(root, file), 'NEEDLE');
  await writeFile(join(root, 'binary.bin'), Buffer.from('NEEDLE\0'));
  await writeFile(
    join(root, 'source.ts'),
    Array.from({ length: 105 }, () => '你好 NEEDLE <script>').join('\r\n'),
  );
  const first = await searchFiles(root, 'NEEDLE', true);
  assert.equal(first.hits.length, 100);
  assert.equal(first.next, 100);
  assert.equal(first.hits[0].column, 4);
  assert.equal(first.hits[0].line, 1);
  const second = await searchFiles(root, 'NEEDLE', true, 100);
  assert.equal(second.hits.length, 5);
  assert.equal(second.hits[0].line, 101);
  assert.equal(second.next, null);
  await writeFile(join(root, 'original.txt'), 'PRIVATE NEEDLE');
  await link(join(root, 'original.txt'), join(root, 'alias.txt'));
  assert.ok((await searchFiles(root, 'PRIVATE', true)).hits.length === 0);
  assert.deepEqual(
    (await searchFiles(root, 'source', false)).hits.map((h) => h.path),
    ['source.ts'],
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchFiles(root, 'x', true, 0, controller.signal));
  await assert.rejects(searchFiles(root, 'x', true, 1001));
});
