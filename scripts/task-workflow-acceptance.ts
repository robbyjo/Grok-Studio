// Explicitly invoked live OAuth acceptance; one disposable-repository model task, no credential copying.
import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import type { Permission, Wire } from '../shared/types';
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to send one real authenticated model prompt.');
  const home = resolve(process.env.GROK_STUDIO_LIVE_HOME ?? 'release/Grok Desktop Data/grok');
  await access(home);
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/task-live-')),
    project = join(root, 'repository'),
    data = join(root, 'desktop');
  await mkdir(project);
  await mkdir(data);
  await mkdir(join(project, '.grok'));
  await writeFile(join(project, 'value.txt'), 'original\n');
  await writeFile(
    join(project, 'check.cjs'),
    "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'edited by managed task\\n');console.log('LIVE_MANAGED_TASK_TEST_OK');\n",
  );
  await writeFile(
    join(project, '.grok', 'config.toml'),
    '[permission]\nask = ["Edit", "Bash(*)"]\n',
  );
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.name', 'Acceptance']);
  git(['config', 'user.email', 'acceptance@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'Disposable task baseline']);
  const now = new Date().toISOString();
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'p',
          name: 'Live task acceptance',
          path: project,
          actions: [
            {
              id: 'check',
              name: 'Check task edit',
              command: process.execPath,
              args: ['check.cjs'],
              directory: '.',
              setup: false,
            },
          ],
        },
      ],
      settings: { executable: 'embedded', authMode: 'oauth' },
      threads: [
        {
          id: 't',
          projectId: 'p',
          cwd: project,
          title: 'Live task acceptance',
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
      GROK_HOME: home,
      XAI_API_KEY: '',
      GROK_DEPLOYMENT_KEY: '',
    },
  });
  const report: Wire = { root, auth: 'existing OAuth, no credential transfer', passed: false };
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Task → test → review', exact: true }).click();
    await page
      .getByLabel('Task prompt')
      .fill(
        'Edit only value.txt using the Edit tool so its entire contents are exactly edited by managed task followed by one newline. Do not modify other files or run tests: Workbench will run check.cjs after your turn. Do not access paths outside this repository.',
      );
    await page.getByRole('checkbox', { name: /Check task edit/ }).check();
    await page.getByRole('button', { name: 'Review task and test commands', exact: true }).click();
    await page
      .getByRole('button', { name: 'Create worktree and start approved task', exact: true })
      .click();
    const deadline = Date.now() + 240000;
    let row: Wire | undefined;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => window.desktop.call<Wire>('state'));
      const child = state.threads.find((thread: Wire) => thread.id !== 't');
      if (child) {
        report.threadId = child.id;
        row = (
          await page.evaluate(
            (id) => window.desktop.call<Wire[]>('workflow:list', { id }),
            child.id,
          )
        )[0];
        if (row && !['preparing', 'running', 'testing'].includes(row.status)) break;
      }
      for (const permission of await page.evaluate(() =>
        window.desktop.call<Permission[]>('permissions'),
      )) {
        const option =
          permission.kind === 'trust'
            ? permission.options.find((o) => o.optionId === 'trust')
            : permission.options.find((o) => o.kind === 'allow_once');
        if (!option) throw new Error('Expected one-time approval is unavailable.');
        // This suite explicitly authorizes the disposable task's project trust and tools.
        await page.getByRole('button', { name: option.name, exact: true }).click();
      }
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(row?.status, 'review', row?.error);
    assert.equal(row!.results[0].exitCode, 0);
    assert.match(row!.results[0].output, /LIVE_MANAGED_TASK_TEST_OK/);
    assert.equal(await readFile(join(project, 'value.txt'), 'utf8'), 'original\n');
    await page.getByRole('button', { name: 'Review task changes', exact: true }).click();
    await page.getByRole('checkbox', { name: 'value.txt', exact: true }).waitFor();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Apply reviewed files', exact: true }).click();
    const applyDeadline = Date.now() + 10000;
    while (
      (await readFile(join(project, 'value.txt'), 'utf8')) !== 'edited by managed task\n' &&
      Date.now() < applyDeadline
    )
      await new Promise((done) => setTimeout(done, 100));
    assert.equal(await readFile(join(project, 'value.txt'), 'utf8'), 'edited by managed task\n');
    assert.match(git(['diff', '--cached']), /edited by managed task/);
    report.passed = true;
    report.testOutput = row!.results[0].output;
    await page.screenshot({ path: join(root, 'live-task.png') });
    console.log('LIVE_TASK_WORKTREE_TEST_REVIEW_APPLY_OK', root);
  } finally {
    await app.close();
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
