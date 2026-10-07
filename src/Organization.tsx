import { useState } from 'react';
import type { State, Wire } from '../shared/types';
export default function Organization({
  state,
  close,
  updated,
}: {
  state: State;
  close: () => void;
  updated: (state: State) => void;
}) {
  const [projects, setProjects] = useState<string[]>([]),
    [chats, setChats] = useState<string[]>([]),
    [group, setGroup] = useState(''),
    [error, setError] = useState('');
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  async function run(method: string, args: Wire) {
    try {
      await window.desktop.call(method, args);
      updated(await window.desktop.call('state'));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal workflow-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Organize projects and chats"
      >
        <div className="modal-header">
          <h2>Organize projects and chats</h2>
          <button onClick={close}>Close</button>
        </div>
        {error && <p role="alert">{error}</p>}
        <h3>Projects</h3>
        <div className="input-row">
          <input
            aria-label="Project group name"
            maxLength={80}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
          <button
            disabled={!projects.length}
            onClick={() => void run('organization:projects', { projectIds: projects, group })}
          >
            Set group
          </button>
        </div>
        <div className="input-row">
          <button
            disabled={!projects.length}
            onClick={() =>
              void run('organization:projects', { projectIds: projects, pinned: true })
            }
          >
            Pin projects
          </button>
          <button
            disabled={!projects.length}
            onClick={() =>
              void run('organization:projects', { projectIds: projects, pinned: false })
            }
          >
            Unpin projects
          </button>
          <button
            disabled={!projects.length}
            onClick={() => {
              if (
                window.confirm(
                  `Remove ${projects.length} projects from the sidebar? Files and chats remain.`,
                )
              )
                void run('organization:projects', { projectIds: projects, hidden: true });
            }}
          >
            Remove projects
          </button>
          <button
            disabled={!projects.length}
            onClick={() =>
              void run('organization:projects', { projectIds: projects, hidden: false })
            }
          >
            Restore projects
          </button>
        </div>
        {[...state.projects]
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((p, index, list) => (
            <div className="workflow-row" key={p.id}>
              <label>
                <input
                  type="checkbox"
                  checked={projects.includes(p.id)}
                  onChange={() => setProjects(toggle(projects, p.id))}
                />
                {p.pinned ? 'Pinned · ' : ''}
                {p.name} · {p.group || 'Ungrouped'}
                {p.hidden ? ' · Removed' : ''}
              </label>
              <button
                disabled={!index}
                aria-label={`Move project ${p.name} up`}
                onClick={() => {
                  const order = list.map((p) => p.id);
                  [order[index - 1], order[index]] = [order[index], order[index - 1]];
                  void run('organization:projects', { projectIds: [p.id], order });
                }}
              >
                Move up
              </button>
            </div>
          ))}
        <h3>Chats</h3>
        <div className="input-row">
          <button
            disabled={!chats.length}
            onClick={() => void run('organization:chats', { ids: chats, pinned: true })}
          >
            Pin chats
          </button>
          <button
            disabled={!chats.length}
            onClick={() => void run('organization:chats', { ids: chats, pinned: false })}
          >
            Unpin chats
          </button>
          <button
            disabled={!chats.length}
            onClick={() => void run('organization:chats', { ids: chats, archived: true })}
          >
            Archive chats
          </button>
          <button
            disabled={!chats.length}
            onClick={() => void run('organization:chats', { ids: chats, archived: false })}
          >
            Restore chats
          </button>
        </div>
        {state.threads.map((t) => (
          <label className="workflow-row" key={t.id}>
            <input
              type="checkbox"
              checked={chats.includes(t.id)}
              onChange={() => setChats(toggle(chats, t.id))}
            />
            {t.title}
            {t.archived ? ' · Archived' : ''}
          </label>
        ))}
        {state.pagination?.hasMore && (
          <button
            onClick={async () =>
              updated(
                await window.desktop.call('state', {
                  limit: Math.min(10000, state.pagination!.limit + 100),
                }),
              )
            }
          >
            Load more chats
          </button>
        )}
      </section>
    </div>
  );
}
