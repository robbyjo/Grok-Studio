import { useEffect, useState } from 'react';
import type { State, Thread, Wire } from '../shared/types';
export default function AuthenticationSettings({
  state,
  thread,
}: {
  state: State;
  thread?: Thread;
}) {
  const [status, setStatus] = useState<Wire>(),
    [key, setKey] = useState(''),
    [remember, setRemember] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function call(method: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call(method, args);
      setStatus(await window.desktop.call('auth:status'));
      return result;
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void call('auth:status');
  }, []);
  return (
    <section>
      <h3>Authentication</h3>
      <p>
        Use your Grok account through OAuth or an xAI API key. Changes disconnect idle engines;
        reconnect the chat to use the selected method.
      </p>
      <label className="field-label">
        Authentication method
        <select
          aria-label="Authentication method"
          disabled={busy}
          value={state.settings.authMode ?? 'auto'}
          onChange={(e) => void call('auth:mode', { mode: e.target.value })}
        >
          <option value="auto">Automatic (existing profile / API key)</option>
          <option value="oauth">Grok account (OAuth)</option>
          <option value="api">xAI API key</option>
        </select>
      </label>
      <p className="muted">
        OAuth uses the built-in browser sign-in and the selected Grok profile. API requests use the
        key supplied here or in XAI_API_KEY.
      </p>
      {thread && (
        <button disabled={busy} onClick={() => void call('agent:connect', { id: thread.id })}>
          Connect / sign in with selected method
        </button>
      )}
      {(thread?.session?.agent?.authMethods ?? [])
        .filter((m: Wire) => /oauth|oidc|grok/i.test(m.id + ' ' + m.name))
        .map((m: Wire) => (
          <button
            key={m.id}
            disabled={busy}
            onClick={() => void call('agent:authenticate', { id: thread!.id, methodId: m.id })}
          >
            {m.name}
          </button>
        ))}
      <label className="field-label">
        xAI API key
        <input
          aria-label="xAI API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{' '}
        Remember with Windows encrypted storage
      </label>
      <p className="muted">
        Session-only is the default. Remembered keys are encrypted for this Windows account and
        machine; portable profile copies require re-entry.
      </p>
      <div className="workflow-row">
        <button
          disabled={busy || !key.trim()}
          onClick={async () => {
            if (await call('auth:save', { key, remember })) setKey('');
          }}
        >
          Save API key
        </button>
        <button disabled={busy} onClick={() => void call('auth:forget')}>
          Forget stored API key
        </button>
      </div>
      {status && (
        <p role="status">
          API key:{' '}
          {status.session
            ? 'in memory'
            : status.saved
              ? 'encrypted on disk'
              : status.environment
                ? 'from environment'
                : 'not set'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
