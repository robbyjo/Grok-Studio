import { realpath, mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { git, gitInput } from './git-runner';
import { directory, futurePath } from './paths';
import { Store } from './store';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const pathKey = (path: string) => {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
export async function common(root: string) {
  return realpath(resolve(root, (await git(root, ['rev-parse', '--git-common-dir'])).trim()));
}
export async function worktreeList(root: string) {
  const output = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  const rows: any[] = [];
  let row: any;
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      row = { path: field.slice(9) };
      rows.push(row);
    } else if (field.startsWith('branch ')) row.branch = field.slice(7);
    else if (field.startsWith('HEAD ')) row.head = field.slice(5);
  }
  return rows;
}
async function snapshot(root: string) {
  const temp = await mkdtemp(join(tmpdir(), 'grok-studio-index-'));
  const env = {
    GIT_INDEX_FILE: join(temp, 'index'),
    GIT_AUTHOR_NAME: 'Grok Studio recovery',
    GIT_AUTHOR_EMAIL: 'recovery@example.invalid',
    GIT_COMMITTER_NAME: 'Grok Studio recovery',
    GIT_COMMITTER_EMAIL: 'recovery@example.invalid',
  };
  try {
    await gitInput(root, ['read-tree', 'HEAD'], '', env);
    await gitInput(root, ['add', '-A', '--', '.'], '', env);
    const tree = (await gitInput(root, ['write-tree'], '', env)).trim();
    return (
      await gitInput(
        root,
        ['commit-tree', tree, '-p', 'HEAD'],
        'Grok Studio recoverable workspace snapshot\n',
        env,
      )
    ).trim();
  } finally {
    if (!resolve(temp).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Invalid temporary index path.');
    await rm(temp, { recursive: true, force: true });
  }
}
export class Worktrees {
  constructor(private store: Store) {}
  async list(id: string) {
    const thread = this.store.thread(id),
      repo = await common(thread.cwd);
    return {
      rows: await worktreeList(thread.cwd),
      archives: (this.store.state.worktrees ?? []).filter(
        (item) => pathKey(item.repo) === pathKey(repo) && item.archived,
      ),
      branches: (
        await git(thread.cwd, [
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads',
          'refs/remotes',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean),
    };
  }
  async selected(id: string, path: string) {
    const thread = this.store.thread(id),
      rows = await worktreeList(thread.cwd);
    const target = await directory(path);
    if (
      !rows.some((row) => pathKey(row.path) === pathKey(target)) ||
      pathKey(await common(target)) !== pathKey(await common(thread.cwd))
    )
      throw new Error('Choose an attached worktree from this repository.');
    return target;
  }
  async own(id: string, path: string) {
    const repo = await common(this.store.thread(id).cwd);
    const record = { id: randomUUID(), repo, path: await directory(path), archived: false };
    this.store.state.worktrees = [...(this.store.state.worktrees ?? []), record];
    this.store.flush();
  }
  async previewApply(id: string, targetPath: string) {
    const source = this.store.thread(id).cwd,
      target = await this.selected(id, targetPath);
    if (pathKey(source) === pathKey(target)) throw new Error('Choose another worktree.');
    if ((await git(target, ['status', '--porcelain', '--untracked-files=all'])).trim())
      throw new Error('The target worktree must be clean before applying changes.');
    const base = (
      await git(source, ['merge-base', 'HEAD', (await git(target, ['rev-parse', 'HEAD'])).trim()])
    ).trim();
    const commit = await snapshot(source);
    const patch = await git(source, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      base,
      commit,
    ]);
    if (!patch) throw new Error('No changes to apply.');
    if (/(?:old|new) mode 120000|(?:new|deleted) file mode 120000/.test(patch))
      throw new Error('Apply does not support symlink changes. Review these with Git.');
    const files = (await git(source, ['diff', '--name-only', '-z', base, commit]))
      .split('\0')
      .filter(Boolean);
    for (const path of files) {
      const absolute = await futurePath(resolve(target, path));
      const rel = relative(target, absolute);
      if (
        !rel ||
        rel === '..' ||
        rel.startsWith('..' + sep) ||
        isAbsolute(rel) ||
        rel.split(sep).some((part) => part.toLowerCase() === '.git')
      )
        throw new Error('Apply path is outside the target workspace.');
    }
    return {
      target,
      patch,
      files,
      revision: hash(patch + '\n' + (await git(target, ['rev-parse', 'HEAD'])).trim()),
    };
  }
  async apply(id: string, target: string, revision: string) {
    const preview = await this.previewApply(id, target);
    if (preview.revision !== revision)
      throw new Error('Changes changed since review. Review again.');
    await gitInput(preview.target, ['apply', '--check', '--index', '-'], preview.patch);
    await gitInput(preview.target, ['apply', '--index', '-'], preview.patch);
    return { applied: true, files: preview.files };
  }
  async archive(id: string) {
    const thread = this.store.thread(id),
      cwd = await directory(thread.cwd),
      record = this.store.state.worktrees?.find(
        (item) => !item.archived && pathKey(item.path) === pathKey(cwd),
      );
    if (!record) throw new Error('Only worktrees created by this desktop profile can be archived.');
    const rows = await worktreeList(thread.cwd);
    if (pathKey(await directory(rows[0].path)) === pathKey(cwd))
      throw new Error('The primary checkout cannot be archived.');
    if (/^160000 /m.test(await git(thread.cwd, ['ls-files', '--stage'])))
      throw new Error(
        'Preserve submodules separately; worktrees containing submodules cannot be archived.',
      );
    async function checkNested(path: string, root = false): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.name.toLowerCase() === '.git') {
          if (!root)
            throw new Error('Preserve embedded Git repositories separately before archiving.');
          continue;
        }
        const target = join(path, entry.name);
        if (entry.isDirectory() && !(await lstat(target)).isSymbolicLink())
          await checkNested(target);
      }
    }
    await checkNested(thread.cwd, true);
    const ignored = (
      await git(thread.cwd, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
    )
      .split('\0')
      .filter(Boolean);
    if (ignored.length)
      throw new Error(
        `Preserve ignored files before archiving: ${ignored.slice(0, 8).join(', ')}${ignored.length > 8 ? '…' : ''}`,
      );
    const primary = rows[0].path;
    const ref = 'refs/grok-studio/archive/' + record.id;
    const commit = await snapshot(thread.cwd);
    await git(thread.cwd, ['update-ref', ref, commit]);
    record.ref = ref;
    this.store.flush();
    await git(primary, ['worktree', 'remove', '--force', '--', record.path]);
    record.archived = true;
    for (const item of this.store.state.threads.filter(
      (item) => item.id === id || pathKey(item.cwd) === pathKey(record.path),
    ))
      item.archived = true;
    this.store.flush();
    const primaryPath = await directory(primary);
    const returnThread =
      this.store.state.threads.find(
        (item) => !item.archived && pathKey(item.cwd) === pathKey(primaryPath),
      ) ?? this.store.create(thread.projectId, primaryPath);
    return { ref, commit, path: record.path, returnThreadId: returnThread.id };
  }
  async restore(id: string, archiveId: string) {
    const thread = this.store.thread(id),
      record = this.store.state.worktrees?.find((item) => item.id === archiveId && item.archived);
    if (!record || pathKey(record.repo) !== pathKey(await common(thread.cwd)) || !record.ref)
      throw new Error('Choose an archive from this repository.');
    const path = await futurePath(record.path);
    if (pathKey(path) !== pathKey(record.path))
      throw new Error('The original archive path now resolves elsewhere.');
    await git(thread.cwd, ['worktree', 'add', '--detach', '--', path, record.ref]);
    record.archived = false;
    this.store.flush();
    return this.store.create(thread.projectId, await directory(path));
  }
}
