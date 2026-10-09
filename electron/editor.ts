import {
  readFile,
  stat,
  open,
  rename,
  unlink,
  chmod,
  realpath,
  copyFile,
  mkdir,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, sep, posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inside, insideFuture } from './paths';
import type { TextDocument } from '../shared/types';

const limit = 1024 * 1024;
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const saving = new Set<string>();
export async function createDocument(root: string, path: string, folder = false) {
  const target = await insideFuture(root, path);
  // Parent must already exist; never create an unreviewed tree of directories.
  await inside(root, dirname(target));
  if (folder) await mkdir(target);
  else {
    const file = await open(target, 'wx', 0o600);
    await file.close();
  }
  return {
    path: relative(await realpath(root), target)
      .split(sep)
      .join('/'),
    folder,
  };
}
export async function renameDocument(
  root: string,
  path: string,
  destination: string,
  expected: string,
) {
  const document = await openDocument(root, path);
  if (document.revision !== expected) throw new Error('File changed; reopen it before renaming.');
  const { target } = await editable(root, path),
    next = await insideFuture(root, destination);
  await inside(root, dirname(next));
  if (next.toLowerCase() === target.toLowerCase()) throw new Error('Choose a different filename.');
  await copyFile(target, next, constants.COPYFILE_EXCL);
  if (
    (await openDocument(root, path)).revision !== expected ||
    (await openDocument(root, destination)).revision !== expected
  )
    throw new Error('File changed while renaming. Both copies were kept for review.');
  await unlink(target);
  return {
    path: relative(await realpath(root), next)
      .split(sep)
      .join('/'),
  };
}
export async function languageContext(root: string, path: string, text: string) {
  await editable(root, path);
  if (!/\.(?:[mc]?[tj]sx?|json)$/i.test(path)) return [];
  const rows: { path: string; text: string }[] = [],
    seen = new Set<string>([path.replaceAll('\\', '/')]);
  let bytes = 0,
    attempts = 0;
  const queue = [{ path: path.replaceAll('\\', '/'), text: text.slice(0, 200000) }];
  while (queue.length && rows.length < 24 && bytes < limit) {
    const source = queue.shift()!;
    const imports = source.text.matchAll(
      /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"](\.[^'"\r\n]{1,256})['"]/g,
    );
    for (const match of imports) {
      const base = posix.normalize(posix.join(posix.dirname(source.path), match[1]));
      const candidates = /\.(?:[mc]?[tj]sx?|json)$/i.test(base)
        ? [base]
        : [
            base + '.ts',
            base + '.tsx',
            base + '.js',
            base + '.jsx',
            base + '.json',
            base + '/index.ts',
            base + '/index.js',
          ];
      for (const candidate of candidates) {
        if (seen.has(candidate) || rows.length >= 24) continue;
        if (++attempts > 256) return rows;
        try {
          const doc = await openDocument(root, candidate);
          const size = Buffer.byteLength(doc.text);
          if (bytes + size > limit) continue;
          seen.add(candidate);
          bytes += size;
          rows.push({ path: candidate, text: doc.text });
          queue.push({ path: candidate, text: doc.text });
          break;
        } catch {
          /* Missing, binary, linked and escaping imports are never loaded. */
        }
      }
    }
  }
  return rows;
}
async function editable(root: string, path: string) {
  const canonicalRoot = await realpath(root);
  const target = await inside(canonicalRoot, path);
  if (
    relative(canonicalRoot, target)
      .split(sep)
      .some((part) => part.toLowerCase() === '.git')
  )
    throw new Error('Git metadata cannot be edited here.');
  const info = await stat(target);
  if (!info.isFile() || info.size > limit)
    throw new Error('Edit supports existing UTF-8 text files up to 1 MiB.');
  if (info.nlink > 1) throw new Error('Hard-linked files cannot be edited here.');
  return { target, info, root: canonicalRoot };
}
function decode(bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary files cannot be edited as text.');
  return text;
}
export async function openDocument(root: string, path: string): Promise<TextDocument> {
  const { target } = await editable(root, path);
  const bytes = await readFile(target);
  if (bytes.length > limit) throw new Error('File grew beyond 1 MiB.');
  return { text: decode(bytes), revision: revision(bytes) };
}
export async function saveDocument(
  root: string,
  path: string,
  text: string,
  expected: string,
): Promise<TextDocument> {
  if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > limit)
    throw new Error('Save supports UTF-8 text up to 1 MiB.');
  if (Buffer.from(text, 'utf8').toString('utf8') !== text)
    throw new Error('Draft contains invalid Unicode. Correct it before saving.');
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Reopen the file before saving.');
  const { target, info, root: canonicalRoot } = await editable(root, path);
  if (!(info.mode & 0o222)) throw new Error('This file is read-only.');
  if (saving.has(target)) throw new Error('This file is already being saved.');
  saving.add(target);
  const temporary = join(dirname(target), `.grok-studio-${randomUUID()}.tmp`);
  try {
    const original = await readFile(target);
    decode(original);
    if (revision(original) !== expected)
      throw new Error('File changed on disk. Your draft was kept; reload the file before saving.');
    const handle = await open(temporary, 'wx', info.mode & 0o777);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, info.mode & 0o777);
    const current = await editable(canonicalRoot, path);
    if (
      current.target !== target ||
      (await inside(canonicalRoot, temporary)) !== temporary ||
      revision(await readFile(target)) !== expected
    )
      throw new Error('File changed on disk. Your draft was kept; reload the file before saving.');
    await rename(temporary, target);
    return { text, revision: revision(Buffer.from(text, 'utf8')) };
  } finally {
    saving.delete(target);
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
