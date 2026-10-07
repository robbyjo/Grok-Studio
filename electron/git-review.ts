import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { git, gitInput } from './git-runner';
import { changes, indexRevision } from './git-actions';
import { insideFuture } from './paths';
import { openDocument } from './editor';
import { Store } from './store';
import type { Wire } from '../shared/types';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exec = promisify(execFile);
export function splitHunks(patch: string) {
  const start = patch.indexOf('\n@@ ');
  if (
    start < 0 ||
    /GIT binary patch|Binary files|(?:new|deleted) file mode|(?:old|new) mode|similarity index/.test(
      patch,
    )
  )
    return { header: '', hunks: [] as string[] };
  const body = patch.slice(start + 1);
  return { header: patch.slice(0, start + 1), hunks: body.split(/(?=^@@ )/m).filter(Boolean) };
}
function hasLine(hunks: string[], side: string, target: number) {
  for (const hunk of hunks) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk);
    if (!match) continue;
    let oldLine = Number(match[1]),
      newLine = Number(match[2]);
    for (const line of hunk.split('\n').slice(1)) {
      if (!line || line.startsWith('\\')) continue;
      if (side === 'left' && !line.startsWith('+') && oldLine === target) return true;
      if (side === 'right' && !line.startsWith('-') && newLine === target) return true;
      if (!line.startsWith('+')) oldLine++;
      if (!line.startsWith('-')) newLine++;
    }
  }
  return false;
}
export class GitReview {
  constructor(private store: Store) {}
  async chunks(id: string, path: string, staged: boolean) {
    const root = this.store.thread(id).cwd;
    await insideFuture(root, path);
    const entry = (await changes(root)).find((item) => item.path === path);
    if (!entry || entry.conflicted || entry.originalPath || entry.index === '?')
      throw new Error('Choose a changed tracked text file without conflicts or renames.');
    const patch = await git(root, [
      '--literal-pathspecs',
      'diff',
      ...(staged ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--full-index',
      '--',
      path,
    ]);
    const parts = splitHunks(patch);
    return { ...parts, revision: hash({ patch, index: await indexRevision(root) }), path, staged };
  }
  async chunk(id: string, input: Wire) {
    if (
      !['stage', 'unstage', 'revert'].includes(input.operation) ||
      !Number.isSafeInteger(input.chunk) ||
      input.chunk < 0
    )
      throw new Error('Choose an advertised chunk action.');
    const staged = input.operation === 'unstage';
    const current = await this.chunks(id, input.path, staged);
    if (current.revision !== input.revision || !current.hunks[input.chunk])
      throw new Error('Diff changed. Inspect the chunks again.');
    const root = this.store.thread(id).cwd,
      patch = current.header + current.hunks[input.chunk];
    const flags =
      input.operation === 'stage'
        ? ['--cached']
        : input.operation === 'unstage'
          ? ['--cached', '--reverse']
          : ['--reverse'];
    await gitInput(root, ['apply', '--check', ...flags, '-'], patch);
    let recovery;
    if (input.operation === 'revert') {
      if (input.reviewed !== true) throw new Error('Confirm reverting the reviewed chunk.');
      const document = await openDocument(root, input.path);
      recovery = this.store.saveRecovery({
        cwd: root,
        path: input.path,
        text: document.text,
        revision: document.revision,
        operation: 'revert-chunk',
      });
    }
    await gitInput(root, ['apply', ...flags, '-'], patch);
    return { changed: true, recovery };
  }
  async comment(id: string, input: Wire) {
    const current = await this.chunks(id, input.path, input.staged === true);
    if (
      input.revision !== current.revision ||
      !['left', 'right'].includes(input.side) ||
      !Number.isSafeInteger(input.line) ||
      input.line < 1 ||
      !hasLine(current.hunks, input.side, input.line) ||
      typeof input.body !== 'string' ||
      !input.body.trim() ||
      input.body.length > 10000
    )
      throw new Error('Choose a line and write a comment on the current reviewed diff.');
    const thread = this.store.thread(id),
      comment = {
        id: randomUUID(),
        path: input.path,
        line: input.line,
        side: input.side,
        body: input.body,
        revision: current.revision,
        staged: input.staged === true,
      };
    thread.reviewComments = [...(thread.reviewComments ?? []), comment];
    this.store.flush();
    return comment;
  }
  removeComment(id: string, commentId: string) {
    const thread = this.store.thread(id);
    thread.reviewComments = thread.reviewComments?.filter((item) => item.id !== commentId);
    this.store.flush();
  }
  async branches(id: string) {
    const root = this.store.thread(id).cwd;
    return {
      current: (await git(root, ['branch', '--show-current'])).trim(),
      branches: (
        await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
      )
        .trim()
        .split('\n')
        .filter(Boolean),
      remotes: (await git(root, ['remote'])).trim().split('\n').filter(Boolean),
    };
  }
  async branch(id: string, name: string, base: string, existing: boolean) {
    const root = this.store.thread(id).cwd;
    if ((await git(root, ['status', '--porcelain', '--untracked-files=all'])).trim())
      throw new Error('Commit or preserve changes before switching branches.');
    await git(root, ['check-ref-format', '--branch', name]);
    if (existing) {
      await git(root, ['show-ref', '--verify', 'refs/heads/' + name]);
      await git(root, ['switch', '--', name]);
    } else {
      const commit = (
        await git(root, ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'])
      ).trim();
      await git(root, ['switch', '-c', name, commit]);
    }
    return this.branches(id);
  }
  async pushPreview(id: string, remote: string) {
    const root = this.store.thread(id).cwd,
      state = await this.branches(id);
    if (!state.remotes.includes(remote) || !state.current)
      throw new Error('Choose a configured remote and a local branch.');
    const urls = (await git(root, ['remote', 'get-url', '--push', '--all', remote]))
      .trim()
      .split('\n');
    if (urls.length !== 1) throw new Error('Review multiple push URLs with Git directly.');
    const preview = {
      remote,
      url: urls[0],
      branch: state.current,
      head: (await git(root, ['rev-parse', 'HEAD'])).trim(),
    };
    return { ...preview, revision: hash(preview) };
  }
  async push(id: string, remote: string, revision: string) {
    const preview = await this.pushPreview(id, remote);
    if (preview.revision !== revision)
      throw new Error('Branch or remote changed. Review the push again.');
    return git(this.store.thread(id).cwd, [
      'push',
      '--porcelain',
      '--set-upstream',
      '--',
      preview.remote,
      `HEAD:refs/heads/${preview.branch}`,
    ]);
  }
  private async github(id: string) {
    const root = this.store.thread(id).cwd;
    const origin = (await git(root, ['remote', 'get-url', 'origin'])).trim();
    const match =
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(origin);
    if (!match)
      throw new Error('Pull request integration currently supports an origin on github.com.');
    return { root, repository: match[1] + '/' + match[2] };
  }
  private async gh(cwd: string, args: string[]) {
    try {
      return (
        await exec('gh', args, {
          cwd,
          windowsHide: true,
          shell: false,
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          'Install GitHub CLI and run gh auth login in the terminal to use pull request integration.',
        );
      throw error;
    }
  }
  async prs(id: string) {
    const { root, repository } = await this.github(id);
    return JSON.parse(
      await this.gh(root, [
        'pr',
        'list',
        '--repo',
        repository,
        '--state',
        'open',
        '--json',
        'number,title,url,headRefName,baseRefName,isDraft',
      ]),
    );
  }
  async prPreview(id: string, input: Wire) {
    const { root, repository } = await this.github(id),
      branch = (await this.branches(id)).current;
    if (
      !branch ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 256 ||
      typeof input.body !== 'string' ||
      input.body.length > 20000 ||
      typeof input.base !== 'string' ||
      !input.base.trim()
    )
      throw new Error('Enter a PR title, description and base branch.');
    await git(root, ['check-ref-format', '--branch', input.base]);
    if (input.base === branch) throw new Error('Choose a different base branch.');
    const preview = {
      repository,
      head: branch,
      headCommit: (await git(root, ['rev-parse', 'HEAD'])).trim(),
      base: input.base,
      title: input.title,
      body: input.body,
    };
    return { ...preview, revision: hash(preview) };
  }
  async createPr(id: string, input: Wire) {
    const preview = await this.prPreview(id, input);
    if (preview.revision !== input.revision) throw new Error('PR changed. Review again.');
    const { root } = await this.github(id);
    // Explicit GUI publish action only. CLI credentials remain in gh, never renderer/state.
    const temporary = await mkdtemp(join(tmpdir(), 'grok-studio-pr-')),
      bodyPath = join(temporary, 'body.txt');
    try {
      await writeFile(bodyPath, preview.body, 'utf8');
      return (
        await this.gh(root, [
          'pr',
          'create',
          '--repo',
          preview.repository,
          '--draft',
          '--head',
          preview.head,
          '--base',
          preview.base,
          '--title',
          preview.title,
          '--body-file',
          bodyPath,
        ])
      ).trim();
    } finally {
      if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep))
        throw new Error('Unsafe PR temporary path.');
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
