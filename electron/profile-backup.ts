import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, lstat, realpath, readdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative, sep, isAbsolute } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { nativeSessionLease } from './native-session-lease';
const byteLimit = 4 * 1024 ** 3,
  fileLimit = 20000;
const owned = (name: string) =>
  /^(state\.json(?:\.previous|\.corrupt-[a-f0-9-]+)?|history\.sqlite(?:-(?:wal|shm|journal))?|xai-api-key\.bin|grok|account|media-files|diagnostics)$/.test(
    name,
  );
const contains = (root: string, path: string) => {
  const r = relative(root, path);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
const safe = (name: string) =>
  !!name &&
  !isAbsolute(name) &&
  name
    .split(/[\\/]/)
    .every((part) => !!part && part !== '.' && part !== '..' && !/[\x00-\x1f:]/.test(part));
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
async function inventory(root: string) {
  const rows: { path: string; bytes: number; mtime: number }[] = [];
  let total = 0,
    visited = 0;
  async function visit(path: string, depth: number) {
    if (++visited > fileLimit || depth > 32)
      throw new Error('Profile backup exceeds its scan limit.');
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error('Linked profile files cannot be backed up for migration.');
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name), depth + 1);
    } else {
      if (!info.isFile() || info.nlink !== 1 || info.size > 512 * 1024 ** 2)
        throw new Error('Profile contains an unsupported file or a file larger than 512 MiB.');
      total += info.size;
      if (total > byteLimit) throw new Error('Profile backup exceeds 4 GiB.');
      rows.push({ path: relative(root, path), bytes: info.size, mtime: info.mtimeMs });
    }
  }
  for (const name of (await readdir(root)).filter(owned).sort()) await visit(join(root, name), 0);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifyProfileBackup(folder: string, manifestHash: string) {
  const base = await realpath(folder);
  if ((await lstat(folder)).isSymbolicLink()) throw new Error('Linked profile backup.');
  const manifestPath = join(base, 'manifest.json'),
    info = await lstat(manifestPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 8 * 1024 ** 2 ||
    (await digest(manifestPath)) !== manifestHash
  )
    throw new Error('Profile backup manifest failed verification.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.format !== 1 || !Array.isArray(manifest.files) || manifest.files.length > fileLimit)
    throw new Error('Unsupported profile backup manifest.');
  const names = new Set<string>();
  let total = 0;
  for (const row of manifest.files) {
    if (
      !safe(row.path) ||
      names.has(row.path) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw new Error('Invalid profile backup entry.');
    names.add(row.path);
    total += row.bytes;
    if (total > byteLimit) throw new Error('Oversized profile backup.');
    let ancestor = join(base, 'profile');
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Linked profile backup.');
    for (const component of row.path.split(/[\\/]/)) {
      ancestor = join(ancestor, component);
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Linked profile backup file.');
    }
    const path = join(base, 'profile', row.path),
      canonical = await realpath(path),
      stat = await lstat(path);
    if (
      !contains(join(base, 'profile'), canonical) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== row.bytes ||
      (await digest(path)) !== row.sha256
    )
      throw new Error('Profile backup file failed verification.');
  }
  return manifest;
}
export async function backupProfile(
  profile: string,
  nativeHome: string,
  updateRoot: string,
  metadata: unknown,
) {
  const root = await realpath(profile),
    native = await realpath(nativeHome);
  if (
    (await lstat(profile)).isSymbolicLink() ||
    !contains(join(root, 'grok'), native) ||
    native !== (await realpath(join(root, 'grok')))
  )
    throw new Error(
      'Migration requires this portable profile’s private Grok home. External GROK_HOME is not backed up automatically.',
    );
  await mkdir(updateRoot, { recursive: true });
  if ((await lstat(updateRoot)).isSymbolicLink()) throw new Error('Linked update folder.');
  const backupRoot = join(await realpath(updateRoot), 'profile-backups');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(backupRoot)).isSymbolicLink()) throw new Error('Linked backup folder.');
  // Never prune a backup automatically; require explicit local preservation/cleanup.
  if ((await readdir(backupRoot)).length >= 3)
    throw new Error(
      'Preserve or remove an old local profile backup before creating another (maximum three).',
    );
  const initial = await inventory(root),
    release = await nativeSessionLease(
      initial.filter((row) => row.path.endsWith('.lock')).map((row) => join(root, row.path)),
    );
  const folder = join(backupRoot, randomUUID()),
    dest = join(folder, 'profile');
  await mkdir(dest, { recursive: true, mode: 0o700 });
  try {
    const files = [];
    const databases = new Set<string>();
    for (const row of initial) {
      if (
        /(?:-wal|-shm|-journal)$/.test(row.path) &&
        databases.has(row.path.replace(/-(?:wal|shm|journal)$/, ''))
      )
        continue;
      const source = join(root, row.path),
        target = join(dest, row.path);
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      const handle = await open(source, 'r');
      let sqlite = false;
      try {
        const header = Buffer.alloc(16);
        await handle.read(header, 0, 16, 0);
        sqlite = header.toString() === 'SQLite format 3\0';
      } finally {
        await handle.close();
      }
      if (sqlite) {
        // SQLite's online backup includes committed WAL pages rather than copying a torn database.
        const db = new DatabaseSync(source, { readOnly: true });
        try {
          await backup(db, target);
        } finally {
          db.close();
        }
        databases.add(row.path);
      } else {
        const before = await lstat(source),
          input = await open(source, 'r'),
          output = await open(target, 'wx', 0o600);
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          for await (const chunk of input.readableWebStream() as any) {
            const part = Buffer.from(chunk);
            bytes += part.length;
            if (bytes > row.bytes) throw new Error('Profile changed during backup.');
            hash.update(part);
            await output.writeFile(part);
          }
          await output.sync();
        } finally {
          await input.close().catch(() => {});
          await output.close();
        }
        const after = await lstat(source);
        if (
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          after.nlink !== 1 ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          bytes !== row.bytes ||
          (await digest(source)) !== hash.digest('hex')
        )
          throw new Error(
            'Profile changed during backup. Partial copy retained; original profile unchanged.',
          );
      }
      const stat = await lstat(target);
      if (stat.size > 512 * 1024 ** 2) throw new Error('Backup database exceeds its file limit.');
      files.push({ path: row.path, bytes: stat.size, sha256: await digest(target), sqlite });
    }
    const final = await inventory(root);
    // Database contents may change during online backup; external clients must be stopped.
    if (JSON.stringify(initial) !== JSON.stringify(final))
      throw new Error(
        'Profile changed during backup. Stop other Grok clients and retry; partial copy preserved.',
      );
    await writeFile(
      join(folder, 'manifest.json'),
      JSON.stringify({ format: 1, createdAt: new Date().toISOString(), metadata, files }, null, 2) +
        '\n',
      { flag: 'wx', mode: 0o600 },
    );
    const manifestHash = await digest(join(folder, 'manifest.json'));
    await verifyProfileBackup(folder, manifestHash);
    return {
      folder,
      manifestHash,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  } finally {
    await release();
  }
}
