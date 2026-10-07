import { useEffect, useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export function MediaPreview({ asset }: { asset: Wire }) {
  if (typeof asset.url !== 'string' || !/^grok-media:\/\/asset\/[a-f\d-]{36}$/.test(asset.url))
    return null;
  if (asset.mimeType?.startsWith('image/'))
    return <img className="media-preview" src={asset.url} alt={asset.name} loading="lazy" />;
  if (asset.mimeType?.startsWith('audio/'))
    return (
      <audio
        className="media-preview"
        src={asset.url}
        controls
        preload="none"
        aria-label={asset.name}
      />
    );
  if (asset.mimeType?.startsWith('video/'))
    return (
      <video
        className="media-preview"
        src={asset.url}
        controls
        preload="none"
        aria-label={asset.name}
      />
    );
  return (
    <span className="muted">
      {asset.name} · {asset.mimeType ?? 'file'}
    </span>
  );
}
export default function MediaStudio({
  thread,
  attach,
  close,
}: {
  thread: Thread;
  attach: (asset: Wire) => void;
  close: () => void;
}) {
  const [assets, setAssets] = useState<Wire[]>([]),
    [kind, setKind] = useState('image'),
    [prompt, setPrompt] = useState(''),
    [aspect, setAspect] = useState('16:9'),
    [duration, setDuration] = useState(5),
    [voice, setVoice] = useState('eve'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = () => window.desktop.call<Wire[]>('media:list').then(setAssets);
  const [privacy, setPrivacy] = useState<Wire>();
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  async function operation(method: string, args: Wire = {}) {
    setError('');
    try {
      const result = await window.desktop.call(method, { id: thread.id, ...args });
      await refresh();
      return result;
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal settings-modal media-studio"
        role="dialog"
        aria-modal="true"
        aria-label="Media studio"
      >
        <div className="modal-header">
          <h2>Media studio</h2>
          <button disabled={busy} onClick={close}>
            Close media studio
          </button>
        </div>
        <p>
          Generate images, speech, or video with the built-in engine. Provider account access and
          billing apply to each Generate request. Stopping disconnects this chat’s engine; an
          accepted request may still be billed.
        </p>
        <label className="field-label">
          Media type
          <select
            aria-label="Media type"
            disabled={busy}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="image">Image</option>
            <option value="audio">Speech (text to audio)</option>
            <option value="video">Video</option>
          </select>
        </label>
        <label className="field-label">
          {kind === 'audio' ? 'Text to speak' : 'Generation prompt'}
          <textarea
            aria-label="Generation prompt"
            disabled={busy}
            value={prompt}
            maxLength={20000}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="media-options">
          {kind !== 'audio' && (
            <label className="field-label">
              Aspect ratio
              <select
                aria-label="Aspect ratio"
                disabled={busy}
                value={aspect}
                onChange={(e) => setAspect(e.target.value)}
              >
                {['1:1', '16:9', '9:16', '4:3', '3:4'].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          )}
          {kind === 'video' && (
            <label className="field-label">
              Duration (seconds)
              <input
                aria-label="Video duration"
                type="number"
                min={1}
                max={15}
                value={duration}
                disabled={busy}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </label>
          )}
          {kind === 'audio' && (
            <label className="field-label">
              Voice
              <select
                aria-label="Speech voice"
                disabled={busy}
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
              >
                {['eve', 'ara', 'leo', 'rex', 'sal'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="workflow-row">
          <button
            className="primary"
            disabled={busy || !prompt.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await operation('media:generate', { kind, prompt, aspect, duration, voice });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Generating…' : 'Generate media'}
          </button>
          {busy && (
            <button onClick={() => void operation('media:cancel')}>Stop media generation</button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        <h3>Stored media and attachments</h3>
        <p className="muted">
          Up to 50 MiB per file, 256 MiB total. Export files you want to retain before deleting
          them. Binary attachments are supplied as file references; model/tool support determines
          what can be interpreted.
        </p>
        <button onClick={() => void refresh().catch((e) => setError(String(e)))}>
          Refresh media
        </button>
        <details>
          <summary>Account privacy and video access</summary>
          <p>
            Grok Build blocks video output while zero data retention is enabled unless a compatible
            user-hosted bucket is configured. Account privacy changes apply to coding data for this
            account.
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              try {
                setPrivacy(await window.desktop.call('privacy:status', { id: thread.id }));
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Check account privacy
          </button>
          {privacy && (
            <p>
              Zero data retention:{' '}
              {privacy.codingDataRetentionOptOut === true
                ? 'enabled'
                : privacy.codingDataRetentionOptOut === false
                  ? 'disabled'
                  : 'unknown'}
            </p>
          )}
          <button
            disabled={busy}
            onClick={async () => {
              if (
                window.confirm(
                  'Enable coding-data retention for your Grok account? This changes account privacy and permits retention of coding data.',
                )
              ) {
                try {
                  setPrivacy(
                    await window.desktop.call('privacy:set', {
                      id: thread.id,
                      optOut: false,
                      reviewed: true,
                    }),
                  );
                } catch (e) {
                  setError(String(e));
                }
              }
            }}
          >
            Enable account coding-data retention
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              if (
                window.confirm(
                  'Disable coding-data retention for your Grok account and restore zero data retention?',
                )
              ) {
                try {
                  setPrivacy(
                    await window.desktop.call('privacy:set', {
                      id: thread.id,
                      optOut: true,
                      reviewed: true,
                    }),
                  );
                } catch (e) {
                  setError(String(e));
                }
              }
            }}
          >
            Restore zero data retention
          </button>
        </details>
        <div className="media-gallery">
          {assets
            .slice()
            .reverse()
            .map((asset) => (
              <article className="media-card" key={asset.id}>
                <strong>{asset.name}</strong>
                <MediaPreview asset={asset} />
                <small>
                  {asset.mimeType} · {(asset.size / 1024 / 1024).toFixed(2)} MiB
                </small>
                <div className="workflow-row">
                  <button disabled={busy} onClick={() => attach(asset)}>
                    Attach to prompt
                  </button>
                  <button onClick={() => void operation('media:export', { assetId: asset.id })}>
                    Export file
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete ${asset.name}? Historical previews and file references will become unavailable.`,
                        )
                      )
                        void operation('media:delete', { assetId: asset.id });
                    }}
                  >
                    Delete file
                  </button>
                </div>
              </article>
            ))}
        </div>
      </section>
    </div>
  );
}
