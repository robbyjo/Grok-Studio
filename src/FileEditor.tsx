import { useEffect, useRef, useState } from 'react';
import type { TextDocument } from '../shared/types';

export interface FileDraft extends TextDocument {
  savedText: string;
}
export default function FileEditor({
  id,
  path,
  draft,
  update,
  busy,
}: {
  id: string;
  path: string;
  draft?: FileDraft;
  update: (draft: FileDraft) => void;
  busy: boolean;
}) {
  const [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [reload, setReload] = useState(false);
  const current = useRef(draft);
  current.current = draft;
  const updateCurrent = useRef(update);
  updateCurrent.current = update;
  useEffect(() => {
    let active = true;
    void window.desktop
      .call<TextDocument>('files:open', { id, path })
      .then((document) => {
        if (!active) return;
        const value = current.current;
        if (value?.text === document.text)
          updateCurrent.current({ ...document, savedText: document.text });
        else if (value && value.text !== value.savedText) {
          if (value.revision !== document.revision)
            setError('File changed on disk. Your draft was kept; reload before saving.');
        } else updateCurrent.current({ ...document, savedText: document.text });
      })
      .catch((failure) => {
        if (active) setError((failure as Error).message);
      });
    return () => {
      active = false;
    };
  }, [id, path]);
  const dirty = Boolean(draft && draft.text !== draft.savedText);
  async function save() {
    if (!draft || !dirty || working || busy) return;
    setWorking(true);
    setError('');
    try {
      const saved = await window.desktop.call<TextDocument>('files:save', {
        id,
        path,
        text: draft.text,
        revision: draft.revision,
      });
      // Preserve any typing that happened while the save was in flight.
      updateCurrent.current({
        ...saved,
        text: current.current?.text ?? saved.text,
        savedText: saved.text,
      });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function reloadFile() {
    setWorking(true);
    setError('');
    try {
      const document = await window.desktop.call<TextDocument>('files:open', { id, path });
      updateCurrent.current({ ...document, savedText: document.text });
      setReload(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const change = (text: string) => {
    if (!draft) return;
    if (draft.savedText.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
    update({ ...draft, text });
  };
  return (
    <div className="file-editor">
      <div className="editor-actions">
        <span>
          {dirty ? 'Unsaved draft' : 'Saved'}
          {draft?.savedText.includes('\r\n') ? ' · CRLF' : ' · LF'}
        </span>
        <button disabled={!dirty || working || busy} onClick={() => void save()}>
          Save file
        </button>
        <button
          disabled={working}
          onClick={() => {
            if (dirty) setReload(true);
            else void reloadFile();
          }}
        >
          Reload file
        </button>
      </div>
      {reload && (
        <div className="editor-confirm">
          <p>Discard this draft and reload the current file?</p>
          <button disabled={working} onClick={() => void reloadFile()}>
            Discard draft and reload
          </button>
          <button onClick={() => setReload(false)}>Keep draft</button>
        </div>
      )}
      {error && (
        <div className="panel-error" role="alert">
          {error}
        </div>
      )}
      {draft && (
        <textarea
          className="file-preview file-edit-text"
          aria-label={`Edit ${path}`}
          spellCheck={false}
          value={draft.text}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              void save();
            }
            if (
              event.key === 'Tab' &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              const input = event.currentTarget,
                start = input.selectionStart,
                end = input.selectionEnd;
              change(input.value.slice(0, start) + '\t' + input.value.slice(end));
              queueMicrotask(() => input.setSelectionRange(start + 1, start + 1));
            }
          }}
        />
      )}
      <small className="editor-help">
        Ctrl+S saves. Drafts survive switching files/chats while the app is open. Saves check for
        external changes.
      </small>
    </div>
  );
}
