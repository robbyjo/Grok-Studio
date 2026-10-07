import { DatabaseSync } from 'node:sqlite';
import type { Entry, SearchHit, SearchResults, Thread, State } from '../shared/types';
import { entryText } from './search';
export const HISTORY_TAIL = 200;
export function displayEntry(entry: Entry): Entry {
  if (Buffer.byteLength(JSON.stringify(entry)) <= 12000) return entry;
  return {
    id: entry.id,
    type: entry.type,
    turn: entry.turn,
    text:
      entry.text.slice(0, 2500) +
      '\n[Display shortened. Export this chat for the complete stored entry.]',
  };
}
export class History {
  readonly db: DatabaseSync;
  constructor(path: string, budgetMiB = 512, readOnly = false) {
    this.db = new DatabaseSync(path, { readOnly });
    this.db.exec('PRAGMA busy_timeout=1500');
    if (readOnly) return;
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS entries(thread TEXT NOT NULL, pos INTEGER NOT NULL, id TEXT NOT NULL,
        document TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(thread,pos));
      CREATE INDEX IF NOT EXISTS entry_ids ON entries(thread,id);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, thread UNINDEXED, pos UNINDEXED, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS entry_insert AFTER INSERT ON entries BEGIN
        INSERT INTO search(rowid,text,thread,pos) VALUES(new.rowid,new.text,new.thread,new.pos); END;
      CREATE TRIGGER IF NOT EXISTS entry_delete AFTER DELETE ON entries BEGIN
        DELETE FROM search WHERE rowid=old.rowid; END;
      CREATE TRIGGER IF NOT EXISTS entry_update AFTER UPDATE ON entries BEGIN
        DELETE FROM search WHERE rowid=old.rowid;
        INSERT INTO search(rowid,text,thread,pos) VALUES(new.rowid,new.text,new.thread,new.pos); END;
      CREATE TABLE IF NOT EXISTS values_store(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_index(id TEXT PRIMARY KEY,title TEXT, project TEXT,updated TEXT,archived INTEGER,hidden INTEGER,text TEXT);`);
    this.budget(budgetMiB);
  }
  budget(mib: number) {
    if (!Number.isInteger(mib) || mib < 64 || mib > 2048)
      throw new Error('Storage budget must be 64–2048 MiB.');
    const size = Number((this.db.prepare('PRAGMA page_size').get() as any).page_size);
    this.db.exec(`PRAGMA max_page_count=${Math.floor((mib * 1024 * 1024) / size)}`);
  }
  transaction(operation: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  count(id: string): number {
    return Number(
      (
        this.db
          .prepare('SELECT coalesce(max(pos)+1,0) AS count FROM entries WHERE thread=?')
          .get(id) as any
      ).count,
    );
  }
  save(id: string, offset: number, entries: Entry[]) {
    const upsert = this.db
      .prepare(`INSERT INTO entries(thread,pos,id,document,text) VALUES(?,?,?,?,?)
      ON CONFLICT(thread,pos) DO UPDATE SET id=excluded.id, document=excluded.document,text=excluded.text
      WHERE entries.document!=excluded.document`);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      upsert.run(id, offset + i, entry.id, JSON.stringify(entry), entryText(entry));
    }
    this.db
      .prepare('DELETE FROM entries WHERE thread=? AND pos>=?')
      .run(id, offset + entries.length);
  }
  read(id: string, start: number, count = HISTORY_TAIL): Entry[] {
    return (
      this.db
        .prepare('SELECT document FROM entries WHERE thread=? AND pos>=? ORDER BY pos LIMIT ?')
        .all(id, start, count) as any[]
    ).map((row) => JSON.parse(row.document));
  }
  page(id: string, before?: number, entryId?: string, limit = 80) {
    const total = this.count(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid history page size.');
    let end = before === undefined ? total : before;
    if (!Number.isInteger(end) || end < 0 || end > total)
      throw new Error('History cursor is no longer valid.');
    if (entryId) {
      const row = this.db
        .prepare('SELECT pos FROM entries WHERE thread=? AND id=?')
        .get(id, entryId) as any;
      if (!row) throw new Error('The selected message is no longer stored.');
      end = Math.min(total, Number(row.pos) + Math.ceil(limit / 2));
    }
    const start = Math.max(0, end - limit);
    return {
      entries: this.read(id, start, end - start).map(displayEntry),
      start,
      end,
      total,
      hasOlder: start > 0,
      hasNewer: end < total,
    };
  }
  value(key: string) {
    const row = this.db.prepare('SELECT value FROM values_store WHERE key=?').get(key) as any;
    return row ? JSON.parse(row.value) : undefined;
  }
  setValue(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO values_store VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  stats() {
    const page = this.db.prepare('PRAGMA page_count').get() as any;
    const size = this.db.prepare('PRAGMA page_size').get() as any;
    const free = this.db.prepare('PRAGMA freelist_count').get() as any;
    return {
      bytes: Number(page.page_count) * Number(size.page_size),
      reclaimableBytes: Number(free.freelist_count) * Number(size.page_size),
      entries: Number((this.db.prepare('SELECT count(*) AS n FROM entries').get() as any).n),
    };
  }
  delete(id: string) {
    this.db.prepare('DELETE FROM entries WHERE thread=?').run(id);
  }
  compact() {
    this.db.exec('VACUUM');
  }
  metadata(state: State) {
    const projects = new Map(state.projects.map((p) => [p.id, p]));
    const save = this.db
      .prepare(`INSERT INTO thread_index VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE
      SET title=excluded.title,project=excluded.project,updated=excluded.updated,archived=excluded.archived,hidden=excluded.hidden,text=excluded.text
      WHERE title!=excluded.title OR project!=excluded.project OR updated!=excluded.updated OR archived!=excluded.archived OR hidden!=excluded.hidden OR text!=excluded.text`);
    for (const t of state.threads) {
      const p = projects.get(t.projectId);
      save.run(
        t.id,
        t.title,
        p?.name ?? 'Unknown project',
        t.updatedAt,
        Number(t.archived),
        Number(Boolean(p?.hidden)),
        `${t.title}\n${p?.name ?? ''}\n${t.cwd}`,
      );
    }
  }
  search(
    _state: State | undefined,
    query: string,
    options: { archived: boolean; hidden: boolean; offset?: number; limit?: number },
  ): SearchResults {
    if (typeof query !== 'string' || query.length > 512 || query.includes('\0'))
      throw new Error('Search text must be at most 512 characters.');
    const offset = options.offset ?? 0,
      limit = options.limit ?? 100;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Invalid search page.');
    const literal = query.trim();
    if (!literal) return { hits: [], truncated: false };
    const pattern = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    const hits: SearchHit[] = [];
    this.db.function('literal_phrase', (text: any) => Number(pattern.test(String(text))));
    // FTS trigram phrases retain literal punctuation. Short phrases scan in the search worker.
    const indexed = Array.from(literal).length >= 3;
    const source = indexed
      ? 'SELECT thread,CAST(pos AS INTEGER) pos,text FROM search WHERE search MATCH ?'
      : 'SELECT thread,pos,text FROM entries';
    const sql = `WITH matches AS (${source} UNION ALL SELECT id,-1,text FROM thread_index WHERE literal_phrase(text))
      SELECT matches.*,t.title,t.project,t.archived,t.hidden FROM matches JOIN thread_index t ON t.id=matches.thread
      WHERE literal_phrase(matches.text) AND (? OR t.archived=0) AND (? OR t.hidden=0)
      ORDER BY t.updated DESC,t.id,matches.pos LIMIT ? OFFSET ?`;
    const params = [
      ...(indexed ? ['"' + literal.replaceAll('"', '""') + '"'] : []),
      Number(options.archived),
      Number(options.hidden),
      limit + 1,
      offset,
    ];
    const rows = this.db.prepare(sql).all(...params) as any[];
    for (const row of rows.slice(0, limit)) {
      const match = pattern.exec(row.text);
      if (!match) continue;
      const entry = row.pos < 0 ? undefined : this.read(row.thread, Number(row.pos), 1)[0];
      const start = Math.max(0, match.index - 70),
        end = Math.min(row.text.length, match.index + match[0].length + 100);
      hits.push({
        threadId: row.thread,
        entryId: entry?.id,
        title: row.title,
        projectName: row.project,
        archived: Boolean(row.archived),
        hidden: Boolean(row.hidden),
        kind: entry?.type ?? 'chat',
        before: (start ? '…' : '') + row.text.slice(start, match.index),
        match: match[0],
        after:
          row.text.slice(match.index + match[0].length, end) + (end < row.text.length ? '…' : ''),
      });
    }
    return {
      hits,
      truncated: rows.length > limit,
      nextOffset: rows.length > limit ? offset + limit : undefined,
    };
  }
}
