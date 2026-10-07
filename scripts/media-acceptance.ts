import { _electron as electron, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to generate real billable media using the selected profile.');
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/live-media-')),
    home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok'),
    now = new Date().toISOString();
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Media acceptance', path: root }],
      settings: { executable: 'embedded', authMode: process.env.GROK_STUDIO_AUTH_MODE ?? 'oauth' },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'Live media',
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
  const app = await electron.launch({
      ...(process.env.GROK_DESKTOP_TEST_EXE
        ? { executablePath: process.env.GROK_DESKTOP_TEST_EXE }
        : {}),
      args: process.env.GROK_DESKTOP_TEST_EXE ? [] : ['.'],
      cwd: resolve('.'),
      env: { ...process.env, GROK_DESKTOP_DATA_DIR: root, GROK_HOME: home },
    }),
    results: any[] = [];
  let originalPrivacy: boolean | undefined,
    privacyChanged = false,
    privacyRestored = false;
  const page = await app.firstWindow();
  try {
    const approve = setInterval(() => {
      void page
        .evaluate(async () => {
          for (const p of await window.desktop.call('permissions')) {
            if (p.kind === 'trust')
              await window.desktop.call('permission:answer', {
                permissionId: p.id,
                optionId: 'trust',
              });
          }
        })
        .catch(() => {});
    }, 500);
    try {
      await page.evaluate(() => window.desktop.call('agent:connect', { id: 't' }));
      if (process.argv.includes('--temporary-retention')) {
        const privacy = await page.evaluate(() =>
          window.desktop.call('privacy:status', { id: 't' }),
        );
        if (typeof privacy.codingDataRetentionOptOut !== 'boolean')
          throw new Error('Cannot establish original privacy state.');
        originalPrivacy = privacy.codingDataRetentionOptOut;
        privacyChanged = true;
        await page.evaluate(() =>
          window.desktop.call('privacy:set', { id: 't', optOut: false, reviewed: true }),
        );
      }
      await page.getByRole('button', { name: 'Media', exact: true }).click();
      const modal = page.getByRole('dialog', { name: 'Media studio' });
      for (const [kind, prompt] of [
        ['image', 'A single blue ceramic cup on a plain white background, product photograph.'],
        ['audio', 'Grok Studio audio playback acceptance.'],
        ['video', 'A blue ceramic cup on a white table. The camera slowly moves closer.'],
      ].filter(([kind]) => !process.argv.includes('--video-only') || kind === 'video')) {
        console.log('MEDIA_START', kind);
        await modal.getByLabel('Media type', { exact: true }).selectOption(kind);
        await modal.getByLabel('Generation prompt', { exact: true }).fill(prompt);
        if (kind === 'video') await modal.getByLabel('Video duration').fill('2');
        const before = await page.evaluate(() => window.desktop.call('media:list'));
        await modal.getByRole('button', { name: 'Generate media', exact: true }).click();
        await expect(
          modal.getByRole('button', { name: 'Generate media', exact: true }),
        ).toBeEnabled({ timeout: 610000 });
        const after = await page.evaluate(() => window.desktop.call('media:list')),
          asset = after.find((a: any) => !before.some((b: any) => a.id === b.id));
        if (!asset) {
          results.push({
            kind,
            status: 'open',
            reason: await modal
              .getByRole('alert')
              .textContent()
              .catch(() => 'No output returned'),
          });
          console.log('MEDIA_OPEN', kind);
          process.exitCode = 1;
          continue;
        }
        const card = modal.locator('.media-card').filter({ hasText: asset.name });
        if (kind === 'image') {
          await expect(card.locator('img')).toHaveJSProperty('complete', true);
          await expect
            .poll(() => card.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth))
            .toBeGreaterThan(0);
        } else {
          const player = card.locator(kind === 'audio' ? 'audio' : 'video');
          await player.evaluate(async (el: HTMLMediaElement) => {
            await el.play();
          });
          await expect
            .poll(() => player.evaluate((el: HTMLMediaElement) => el.currentTime), {
              timeout: 20000,
            })
            .toBeGreaterThan(0);
          await player.evaluate((el: HTMLMediaElement) => el.pause());
        }
        results.push({ kind, status: 'pass', asset });
        console.log('MEDIA_PASS', kind);
      }
      await page.screenshot({ path: join(root, 'media-gallery.png') });
    } finally {
      clearInterval(approve);
    }
  } finally {
    try {
      if (privacyChanged) {
        await page.evaluate(
          (optOut) => window.desktop.call('privacy:set', { id: 't', optOut, reviewed: true }),
          originalPrivacy,
        );
        const restored = await page.evaluate(() =>
          window.desktop.call('privacy:status', { id: 't' }),
        );
        privacyRestored = restored.codingDataRetentionOptOut === originalPrivacy;
        if (!privacyRestored) throw new Error('Original account privacy could not be verified.');
        console.log('MEDIA_PRIVACY_RESTORED', privacyRestored);
      }
    } finally {
      writeFileSync(
        join(root, 'result.json'),
        JSON.stringify(
          {
            startedAt: now,
            engine: 'embedded',
            authMode: process.env.GROK_STUDIO_AUTH_MODE ?? 'oauth',
            originalPrivacy,
            privacyRestored,
            results,
          },
          null,
          2,
        ),
      );
      await app.close();
      console.log('MEDIA_REPORT', root);
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
