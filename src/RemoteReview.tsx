import { useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export default function RemoteReview({
  thread,
  number,
  close,
}: {
  thread: Thread;
  number: number;
  close: () => void;
}) {
  const [diff, setDiff] = useState<Wire>(),
    [preview, setPreview] = useState<Wire>(),
    [path, setPath] = useState(''),
    [side, setSide] = useState('RIGHT'),
    [line, setLine] = useState(1),
    [comment, setComment] = useState(''),
    [comments, setComments] = useState<Wire[]>([]),
    [body, setBody] = useState(''),
    [event, setEvent] = useState('COMMENT'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<Wire>();
  async function run(method: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const value = await window.desktop.call(`review:remote-${method}`, {
        id: thread.id,
        number,
        ...args,
      });
      if (method === 'diff') {
        setDiff(value);
        setPath(value.files[0]?.path ?? '');
        setPreview(undefined);
      } else if (method === 'preview') setPreview(value);
      else {
        setResult(value);
        setPreview(undefined);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={`Remote review PR ${number}`}>
      <h4>Remote review · PR #{number}</h4>
      <button onClick={close}>Close remote review</button>
      <button disabled={busy} onClick={() => void run('diff')}>
        Fetch remote PR diff
      </button>
      {diff && (
        <>
          <p>
            {diff.repository} · {diff.title}
          </p>
          <p>
            Reviewed commit: <code>{diff.head}</code>
          </p>
          <label>
            Remote review file{' '}
            <select
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setPreview(undefined);
              }}
            >
              {diff.files.map((f: Wire) => (
                <option key={f.path}>{f.path}</option>
              ))}
            </select>
          </label>
          <pre>
            {diff.files.find((f: Wire) => f.path === path)?.patch ||
              'No inline patch available. Use a summary review for this file.'}
          </pre>
          <label>
            Comment side{' '}
            <select value={side} onChange={(e) => setSide(e.target.value)}>
              <option>RIGHT</option>
              <option>LEFT</option>
            </select>
          </label>
          <label>
            Remote line number{' '}
            <input
              type="number"
              min={1}
              value={line}
              onChange={(e) => setLine(Number(e.target.value))}
            />
          </label>
          <label>
            Remote inline comment{' '}
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          {thread.reviewComments?.length ? (
            <label>
              Copy a local comment draft{' '}
              <select
                value=""
                onChange={(e) => {
                  const c = thread.reviewComments?.find((c) => c.id === e.target.value);
                  if (c) {
                    setPath(c.path);
                    setLine(c.line);
                    setSide(c.side.toUpperCase());
                    setComment(c.body);
                    setPreview(undefined);
                  }
                }}
              >
                <option value="">Choose a local draft</option>
                {thread.reviewComments.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.path}:{c.line} · {c.body.slice(0, 60)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="muted">
            Check copied drafts against this remote diff before adding them. Local working changes
            may differ from the published PR.
          </p>
          <button
            disabled={busy || !comment.trim() || comments.length >= 50}
            onClick={() => {
              setComments([...comments, { path, line, side, body: comment }]);
              setComment('');
              setPreview(undefined);
            }}
          >
            Add remote comment draft
          </button>
          {comments.map((c, i) => (
            <div key={i}>
              <p>
                {c.path}:{c.line} ({c.side}) · {c.body}
              </p>
              <button
                onClick={() => {
                  setComments(comments.filter((_, index) => index !== i));
                  setPreview(undefined);
                }}
              >
                Remove draft {i + 1}
              </button>
            </div>
          ))}
          <label>
            Review summary{' '}
            <textarea
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          <label>
            Review action{' '}
            <select
              value={event}
              onChange={(e) => {
                setEvent(e.target.value);
                setPreview(undefined);
              }}
            >
              <option value="COMMENT">Comment</option>
              <option value="APPROVE">Approve</option>
              <option value="REQUEST_CHANGES">Request changes</option>
            </select>
          </label>
          <button
            disabled={busy || (!body.trim() && !comments.length)}
            onClick={() =>
              void run('preview', { diffRevision: diff.revision, event, body, comments })
            }
          >
            Review remote submission
          </button>
        </>
      )}
      {preview && (
        <div>
          <p>
            Publish {preview.event} to {preview.repository} PR #{preview.number}, commit{' '}
            {preview.head}?
          </p>
          <pre>{preview.body}</pre>
          {preview.comments.map((c: Wire, i: number) => (
            <pre key={i}>
              {c.path}:{c.line} ({c.side}){'\n'}
              {c.context}
              {'\n'}
              {c.body}
            </pre>
          ))}
          <button
            disabled={busy}
            onClick={() => void run('submit', { revision: preview.revision, confirmed: true })}
          >
            Submit reviewed GitHub review
          </button>
          <button onClick={() => setPreview(undefined)}>Cancel remote submission</button>
        </div>
      )}
      {result && (
        <p role="status">
          Review #{result.id}: {result.state} ·{' '}
          <button onClick={() => void window.desktop.call('external:open', { url: result.url })}>
            Open submitted review
          </button>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
