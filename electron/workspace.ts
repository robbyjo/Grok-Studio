import { realpath, readdir, stat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FileItem, GitState } from '../shared/types';
const execute = promisify(execFile);
export async function directory(path: string) {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a folder.');
  return root;
}
export async function inside(root: string, path = '.') {
  const canonicalRoot = await realpath(root);
  const target = await realpath(resolve(canonicalRoot, path));
  const rel = relative(canonicalRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Path leaves this workspace.');
  return target;
}
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
export async function git(root: string, args: string[]) {
  const { stdout } = await execute('git', ['--no-pager', ...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
export async function gitState(root: string): Promise<GitState> {
  const [branch, status, diff, staged, worktrees] = await Promise.all([
    git(root, ['branch', '--show-current']),
    git(root, ['status', '--short']),
    git(root, ['diff', '--no-ext-diff', '--no-textconv']),
    git(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv']),
    git(root, ['worktree', 'list']),
  ]);
  return { branch: branch.trim() || '(detached HEAD)', status, diff, staged, worktrees };
}
export async function createWorktree(root: string, target: string, branch: string) {
  if (!branch || branch.startsWith('-') || !/^[\w./-]+$/.test(branch))
    throw new Error('Enter a valid new Git branch name.');
  await git(root, ['check-ref-format', '--branch', branch]);
  // Git rejects existing nonempty targets and existing branches. No reset/removal fallback.
  const destination = resolve(target);
  const repo = await directory(root);
  const rel = relative(repo, destination);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)))
    throw new Error('Choose a worktree folder outside the current checkout.');
  await git(repo, ['worktree', 'add', '-b', branch, '--', destination, 'HEAD']);
  return { path: await directory(destination), name: basename(destination) };
}
