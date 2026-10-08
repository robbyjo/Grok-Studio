import { useState } from 'react';
import type { State, Wire } from '../shared/types';
export default function StorageSettings({ state }: { state: State }) {
  const [report, setReport] = useState<Wire>(),
    [review, setReview] = useState<Wire>(),
    [selected, setSelected] = useState<string[]>([]),
    [days, setDays] = useState(30),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  async function run(method: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call(`storage:${method}`, args);
      if (method === 'inspect') setReport(result);
      else if (method === 'preview') setReview(result);
      else if (result) {
        setMessage(JSON.stringify(result, null, 2));
        setReview(undefined);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const sessions = [
    ...new Set(state.threads.filter((t) => t.archived && t.sessionId).map((t) => t.sessionId!)),
  ];
  return (
    <section>
      <button disabled={busy} onClick={() => void run('inspect')}>
        Inspect aggregate profile storage
      </button>
      {report && <pre>{JSON.stringify(report, null, 2)}</pre>}
      <h4>Export and prune archived native sessions</h4>
      <p>
        Only old native sessions owned exclusively by idle archived chats qualify. Choose an export
        folder outside the profiles. Verified local exports allow restoration. Cloud history is not
        deleted. Stop any separately running Grok clients that use this profile first.
      </p>
      <label>
        Minimum age in days{' '}
        <input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setReview(undefined);
          }}
        />
      </label>
      {sessions.map((sessionId) => (
        <label className="workflow-row" key={sessionId}>
          <input
            type="checkbox"
            checked={selected.includes(sessionId)}
            onChange={() => {
              setSelected(
                selected.includes(sessionId)
                  ? selected.filter((id) => id !== sessionId)
                  : [...selected, sessionId],
              );
              setReview(undefined);
            }}
          />
          {state.threads.find((t) => t.sessionId === sessionId)?.title} · {sessionId}
        </label>
      ))}
      <button
        disabled={busy || !selected.length}
        onClick={() => void run('preview', { sessionIds: selected, days })}
      >
        Review native retention
      </button>
      {review && (
        <div>
          <pre>{JSON.stringify(review.sessions, null, 2)}</pre>
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Export and verify these local native sessions, then prune their profile copies? Separately running Grok clients must be stopped.',
                )
              )
                void run('prune', { revision: review.revision, confirmed: true });
            }}
          >
            Export and prune reviewed native sessions
          </button>
          <button onClick={() => setReview(undefined)}>Cancel retention</button>
        </div>
      )}
      <button disabled={busy} onClick={() => void run('restore')}>
        Restore verified native session export
      </button>
      {message && <pre role="status">{message}</pre>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
