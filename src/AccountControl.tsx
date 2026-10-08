import { useEffect, useState } from 'react';
import { UserRound, X } from 'lucide-react';
import type { State, Wire } from '../shared/types';
import AuthenticationSettings from './AuthenticationSettings';

export default function AccountControl({ state }: { state: State }) {
  const [status, setStatus] = useState<Wire>(),
    [open, setOpen] = useState(false);
  useEffect(() => {
    void window.desktop
      .call('auth:account')
      .then(setStatus)
      .catch(() => {});
  }, [state.settings.authMode]);
  useEffect(
    () =>
      window.desktop.onEvent((event) => {
        if (event.type === 'account') setStatus(event.status);
      }),
    [],
  );
  const api =
    state.settings.authMode === 'api' && (status?.saved || status?.session || status?.environment);
  const label = api
    ? 'xAI API key'
    : status?.account?.signedIn
      ? status.account.label || 'Grok account'
      : 'Sign in to Grok';
  return (
    <>
      <button
        className="account-button"
        aria-label="Account / sign in"
        onClick={() => setOpen(true)}
      >
        <span className="account-circle">
          <UserRound size={18} />
        </span>
        <span className="account-label">
          {label}
          <small>
            {api
              ? status?.saved
                ? 'Remembered on this Windows account'
                : 'Session / environment key'
              : status?.account?.signedIn
                ? 'Saved OAuth sign-in'
                : 'OAuth or API key'}
          </small>
        </span>
      </button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <section
            className="modal account-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
          >
            <div className="modal-header">
              <h2>Account</h2>
              <button aria-label="Close account" onClick={() => setOpen(false)}>
                <X size={18} />
              </button>
            </div>
            <AuthenticationSettings
              state={state}
              updated={setStatus}
              signedIn={() => setOpen(false)}
            />
            <p className="muted">
              After signing in, open a project and send a prompt. Your login is shared by this
              portable profile's chats.
            </p>
          </section>
        </div>
      )}
    </>
  );
}
