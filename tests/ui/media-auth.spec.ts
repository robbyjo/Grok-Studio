import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { History } from '../../electron/history';
import { Media } from '../../electron/media';
test('native media previews play local audio, attach binary files and retain drafts; API keys stay encrypted', async () => {
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/media-ui-')),
    now = new Date().toISOString();
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Media fixture', path: root }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'Media chat',
          cwd: root,
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
  const history = new History(join(root, 'history.sqlite'), 64),
    media = new Media(join(root, 'media-files'), history);
  const image = media.add(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lFEAAAAASUVORK5CYII=',
      'base64',
    ),
    'preview.png',
    'attachment',
  );
  const wave = Buffer.alloc(44 + 16000);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(16000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(16000, 40);
  media.add(wave, 'playback.wav', 'attachment');
  history.db.close();
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
    await page.getByRole('button', { name: 'Media', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Media studio' });
    await expect(modal.locator('img')).toHaveJSProperty('naturalWidth', 1);
    const audio = modal.locator('audio');
    await audio.evaluate(async (el: HTMLAudioElement) => {
      await el.play();
    });
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime))
      .toBeGreaterThan(0);
    await audio.evaluate((el: HTMLAudioElement) => el.pause());
    await modal
      .locator('.media-card')
      .filter({ hasText: 'preview.png' })
      .getByRole('button', { name: 'Attach to prompt' })
      .click();
    await expect(page.locator('.attachments')).toContainText('preview.png');
    await page.waitForTimeout(700);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].reload());
    await expect(page.locator('.attachments')).toContainText('preview.png');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByLabel('Authentication method', { exact: true }).selectOption('oauth');
    await expect(settings.getByLabel('Authentication method', { exact: true })).toHaveValue(
      'oauth',
    );
    await settings
      .getByLabel('xAI API key', { exact: true })
      .fill('xai-studio-test-secret-not-a-real-key');
    await settings.getByLabel('Remember with Windows encrypted storage').check();
    await settings.getByRole('button', { name: 'Save API key', exact: true }).click();
    await expect(settings.getByLabel('xAI API key', { exact: true })).toHaveValue('');
    const saved = await page.evaluate(() => window.desktop.call('state'));
    expect(JSON.stringify(saved)).not.toContain('xai-studio-test-secret');
    const blob = readFileSync(join(root, 'xai-api-key.bin'), 'utf8');
    expect(blob).not.toContain('xai-studio-test-secret');
    await settings.getByRole('button', { name: 'Forget stored API key', exact: true }).click();
    await expect(
      settings.getByRole('status').filter({ hasText: 'API key: not set' }),
    ).toBeVisible();
    await page.screenshot({ path: join(root, 'authentication.png') });
    await page.evaluate(() => window.desktop.call('drafts:save', { value: {} }));
  } finally {
    await app.close();
  }
});
