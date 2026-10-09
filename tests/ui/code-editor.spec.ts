import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
test('rich editor runs real local diagnostics/completion/navigation, saves keyboard edits and creates/renames files', async () => {
  await mkdir('.test-data', { recursive: true });
  const data = await mkdtemp(resolve('.test-data/code-editor-')),
    project = join(data, 'project');
  await mkdir(project);
  await writeFile(
    join(project, 'example.ts'),
    "import { answer } from './dependency';\nconst result: number = 'wrong';\nconsole.log(answer);\n",
  );
  await writeFile(join(project, 'dependency.ts'), 'export const answer = 42;\n');
  const now = new Date().toISOString();
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Editor acceptance', path: project }],
      settings: { executable: 'embedded' },
      threads: [
        {
          id: 't',
          projectId: 'p',
          cwd: project,
          title: 'Editor acceptance',
          status: 'idle',
          createdAt: now,
          updatedAt: now,
          entries: [],
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
      GROK_DESKTOP_DATA_DIR: data,
      GROK_HOME: join(data, 'grok'),
      XAI_API_KEY: '',
      GROK_DEPLOYMENT_KEY: '',
    },
  });
  try {
    const page = await app.firstWindow();
    // Delay only restoration replies, keeping real file/worker operations intact.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, Function>,
        original = handlers.get('desktop:call')!;
      (globalThis as any).restoredTabReplies = 0;
      ipcMain.removeHandler('desktop:call');
      ipcMain.handle('desktop:call', async (event, method, args) => {
        const value = await original(event, method, args);
        if (method === 'files:tabs' && args.paths === undefined) {
          await new Promise((done) => setTimeout(done, 2000));
          (globalThis as any).restoredTabReplies++;
        }
        return value;
      });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'example.ts', exact: true }).click();
    const input = page.locator('.monaco-editor textarea').first();
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).restoredTabReplies))
      .toBeGreaterThan(0);
    await expect(input).toBeVisible();
    await page.locator('.editor-problems summary').click();
    await expect(page.locator('.editor-problems')).toContainText(
      "Type 'string' is not assignable to type 'number'.",
      { timeout: 25000 },
    );
    await input.focus();
    await input.press('Control+Home');
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('End');
    await input.press('ArrowLeft');
    await input.press('ArrowLeft');
    await input.press('ArrowLeft');
    await expect(page.locator('.editor-position')).toHaveText('Ln 3, Col 18');
    await page.getByRole('button', { name: 'Go to definition', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'dependency.ts', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'example.ts', exact: true }).click();
    await input.focus();
    await input.press('Control+a');
    await page.keyboard.insertText('const result: number = 42;\nMath.');
    await page.getByRole('button', { name: 'Completions', exact: true }).click();
    await expect(page.locator('.suggest-widget.visible')).toBeVisible();
    await input.press('Escape');
    await input.press('Backspace');
    await input.press('Backspace');
    await input.press('Backspace');
    await input.press('Backspace');
    await input.press('Backspace');
    await input.press('Control+s');
    await expect
      .poll(() => readFile(join(project, 'example.ts'), 'utf8'))
      .toBe('const result: number = 42;\n');
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page.locator('.find-widget')).toBeVisible();
    await input.press('Escape');
    await page.getByText('Create or rename files', { exact: true }).click();
    await page.getByLabel('New workspace path').fill('created.txt');
    await page.getByRole('button', { name: 'Create workspace entry', exact: true }).click();
    await expect.poll(() => readFile(join(project, 'created.txt'), 'utf8')).toBe('');
    await page.getByLabel('New workspace path').fill('renamed.txt');
    await page.getByRole('button', { name: 'Rename active file', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toBeVisible();
    await expect
      .poll(() =>
        access(join(project, 'created.txt')).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await page.screenshot({ path: '.test-data/rich-editor.png' });
    expect(errors).toEqual([]);
  } finally {
    // A failed editing assertion may leave a draft. Discard only this fixture's
    // drafts so the native quit prompt does not mask the original failure.
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = ((...args: any[]) => {
        const options = args.at(-1);
        if (options?.buttons?.includes('Discard drafts and quit'))
          return Promise.resolve({ response: 1, checkboxChecked: false });
        return original(...(args as Parameters<typeof original>));
      }) as typeof dialog.showMessageBox;
    });
    await app.close();
  }
});
