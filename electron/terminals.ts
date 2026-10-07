import * as pty from '@lydell/node-pty';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DesktopEvent } from '../shared/types';
import type { History } from './history';
interface TerminalState {
  id: string;
  owner: string;
  shell: string;
  cwd: string;
  buffer: string;
  seq: number;
  exited: boolean;
  pty?: pty.IPty;
}
export class Terminals {
  private terminals = new Map<string, TerminalState>();
  private timer?: NodeJS.Timeout;
  constructor(
    private emit: (event: DesktopEvent) => void,
    private history?: History,
  ) {
    for (const row of (history?.value('terminals') ?? []).slice(0, 32))
      if (
        typeof row.id === 'string' &&
        typeof row.owner === 'string' &&
        typeof row.buffer === 'string'
      )
        this.terminals.set(row.id, { ...row, buffer: row.buffer.slice(-200000), exited: true });
  }
  shells() {
    if (process.platform !== 'win32')
      return [
        {
          id: 'default',
          name: 'Default shell',
          command: process.env.SHELL || '/bin/bash',
          args: [],
        },
      ];
    const rows = [
      {
        id: 'powershell',
        name: 'Windows PowerShell',
        command: 'powershell.exe',
        args: ['-NoLogo'],
      },
      { id: 'pwsh', name: 'PowerShell 7', command: 'pwsh.exe', args: ['-NoLogo'] },
      { id: 'cmd', name: 'Command Prompt', command: 'cmd.exe', args: [] },
    ];
    const result = rows.flatMap((row) => {
      try {
        const command = execFileSync('where.exe', [row.command], {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .trim()
          .split('\r\n')[0];
        return [{ ...row, command }];
      } catch {
        return [];
      }
    });
    const bash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (existsSync(bash))
      result.push({ id: 'bash', name: 'Git Bash', command: bash, args: ['--login'] });
    return result;
  }
  list(owner: string) {
    return [...this.terminals.values()]
      .filter((row) => row.owner === owner)
      .map(({ id, shell, cwd, exited }) => ({ id, shell, cwd, exited }));
  }
  create(owner: string, cwd: string, shell: string) {
    const id = owner + ':' + randomUUID();
    this.open(owner, cwd, id, shell, true);
    return id;
  }
  private owned(owner: string, id = owner) {
    const row = this.terminals.get(id);
    if (!row || row.owner !== owner) throw new Error('Choose a terminal belonging to this chat.');
    return row;
  }
  open(owner: string, cwd: string, id = owner, shellId?: string, create = false) {
    let row = this.terminals.get(id);
    if (row && row.owner !== owner) throw new Error('Terminal belongs to another chat.');
    if (!row && id !== owner && !create) throw new Error('Terminal no longer exists.');
    if (row && !row.exited) return { buffer: row.buffer, seq: row.seq, id: row.id };
    if (!row && (this.list(owner).length >= 6 || this.terminals.size >= 32))
      throw new Error(
        'Terminal limit reached (six per chat, 32 total). Close a tab to release its stored scrollback.',
      );
    const profiles = this.shells(),
      profile = profiles.find((p) => p.id === (shellId ?? row?.shell ?? profiles[0]?.id));
    if (!profile) throw new Error('Selected shell is unavailable.');
    row = {
      id,
      owner,
      shell: profile.id,
      cwd,
      buffer: row?.buffer ?? '',
      seq: row?.seq ?? 0,
      exited: false,
    };
    if (row.buffer)
      row.buffer += '\r\n[New shell process: previous variables/jobs are not restored.]\r\n';
    row.pty = pty.spawn(profile.command, profile.args, {
      name: 'xterm-256color',
      cwd,
      cols: 90,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    this.terminals.set(id, row);
    const terminal = row;
    terminal.pty!.onData((data) => {
      terminal.buffer = (terminal.buffer + data).slice(-200000);
      this.emit({ type: 'terminal', id, data, seq: ++terminal.seq });
      this.schedule();
    });
    terminal.pty!.onExit(({ exitCode }) => {
      terminal.exited = true;
      this.emit({ type: 'terminal-exit', id, code: exitCode });
      this.persist();
    });
    this.schedule();
    return { buffer: terminal.buffer, seq: terminal.seq, id };
  }
  write(owner: string, data: string, id = owner) {
    const row = this.owned(owner, id);
    if (row.exited || !row.pty) throw new Error('Terminal is closed.');
    row.pty.write(data);
  }
  resize(owner: string, cols: number, rows: number, id = owner) {
    const row = this.terminals.get(id);
    if (row && row.owner !== owner) throw new Error('Terminal belongs to another chat.');
    if (row?.pty && !row.exited)
      row.pty.resize(Math.max(2, Math.min(500, cols)), Math.max(1, Math.min(300, rows)));
  }
  context(owner: string, id = owner) {
    const row = this.owned(owner, id);
    return {
      shell: row.shell,
      cwd: row.cwd,
      exited: row.exited,
      text: row.buffer
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[()][A-Z0-9]/g, '')
        .slice(-16000),
    };
  }
  close(owner: string, id?: string, forget = false) {
    if (id && this.terminals.get(id)?.owner !== owner && this.terminals.has(id))
      throw new Error('Terminal belongs to another chat.');
    for (const row of this.terminals.values())
      if (row.owner === owner && (!id || row.id === id)) {
        if (!row.exited) row.pty?.kill();
        row.exited = true;
        if (forget) this.terminals.delete(row.id);
      }
    this.persist();
  }
  private schedule() {
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.persist();
      }, 500);
  }
  persist() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.history?.setValue(
      'terminals',
      [...this.terminals.values()].map(({ pty, ...row }) => row),
    );
  }
  shutdown() {
    for (const owner of new Set([...this.terminals.values()].map((row) => row.owner)))
      this.close(owner);
    this.persist();
  }
  stats() {
    return {
      tabs: this.terminals.size,
      live: [...this.terminals.values()].filter((row) => !row.exited).length,
      bufferChars: [...this.terminals.values()].reduce((n, row) => n + row.buffer.length, 0),
    };
  }
}
