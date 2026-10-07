import * as pty from '@lydell/node-pty';
import type { DesktopEvent } from '../shared/types';
interface TerminalState {
  pty: pty.IPty;
  buffer: string;
  exited: boolean;
  seq: number;
}
export class Terminals {
  private terminals = new Map<string, TerminalState>();
  constructor(private emit: (event: DesktopEvent) => void) {}
  open(id: string, cwd: string) {
    const existing = this.terminals.get(id);
    if (existing && !existing.exited) return { buffer: existing.buffer, seq: existing.seq };
    const shell =
      process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    const terminal: TerminalState = {
      pty: pty.spawn(shell, process.platform === 'win32' ? ['-NoLogo'] : [], {
        name: 'xterm-256color',
        cwd,
        cols: 90,
        rows: 24,
        env: process.env as Record<string, string>,
      }),
      buffer: '',
      exited: false,
      seq: 0,
    };
    this.terminals.set(id, terminal);
    terminal.pty.onData((data) => {
      terminal.buffer = (terminal.buffer + data).slice(-200_000);
      this.emit({ type: 'terminal', id, data, seq: ++terminal.seq });
    });
    terminal.pty.onExit(({ exitCode }) => {
      terminal.exited = true;
      this.emit({ type: 'terminal-exit', id, code: exitCode });
    });
    return { buffer: '', seq: 0 };
  }
  write(id: string, data: string) {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.exited) throw new Error('Terminal is closed.');
    terminal.pty.write(data);
  }
  resize(id: string, cols: number, rows: number) {
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.exited)
      terminal.pty.resize(Math.max(2, Math.min(500, cols)), Math.max(1, Math.min(300, rows)));
  }
  close(id: string) {
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.exited) terminal.pty.kill();
    this.terminals.delete(id);
  }
  shutdown() {
    for (const id of this.terminals.keys()) this.close(id);
  }
}
