import { readdir, stat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { directory, inside, futurePath } from './paths';
import { git } from './git-runner';
import type { FileItem, GitState } from '../shared/types';
import { changes, indexRevision } from './git-actions';
export { directory, inside } from './paths';
export { git } from './git-runner';
export async function files(root: string, path: string): Promise<FileItem[]> {
  const target = await inside(root, path);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => !['.git', 'node_modules', '.DS_Store'].includes(entry.name))
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .slice(0, 1000)
    .map((entry) => ({
      name: entry.name,
      path: relative(root, join(target, entry.name)),
      directory: entry.isDirectory(),
    }));
}
export async function textFile(root: string, path: string) {
  const target = await inside(root, path);
  const info = await stat(target);
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error('Preview supports text files up to 1 MiB.');
  const text = await readFile(target, 'utf8');
  if (text.includes('\0')) throw new Error('Binary files cannot be previewed as text.');
  return text;
}
export async function gitState(root: string, retry = true): Promise<GitState> {
  const before = await indexRevision(root);
  const [branch, status, diff, staged, worktrees] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--short', '--', '.']),
    git(root, ['diff', '--no-ext-diff', '--no-textconv', '--', '.']),
    git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.']),
    git(root, ['worktree', 'list']),
  ]);
  const files = await changes(root),
    after = await indexRevision(root);
  if (before !== after) {
    if (retry) return gitState(root, false);
    throw new Error('Git index changed during refresh; try again.');
  }
  return {
    branch: branch.trim() || '(detached HEAD)',
    status,
    diff,
    staged,
    worktrees,
    files,
    indexRevision: after,
  };
}
export async function createWorktree(
  root: string,
  target: string,
  branch: string,
  base = 'HEAD',
  existing = false,
) {
  if (!branch || branch.startsWith('-') || !/^[\w./-]+$/.test(branch))
    throw new Error('Enter a valid new Git branch name.');
  await git(root, ['check-ref-format', '--branch', branch]);
  // Git rejects existing nonempty targets and existing branches. No reset/removal fallback.
  const destination = await futurePath(target);
  const repo = await directory(root);
  const rel = relative(repo, destination);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)))
    throw new Error('Choose a worktree folder outside the current checkout.');
  const commit = (
    await git(repo, ['rev-parse', '--verify', '--end-of-options', base + '^{commit}'])
  ).trim();
  await git(
    repo,
    existing
      ? ['worktree', 'add', '--', destination, branch]
      : ['worktree', 'add', '-b', branch, '--', destination, commit],
  );
  return { path: await directory(destination), name: basename(destination) };
}
