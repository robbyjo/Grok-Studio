import { useEffect, useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export default function ProjectActions({ thread }: { thread?: Thread }) {
  const [catalog, setCatalog] = useState<Wire>({ actions: [], runs: [] }),
    [preview, setPreview] = useState<Wire>();
  const [actionId, setActionId] = useState<string>();
  const [name, setName] = useState(''),
    [command, setCommand] = useState('powershell.exe'),
    [args, setArgs] = useState('-NoProfile\n-File\n.grok/setup.ps1'),
    [directory, setDirectory] = useState('.'),
    [setup, setSetup] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function refresh() {
    if (thread) setCatalog(await window.desktop.call('actions:list', { id: thread.id }));
  }
  async function run(method: string, input: Wire = {}) {
    if (!thread) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call(method, { id: thread.id, ...input });
      if (method === 'actions:preview') setPreview(result);
      else setPreview(undefined);
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [thread?.id]);
  if (!thread) return null;
  return (
    <div className="mcp-settings">
      <h3>Project setup and reusable actions</h3>
      <p>
        Actions are saved with this project's desktop profile. Review the executable, individual
        arguments and workspace before running. Setup actions run explicitly, including in attached
        worktrees.
      </p>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {catalog.actions.map((action: Wire) => (
        <div className="mcp-server" key={action.id}>
          <strong>
            {action.name}
            {action.setup ? ' · Setup' : ''}
          </strong>
          <code>
            {action.command} {JSON.stringify(action.args)}
          </code>
          <button
            disabled={busy}
            onClick={() => void run('actions:preview', { actionId: action.id })}
          >
            Review and run
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setActionId(action.id);
              setName(action.name);
              setCommand(action.command);
              setArgs(action.args.join('\n'));
              setDirectory(action.directory);
              setSetup(action.setup);
            }}
          >
            Edit action
          </button>
          <button
            disabled={busy}
            onClick={() => void run('actions:remove', { actionId: action.id })}
          >
            Remove action
          </button>
        </div>
      ))}
      {preview && (
        <div className="mcp-server">
          <p>
            Run {preview.action.name} in {preview.cwd}?
          </p>
          <pre>{preview.action.command + '\n' + preview.action.args.join('\n')}</pre>
          <button
            disabled={busy}
            onClick={() =>
              void run('actions:run', { actionId: preview.action.id, revision: preview.revision })
            }
          >
            Run reviewed action
          </button>
          <button onClick={() => setPreview(undefined)}>Cancel</button>
        </div>
      )}
      {catalog.runs.map((record: Wire) => (
        <div className="mcp-server" key={record.id}>
          <strong>
            {record.status} · Exit {record.exitCode ?? 'pending'}
          </strong>
          <pre>{record.output || record.error}</pre>
          {record.status === 'running' && (
            <button onClick={() => void run('actions:cancel', { runId: record.id })}>
              Cancel action
            </button>
          )}
        </div>
      ))}
      <label>
        Action name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Executable
        <input value={command} onChange={(event) => setCommand(event.target.value)} />
      </label>
      <label>
        Arguments, one per line
        <textarea rows={4} value={args} onChange={(event) => setArgs(event.target.value)} />
      </label>
      <label>
        Working directory relative to this workspace
        <input value={directory} onChange={(event) => setDirectory(event.target.value)} />
      </label>
      <label>
        <input
          type="checkbox"
          checked={setup}
          onChange={(event) => setSetup(event.target.checked)}
        />
        Project setup action
      </label>
      <button
        disabled={busy || !name}
        onClick={() =>
          void run('actions:save', {
            actionId,
            name,
            command,
            args: args ? args.split(/\r?\n/) : [],
            directory,
            setup,
          })
        }
      >
        Save action
      </button>
      {actionId && (
        <button
          onClick={() => {
            setActionId(undefined);
            setName('');
          }}
        >
          New action
        </button>
      )}
    </div>
  );
}
