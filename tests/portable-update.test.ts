import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  PortableUpdates,
  compatibility,
  compareVersions,
  fileHash,
  verifyPortableArtifact,
} from '../electron/portable-update';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const engine = 'e'.repeat(64);
async function fixture() {
  // Hosted Windows runners may expose TEMP through an 8.3 alias. The update
  // fixture must use a canonical launch path, just like the production gate.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grok-update-'))),
    folder = join(root, 'updates'),
    exe = join(root, 'Workbench.exe');
  await writeFile(exe, 'old executable');
  const bytes = Buffer.from('new executable'),
    manifest = Buffer.from(
      JSON.stringify({
        format: 1,
        product: 'Grok Workbench',
        version: '0.6.4',
        platform: 'win32-x64',
        stateSchema: 1,
        historySchema: 1,
        bindingVersion: '0.6.0',
        engineSha256: engine,
        sha256: sha(bytes),
        bytes: bytes.length,
      }),
    );
  const prefix = 'https://github.com/robbyjo/Grok-Workbench/releases/download/v0.6.4/',
    assets = [
      {
        id: 1,
        name: 'Grok-Workbench-0.6.4-Portable.exe',
        size: bytes.length,
        digest: 'sha256:' + sha(bytes),
        browser_download_url: prefix + 'Grok-Workbench-0.6.4-Portable.exe',
      },
      {
        id: 2,
        name: 'Grok-Workbench-0.6.4-Portable.exe.manifest.json',
        size: manifest.length,
        digest: 'sha256:' + sha(manifest),
        browser_download_url: prefix + 'Grok-Workbench-0.6.4-Portable.exe.manifest.json',
      },
    ],
    release = { id: 3, tag_name: 'v0.6.4', prerelease: true, draft: false, assets };
  const api = new PortableUpdates(
    folder,
    exe,
    '0.6.3',
    async () => engine,
    async (url) =>
      url.includes('/releases?')
        ? Buffer.from(JSON.stringify([release]))
        : url.endsWith('/releases/3')
          ? Buffer.from(JSON.stringify(release))
          : url.endsWith('.json')
            ? manifest
            : bytes,
    async () => ({ version: '0.6.4', signature: 'NotSigned' }),
  );
  return { api, root, folder, exe, release };
}
test('portable staging verifies release, engine/schema/ABI, asset digests and explicit alpha/unsigned choice', async () => {
  assert.ok(compareVersions('0.6.4', '0.6.3') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.9') > 0);
  assert.throws(() => compareVersions('latest', '0.6.3'));
  assert.throws(() => compatibility({ version: '0.6.4' }, '0.6.4', engine), /version gates/);
  const f = await fixture();
  assert.equal((await f.api.check(false)).available, false);
  const review = await f.api.check(true);
  await assert.rejects(f.api.stage(review.token, false), /unsigned/);
  const staged = await f.api.stage(review.token, true);
  assert.equal(staged.journal?.state, 'staged');
  assert.equal(await fileHash(staged.journal!.staged), sha('new executable'));
  assert.equal(await readFile(f.exe, 'utf8'), 'old executable');
  await assert.rejects(f.api.stage(review.token, true), /existing rollback/);
});
test(
  'Windows worker atomically installs, rolls back and recovers an interrupted journal; no profile files change',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'profile'));
    await writeFile(join(f.root, 'profile', 'canary'), 'preserve profile');
    const review = await f.api.check(true);
    await f.api.stage(review.token, true);
    const journal = await f.api.prepare('apply', true),
      prepared = JSON.parse(await readFile(journal, 'utf8'));
    prepared.ownerPid = 0;
    await writeFile(journal, JSON.stringify(prepared));
    const worker = resolve('scripts/portable-update-worker.ps1');
    const run = () =>
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', worker, '-Journal', journal, '-NoLaunch'],
        { windowsHide: true, encoding: 'utf8' },
      );
    run();
    assert.equal(await readFile(f.exe, 'utf8'), 'new executable');
    assert.equal(await readFile(prepared.rollback, 'utf8'), 'old executable');
    await assert.rejects(lstat(prepared.staged));
    const installed = JSON.parse(await readFile(journal, 'utf8'));
    installed.state = 'prepared';
    await writeFile(journal, JSON.stringify(installed));
    assert.equal((await f.api.status()).journal?.state, 'installed');
    await f.api.prepare('rollback', true);
    const rollback = JSON.parse(await readFile(journal, 'utf8'));
    rollback.ownerPid = 0;
    await writeFile(journal, JSON.stringify(rollback));
    run();
    assert.equal(await readFile(f.exe, 'utf8'), 'old executable');
    assert.equal(await readFile(rollback.displaced, 'utf8'), 'new executable');
    assert.equal((await f.api.status()).journal?.state, 'rolledBack');
    assert.equal(await readFile(join(f.root, 'profile', 'canary'), 'utf8'), 'preserve profile');
  },
);
test(
  'real published portable PE version is inspected and refuses a mismatched manifest',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const path = resolve('release/Grok-Workbench-0.6.3-Portable.exe');
    // This local published artifact need not exist on a fresh CI checkout.
    if (!(await lstat(path).catch(() => undefined))) {
      t.skip('Published portable artifact is absent on this checkout.');
      return;
    }
    assert.equal((await verifyPortableArtifact(path, { version: '0.6.3' })).version, '0.6.3');
    await assert.rejects(verifyPortableArtifact(path, { version: '0.6.4' }), /version\/product/);
  },
);
test('changed/stale release assets and tampered staged binaries are rejected before replacement', async () => {
  const f = await fixture(),
    review = await f.api.check(true);
  f.release.assets[0].digest = 'sha256:' + 'a'.repeat(64);
  await assert.rejects(f.api.stage(review.token, true), /does not match|changed/);
  assert.equal(await readFile(f.exe, 'utf8'), 'old executable');
  const g = await fixture(),
    selected = await g.api.check(true),
    staged = await g.api.stage(selected.token, true);
  await writeFile(staged.journal!.staged, 'tamper');
  await assert.rejects(g.api.prepare('apply', true), /verification/);
  assert.equal(await readFile(g.exe, 'utf8'), 'old executable');
});

test(
  'failed worker records repair state; explicit recovery refuses tampering and preserves rollback until discard',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = await fixture(),
      review = await f.api.check(true);
    await f.api.stage(review.token, true);
    const journal = await f.api.prepare('apply', true),
      prepared = JSON.parse(await readFile(journal, 'utf8'));
    prepared.ownerPid = 0;
    await writeFile(journal, JSON.stringify(prepared));
    await writeFile(prepared.staged, 'tampered');
    assert.throws(() =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          resolve('scripts/portable-update-worker.ps1'),
          '-Journal',
          journal,
          '-NoLaunch',
        ],
        { windowsHide: true, stdio: 'ignore' },
      ),
    );
    assert.equal((await f.api.status()).journal?.state, 'repairRequired');
    await assert.rejects(f.api.recover(true), /hashes/);
    assert.equal(await readFile(f.exe, 'utf8'), 'old executable');
    await writeFile(prepared.staged, 'new executable');
    assert.equal((await f.api.recover(true)).journal?.state, 'staged');
    await assert.rejects(f.api.stage(review.token, true), /existing rollback/);
    await f.api.discard(true);
    await assert.rejects(lstat(prepared.staged));
    assert.equal((await f.api.stage(review.token, true)).journal?.state, 'staged');
  },
);
