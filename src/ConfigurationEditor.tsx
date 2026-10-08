import { useEffect, useState } from 'react';
import type { Thread, Wire, TextDocument } from '../shared/types';
export default function ConfigurationEditor({
  thread,
  dirtyChanged,
}: {
  thread?: Thread;
  dirtyChanged: (dirty: boolean) => void;
}) {
  const [sources, setSources] = useState<Wire[]>([]),
    [selected, setSelected] = useState<Wire>(),
    [doc, setDoc] = useState<TextDocument>();
  const [text, setText] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(action: string, source?: Wire) {
    if (!thread) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'list') {
        setSources(await window.desktop.call('configuration:list', { id: thread.id }));
        setSelected(undefined);
        setDoc(undefined);
        setText('');
      }
      if (action === 'open') {
        const result = await window.desktop.call('configuration:open', { sourceId: source!.id });
        setSelected(source);
        setDoc(result);
        setText(result.text);
      }
      if (action === 'save') {
        const result = await window.desktop.call('configuration:save', {
          sourceId: selected!.id,
          text,
          revision: doc!.revision,
        });
        setDoc(result);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dirty = doc && text !== doc.text;
  useEffect(() => {
    dirtyChanged(!!dirty);
    return () => dirtyChanged(false);
  }, [dirty, dirtyChanged]);
  if (!thread) return null;
  return (
    <div className="mcp-settings">
      <h3>Configuration, instructions and rules</h3>
      <p>
        Edit existing sources directly. Saving preserves your exact text, comments and advanced
        fields. User configuration can include secrets; keep them out of shared repositories.
        Connections close after saving to reload native policy.
      </p>
      <button disabled={busy || !!dirty} onClick={() => void run('list')}>
        Inspect sources and duplicate definitions
      </button>
      {error && (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      )}
      {sources.map((source) => (
        <div className="mcp-server" key={source.id}>
          <strong>
            {source.scope} · {source.kind}
            {source.readOnly ? ' · managed, read-only' : ''}
          </strong>
          <code>{source.path}</code>
          {source.error && <p>{source.error}</p>}
          {source.definitions.map((item: Wire) => (
            <p key={item.name}>
              {item.name}
              {item.alsoDefinedIn.length ? ` also defined in ${item.alsoDefinedIn.join(', ')}` : ''}
            </p>
          ))}
          <button disabled={busy || !!dirty} onClick={() => void run('open', source)}>
            Edit source
          </button>
        </div>
      ))}
      {selected && doc && (
        <>
          <label>
            {selected.path}
            <textarea
              aria-label="Configuration source text"
              rows={16}
              value={text}
              readOnly={selected.readOnly === true}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button disabled={busy || !dirty || selected.readOnly} onClick={() => void run('save')}>
            Save reviewed source
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setText(doc.text);
              setSelected(undefined);
              setDoc(undefined);
            }}
          >
            Close and discard draft
          </button>
        </>
      )}
    </div>
  );
}
