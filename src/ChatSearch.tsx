import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { SearchHit, SearchResults } from '../shared/types';

export default function ChatSearch({
  close,
  select,
}: {
  close: () => void;
  select: (hit: SearchHit) => void;
}) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<SearchResults>({ hits: [], truncated: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    setResult({ hits: [], truncated: false });
    setError('');
    setBusy(Boolean(query.trim()));
    // Cancel the previous native scan immediately, before the input debounce.
    void window.desktop.call('chats:search-cancel').catch(() => {});
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      void window.desktop
        .call<SearchResults>('chats:search', { query, archived, hidden })
        .then((result) => {
          if (sequence.current === request) setResult(result);
        })
        .catch((error) => {
          if (sequence.current === request) setError(String(error));
        })
        .finally(() => {
          if (sequence.current === request) setBusy(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      sequence.current++;
      void window.desktop.call('chats:search-cancel').catch(() => {});
    };
  }, [query, archived, hidden, refresh]);
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal chat-search"
        role="dialog"
        aria-label="Search chats"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close();
        }}
      >
        <div className="modal-header">
          <h2>Search chats</h2>
          <button className="icon-button" aria-label="Close search" onClick={close}>
            <X size={18} />
          </button>
        </div>
        <label className="field-label" htmlFor="transcript-query">
          Titles and full saved transcripts
        </label>
        <div className="input-row">
          <Search size={18} />
          <input
            id="transcript-query"
            autoFocus
            maxLength={512}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a phrase, file name, or tool output…"
          />
        </div>
        <div className="search-options">
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            Include archived chats
          </label>
          <label>
            <input
              type="checkbox"
              checked={hidden}
              onChange={(event) => setHidden(event.target.checked)}
            />
            Include removed projects
          </label>
          <button onClick={() => setRefresh((value) => value + 1)} disabled={busy || !query.trim()}>
            Refresh results
          </button>
        </div>
        <p className="muted">
          Literal phrase search, ignoring case. Searches this desktop profile’s saved messages,
          reasoning, plans and tool activity. Results open the matching message.
        </p>
        <p role="status">
          {busy
            ? 'Searching…'
            : query.trim()
              ? `${result.hits.length} ${result.hits.length === 1 ? 'result' : 'results'}${result.truncated ? ' · First 100 shown; narrow your search.' : ''}`
              : 'Enter text to search.'}
        </p>
        {error && <p role="alert">{error}</p>}
        <div className="search-results">
          {result.hits.map((hit) => (
            <button
              key={`${hit.threadId}:${hit.entryId ?? 'title'}`}
              className="search-hit"
              onClick={() => select(hit)}
            >
              <strong>{hit.title}</strong>
              <small>
                {hit.projectName} · {hit.kind}
                {hit.archived ? ' · Archived' : ''}
                {hit.hidden ? ' · Removed project' : ''}
              </small>
              <span>
                {hit.before}
                <mark>{hit.match}</mark>
                {hit.after}
              </span>
            </button>
          ))}
          {!busy && query.trim() && !result.hits.length && !error && (
            <p>No matches in the selected scope.</p>
          )}
        </div>
      </section>
    </div>
  );
}
