import { useEffect, useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export default function TaskWorkflow({
  thread,
  select,
}: {
  thread: Thread;
  select: (id: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState(''),
    [actions, setActions] = useState<Wire[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [rows, setRows] = useState<Wire[]>([]),
    [review, setReview] = useState<Wire>(),
    [patch, setPatch] = useState<Wire>(),
    [files, setFiles] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      void window.desktop
        .call<Wire[]>('workflow:list', { id: thread.id })
        .then((rows) => {
          if (alive) setRows(rows);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [thread.id]);
  async function call(method: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      return await window.desktop.call(`workflow:${method}`, { id: thread.id, ...args });
    } catch (e) {
      setError(String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="task-workflow">
      <button
        onClick={async () => {
          setOpen(!open);
          if (!open)
            try {
              setActions(
                (await window.desktop.call<Wire>('actions:list', { id: thread.id })).actions,
              );
            } catch (e) {
              setError(String(e));
            }
        }}
      >
        Task → test → review
      </button>
      {open && (
        <div>
          <p>
            Start from a clean committed project. Workbench creates a separate worktree, runs your
            selected test actions after the agent finishes, then lets you review and apply selected
            files.
          </p>
          <label>
            Task prompt
            <textarea
              aria-label="Task prompt"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setReview(undefined);
              }}
            />
          </label>
          {!actions.length && (
            <p>Configure test commands under Settings → Project actions first.</p>
          )}
          {actions.map((action) => (
            <label key={action.id}>
              <input
                type="checkbox"
                checked={chosen.includes(action.id)}
                onChange={(e) => {
                  setChosen(
                    e.target.checked
                      ? [...chosen, action.id]
                      : chosen.filter((id) => id !== action.id),
                  );
                  setReview(undefined);
                }}
              />
              {action.name} · {action.command} {action.args.join(' ')} · {action.directory}
            </label>
          ))}
          <button
            disabled={busy || !text.trim() || !chosen.length}
            onClick={async () => setReview(await call('preview', { text, actionIds: chosen }))}
          >
            Review task and test commands
          </button>
          {review && (
            <div>
              <pre>{JSON.stringify(review, null, 2)}</pre>
              <button
                disabled={busy}
                onClick={async () => {
                  const result = await call('start', { token: review.token });
                  if (result) select(result.id);
                }}
              >
                Create worktree and start approved task
              </button>
            </div>
          )}
        </div>
      )}
      {rows.map((row) => (
        <details key={row.id} open={row.threadId === thread.id}>
          <summary>Task · {row.status}</summary>
          <p>Original project: {row.target}</p>
          {row.error && <p role="alert">{row.error}</p>}
          {row.results.map((result: Wire, i: number) => (
            <details key={i}>
              <summary>
                {result.name} · {result.status} · exit {result.exitCode}
              </summary>
              <pre>
                {result.output}
                {result.error}
              </pre>
            </details>
          ))}
          {row.threadId !== thread.id ? (
            <button onClick={() => select(row.threadId)}>Open task worktree</button>
          ) : ['preparing', 'running', 'testing'].includes(row.status) ? (
            <button onClick={() => void call('cancel')}>Cancel managed task</button>
          ) : (
            <button
              disabled={busy}
              onClick={async () => {
                const value = await call('review');
                setPatch(value);
                setFiles(value?.files ?? []);
              }}
            >
              Review task changes
            </button>
          )}
        </details>
      ))}
      {patch && (
        <div>
          <p>
            Choose files to apply to the clean original project. Unselected changes remain in the
            task worktree. Applying stages changes in the original Git index.
          </p>
          {patch.allFiles.map((path: string) => (
            <label key={path}>
              <input
                type="checkbox"
                checked={files.includes(path)}
                onChange={(e) => {
                  setFiles(e.target.checked ? [...files, path] : files.filter((f) => f !== path));
                  setPatch({ ...patch, revision: undefined });
                }}
              />
              {path}
            </label>
          ))}
          <pre>{patch.patch}</pre>
          {!patch.revision ? (
            <button
              disabled={busy || !files.length}
              onClick={async () => setPatch(await call('review', { files }))}
            >
              Preview selected files
            </button>
          ) : (
            <button
              disabled={busy || !files.length}
              onClick={async () => {
                if (
                  window.confirm(
                    'Apply these reviewed files to the original project and stage them in Git?',
                  )
                ) {
                  const value = await call('apply', { files, revision: patch.revision });
                  if (value) setPatch(undefined);
                }
              }}
            >
              Apply reviewed files
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
