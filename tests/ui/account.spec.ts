import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

test('account sign-in is above Settings without a project; remembered API key survives restart', async () => {
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/account-ui-'));
  const key = 'xai-fixture-account-persistence-not-a-real-key';
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({ version: 1, projects: [], threads: [], settings: { executable: 'embedded' } }),
  );
  const launch = () =>
    electron.launch({
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
        GROK_CODE_XAI_API_KEY: '',
        GROK_DEPLOYMENT_KEY: '',
      },
    });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    const account = page.getByRole('button', { name: 'Account / sign in', exact: true });
    await expect(account).toBeVisible();
    const accountBounds = await account.boundingBox(),
      settingsBounds = await page
        .getByRole('button', { name: 'Settings', exact: true })
        .boundingBox();
    expect(accountBounds!.y + accountBounds!.height).toBeLessThanOrEqual(settingsBounds!.y + 1);
    await account.click();
    let modal = page.getByRole('dialog', { name: 'Account', exact: true });
    await expect(
      modal.getByRole('button', { name: 'Sign in with Grok (OAuth)', exact: true }),
    ).toBeVisible();
    await expect(modal.getByLabel('Remember with Windows encrypted storage')).toBeChecked();
    await modal.getByLabel('xAI API key', { exact: true }).fill(key);
    await modal.getByRole('button', { name: 'Save API key', exact: true }).click();
    await expect(
      modal.getByRole('status').filter({ hasText: 'API key: encrypted on disk' }),
    ).toBeVisible();
    expect(readFileSync(join(root, 'xai-api-key.bin')).includes(Buffer.from(key))).toBe(false);
    const state = await page.evaluate(() => window.desktop.call('state'));
    expect(state.projects).toHaveLength(0);
    expect(state.threads).toHaveLength(0);
    expect(JSON.stringify(state)).not.toContain(key);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: 'Account / sign in', exact: true }).click();
    modal = page.getByRole('dialog', { name: 'Account', exact: true });
    await expect(
      modal.getByRole('status').filter({ hasText: 'API key: encrypted on disk' }),
    ).toBeVisible();
    expect(
      await app.evaluate(
        ({ safeStorage }, { bytes, key }) => safeStorage.decryptString(Buffer.from(bytes)) === key,
        { bytes: [...readFileSync(join(root, 'xai-api-key.bin'))], key },
      ),
    ).toBe(true);
    await page.screenshot({ path: join(root, 'account.png') });
    await modal.getByRole('button', { name: 'Close account' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Settings', exact: true })
        .getByRole('button', { name: 'Sign in with Grok (OAuth)', exact: true }),
    ).toBeVisible();
  } finally {
    await app?.close();
  }
});
