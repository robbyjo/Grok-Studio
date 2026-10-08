import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsSandbox, sandboxConfiguration } from '../electron/windows-sandbox';
test('Sandbox configuration explicitly controls network and redirects only the isolated copy', () => {
  const config = sandboxConfiguration('C:\\payload & test', 'C:\\copy', false);
  assert.ok(config.includes('<Networking>Disable</Networking>'));
  assert.ok(config.includes('<ClipboardRedirection>Disable</ClipboardRedirection>'));
  assert.ok(config.includes('<ProtectedClient>Enable</ProtectedClient>'));
  assert.ok(config.includes('payload &amp; test'));
  assert.equal((config.match(/<HostFolder>/g) ?? []).length, 2);
  assert.ok(config.includes('<ReadOnly>true</ReadOnly>'));
  assert.ok(
    sandboxConfiguration('C:\\payload', 'C:\\copy', true).includes(
      '<Networking>Enable</Networking>',
    ),
  );
});
test('Sandbox preparation binds the reviewed executable and excludes host credentials without copying the original profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench-sandbox-')),
    project = join(root, 'project'),
    exe = join(root, 'Workbench.exe'),
    output = join(root, 'exports');
  await mkdir(project);
  await mkdir(join(project, '.grok'));
  await writeFile(exe, 'portable fixture');
  await writeFile(join(project, 'file.ts'), 'const x=1');
  await writeFile(join(project, '.grok', 'auth.json'), 'secret');
  await writeFile(join(project, '.env'), 'secret');
  const api = new WindowsSandbox(output, () => exe);
  const review = await api.preview(project, false);
  assert.equal(review.files, 1);
  assert.equal(review.skipped, 2);
  const prepared = await api.prepare(review.token);
  assert.deepEqual(await readdir(prepared.recovery), ['file.ts']);
  assert.equal(await readFile(join(prepared.recovery, 'file.ts'), 'utf8'), 'const x=1');
  assert.ok(
    !(await readFile(prepared.config, 'utf8')).includes(`<HostFolder>${project}</HostFolder>`),
  );
  await assert.rejects(api.prepare(review.token), /Review/);
  const stale = await api.preview(project, true);
  await writeFile(exe, 'tampered');
  await assert.rejects(api.prepare(stale.token), /Executable changed/);
  assert.equal(await readFile(join(project, '.env'), 'utf8'), 'secret');
});
