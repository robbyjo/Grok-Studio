import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import type { Wire } from '../shared/types';
import type { Store } from './store';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function reviewLine(patch: string, side: string, target: number) {
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !line || line.startsWith('\\')) continue;
    if (!/^[ +\-]/.test(line)) {
      inHunk = false;
      continue;
    }
    if (
      (side === 'LEFT' && line[0] !== '+' && oldLine === target) ||
      (side === 'RIGHT' && line[0] !== '-' && newLine === target)
    )
      return line;
    if (line[0] !== '+') oldLine++;
    if (line[0] !== '-') newLine++;
  }
  return undefined;
}
/** User-reviewed remote actions; credentials remain exclusively in GitHub CLI. */
export class GitHubReviews {
  constructor(
    private store: Store,
    private source: (id: string) => Promise<{ root: string; repository: string }>,
    private cli: (cwd: string, args: string[]) => Promise<string>,
  ) {}
  async inspect(id: string, number: number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error('Choose a pull request number.');
    const { root, repository } = await this.source(id),
      endpoint = `repos/${repository}/pulls/${number}`;
    const pr = JSON.parse(await this.cli(root, ['api', endpoint, '-H', 'Cache-Control: no-cache']));
    if (
      pr.state !== 'open' ||
      !/^[a-f0-9]{40}$/.test(pr.head?.sha) ||
      !/^[a-f0-9]{40}$/.test(pr.base?.sha)
    )
      throw new Error('Choose an open pull request with a valid head/base.');
    const pages = JSON.parse(
      await this.cli(root, ['api', endpoint + '/files?per_page=100', '--paginate', '--slurp']),
    );
    const files = pages.flat().map((f: Wire) => ({
      path: f.filename,
      status: f.status,
      previousPath: f.previous_filename,
      patch: f.patch ?? '',
    }));
    if (files.length !== pr.changed_files || files.length > 3000)
      throw new Error('Pull request exceeds the complete diff review limit.');
    const after = JSON.parse(
      await this.cli(root, ['api', endpoint, '-H', 'Cache-Control: no-cache']),
    );
    if (
      after.state !== 'open' ||
      after.head?.sha !== pr.head.sha ||
      after.base?.sha !== pr.base.sha ||
      after.changed_files !== pr.changed_files
    )
      throw new Error('Pull request changed while fetching the diff. Inspect it again.');
    const value = {
      repository,
      number,
      head: pr.head.sha,
      base: pr.base.sha,
      title: pr.title,
      url: pr.html_url,
      files,
    };
    return { ...value, revision: hash(value) };
  }
  async preview(id: string, input: Wire) {
    const current = await this.inspect(id, input.number);
    if (input.diffRevision !== current.revision)
      throw new Error('Pull request changed. Inspect its remote diff again.');
    if (
      !['COMMENT', 'APPROVE', 'REQUEST_CHANGES'].includes(input.event) ||
      typeof input.body !== 'string' ||
      input.body.length > 20000 ||
      !Array.isArray(input.comments) ||
      input.comments.length > 50 ||
      (!input.body.trim() && !input.comments.length)
    )
      throw new Error(
        'Write a review summary or up to 50 inline comments and choose a review action.',
      );
    if (input.event === 'REQUEST_CHANGES' && !input.body.trim())
      throw new Error('Explain the requested changes in the review summary.');
    const comments = input.comments.map((c: Wire) => {
      const file = current.files.find((f: Wire) => f.path === c.path),
        side = typeof c.side === 'string' ? c.side.toUpperCase() : '';
      if (
        !file ||
        !['LEFT', 'RIGHT'].includes(side) ||
        !Number.isSafeInteger(c.line) ||
        c.line < 1 ||
        typeof c.body !== 'string' ||
        !c.body.trim() ||
        c.body.length > 10000 ||
        !reviewLine(file.patch, side, c.line)
      )
        throw new Error(
          'Each inline comment must reference a visible line in the current remote PR diff.',
        );
      return {
        path: c.path,
        side,
        line: c.line,
        body: c.body,
        context: reviewLine(file.patch, side, c.line),
      };
    });
    const value = {
      threadId: id,
      repository: current.repository,
      number: current.number,
      head: current.head,
      diffRevision: current.revision,
      event: input.event,
      body: input.body,
      comments,
      token: randomUUID(),
    };
    const preview = { ...value, revision: hash(value) };
    const records = (this.store.history.value('github-reviews') ?? []).filter(
      (r: Wire) => r.state !== 'preview',
    );
    this.store.history.setValue('github-reviews', [
      ...records.slice(-19),
      { ...preview, state: 'preview' },
    ]);
    return preview;
  }
  async submit(id: string, input: Wire) {
    const records: Wire[] = this.store.history.value('github-reviews') ?? [],
      record = records.find((r) => r.revision === input.revision && r.threadId === id);
    if (!record || input.confirmed !== true)
      throw new Error('Confirm a stored, reviewed remote submission.');
    if (record.state === 'submitted')
      return { id: record.reviewId, url: record.url, state: record.reviewState, recovered: true };
    const { root, repository } = await this.source(id);
    if (repository !== record.repository) throw new Error('Repository changed. Review again.');
    const endpoint = `repos/${repository}/pulls/${record.number}/reviews`,
      marker = `<!-- grok-workbench-review:${record.token} -->`;
    if (record.state === 'sending' || record.state === 'uncertain') {
      const pages = JSON.parse(
        await this.cli(root, ['api', endpoint + '?per_page=100', '--paginate', '--slurp']),
      );
      const found = pages.flat().find((r: Wire) => r.body?.includes(marker));
      if (found) {
        record.state = 'submitted';
        record.reviewId = found.id;
        record.url = found.html_url;
        record.reviewState = found.state;
        this.store.history.setValue('github-reviews', records);
        return { id: found.id, url: found.html_url, state: found.state, recovered: true };
      }
      throw new Error(
        'The previous submission outcome is uncertain. Check GitHub before preparing a new review; this action will not resend it.',
      );
    }
    const current = await this.inspect(id, record.number);
    if (current.revision !== record.diffRevision || current.head !== record.head)
      throw new Error('Remote PR head or diff changed. Prepare a new review.');
    const temporary = await mkdtemp(join(tmpdir(), 'grok-review-')),
      path = join(temporary, 'review.json');
    try {
      await writeFile(
        path,
        JSON.stringify({
          commit_id: record.head,
          event: record.event,
          body: record.body + '\n\n' + marker,
          comments: record.comments.map(({ path, line, side, body }: Wire) => ({
            path,
            line,
            side,
            body,
          })),
        }),
        { mode: 0o600 },
      );
      record.state = 'sending';
      this.store.history.setValue('github-reviews', records);
      let result: Wire;
      try {
        result = JSON.parse(
          await this.cli(root, ['api', '--method', 'POST', endpoint, '--input', path]),
        );
      } catch (error) {
        record.state = 'uncertain';
        this.store.history.setValue('github-reviews', records);
        throw new Error(
          `Remote submission outcome is uncertain; it will not be retried automatically. ${String(error)}`,
        );
      }
      record.state = 'submitted';
      record.reviewId = result.id;
      record.url = result.html_url;
      record.reviewState = result.state;
      this.store.history.setValue('github-reviews', records);
      return { id: result.id, url: result.html_url, state: result.state };
    } finally {
      const rel = relative(tmpdir(), temporary);
      if (!rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Unsafe review temporary directory.');
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
