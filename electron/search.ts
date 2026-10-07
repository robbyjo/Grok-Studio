import { setImmediate } from 'node:timers/promises';
import type { Entry, SearchHit, SearchResults, State } from '../shared/types';

export function entryText(entry: Entry): string {
  const data =
    entry.type === 'tool'
      ? {
          input: entry.data?.rawInput,
          output: entry.data?.rawOutput,
          content: entry.data?.content,
          locations: entry.data?.locations,
        }
      : entry.type === 'plan' || entry.type === 'notice'
        ? entry.data
        : undefined;
  return entry.text + (data ? '\n' + JSON.stringify(data, null, 2) : '');
}

// Search only saved transcript content and chat metadata; never session/config/credentials.
export async function searchTranscripts(
  state: State,
  query: string,
  options: { archived: boolean; hidden: boolean },
  cancelled: () => boolean = () => false,
): Promise<SearchResults> {
  if (typeof query !== 'string' || query.length > 512 || query.includes('\0'))
    throw new Error('Search text must be at most 512 characters.');
  const hits: SearchHit[] = [];
  if (!query.trim()) return { hits, truncated: false };
  const pattern = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const projects = new Map(state.projects.map((project) => [project.id, project]));
  const threads = [...state.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  let scanned = 0;
  let bytes = 0;
  for (const thread of threads) {
    const project = projects.get(thread.projectId);
    if ((!options.archived && thread.archived) || (!options.hidden && project?.hidden)) continue;
    // Copy entries to keep each chat's search iteration bounded while streaming appends.
    const entries: (Entry | undefined)[] = [undefined, ...thread.entries];
    for (const entry of entries) {
      if (cancelled()) return { hits: [], truncated: false };
      const text = entry
        ? entryText(entry)
        : `${thread.title}\n${project?.name ?? ''}\n${thread.cwd}`;
      const match = pattern.exec(text);
      if (match) {
        if (hits.length === 100) return { hits, truncated: true };
        const start = Math.max(0, match.index - 70);
        const end = Math.min(text.length, match.index + match[0].length + 100);
        hits.push({
          threadId: thread.id,
          entryId: entry?.id,
          title: thread.title,
          projectName: project?.name ?? 'Unknown project',
          archived: thread.archived,
          hidden: Boolean(project?.hidden),
          kind: entry?.type ?? 'chat',
          before: (start ? '…' : '') + text.slice(start, match.index),
          match: match[0],
          after: text.slice(match.index + match[0].length, end) + (end < text.length ? '…' : ''),
        });
      }
      bytes += text.length;
      // Let IPC, cancellation and native close requests run during long searches.
      if (++scanned % 128 === 0 || bytes >= 1024 * 1024) {
        bytes = 0;
        await setImmediate();
      }
    }
  }
  return { hits, truncated: false };
}
