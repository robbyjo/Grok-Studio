import { test, expect, _electron as electron } from '@playwright/test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  utimes,
  open,
  unlink,
  access,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
test('aggregate quota blocks native work; reviewed retention cancels, exports/prunes, restores and refuses overwrite', async () => {
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/storage-ui-')),
    desktop = join(root, 'desktop'),
    home = join(desktop, 'grok'),
    sid = randomUUID(),
    session = join(home, 'sessions', 'fixture-project', sid),
    exports = join(root, 'exports');
  await mkdir(session, { recursive: true });
  await mkdir(exports);
  await writeFile(join(session, 'summary.json'), JSON.stringify({ id: sid }));
  await writeFile(join(session, 'chat_history.jsonl'), 'RETENTION_GUI_NATIVE_FIXTURE');
  const old = new Date(Date.now() - 40 * 86400000);
  for (const file of ['summary.json', 'chat_history.jsonl'])
    await utimes(join(session, file), old, old);
  const now = new Date().toISOString();
  await writeFile(
    join(desktop, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Storage acceptance', path: root }],
      settings: { executable: 'embedded' },
      threads: [
        {
          id: 'old',
          projectId: 'p',
          cwd: root,
          title: 'Archived native fixture',
          sessionId: sid,
          archived: true,
          status: 'idle',
          pinned: false,
          entries: [],
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'active',
          projectId: 'p',
          cwd: root,
          title: 'Quota acceptance',
          archived: false,
          status: 'idle',
          pinned: false,
          entries: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  const app = await electron.launch({
    ...(process.env.GROK_DESKTOP_TEST_EXE
      ? { executablePath: process.env.GROK_DESKTOP_TEST_EXE }
      : {}),
    args: process.env.GROK_DESKTOP_TEST_EXE ? [] : ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_DESKTOP_DATA_DIR: desktop,
      GROK_HOME: home,
      XAI_API_KEY: '',
      GROK_CODE_XAI_API_KEY: '',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Settings', exact: true });
    await modal.getByLabel('Aggregate desktop and Grok profile budget (MiB)').fill('256');
    await modal.getByRole('button', { name: 'Save desktop preferences', exact: true }).click();
    await expect(modal.getByText('Desktop preferences saved.', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      await window.desktop.call('agent:disconnect', { id: 'active' });
      await window.desktop.call('agent:disconnect', { id: 'old' });
    });
    const canary = join(home, 'quota-canary.bin'),
      file = await open(canary, 'w');
    await file.truncate(238 * 1024 * 1024);
    await file.close();
    await modal
      .getByRole('button', { name: 'Inspect aggregate profile storage', exact: true })
      .click();
    await expect(modal.locator('pre').filter({ hasText: 'nativeSessions' })).toBeVisible();
    const before = (await page.evaluate(() => window.desktop.call('diagnostics:info'))).agents
      .connections;
    expect(before).toBe(0);
    const nativeInventoryError = await page.evaluate(() =>
      window.desktop.call('mcp:list', { id: 'active' }).then(
        () => '',
        (e) => String(e),
      ),
    );
    expect(nativeInventoryError).toContain('aggregate profile is near its quota');
    const error = await page.evaluate(() =>
      window.desktop.call('agent:connect', { id: 'active' }).then(
        () => '',
        (e) => String(e),
      ),
    );
    expect(error).toContain('aggregate profile is near its quota');
    expect(
      (await page.evaluate(() => window.desktop.call('diagnostics:info'))).agents.connections,
    ).toBe(before);
    await unlink(canary);
    await modal
      .getByRole('checkbox', { name: `Archived native fixture · ${sid}`, exact: true })
      .check();
    await modal.getByRole('button', { name: 'Review native retention', exact: true }).click();
    const prune = modal.getByRole('button', {
      name: 'Export and prune reviewed native sessions',
      exact: true,
    });
    await expect(prune).toBeVisible();
    let accepted = false;
    page.on('dialog', (dialog) => void (accepted ? dialog.accept() : dialog.dismiss()));
    await prune.click();
    await access(join(session, 'chat_history.jsonl'));
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, exports);
    accepted = true;
    await prune.click();
    await expect(modal.getByRole('status').filter({ hasText: 'pruned' })).toBeVisible({
      timeout: 30000,
    });
    expect(
      await access(session).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const backup = join(exports, (await readdir(exports))[0]);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, backup);
    await modal
      .getByRole('button', { name: 'Restore verified native session export', exact: true })
      .click();
    await expect(modal.getByRole('status').filter({ hasText: 'restored' })).toBeVisible();
    expect(await readFile(join(session, 'chat_history.jsonl'), 'utf8')).toBe(
      'RETENTION_GUI_NATIVE_FIXTURE',
    );
    await modal
      .getByRole('button', { name: 'Restore verified native session export', exact: true })
      .click();
    await expect(modal.getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();
    await modal
      .getByRole('button', { name: 'Inspect installed version and rollback', exact: true })
      .click();
    await expect(
      modal.locator('pre').filter({ hasText: 'verified local profile backup' }),
    ).toBeVisible();
    await page.screenshot({ path: join(root, 'storage.png') });
  } finally {
    await app.close();
  }
});
