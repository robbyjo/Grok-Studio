import { useEffect, useRef, useState } from 'react';
import type { FileItem, Thread, Wire } from '../shared/types';
import FileEditor, { type FileDraft } from './FileEditor';
export default function WorkspaceFiles({
  thread,
  drafts,
  update,
  busy,
}: {
  thread: Thread;
  drafts: Record<string, FileDraft>;
  update: (path: string, draft: FileDraft) => void;
  busy: boolean;
}) {
  const [folder, setFolder] = useState('.'),
    [items, setItems] = useState<FileItem[]>([]),
    [tabs, setTabs] = useState<string[]>([]),
    [active, setActive] = useState<string>(),
    [ready, setReady] = useState(false);
  const [query, setQuery] = useState(''),
    [contents, setContents] = useState(false),
    [results, setResults] = useState<Wire>(),
    [error, setError] = useState(''),
    [searching, setSearching] = useState(false),
    [location, setLocation] = useState<Wire>();
  const generation = useRef(0);
  const [newPath, setNewPath] = useState(''),
    [newFolder, setNewFolder] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    void window.desktop
      .call<Wire>('files:tabs', { id: thread.id })
      .then((value) => {
        if (alive) {
          // Opening a file can beat restoration on a slow IPC round-trip.
          // Preserve that explicit choice and merge restored tabs behind it.
          setTabs((current) => [...new Set([...(value.paths ?? []), ...current])].slice(-20));
          setActive((current) => current ?? value.active);
          setReady(true);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(String(e));
          setReady(true);
        }
      });
    return () => {
      alive = false;
      generation.current++;
      void window.desktop.call('files:cancel-search', { id: thread.id }).catch(() => {});
    };
  }, [thread.id]);
  useEffect(() => {
    if (ready)
      void window.desktop
        .call('files:tabs', { id: thread.id, paths: tabs, active })
        .catch((e) => setError(String(e)));
  }, [ready, thread.id, tabs, active]);
  useEffect(() => {
    let alive = true;
    void window.desktop
      .call<FileItem[]>('files:list', { id: thread.id, path: folder })
      .then((v) => {
        if (alive) setItems(v);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [thread.id, folder, revision]);
  function open(path: string, hit?: Wire) {
    if (!tabs.includes(path)) {
      if (tabs.length >= 20) {
        setError('Close a tab before opening another (20 tab limit).');
        return;
      }
      setTabs([...tabs, path]);
    }
    setActive(path);
    setLocation(hit);
  }
  async function search(offset = 0) {
    const current = ++generation.current;
    setSearching(true);
    setError('');
    try {
      const value = await window.desktop.call<Wire>('files:search', {
        id: thread.id,
        query,
        contents,
        offset,
      });
      if (current === generation.current) setResults(value);
    } catch (e) {
      if (current === generation.current) setError(String(e));
    } finally {
      if (current === generation.current) setSearching(false);
    }
  }
  return (
    <div className="workspace-files">
      <details>
        <summary>Create or rename files</summary>
        <label>
          Workspace path
          <input
            aria-label="New workspace path"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={newFolder}
            onChange={(e) => setNewFolder(e.target.checked)}
          />
          Create folder
        </label>
        <button
          disabled={busy || !newPath.trim()}
          onClick={async () => {
            try {
              const result = await window.desktop.call('files:create', {
                id: thread.id,
                path: newPath,
                folder: newFolder,
              });
              setRevision((v) => v + 1);
              if (!newFolder) open(result.path);
              setNewPath('');
              setError('');
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Create workspace entry
        </button>
        <button
          disabled={busy || !active || !newPath.trim() || newFolder}
          onClick={async () => {
            try {
              const draft = drafts[thread.cwd + '\0' + active!];
              if (!draft || draft.text !== draft.savedText)
                throw new Error('Save the active draft before renaming.');
              const result = await window.desktop.call('files:rename', {
                id: thread.id,
                path: active,
                destination: newPath,
                revision: draft.revision,
              });
              setTabs(tabs.map((p) => (p === active ? result.path : p)));
              setActive(result.path);
              setNewPath('');
              setRevision((v) => v + 1);
              setError('');
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          Rename active file
        </button>
      </details>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Project file search"
          placeholder="Search project"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={contents}
            onChange={(e) => setContents(e.target.checked)}
          />
          Search contents
        </label>
        <button disabled={searching || !query.trim()}>Search files</button>
        {searching && (
          <button
            type="button"
            onClick={() => {
              generation.current++;
              setSearching(false);
              void window.desktop.call('files:cancel-search', { id: thread.id });
            }}
          >
            Cancel search
          </button>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
      {results && (
        <div className="project-search-results">
          <button onClick={() => setResults(undefined)}>Close search results</button>
          <small>
            {results.hits.length} matches · {results.scanned} entries scanned
            {results.limited ? ' · scan limit reached' : ''}
          </small>
          {results.hits.map((hit: Wire, i: number) => (
            <button key={i} onClick={() => open(hit.path, hit)}>
              {hit.path}
              {hit.line ? `:${hit.line}` : ''}
              <small>{hit.text}</small>
            </button>
          ))}
          {results.next !== null && (
            <button onClick={() => void search(results.next)}>Next matches</button>
          )}
        </div>
      )}
      <div className="editor-tabs" role="tablist" aria-label="Open files">
        {tabs.map((path) => (
          <span key={path}>
            <button
              role="tab"
              aria-selected={active === path}
              tabIndex={active === path || (!active && tabs[0] === path) ? 0 : -1}
              onKeyDown={(event) => {
                const index = tabs.indexOf(path);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setActive(tabs[next]);
                setLocation(undefined);
                const list = event.currentTarget.closest('[role="tablist"]');
                queueMicrotask(() =>
                  list?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(),
                );
              }}
              onClick={() => {
                setActive(path);
                setLocation(undefined);
              }}
            >
              {path}
              {drafts[thread.cwd + '\0' + path]?.text !==
              drafts[thread.cwd + '\0' + path]?.savedText
                ? ' *'
                : ''}
            </button>
            <button
              aria-label={`Close ${path}`}
              onClick={() => {
                setTabs(tabs.filter((p) => p !== path));
                if (active === path) setActive(tabs.find((p) => p !== path));
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {active ? (
        <>
          <div className="file-preview-heading">
            <button aria-label="Back to files" onClick={() => setActive(undefined)}>
              Back to files
            </button>
            <span>{active}</span>
          </div>
          <FileEditor
            key={active}
            id={thread.id}
            path={active}
            draft={drafts[thread.cwd + '\0' + active]}
            update={(draft) => update(active, draft)}
            busy={busy}
            location={location}
            navigate={(path, hit) => open(path, hit)}
          />
        </>
      ) : (
        <>
          <div className="file-path">
            <span>{folder}</span>
            {folder !== '.' && (
              <button
                onClick={() => setFolder(folder.split(/[\\/]/).slice(0, -1).join('/') || '.')}
              >
                Up one folder
              </button>
            )}
          </div>
          <div className="file-list">
            {items.map((item) => (
              <button
                key={item.path}
                onClick={() => (item.directory ? setFolder(item.path) : open(item.path))}
              >
                {item.directory ? '▸ ' : ''}
                {item.name}
              </button>
            ))}
          </div>
        </>
      )}
      <small>
        Closing a tab keeps its unsaved draft. Search skips links, credentials and generated
        folders; results are bounded.
      </small>
    </div>
  );
}
