import { useState } from 'react';
import type { Wire } from '../shared/types';
export default function SandboxLaunch({ projectId }: { projectId: string }) {
  const [network, setNetwork] = useState(false),
    [review, setReview] = useState<Wire>(),
    [result, setResult] = useState<Wire>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(method: string, args: Wire) {
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call<Wire>(method, { projectId, ...args });
      if (method.endsWith('preview')) setReview(result);
      else setResult(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Isolated Windows Sandbox project copy (experimental)</summary>
      <p>
        Requires the Windows Sandbox optional feature. The whole guest Workbench runs separately.
        Original files and host sign-in are not mapped. Open C:\WorkbenchProject inside the guest
        and sign in there. Closing Sandbox deletes its chats and sign-in; edits to the project copy
        remain for manual review.
      </p>
      <label>
        <input
          type="checkbox"
          checked={network}
          onChange={(e) => {
            setNetwork(e.target.checked);
            setReview(undefined);
          }}
        />
        Enable guest networking for OAuth/model/MCP access (also allows guest access to the local
        network)
      </label>
      <button disabled={busy} onClick={() => void run('sandbox:preview', { network })}>
        Review isolated launch
      </button>
      {review && (
        <>
          <p>
            {review.files} files · {review.bytes} bytes · {review.skipped} excluded entries.
            Generated folders, configuration and recognized credential files are excluded.
            Custom-named secrets in project files can still be copied; review the project first.
          </p>
          <p>{review.scope}</p>
          <button
            disabled={busy}
            onClick={() => void run('sandbox:launch', { token: review.token, reviewed: true })}
          >
            Prepare and launch reviewed Sandbox
          </button>
        </>
      )}
      {result && (
        <p role="status">
          {result.message} Project-copy recovery folder: {result.recovery}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
