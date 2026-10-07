import { realpath, readFile, stat } from 'node:fs/promises';
import { relative, resolve, isAbsolute, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git-runner';
import { inside } from './paths';
import { openDocument } from './editor';
import type { GitChange } from '../shared/types';

const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
function contained(root: string, target: string) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function parseChanges(raw: string): Array<{
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  conflicted: boolean;
}> {
  const result = [],
    records = raw.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Unexpected Git status format.');
    const xy = record.slice(0, 2),
      path = record.slice(3);
    const originalPath = /[RC]/.test(xy) ? records[++index] : undefined;
    if (/[RC]/.test(xy) && !originalPath) throw new Error('Incomplete Git rename status.');
    result.push({
      path,
      originalPath,
      index: xy[0],
      worktree: xy[1],
      conflicted: conflicts.has(xy),
    });
  }
  return result;
}
export async function changes(root: string): Promise<GitChange[]> {
  const canonical = await realpath(root);
  const repo = (await git(canonical, ['rev-parse', '--show-toplevel'])).trim();
  const raw = await git(canonical, [
    '--literal-pathspecs',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--',
    '.',
  ]);
  return parseChanges(raw).map((item) => {
    const path = resolve(repo, item.path);
    if (!contained(canonical, path))
      throw new Error('Git reported a change outside this workspace.');
    return {
      ...item,
      path: relative(canonical, path),
      originalPath: item.originalPath
        ? relative(canonical, resolve(repo, item.originalPath))
        : undefined,
    };
  });
}
export async function indexRevision(root: string): Promise<string> {
  const path = resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
  try {
    if ((await stat(path)).size > 32 * 1024 * 1024)
      throw new Error('Git index exceeds the 32 MiB GUI limit.');
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}
async function literalPath(root: string, path: string) {
  const canonical = await realpath(root),
    target = resolve(canonical, path);
  if (
    !path ||
    path.includes('\0') ||
    !contained(canonical, target) ||
    target === canonical ||
    relative(canonical, target)
      .split(sep)
      .some((part) => part.toLowerCase() === '.git')
  )
    throw new Error('Choose a file inside this workspace.');
  // Deleted files still need their nearest existing parent checked for symlink escapes.
  let existing = target;
  while (true) {
    try {
      await inside(canonical, existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = dirname(existing);
    }
  }
  return relative(canonical, target);
}
async function expectIndex(root: string, expected: string) {
  if (typeof expected !== 'string' || (await indexRevision(root)) !== expected)
    throw new Error('Staged index changed. Refresh and review it again.');
}
export async function changeIndex(root: string, operation: string, path: string, expected: string) {
  if (!['stage', 'unstage'].includes(operation)) throw new Error('Unknown Git action.');
  const literal = await literalPath(root, path);
  const entry = (await changes(root)).find((item) => item.path === literal);
  if (!entry) throw new Error('This file is no longer changed; refresh the workspace.');
  await expectIndex(root, expected);
  if (operation === 'stage') return git(root, ['--literal-pathspecs', 'add', '--', literal]);
  const paths = [literal];
  if (entry.originalPath) paths.push(await literalPath(root, entry.originalPath));
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => undefined);
  if (head) return git(root, ['--literal-pathspecs', 'reset', '--quiet', 'HEAD', '--', ...paths]);
  return git(root, ['--literal-pathspecs', 'rm', '--cached', '--force', '--', ...paths]);
}
export async function fileDiff(root: string, path: string, staged: boolean) {
  const literal = await literalPath(root, path);
  const entry = (await changes(root)).find((item) => item.path === literal);
  if (!entry) throw new Error('File is no longer changed.');
  if (entry.index === '?' && !staged) {
    try {
      return (
        `Untracked text preview: ${literal}\n` +
        (await openDocument(root, literal)).text
          .split('\n')
          .map((line) => '+' + line)
          .join('\n')
      );
    } catch {
      return 'Untracked file; text preview unavailable. Stage it to inspect the Git diff.';
    }
  }
  return git(root, [
    '--literal-pathspecs',
    'diff',
    ...(staged ? ['--cached'] : []),
    '--no-ext-diff',
    '--no-textconv',
    '--',
    literal,
    ...(entry.originalPath ? [await literalPath(root, entry.originalPath)] : []),
  ]);
}
export async function commitIndex(root: string, message: string, expected: string) {
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > 10000 ||
    message.includes('\0')
  )
    throw new Error('Enter a commit message.');
  const canonical = await realpath(root),
    repo = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  const staged = (await git(root, ['diff', '--cached', '--no-renames', '--name-only', '-z']))
    .split('\0')
    .filter(Boolean);
  if (!staged.length) throw new Error('Stage changes before committing.');
  if (staged.some((path) => !contained(canonical, resolve(repo, path))))
    throw new Error(
      'Staged files include changes outside this workspace. Open the repository root to commit them.',
    );
  if ((await changes(root)).some((item) => item.conflicted))
    throw new Error('Resolve and stage merge conflicts before committing.');
  await expectIndex(root, expected);
  await git(root, ['commit', '-m', message.trim()]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}
