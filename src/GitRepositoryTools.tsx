import { useState } from 'react';
import type { Thread, Wire } from '../shared/types';
import RemoteReview from './RemoteReview';
export default function GitRepositoryTools({ thread }: { thread: Thread }) {
  const [catalog, setCatalog] = useState<Wire>(),
    [push, setPush] = useState<Wire>(),
    [pr, setPr] = useState<Wire>(),
    [prs, setPrs] = useState<Wire[]>([]);
  const [reviewNumber, setReviewNumber] = useState<number>();
  const [name, setName] = useState('codex/'),
    [base, setBase] = useState('HEAD'),
    [existing, setExisting] = useState(false),
    [remote, setRemote] = useState('origin');
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [prBase, setPrBase] = useState('main'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState('');
  async function run(operation: string, input: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const value = await window.desktop.call(`review:${operation}`, { id: thread.id, ...input });
      if (operation === 'branches' || operation === 'branch') setCatalog(value);
      else if (operation === 'push-preview') setPush(value);
      else if (operation === 'pr-preview') setPr(value);
      else if (operation === 'prs') setPrs(value);
      else {
        setResult(String(value));
        setPush(undefined);
        setPr(undefined);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mcp-settings">
      <h3>Branches, push and pull requests</h3>
      <button disabled={busy} onClick={() => void run('branches')}>
        Inspect branches and remotes
      </button>
      {catalog && (
        <p>
          Current: {catalog.current} · Available: {catalog.branches.join(', ')}
        </p>
      )}
      <label>
        Branch
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Base reference
        <input disabled={existing} value={base} onChange={(event) => setBase(event.target.value)} />
      </label>
      <label>
        <input
          type="checkbox"
          checked={existing}
          onChange={(event) => setExisting(event.target.checked)}
        />
        Switch to an existing local branch
      </label>
      <button disabled={busy} onClick={() => void run('branch', { name, base, existing })}>
        Create / switch branch in clean checkout
      </button>
      <label>
        Remote
        <select value={remote} onChange={(event) => setRemote(event.target.value)}>
          {(catalog?.remotes ?? ['origin']).map((name: string) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <button disabled={busy} onClick={() => void run('push-preview', { remote })}>
        Review push
      </button>
      {push && (
        <div>
          <pre>
            {push.url}
            {'\n'}
            {push.branch}
            {'\n'}
            {push.head}
          </pre>
          <p>Push this commit to the remote branch and set upstream? Force push is unavailable.</p>
          <button
            disabled={busy}
            onClick={() => void run('push', { remote: push.remote, revision: push.revision })}
          >
            Push reviewed branch
          </button>
          <button onClick={() => setPush(undefined)}>Cancel push</button>
        </div>
      )}
      <p>
        GitHub PRs use an installed GitHub CLI and its account authentication. Run gh auth login in
        the terminal if needed.
      </p>
      <button disabled={busy} onClick={() => void run('prs')}>
        List open pull requests
      </button>
      {prs.map((item) => (
        <div key={item.number}>
          <button onClick={() => void window.desktop.call('external:open', { url: item.url })}>
            #{item.number} {item.title}
          </button>
          <small>
            {item.headRefName} → {item.baseRefName}
          </small>
          <button disabled={busy} onClick={() => setReviewNumber(item.number)}>
            Review PR #{item.number}
          </button>
        </div>
      ))}
      {reviewNumber && (
        <RemoteReview
          key={reviewNumber}
          thread={thread}
          number={reviewNumber}
          close={() => setReviewNumber(undefined)}
        />
      )}
      <label>
        PR title
        <input
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setPr(undefined);
          }}
        />
      </label>
      <label>
        Description
        <textarea
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            setPr(undefined);
          }}
        />
      </label>
      <label>
        Base branch
        <input
          value={prBase}
          onChange={(event) => {
            setPrBase(event.target.value);
            setPr(undefined);
          }}
        />
      </label>
      <button
        disabled={busy || !title.trim()}
        onClick={() => void run('pr-preview', { title, body, base: prBase })}
      >
        Review draft pull request
      </button>
      {pr && (
        <div>
          <p>
            {pr.repository}: {pr.head} → {pr.base}
          </p>
          <strong>{pr.title}</strong>
          <pre>{pr.body}</pre>
          <button disabled={busy} onClick={() => void run('pr-create', pr)}>
            Publish reviewed draft PR
          </button>
          <button onClick={() => setPr(undefined)}>Cancel PR</button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {result && <pre>{result}</pre>}
    </div>
  );
}
