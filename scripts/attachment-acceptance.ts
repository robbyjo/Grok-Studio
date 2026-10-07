import { _electron as electron } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import assert from 'node:assert/strict';
import { History } from '../electron/history';
import { Media } from '../electron/media';

async function main() {
  const index = process.argv.indexOf('--image');
  if (!process.argv.includes('--run') || index < 0 || !process.argv[index + 1])
    throw new Error(
      'Usage: tsx scripts/attachment-acceptance.ts --run --image FILE. Sends a real billable image prompt.',
    );
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/live-attachment-')),
    now = new Date().toISOString();
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Attachment acceptance', path: root }],
      settings: { executable: 'embedded', authMode: 'oauth' },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'Image prompt',
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
    media = new Media(join(root, 'media-files'), history),
    path = resolve(process.argv[index + 1]);
  const image = media.add(readFileSync(path), basename(path), 'attachment');
  assert.ok(image.mimeType.startsWith('image/'));
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
      GROK_HOME: resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok'),
    },
  });
  const page = await app.firstWindow();
  const approvals = setInterval(
    () =>
      void page
        .evaluate(async () => {
          for (const p of await window.desktop.call('permissions'))
            await window.desktop.call('permission:answer', {
              permissionId: p.id,
              optionId:
                p.kind === 'trust'
                  ? 'trust'
                  : p.options.find((o: any) => o.kind === 'reject_once')?.optionId,
            });
        })
        .catch(() => {}),
    200,
  );
  try {
    await page.evaluate(
      (assetId) =>
        window.desktop.call('agent:prompt', {
          id: 't',
          text: 'Describe the attached image: identify its main object and color. Use no tools.',
          attachments: [assetId],
        }),
      image.id,
    );
    const state = await page.evaluate(() => window.desktop.call('state')),
      thread = state.threads.find((t: any) => t.id === 't');
    assert.equal(thread.status, 'idle');
    const reply = thread.entries
      .filter((e: any) => e.type === 'assistant')
      .map((e: any) => e.text)
      .join('\n');
    assert.ok(reply.trim(), 'The real model must answer the image prompt.');
    if (process.argv.includes('--expect-cup')) assert.match(reply, /cup|mug/i);
    const user = thread.entries.find((e: any) => e.type === 'user');
    assert.equal(user.data.attachments[0].id, image.id);
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        {
          testedAt: now,
          engine: 'embedded',
          authMode: 'oauth',
          image: { mimeType: image.mimeType, size: image.size },
          reply,
          status: 'pass',
        },
        null,
        2,
      ),
    );
    console.log('LIVE_IMAGE_PROMPT_PASS', root);
  } finally {
    clearInterval(approvals);
    await app.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
