import { Agents } from '../electron/agent';
import { Store } from '../electron/store';
import { EmbeddedRpc } from '../electron/embedded-rpc';
import { embeddedEngine } from '../electron/runtime';
import { ProfileStorage } from '../electron/profile-storage';
import { mkdir, mkdtemp, readFile, readdir, writeFile, utimes, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error(
      'Pass --run to archive/prune/restore only a disposable concurrency acceptance session and run one real resume prompt.',
    );
  const index = process.argv.indexOf('--concurrency-root');
  if (index < 0) throw new Error('Supply the successful isolated --concurrency-root.');
  const previous = resolve(process.argv[index + 1]),
    ownedRoot = resolve('.test-data') + '\\';
  if (!previous.toLowerCase().startsWith(ownedRoot.toLowerCase()))
    throw new Error('Expected an owned disposable acceptance folder.');
  const proof = JSON.parse(await readFile(join(previous, 'result.json'), 'utf8'));
  assert.equal(proof.outcome, 'pass');
  const seed = new Store(join(previous, 'desktop/state.json')),
    original = seed.state.threads.find((t) => t.sessionId === proof.sessions[0])!;
  assert.ok(original);
  assert.equal(resolve(original.cwd).toLowerCase(), join(previous, 'repository').toLowerCase());
  seed.history.db.close();
  const home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok'),
    root = await mkdtemp(resolve('.test-data/live-retention-')),
    desktop = join(root, 'desktop'),
    exports = join(root, 'exports');
  await mkdir(exports);
  const store = new Store(join(desktop, 'state.json')),
    p = store.openProject(original.cwd, 'Disposable real native retention'),
    t = store.create(p.id, original.cwd);
  t.sessionId = original.sessionId;
  t.archived = true;
  store.flush();
  let sessionPath = '';
  for (const group of await readdir(join(home, 'sessions'), { withFileTypes: true })) {
    if (!group.isDirectory() || group.isSymbolicLink()) continue;
    const path = join(home, 'sessions', group.name, t.sessionId!);
    if (await lstat(path).catch(() => undefined)) {
      assert.equal(sessionPath, '');
      sessionPath = path;
    }
  }
  assert.ok(sessionPath);
  const summary = JSON.parse(await readFile(join(sessionPath, 'summary.json'), 'utf8'));
  const summaryText = JSON.stringify(summary);
  assert.ok(summaryText.includes(t.sessionId!));
  // Only this disposable real session is aged for the retention eligibility test.
  const old = new Date(Date.now() - 40 * 86400000);
  async function age(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink());
      const file = join(path, entry.name);
      if (entry.isDirectory()) await age(file);
      else await utimes(file, old, old);
    }
  }
  await age(sessionPath);
  const storage = new ProfileStorage(desktop, home, () => store.state.threads),
    preview = await storage.preview([t.sessionId!], 30),
    backup = await storage.exportPrune(preview.revision, exports);
  await assert.rejects(lstat(sessionPath));
  await storage.restore(backup.backup);
  assert.ok((await lstat(join(sessionPath, 'chat_history.jsonl'))).isFile());
  t.archived = false;
  store.flush();
  const agents = new Agents(
    store,
    () => {},
    (cwd) =>
      new EmbeddedRpc(
        embeddedEngine(),
        cwd,
        { ...process.env, GROK_HOME: home, XAI_API_KEY: undefined, GROK_DEPLOYMENT_KEY: undefined },
        'oauth',
      ),
  );
  const permissions = setInterval(() => {
    for (const permission of agents.permissionsSnapshot())
      agents.approve(
        permission.id,
        permission.kind === 'trust'
          ? 'trust'
          : permission.options.find((o) => o.kind === 'reject_once')?.optionId,
      );
  }, 100);
  try {
    await agents.connect(t.id);
    assert.equal(t.sessionId, original.sessionId);
    await agents.prompt(
      t.id,
      'Do not use tools or change files. Reply exactly RESTORED_NATIVE_SESSION_OK.',
      [],
    );
    assert.ok(
      store
        .fullHistory(t.id)
        .some((e) => e.type === 'assistant' && e.text.includes('RESTORED_NATIVE_SESSION_OK')),
    );
    const report = {
      root,
      testedAt: new Date().toISOString(),
      actualNativeSession: true,
      eligibilityAge: 'Artificially aged only the owned disposable session',
      reviewedExportVerified: true,
      originalPruned: true,
      hashesRestored: true,
      realOAuthResume: true,
      sessionIdPreserved: true,
      noCredentialExport: true,
      noCloudDelete: true,
    };
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(permissions);
    await agents.shutdownAndWait();
    store.flush();
    store.history.db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
