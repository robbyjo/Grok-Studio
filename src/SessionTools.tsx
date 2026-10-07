import { useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export default function SessionTools({
  thread,
  select,
}: {
  thread: Thread;
  select: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<Wire[]>([]),
    [points, setPoints] = useState<Wire[]>([]);
  const [cursor, setCursor] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [mode, setMode] = useState('conversation_only'),
    [chosen, setChosen] = useState<Wire>(),
    [notice, setNotice] = useState('');
  async function run(method: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call(method, { id: thread.id, ...args });
      if (method === 'sessions:list') {
        setSessions(args.cursor ? [...sessions, ...result.sessions] : result.sessions);
        setCursor(result.nextCursor);
      } else if (method === 'sessions:points') setPoints(result.rewind_points ?? []);
      else if (method === 'sessions:preview') setChosen(result);
      else if (method === 'sessions:rewind') {
        setNotice(
          result.success
            ? 'Rewound. An archived transcript backup is available in chat history.'
            : `Rewind refused: ${result.error ?? JSON.stringify(result.conflicts)}`,
        );
        setChosen(undefined);
      } else select(result.id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mcp-settings">
      <h3>Native sessions and checkpoints</h3>
      <p>
        Browse Grok CLI sessions in this workspace, fork the current conversation, or rewind to a
        checkpoint recorded by Grok before a prompt.
      </p>
      <div className="mcp-actions">
        <button disabled={busy} onClick={() => void run('sessions:list')}>
          Browse CLI sessions
        </button>
        <button disabled={busy} onClick={() => void run('sessions:fork')}>
          Fork current chat
        </button>
        <button disabled={busy} onClick={() => void run('sessions:points')}>
          Load checkpoints
        </button>
      </div>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {sessions.map((item) => (
        <div className="mcp-server" key={item.sessionId}>
          <strong>{item.title ?? item.sessionId}</strong>
          <small>{item.updatedAt}</small>
          <button
            disabled={busy}
            onClick={() => void run('sessions:import', { sessionId: item.sessionId })}
          >
            Import session
          </button>
        </div>
      ))}
      {cursor && (
        <button disabled={busy} onClick={() => void run('sessions:list', { cursor })}>
          More sessions
        </button>
      )}
      <label>
        Rewind scope
        <select value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="conversation_only">Conversation only</option>
          <option value="files_only">Files only</option>
          <option value="all">Conversation and files</option>
        </select>
      </label>
      {points.map((point) => (
        <div className="mcp-server" key={point.prompt_index}>
          <strong>Before prompt {point.prompt_index + 1}</strong>
          <p>{point.prompt_preview}</p>
          <small>
            {point.created_at} · {point.num_file_snapshots} file snapshots
          </small>
          <button
            disabled={busy || (mode !== 'conversation_only' && !point.has_file_changes)}
            onClick={() => void run('sessions:preview', { index: point.prompt_index, mode })}
          >
            Review rewind
          </button>
        </div>
      ))}
      {chosen && (
        <div className="mcp-server">
          <p>
            Rewind to before prompt {chosen.index + 1} using {chosen.mode.replaceAll('_', ' ')}?
            Later conversation entries will be removed from the active chat when included. Files may
            be restored when included. External file conflicts will stop the operation. A transcript
            backup will be archived first.
          </p>
          <pre>{chosen.files.join('\n') || 'No file changes in this scope.'}</pre>
          <button
            disabled={busy}
            onClick={() => void run('sessions:rewind', { token: chosen.token })}
          >
            Confirm rewind
          </button>
          <button onClick={() => setChosen(undefined)}>Cancel rewind</button>
        </div>
      )}
    </div>
  );
}
