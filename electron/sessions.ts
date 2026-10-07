import { resolve } from 'node:path';
import { Agents } from './agent';
import { Store } from './store';
import type { Wire } from '../shared/types';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { insideFuture } from './paths';

export class Sessions {
  private candidates = new Map<string, Wire>();
  private previews = new Map<string, Wire>();
  constructor(
    private agents: Agents,
    private store: Store,
  ) {}
  async list(id: string, cursor?: string) {
    const thread = this.store.thread(id);
    const session = await this.agents.connect(id);
    if (!session.agent?.agentCapabilities?.sessionCapabilities?.list)
      throw new Error('This runtime does not advertise session listing.');
    const response = await this.agents.native(id, 'session/list', {
      cwd: thread.cwd,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(response.sessions)) throw new Error('Unexpected native session list.');
    if (!cursor) this.candidates.clear();
    for (const item of response.sessions) {
      if (
        typeof item.sessionId === 'string' &&
        typeof item.cwd === 'string' &&
        resolve(item.cwd).toLowerCase() === resolve(thread.cwd).toLowerCase()
      )
        this.candidates.set(item.sessionId, { ...item, projectId: thread.projectId });
    }
    return {
      sessions: response.sessions.filter((item: Wire) => this.candidates.has(item.sessionId)),
      nextCursor: response.nextCursor,
    };
  }
  async import(id: string, sessionId: string) {
    const source = this.store.thread(id),
      selected = this.candidates.get(sessionId);
    if (
      !selected ||
      selected.projectId !== source.projectId ||
      resolve(selected.cwd).toLowerCase() !== resolve(source.cwd).toLowerCase()
    )
      throw new Error('Refresh and select a native session in this workspace.');
    const existing = this.store.state.threads.find(
      (item) => item.sessionId === sessionId && item.cwd === source.cwd,
    );
    if (existing) return existing;
    const imported = this.store.create(source.projectId, source.cwd);
    imported.sessionId = sessionId;
    imported.title = String(selected.title ?? 'Imported CLI chat').slice(0, 120);
    this.store.flush();
    // Loading is explicit and replays native history. Failure preserves the imported ID for retry.
    await this.agents.connect(imported.id);
    return imported;
  }
  async fork(id: string) {
    const source = this.store.thread(id);
    await this.agents.connect(id);
    const result = await this.agents.native(id, '_x.ai/session/fork', {
      sourceSessionId: source.sessionId,
      sourceCwd: source.cwd,
      newCwd: source.cwd,
    });
    if (typeof result.newSessionId !== 'string' || result.newSessionId === source.sessionId)
      throw new Error('Native fork did not return a new session.');
    const fork = this.store.create(source.projectId, source.cwd);
    fork.sessionId = result.newSessionId;
    fork.title = ('Fork: ' + source.title).slice(0, 120);
    this.store.flush();
    await this.agents.connect(fork.id);
    return fork;
  }
  async points(id: string) {
    const thread = this.store.thread(id);
    await this.agents.connect(id);
    return this.agents.native(id, '_x.ai/rewind/points', { sessionId: thread.sessionId });
  }
  async handoff(id: string, cwd: string) {
    const thread = this.store.thread(id);
    await this.agents.connect(id);
    const result = await this.agents.native(id, '_x.ai/session/fork', {
      sourceSessionId: thread.sessionId,
      sourceCwd: thread.cwd,
      newCwd: cwd,
    });
    if (typeof result.newSessionId !== 'string' || result.newSessionId === thread.sessionId)
      throw new Error('Native handoff did not return a new session.');
    this.agents.disconnect(id);
    thread.entries.push({
      id: randomUUID(),
      type: 'notice',
      text: `Moved workspace from ${thread.cwd} to ${cwd}.`,
      data: { previousSessionId: thread.sessionId },
    });
    thread.cwd = cwd;
    thread.sessionId = result.newSessionId;
    thread.session = undefined;
    this.store.flush();
    await this.agents.connect(id);
    return thread;
  }
  async preview(id: string, index: number, mode: string) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !['all', 'conversation_only', 'files_only'].includes(mode)
    )
      throw new Error('Choose a valid checkpoint and rewind scope.');
    const thread = this.store.thread(id);
    const points = await this.points(id);
    if (!points.rewind_points?.some((point: Wire) => point.prompt_index === index))
      throw new Error('Checkpoint is no longer available.');
    const result = await this.agents.native(id, '_x.ai/rewind/execute', {
      sessionId: thread.sessionId,
      targetPromptIndex: index,
      mode,
      force: false,
    });
    if (result.error || result.conflicts?.length)
      throw new Error(result.error ?? 'External file conflicts prevent rewind.');
    const files = [];
    let size = 0;
    for (const path of result.clean_files ?? []) {
      const target = await insideFuture(thread.cwd, path);
      const bytes = await readFile(target).catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      size += bytes?.length ?? 0;
      if (size > 20 * 1024 * 1024) throw new Error('Rewind recovery exceeds the 20 MiB GUI limit.');
      files.push({
        path,
        content: bytes?.toString('base64'),
        revision: bytes ? createHash('sha256').update(bytes).digest('hex') : 'absent',
      });
    }
    const token = randomUUID();
    this.previews.clear();
    this.previews.set(token, { id, index, mode, result, files });
    return { token, index, mode, files: files.map((item) => item.path) };
  }
  async rewind(id: string, token: string) {
    const selected = this.previews.get(token);
    if (!selected || selected.id !== id) throw new Error('Review the rewind again.');
    const { index, mode, result: reviewed, files } = selected;
    const thread = this.store.thread(id);
    const current = await this.agents.native(id, '_x.ai/rewind/execute', {
      sessionId: thread.sessionId,
      targetPromptIndex: index,
      mode,
      force: false,
    });
    if (
      current.error ||
      current.conflicts?.length ||
      JSON.stringify(current.clean_files) !== JSON.stringify(reviewed.clean_files)
    )
      throw new Error('Rewind preview changed. Review again.');
    for (const file of files) {
      const bytes = await readFile(await insideFuture(thread.cwd, file.path)).catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      const revision = bytes ? createHash('sha256').update(bytes).digest('hex') : 'absent';
      if (revision !== file.revision)
        throw new Error('File changed after rewind review. Review again.');
    }
    this.previews.delete(token);
    const recovery = this.store.saveRecovery({
      cwd: thread.cwd,
      sessionId: thread.sessionId,
      index,
      mode,
      files,
      entries: thread.entries,
    });
    // Preserve conversation and file recovery before the explicitly confirmed native mutation.
    const backup = this.store.create(thread.projectId, thread.cwd);
    backup.title = ('Before rewind: ' + thread.title).slice(0, 120);
    backup.entries = structuredClone(thread.entries);
    backup.archived = true;
    backup.entries.push({
      id: randomUUID(),
      type: 'notice',
      text: `Rewind recovery saved: ${recovery}`,
    });
    this.store.flush();
    const result = await this.agents.native(id, '_x.ai/rewind/execute', {
      sessionId: thread.sessionId,
      targetPromptIndex: index,
      mode,
      // Grok force=false is a dry run. Execute only after GUI confirmation,
      // a second conflict-free preview and source-file hash checks.
      force: true,
    });
    if (!result.success) return { ...result, transcriptBackupId: backup.id };
    if (mode !== 'files_only') {
      this.agents.disconnect(id);
      thread.entries = [];
      this.store.flush();
      await this.agents.connect(id);
    }
    return { ...result, transcriptBackupId: backup.id };
  }
}
