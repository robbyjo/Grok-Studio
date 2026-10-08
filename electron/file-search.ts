import { opendir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { directory, inside } from './paths';

export interface SearchHit {
  path: string;
  line?: number;
  column?: number;
  text?: string;
}
const excluded = new Set([
  '.git',
  'node_modules',
  '.runtime',
  '.test-data',
  '.grok',
  '.claude',
  '.cursor',
  'grok-studio-data',
  'grok-workbench-data',
  'grok desktop data',
  '.ssh',
  '.aws',
  '.azure',
  '.codex',
]);
/** Literal, bounded search. Never follows directory links or reads hard-linked files. */
export async function searchFiles(
  root: string,
  query: string,
  contents: boolean,
  offset = 0,
  signal?: AbortSignal,
) {
  if (
    !query.trim() ||
    query.length > 256 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000
  )
    throw new Error('Enter a search of 1–256 characters and a valid result page.');
  const canonical = await directory(root),
    needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  let scanned = 0,
    bytes = 0,
    limited = false;
  async function visit(folder: string, depth: number): Promise<void> {
    if (depth > 16) {
      limited = true;
      return;
    }
    const entries = [];
    const dir = await opendir(join(canonical, folder));
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (++scanned > 10000) {
        limited = true;
        break;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (hits.length > offset + 100 || scanned > 10000 || bytes >= 32 * 1024 * 1024) {
        limited = true;
        return;
      }
      if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase())) continue;
      const path = folder ? folder + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!contents) {
        if (path.toLowerCase().includes(needle)) hits.push({ path });
        continue;
      }
      // Credential files remain outside the automatic content scan.
      if (/^(\.env(?:\..*)?|auth\.json|mcp_credentials\.json)$/i.test(entry.name)) continue;
      let handle;
      try {
        handle = await open(await inside(canonical, path), 'r');
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) continue;
        const buffer = Buffer.alloc(Math.min(1024 * 1024 + 1, info.size + 1));
        const read = await handle.read(buffer, 0, buffer.length, 0);
        bytes += read.bytesRead;
        if (read.bytesRead > 1024 * 1024 || buffer.subarray(0, read.bytesRead).includes(0))
          continue;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, read.bytesRead),
        );
        let line = 0;
        for (const value of text.split(/\r?\n/)) {
          const column = value.toLowerCase().indexOf(needle);
          if (column >= 0)
            hits.push({
              path,
              line: line + 1,
              column: column + 1,
              text: value.slice(Math.max(0, column - 80), column + 160),
            });
          line++;
          if (hits.length > offset + 100) return;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // Unreadable/binary files are excluded; one file cannot stop the workspace scan.
      } finally {
        await handle?.close();
      }
    }
  }
  await visit('', 0);
  return {
    hits: hits.slice(offset, offset + 100),
    next: hits.length > offset + 100 ? offset + 100 : null,
    limited,
    scanned,
    bytes,
  };
}
