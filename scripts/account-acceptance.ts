import { _electron as electron, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to verify the existing real OAuth profile.');
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/live-account-'));
  const home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok');
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [],
      threads: [],
      settings: { executable: 'embedded', authMode: 'oauth' },
    }),
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
        GROK_HOME: home,
        XAI_API_KEY: '',
        GROK_CODE_XAI_API_KEY: '',
      },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Account / sign in', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Account', exact: true });
    await modal.getByRole('button', { name: 'Sign in with Grok (OAuth)', exact: true }).click();
    await expect(modal).toBeHidden({
      timeout: 180000,
    });
    await expect(
      page.getByRole('button', { name: 'Account / sign in', exact: true }),
    ).toContainText('Saved OAuth sign-in');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: 'Sign in with Grok (OAuth)', exact: true }).click();
    await expect(settings).toBeHidden({ timeout: 180000 });
    let state = await page.evaluate(() => window.desktop.call('state'));
    if (state.projects.length || state.threads.length)
      throw new Error('Account sign-in created project/chat state.');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page.getByRole('button', { name: 'Account / sign in', exact: true }),
    ).toContainText('Saved OAuth sign-in', { timeout: 60000 });
    state = await page.evaluate(() => window.desktop.call('state'));
    if (state.projects.length || state.threads.length)
      throw new Error('Account inspection created project/chat state.');
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        {
          oauthSignInWithoutProject: true,
          accountDialogClosedOnSuccess: true,
          settingsDialogClosedOnSuccess: true,
          savedOAuthAfterRestart: true,
          projects: 0,
          chats: 0,
        },
        null,
        2,
      ),
    );
    console.log('ACCOUNT_REPORT', root);
  } finally {
    await app.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
