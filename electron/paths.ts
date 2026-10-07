import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
