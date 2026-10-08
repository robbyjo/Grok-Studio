import { useState } from 'react';
import type { Thread, Wire } from '../shared/types';
import McpBrowser from './McpBrowser';
export default function IntegrationSettings({ thread }: { thread?: Thread }) {
  const [kind, setKind] = useState('mcp'),
    [catalog, setCatalog] = useState<Wire>(),
    [result, setResult] = useState<Wire>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [source, setSource] = useState(''),
    [reviewed, setReviewed] = useState(false),
    [resource, setResource] = useState('');
  const [logout, setLogout] = useState<string>();
  const [setupValues, setSetupValues] = useState<Record<string, Record<string, string>>>({});
  async function run(operation?: string, input: Wire = {}) {
    if (!thread) return;
    setBusy(true);
    setError('');
    try {
      if (operation) {
        const value = await window.desktop.call('integration:action', {
          id: thread.id,
          kind,
          operation,
          ...input,
        });
        setResult(value);
      }
      setCatalog(await window.desktop.call('integration:list', { id: thread.id, kind }));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!thread) return null;
  const rows = kind === 'instructions' ? [] : (catalog?.[kind === 'mcp' ? 'servers' : kind] ?? []);
  return (
    <div className="mcp-settings">
      <h3>Effective runtime integrations</h3>
      <p>
        Connect Grok to inspect the session's effective sources and policies. Native actions use
        Grok's policy and trust checks.
      </p>
      <select
        aria-label="Integration category"
        value={kind}
        disabled={busy}
        onChange={(event) => {
          setKind(event.target.value);
          setCatalog(undefined);
          setResult(undefined);
        }}
      >
        <option value="mcp">MCP catalog and authentication</option>
        <option value="skills">Skills</option>
        <option value="plugins">Plugins</option>
        <option value="hooks">Hooks and policy</option>
        <option value="instructions">Effective instructions and rules</option>
      </select>
      <button disabled={busy} onClick={() => void run()}>
        Load effective catalog
      </button>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {kind === 'instructions' && catalog && (
        <>
          <p>{catalog.policy}</p>
          <p>
            Project instructions:{' '}
            {catalog.projectTrusted
              ? 'trusted and eligible'
              : 'withheld until folder trust is granted'}
          </p>
          {(catalog.instructions ?? []).map((item: Wire) => (
            <details key={item.path}>
              <summary>
                {item.order + 1}. {item.source} · {item.path}
              </summary>
              <pre>{item.content}</pre>
            </details>
          ))}
        </>
      )}
      {kind === 'mcp' && (
        <p>
          Browse provider resources, templates and prompts, or read a known URI. Forgetting local
          credentials closes connections and removes only this server's stored OAuth credential; it
          does not revoke provider consent or clear configured bearer headers.
        </p>
      )}
      {rows.map((row: Wire) => (
        <div className="mcp-server" key={row.id ?? row.name}>
          <strong>{row.displayName ?? row.name}</strong>
          <small>
            {row.scope ?? row.source} · {row.sourceLabel ?? row.sourceDir ?? row.root ?? row.path}
          </small>
          <p>{row.description}</p>
          {kind === 'mcp' ? (
            <>
              <small>
                {row.session?.status} · {row.session?.blockedReason}
              </small>
              {(row.setup?.fields ?? []).map((field: Wire) => (
                <label key={field.id}>
                  {field.label}
                  <select
                    value={setupValues[row.name]?.[field.id] ?? ''}
                    onChange={(event) =>
                      setSetupValues((current) => ({
                        ...current,
                        [row.name]: { ...current[row.name], [field.id]: event.target.value },
                      }))
                    }
                  >
                    <option value="">Choose an option</option>
                    {field.options?.map((option: Wire) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {!!row.setup?.fields?.length && (
                <button
                  disabled={busy || !setupValues[row.name]}
                  onClick={() =>
                    void run('setup', { name: row.name, values: setupValues[row.name] })
                  }
                >
                  Save reviewed server setup
                </button>
              )}
              <div className="mcp-actions">
                <button disabled={busy} onClick={() => void run('auth-status', { name: row.name })}>
                  Authentication status
                </button>
                <button disabled={busy} onClick={() => void run('sign-in', { name: row.name })}>
                  {row.name === 'github-oauth' ? 'Sign in / verify identity' : 'Sign in'}
                </button>
                <button
                  disabled={busy || (row.type !== 'http' && row.name !== 'github-oauth')}
                  onClick={() => setLogout(row.name)}
                >
                  {row.name === 'github-oauth'
                    ? 'Clear GitHub connection'
                    : 'Forget local OAuth credential'}
                </button>
              </div>
              {logout === row.name && (
                <div>
                  <p>
                    Clear the local OAuth credential for {row.name}? GitHub's STDIO token is held in
                    memory; clearing it closes native sessions. Other servers and the definition are
                    preserved. Provider consent remains until revoked at the provider.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => {
                      void run('logout', { name: row.name, reviewed: true });
                      setLogout(undefined);
                    }}
                  >
                    Confirm credential logout
                  </button>
                  <button onClick={() => setLogout(undefined)}>Cancel logout</button>
                </div>
              )}
              {(row.session?.tools ?? []).map((tool: Wire) => (
                <label key={tool.name}>
                  <input
                    type="checkbox"
                    checked={tool.enabled !== false}
                    disabled={busy}
                    onChange={(event) =>
                      void run('tool-policy', {
                        name: row.name,
                        tool: tool.name,
                        enabled: event.target.checked,
                      })
                    }
                  />
                  {tool.displayName ?? tool.name}
                  <small>{tool.description}</small>
                </label>
              ))}
              <input
                aria-label={`Resource URI for ${row.name}`}
                placeholder="Known resource URI"
                value={resource}
                onChange={(event) => setResource(event.target.value)}
              />
              <McpBrowser id={thread.id} server={row.name} />
              <button
                disabled={busy || !resource}
                onClick={() => void run('resource-read', { name: row.name, uri: resource })}
              >
                Read resource
              </button>
            </>
          ) : kind === 'skills' ? (
            <button
              disabled={busy}
              onClick={() => void run('toggle', { name: row.name, enabled: row.enabled === false })}
            >
              {row.enabled === false ? 'Enable' : 'Disable'} skill
            </button>
          ) : kind === 'plugins' ? (
            <div className="mcp-actions">
              <button
                disabled={busy}
                onClick={() =>
                  void run(row.enabled === false ? 'enable' : 'disable', { name: row.id })
                }
              >
                {row.enabled === false ? 'Enable' : 'Disable'}
              </button>
              <button disabled={busy} onClick={() => void run('update', { name: row.id })}>
                Update plugin
              </button>
              <button
                disabled={busy || !reviewed}
                onClick={() => {
                  if (
                    window.confirm(
                      'Remove this plugin installation? All sibling plugins installed from the same source repository may also be removed.',
                    )
                  )
                    void run('uninstall', { name: row.id, reviewed });
                }}
              >
                Remove plugin
              </button>
            </div>
          ) : (
            <>
              <code>{row.command ?? row.url}</code>
              <small>
                {row.event} · {row.matcher} · {row.pinned ? 'Managed, read-only' : 'Editable'}
              </small>
              <button
                disabled={busy || row.pinned}
                onClick={() => void run(row.disabled ? 'enable' : 'disable', { name: row.name })}
              >
                {row.disabled ? 'Enable' : 'Disable'} hook
              </button>
            </>
          )}
          <details>
            <summary>Source and policy details</summary>
            <pre>{JSON.stringify(row, null, 2)}</pre>
          </details>
        </div>
      ))}
      {(kind === 'skills' || kind === 'plugins' || kind === 'hooks') && (
        <>
          {kind === 'hooks' && (
            <p>
              Registered hook directories must be under the selected Grok profile. Project hooks can
              be edited in their existing configuration sources.
            </p>
          )}
          <label>
            Source
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder={
                kind === 'plugins'
                  ? 'Plugin repository URL or local directory'
                  : 'Local source directory'
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I have reviewed this source, its scopes and executable content, and approve this change.
          </label>
          <button
            disabled={busy || !source || !reviewed}
            onClick={() =>
              void run(kind === 'plugins' ? 'install' : 'add', { path: source, source, reviewed })
            }
          >
            {kind === 'plugins' ? 'Install plugin from repository' : `Register ${kind} source`}
          </button>
          {kind === 'plugins' && (
            <button
              disabled={busy || !source || !reviewed}
              onClick={() => void run('add', { path: source, reviewed })}
            >
              Register local plugin directory
            </button>
          )}
          {kind !== 'plugins' && (
            <button
              disabled={busy || !source || !reviewed}
              onClick={() => void run('remove', { path: source, reviewed })}
            >
              Unregister source
            </button>
          )}
        </>
      )}
      {(kind === 'plugins' || kind === 'hooks') && (
        <button disabled={busy} onClick={() => void run('reload')}>
          Reload {kind}
        </button>
      )}
      {kind === 'hooks' && (
        <div>
          <p>Hook trust applies to the current workspace's discovered executable hooks.</p>
          <button disabled={busy || !reviewed} onClick={() => void run('trust', { reviewed })}>
            Trust reviewed workspace hooks
          </button>
          <button disabled={busy || !reviewed} onClick={() => void run('untrust', { reviewed })}>
            Remove workspace hook trust
          </button>
        </div>
      )}
      {result && (
        <details open>
          <summary>Native result</summary>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
