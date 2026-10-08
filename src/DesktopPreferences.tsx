import { useState } from 'react';
import type { State, Wire } from '../shared/types';
import { defaultShortcuts } from '../shared/shortcuts';
import StorageSettings from './StorageSettings';
import UpdateSettings from './UpdateSettings';
export default function DesktopPreferences({ state }: { state: State }) {
  const [shortcuts, setShortcuts] = useState({ ...defaultShortcuts, ...state.settings.shortcuts }),
    [notifications, setNotifications] = useState(state.settings.notifications ?? false),
    [budget, setBudget] = useState(state.settings.storageMiB ?? 512),
    [profileBudget, setProfileBudget] = useState(state.settings.profileMiB ?? 4096),
    [report, setReport] = useState<Wire>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [selected, setSelected] = useState<string[]>([]);
  async function inspect() {
    try {
      setReport(await window.desktop.call('diagnostics:info'));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="desktop-preferences">
      <h3>Desktop preferences</h3>
      <label>
        <input
          type="checkbox"
          checked={notifications}
          onChange={(e) => setNotifications(e.target.checked)}
        />
        Notify when Grok finishes or needs approval while this window is unfocused
      </label>
      <label className="field-label">
        Desktop database budget (MiB)
        <input
          type="number"
          min={64}
          max={2048}
          value={budget}
          onChange={(e) => setBudget(Number(e.target.value))}
        />
      </label>
      <p className="muted">
        At the budget, new turns stop until you increase it or prune exported archived chats. Native
        Grok files and exported recovery files are managed separately.
      </p>
      <label className="field-label">
        Aggregate desktop and Grok profile budget (MiB)
        <input
          type="number"
          min={256}
          max={1048576}
          value={profileBudget}
          onChange={(e) => setProfileBudget(Number(e.target.value))}
        />
      </label>
      <p className="muted">
        New prompts, queued prompts, media generation and attachment imports stop at 90% of the
        aggregate budget. Existing native processes may continue writing; this is an admission
        limit, not a disk reservation.
      </p>
      <h4>Keyboard shortcuts</h4>
      {Object.entries(shortcuts).map(([key, value]) => (
        <label className="field-label" key={key}>
          {key}
          <input
            aria-label={`Shortcut ${key}`}
            value={value}
            onChange={(e) => setShortcuts({ ...shortcuts, [key]: e.target.value })}
          />
        </label>
      ))}
      <button
        onClick={async () => {
          try {
            await window.desktop.call('preferences:save', {
              shortcuts,
              notifications,
              storageMiB: budget,
              profileMiB: profileBudget,
            });
            setNotice('Desktop preferences saved.');
            setError('');
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Save desktop preferences
      </button>
      <button onClick={() => setShortcuts({ ...defaultShortcuts })}>Reset shortcut fields</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <h3>Diagnostics and storage</h3>
      <StorageSettings state={state} />
      <UpdateSettings />
      <button onClick={() => void inspect()}>Refresh diagnostics</button>
      {report && (
        <>
          <pre>{JSON.stringify({ ...report, events: undefined }, null, 2)}</pre>
          <details>
            <summary>Recent diagnostic events (last 100)</summary>
            <pre>{JSON.stringify(report.events.slice(-100), null, 2)}</pre>
          </details>
        </>
      )}
      <p className="muted">
        Diagnostics contain operation names, timing and counts. Prompts, tool output, file contents
        and provider credentials are excluded. Diagnostic logs rotate at 512 KiB, keeping four
        files.
      </p>
      <h4>Export and prune archived desktop history</h4>
      <p>Export chats you want to keep before deleting them. Native CLI sessions are retained.</p>
      {state.threads
        .filter((t) => t.archived)
        .map((t) => (
          <div className="workflow-row" key={t.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(t.id)}
                onChange={() =>
                  setSelected(
                    selected.includes(t.id)
                      ? selected.filter((x) => x !== t.id)
                      : [...selected, t.id],
                  )
                }
              />
              {t.title} · {t.entryCount ?? 0} entries
            </label>
            <button
              onClick={() =>
                void window.desktop
                  .call('history:export', { id: t.id })
                  .catch((e) => setError(String(e)))
              }
            >
              Export transcript
            </button>
          </div>
        ))}
      <button
        disabled={!selected.length}
        onClick={async () => {
          if (
            !window.confirm(
              `Permanently delete ${selected.length} archived desktop transcripts and comments? Export them first if needed.`,
            )
          )
            return;
          try {
            await window.desktop.call('history:prune', { ids: selected, confirmed: true });
            setSelected([]);
            await inspect();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Delete selected archived history
      </button>
    </section>
  );
}
