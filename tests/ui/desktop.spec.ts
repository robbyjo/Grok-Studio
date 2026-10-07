import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve('.test-data');
test('native desktop: persisted chat, file/diff panels, terminal, and IPC boundaries', async () => {
  await mkdir(root, { recursive: true });
  const data = await mkdtemp(join(root, 'ui-'));
  const project = join(data, 'project');
  await mkdir(project);
  const git = (args: string[]) => execFileSync('git', args, { cwd: project, windowsHide: true });
  git(['init']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(project, 'hello.txt'), 'original\n');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  await writeFile(join(project, 'hello.txt'), 'Changed in the real filesystem\n');
  const now = new Date().toISOString();
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Desktop fixture', path: project }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'Fixture chat',
          cwd: project,
          status: 'idle',
          archived: false,
          pinned: false,
          createdAt: now,
          updatedAt: now,
          entries: [],
        },
      ],
    }),
  );
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
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
      timeout: 30_000,
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: 'What are we building?' })).toBeVisible();
    await expect(page.getByText('Changed in the real filesystem', { exact: false })).toBeVisible();
    await page.screenshot({ path: '.test-data/desktop-welcome.png' });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'hello.txt' }).click();
    const editor = page.getByRole('textbox', { name: 'Edit hello.txt', exact: true });
    await expect(editor).toHaveValue('Changed in the real filesystem\n');
    await editor.fill('Unsaved GUI draft\n');
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    await page.getByRole('button', { name: 'hello.txt', exact: true }).click();
    await expect(editor).toHaveValue('Unsaved GUI draft\n');
    await page.evaluate(async () => {
      await window.desktop.call('terminal:open', { id: 't' });
      await window.desktop.call('terminal:write', { id: 't', data: '$taskSurvivedQuit = 42\r' });
    });
    // Stub only the native confirmation response to exercise the real close guard.
    await app.evaluate(({ dialog }) => {
      (globalThis as any).taskOriginalDialog = dialog.showMessageBox;
      (globalThis as any).taskDialogCount = 0;
      dialog.showMessageBox = (() => {
        (globalThis as any).taskDialogCount++;
        return new Promise((done) => {
          (globalThis as any).taskAnswerDialog = done;
        });
      }) as any;
    });
    await app.evaluate(({ app }) => app.quit());
    await expect.poll(() => app!.evaluate(() => (globalThis as any).taskDialogCount)).toBe(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    expect(await app.evaluate(() => (globalThis as any).taskDialogCount)).toBe(1);
    await app.evaluate(({ dialog }) => {
      (globalThis as any).taskAnswerDialog({ response: 0 });
      dialog.showMessageBox = (globalThis as any).taskOriginalDialog;
    });
    await page.evaluate(() =>
      window.desktop.call('terminal:write', {
        id: 't',
        data: "Write-Output ('QUIT_CANCELED_' + $taskSurvivedQuit)\r",
      }),
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.desktop.call('terminal:open', { id: 't' })).buffer,
          ),
        { timeout: 15000 },
      )
      .toContain('QUIT_CANCELED_42');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect
      .poll(() => readFile(join(project, 'hello.txt'), 'utf8'))
      .toBe('Unsaved GUI draft\n');
    await writeFile(join(project, 'hello.txt'), 'External process edit\n');
    await editor.fill('Draft must survive conflict\n');
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('File changed on disk');
    await expect(editor).toHaveValue('Draft must survive conflict\n');
    expect(await readFile(join(project, 'hello.txt'), 'utf8')).toBe('External process edit\n');
    await page.getByRole('button', { name: 'Reload file', exact: true }).click();
    await page.getByRole('button', { name: 'Discard draft and reload', exact: true }).click();
    await expect(editor).toHaveValue('External process edit\n');
    await editor.fill('Edited from the native GUI\n');
    await editor.press('Control+s');
    await expect
      .poll(() => readFile(join(project, 'hello.txt'), 'utf8'))
      .toBe('Edited from the native GUI\n');
    await page.screenshot({ path: '.test-data/desktop-editor.png' });
    await writeFile(join(project, 'keep-untracked.txt'), 'Keep this unstaged');
    await page.getByRole('button', { name: /^Changes/ }).click();
    await expect(
      page.getByRole('button', { name: 'Inspect hello.txt', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Inspect hello.txt', exact: true }).click();
    await expect(page.locator('.diff-view').first()).toContainText('+Edited from the native GUI');
    await page.getByRole('button', { name: 'Stage hello.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage hello.txt', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Unstage hello.txt', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stage hello.txt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stage hello.txt', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Unstage hello.txt', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Review staged commit', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Commit message', exact: true })
      .fill('Native GUI staged commit');
    await page.screenshot({ path: '.test-data/desktop-commit.png' });
    await page.getByRole('button', { name: 'Commit staged index', exact: true }).click();
    await expect(page.locator('.git-notice')).toContainText('Committed');
    expect(git(['show', 'HEAD:hello.txt']).toString()).toBe('Edited from the native GUI\n');
    expect(git(['log', '-1', '--format=%s']).toString().trim()).toBe('Native GUI staged commit');
    expect(await readFile(join(project, 'keep-untracked.txt'), 'utf8')).toBe('Keep this unstaged');
    await page.getByRole('button', { name: 'Pin chat', exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.desktop.call('state')).threads[0].pinned),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Rename chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Chat title' }).fill('Renamed fixture');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.breadcrumbs')).toContainText('Renamed fixture');
    await page.getByRole('button', { name: 'Toggle terminal', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    await page.evaluate(async () => {
      await window.desktop.call('terminal:write', {
        id: 't',
        data: "$taskSum = 40 + 2; Write-Output ('TERMINAL_' + $taskSum)\r",
      });
    });
    await expect
      .poll(
        async () =>
          page.evaluate(
            async () => (await window.desktop.call('terminal:open', { id: 't' })).buffer,
          ),
        { timeout: 15_000 },
      )
      .toContain('TERMINAL_42');
    await page.screenshot({ path: '.test-data/desktop-terminal.png' });
    await expect(
      page.evaluate(() => ({
        node: typeof (window as any).require,
        process: typeof (window as any).process,
      })),
    ).resolves.toEqual({ node: 'undefined', process: 'undefined' });
    const rejected = await page.evaluate(async () => {
      try {
        await window.desktop.call('files:read', { id: 't', path: '../state.json' });
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(
      page.getByText('Grok currently has no OS sandbox on Windows.', { exact: false }),
    ).toBeVisible();
    await page.screenshot({ path: '.test-data/desktop-settings.png' });
    await page.getByText('Add MCP server', { exact: true }).click();
    await page.getByLabel('Server name', { exact: true }).fill('ui-fixture');
    await page.getByLabel('Server command', { exact: true }).fill(process.execPath);
    await page
      .getByLabel('Arguments (one per line, without shell quoting)', { exact: true })
      .fill(resolve('tests/fixtures/mcp.mjs'));
    await page.getByRole('button', { name: 'Save MCP server', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Test connection: ui-fixture', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Test connection: ui-fixture', exact: true }).click();
    await expect(
      page.getByText('Connection diagnostics: 1 healthy, 0 failing', { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: '.test-data/desktop-mcp.png' });
    await page.getByRole('button', { name: 'Disable ui-fixture', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Enable ui-fixture', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Enable ui-fixture', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Disable ui-fixture', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Remove ui-fixture', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Test connection: ui-fixture', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
    await expect(page.locator('.archived-banner')).toBeVisible();
    await page.locator('.archived-banner').getByRole('button', { name: 'Restore chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Message Grok' })).toBeVisible();
    expect(errors).toEqual([]);
    await app.close();
    app = undefined;
    app = await electron.launch({
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
    const reopened = await app.firstWindow();
    await expect(reopened.locator('.breadcrumbs')).toContainText('Renamed fixture');
    const saved = await reopened.evaluate(async () => await window.desktop.call('state'));
    expect(saved.threads[0].pinned).toBe(true);
    expect(saved.threads[0].archived).toBe(false);
  } finally {
    await app?.close();
  }
});
