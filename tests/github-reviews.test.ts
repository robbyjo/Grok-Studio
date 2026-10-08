import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/store';
import { GitHubReviews, reviewLine } from '../electron/github-reviews';
const patch = '@@ -1,2 +1,2 @@\n old\n-before\n+after';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grok-ghreview-')),
    store = new Store(join(root, 'state.json')),
    p = store.openProject(root, 'Review'),
    t = store.create(p.id, root);
  let head = 'a'.repeat(40),
    posts = 0,
    fail = false,
    body: any,
    reviews: any[] = [];
  const api = new GitHubReviews(
    store,
    async () => ({ root, repository: 'owner/repo' }),
    async (_cwd, args) => {
      if (args.includes('POST')) {
        posts++;
        body = JSON.parse(await readFile(args[args.indexOf('--input') + 1], 'utf8'));
        if (fail) throw new Error('lost response');
        return JSON.stringify({
          id: 10,
          html_url: 'https://github.com/owner/repo/pull/1#review-10',
          state: 'COMMENTED',
        });
      }
      if (args[1].includes('/files'))
        return JSON.stringify([[{ filename: 'file.txt', status: 'modified', patch }]]);
      if (args[1].includes('/reviews')) return JSON.stringify([reviews]);
      return JSON.stringify({
        state: 'open',
        title: 'PR',
        head: { sha: head },
        base: { sha: 'b'.repeat(40) },
        changed_files: 1,
      });
    },
  );
  const input = async (event = 'COMMENT') => {
    const diff = await api.inspect(t.id, 1);
    return {
      number: 1,
      diffRevision: diff.revision,
      event,
      body: 'Reviewed summary',
      comments: [{ path: 'file.txt', line: 2, side: 'RIGHT', body: 'Inline comment' }],
    };
  };
  return {
    api,
    store,
    t,
    input,
    setHead: () => {
      head = 'c'.repeat(40);
    },
    fail: () => {
      fail = true;
    },
    posts: () => posts,
    body: () => body,
    setReviews: (value: any[]) => {
      reviews = value;
    },
  };
}
test('remote reviews bind current PR lines, head and review event; repeated successful action does not repost', async () => {
  const f = await fixture();
  assert.equal(reviewLine(patch, 'LEFT', 2), '-before');
  assert.equal(reviewLine(patch, 'RIGHT', 2), '+after');
  assert.equal(reviewLine(patch, 'RIGHT', 3), undefined);
  for (const event of ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']) {
    const preview = await f.api.preview(f.t.id, await f.input(event));
    const result = await f.api.submit(f.t.id, { revision: preview.revision, confirmed: true });
    assert.equal(result.id, 10);
    assert.equal(f.body().commit_id, 'a'.repeat(40));
    assert.equal(f.body().event, event);
    assert.equal(f.body().comments[0].side, 'RIGHT');
    const posts = f.posts();
    await f.api.submit(f.t.id, { revision: preview.revision, confirmed: true });
    assert.equal(f.posts(), posts);
  }
  const invalid = await f.input();
  invalid.comments[0].line = 300;
  await assert.rejects(f.api.preview(f.t.id, invalid), /visible line/);
  f.store.history.db.close();
});
test('stale PR heads block publication; uncertain responses reconcile a marker without resending', async () => {
  const stale = await fixture(),
    preview = await stale.api.preview(stale.t.id, await stale.input());
  stale.setHead();
  await assert.rejects(
    stale.api.submit(stale.t.id, { revision: preview.revision, confirmed: true }),
    /head or diff changed/,
  );
  assert.equal(stale.posts(), 0);
  stale.store.history.db.close();
  const f = await fixture(),
    draft = await f.api.preview(f.t.id, await f.input());
  f.fail();
  await assert.rejects(
    f.api.submit(f.t.id, { revision: draft.revision, confirmed: true }),
    /uncertain/,
  );
  await assert.rejects(
    f.api.submit(f.t.id, { revision: draft.revision, confirmed: true }),
    /will not resend/,
  );
  assert.equal(f.posts(), 1);
  f.setReviews([
    {
      id: 42,
      body: f.body().body,
      state: 'COMMENTED',
      html_url: 'https://github.com/owner/repo/pull/1#review-42',
    },
  ]);
  assert.equal((await f.api.submit(f.t.id, { revision: draft.revision, confirmed: true })).id, 42);
  assert.equal(f.posts(), 1);
  f.store.history.db.close();
});
