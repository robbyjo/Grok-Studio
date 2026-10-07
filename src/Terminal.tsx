import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
export default function TerminalPanel({
  id,
  error,
}: {
  id: string;
  error: (message: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: 'Cascadia Code, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#111315',
        foreground: '#d0d5d8',
        cursor: '#a8d9bd',
        selectionBackground: '#3b5147',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current!);
    let disposed = false;
    let replayed = false;
    const buffered: { data: string; seq: number }[] = [];
    const unsubscribe = window.desktop.onEvent((event) => {
      if (event.type === 'terminal' && event.id === id) {
        if (replayed) terminal.write(event.data);
        else buffered.push(event);
      }
      if (event.type === 'terminal-exit' && event.id === id)
        terminal.write(`\r\n[Shell exited: ${event.code}]\r\n`);
    });
    window.desktop
      .call<{ buffer: string; seq: number }>('terminal:open', { id })
      .then((history) => {
        if (disposed) return;
        terminal.write(history.buffer);
        for (const item of buffered) if (item.seq > history.seq) terminal.write(item.data);
        replayed = true;
        fit.fit();
        terminal.focus();
      })
      .catch((reason) => {
        if (!disposed) error(String(reason));
      });
    const input = terminal.onData((data) => {
      void window.desktop
        .call('terminal:write', { id, data })
        .catch((reason) => error(String(reason)));
    });
    const resize = () => {
      if (!disposed && element.current?.clientWidth) {
        fit.fit();
        void window.desktop
          .call('terminal:resize', { id, cols: terminal.cols, rows: terminal.rows })
          .catch(() => {});
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element.current!);
    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribe();
      input.dispose();
      terminal.dispose();
    };
  }, [id]);
  return <div className="terminal-surface" ref={element} />;
}
