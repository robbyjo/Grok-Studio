import { useEffect, useState } from 'react';
import type { Wire } from '../shared/types';
export default function GitChunkReview({
  id,
  path,
  staged,
  busy,
  refresh,
}: {
  id: string;
  path: string;
  staged: boolean;
  busy: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [data, setData] = useState<Wire>(),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const [selected, setSelected] = useState<Wire>(),
    [body, setBody] = useState(''),
    [revert, setRevert] = useState<number>();
  async function load() {
    setData(await window.desktop.call('review:chunks', { id, path, staged }));
  }
  useEffect(() => {
    let alive = true;
    window.desktop
      .call('review:chunks', { id, path, staged })
      .then((value) => {
        if (alive) {
          setData(value);
          setError('');
        }
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [id, path, staged, busy]);
  async function run(method: string, input: Wire) {
    setWorking(true);
    setError('');
    try {
      await window.desktop.call(method, { id, path, staged, revision: data?.revision, ...input });
      await load();
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <details className="git-commit">
      <summary>Chunks and inline review comments</summary>
      <button
        disabled={busy || working}
        onClick={() => void load().catch((error) => setError(error.message))}
      >
        Refresh reviewed chunks
      </button>
      {error && <p role="alert">{error}</p>}
      {data?.hunks.map((hunk: string, chunk: number) => {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(hunk);
        let oldLine = Number(match?.[1]),
          newLine = Number(match?.[2]);
        return (
          <div key={chunk}>
            <strong>Chunk {chunk + 1}</strong>
            <div className="diff-view">
              {hunk.split('\n').map((line, index) => {
                const isCode = !!line && !line.startsWith('@@') && !line.startsWith('\\');
                const side = line.startsWith('-') ? 'left' : 'right';
                const number = side === 'left' ? oldLine : newLine;
                if (isCode) {
                  if (!line.startsWith('+')) oldLine++;
                  if (!line.startsWith('-')) newLine++;
                }
                return (
                  <div
                    key={index}
                    className={
                      line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : ''
                    }
                  >
                    {isCode && (
                      <button
                        aria-label={`Comment ${side} line ${number}`}
                        onClick={() => {
                          setSelected({ side, line: number });
                          setBody('');
                        }}
                      >
                        {' '}
                        {number}{' '}
                      </button>
                    )}
                    {line}
                  </div>
                );
              })}
            </div>
            <button
              disabled={busy || working}
              onClick={() =>
                void run('review:chunk', { chunk, operation: staged ? 'unstage' : 'stage' })
              }
            >
              {staged ? 'Unstage' : 'Stage'} chunk
            </button>
            {!staged && (
              <button disabled={busy || working} onClick={() => setRevert(chunk)}>
                Review revert chunk
              </button>
            )}
            {revert === chunk && (
              <div>
                <p>
                  Revert this chunk on disk? The current file is saved in a recovery record first.
                </p>
                <button
                  disabled={busy || working}
                  onClick={() => {
                    void run('review:chunk', { chunk, operation: 'revert', reviewed: true });
                    setRevert(undefined);
                  }}
                >
                  Confirm revert
                </button>
                <button onClick={() => setRevert(undefined)}>Keep changes</button>
              </div>
            )}
          </div>
        );
      })}
      {data && !data.hunks.length && (
        <p>
          Chunk actions support tracked text modifications. Use file actions for new, deleted,
          renamed or binary files.
        </p>
      )}
      {selected && (
        <div>
          <label>
            Local comment on {selected.side} line {selected.line}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <button
            disabled={busy || working || !body.trim()}
            onClick={() => {
              void run('review:comment', { ...selected, body });
              setSelected(undefined);
            }}
          >
            Save local review comment
          </button>
        </div>
      )}
      {data?.comments
        .filter((comment: Wire) => comment.path === path)
        .map((comment: Wire) => (
          <div key={comment.id}>
            <small>
              {comment.side} line {comment.line} ·{' '}
              {comment.revision === data.revision ? 'Current diff' : 'Older diff'}
            </small>
            <p>{comment.body}</p>
            <button onClick={() => void run('review:remove-comment', { commentId: comment.id })}>
              Remove comment
            </button>
          </div>
        ))}
      <p>Comments stay in this chat. They are not published to GitHub.</p>
    </details>
  );
}
