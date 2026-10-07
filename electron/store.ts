import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project, State, Thread, Wire, Entry } from '../shared/types';
import { History, HISTORY_TAIL } from './history';
import { Worker } from 'node:worker_threads';

export class Store {
  state: State;
  private timer?: NodeJS.Timeout;
  readonly history: History;
  private historyPath: string;
  private searchWorker?: Worker;
  private cache = new Map<string, { offset: number; entries: Entry[] }>();
  selected?: string;
  viewLimit = 100;
  storageError?: string;
  storageFault = () => {};
  constructor(
    private file: string,
    private changed: (state: State) => void = () => {},
    executable = 'grok',
  ) {
    this.state = { version: 1, projects: [], threads: [], settings: { executable } };
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.projects) || !Array.isArray(saved.threads))
        throw new Error('Unsupported state format');
      this.state = saved;
      for (const thread of this.state.threads)
        if (['running', 'connecting', 'approval'].includes(thread.status))
          thread.status = 'interrupted';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          const previous = JSON.parse(readFileSync(file + '.previous', 'utf8'));
          if (
            previous.version !== 1 ||
            !Array.isArray(previous.threads) ||
            !Array.isArray(previous.projects)
          )
            throw error;
          if (
            readdirSync(dirname(file)).filter((name) => name.startsWith('state.json.corrupt-'))
              .length >= 5
          )
            throw new Error('Preserve existing corrupt snapshots before another recovery.');
          // Preserve the corrupt source before restoring the last atomically written metadata.
          renameSync(file, file + '.corrupt-' + randomUUID());
          this.state = previous;
          this.state.recoveryNotice =
            'Recovered the previous metadata snapshot. The corrupt source was preserved beside state.json; transcripts remain in history.sqlite.';
        } catch {
          throw new Error(
            `Cannot read desktop state: ${String(error)}. Preserve ${file} before repair.`,
          );
        }
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    this.historyPath = join(dirname(file), 'history.sqlite');
    this.history = new History(this.historyPath, this.state.settings.storageMiB ?? 512);
    const durable = this.history.value('metadata');
    if (
      (!existsSync(file) || this.state.recoveryNotice) &&
      durable?.version === 1 &&
      Array.isArray(durable.threads) &&
      Array.isArray(durable.projects)
    ) {
      const notice =
        this.state.recoveryNotice ??
        'Recovered durable database metadata after the JSON snapshot was missing.';
      this.state = durable;
      this.state.recoveryNotice = notice;
      this.history.budget(this.state.settings.storageMiB ?? 512);
    }
    for (const thread of this.state.threads) {
      if (['running', 'approval', 'connecting'].includes(thread.status))
        thread.status = 'interrupted';
      for (const row of thread.queue ?? []) row.state = 'paused';
      delete thread.usage;
      delete thread.runtimeStatus;
      if (thread.session) thread.session.connected = false;
      for (const row of [...(thread.tasks ?? []), ...(thread.subagents ?? [])])
        if (row.status === 'running') row.status = 'unknown';
      this.bind(thread);
    }
    this.selected = this.state.threads[0]?.id;
    // Migrate legacy embedded transcripts durably before emitting any paged metadata.
    this.persistHistory();
  }
  private bind(thread: Thread) {
    const legacy = thread.entries;
    delete (thread as Partial<Thread>).entries;
    // An existing SQLite transcript wins over a legacy JSON file left by a crash during migration.
    if (legacy?.length && this.history.count(thread.id) === 0)
      this.cache.set(thread.id, { offset: 0, entries: legacy });
    Object.defineProperty(thread, 'entries', {
      configurable: true,
      enumerable: false,
      get: () => this.loaded(thread.id).entries,
      set: (entries: Entry[]) => {
        this.cache.set(thread.id, { offset: 0, entries });
      },
    });
  }
  private loaded(id: string) {
    const existing = this.cache.get(id);
    if (existing) {
      this.cache.delete(id);
      this.cache.set(id, existing);
      return existing;
    }
    if (this.cache.size >= 8) {
      const [oldId, old] = this.cache.entries().next().value!;
      this.history.transaction(() => this.history.save(oldId, old.offset, old.entries));
      this.cache.delete(oldId);
    }
    const count = this.history.count(id),
      offset = Math.max(0, count - HISTORY_TAIL);
    const record = { offset, entries: this.history.read(id, offset) };
    this.trimCache(record);
    this.cache.set(id, record);
    return record;
  }
  private persistHistory() {
    for (const t of this.state.threads)
      if (Object.getOwnPropertyDescriptor(t, 'entries')?.enumerable) this.bind(t);
    this.history.transaction(() => {
      for (const [id, row] of this.cache) this.history.save(id, row.offset, row.entries);
      this.history.metadata(this.state);
      const metadata = JSON.stringify(this.state);
      if (Buffer.byteLength(metadata) > 16 * 1024 * 1024)
        throw new Error('Metadata exceeds the 16 MiB budget. Export and prune archived chats.');
      this.history.setValue('metadata', this.state);
    });
    for (const row of this.cache.values()) {
      this.trimCache(row);
      if (row.entries.length > HISTORY_TAIL) {
        const removed = row.entries.length - HISTORY_TAIL;
        row.entries.splice(0, removed);
        row.offset += removed;
      }
    }
    for (const thread of this.state.threads) thread.entryCount = this.history.count(thread.id);
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }
  private trimCache(row: { offset: number; entries: Entry[] }) {
    let bytes = row.entries.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0);
    while (row.entries.length > 1 && bytes > 1024 * 1024) {
      bytes -= Buffer.byteLength(JSON.stringify(row.entries.shift()!));
      row.offset++;
    }
  }
  fullHistory(id: string) {
    this.persistHistory();
    return this.history.read(id, 0, this.history.count(id));
  }
  page(id: string, before?: number, entryId?: string) {
    this.thread(id);
    this.persistHistory();
    return this.history.page(id, before, entryId);
  }
  publicThread(id: string) {
    const thread = this.thread(id);
    const entries = id === this.selected ? this.history.page(id).entries : [];
    return {
      ...thread,
      entries,
      historyStart: Math.max(0, (thread.entryCount ?? 0) - entries.length),
    };
  }
  snapshot(): State {
    const sorted = [...this.state.threads].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
    );
    const shown = sorted.slice(0, this.viewLimit);
    const selected = this.state.threads.find((item) => item.id === this.selected);
    if (selected && !shown.includes(selected)) shown.push(selected);
    return {
      ...this.state,
      threads: shown.map((item) => this.publicThread(item.id)),
      pagination: {
        limit: this.viewLimit,
        total: sorted.length,
        hasMore: sorted.length > this.viewLimit,
      },
    };
  }
  assertCapacity() {
    if (
      this.storageError ||
      this.history.stats().bytes > (this.state.settings.storageMiB ?? 512) * 1024 * 1024 * 0.85
    )
      throw new Error(
        this.storageError ??
          'History is near its storage budget. Export and prune archived chats or increase the budget before starting another turn.',
      );
  }
  organization(input: Wire) {
    const ids = input.projectIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
      throw new Error('Select distinct projects.');
    const projects = ids.map((id) => this.project(id));
    if (
      input.group !== undefined &&
      (typeof input.group !== 'string' || input.group.length > 80 || input.group.includes('\0'))
    )
      throw new Error('Invalid group name.');
    if (
      input.hidden === true &&
      this.state.threads.some(
        (t) =>
          ids.includes(t.projectId) && ['running', 'approval', 'connecting'].includes(t.status),
      )
    )
      throw new Error('Stop active turns before removing projects.');
    if (
      input.order &&
      (!Array.isArray(input.order) ||
        input.order.length !== this.state.projects.length ||
        new Set(input.order).size !== input.order.length ||
        input.order.some((id: string) => !this.state.projects.some((p) => p.id === id)))
    )
      throw new Error('Order must contain every project exactly once.');
    for (const p of projects) {
      if (typeof input.pinned === 'boolean') p.pinned = input.pinned;
      if (typeof input.hidden === 'boolean') p.hidden = input.hidden;
      if (input.group !== undefined) p.group = input.group.trim();
    }
    if (input.order) input.order.forEach((id: string, i: number) => (this.project(id).order = i));
    this.flush();
  }
  bulkChats(ids: string[], update: { archived?: boolean; pinned?: boolean }) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
      throw new Error('Select distinct chats.');
    const threads = ids.map((id) => this.thread(id));
    if (
      update.archived !== undefined &&
      threads.some((t) => ['running', 'approval', 'connecting'].includes(t.status))
    )
      throw new Error('Stop active turns before archiving chats.');
    for (const t of threads) {
      if (typeof update.archived === 'boolean') t.archived = update.archived;
      if (typeof update.pinned === 'boolean') t.pinned = update.pinned;
    }
    this.flush();
  }
  prune(ids: string[], confirmed: boolean) {
    if (
      !confirmed ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 1000 ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Review and confirm the archived chats to delete.');
    const threads = ids.map((id) => this.thread(id));
    if (
      threads.some((t) => !t.archived || ['running', 'approval', 'connecting'].includes(t.status))
    )
      throw new Error('Only idle archived desktop chats can be deleted.');
    this.history.transaction(() => {
      for (const id of ids) {
        this.history.delete(id);
        this.history.db.prepare('DELETE FROM thread_index WHERE id=?').run(id);
        this.cache.delete(id);
      }
    });
    this.state.threads = this.state.threads.filter((t) => !ids.includes(t.id));
    this.flush();
    this.history.compact();
    this.storageError = undefined;
  }
  drafts(value: Wire) {
    if (
      !value ||
      typeof value !== 'object' ||
      Buffer.byteLength(JSON.stringify(value)) > 5 * 1024 * 1024
    )
      throw new Error('Recovery drafts exceed the 5 MiB limit.');
    this.history.setValue('drafts', value);
  }
  cacheStats() {
    return {
      chats: this.cache.size,
      entries: [...this.cache.values()].reduce((n, r) => n + r.entries.length, 0),
    };
  }
  vendorUpdate(id: string, update: Wire) {
    const t = this.thread(id),
      type = update.sessionUpdate;
    const allowed = [
      'task_id',
      'taskId',
      'command',
      'description',
      'status',
      'kind',
      'started_at',
      'ended_at',
      'exit_code',
      'subagent_id',
      'subagentId',
      'child_session_id',
      'subagent_type',
      'model',
      'duration_ms',
      'turn_count',
      'tool_call_count',
      'tokens_used',
      'context_window_tokens',
      'context_usage_pct',
      'turns',
      'tool_calls',
      'parent_session_id',
    ];
    const clean = (source: Wire) => {
      const row = Object.fromEntries(
        Object.entries(source).map(([key, value]) => [
          key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
          value,
        ]),
      );
      return Object.fromEntries(
        Object.entries(row)
          .filter(
            ([key, value]) =>
              allowed.includes(key) && ['string', 'number', 'boolean'].includes(typeof value),
          )
          .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 1000) : value]),
      );
    };
    if (type === 'background_tasks')
      t.tasks = (update.tasks ?? []).slice(0, 100).map((r: Wire) => ({
        ...clean(r),
        status:
          r.status ??
          (typeof r.completed === 'boolean'
            ? r.completed
              ? r.exit_code
                ? 'failed'
                : 'completed'
              : 'running'
            : 'unknown'),
      }));
    else if (type === 'subagents_snapshot') {
      const previous = t.subagents ?? [];
      const incoming = (update.subagents ?? [])
        .filter(
          (r: Wire) =>
            !(r.parentSessionId ?? r.parent_session_id) ||
            (r.parentSessionId ?? r.parent_session_id) === t.sessionId,
        )
        .slice(0, 100)
        .map((r: Wire) => ({ ...clean(r), status: r.status ?? 'running' }));
      const ids = new Set(incoming.map((r: Wire) => r.subagent_id ?? r.subagentId));
      t.subagents = [
        ...incoming,
        ...previous.filter(
          (r) => !ids.has(r.subagent_id ?? r.subagentId) && r.status !== 'running',
        ),
      ].slice(0, 100);
    } else if (
      [
        'subagent_spawned',
        'subagent_progress',
        'subagent_finished',
        'task_backgrounded',
        'task_completed',
      ].includes(type)
    ) {
      const field = type.startsWith('subagent') ? 'subagents' : 'tasks',
        key = type.startsWith('subagent') ? 'subagent_id' : 'task_id';
      const rows = t[field] ?? [],
        row = rows.find((r) => r[key] === update[key]);
      const next = {
        ...(row ?? {}),
        ...clean(update),
        status:
          update.status ??
          (type.endsWith('completed') || type.endsWith('finished') ? 'completed' : 'running'),
      };
      t[field] = [next, ...rows.filter((r) => r[key] !== update[key])].slice(0, 100);
    } else if (type === 'session_status') {
      t.runtimeStatus = {
        model: update.model,
        context_window: update.context_window,
        turn: update.turn,
        cost: update.cost,
        observedAt: new Date().toISOString(),
      };
    } else if (type === 'turn_completed' && update.usage)
      t.usage = { ...update.usage, _scope: 'turn' };
    this.touch();
  }
  cancelSearch() {
    void this.searchWorker?.terminate();
    this.searchWorker = undefined;
  }
  async search(
    query: string,
    options: { archived: boolean; hidden: boolean; offset?: number; limit?: number },
  ) {
    this.persistHistory();
    this.cancelSearch();
    const worker = new Worker(
      join(__dirname, 'history-worker' + (__filename.endsWith('.ts') ? '.ts' : '.js')),
      { workerData: { path: this.historyPath, query, options } },
    );
    this.searchWorker = worker;
    return new Promise<any>((resolve, reject) => {
      let done = false;
      worker.once('message', (result) => {
        done = true;
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      });
      worker.once('error', reject);
      worker.once('exit', () => {
        if (!done) resolve({ hits: [], truncated: false });
        if (this.searchWorker === worker) this.searchWorker = undefined;
      });
    });
  }
  thread(id: string): Thread {
    const thread = this.state.threads.find((item) => item.id === id);
    if (!thread) throw new Error('Chat not found.');
    return thread;
  }
  saveRecovery(record: Wire): string {
    const root = dirname(this.file) + '/recovery';
    mkdirSync(root, { recursive: true });
    const bytes = Buffer.byteLength(JSON.stringify(record));
    const existing = readdirSync(root).reduce((n, file) => n + statSync(join(root, file)).size, 0);
    if (existing + bytes > 256 * 1024 * 1024)
      throw new Error(
        'Recovery backups exceed 256 MiB. Preserve or remove old backups before continuing.',
      );
    const path = root + '/' + randomUUID() + '.json';
    writeFileSync(path, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
    return path;
  }
  project(id: string): Project {
    const project = this.state.projects.find((item) => item.id === id);
    if (!project) throw new Error('Project not found.');
    return project;
  }
  openProject(path: string, name: string): Project {
    let project = this.state.projects.find((item) => item.path === path);
    if (!project) {
      project = { id: randomUUID(), name, path };
      this.state.projects.push(project);
    }
    project.hidden = false;
    this.flush();
    return project;
  }
  editProject(id: string, update: { name?: string; hidden?: boolean }): Project {
    const project = this.project(id);
    if (
      update.name !== undefined &&
      (!update.name.trim() || update.name.length > 120 || update.name.includes('\0'))
    )
      throw new Error('Enter a project name between 1 and 120 characters.');
    if (
      update.hidden &&
      this.state.threads.some(
        (item) =>
          item.projectId === id && ['running', 'approval', 'connecting'].includes(item.status),
      )
    )
      throw new Error('Stop active turns in this project before removing it.');
    if (update.name !== undefined) project.name = update.name.trim();
    if (update.hidden !== undefined) project.hidden = update.hidden;
    this.flush();
    return project;
  }
  create(projectId: string, cwd: string): Thread {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: randomUUID(),
      projectId,
      cwd,
      title: 'New chat',
      status: 'idle',
      archived: false,
      pinned: false,
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
    this.state.threads.unshift(thread);
    this.bind(thread);
    // Publish metadata before the IPC reply selects a newly created chat.
    this.flush();
    return thread;
  }
  touch() {
    if (this.storageError) {
      this.changed(this.snapshot());
      return;
    }
    // Coalesce streaming chunks so IPC and disk writes do not grow per token.
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch (error) {
          this.storageError = 'History could not be saved: ' + (error as Error).message;
          this.state.recoveryNotice = this.storageError;
          this.storageFault();
          this.changed(this.snapshot());
        }
      }, 80);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.persistHistory();
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    if (existsSync(this.file)) {
      const previous = readFileSync(this.file, 'utf8');
      // Never replace a valid backup with a corrupt file.
      const parsed = JSON.parse(previous);
      if (parsed.version === 1) writeFileSync(this.file + '.previous', previous, { mode: 0o600 });
    }
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.changed(this.snapshot());
  }
  update(id: string, update: Wire, turn?: string) {
    const thread = this.thread(id);
    const type = update.sessionUpdate;
    if (
      type === 'agent_message_chunk' ||
      type === 'agent_thought_chunk' ||
      type === 'user_message_chunk'
    ) {
      const role =
        type === 'agent_message_chunk'
          ? 'assistant'
          : type === 'agent_thought_chunk'
            ? 'thought'
            : 'user';
      const text = update.content?.text ?? '';
      const last = thread.entries.at(-1);
      if (last?.type === role && last.turn === turn) last.text += text;
      else thread.entries.push({ id: randomUUID(), type: role, text, turn });
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const existing = thread.entries.find(
        (item) =>
          item.type === 'tool' && item.data?.toolCallId === update.toolCallId && item.turn === turn,
      );
      if (existing) {
        existing.data = { ...existing.data, ...update };
        existing.text = update.title ?? existing.text;
      } else
        thread.entries.push({
          id: randomUUID(),
          type: 'tool',
          text: update.title ?? 'Tool activity',
          data: update,
          turn,
        });
    } else if (type === 'plan') {
      const existing = thread.entries.find((item) => item.type === 'plan' && item.turn === turn);
      if (existing) existing.data = update;
      else
        thread.entries.push({ id: randomUUID(), type: 'plan', text: 'Plan', data: update, turn });
    } else if (type === 'config_option_update') {
      thread.session = { ...thread.session, configOptions: update.configOptions };
    } else if (type === 'current_mode_update') {
      thread.session = {
        ...thread.session,
        modes: { ...thread.session?.modes, currentModeId: update.currentModeId },
      };
    } else if (type === 'available_commands_update') {
      thread.session = { ...thread.session, availableCommands: update.availableCommands };
    } else {
      thread.entries.push({
        id: randomUUID(),
        type: 'notice',
        text: type ?? 'Agent update',
        data: update,
        turn,
      });
    }
    thread.updatedAt = new Date().toISOString();
    this.touch();
  }
}
