import { useState } from 'react';
import type { Wire } from '../shared/types';
export default function UpdateSettings() {
  const [status, setStatus] = useState<Wire>(),
    [release, setRelease] = useState<Wire>(),
    [alpha, setAlpha] = useState(false),
    [unsigned, setUnsigned] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function run(method: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const value = await window.desktop.call(`updates:${method}`, args);
      if (method === 'check') setRelease(value);
      else setStatus(value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>Portable updates and rollback</h3>
      <p>
        Check and download explicitly. Replacement happens after Workbench exits, retaining the
        previous executable. The adjacent profile stays in place. Native-engine or storage-format
        changes require a separate migration.
      </p>
      <button disabled={busy} onClick={() => void run('status')}>
        Inspect installed version and rollback
      </button>
      {status && <pre>{JSON.stringify(status, null, 2)}</pre>}
      <label>
        <input
          type="checkbox"
          checked={alpha}
          onChange={(e) => {
            setAlpha(e.target.checked);
            setRelease(undefined);
          }}
        />
        Include alpha releases
      </label>
      <label>
        <input type="checkbox" checked={unsigned} onChange={(e) => setUnsigned(e.target.checked)} />
        Allow unsigned updates from the project’s GitHub releases
      </label>
      <button disabled={busy} onClick={() => void run('check', { alpha })}>
        Check for portable updates
      </button>
      {release && (
        <div>
          {release.available ? (
            <>
              <p>
                Version {release.version} · {release.prerelease ? 'Alpha' : 'Stable'} ·{' '}
                {release.executable?.size ?? 0} bytes
              </p>
              <p>
                {release.compatibleMetadata
                  ? 'Compatibility metadata is available.'
                  : 'This release has no compatibility manifest and cannot be installed by this updater.'}
              </p>
              <button
                disabled={busy || !release.compatibleMetadata}
                onClick={() => void run('stage', { token: release.token, allowUnsigned: unsigned })}
              >
                Download and verify reviewed update
              </button>
            </>
          ) : (
            <p role="status">No newer release in this channel.</p>
          )}
        </div>
      )}
      {status?.journal?.state === 'staged' && (
        <button
          disabled={busy || !status?.portable}
          onClick={() => {
            if (
              window.confirm(
                'Save or discard any unsaved Settings configuration first. Exit Workbench, replace this portable executable with the verified version and keep the previous binary for rollback?',
              )
            )
              void run('apply', { confirmed: true });
          }}
        >
          Exit and install verified update
        </button>
      )}
      {status?.journal?.state === 'installed' && (
        <button
          disabled={busy || !status?.portable}
          onClick={() => {
            if (
              window.confirm(
                'Save or discard unsaved Settings configuration first. Exit and restore the previous portable executable? Current chats and profile files stay in place.',
              )
            )
              void run('rollback', { confirmed: true });
          }}
        >
          Exit and roll back executable
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {['prepared', 'rollbackPrepared', 'repairRequired'].includes(status?.journal?.state) && (
        <button
          disabled={busy || !status?.portable}
          onClick={() => {
            if (
              window.confirm(
                'Check the interrupted replacement and restore the retry option only if the original and reviewed binary hashes still match and its worker has stopped?',
              )
            )
              void run('recover', { confirmed: true });
          }}
        >
          Recover interrupted replacement
        </button>
      )}
      {['staged', 'installed', 'rolledBack'].includes(status?.journal?.state) && (
        <button
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                'Delete the retained staged/rollback executable files to free storage? This removes the rollback option and keeps the running executable and profile.',
              )
            )
              void run('discard', { confirmed: true });
          }}
        >
          Discard retained update and rollback files
        </button>
      )}
    </section>
  );
}
