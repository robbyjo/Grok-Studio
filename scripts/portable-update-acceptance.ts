import { chromium, expect, type Browser } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileHash, verifyPortableArtifact } from '../electron/portable-update';
import assert from 'node:assert/strict';
import { version } from '../package.json';

async function main() {
  const option = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  if (
    !process.argv.includes('--run') ||
    !process.argv.includes('--current') ||
    !process.argv.includes('--replacement')
  )
    throw new Error(
      'Usage: tsx scripts/portable-update-acceptance.ts --run --current EXE --replacement EXE. Uses isolated profiles and a seeded download-review fixture; no release is published.',
    );
  const current = resolve(option('--current')),
    replacement = resolve(option('--replacement'));
  for (const file of [current, replacement]) await verifyPortableArtifact(file, { version });
  const beforeHash = await fileHash(current),
    nextHash = await fileHash(replacement);
  assert.notEqual(beforeHash, nextHash, 'Use two distinct unreleased test builds.');
  const root = await mkdtemp(resolve('.test-data/portable-replacement-')),
    executable = join(root, 'Workbench-Test.exe'),
    data = join(root, 'Grok Desktop Data'),
    updates = join(data, 'updates'),
    extraction = join(root, 'extraction');
  await mkdir(updates, { recursive: true });
  await mkdir(extraction);
  await copyFile(current, executable);
  const now = new Date().toISOString();
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Disposable portable replacement', path: root }],
      settings: { executable: 'embedded', authMode: 'oauth' },
      threads: [
        {
          id: 't',
          projectId: 'p',
          cwd: root,
          title: 'Before replacement',
          status: 'idle',
          archived: false,
          pinned: false,
          entries: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  const staged = join(updates, `staged-${randomUUID()}.exe`);
  await copyFile(replacement, staged);
  // Release/download gates have separate regressions. Both builds keep the current version.
  await writeFile(
    join(updates, 'journal.json'),
    JSON.stringify({
      format: 1,
      state: 'staged',
      staged,
      version,
      sha256: nextHash,
      allowUnsigned: true,
      operation: 'apply',
      sourceVersion: version,
    }),
  );
  let child: ChildProcess | undefined, browser: Browser | undefined;
  const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const ps = (script: string) =>
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64'),
      ],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const stopOwned = () => {
    const ids: number[] = JSON.parse(
      ps(
        `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith(${quote(root + '\\')},[StringComparison]::OrdinalIgnoreCase)}|Select-Object -ExpandProperty ProcessId)`,
      ),
    );
    for (const pid of ids) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {}
    }
  };
  const launch = async () => {
    const port = 35000 + Math.floor(Math.random() * 15000);
    child = spawn(executable, [`--remote-debugging-port=${port}`], {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        TEMP: extraction,
        TMP: extraction,
        GROK_HOME: '',
        GROK_DESKTOP_DATA_DIR: '',
        XAI_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '',
        GROK_DEPLOYMENT_KEY: '',
      },
    });
    for (let n = 0; n < 120; n++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
          break;
        }
      } catch {}
      await delay(500);
    }
    assert.ok(browser, 'Owned portable did not start.');
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => Boolean(window.desktop));
    return page;
  };
  const waitJournal = async (state: string, hash: string) => {
    for (let n = 0; n < 180; n++) {
      const journal = JSON.parse(await readFile(join(updates, 'journal.json'), 'utf8'));
      if (journal.state === 'repairRequired')
        throw new Error(journal.error ?? 'Worker needs repair.');
      if (journal.state === state && (await fileHash(executable)) === hash) {
        // Verify default post-replacement restart, without connecting to private app state.
        for (let m = 0; m < 80; m++) {
          if (
            ps(
              `@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -ieq ${quote(executable)}}).Count`,
            ).trim() !== '0'
          )
            return journal;
          await delay(500);
        }
        throw new Error('Worker did not restart the replaced portable.');
      }
      await delay(500);
    }
    throw new Error('Portable worker did not complete.');
  };
  try {
    let page = await launch();
    const info = await page.evaluate(() => window.desktop.call('runtime:info'));
    assert.equal(info.dataDirectory.toLowerCase(), data.toLowerCase());
    await page.evaluate(() =>
      window.desktop.call('thread:edit', { id: 't', title: 'Portable update profile preserved' }),
    );
    await expect(page.locator('.composer textarea')).toBeVisible();
    await page.waitForFunction(() =>
      document.body.innerText.includes('Portable update profile preserved'),
    );
    await page.locator('.composer textarea').fill('UPDATE_PROFILE_CANARY');
    await expect
      .poll(() => page.evaluate(() => window.desktop.call('drafts:get')).then((r) => r.composer?.t))
      .toBe('UPDATE_PROFILE_CANARY');
    const call = page.evaluate(() => window.desktop.call('updates:apply', { confirmed: true }));
    await call;
    await waitJournal('installed', nextHash);
    await browser?.close();
    browser = undefined;
    stopOwned();
    page = await launch();
    assert.equal(
      (await page.evaluate(() => window.desktop.call('state'))).threads[0].title,
      'Portable update profile preserved',
    );
    await expect(page.locator('.composer textarea')).toHaveValue('UPDATE_PROFILE_CANARY');
    assert.equal(
      (await page.evaluate(() => window.desktop.call('drafts:get'))).composer.t,
      'UPDATE_PROFILE_CANARY',
    );
    assert.equal(
      (await page.evaluate(() => window.desktop.call('updates:status'))).journal.state,
      'installed',
    );
    await page.evaluate(() => window.desktop.call('updates:rollback', { confirmed: true }));
    await waitJournal('rolledBack', beforeHash);
    await browser?.close();
    browser = undefined;
    stopOwned();
    page = await launch();
    assert.equal(
      (await page.evaluate(() => window.desktop.call('state'))).threads[0].title,
      'Portable update profile preserved',
    );
    await expect(page.locator('.composer textarea')).toHaveValue('UPDATE_PROFILE_CANARY');
    assert.equal(
      (await page.evaluate(() => window.desktop.call('drafts:get'))).composer.t,
      'UPDATE_PROFILE_CANARY',
    );
    assert.equal(
      (await page.evaluate(() => window.desktop.call('updates:status'))).journal.state,
      'rolledBack',
    );
    await page.evaluate(() => window.desktop.call('updates:discard', { confirmed: true }));
    await page.close();
    await browser!.close();
    browser = undefined;
    const result = {
      root,
      testedAt: new Date().toISOString(),
      beforeHash,
      nextHash,
      outcome: 'pass',
      realPortableExitReplacementRestartRollback: true,
      profilePreserved: true,
      retainedFilesDiscarded: true,
      downloadReviewFixtureSeeded: true,
      scope:
        'Two distinct unsigned packages of the current version; release download gates tested separately, no published newer-version/signed-update claim.',
    };
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    stopOwned();
    child?.kill();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
