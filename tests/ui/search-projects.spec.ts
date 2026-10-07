import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('native search jumps to messages and project removal retains files, drafts and chats across restart', async () => {
  await mkdir(resolve('.test-data'), { recursive: true });
  const data = await mkdtemp(resolve('.test-data', 'organization-'));
  const project = join(data, 'project');
  await mkdir(project);
  await writeFile(join(project, 'draft.txt'), 'original\n');
  const chat = (id: string, title: string, archived = false) => ({
    id,
    projectId: 'p',
    title,
    cwd: project,
    status: 'idle',
    archived,
    pinned: false,
    createdAt: '2026-10-07',
    updatedAt: '2026-10-07',
    entries: [{ id: `${id}-message`, type: 'assistant', text: `Saved transcript ${id}` }],
  });
  const main = chat('t', 'Search fixture');
  main.entries = [
    { id: 'needle', type: 'assistant', text: 'The older CAFÉ 東京 message contains [a.*].' },
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `filler-${index}`,
      type: 'assistant',
      text: `Later reply ${index}\n\n${'Ordinary content. '.repeat(35)}`,
    })),
  ];
  (main.entries as any[]).push({
    id: 'tool',
    type: 'tool',
    text: 'Build report',
    data: { rawOutput: 'Unique tool output: FIXTURE_BUILD_OK', status: 'completed' },
  });
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [
        { id: 'p', name: 'Organization fixture', path: project },
        { id: 'h', name: 'Previously removed', path: join(data, 'removed'), hidden: true },
      ],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        main,
        chat('a', 'Archived fixture', true),
        { ...chat('h-chat', 'Hidden fixture'), projectId: 'h' },
      ],
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
        GROK_DESKTOP_DATA_DIR: data,
        GROK_HOME: join(data, 'grok'),
        XAI_API_KEY: '',
        GROK_DEPLOYMENT_KEY: '',
      },
    });
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.breadcrumbs')).toContainText('Search fixture');
    await page.keyboard.press('Control+Shift+f');
    const search = page.getByRole('dialog', { name: 'Search chats', exact: true });
    const query = search.getByLabel('Titles and full saved transcripts');
    await expect(query).toBeFocused();
    await query.fill('café 東京');
    await expect(search.locator('.search-hit')).toHaveCount(1);
    await expect(search.locator('mark')).toHaveText('CAFÉ 東京');
    await page.screenshot({ path: '.test-data/desktop-search.png' });
    await search.locator('.search-hit').click();
    const entry = page.locator('[data-entry-id="needle"]');
    await expect(entry).toBeFocused();
    await expect(entry).toHaveClass('matched-entry');
    expect(
      await entry.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const container = element.closest('.messages')!.getBoundingClientRect();
        return rect.top >= container.top && rect.bottom <= container.bottom;
      }),
    ).toBe(true);
    await page.getByRole('button', { name: 'Search chats', exact: true }).click();
    await query.fill('FIXTURE_BUILD_OK');
    await expect(search.locator('.search-hit')).toHaveCount(1);
    await search.locator('.search-hit').click();
    await expect(page.locator('[data-entry-id="tool"] details')).toHaveAttribute('open', '');
    await expect(page.locator('[data-entry-id="tool"] pre')).toContainText('FIXTURE_BUILD_OK');
    await page.getByRole('button', { name: 'Search chats', exact: true }).click();
    await query.fill('Saved transcript a');
    await expect(search.locator('.search-hit')).toHaveCount(1);
    await search.getByLabel('Include archived chats').uncheck();
    await expect(search.locator('.search-hit')).toHaveCount(0);
    await search.getByLabel('Include archived chats').check();
    await expect(search.locator('.search-hit')).toHaveCount(1);
    await search.locator('.search-hit').click();
    await expect(page.locator('.archived-banner')).toContainText('This chat is archived');
    await page.getByRole('button', { name: 'Search chats', exact: true }).click();
    await query.fill('Saved transcript h-chat');
    await expect(search.getByRole('status')).toContainText('0 results');
    await search.getByLabel('Include removed projects').check();
    await expect(search.locator('.search-hit')).toHaveCount(1);
    await search.locator('.search-hit').click();
    await expect(page.locator('.archived-banner')).toContainText('removed from the sidebar');
    await expect(page.getByRole('button', { name: /^New chat/ })).toBeDisabled();
    await page.getByRole('button', { name: 'Search fixture', exact: false }).first().click();
    await page
      .getByRole('button', { name: 'Manage project Organization fixture', exact: true })
      .click();
    const settings = page.getByRole('dialog', { name: 'Project settings', exact: true });
    await settings.getByLabel('Project name').fill('Renamed project');
    await settings.getByRole('button', { name: 'Save project name', exact: true }).click();
    await expect(page.locator('.breadcrumbs')).toContainText('Renamed project');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'draft.txt', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Edit draft.txt', exact: true })
      .fill('Retained unsaved draft\n');
    await page.evaluate(async () => {
      await window.desktop.call('terminal:open', { id: 't' });
      await window.desktop.call('terminal:write', {
        id: 't',
        data: "Write-Output ('REMOVE_READY_' + (40 + 2))\r",
      });
    });
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.desktop.call('terminal:open', { id: 't' })).buffer,
          ),
        { timeout: 15000 },
      )
      .toContain('REMOVE_READY_42');
    await page.getByRole('button', { name: 'Manage project Renamed project', exact: true }).click();
    await settings.getByRole('button', { name: 'Remove from sidebar', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText(
      'Chats, file drafts, files and worktrees are retained',
    );
    await settings.getByRole('button', { name: 'Keep project', exact: true }).click();
    await expect(
      settings.getByRole('button', { name: 'Confirm remove project', exact: true }),
    ).toHaveCount(0);
    await settings.getByRole('button', { name: 'Remove from sidebar', exact: true }).click();
    await settings.getByRole('button', { name: 'Confirm remove project', exact: true }).click();
    await expect(page.locator('.thread-list .thread-row')).toHaveCount(0);
    await expect(
      page.evaluate(() =>
        window.desktop.call('terminal:write', { id: 't', data: 'must not reach a closed shell' }),
      ),
    ).rejects.toThrow('Terminal is closed');
    expect(await readFile(join(project, 'draft.txt'), 'utf8')).toBe('original\n');
    const retained = await page.evaluate(() => window.desktop.call('state'));
    expect(retained.threads).toHaveLength(3);
    expect(retained.threads.find((thread: any) => thread.id === 'a').archived).toBe(true);
    await expect(
      page.evaluate(() => window.desktop.call('thread:new', { projectId: 'p' })),
    ).rejects.toThrow('Restore the project');
    await page.getByRole('button', { name: 'Removed projects', exact: true }).click();
    await page
      .getByRole('button', { name: 'Manage removed project Renamed project', exact: true })
      .click();
    await settings.getByRole('button', { name: 'Restore project', exact: true }).click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'draft.txt', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Edit draft.txt', exact: true })).toHaveValue(
      'Retained unsaved draft\n',
    );
    await page.getByRole('button', { name: 'Save file', exact: true }).click();
    await expect
      .poll(() => readFile(join(project, 'draft.txt'), 'utf8'))
      .toBe('Retained unsaved draft\n');
    await page.getByRole('button', { name: 'Manage project Renamed project', exact: true }).click();
    await settings.getByRole('button', { name: 'Remove from sidebar', exact: true }).click();
    await settings.getByRole('button', { name: 'Confirm remove project', exact: true }).click();
    await page.screenshot({ path: '.test-data/desktop-removed-project.png' });
    expect(errors).toEqual([]);
    await app.close();
    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.locator('.thread-list .thread-row')).toHaveCount(0);
    await expect(
      reopened.locator('.sidebar').getByRole('button', { name: 'Open a project', exact: true }),
    ).toBeVisible();
    // Stub the picker response only; use native canonicalization and project restoration.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as any;
    }, project);
    await reopened
      .locator('.sidebar')
      .getByRole('button', { name: 'Open a project', exact: true })
      .click();
    await expect(reopened.locator('.breadcrumbs')).toContainText('Renamed project');
    const saved = await reopened.evaluate(() => window.desktop.call('state'));
    expect(saved.projects).toHaveLength(2);
    expect(saved.threads).toHaveLength(3);
    expect(saved.projects.find((project: any) => project.id === 'p').hidden).toBe(false);
    expect(saved.threads.find((thread: any) => thread.id === 't').entries).toHaveLength(27);
    expect(saved.threads.find((thread: any) => thread.id === 'a').archived).toBe(true);
  } finally {
    await app?.close();
  }
});
