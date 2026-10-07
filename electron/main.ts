import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { basename, join, isAbsolute, dirname, delimiter } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from './store';
import { Agents } from './agent';
import { Sessions } from './sessions';
import { Integrations } from './integrations';
import { Configuration } from './configuration';
import { Actions } from './actions';
import { Worktrees } from './worktrees';
import { GitReview } from './git-review';
import { Terminals } from './terminals';
import { Mcp } from './mcp';
import { openDocument, saveDocument } from './editor';
import { changeIndex, commitIndex, fileDiff } from './git-actions';
import { rendererUrlMatches } from './renderer-origin';
import { searchTranscripts } from './search';
import { bundledRuntime, desktopDataDirectory, runtimeExecutable, grokProfile } from './runtime';
import { createWorktree, directory, files, gitState, textFile } from './workspace';
import type { Attachment, DesktopEvent, Wire } from '../shared/types';

const isDev = process.argv.includes('--dev');
const rendererFile = join(__dirname, '../../dist/index.html');
let window: BrowserWindow;
let store: Store;
let agents: Agents;
let sessions: Sessions;
let integrations: Integrations;
let configuration: Configuration;
let actions: Actions;
let worktrees: Worktrees;
let gitReview: GitReview;
let terminals: Terminals;
let mcp: Mcp;
let mcpMutation = false;
let workspaceMutation = false;
let dirtyDocuments = 0;
let closing = false;
let closePrompt = false;
const attachments = new Map<string, Attachment>();
let searchRequest = 0;
function emit(event: DesktopEvent) {
  if (window && !window.isDestroyed()) window.webContents.send('desktop:event', event);
}
function string(value: unknown, name: string, max = 10000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw new Error(`Invalid ${name}.`);
  return value;
}
function trusted(frame: Electron.WebFrameMain | null) {
  return (
    frame &&
    frame === window.webContents.mainFrame &&
    (isDev ? frame.url === 'http://127.0.0.1:5173/' : rendererUrlMatches(frame.url, rendererFile))
  );
}
async function dispatch(method: string, args: Wire) {
  if (
    actions?.running() &&
    [
      'agent:connect',
      'agent:prompt',
      'git:update',
      'git:commit',
      'files:save',
      'configuration:save',
      'sessions:rewind',
      'integration:action',
    ].includes(method)
  )
    throw new Error('Wait for or cancel the project action before changing workspace state.');
  if (
    (workspaceMutation || mcpMutation) &&
    (method.startsWith('sessions:') ||
      method.startsWith('integration:') ||
      method.startsWith('configuration:') ||
      method.startsWith('worktrees:') ||
      method.startsWith('review:'))
  )
    throw new Error('Wait for the current configuration/workspace change.');
  if (
    mcpMutation &&
    [
      'agent:connect',
      'agent:prompt',
      'agent:authenticate',
      'settings:save',
      'mcp:add',
      'mcp:change',
    ].includes(method)
  )
    throw new Error('Wait for the MCP configuration change to finish.');
  if (
    workspaceMutation &&
    [
      'agent:connect',
      'agent:prompt',
      'agent:authenticate',
      'settings:save',
      'git:update',
      'git:commit',
      'files:save',
    ].includes(method)
  )
    throw new Error('Wait for the workspace change to finish.');
  const thread = () => store.thread(string(args.id, 'chat ID', 100));
  const mutate = async (operation: () => Promise<unknown>) => {
    if (workspaceMutation || mcpMutation || actions?.running())
      throw new Error('Wait for the active workspace operation.');
    if (
      store.state.threads.some((item) =>
        ['running', 'approval', 'connecting'].includes(item.status),
      )
    )
      throw new Error('Stop active agent turns before editing files or changing Git state.');
    workspaceMutation = true;
    try {
      return await operation();
    } finally {
      workspaceMutation = false;
    }
  };
  switch (method) {
    case 'review:chunks':
      return {
        ...(await gitReview.chunks(
          thread().id,
          string(args.path, 'file path'),
          args.staged === true,
        )),
        comments: thread().reviewComments ?? [],
      };
    case 'review:chunk':
      return mutate(() =>
        gitReview.chunk(thread().id, { ...args, path: string(args.path, 'file path') }),
      );
    case 'review:comment':
      return gitReview.comment(thread().id, args);
    case 'review:remove-comment':
      return gitReview.removeComment(thread().id, string(args.commentId, 'comment ID', 100));
    case 'review:branches':
      return gitReview.branches(thread().id);
    case 'review:branch':
      if (dirtyDocuments) throw new Error('Save or discard drafts before switching branches.');
      return mutate(async () => {
        agents.shutdown();
        return gitReview.branch(
          thread().id,
          string(args.name, 'branch', 150),
          string(args.base ?? 'HEAD', 'base', 200),
          args.existing === true,
        );
      });
    case 'review:push-preview':
      return gitReview.pushPreview(thread().id, string(args.remote, 'remote', 100));
    case 'review:push':
      return mutate(() =>
        gitReview.push(
          thread().id,
          string(args.remote, 'remote', 100),
          string(args.revision, 'push review', 64),
        ),
      );
    case 'review:prs':
      return gitReview.prs(thread().id);
    case 'review:pr-preview':
      return gitReview.prPreview(thread().id, args);
    case 'review:pr-create':
      return mutate(() => gitReview.createPr(thread().id, args));
    case 'worktrees:list':
      return worktrees.list(thread().id);
    case 'worktrees:attach':
      return mutate(async () =>
        store.create(
          thread().projectId,
          await worktrees.selected(thread().id, string(args.path, 'worktree path')),
        ),
      );
    case 'worktrees:handoff':
      if (dirtyDocuments)
        throw new Error('Save or discard editor drafts before moving the workspace.');
      return mutate(async () => {
        const target = await worktrees.selected(thread().id, string(args.path, 'worktree path'));
        terminals.close(thread().id);
        return sessions.handoff(thread().id, target);
      });
    case 'worktrees:preview':
      return mutate(() =>
        worktrees.previewApply(thread().id, string(args.path, 'target worktree')),
      );
    case 'worktrees:apply':
      if (dirtyDocuments)
        throw new Error('Save or discard drafts before applying worktree changes.');
      return mutate(() =>
        worktrees.apply(
          thread().id,
          string(args.path, 'target worktree'),
          string(args.revision, 'apply review', 64),
        ),
      );
    case 'worktrees:archive':
      if (dirtyDocuments) throw new Error('Save or discard drafts before archiving.');
      return mutate(async () => {
        const item = thread();
        for (const chat of store.state.threads.filter((chat) => chat.cwd === item.cwd)) {
          agents.disconnect(chat.id);
          terminals.close(chat.id);
        }
        return worktrees.archive(item.id);
      });
    case 'worktrees:restore':
      return mutate(() =>
        worktrees.restore(thread().id, string(args.archiveId, 'archive ID', 100)),
      );
    case 'actions:list':
      return actions.list(thread().projectId);
    case 'actions:save':
      return mutate(async () => actions.save(thread().projectId, args));
    case 'actions:remove':
      return mutate(async () =>
        actions.remove(thread().projectId, string(args.actionId, 'action ID', 100)),
      );
    case 'actions:preview':
      return actions.preview(thread().id, string(args.actionId, 'action ID', 100));
    case 'actions:run':
      return mutate(() =>
        actions.run(
          thread().id,
          string(args.actionId, 'action ID', 100),
          string(args.revision, 'action review', 64),
        ),
      );
    case 'actions:cancel':
      return actions.cancel(string(args.runId, 'action run ID', 100));
    case 'configuration:list':
      return configuration.list(thread().cwd);
    case 'configuration:open':
      return configuration.open(string(args.sourceId, 'configuration source', 100));
    case 'configuration:save':
      return mutate(async () => {
        const result = await configuration.save(
          string(args.sourceId, 'configuration source', 100),
          string(args.text, 'configuration text', 1024 * 1024),
          string(args.revision, 'configuration revision', 64),
        );
        agents.shutdown();
        return result;
      });
    case 'sessions:list':
      return sessions.list(
        thread().id,
        args.cursor === undefined ? undefined : string(args.cursor, 'session cursor', 4000),
      );
    case 'sessions:import':
      return mutate(() => sessions.import(thread().id, string(args.sessionId, 'session ID', 150)));
    case 'sessions:fork':
      return mutate(() => sessions.fork(thread().id));
    case 'sessions:points':
      return sessions.points(thread().id);
    case 'sessions:preview':
      return sessions.preview(thread().id, args.index, string(args.mode, 'rewind scope', 40));
    case 'sessions:rewind':
      if (dirtyDocuments) throw new Error('Save or discard editor drafts before rewinding.');
      return mutate(() => sessions.rewind(thread().id, string(args.token, 'rewind review', 100)));
    case 'integration:list':
      return integrations.list(thread().id, string(args.kind, 'integration category', 20));
    case 'integration:action':
      return mutate(() =>
        integrations.action(thread().id, string(args.kind, 'integration category', 20), args),
      );
    case 'state':
      return store.state;
    case 'chats:search': {
      const request = ++searchRequest;
      return searchTranscripts(
        store.state,
        string(args.query, 'search text', 512),
        {
          archived: args.archived === true,
          hidden: args.hidden === true,
        },
        () => request !== searchRequest,
      );
    }
    case 'chats:search-cancel':
      searchRequest++;
      return;
    case 'runtime:info':
      return {
        portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
        dataDirectory: app.getPath('userData'),
        sessionDirectory: app.getPath('sessionData'),
        grokHome: process.env.GROK_HOME,
        executable: runtimeExecutable(store.state.settings.executable),
      };
    case 'mcp:list':
      return mcp.list(thread().cwd);
    case 'mcp:doctor':
      return mcp.doctor(thread().cwd, args);
    case 'mcp:add':
    case 'mcp:change': {
      if (
        store.state.threads.some((item) =>
          ['running', 'approval', 'connecting'].includes(item.status),
        )
      )
        throw new Error('Stop active turns before changing MCP configuration.');
      const cwd = thread().cwd;
      mcpMutation = true;
      try {
        const result =
          method === 'mcp:add'
            ? await mcp.add(cwd, args)
            : await mcp.change(cwd, string(args.operation, 'MCP operation', 20), args);
        agents.shutdown();
        return result;
      } finally {
        mcpMutation = false;
      }
    }
    case 'project:add': {
      const selected = await dialog.showOpenDialog(window, {
        title: 'Open a project',
        properties: ['openDirectory'],
      });
      if (selected.canceled) return null;
      const path = await directory(selected.filePaths[0]);
      return store.openProject(path, basename(path));
    }
    case 'project:edit': {
      const id = string(args.projectId, 'project ID', 100);
      if (args.hidden !== undefined && typeof args.hidden !== 'boolean')
        throw new Error('Invalid project visibility.');
      const project = store.editProject(id, {
        name: args.name === undefined ? undefined : string(args.name, 'project name', 120),
        hidden: args.hidden,
      });
      if (project.hidden) {
        for (const item of store.state.threads.filter((item) => item.projectId === id)) {
          agents.disconnect(item.id);
          terminals.close(item.id);
        }
      }
      return project;
    }
    case 'thread:new': {
      const project = store.state.projects.find((item) => item.id === args.projectId);
      if (!project) throw new Error('Choose a project first.');
      if (project.hidden) throw new Error('Restore the project before creating a new chat.');
      return store.create(project.id, project.path);
    }
    case 'thread:edit': {
      const item = thread();
      if (args.title !== undefined)
        item.title = string(args.title, 'title', 120).trim() || 'Untitled chat';
      if (typeof args.pinned === 'boolean') item.pinned = args.pinned;
      if (typeof args.archived === 'boolean') {
        if (['running', 'approval', 'connecting'].includes(item.status))
          throw new Error('Stop the active turn before archiving.');
        item.archived = args.archived;
        if (item.archived) {
          agents.disconnect(item.id);
          terminals.close(item.id);
        }
      }
      store.flush();
      return item;
    }
    case 'agent:connect':
      return agents.connect(thread().id);
    case 'agent:disconnect':
      return agents.disconnect(thread().id);
    case 'agent:prompt': {
      const ids = Array.isArray(args.attachments) ? args.attachments : [];
      if (ids.length > 5) throw new Error('Attach up to five files.');
      const content = ids.map((id) => {
        const item = attachments.get(id);
        if (!item) throw new Error('Attachment expired; attach it again.');
        return item;
      });
      const prompt = string(args.text, 'prompt', 200_000);
      if (!prompt.trim() && !content.length) throw new Error('Enter a prompt.');
      try {
        return await agents.prompt(thread().id, prompt, content);
      } finally {
        for (const id of ids) attachments.delete(id);
      }
    }
    case 'agent:cancel':
      return agents.cancel(thread().id);
    case 'agent:config':
      return agents.config(
        thread().id,
        string(args.configId, 'configuration ID', 100),
        string(args.value, 'value', 200),
      );
    case 'agent:authenticate':
      return agents.authenticate(thread().id, string(args.methodId, 'authentication method', 100));
    case 'permissions':
      return agents.permissionsSnapshot();
    case 'permission:answer':
      return agents.approve(
        string(args.permissionId, 'approval ID', 100),
        args.optionId === undefined ? undefined : string(args.optionId, 'option ID', 300),
      );
    case 'settings:save': {
      const executable = string(args.executable, 'executable', 2000).trim();
      if (
        executable !== 'grok' &&
        executable !== 'bundled' &&
        (!isAbsolute(executable) ||
          (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')))
      )
        throw new Error('Use bundled, grok on PATH, or an absolute path to the Grok executable.');
      agents.shutdown();
      store.state.settings.executable = executable;
      store.flush();
      return store.state.settings;
    }
    case 'settings:executable': {
      const result = await dialog.showOpenDialog(window, {
        title: 'Select Grok executable',
        properties: ['openFile'],
        filters: process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : [],
      });
      return result.canceled ? null : result.filePaths[0];
    }
    case 'files:list':
      return files(thread().cwd, string(args.path ?? '.', 'path'));
    case 'files:read':
      return textFile(thread().cwd, string(args.path, 'path'));
    case 'files:open':
      return openDocument(thread().cwd, string(args.path, 'path'));
    case 'files:save':
      return mutate(() =>
        saveDocument(
          thread().cwd,
          string(args.path, 'path'),
          string(args.text, 'file text', 1024 * 1024),
          string(args.revision, 'file revision', 64),
        ),
      );
    case 'editor:dirty':
      if (!Number.isInteger(args.count) || args.count < 0 || args.count > 10000)
        throw new Error('Invalid draft count.');
      dirtyDocuments = args.count;
      return;
    case 'git:state':
      return gitState(thread().cwd);
    case 'git:diff':
      return fileDiff(thread().cwd, string(args.path, 'path'), args.staged === true);
    case 'git:update':
      return mutate(() =>
        changeIndex(
          thread().cwd,
          string(args.operation, 'Git action', 20),
          string(args.path, 'path'),
          string(args.revision, 'index revision', 64),
        ),
      );
    case 'git:commit':
      return mutate(() =>
        commitIndex(
          thread().cwd,
          string(args.message, 'commit message'),
          string(args.revision, 'index revision', 64),
        ),
      );
    case 'git:worktree': {
      const item = thread();
      const result = await dialog.showSaveDialog(window, {
        title: 'Choose a new worktree folder',
        buttonLabel: 'Create worktree',
        defaultPath: join(item.cwd, '..', `grok-${Date.now()}`),
      });
      if (result.canceled || !result.filePath) return null;
      return mutate(async () => {
        const worktree = await createWorktree(
          item.cwd,
          result.filePath,
          string(args.branch, 'branch', 150),
          string(args.base ?? 'HEAD', 'base reference', 200),
          args.existing === true,
        );
        await worktrees.own(item.id, worktree.path);
        return store.create(item.projectId, worktree.path);
      });
    }
    case 'attachments:pick': {
      const result = await dialog.showOpenDialog(window, {
        title: 'Attach text files (up to five, 1 MiB each)',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return [];
      if (result.filePaths.length > 5) throw new Error('Choose up to five files.');
      const items = await Promise.all(
        result.filePaths.map(async (path) => {
          const info = await stat(path);
          if (!info.isFile() || info.size > 1024 * 1024)
            throw new Error('Attachments must be text files up to 1 MiB.');
          const text = await readFile(path, 'utf8');
          if (text.includes('\0')) throw new Error('Only text attachments are supported.');
          return { id: randomUUID(), name: basename(path), uri: pathToFileURL(path).href, text };
        }),
      );
      for (const item of items) attachments.set(item.id, item);
      // Keep abandoned drafts bounded; tokens never become a generic filesystem API.
      while (attachments.size > 50) attachments.delete(attachments.keys().next().value!);
      return items.map(({ id, name }) => ({ id, name }));
    }
    case 'terminal:open':
      return terminals.open(thread().id, thread().cwd);
    case 'terminal:write':
      return terminals.write(thread().id, string(args.data, 'terminal input', 100_000));
    case 'terminal:resize': {
      if (!Number.isInteger(args.cols) || !Number.isInteger(args.rows))
        throw new Error('Invalid terminal dimensions.');
      return terminals.resize(thread().id, args.cols, args.rows);
    }
    case 'terminal:close':
      return terminals.close(thread().id);
    case 'workspace:reveal':
      return shell.openPath(thread().cwd);
    case 'external:open': {
      const url = new URL(string(args.url, 'URL'));
      if (!['https:', 'http:'].includes(url.protocol))
        throw new Error('Only HTTP links can be opened.');
      await shell.openExternal(url.href);
      return;
    }
    default:
      throw new Error('Unknown desktop operation.');
  }
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#101214',
    title: 'Grok Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('close', (event) => {
    if (closing) return;
    if (closePrompt) {
      event.preventDefault();
      return;
    }
    if (workspaceMutation) {
      event.preventDefault();
      void dialog.showMessageBox(window, {
        type: 'info',
        message: 'Wait for the file or Git operation to finish before quitting.',
      });
    } else if (dirtyDocuments) {
      event.preventDefault();
      closePrompt = true;
      void dialog
        .showMessageBox(window, {
          type: 'warning',
          message: `You have ${dirtyDocuments} unsaved file draft(s).`,
          detail: 'Drafts are retained while this app is open. Discard them and quit?',
          buttons: ['Keep editing', 'Discard drafts and quit'],
          defaultId: 0,
          cancelId: 0,
        })
        .then(({ response }) => {
          closePrompt = false;
          if (response === 1) {
            closing = true;
            app.quit();
          }
        });
    }
  });
  window.on('closed', () => {
    agents.shutdown();
    terminals.shutdown();
    mcp.shutdown();
    actions.shutdown();
    store.flush();
  });
  if (isDev) void window.loadURL('http://127.0.0.1:5173/');
  else void window.loadFile(rendererFile);
}
// Preserve profiles from the original name, including nonportable launches.
const dataDirectory = desktopDataDirectory(process.env, app.getPath('appData'));
if (dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true });
  app.setPath('userData', dataDirectory);
  app.setPath('sessionData', dataDirectory);
}
// Portable launches use an adjacent Grok profile; never copy existing credentials.
if (process.env.PORTABLE_EXECUTABLE_DIR && !process.env.GROK_HOME) {
  process.env.GROK_HOME = join(app.getPath('userData'), 'grok');
  mkdirSync(process.env.GROK_HOME, { recursive: true });
}
if (existsSync(bundledRuntime()))
  process.env.PATH = dirname(bundledRuntime()) + delimiter + (process.env.PATH ?? '');
// Optional user-installed provider tools travel with the selected portable profile.
const githubToolDirectory = join(grokProfile(), 'tools', 'github');
if (existsSync(join(githubToolDirectory, 'github-mcp-server.exe')))
  process.env.PATH = githubToolDirectory + delimiter + (process.env.PATH ?? '');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  void app.whenReady().then(() => {
    try {
      store = new Store(
        join(app.getPath('userData'), 'state.json'),
        (state) => emit({ type: 'state', state }),
        existsSync(bundledRuntime()) ? 'bundled' : 'grok',
      );
    } catch (error) {
      dialog.showErrorBox('Cannot load Grok Studio', (error as Error).message);
      app.quit();
      return;
    }
    // Connections are process-local even when their last session metadata was saved.
    for (const item of store.state.threads) if (item.session) item.session.connected = false;
    agents = new Agents(store, emit);
    sessions = new Sessions(agents, store);
    integrations = new Integrations(agents, store);
    configuration = new Configuration(grokProfile);
    actions = new Actions(store);
    worktrees = new Worktrees(store);
    gitReview = new GitReview(store);
    terminals = new Terminals(emit);
    mcp = new Mcp(() => runtimeExecutable(store.state.settings.executable));
    ipcMain.handle('desktop:call', async (event, method: unknown, args: unknown) => {
      if (!trusted(event.senderFrame)) throw new Error('Untrusted desktop caller.');
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Invalid operation arguments.');
      return dispatch(string(method, 'operation', 100), args as Wire);
    });
    createWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && store) createWindow();
  });
  // A canceled unsaved-draft close must leave live sessions and terminals running.
  app.on('will-quit', () => {
    agents?.shutdown();
    terminals?.shutdown();
    mcp?.shutdown();
    actions?.shutdown();
    store?.flush();
  });
}
