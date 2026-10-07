import { test, expect, _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

test('paged history, preferences/focus, terminal tabs and interface reload recover drafts and scrollback', async () => {
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/scale-ui-'));
  const now = new Date().toISOString();
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Scale fixture', path: root }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          cwd: root,
          title: 'Scale chat',
          status: 'idle',
          archived: false,
          pinned: false,
          createdAt: now,
          updatedAt: now,
          entries: Array.from({ length: 250 }, (_, n) => ({
            id: `entry-${n}`,
            type: 'assistant',
            text: `Saved message ${n}`,
          })),
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
      GROK_DESKTOP_DATA_DIR: root,
      GROK_HOME: join(root, 'grok'),
      XAI_API_KEY: '',
      GROK_DEPLOYMENT_KEY: '',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-entry-id]')).toHaveCount(80);
    await page.getByRole('button', { name: 'Older messages', exact: true }).click();
    await expect(page.locator('[data-entry-id="entry-90"]')).toBeVisible();
    await page.getByRole('button', { name: 'Latest messages', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByLabel('Shortcut search', { exact: true }).fill('Ctrl+Shift+G');
    await settings.getByRole('button', { name: 'Save desktop preferences', exact: true }).click();
    await expect(settings.getByText('Desktop preferences saved.', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await expect(settings.locator('pre').filter({ hasText: 'rss' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+g');
    const search = page.getByRole('dialog', { name: 'Search chats', exact: true });
    await expect(search.getByLabel('Titles and full saved transcripts')).toBeFocused();
    await search.getByLabel('Titles and full saved transcripts').fill('Saved message 0');
    await expect(search.locator('.search-hit')).toHaveCount(1);
    await search.locator('.search-hit').click();
    await expect(page.locator('[data-entry-id="entry-0"]')).toBeFocused();
    await page.getByRole('button', { name: 'Toggle terminal', exact: true }).click();
    await expect(page.locator('.terminal-surface')).toBeVisible();
    await page.getByLabel('New terminal shell').selectOption('cmd');
    await page.getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    const tabs = await page.evaluate(() => window.desktop.call('terminal:list', { id: 't' }));
    const cmd = tabs.find((t: any) => t.shell === 'cmd');
    await page.evaluate(
      (terminalId) =>
        window.desktop.call('terminal:write', {
          id: 't',
          terminalId,
          data: 'echo PERSISTENT_TERMINAL_MARKER\r',
        }),
      cmd.id,
    );
    await expect
      .poll(() =>
        page
          .evaluate(
            (terminalId) => window.desktop.call('terminal:context', { id: 't', terminalId }),
            cmd.id,
          )
          .then((r) => r.text),
      )
      .toContain('PERSISTENT_TERMINAL_MARKER');
    await page.getByRole('button', { name: 'Review terminal context', exact: true }).click();
    await expect(page.getByLabel('Terminal context to include')).toContainText(
      'PERSISTENT_TERMINAL_MARKER',
    );
    await page.getByRole('button', { name: 'Add context to message', exact: true }).click();
    const composer = page.locator('.composer textarea').first();
    await expect(composer).toHaveValue(/PERSISTENT_TERMINAL_MARKER/);
    await composer.fill('RECOVER_UNSENT_DRAFT');
    await page.waitForTimeout(900);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].reload());
    await expect(composer).toHaveValue('RECOVER_UNSENT_DRAFT', { timeout: 20000 });
    const recovered = await page.evaluate(() =>
      window.desktop.call('terminal:context', { id: 't', terminalId: 't' }),
    );
    expect(recovered).toHaveProperty('text');
    const diagnostics = await page.evaluate(() => window.desktop.call('diagnostics:info'));
    expect(diagnostics.storage.entries).toBe(250);
    await page.evaluate(() => window.desktop.call('drafts:save', { value: {} }));
  } finally {
    await app.close();
  }
});
