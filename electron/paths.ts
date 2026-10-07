import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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

// Resolve aliases/junctions in an existing ancestor of a not-yet-created path.
export async function futurePath(path: string): Promise<string> {
  let ancestor = resolve(path);
  const tail: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function insideFuture(root: string, path: string) {
  const canonicalRoot = await realpath(root),
    target = await futurePath(resolve(canonicalRoot, path));
  const rel = relative(canonicalRoot, target);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('..' + sep) ||
    isAbsolute(rel) ||
    rel.split(sep).some((part) => part.toLowerCase() === '.git')
  )
    throw new Error('Path leaves this workspace or enters Git metadata.');
  return target;
}
