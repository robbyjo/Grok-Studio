import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to publish a real disposable draft PR.');
  const gh = process.platform === 'win32' ? 'C:/Program Files/GitHub CLI/gh.exe' : 'gh';
  mkdirSync('.test-data', { recursive: true });
  const resume = process.argv.indexOf('--resume');
  const root =
    resume >= 0 ? resolve(process.argv[resume + 1]) : mkdtempSync(resolve('.test-data/github-pr-'));
  const cwd = join(root, 'repository');
  const git = (args: string[], path = cwd) =>
    execFileSync('git', args, { cwd: path, windowsHide: true, encoding: 'utf8' }).trim();
  const github = (args: string[]) =>
    execFileSync(gh, args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
  if (resume < 0)
    git(['clone', '--depth', '1', 'https://github.com/robbyjo/Grok-Workbench.git', cwd], root);
  const branch =
    resume >= 0
      ? git(['branch', '--show-current'])
      : 'codex/live-pr-acceptance-' + randomUUID().slice(0, 8);
  if (resume < 0) {
    git(['checkout', '-b', branch]);
    git(['config', 'user.name', 'Grok Workbench acceptance']);
    git(['config', 'user.email', 'acceptance@example.invalid']);
    writeFileSync(
      join(cwd, 'LIVE-PR-ACCEPTANCE.txt'),
      'Disposable Grok Workbench GUI draft publication acceptance. This branch is not intended to merge.\n',
    );
    git(['add', 'LIVE-PR-ACCEPTANCE.txt']);
    git(['commit', '-m', 'test: disposable draft PR publication acceptance']);
    git(['push', '-u', 'origin', branch]);
  }
  const now = new Date().toISOString();
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'GitHub acceptance', path: cwd }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          cwd,
          title: 'GitHub live acceptance',
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
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_DESKTOP_DATA_DIR: root,
      GROK_HOME: join(root, 'grok'),
      XAI_API_KEY: '',
      GROK_DEPLOYMENT_KEY: '',
    },
  });
  let url = '';
  const title = '[Acceptance only] Grok Workbench GUI draft PR';
  const body =
    'This disposable draft validates the Grok Workbench native GUI and GitHub CLI integration.\n\nChecks: real listing, reviewed multiline body, draft publication, exact head/base binding.\n\nIt will be closed without merging after validation.';
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Settings', exact: true });
    await modal.getByRole('button', { name: 'List open pull requests', exact: true }).click();
    if (resume < 0) {
      await modal.getByLabel('PR title', { exact: true }).fill(title);
      await modal.getByLabel('Description', { exact: true }).fill(body);
      await modal.getByLabel('Base branch', { exact: true }).fill('main');
      await modal.getByRole('button', { name: 'Review draft pull request', exact: true }).click();
      await expect(
        modal.getByRole('button', { name: 'Publish reviewed draft PR', exact: true }),
      ).toBeVisible();
      await modal.getByRole('button', { name: 'Publish reviewed draft PR', exact: true }).click();
      await expect(
        modal
          .locator('pre')
          .filter({ hasText: /https:\/\/github.com\/robbyjo\/Grok-Workbench\/pull\/\d+/ }),
      ).toBeVisible({ timeout: 60000 });
    }
    url =
      resume >= 0
        ? JSON.parse(github(['pr', 'view', branch, '--json', 'url'])).url
        : (
            await modal
              .locator('pre')
              .filter({ hasText: /https:\/\/github.com\/robbyjo\/Grok-Workbench\/pull\/\d+/ })
              .innerText()
          ).match(/https:\/\/github.com\/robbyjo\/Grok-Workbench\/pull\/\d+/)![0];
    const actual = JSON.parse(
      github([
        'pr',
        'view',
        url,
        '--json',
        'number,url,isDraft,headRefName,baseRefName,title,body,state',
      ]),
    );
    assert.equal(actual.isDraft, true);
    assert.equal(actual.headRefName, branch);
    assert.equal(actual.baseRefName, 'main');
    assert.equal(actual.title, title);
    assert.equal(actual.body, body);
    await modal.getByRole('button', { name: 'List open pull requests', exact: true }).click();
    await expect(modal.getByRole('button', { name: new RegExp('Acceptance only') })).toBeVisible();
    console.log(
      JSON.stringify({
        url,
        branch,
        root,
        publication: 'pass',
        cleanup: 'pending; attach before closing',
      }),
    );
    let remoteReview;
    if (process.argv.includes('--review')) {
      const beforeReviews = JSON.parse(
        github(['api', `repos/robbyjo/Grok-Workbench/pulls/${actual.number}/reviews`]),
      ).length;
      await modal.getByRole('button', { name: `Review PR #${actual.number}`, exact: true }).click();
      const review = modal.getByRole('region', { name: `Remote review PR ${actual.number}` });
      await review.getByRole('button', { name: 'Fetch remote PR diff', exact: true }).click();
      await expect(review.getByLabel('Remote review file')).toBeVisible({ timeout: 30000 });
      await review.getByLabel('Remote review file').selectOption('LIVE-PR-ACCEPTANCE.txt');
      await review.getByLabel('Remote line number').fill('1');
      await review
        .getByLabel('Remote inline comment')
        .fill('Disposable acceptance: this inline comment is bound to the published PR line.');
      await review.getByRole('button', { name: 'Add remote comment draft', exact: true }).click();
      await review
        .getByLabel('Review summary')
        .fill(
          'Disposable acceptance: reviewed remote COMMENT submission; not a merge recommendation.',
        );
      await review.getByRole('button', { name: 'Review remote submission', exact: true }).click();
      await expect(
        review.getByRole('button', { name: 'Submit reviewed GitHub review', exact: true }),
      ).toBeVisible({ timeout: 30000 });
      // Move the real remote head after preview. Submission must stop before POST.
      writeFileSync(
        join(cwd, 'LIVE-PR-ACCEPTANCE.txt'),
        'Disposable Grok Workbench GUI draft publication acceptance. This branch is not intended to merge.\nStale-head acceptance marker ' +
          randomUUID() +
          '.\n',
      );
      git(['add', 'LIVE-PR-ACCEPTANCE.txt']);
      git(['commit', '-m', 'test: move disposable PR head after review preview']);
      git(['push', 'origin', branch]);
      const expectedHead = git(['rev-parse', 'HEAD']);
      for (let i = 0; i < 30; i++) {
        if (
          JSON.parse(
            github([
              'api',
              `repos/robbyjo/Grok-Workbench/pulls/${actual.number}`,
              '-H',
              'Cache-Control: no-cache',
            ]),
          ).head.sha === expectedHead
        )
          break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(
        JSON.parse(
          github([
            'api',
            `repos/robbyjo/Grok-Workbench/pulls/${actual.number}`,
            '-H',
            'Cache-Control: no-cache',
          ]),
        ).head.sha,
        expectedHead,
        'Wait for GitHub to acknowledge the new PR head before testing the stale preview.',
      );
      await review
        .getByRole('button', { name: 'Submit reviewed GitHub review', exact: true })
        .click();
      await expect(review.getByRole('alert')).toContainText('head or diff changed', {
        timeout: 30000,
      });
      assert.equal(
        JSON.parse(github(['api', `repos/robbyjo/Grok-Workbench/pulls/${actual.number}/reviews`]))
          .length,
        beforeReviews,
      );
      await review.getByRole('button', { name: 'Fetch remote PR diff', exact: true }).click();
      await expect(review.getByRole('alert')).toHaveCount(0);
      await expect(review.locator('code')).toHaveText(git(['rev-parse', 'HEAD']), {
        timeout: 30000,
      });
      await review.getByRole('button', { name: 'Review remote submission', exact: true }).click();
      await expect(
        review.getByRole('button', { name: 'Submit reviewed GitHub review', exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await review
        .getByRole('button', { name: 'Submit reviewed GitHub review', exact: true })
        .click();
      await expect(
        review.getByRole('button', { name: 'Open submitted review', exact: true }),
      ).toBeVisible({ timeout: 30000 });
      const reviews = JSON.parse(
        github(['api', `repos/robbyjo/Grok-Workbench/pulls/${actual.number}/reviews`]),
      );
      assert.equal(reviews.length, beforeReviews + 1);
      const submitted = reviews.at(-1);
      assert.equal(submitted.state, 'COMMENTED');
      assert.equal(submitted.commit_id, git(['rev-parse', 'HEAD']));
      const comments = JSON.parse(
        github(['api', `repos/robbyjo/Grok-Workbench/pulls/${actual.number}/comments`]),
      ).filter((c: any) => c.pull_request_review_id === submitted.id);
      assert.equal(comments.length, 1);
      assert.equal(comments[0].path, 'LIVE-PR-ACCEPTANCE.txt');
      assert.equal(comments[0].line, 1);
      assert.equal(comments[0].side, 'RIGHT');
      remoteReview = {
        staleHeadRefused: true,
        reviewId: submitted.id,
        state: submitted.state,
        inlineComments: comments.length,
        commit: submitted.commit_id,
        url: submitted.html_url,
      };
    }
    await page.screenshot({ path: join(root, 'publication.png') });
    writeFileSync(
      join(root, 'result.json'),
      JSON.stringify(
        { testedAt: now, branch, head: git(['rev-parse', 'HEAD']), ...actual, remoteReview },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        root,
        url,
        branch,
        result: 'passed',
        remoteReview,
        cleanup: 'pending; attach PR before closing it',
      }),
    );
  } finally {
    await app.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
