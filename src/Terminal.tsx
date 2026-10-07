import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
function TerminalSurface({
  id,
  terminalId,
  error,
}: {
  id: string;
  terminalId: string;
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
      if (event.type === 'terminal' && event.id === terminalId) {
        if (replayed) terminal.write(event.data);
        else buffered.push(event);
      }
      if (event.type === 'terminal-exit' && event.id === terminalId)
        terminal.write(`\r\n[Shell exited: ${event.code}]\r\n`);
    });
    window.desktop
      .call<{ buffer: string; seq: number }>('terminal:open', { id, terminalId })
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
        .call('terminal:write', { id, terminalId, data })
        .catch((reason) => error(String(reason)));
    });
    const resize = () => {
      if (!disposed && element.current?.clientWidth) {
        fit.fit();
        void window.desktop
          .call('terminal:resize', { id, terminalId, cols: terminal.cols, rows: terminal.rows })
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
  }, [id, terminalId]);
  return <div className="terminal-surface" ref={element} />;
}
export default function TerminalPanel({
  id,
  error,
  context,
}: {
  id: string;
  error: (message: string) => void;
  context: (text: string) => void;
}) {
  const [rows, setRows] = useState<Array<{ id: string; shell: string; exited: boolean }>>([]),
    [selected, setSelected] = useState<string>(''),
    [shells, setShells] = useState<Array<{ id: string; name: string }>>([]),
    [shell, setShell] = useState('powershell'),
    [review, setReview] = useState<string>();
  async function refresh() {
    const list = await window.desktop.call<any[]>('terminal:list', { id });
    setRows(list);
    return list;
  }
  useEffect(() => {
    void window.desktop
      .call<any[]>('terminal:shells')
      .then((list) => {
        setShells(list);
        setShell(list[0]?.id ?? 'default');
      })
      .catch((e) => error(String(e)));
    void refresh()
      .then((list) => {
        if (list.length) setSelected(list[0].id);
        else {
          setRows([{ id, shell: 'powershell', exited: false }]);
          setSelected(id);
        }
      })
      .catch((e) => error(String(e)));
  }, [id]);
  return (
    <>
      <div className="terminal-tabs">
        <div role="tablist" aria-label="Terminal tabs">
          {rows.map((row, index) => (
            <button
              key={row.id}
              role="tab"
              aria-selected={selected === row.id}
              onClick={() => setSelected(row.id)}
            >
              {index + 1} · {row.shell}
            </button>
          ))}
        </div>
        <select
          aria-label="New terminal shell"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
        >
          {shells.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          onClick={async () => {
            try {
              const next = await window.desktop.call<string>('terminal:create', { id, shell });
              await refresh();
              setSelected(next);
            } catch (e) {
              error(String(e));
            }
          }}
        >
          New terminal
        </button>
        <button
          disabled={!selected}
          onClick={async () => {
            try {
              await window.desktop.call('terminal:close', {
                id,
                terminalId: selected,
                forget: true,
              });
              const list = await refresh();
              setSelected(list[0]?.id ?? '');
            } catch (e) {
              error(String(e));
            }
          }}
        >
          Close tab
        </button>
        <button
          disabled={!selected}
          onClick={async () => {
            try {
              const result = await window.desktop.call('terminal:context', {
                id,
                terminalId: selected,
              });
              setReview(
                `Terminal output (${result.shell}, ${result.cwd}) captured for review:\n${result.text}`,
              );
            } catch (e) {
              error(String(e));
            }
          }}
        >
          Review terminal context
        </button>
      </div>
      {review !== undefined && (
        <div className="terminal-context">
          <p>
            Review and edit this captured output before adding it to your message. It is sent to
            Grok only when you send the message.
          </p>
          <textarea
            aria-label="Terminal context to include"
            value={review}
            maxLength={20000}
            onChange={(e) => setReview(e.target.value)}
          />
          <button
            onClick={() => {
              context(review);
              setReview(undefined);
            }}
          >
            Add context to message
          </button>
          <button onClick={() => setReview(undefined)}>Discard context</button>
        </div>
      )}
      {selected ? (
        <TerminalSurface id={id} terminalId={selected} error={error} />
      ) : (
        <p>No terminal tabs. Choose a shell and open a new terminal.</p>
      )}
    </>
  );
}
