import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/crash-'));
  const now = new Date().toISOString();
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Crash acceptance', path: root }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          cwd: root,
          title: 'Crash recovery',
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
    await page.locator('.composer textarea').fill('CRASH_RECOVERY_UNSENT');
    await page.waitForTimeout(900);
    await app.evaluate(async ({ BrowserWindow, dialog }) => {
      const win = BrowserWindow.getAllWindows()[0];
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      const loaded = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Renderer reload timed out')), 15000);
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      win.webContents.forcefullyCrashRenderer();
      await loaded;
    });
    // Use the main process to observe the newly created renderer context after the intentional crash.
    let draft = '';
    for (let i = 0; i < 50; i++) {
      draft = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          'document.querySelector(".composer textarea")?.value ?? ""',
        ),
      );
      if (draft === 'CRASH_RECOVERY_UNSENT') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(draft, 'CRASH_RECOVERY_UNSENT');
    const result = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        'window.desktop.call("diagnostics:info")',
      ),
    );
    assert.ok(result.events.some((e: any) => e.event === 'renderer-crash'));
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        { root, rendererCrashRecovered: true, draftRecovered: true, diagnosticRecorded: true },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        root,
        rendererCrashRecovered: true,
        draftRecovered: true,
        diagnosticRecorded: true,
      }),
    );
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
