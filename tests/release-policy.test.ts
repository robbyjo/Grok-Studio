import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { validateRun } = createRequire(import.meta.url)('../scripts/publish-ci-release.cjs');
test('release publication rejects unsuccessful, stale, fork/PR and unrelated workflow builds', () => {
  const head = 'a'.repeat(40),
    run = {
      head_sha: head,
      head_branch: 'main',
      event: 'push',
      conclusion: 'success',
      status: 'completed',
      path: '.github/workflows/windows.yml',
      repository: { full_name: 'robbyjo/Grok-Workbench' },
    };
  validateRun(run, head);
  for (const invalid of [
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { head_sha: 'b'.repeat(40) },
    { event: 'pull_request' },
    { head_branch: 'other' },
    { path: '.github/workflows/release.yml' },
    { repository: { full_name: 'someone/fork' } },
  ])
    assert.throws(() => validateRun({ ...run, ...invalid }, head), /trusted Windows run/);
});
