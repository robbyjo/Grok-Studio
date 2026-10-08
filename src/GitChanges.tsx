import { useEffect, useRef, useState } from 'react';
import type { GitState } from '../shared/types';
import GitChunkReview from './GitChunkReview';

function Diff({ text }: { text: string }) {
  return (
    <div className="diff-view">
      {text ? (
        text.split('\n').map((line, index) => (
          <div
            key={index}
            className={
              line.startsWith('+')
                ? 'addition'
                : line.startsWith('-')
                  ? 'deletion'
                  : line.startsWith('@@')
                    ? 'hunk'
                    : line.startsWith('diff ')
                      ? 'diff-file'
                      : ''
            }
          >
            {line || ' '}
          </div>
        ))
      ) : (
        <div className="clean-state">
          <p>No changes in this view.</p>
        </div>
      )}
    </div>
  );
}
export default function GitChanges({
  id,
  git,
  busy,
  refresh,
}: {
  id: string;
  git: GitState;
  busy: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string>(),
    [staged, setStaged] = useState(false),
    [diff, setDiff] = useState('');
  const [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [review, setReview] = useState<{ revision: string; diff: string; paths: string[] }>();
  const [notice, setNotice] = useState('');
  const request = useRef(0);
  useEffect(() => {
    const sequence = ++request.current;
    if (!selected) {
      setDiff(staged ? git.staged : git.diff);
      return;
    }
    setDiff('Loading file diff…');
    void window.desktop
      .call<string>('git:diff', { id, path: selected, staged })
      .then((text) => {
        if (sequence === request.current) setDiff(text);
      })
      .catch((failure) => {
        if (sequence === request.current) setDiff((failure as Error).message);
      });
    return () => {
      request.current++;
    };
  }, [id, selected, staged, git]);
  async function action(method: string, args: Record<string, unknown>) {
    setWorking(true);
    setError('');
    setNotice('');
    try {
      const result = await window.desktop.call(method, { id, ...args });
      await refresh();
      return result;
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const indexed = git.files.filter((file) => ![' ', '?'].includes(file.index));
  if (!git.isRepository)
    return (
      <div className="clean-state" role="status">
        <h3>Git hasn’t been set up for this project.</h3>
        <p>You can still use chats, edit files and run commands in the terminal.</p>
        <p>
          To enable changes, commits and worktrees, run <code>git init</code> in the project
          terminal or open an existing Git repository, then refresh this view.
        </p>
      </div>
    );
  return (
    <>
      {error && (
        <div className="panel-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="git-notice" role="status">
          {notice}
        </p>
      )}
      <div className="git-files">
        {!git.files.length && <p>Working tree clean</p>}
        {git.files.map((file) => (
          <div className="git-file" key={file.path}>
            <button
              className={selected === file.path ? 'selected' : ''}
              aria-label={`Inspect ${file.path}`}
              onClick={() => {
                setSelected(file.path);
                setStaged(file.worktree === ' ');
              }}
            >
              <code>
                {file.index}
                {file.worktree}
              </code>
              <span title={file.path}>{file.path}</span>
              {file.conflicted && <small>Conflict</small>}
            </button>
            {file.worktree !== ' ' && (
              <button
                disabled={busy || working}
                aria-label={`Stage ${file.path}`}
                onClick={() =>
                  void action('git:update', {
                    operation: 'stage',
                    path: file.path,
                    revision: git.indexRevision,
                  })
                }
              >
                Stage
              </button>
            )}
            {![' ', '?'].includes(file.index) && (
              <button
                disabled={busy || working}
                aria-label={`Unstage ${file.path}`}
                onClick={() =>
                  void action('git:update', {
                    operation: 'unstage',
                    path: file.path,
                    revision: git.indexRevision,
                  })
                }
              >
                Unstage
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="diff-tabs">
        <button className={!staged ? 'selected' : ''} onClick={() => setStaged(false)}>
          Unstaged
        </button>
        <button className={staged ? 'selected' : ''} onClick={() => setStaged(true)}>
          Staged
        </button>
        {selected && <button onClick={() => setSelected(undefined)}>All files</button>}
      </div>
      {selected && <small className="selected-diff-path">{selected}</small>}
      <Diff text={diff} />
      {selected && (
        <GitChunkReview
          key={`${id}:${selected}:${staged}`}
          id={id}
          path={selected}
          staged={staged}
          busy={busy || working}
          refresh={refresh}
        />
      )}
      <div className="git-commit">
        <button
          disabled={busy || working || !indexed.length || git.files.some((file) => file.conflicted)}
          onClick={() => {
            setReview({
              revision: git.indexRevision,
              diff: git.staged,
              paths: indexed.map((file) => file.path),
            });
            setMessage('');
          }}
        >
          Review staged commit
        </button>
        {review && (
          <div className="commit-review">
            <strong>Commit {review.paths.length} staged file(s)</strong>
            <pre>{review.paths.join('\n')}</pre>
            <details>
              <summary>Review staged diff</summary>
              <Diff text={review.diff} />
            </details>
            <label htmlFor="commit-message">Commit message</label>
            <textarea
              id="commit-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={3}
            />
            {review.revision !== git.indexRevision && (
              <p>Staged index changed. Refresh and open a new review.</p>
            )}
            <p>
              Commits the reviewed staged index. Unstaged edits stay on disk. Repository Git hooks
              may run.
            </p>
            <button
              disabled={busy || working || !message.trim() || review.revision !== git.indexRevision}
              onClick={async () => {
                const commit = await action('git:commit', { message, revision: review.revision });
                if (commit) {
                  setNotice(`Committed ${String(commit).slice(0, 12)}`);
                  setReview(undefined);
                }
              }}
            >
              Commit staged index
            </button>
            <button disabled={working} onClick={() => setReview(undefined)}>
              Cancel commit
            </button>
          </div>
        )}
      </div>
      <details className="worktree-list">
        <summary>Worktrees</summary>
        <pre>{git.worktrees}</pre>
      </details>
    </>
  );
}
