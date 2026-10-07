import { useEffect, useState } from 'react';
import type { Thread, Wire } from '../shared/types';

export default function McpSettings({ thread }: { thread?: Thread }) {
  const [servers, setServers] = useState<Wire[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Wire>();
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState('stdio');
  const [scope, setScope] = useState('user');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [values, setValues] = useState('');
  const [remove, setRemove] = useState<string>();
  const lines = (text: string) => text.split(/\r?\n/).filter((line) => line.trim());
  async function operation(method: string, input: Wire = {}) {
    if (!thread) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call(method, { id: thread.id, ...input });
      if (method === 'mcp:doctor') setReport(result);
      else {
        setServers(await window.desktop.call('mcp:list', { id: thread.id }));
        if (method !== 'mcp:list') {
          setReport(undefined);
          setRemove(undefined);
          setNotice(
            'Saved to Grok configuration. Chat connections were closed; reconnect to load the new configuration.',
          );
        }
      }
      return result;
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void operation('mcp:list');
  }, [thread?.id]);
  if (!thread)
    return <p>Open a project chat to manage MCP servers in its configuration context.</p>;
  return (
    <div className="mcp-settings">
      <h3>MCP servers</h3>
      <p>
        Configuration context: <code>{thread.cwd}</code>. Server processes and connections are
        managed by Grok. Connection tests start the server and check the MCP handshake and tool
        discovery.
      </p>
      <button disabled={busy} onClick={() => void operation('mcp:list')}>
        {busy ? 'Working…' : 'Refresh servers'}
      </button>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!servers.length && !busy && !error && <p>No TOML-configured servers in this context.</p>}
      {servers.map((server) => (
        <div className="mcp-server" key={server.name}>
          <strong>{server.name}</strong>
          <small>
            {server.transport} · {server.scope} · {server.enabled ? 'Enabled' : 'Disabled'}
          </small>
          <code>{server.target}</code>
          {server.blocked_reason && <p>Policy blocked: {server.blocked_reason}</p>}
          <div className="mcp-actions">
            <button
              disabled={busy}
              onClick={() => void operation('mcp:doctor', { name: server.name })}
            >
              Test connection: {server.name}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void operation('mcp:change', {
                  name: server.name,
                  operation: server.enabled ? 'disable' : 'enable',
                })
              }
            >
              {server.enabled ? 'Disable' : 'Enable'} {server.name}
            </button>
            <button disabled={busy} onClick={() => setRemove(server.name)}>
              Remove {server.name}
            </button>
          </div>
          {remove === server.name && (
            <div className="mcp-actions">
              <span>Remove this {server.scope} definition?</span>
              <button
                disabled={busy}
                onClick={() =>
                  void operation('mcp:change', {
                    name: server.name,
                    scope: server.scope,
                    operation: 'remove',
                  })
                }
              >
                Confirm remove
              </button>
              <button onClick={() => setRemove(undefined)}>Keep server</button>
            </div>
          )}
        </div>
      ))}
      {report && (
        <div className="mcp-report" role="status">
          <strong>
            Connection diagnostics: {report.healthy_count} healthy, {report.failing_count} failing
          </strong>
          {report.servers?.map((server: Wire) => (
            <div key={server.name}>
              <h4>
                {server.name}: {server.healthy ? 'Healthy' : 'Failed'}
              </h4>
              {server.checks?.map((check: Wire, index: number) => (
                <p key={index}>
                  {check.passed ? '✓' : '✕'} {check.label}
                  {check.detail ? ` — ${check.detail}` : ''}
                  {check.hint ? ` (${check.hint})` : ''}
                </p>
              ))}
            </div>
          ))}
          <details>
            <summary>Configuration sources</summary>
            <pre>{JSON.stringify(report.sources, null, 2)}</pre>
          </details>
        </div>
      )}
      <details className="mcp-add">
        <summary>Add MCP server</summary>
        <label className="field-label" htmlFor="mcp-name">
          Server name
        </label>
        <input
          id="mcp-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="my-server"
        />
        <div className="mcp-actions">
          <label>
            Transport{' '}
            <select
              aria-label="MCP transport"
              value={transport}
              onChange={(event) => {
                setTransport(event.target.value);
                setValues('');
              }}
            >
              <option value="stdio">STDIO</option>
              <option value="http">Streamable HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </label>
          <label>
            Scope{' '}
            <select
              aria-label="MCP scope"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="user">User</option>
              <option value="project">Project</option>
            </select>
          </label>
        </div>
        <label className="field-label" htmlFor="mcp-target">
          {transport === 'stdio' ? 'Server command' : 'Server URL'}
        </label>
        <input
          id="mcp-target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={transport === 'stdio' ? 'C:\\path\\to\\node.exe' : 'https://example.com/mcp'}
        />
        {transport === 'stdio' && (
          <>
            <label className="field-label" htmlFor="mcp-args">
              Arguments (one per line, without shell quoting)
            </label>
            <textarea
              id="mcp-args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              rows={3}
            />
          </>
        )}
        <label className="field-label" htmlFor="mcp-values">
          {transport === 'stdio'
            ? 'Environment variables (KEY=value, one per line)'
            : 'HTTP headers (Name: value, one per line)'}
        </label>
        <textarea
          id="mcp-values"
          value={values}
          onChange={(event) => setValues(event.target.value)}
          rows={3}
          spellCheck={false}
        />
        <p>
          Values are saved in Grok’s config file. For shared project configuration, use environment
          references such as <code>{'${API_TOKEN}'}</code> instead of literal secrets. OAuth sign-in
          and advanced configuration currently use Grok’s terminal interface.
        </p>
        <button
          disabled={busy || !name.trim() || !target.trim()}
          onClick={async () => {
            const saved = await operation('mcp:add', {
              name: name.trim(),
              transport,
              scope,
              command: target.trim(),
              url: target.trim(),
              args: lines(args),
              env: transport === 'stdio' ? lines(values) : [],
              headers: transport === 'stdio' ? [] : lines(values),
            });
            if (saved) {
              setName('');
              setTarget('');
              setArgs('');
              setValues('');
            }
          }}
        >
          Save MCP server
        </button>
      </details>
      <p>
        Inventory covers Grok’s TOML server definitions. Plugin-managed servers, OAuth controls,
        tools/resources browsing and per-tool policy editing still need dedicated GUI support. A
        healthy test confirms connectivity and discovery; it does not prove a model used the tools.
      </p>
    </div>
  );
}
