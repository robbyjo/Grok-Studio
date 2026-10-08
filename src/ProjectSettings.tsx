import { useState } from 'react';
import { X } from 'lucide-react';
import type { Project } from '../shared/types';
import SandboxLaunch from './SandboxLaunch';

export default function ProjectSettings({
  project,
  close,
  saved,
}: {
  project: Project;
  close: () => void;
  saved: (project: Project) => void;
}) {
  const [name, setName] = useState(project.name);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function edit(update: { name?: string; hidden?: boolean }) {
    setBusy(true);
    setError('');
    try {
      saved(
        await window.desktop.call<Project>('project:edit', { projectId: project.id, ...update }),
      );
      close();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal small"
        role="dialog"
        aria-label="Project settings"
        aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) close();
        }}
      >
        <div className="modal-header">
          <h2>Project settings</h2>
          <button
            className="icon-button"
            aria-label="Close project settings"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p className="project-path">{project.path}</p>
        {!project.hidden && <SandboxLaunch projectId={project.id} />}
        <label className="field-label" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          autoFocus
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        {error && <p role="alert">{error}</p>}
        {remove && (
          <p role="status">
            Remove this project from the sidebar? Chats, file drafts, files and worktrees are
            retained. Idle Grok connections and terminals will close. Reopen the folder or restore
            the project to bring its chats back.
          </p>
        )}
        <div className="modal-actions">
          <button disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !name.trim()}
            onClick={() => void edit({ name })}
          >
            Save project name
          </button>
          {project.hidden ? (
            <button disabled={busy} onClick={() => void edit({ hidden: false })}>
              Restore project
            </button>
          ) : remove ? (
            <>
              <button disabled={busy} onClick={() => setRemove(false)}>
                Keep project
              </button>
              <button disabled={busy} onClick={() => void edit({ hidden: true })}>
                Confirm remove project
              </button>
            </>
          ) : (
            <button disabled={busy} onClick={() => setRemove(true)}>
              Remove from sidebar
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
