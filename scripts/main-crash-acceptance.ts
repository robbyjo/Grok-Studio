import { _electron as electron, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Store } from '../electron/store';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
async function main() {
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/main-crash-')),
    seed = new Store(join(root, 'state.json')),
    project = seed.openProject(root, 'Abrupt main-process recovery'),
    thread = seed.create(project.id, root);
  thread.status = 'running';
  thread.queue = [
    { id: 'queued', text: 'Never automatically restart this prompt', state: 'queued' },
  ];
  seed.flush();
  seed.history.db.close();
  const launch = () =>
    electron.launch({
      args: ['.'],
      cwd: resolve('.'),
      env: {
        ...process.env,
        GROK_DESKTOP_DATA_DIR: root,
        GROK_HOME: join(root, 'grok'),
        XAI_API_KEY: '',
        GROK_DEPLOYMENT_KEY: '',
      },
    });
  let app = await launch(),
    killed = false;
  try {
    let page = await app.firstWindow();
    await expect(page.locator('.composer textarea')).toBeVisible();
    await page.locator('.composer textarea').fill('DURABLE_MAIN_CRASH_DRAFT');
    await expect
      .poll(() =>
        page.evaluate(() => window.desktop.call('drafts:get')).then((r) => JSON.stringify(r)),
      )
      .toContain('DURABLE_MAIN_CRASH_DRAFT');
    const ownedPid = app.process().pid!;
    assert.ok(ownedPid > 0);
    // Kill only the Electron process tree returned by this acceptance launch.
    if (process.platform === 'win32')
      execFileSync('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'], { windowsHide: true });
    else app.process().kill('SIGKILL');
    killed = true;
    await new Promise((done) => setTimeout(done, 1000));
    app = await launch();
    killed = false;
    page = await app.firstWindow();
    await expect(page.locator('.composer textarea')).toHaveValue('DURABLE_MAIN_CRASH_DRAFT', {
      timeout: 20000,
    });
    const state = await page.evaluate(() => window.desktop.call('state')),
      recovered = state.threads.find((t: any) => t.id === thread.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.queue[0].state, 'paused');
    assert.equal(
      (await page.evaluate(() => window.desktop.call('diagnostics:info'))).agents.connections,
      0,
    );
    await page.evaluate(() => window.desktop.call('drafts:save', { value: {} }));
    await app.close();
    killed = true;
    // Terminate a real SQLite writer inside an uncommitted transaction; committed baseline must survive.
    const dbPath = join(root, 'transaction-probe.sqlite'),
      db = new DatabaseSync(dbPath);
    db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE canary(value TEXT); INSERT INTO canary VALUES('committed');",
    );
    db.close();
    const childPath = join(root, 'transaction-child.cjs');
    writeFileSync(
      childPath,
      "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[2]); db.exec(\"BEGIN IMMEDIATE; INSERT INTO canary VALUES('uncommitted');\"); console.log('TRANSACTION_OPEN'); setInterval(()=>{},1000);",
    );
    const child = spawn(process.execPath, [childPath, dbPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Writer did not enter transaction'));
      }, 10000);
      child.once('error', reject);
      child.stdout.on('data', (data) => {
        if (String(data).includes('TRANSACTION_OPEN')) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGKILL');
    await exited;
    const reopened = new DatabaseSync(dbPath);
    assert.deepEqual(
      reopened
        .prepare('SELECT value FROM canary')
        .all()
        .map((r) => r.value),
      ['committed'],
    );
    assert.equal(reopened.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    reopened.close();
    const report = {
      root,
      testedAt: new Date().toISOString(),
      mainProcessKilled: true,
      durableDraftRestored: true,
      interruptedTurnRecovered: true,
      queuePaused: true,
      noAutomaticAgentRestart: true,
      interruptedSqliteTransactionRolledBack: true,
      scope: 'Abrupt process termination; not a physical power-loss/reboot test.',
    };
    writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (!killed) await app.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
