import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp,
  ArrowUpRight,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  File,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompareArrows,
  History,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';
import type {
  FileItem,
  GitState,
  Permission,
  Project,
  SearchHit,
  State,
  Thread,
  Wire,
} from '../shared/types';
import ChatSearch from './ChatSearch';
import ProjectSettings from './ProjectSettings';
import McpSettings from './McpSettings';
import IntegrationSettings from './IntegrationSettings';
import SessionTools from './SessionTools';
import ConfigurationEditor from './ConfigurationEditor';
import WorktreeTools from './WorktreeTools';
import GitRepositoryTools from './GitRepositoryTools';
import ProjectActions from './ProjectActions';
import FileEditor, { type FileDraft } from './FileEditor';
import GitChanges from './GitChanges';
import TaskDashboard, { UsageIndicators } from './TaskDashboard';
import Organization from './Organization';
import DesktopPreferences from './DesktopPreferences';
import AuthenticationSettings from './AuthenticationSettings';
import AccountControl from './AccountControl';
import MediaStudio, { MediaPreview } from './MediaStudio';
import { defaultShortcuts, matchesShortcut } from '../shared/shortcuts';
import { useAccessibleDialogs } from './accessibility';
const TerminalPanel = lazy(() => import('./Terminal'));

const initial: State = { version: 1, projects: [], threads: [], settings: { executable: 'grok' } };
const pretty = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const running = (thread?: Thread) =>
  Boolean(thread && ['running', 'approval', 'connecting'].includes(thread.status));

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) void window.desktop.call('external:open', { url: href }).catch(() => {});
            }}
          >
            {children}
            <ArrowUpRight size={12} />
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
function Activity({ entry }: { entry: Thread['entries'][number] }) {
  if (entry.type === 'thought')
    return (
      <details className="activity thought">
        <summary>
          <Circle size={12} />
          Reasoning
        </summary>
        <div className="markdown">
          <Markdown text={entry.text} />
        </div>
      </details>
    );
  if (entry.type === 'plan')
    return (
      <div className="plan">
        <span className="eyebrow">PLAN</span>
        {(entry.data?.entries ?? []).map((item: Wire, index: number) => (
          <div key={index}>
            <span className={`plan-dot ${item.status}`}>
              {item.status === 'completed' ? <Check size={12} /> : index + 1}
            </span>
            <span>{item.content}</span>
            <small>{item.status?.replaceAll('_', ' ')}</small>
          </div>
        ))}
      </div>
    );
  if (entry.type === 'tool')
    return (
      <details className="activity">
        <summary>
          <Code2 size={14} />
          <span>{entry.text}</span>
          <small className={entry.data?.status === 'failed' ? 'danger' : ''}>
            {entry.data?.status?.replaceAll('_', ' ')}
          </small>
        </summary>
        <pre>
          {pretty({
            input: entry.data?.rawInput,
            output: entry.data?.rawOutput,
            content: entry.data?.content,
            locations: entry.data?.locations,
          }).slice(0, 80_000)}
        </pre>
      </details>
    );
  if (entry.type === 'notice')
    return (
      <details className="notice">
        <summary>
          <Check size={12} />
          {entry.text}
        </summary>
        {entry.data && <pre>{pretty(entry.data).slice(0, 40_000)}</pre>}
      </details>
    );
  return (
    <div className={`message ${entry.type}`}>
      <div className="message-label">{entry.type === 'user' ? 'You' : 'Grok'}</div>
      {entry.data?.attachments?.map((asset: Wire) => (
        <MediaPreview key={asset.id ?? asset.name} asset={asset} />
      ))}
      <div className="markdown">
        <Markdown text={entry.text} />
      </div>
    </div>
  );
}
function ConfigControls({
  thread,
  action,
}: {
  thread: Thread;
  action: (method: string, args?: Wire) => Promise<any>;
}) {
  const configs = thread.session?.configOptions ?? [];
  return (
    <div className="config-controls">
      {configs.length ? (
        configs
          .filter((item: Wire) => item.type === 'select')
          .map((config: Wire) => {
            const values = (config.options ?? []).flatMap((item: Wire) => item.options ?? [item]);
            return (
              <label key={config.id} title={config.name ?? config.id}>
                <select
                  aria-label={config.name ?? config.id}
                  disabled={thread.status !== 'idle'}
                  value={config.currentValue}
                  onChange={(event) =>
                    void action('agent:config', {
                      id: thread.id,
                      configId: config.id,
                      value: event.target.value,
                    })
                  }
                >
                  {!values.some((item: Wire) => item.value === config.currentValue) && (
                    <option value={config.currentValue}>{config.currentValue}</option>
                  )}
                  {values.map((item: Wire) => (
                    <option value={item.value} key={item.value}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })
      ) : (
        <span className="muted">
          <Circle size={10} /> Grok defaults
        </span>
      )}
      {thread.session?.modes?.availableModes && (
        <select
          aria-label="Agent mode"
          disabled={thread.status !== 'idle'}
          value={thread.session.modes.currentModeId}
          onChange={(event) =>
            void action('agent:config', {
              id: thread.id,
              configId: '__mode',
              value: event.target.value,
            })
          }
        >
          {thread.session.modes.availableModes.map((mode: Wire) => (
            <option value={mode.id} key={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
      )}
      <span
        className="permission-label"
        title="Grok's configured permission rules apply. Approval prompts are surfaced here."
      >
        <ShieldCheck size={13} /> Grok permissions
      </span>
    </div>
  );
}

export default function App() {
  useAccessibleDialogs();
  const [state, setState] = useState<State>(initial);
  const [activeId, setActiveId] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [search, setSearch] = useState(false);
  const [organize, setOrganize] = useState(false),
    [tasks, setTasks] = useState(false);
  const [historyPage, setHistoryPage] = useState<{
    entries: Thread['entries'];
    start: number;
    end: number;
    total: number;
    hasOlder: boolean;
    hasNewer: boolean;
  }>();
  const recoveryReady = useRef(false);
  const [searchHit, setSearchHit] = useState<SearchHit>();
  const [projectSettings, setProjectSettings] = useState<string>();
  const [removedProjects, setRemovedProjects] = useState(false);
  const [archived, setArchived] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [executable, setExecutable] = useState('grok');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attached, setAttached] = useState<Record<string, Wire[]>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [inspector, setInspector] = useState(true);
  const [tab, setTab] = useState<'files' | 'changes'>('changes');
  const [filePath, setFilePath] = useState('.');
  const [fileItems, setFileItems] = useState<FileItem[]>([]);
  const [preview, setPreview] = useState<{ name: string; path: string }>();
  const [fileDrafts, setFileDrafts] = useState<Record<string, FileDraft>>({});
  const [git, setGit] = useState<GitState>();
  const [panelError, setPanelError] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [existingBranch, setExistingBranch] = useState(false);
  const [configurationDirty, setConfigurationDirty] = useState(false);
  function closeSettings(signInSucceeded = false) {
    if (
      configurationDirty &&
      !window.confirm(
        signInSucceeded
          ? 'Grok sign-in succeeded. Discard the unsaved configuration draft and close Settings? Cancel to keep editing.'
          : 'Discard the unsaved configuration draft?',
      )
    )
      return;
    setSettings(false);
  }
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const panelRequest = useRef(0);
  const currentPanel = useRef('');
  const thread = state.threads.find((item) => item.id === activeId);
  const project =
    state.projects.find((item) => item.id === (thread?.projectId ?? projectId)) ??
    state.projects.find((item) => !item.hidden);
  const draftKey = thread?.id ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const busy = running(thread) || Boolean(thread && pending[thread.id]);
  currentPanel.current = `${thread?.id ?? ''}:${tab}:${filePath}`;

  useEffect(() => {
    if (!window.desktop) {
      setError(
        'Open this application with Electron. The browser preview has no access to local projects.',
      );
      return;
    }
    const unsubscribe = window.desktop.onEvent((event) => {
      if (event.type === 'state') setState(event.state);
      if (event.type === 'focus-chat') {
        setHistoryPage(undefined);
        setActiveId(event.id);
      }
      if (event.type === 'permission')
        setPermissions((items) => [
          ...items.filter((item) => item.id !== event.permission.id),
          event.permission,
        ]);
      if (event.type === 'permission-closed')
        setPermissions((items) => items.filter((item) => item.id !== event.id));
    });
    void window.desktop
      .call<State>('state')
      .then((saved) => {
        setState(saved);
        setExecutable(saved.settings.executable);
        setActiveId(
          saved.threads.find(
            (item) =>
              !item.archived &&
              !saved.projects.find((project) => project.id === item.projectId)?.hidden,
          )?.id,
        );
        setProjectId(saved.projects.find((item) => !item.hidden)?.id);
      })
      .catch((reason) => setError(String(reason)));
    void window.desktop
      .call<Permission[]>('permissions')
      .then(setPermissions)
      .catch(() => {});
    void window.desktop
      .call('drafts:get')
      .then((value) => {
        setDrafts(value.composer ?? {});
        setFileDrafts(value.files ?? {});
        setAttached(value.attachments ?? {});
        recoveryReady.current = true;
      })
      .catch((reason) => setError(String(reason)));
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!recoveryReady.current) return;
    const timer = setTimeout(() => {
      void window.desktop
        .call('drafts:save', {
          value: {
            composer: drafts,
            attachments: attached,
            files: Object.fromEntries(
              Object.entries(fileDrafts).filter(([, d]) => d.text !== d.savedText),
            ),
          },
        })
        .catch((e) => setError(String(e)));
    }, 500);
    return () => clearTimeout(timer);
  }, [drafts, fileDrafts, attached]);
  useEffect(() => {
    if (!activeId) return;
    setHistoryPage(undefined);
    void window.desktop
      .call<State>('thread:select', { id: activeId })
      .then(setState)
      .catch((e) => setError(String(e)));
  }, [activeId]);
  useEffect(() => {
    if (searchHit?.entryId && searchHit.threadId === activeId)
      void window.desktop
        .call('history:page', { id: activeId, entryId: searchHit.entryId })
        .then(setHistoryPage)
        .catch((e) => setError(String(e)));
  }, [searchHit, activeId]);
  async function action(method: string, args: Wire = {}) {
    try {
      return await window.desktop.call(method, args);
    } catch (reason) {
      setError(String(reason).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''));
      return undefined;
    }
  }
  async function newChat() {
    if (project?.hidden) return;
    if (!project) {
      await addProject();
      return;
    }
    const result = await action('thread:new', { projectId: project.id });
    if (result) {
      setSearchHit(undefined);
      setActiveId(result.id);
      setArchived(false);
      setPreview(undefined);
      composer.current?.focus();
    }
  }
  async function addProject() {
    const result = await action('project:add');
    if (result) {
      setSearchHit(undefined);
      setProjectId(result.id);
      const chat =
        state.threads.find((item) => item.projectId === result.id && !item.archived) ??
        (await action('thread:new', { projectId: result.id }));
      if (chat) setActiveId(chat.id);
      setArchived(false);
    }
  }
  function projectSaved(updated: Project) {
    if (updated.hidden && project?.id === updated.id) {
      setSearchHit(undefined);
      setActiveId(undefined);
      setProjectId(state.projects.find((item) => item.id !== updated.id && !item.hidden)?.id);
    } else if (!updated.hidden && state.projects.find((item) => item.id === updated.id)?.hidden) {
      setProjectId(updated.id);
      setActiveId(
        state.threads.find((item) => item.projectId === updated.id && !item.archived)?.id,
      );
      setArchived(false);
    }
  }
  function selectSearchHit(hit: SearchHit) {
    setActiveId(hit.threadId);
    setProjectId(state.threads.find((item) => item.id === hit.threadId)?.projectId);
    setArchived(hit.archived);
    setSearch(false);
    setSearchHit(hit);
  }
  async function refresh() {
    if (!thread) return;
    const id = thread.id;
    const key = `${id}:${tab}:${filePath}`;
    if (currentPanel.current !== key) return;
    const request = ++panelRequest.current;
    setPanelError('');
    try {
      if (tab === 'changes') {
        const result = await window.desktop.call<GitState>('git:state', { id });
        if (currentPanel.current === key && panelRequest.current === request) setGit(result);
      } else {
        const result = await window.desktop.call<FileItem[]>('files:list', { id, path: filePath });
        if (currentPanel.current === key && panelRequest.current === request) setFileItems(result);
      }
    } catch (reason) {
      if (currentPanel.current !== key || panelRequest.current !== request) return;
      setPanelError(
        String(reason).replace(/^Error: Error invoking remote method '[^']+': Error: /, ''),
      );
      if (tab === 'changes') setGit(undefined);
    }
  }
  useEffect(() => {
    setFilePath('.');
    setPreview(undefined);
    setGit(undefined);
    setFileItems([]);
    setPanelError('');
    setTerminal(false);
    stick.current = !searchHit;
  }, [activeId, thread?.cwd]);
  useEffect(() => {
    void refresh();
  }, [activeId, thread?.id, thread?.cwd, tab, filePath]);
  useEffect(() => {
    void window.desktop
      ?.call('editor:dirty', {
        count:
          Object.values(fileDrafts).filter((draft) => draft.text !== draft.savedText).length +
          Number(configurationDirty),
      })
      .catch((reason) => setError(String(reason)));
  }, [fileDrafts, configurationDirty]);
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ behavior: 'instant' });
  }, [thread?.entries, thread?.status]);
  useEffect(() => {
    if (!searchHit || searchHit.threadId !== activeId) return;
    stick.current = false;
    const entry = searchHit.entryId
      ? Array.from(messages.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? []).find(
          (element) => element.dataset.entryId === searchHit.entryId,
        )
      : undefined;
    entry?.querySelector('details')?.setAttribute('open', '');
    entry?.focus({ preventScroll: true });
    (entry ?? messages.current)?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [activeId, searchHit, historyPage]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const shortcuts = { ...defaultShortcuts, ...state.settings.shortcuts };
      if (matchesShortcut(event, shortcuts.newChat)) {
        event.preventDefault();
        void newChat();
      }
      if (matchesShortcut(event, shortcuts.settings)) {
        event.preventDefault();
        setSettings(true);
      }
      if (matchesShortcut(event, shortcuts.search)) {
        event.preventDefault();
        setSearch(true);
      }
      if (matchesShortcut(event, shortcuts.terminal)) {
        event.preventDefault();
        setTerminal((value) => !value);
      }
      if (matchesShortcut(event, shortcuts.tasks)) {
        event.preventDefault();
        setTasks(true);
      }
      if (event.key === 'Escape') {
        closeSettings();
        setWorktree(false);
        setRename(false);
        setSearch(false);
        setProjectSettings(undefined);
        setTasks(false);
        setOrganize(false);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [project?.id, configurationDirty, state.settings.shortcuts]);
  async function send() {
    if (busy) {
      if (thread && draft.trim()) {
        const result = await action('agent:queue', { id: thread.id, text: draft });
        if (result) setDrafts((value) => ({ ...value, [draftKey]: '' }));
      }
      return;
    }
    if (!draft.trim() && !attached[draftKey]?.length) return;
    let target = thread;
    if (!target) {
      if (!project) {
        await addProject();
        return;
      }
      target = await action('thread:new', { projectId: project.id });
      if (!target) return;
      setActiveId(target.id);
    }
    const id = target.id;
    setSearchHit(undefined);
    const text = draft;
    const files = attached[draftKey] ?? [];
    setPending((value) => ({ ...value, [id]: true }));
    setDrafts((value) => ({ ...value, [draftKey]: '', [id]: '' }));
    setAttached((value) => ({ ...value, [draftKey]: [], [id]: [] }));
    stick.current = true;
    try {
      await window.desktop.call('agent:prompt', {
        id,
        text,
        attachments: files.map((item) => item.id),
      });
    } catch (reason) {
      setError(String(reason));
      setDrafts((value) => ({ ...value, [id]: value[id] || text }));
    } finally {
      setPending((value) => ({ ...value, [id]: false }));
      void refresh();
    }
  }
  const shown = state.threads
    .filter(
      (item) =>
        item.archived === archived &&
        !state.projects.find((project) => project.id === item.projectId)?.hidden,
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  const currentPermissions = permissions.filter((item) => item.threadId === thread?.id);
  const count = git?.status.split('\n').filter(Boolean).length ?? 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">/</div>
          <span>
            Grok <b>Workbench</b>
          </span>
          <span className="version">α</span>
        </div>
        <button className="new-chat" disabled={project?.hidden} onClick={() => void newChat()}>
          <Plus size={17} />
          New chat<kbd>Ctrl N</kbd>
        </button>
        <button className="search" aria-label="Search chats" onClick={() => setSearch(true)}>
          <Search size={14} />
          Search chats<kbd>Ctrl Shift F</kbd>
        </button>
        <div className="section-heading">
          <span>PROJECTS</span>
          <button
            className="icon-button"
            aria-label="Organize projects and chats"
            onClick={() => setOrganize(true)}
          >
            <MoreHorizontal size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Add project"
            onClick={() => void addProject()}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="project-list">
          {state.projects
            .filter((item) => !item.hidden)
            .sort(
              (a, b) =>
                Number(b.pinned) - Number(a.pinned) ||
                (a.group ?? '').localeCompare(b.group ?? '') ||
                (a.order ?? 0) - (b.order ?? 0),
            )
            .map((item) => (
              <div className="project-item" key={item.id}>
                <button
                  className={`project-row ${project?.id === item.id ? 'selected' : ''}`}
                  title={item.path}
                  onClick={() => {
                    setSearchHit(undefined);
                    setProjectId(item.id);
                    setActiveId(
                      state.threads.find((chat) => chat.projectId === item.id && !chat.archived)
                        ?.id,
                    );
                  }}
                >
                  <Folder size={15} />
                  <span>
                    {item.pinned ? '★ ' : ''}
                    {item.name}
                    {item.group && <small> · {item.group}</small>}
                  </span>
                  {project?.id === item.id && <ChevronDown size={13} />}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Manage project ${item.name}`}
                  onClick={() => setProjectSettings(item.id)}
                >
                  <MoreHorizontal size={15} />
                </button>
              </div>
            ))}
          {!state.projects.some((item) => !item.hidden) && (
            <button className="open-project" onClick={() => void addProject()}>
              <FolderOpen size={15} />
              Open a project
            </button>
          )}
          {state.projects.some((item) => item.hidden) && (
            <>
              <button
                className="removed-projects"
                aria-expanded={removedProjects}
                onClick={() => setRemovedProjects(!removedProjects)}
              >
                Removed projects
              </button>
              {removedProjects &&
                state.projects
                  .filter((item) => item.hidden)
                  .map((item) => (
                    <button
                      className="project-row"
                      key={item.id}
                      aria-label={`Manage removed project ${item.name}`}
                      onClick={() => setProjectSettings(item.id)}
                    >
                      <Folder size={15} />
                      <span>{item.name}</span>
                    </button>
                  ))}
            </>
          )}
        </div>
        <div className="section-heading">
          <span>{archived ? 'ARCHIVED CHATS' : 'CHATS'}</span>
          <button
            className={`icon-button ${archived ? 'active' : ''}`}
            aria-label="Toggle archived chats"
            title="Archived chats"
            onClick={() => setArchived(!archived)}
          >
            <History size={14} />
          </button>
        </div>
        <div className="thread-list">
          {shown.map((item) => (
            <button
              key={item.id}
              className={`thread-row ${activeId === item.id ? 'selected' : ''}`}
              onClick={() => {
                setSearchHit(undefined);
                setActiveId(item.id);
                setProjectId(item.projectId);
              }}
            >
              <span className={`status-dot ${item.status}`} />
              <span className="thread-copy">
                <span>{item.title}</span>
                <small>
                  {state.projects.find((value) => value.id === item.projectId)?.name}
                  {item.cwd !== state.projects.find((value) => value.id === item.projectId)?.path
                    ? ' · worktree'
                    : ''}
                </small>
              </span>
              {item.pinned && <Pin size={12} />}
              {permissions.some((value) => value.threadId === item.id) && (
                <span className="approval-badge">!</span>
              )}
            </button>
          ))}
          {state.pagination?.hasMore && (
            <button
              onClick={async () => {
                const next = await action('state', {
                  limit: Math.min(10000, state.pagination!.limit + 100),
                });
                if (next) setState(next);
              }}
            >
              Load more chats
            </button>
          )}
          {!shown.length && (
            <p className="sidebar-empty">
              {archived ? 'No archived chats.' : 'Your work starts here.'}
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-machine">
            <span className="status-dot idle" />
            <span>
              Local machine<small>Windows · local workflows</small>
            </span>
          </div>
          <AccountControl state={state} />
          <button
            aria-label="Settings"
            className="settings-button"
            onClick={() => {
              setExecutable(state.settings.executable);
              setSettings(true);
            }}
          >
            <Settings2 size={16} />
            Settings<kbd>Ctrl ,</kbd>
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <Folder size={15} />
            <span>{project?.name ?? 'Workspace'}</span>
            <ChevronRight size={13} />
            <strong>{thread?.title ?? 'New chat'}</strong>
          </div>
          <div className="toolbar">
            {thread && (
              <>
                <span className={`status-label ${thread.status}`}>
                  {busy ? (
                    <LoaderCircle size={12} className="spin" />
                  ) : (
                    <span className={`status-dot ${thread.status}`} />
                  )}{' '}
                  {thread.status === 'idle' ? 'Ready' : thread.status}
                </span>
                <button
                  className="icon-button"
                  title="Rename chat"
                  aria-label="Rename chat"
                  onClick={() => {
                    setTitle(thread.title);
                    setRename(true);
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
                <button
                  className={`icon-button ${thread.pinned ? 'active' : ''}`}
                  title="Pin chat"
                  aria-label="Pin chat"
                  onClick={() =>
                    void action('thread:edit', { id: thread.id, pinned: !thread.pinned })
                  }
                >
                  <Pin size={15} />
                </button>
                <button
                  className="icon-button"
                  title={thread.archived ? 'Restore chat' : 'Archive chat'}
                  aria-label={thread.archived ? 'Restore chat' : 'Archive chat'}
                  disabled={busy}
                  onClick={() => {
                    void action('thread:edit', { id: thread.id, archived: !thread.archived });
                    setArchived(!thread.archived);
                  }}
                >
                  <Archive size={15} />
                </button>
                <span className="toolbar-divider" />
                <button
                  className={`icon-button ${terminal ? 'active' : ''}`}
                  title="Toggle terminal"
                  aria-label="Toggle terminal"
                  onClick={() => setTerminal(!terminal)}
                >
                  <TerminalSquare size={17} />
                </button>
              </>
            )}
            <button
              className={`icon-button ${inspector ? 'active' : ''}`}
              title="Toggle workspace panel"
              aria-label="Toggle workspace panel"
              onClick={() => setInspector(!inspector)}
            >
              <GitCompareArrows size={17} />
            </button>
          </div>
        </header>
        <div className="workspace-body">
          <section className="conversation">
            {thread && (
              <div className="workflow-toolbar">
                <UsageIndicators thread={thread} />
                <button onClick={() => setTasks(true)}>Tasks and queue</button>
                <button onClick={() => void action('history:export', { id: thread.id })}>
                  Export chat
                </button>
              </div>
            )}
            {state.recoveryNotice && <p role="status">{state.recoveryNotice}</p>}
            {searchHit && searchHit.threadId === activeId && (
              <div className="search-context" role="status">
                <span>
                  Search match · {searchHit.kind}: {searchHit.before}
                  <mark>{searchHit.match}</mark>
                  {searchHit.after}
                </span>
                <button
                  className="icon-button"
                  aria-label="Dismiss search match"
                  onClick={() => setSearchHit(undefined)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <div
              className="messages"
              ref={messages}
              onScroll={() => {
                const element = messages.current!;
                stick.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 100;
              }}
            >
              {thread && (historyPage ? historyPage.hasOlder : (thread.historyStart ?? 0) > 0) && (
                <button
                  onClick={async () => {
                    const page = await action('history:page', {
                      id: thread.id,
                      before: historyPage?.start ?? thread.historyStart,
                    });
                    if (page) setHistoryPage(page);
                  }}
                >
                  Older messages
                </button>
              )}
              {historyPage && (
                <div className="input-row">
                  <span>
                    Messages {historyPage.start + 1}–{historyPage.end} of {historyPage.total}
                  </span>
                  {historyPage.hasNewer && (
                    <button
                      onClick={async () => {
                        const page = await action('history:page', {
                          id: thread?.id,
                          before: Math.min(historyPage.total, historyPage.end + 80),
                        });
                        if (page) setHistoryPage(page);
                      }}
                    >
                      Newer messages
                    </button>
                  )}
                  <button onClick={() => setHistoryPage(undefined)}>Latest messages</button>
                </div>
              )}
              {!thread?.entries.length && (
                <div className="welcome">
                  <div className="welcome-symbol">/</div>
                  <div className="eyebrow">YOUR LOCAL CODING WORKSPACE</div>
                  <h1>What are we building?</h1>
                  <p>
                    Bring a project. Start a conversation.
                    <br />
                    Let Grok work alongside you.
                  </p>
                  <div className="suggestions">
                    {[
                      {
                        icon: <Code2 size={18} />,
                        title: 'Explore the codebase',
                        text: 'Explain the architecture of this project and identify its main entry points.',
                      },
                      {
                        icon: <GitCompareArrows size={18} />,
                        title: 'Review my changes',
                        text: 'Review the current Git changes for bugs and missing tests. Explain your findings before editing.',
                      },
                      {
                        icon: <MessageSquare size={18} />,
                        title: 'Plan a feature',
                        text: 'Help me plan a new feature. Start by understanding this project and asking what I want to build.',
                      },
                    ].map((item) => (
                      <button
                        key={item.title}
                        onClick={() => {
                          setDrafts((value) => ({ ...value, [draftKey]: item.text }));
                          composer.current?.focus();
                        }}
                      >
                        {item.icon}
                        <span>{item.title}</span>
                        <ArrowUpRight size={13} />
                      </button>
                    ))}
                  </div>
                  {!project && (
                    <button className="primary" onClick={() => void addProject()}>
                      <FolderOpen size={16} />
                      Open a project
                    </button>
                  )}
                  <div className="welcome-footnote">Powered by Grok Build</div>
                </div>
              )}
              <div className="timeline">
                {(historyPage?.entries ?? thread?.entries)?.map((entry) => (
                  <div
                    key={entry.id}
                    data-entry-id={entry.id}
                    tabIndex={-1}
                    className={
                      searchHit?.threadId === thread?.id && searchHit?.entryId === entry.id
                        ? 'matched-entry'
                        : ''
                    }
                  >
                    <Activity entry={entry} />
                  </div>
                ))}
              </div>
              {thread?.error && (
                <div className="inline-error">
                  <span>{thread.error}</span>
                  <button
                    onClick={() => {
                      setExecutable(state.settings.executable);
                      setSettings(true);
                    }}
                  >
                    Runtime settings
                    <ArrowUpRight size={12} />
                  </button>
                  {thread.session?.agent?.authMethods?.map((method: Wire) => (
                    <button
                      key={method.id}
                      onClick={() =>
                        void action('agent:authenticate', { id: thread.id, methodId: method.id })
                      }
                    >
                      Authenticate: {method.name}
                    </button>
                  ))}
                </div>
              )}
              {busy && (
                <div className="working">
                  <LoaderCircle size={14} className="spin" />
                  {currentPermissions.length
                    ? 'Waiting for your approval'
                    : thread?.status === 'connecting'
                      ? 'Connecting to Grok Build…'
                      : 'Grok is working…'}
                </div>
              )}
              <div ref={end} />
            </div>
            <div className="composer-area">
              {currentPermissions.map((permission) => (
                <div className="permission-card" key={permission.id}>
                  <div className="permission-title">
                    <ShieldCheck size={17} />
                    <strong>
                      {permission.kind === 'trust' ? 'Project trust required' : 'Approval required'}
                    </strong>
                    <span>{permission.toolCall.kind}</span>
                  </div>
                  <p>{permission.toolCall.title ?? 'Tool execution'}</p>
                  <details>
                    <summary>Review action</summary>
                    <pre>{pretty(permission.toolCall).slice(0, 80_000)}</pre>
                  </details>
                  <div className="permission-options">
                    {permission.options.map((option: Wire) => (
                      <button
                        key={option.optionId}
                        className={option.kind?.startsWith('reject') ? 'reject' : 'approve'}
                        onClick={() =>
                          void action('permission:answer', {
                            permissionId: permission.id,
                            optionId: option.optionId,
                          })
                        }
                      >
                        {option.name}
                      </button>
                    ))}
                    <button
                      onClick={() =>
                        void action('permission:answer', { permissionId: permission.id })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
              {project?.hidden ? (
                <div className="archived-banner">
                  This project was removed from the sidebar.
                  <button
                    onClick={async () => {
                      const updated = await action('project:edit', {
                        projectId: project.id,
                        hidden: false,
                      });
                      if (updated) projectSaved(updated);
                    }}
                  >
                    Restore project
                  </button>
                </div>
              ) : thread?.archived ? (
                <div className="archived-banner">
                  This chat is archived.
                  <button
                    onClick={() => void action('thread:edit', { id: thread.id, archived: false })}
                  >
                    Restore chat
                  </button>
                </div>
              ) : (
                <div className="composer">
                  {(attached[draftKey] ?? []).length > 0 && (
                    <div className="attachments">
                      {attached[draftKey].map((item) => (
                        <span key={item.id}>
                          <File size={12} />
                          {item.name}
                          <button
                            className="icon-button"
                            aria-label={`Remove ${item.name}`}
                            onClick={() =>
                              setAttached((value) => ({
                                ...value,
                                [draftKey]: value[draftKey].filter((file) => file.id !== item.id),
                              }))
                            }
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={composer}
                    aria-label="Message Grok"
                    placeholder={
                      project
                        ? 'Ask Grok to build, explore, or fix something…'
                        : 'Open a project to get started…'
                    }
                    value={draft}
                    onChange={(event) =>
                      setDrafts((value) => ({ ...value, [draftKey]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-bottom">
                    <div className="composer-options">
                      <button
                        className="icon-button"
                        title="Attach files"
                        aria-label="Attach files"
                        disabled={busy}
                        onClick={async () => {
                          const items = await action('attachments:pick');
                          if (items)
                            setAttached((value) => ({
                              ...value,
                              [draftKey]: [...(value[draftKey] ?? []), ...items].slice(0, 5),
                            }));
                        }}
                      >
                        <Paperclip size={17} />
                      </button>
                      {thread && (
                        <button disabled={busy} onClick={() => setMediaOpen(true)}>
                          Media
                        </button>
                      )}
                      {thread ? (
                        <ConfigControls thread={thread} action={action} />
                      ) : (
                        <span className="muted">Grok defaults</span>
                      )}
                    </div>
                    {busy && thread ? (
                      <>
                        <button disabled={!draft.trim()} onClick={() => void send()}>
                          Queue prompt
                        </button>
                        <button
                          disabled={!draft.trim() || thread.status !== 'running'}
                          onClick={async () => {
                            const result = await action('agent:steer', {
                              id: thread.id,
                              text: draft,
                            });
                            if (result) setDrafts((value) => ({ ...value, [draftKey]: '' }));
                          }}
                        >
                          Steer now
                        </button>
                        <button
                          className="send stop"
                          aria-label="Stop turn"
                          title="Stop turn"
                          onClick={() => void action('agent:cancel', { id: thread.id })}
                        >
                          <Square size={14} />
                        </button>
                      </>
                    ) : (
                      <button
                        className="send"
                        aria-label="Send message"
                        title="Send message"
                        disabled={!draft.trim() && !attached[draftKey]?.length}
                        onClick={() => void send()}
                      >
                        <ArrowUp size={19} />
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="composer-caption">
                <span>
                  <GitBranch size={12} />
                  {git?.branch ?? 'Local workspace'}
                </span>
                <span>Enter to send · Shift Enter for newline</span>
              </div>
            </div>
            {terminal && thread && (
              <div className="terminal-panel">
                <div className="panel-heading">
                  <span>
                    <TerminalSquare size={14} />
                    TERMINAL
                  </span>
                  <span className="muted">{thread.cwd}</span>
                  <button
                    className="icon-button"
                    aria-label="Close terminal"
                    onClick={() => {
                      void action('terminal:close', { id: thread.id });
                      setTerminal(false);
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
                <Suspense fallback={<div className="muted">Opening terminal…</div>}>
                  <TerminalPanel
                    key={thread.id}
                    id={thread.id}
                    error={setError}
                    context={(text) => {
                      setDrafts((value) => ({
                        ...value,
                        [draftKey]: (value[draftKey] ?? '') + '\n\n' + text,
                      }));
                      composer.current?.focus();
                    }}
                  />
                </Suspense>
              </div>
            )}
          </section>
          {inspector && (
            <aside className="inspector">
              <div className="inspector-tabs">
                <button
                  className={tab === 'changes' ? 'selected' : ''}
                  onClick={() => {
                    setTab('changes');
                    setPreview(undefined);
                  }}
                >
                  <GitCompareArrows size={15} />
                  Changes{count > 0 && <span>{count}</span>}
                </button>
                <button
                  className={tab === 'files' ? 'selected' : ''}
                  onClick={() => setTab('files')}
                >
                  <Folder size={15} />
                  Files
                </button>
                <button
                  className="icon-button"
                  aria-label="Refresh workspace"
                  title="Refresh workspace"
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={14} />
                </button>
              </div>
              {!thread ? (
                <div className="inspector-empty">
                  <GitCompareArrows size={28} />
                  <h3>Your workspace, in view.</h3>
                  <p>Files, changes, and worktrees appear here when you open a project.</p>
                </div>
              ) : (
                <>
                  <div className="workspace-location">
                    <Folder size={14} />
                    <span title={thread.cwd}>{thread.cwd}</span>
                    <button
                      className="icon-button"
                      aria-label="Show workspace in Explorer"
                      onClick={() => void action('workspace:reveal', { id: thread.id })}
                    >
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                  {panelError && <div className="panel-error">{panelError}</div>}
                  {tab === 'changes' && (
                    <>
                      <div className="git-summary">
                        <span>
                          <GitBranch size={14} />
                          {git?.branch ?? 'Git unavailable'}
                        </span>
                        <button
                          disabled={busy || !git}
                          onClick={() => {
                            setBranch(`grok/task-${Date.now().toString(36)}`);
                            setWorktree(true);
                          }}
                        >
                          <Plus size={13} />
                          Worktree
                        </button>
                      </div>
                      {git && (
                        <GitChanges
                          key={thread.id}
                          id={thread.id}
                          git={git}
                          busy={busy}
                          refresh={refresh}
                        />
                      )}
                    </>
                  )}
                  {tab === 'files' &&
                    (preview ? (
                      <>
                        <div className="file-preview-heading">
                          <button
                            className="icon-button"
                            aria-label="Back to files"
                            onClick={() => setPreview(undefined)}
                          >
                            <ChevronRight className="back" size={15} />
                          </button>
                          <span>{preview.name}</span>
                          <small>Text editor</small>
                        </div>
                        <FileEditor
                          key={`${thread.cwd}:${preview.path}`}
                          id={thread.id}
                          path={preview.path}
                          draft={fileDrafts[`${thread.cwd}\0${preview.path}`]}
                          update={(draft) =>
                            setFileDrafts((items) => ({
                              ...items,
                              [`${thread.cwd}\0${preview.path}`]: draft,
                            }))
                          }
                          busy={busy}
                        />
                      </>
                    ) : (
                      <>
                        <div className="file-path">
                          <span>{filePath}</span>
                          {filePath !== '.' && (
                            <button
                              onClick={() => {
                                const components = filePath.split(/[\\/]/);
                                components.pop();
                                setFilePath(components.join('/') || '.');
                              }}
                            >
                              Up one folder
                            </button>
                          )}
                        </div>
                        <div className="file-list">
                          {fileItems.map((item) => (
                            <button
                              key={item.path}
                              onClick={async () => {
                                if (item.directory) setFilePath(item.path);
                                else {
                                  setPreview({ name: item.name, path: item.path });
                                }
                              }}
                            >
                              {item.directory ? <Folder size={15} /> : <File size={14} />}
                              <span>{item.name}</span>
                              {item.directory && <ChevronRight size={12} />}
                            </button>
                          ))}
                        </div>
                      </>
                    ))}
                </>
              )}
              <div className="inspector-footer">
                <ShieldCheck size={14} />
                <span>
                  Permissions apply.<small>Windows OS sandbox unavailable.</small>
                </span>
              </div>
            </aside>
          )}
        </div>
      </main>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {search && <ChatSearch close={() => setSearch(false)} select={selectSearchHit} />}
      {organize && (
        <Organization state={state} close={() => setOrganize(false)} updated={setState} />
      )}
      {tasks && thread && <TaskDashboard thread={thread} close={() => setTasks(false)} />}
      {projectSettings && state.projects.find((item) => item.id === projectSettings) && (
        <ProjectSettings
          key={projectSettings}
          project={state.projects.find((item) => item.id === projectSettings)!}
          close={() => setProjectSettings(undefined)}
          saved={projectSaved}
        />
      )}
      {settings && (
        <div className="modal-backdrop" onClick={() => closeSettings()}>
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">GROK WORKBENCH</span>
                <h2>Settings</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close settings"
                onClick={() => closeSettings()}
              >
                <X size={18} />
              </button>
            </div>
            <h3>Grok engine</h3>
            <p>
              The built-in engine includes Grok Build’s agent, OAuth/API authentication, project
              rules, skills, plugins, and MCP support. A separate Grok executable is optional.
            </p>
            <label className="field-label" htmlFor="executable">
              Engine (embedded is recommended)
            </label>
            <div className="input-row">
              <input
                id="executable"
                value={executable}
                onChange={(event) => setExecutable(event.target.value)}
                placeholder="embedded, grok or C:\path\to\grok.exe"
              />
              <button
                onClick={async () => {
                  const path = await action('settings:executable');
                  if (path) setExecutable(path);
                }}
              >
                Browse
              </button>
            </div>
            <small>
              Use “embedded” for the built-in engine, “grok” on PATH, or select a Windows
              executable.
            </small>
            <div className="runtime-help">
              <h4>First-time setup</h4>
              <p>
                Select embedded and save settings, then connect a project chat to sign in. Your
                project still needs its own development tools.
              </p>
              <button
                onClick={() =>
                  void action('external:open', { url: 'https://docs.x.ai/build/overview' })
                }
              >
                Installation & documentation
                <ArrowUpRight size={13} />
              </button>
              {thread && (
                <button
                  onClick={() => {
                    closeSettings();
                    setTerminal(true);
                  }}
                >
                  Open project terminal
                  <TerminalSquare size={13} />
                </button>
              )}
            </div>
            <div className="runtime-help">
              <h4>Execution boundaries</h4>
              <p>
                Grok controls tool permissions and project trust. The GUI presents approval requests
                without enabling always-approve. Grok currently has no OS sandbox on Windows. The
                interactive terminal runs as your Windows user.
              </p>
            </div>
            <McpSettings thread={thread} />
            <AuthenticationSettings
              state={state}
              thread={thread}
              signedIn={() => closeSettings(true)}
            />
            <IntegrationSettings thread={thread} />
            <ConfigurationEditor thread={thread} dirtyChanged={setConfigurationDirty} />
            <ProjectActions thread={thread} />
            <DesktopPreferences state={state} />
            {thread && <GitRepositoryTools key={thread.id} thread={thread} />}
            {thread && (
              <WorktreeTools
                key={thread.id}
                thread={thread}
                select={(id) => {
                  setActiveId(id);
                  closeSettings();
                }}
              />
            )}
            {thread && (
              <SessionTools
                key={thread.id}
                thread={thread}
                select={(id) => {
                  setActiveId(id);
                  closeSettings();
                }}
              />
            )}
            <div className="modal-actions">
              <button onClick={() => closeSettings()}>Cancel</button>
              <button
                className="primary"
                onClick={async () => {
                  const result = await action('settings:save', { executable });
                  if (result) closeSettings();
                }}
              >
                Save settings
              </button>
              {thread && (
                <button onClick={() => void action('agent:connect', { id: thread.id })}>
                  Connect Grok
                </button>
              )}
            </div>
            <small className="muted">
              Grok Workbench 0.6.3 · Independent client · Windows first
            </small>
          </section>
        </div>
      )}
      {mediaOpen && thread && (
        <MediaStudio
          thread={thread}
          close={() => setMediaOpen(false)}
          attach={(asset) => {
            setAttached((value) => ({
              ...value,
              [draftKey]: [...(value[draftKey] ?? []), asset].slice(0, 5),
            }));
            setMediaOpen(false);
          }}
        />
      )}
      {worktree && thread && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-label="Create worktree" aria-modal="true">
            <h2>Give this task its own workspace</h2>
            <p>
              Create or select a branch from a chosen reference. Existing uncommitted changes stay
              in the original checkout.
            </p>
            <label className="field-label" htmlFor="branch">
              New branch
            </label>
            <input id="branch" value={branch} onChange={(event) => setBranch(event.target.value)} />
            <label>
              Base reference{' '}
              <input
                value={baseRef}
                disabled={existingBranch}
                onChange={(event) => setBaseRef(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={existingBranch}
                onChange={(event) => setExistingBranch(event.target.checked)}
              />
              Use an existing local branch
            </label>
            <div className="modal-actions">
              <button onClick={() => setWorktree(false)}>Cancel</button>
              <button
                className="primary"
                onClick={async () => {
                  const result = await action('git:worktree', {
                    id: thread.id,
                    branch,
                    base: baseRef,
                    existing: existingBranch,
                  });
                  if (result) {
                    setWorktree(false);
                    setActiveId(result.id);
                  }
                }}
              >
                Choose folder & create
              </button>
            </div>
          </section>
        </div>
      )}
      {rename && thread && (
        <div className="modal-backdrop">
          <section className="modal small" role="dialog" aria-label="Rename chat" aria-modal="true">
            <h2>Rename chat</h2>
            <input
              aria-label="Chat title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="modal-actions">
              <button onClick={() => setRename(false)}>Cancel</button>
              <button
                className="primary"
                onClick={async () => {
                  await action('thread:edit', { id: thread.id, title });
                  setRename(false);
                }}
              >
                Save
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
