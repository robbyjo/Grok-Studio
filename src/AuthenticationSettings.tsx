import { useEffect, useState } from 'react';
import type { State, Thread, Wire } from '../shared/types';
export default function AuthenticationSettings({
  state,
  thread,
  updated,
}: {
  state: State;
  thread?: Thread;
  updated?: (value: Wire) => void;
}) {
  const [status, setStatus] = useState<Wire>(),
    [key, setKey] = useState(''),
    [remember, setRemember] = useState(true),
    [error, setError] = useState(''),
    [authenticating, setAuthenticating] = useState(false),
    [busy, setBusy] = useState(false);
  async function call(method: string, args: Wire = {}) {
    setBusy(true);
    if (method === 'auth:sign-in') setAuthenticating(true);
    setError('');
    try {
      const result = await window.desktop.call(method, args);
      const status = await window.desktop.call('auth:status');
      setStatus(status);
      updated?.(status);
      return result;
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setAuthenticating(false);
    }
  }
  useEffect(() => {
    void call('auth:status');
  }, []);
  useEffect(() => {
    if (!status?.signingIn) return;
    const timer = setInterval(() => {
      void window.desktop.call('auth:status').then((next) => {
        setStatus(next);
        updated?.(next);
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status?.signingIn]);
  return (
    <section>
      <h3>Authentication</h3>
      <p>
        Sign in before opening a project. OAuth credentials are saved in your Grok profile and
        reused after restarting Workbench or Windows. API keys are remembered with Windows
        encryption by default. Authentication changes disconnect idle engines.
      </p>
      <label className="field-label">
        Authentication method
        <select
          aria-label="Authentication method"
          disabled={busy || status?.signingIn}
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
      <button
        disabled={busy || status?.signingIn}
        className="primary"
        onClick={() => void call('auth:sign-in')}
      >
        Sign in with Grok (OAuth)
      </button>
      {(authenticating || status?.signingIn) && (
        <button onClick={() => void window.desktop.call('auth:cancel-sign-in')}>
          Cancel sign-in
        </button>
      )}
      {status?.account?.signedIn && (
        <p role="status">Grok account: {status.account.label || 'Signed in'}. Sign-in is saved.</p>
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
        Remembered keys survive application restarts and Windows reboots on this account and
        machine. Uncheck for session-only use. Portable copies may require re-entry elsewhere.
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
          {status.saved
            ? 'encrypted on disk'
            : status.session
              ? 'in memory'
              : status.environment
                ? 'from environment'
                : 'not set'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
