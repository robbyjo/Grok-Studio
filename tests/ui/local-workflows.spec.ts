import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('native local workflow controls: chunks/comments, exact config editing, reusable actions and worktree archive/restore', async () => {
  const root = await mkdtemp(resolve('.test-data/local-ui-')),
    cwd = join(root, 'project'),
    home = join(root, 'grok'),
    target = join(root, 'worktree');
  await mkdir(cwd);
  await mkdir(home);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  await writeFile(join(cwd, 'value.txt'), original);
  git(['add', '.']);
  git(['commit', '-m', 'baseline']);
  await writeFile(
    join(cwd, 'value.txt'),
    original.replace('line 2\n', 'FIRST_EDIT\n').replace('line 28\n', 'LAST_EDIT\n'),
  );
  const config =
    '# KEEP COMMENT\n[mcp_servers.sample]\ncommand="missing-fixture"\nstartup_timeout_sec=123\n';
  await writeFile(join(home, 'config.toml'), config);
  const now = new Date().toISOString();
  await writeFile(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Local workflow fixture', path: cwd }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'Local fixture',
          cwd,
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
        GROK_DESKTOP_DATA_DIR: root,
        GROK_HOME: home,
        XAI_API_KEY: '',
        GROK_DEPLOYMENT_KEY: '',
      },
    });
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('button', { name: 'Inspect value.txt', exact: true }).click();
    await page.getByText('Chunks and inline review comments', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stage chunk', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: 'Comment right line 2', exact: true }).click();
    await page.getByLabel('Local comment on right line 2').fill('Local line feedback');
    await page.getByRole('button', { name: 'Save local review comment', exact: true }).click();
    await expect(page.getByText('Local line feedback', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stage chunk', exact: true }).first().click();
    await expect.poll(() => git(['diff', '--cached'])).toContain('FIRST_EDIT');
    expect(git(['diff', '--cached'])).not.toContain('LAST_EDIT');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const configuration = dialog.locator('.mcp-settings').filter({
      has: page.getByRole('heading', {
        name: 'Configuration, instructions and rules',
        exact: true,
      }),
    });
    await configuration
      .getByRole('button', { name: 'Inspect sources and duplicate definitions' })
      .click();
    await configuration.getByRole('button', { name: 'Edit source', exact: true }).click();
    const source = configuration.getByLabel('Configuration source text');
    await source.fill(config.replace('123', '456'));
    await configuration.getByRole('button', { name: 'Save reviewed source' }).click();
    await expect
      .poll(() => readFile(join(home, 'config.toml'), 'utf8'))
      .toBe(config.replace('123', '456'));
    const actions = dialog.locator('.mcp-settings').filter({
      has: page.getByRole('heading', { name: 'Project setup and reusable actions', exact: true }),
    });
    await actions.getByLabel('Action name', { exact: true }).fill('Fixture setup');
    await actions.getByLabel('Executable', { exact: true }).fill(process.execPath);
    await actions.getByLabel('Arguments, one per line').fill('-e\nconsole.log("NATIVE_ACTION_OK")');
    await actions.getByRole('button', { name: 'Save action', exact: true }).click();
    await actions.getByRole('button', { name: 'Review and run', exact: true }).click();
    await actions.getByRole('button', { name: 'Run reviewed action', exact: true }).click();
    await expect(actions.getByText('NATIVE_ACTION_OK', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as any;
    }, target);
    await page.getByRole('button', { name: 'Worktree', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create worktree', exact: true });
    await create.getByLabel('New branch', { exact: true }).fill('codex/ui-task');
    await create.getByRole('button', { name: 'Choose folder & create' }).click();
    await expect
      .poll(() => readFile(join(target, 'value.txt'), 'utf8').catch(() => undefined))
      .toBe(original);
    await expect(create).not.toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const worktrees = page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .locator('.mcp-settings')
      .filter({ has: page.getByRole('heading', { name: 'Repository worktrees', exact: true }) });
    await worktrees.getByRole('button', { name: 'Inspect worktrees', exact: true }).click();
    await worktrees.getByRole('button', { name: 'Archive this app-created worktree' }).click();
    await worktrees.getByRole('button', { name: 'Confirm recoverable archive' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const restoredTools = page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .locator('.mcp-settings')
      .filter({ has: page.getByRole('heading', { name: 'Repository worktrees', exact: true }) });
    await restoredTools.getByRole('button', { name: 'Inspect worktrees', exact: true }).click();
    await restoredTools.getByRole('button', { name: 'Restore archive', exact: true }).click();
    await expect
      .poll(() => readFile(join(target, 'value.txt'), 'utf8').catch(() => undefined))
      .toBe(original);
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toBeVisible();
    await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
    await page.screenshot({ path: '.test-data/local-workflows.png' });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
  }
});
