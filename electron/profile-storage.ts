import {
  readdir,
  lstat,
  realpath,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Thread } from '../shared/types';
import { nativeSessionLease } from './native-session-lease';
import { DatabaseSync } from 'node:sqlite';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
const validRelative = (path: unknown): path is string =>
  typeof path === 'string' &&
  !!path &&
  !isAbsolute(path) &&
  path
    .split(/[\\/]/)
    .every(
      (part) =>
        !!part &&
        part !== '.' &&
        part !== '..' &&
        !/[\x00-\x1f:]/.test(part) &&
        !/[. ]$/.test(part),
    );
type FileRow = { path: string; bytes: number; modified: number };
async function inventory(root: string, retention = false): Promise<FileRow[]> {
  const rows: FileRow[] = [];
  let visited = 0;
  async function visit(path: string, depth: number) {
    if (++visited > 100000 || depth > 32)
      throw new Error('Profile inventory exceeds its scan limit.');
    const info = await lstat(path).catch((e) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    if (!info) return;
    if (info.isSymbolicLink())
      throw new Error('Profile contains a linked folder/file; review it before managing storage.');
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name), depth + 1);
    } else if (info.isFile()) {
      if (retention && info.nlink !== 1)
        throw new Error('Hard-linked session files are not managed.');
      rows.push({ path: relative(root, path), bytes: info.size, modified: info.mtimeMs });
    }
  }
  await visit(root, 0);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function profileBudget(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 256 || Number(value) > 1048576)
    throw new Error('Aggregate profile budget must be 256–1048576 MiB.');
  return Number(value);
}

/** Counts selected profile files; never follows links or reads credentials. */
export class ProfileStorage {
  private scans?: Promise<{ bytes: number; files: number; categories: Record<string, number> }>;
  private reviews = new Map<
    string,
    {
      revision: string;
      days: number;
      candidates: Array<{
        sessionId: string;
        group: string;
        path: string;
        files: FileRow[];
        threadIds: string[];
      }>;
    }
  >();
  constructor(
    readonly desktop: string,
    readonly home: string,
    private threads: () => Thread[],
  ) {}
  async scan() {
    if (this.scans) return this.scans;
    this.scans = (async () => {
      const desktop = await realpath(this.desktop);
      const home = await realpath(this.home).catch((e) => {
        if (e.code === 'ENOENT') return resolve(this.home);
        throw e;
      });
      const roots = [...new Set([desktop, home])].filter(
        (root, _, all) => !all.some((other) => other !== root && inside(other, root)),
      );
      const categories: Record<string, number> = {};
      let bytes = 0,
        files = 0;
      for (const root of roots)
        for (const row of await inventory(root)) {
          const path = join(root, row.path);
          const native = inside(home, path);
          const name = relative(native ? home : desktop, path).split(sep)[0];
          const category = native
            ? name === 'sessions'
              ? 'nativeSessions'
              : name === 'logs' || name === 'memtrace'
                ? 'nativeLogs'
                : 'nativeOther'
            : name.startsWith('history.sqlite')
              ? 'desktopHistory'
              : name === 'media-files'
                ? 'media'
                : name === 'diagnostics'
                  ? 'diagnostics'
                  : name === 'updates'
                    ? 'updates'
                    : 'desktopOther';
          categories[category] = (categories[category] ?? 0) + row.bytes;
          bytes += row.bytes;
          files++;
        }
      return { bytes, files, categories };
    })();
    try {
      return await this.scans;
    } finally {
      this.scans = undefined;
    }
  }
  async assertCapacity(mib: number) {
    const report = await this.scan();
    if (report.bytes >= profileBudget(mib) * 1024 * 1024 * 0.9)
      throw new Error(
        'The aggregate profile is near its quota. Export/prune archived native sessions, remove unneeded media or increase the budget before starting more work.',
      );
  }
  private async eligible(sessionId: string, days: number) {
    if (!uuid.test(sessionId)) throw new Error('Invalid native session identifier.');
    const owners = this.threads().filter((t) => t.sessionId === sessionId);
    if (
      !owners.length ||
      owners.some((t) => !t.archived || ['running', 'approval', 'connecting'].includes(t.status))
    )
      throw new Error(
        'Only native sessions referenced exclusively by idle archived desktop chats can be pruned.',
      );
    const root = await realpath(join(this.home, 'sessions'));
    if ((await lstat(join(this.home, 'sessions'))).isSymbolicLink())
      throw new Error('Linked native sessions are not managed.');
    const found: Array<{ group: string; path: string }> = [];
    for (const group of await readdir(root, { withFileTypes: true })) {
      if (!group.isDirectory() || group.isSymbolicLink()) continue;
      const path = join(root, group.name, sessionId);
      if (!(await lstat(path).catch(() => undefined))) continue;
      if (!samePath(await realpath(path), path) || !inside(root, path))
        throw new Error('Linked native sessions are not managed.');
      if (!(await lstat(join(path, 'summary.json'))).isFile())
        throw new Error('Native session has no summary.');
      found.push({ group: group.name, path });
    }
    if (found.length !== 1) throw new Error('Native session location is missing or ambiguous.');
    const files = await inventory(found[0].path, true);
    if (!files.length || files.some((f) => f.modified > Date.now() - days * 86400000))
      throw new Error('Native session is newer than the selected retention age.');
    return { sessionId, ...found[0], files, threadIds: owners.map((t) => t.id).sort() };
  }
  async preview(ids: string[], days: number) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 3650
    )
      throw new Error(
        'Choose up to 100 distinct archived sessions and a retention age of 1–3650 days.',
      );
    const candidates = [];
    for (const id of ids) candidates.push(await this.eligible(id, days));
    if (candidates.reduce((n, c) => n + c.files.length, 0) > 100000)
      throw new Error('Retention batch exceeds 100000 files. Select fewer sessions.');
    const review = { revision: fingerprint({ days, candidates }), days, candidates };
    this.reviews.clear();
    this.reviews.set(review.revision, review);
    return {
      revision: review.revision,
      days,
      sessions: candidates.map((c) => ({
        sessionId: c.sessionId,
        files: c.files.length,
        bytes: c.files.reduce((n, f) => n + f.bytes, 0),
      })),
    };
  }
  async exportPrune(revision: string, destination: string) {
    const review = this.reviews.get(revision);
    if (!review) throw new Error('Inspect native retention again before exporting/pruning.');
    const release = await nativeSessionLease(
      review.candidates.flatMap((c) =>
        c.files.filter((f) => f.path.endsWith('.lock')).map((f) => join(c.path, f.path)),
      ),
    );
    try {
      return await this.exportAndPrune(revision, destination, release);
    } finally {
      await release();
    }
  }
  private async exportAndPrune(
    revision: string,
    destination: string,
    release: () => Promise<void>,
  ) {
    const review = this.reviews.get(revision);
    if (!review) throw new Error('Inspect native retention again before exporting/pruning.');
    const fresh = [];
    for (const c of review.candidates) fresh.push(await this.eligible(c.sessionId, review.days));
    if (fingerprint({ days: review.days, candidates: fresh }) !== revision)
      throw new Error('Native sessions changed. Review retention again.');
    const backupParent = await realpath(destination);
    for (const root of [this.desktop, this.home]) {
      const canonical = await realpath(root);
      if (inside(canonical, backupParent) || inside(backupParent, canonical))
        throw new Error('Choose an export folder outside the selected profiles.');
    }
    const backup = join(backupParent, 'Grok-session-export-' + randomUUID());
    await mkdir(backup, { mode: 0o700 });
    const sessions = [];
    for (const c of fresh) {
      const files = [];
      for (const f of c.files) {
        const target = join(backup, c.sessionId, f.path);
        await mkdir(resolve(target, '..'), { recursive: true });
        await copyFile(join(c.path, f.path), target);
        const sha256 = await digest(target);
        if (sha256 !== (await digest(join(c.path, f.path))))
          throw new Error('Session changed during export. Original retained.');
        files.push({ path: f.path, sha256 });
      }
      sessions.push({ sessionId: c.sessionId, group: c.group, files });
    }
    await writeFile(
      join(backup, 'workbench-export.json'),
      JSON.stringify({ version: 1, sessions }, null, 2),
      { mode: 0o600 },
    );
    // Revalidate the complete batch before touching any original session.
    const final = [];
    for (const c of fresh) final.push(await this.eligible(c.sessionId, review.days));
    if (fingerprint({ days: review.days, candidates: final }) !== revision)
      throw new Error('Sessions changed during export. Originals retained.');
    await this.evictSearchCache(fresh.map((c) => c.sessionId));
    // Windows refuses directory rename while child file handles are open, including our lease.
    // Release after verified export. A competing native open prevents rename; after rename,
    // native clients use the original path, never the uniquely named quarantine.
    await release();
    for (const c of fresh) {
      const quarantine = join(resolve(c.path, '..'), '.workbench-retention-' + randomUUID());
      if (!inside(await realpath(join(this.home, 'sessions')), quarantine))
        throw new Error('Unsafe retention target.');
      await rename(c.path, quarantine);
      try {
        if (fingerprint(await inventory(quarantine, true)) !== fingerprint(c.files))
          throw new Error('Session changed before cleanup.');
        const exported = sessions.find((s) => s.sessionId === c.sessionId)!;
        for (const f of exported.files) {
          if (
            (await digest(join(quarantine, f.path))) !== f.sha256 ||
            (await digest(join(backup, c.sessionId, f.path))) !== f.sha256
          )
            throw new Error('Session/export content changed before cleanup. Original retained.');
        }
        // Recursive removal is restricted to this verified, renamed session directory.
        if ((await lstat(quarantine)).isSymbolicLink()) throw new Error('Unsafe retention target.');
        await rm(quarantine, { recursive: true });
      } catch (error) {
        await rename(quarantine, c.path).catch(() => {});
        throw error;
      }
    }
    this.reviews.clear();
    return { backup, pruned: fresh.map((c) => c.sessionId) };
  }
  private async evictSearchCache(ids: string[]) {
    const path = join(this.home, 'sessions', 'session_search.sqlite'),
      info = await lstat(path).catch((e) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      });
    if (!info) return;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('Linked native search caches are not managed. Originals retained.');
    const cache = new DatabaseSync(path);
    try {
      cache.exec('PRAGMA busy_timeout=1500');
      if (
        cache.prepare("SELECT value FROM meta WHERE key='session_search_schema_version'").get()
          ?.value !== '4'
      )
        throw new Error('Native search cache format is unsupported. Originals retained.');
      // This is the pinned upstream cache schema. Its DELETE trigger maintains FTS.
      cache.exec('BEGIN IMMEDIATE');
      try {
        const remove = cache.prepare('DELETE FROM session_docs WHERE session_id=?');
        for (const id of ids) remove.run(id);
        cache.exec('COMMIT');
      } catch (e) {
        cache.exec('ROLLBACK');
        throw e;
      }
      // Reclaim this rebuildable cache's freed pages before pruning original directories.
      // If directory pruning is blocked later, native resume can reindex the retained session.
      cache.exec('VACUUM');
    } finally {
      cache.close();
    }
  }
  async restore(exportFolder: string) {
    const backup = await realpath(exportFolder);
    const manifestPath = join(backup, 'workbench-export.json');
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024)
      throw new Error('Export manifest exceeds its size/type limit.');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.sessions) ||
      !manifest.sessions.length ||
      manifest.sessions.length > 100 ||
      new Set(manifest.sessions.map((c: any) => c.sessionId)).size !== manifest.sessions.length
    )
      throw new Error('Invalid native session export.');
    // Preflight the entire export before restoring any session; refuse linked/hard-linked files.
    await inventory(backup, true);
    const root = await realpath(join(this.home, 'sessions'));
    if ((await lstat(join(this.home, 'sessions'))).isSymbolicLink())
      throw new Error('Linked native sessions are not managed.');
    const restored: string[] = [];
    let count = 0;
    for (const c of manifest.sessions) {
      const owners = this.threads().filter((t) => t.sessionId === c.sessionId);
      if (
        !uuid.test(c.sessionId) ||
        !validRelative(c.group) ||
        /[\\/]/.test(c.group) ||
        !Array.isArray(c.files) ||
        !owners.length ||
        owners.some((t) => !t.archived || ['running', 'approval', 'connecting'].includes(t.status))
      )
        throw new Error('Export does not match exclusively idle archived desktop sessions.');
      count += c.files.length;
      if (
        count > 100000 ||
        new Set(
          c.files.map((f: any) =>
            typeof f.path === 'string' ? f.path.replaceAll('\\', '/').toLowerCase() : '',
          ),
        ).size !== c.files.length
      )
        throw new Error('Export has duplicate paths or exceeds its file limit.');
      const parent = join(root, c.group);
      const canonical = await realpath(parent).catch((e) => {
        if (e.code === 'ENOENT') return parent;
        throw e;
      });
      if (
        !samePath(canonical, parent) ||
        !inside(root, parent) ||
        (await lstat(parent).catch(() => undefined))?.isSymbolicLink()
      )
        throw new Error('Unsafe session restore folder.');
      const target = join(parent, c.sessionId);
      if (await lstat(target).catch(() => undefined))
        throw new Error('Session already exists. No restore files were overwritten.');
      if (!c.files.some((f: any) => f.path === 'summary.json'))
        throw new Error('Export contains no session summary.');
      for (const f of c.files) {
        if (
          !validRelative(f.path) ||
          typeof f.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(f.sha256)
        )
          throw new Error('Invalid export file path/hash.');
        const source = join(backup, c.sessionId, f.path);
        if (
          !inside(join(backup, c.sessionId), await realpath(source)) ||
          !(await lstat(source)).isFile() ||
          (await digest(source)) !== f.sha256
        )
          throw new Error('Export file failed verification.');
      }
    }
    for (const c of manifest.sessions) {
      const parent = join(root, c.group);
      await mkdir(parent, { recursive: true });
      if (!samePath(await realpath(parent), parent) || (await lstat(parent)).isSymbolicLink())
        throw new Error('Unsafe session restore folder.');
      const target = join(parent, c.sessionId);
      const staging = join(parent, '.workbench-restore-' + randomUUID());
      await mkdir(staging);
      for (const f of c.files) {
        const source = join(backup, c.sessionId, f.path);
        const output = join(staging, f.path);
        await mkdir(resolve(output, '..'), { recursive: true });
        await copyFile(source, output);
        if ((await digest(output)) !== f.sha256)
          throw new Error('Export changed while restoring. Verified originals are retained.');
      }
      if (!(await lstat(join(staging, 'summary.json'))).isFile())
        throw new Error('Export contains no session summary.');
      if (await lstat(target).catch(() => undefined))
        throw new Error('Session appeared while restoring. No files were overwritten.');
      await rename(staging, target);
      restored.push(c.sessionId);
    }
    return { restored };
  }
}
