import { useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export default function WorktreeTools({
  thread,
  select,
}: {
  thread: Thread;
  select: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<Wire>(),
    [review, setReview] = useState<Wire>(),
    [archive, setArchive] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<Wire>();
  async function run(operation: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const value = await window.desktop.call(`worktrees:${operation}`, { id: thread.id, ...args });
      if (operation === 'preview') setReview(value);
      else if (['attach', 'restore'].includes(operation)) select(value.id);
      else if (operation === 'archive') select(value.returnThreadId);
      else {
        setResult(value);
        setReview(undefined);
        setCatalog(await window.desktop.call('worktrees:list', { id: thread.id }));
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mcp-settings">
      <h3>Repository worktrees</h3>
      <p>
        Attach an existing checkout, move this conversation by native fork, or review changes before
        applying them to a clean checkout. Archive preserves history and non-ignored files in a Git
        recovery ref.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setCatalog(await window.desktop.call('worktrees:list', { id: thread.id }));
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Inspect worktrees
      </button>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {catalog?.rows.map((row: Wire) => (
        <div className="mcp-server" key={row.path}>
          <strong>{row.branch ?? 'Detached HEAD'}</strong>
          <code>{row.path}</code>
          <div className="mcp-actions">
            <button disabled={busy} onClick={() => void run('attach', { path: row.path })}>
              Open as new chat
            </button>
            <button
              disabled={busy || row.path.toLowerCase() === thread.cwd.toLowerCase()}
              onClick={() => void run('handoff', { path: row.path })}
            >
              Move conversation here
            </button>
            <button
              disabled={busy || row.path.toLowerCase() === thread.cwd.toLowerCase()}
              onClick={() => void run('preview', { path: row.path })}
            >
              Review apply to this checkout
            </button>
          </div>
        </div>
      ))}
      {review && (
        <div>
          <p>
            Apply the reviewed patch to {review.target}? Changes are staged in the target checkout.
          </p>
          <pre>{review.patch}</pre>
          <button
            disabled={busy}
            onClick={() => void run('apply', { path: review.target, revision: review.revision })}
          >
            Apply reviewed patch
          </button>
          <button onClick={() => setReview(undefined)}>Cancel apply</button>
        </div>
      )}
      <button disabled={busy} onClick={() => setArchive(true)}>
        Archive this app-created worktree
      </button>
      {archive && (
        <div>
          <p>
            Save a recoverable snapshot, remove this checkout and archive its chats? Ignored files,
            submodules and embedded repositories must be preserved separately; their presence blocks
            removal.
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setArchive(false);
              void run('archive');
            }}
          >
            Confirm recoverable archive
          </button>
          <button onClick={() => setArchive(false)}>Keep checkout</button>
        </div>
      )}
      {catalog?.archives.map((item: Wire) => (
        <div className="mcp-server" key={item.id}>
          <code>{item.path}</code>
          <button disabled={busy} onClick={() => void run('restore', { archiveId: item.id })}>
            Restore archive
          </button>
        </div>
      ))}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}
