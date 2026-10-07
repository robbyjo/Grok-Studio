import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { State, Thread, Wire } from '../shared/types';

export class Store {
  state: State;
  private timer?: NodeJS.Timeout;
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          `Cannot read desktop state: ${String(error)}. Preserve ${file} before repair.`,
        );
    }
  }
  thread(id: string): Thread {
    const thread = this.state.threads.find((item) => item.id === id);
    if (!thread) throw new Error('Chat not found.');
    return thread;
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
    this.touch();
    return thread;
  }
  touch() {
    // Coalesce streaming chunks so IPC and disk writes do not grow per token.
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 80);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.file);
    this.changed(this.state);
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
