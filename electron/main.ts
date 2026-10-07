import { app, BrowserWindow, dialog, ipcMain, shell, Notification, protocol } from 'electron';
import { basename, join, isAbsolute, dirname, delimiter } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFile, stat, writeFile } from 'node:fs/promises';
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
import { Mcp, addArguments } from './mcp';
import { openDocument, saveDocument } from './editor';
import { changeIndex, commitIndex, fileDiff } from './git-actions';
import { rendererUrlMatches } from './renderer-origin';
import { Diagnostics } from './diagnostics';
import { Credentials } from './credentials';
import { Media, generation, mediaType } from './media';
import { validateShortcuts } from '../shared/shortcuts';
import {
  bundledRuntime,
  desktopDataDirectory,
  runtimeExecutable,
  grokProfile,
  embeddedEngine,
} from './runtime';
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
let diagnostics: Diagnostics;
let credentials: Credentials;
let media: Media;
const generating = new Set<string>();
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'grok-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
let attentionAt = 0;
let mcpMutation = false;
let workspaceMutation = false;
let dirtyDocuments = 0;
let closing = false;
let closePrompt = false;
const attachments = new Map<string, Attachment>();
let searchRequest = 0;
function emit(event: DesktopEvent) {
  if (window && !window.isDestroyed()) window.webContents.send('desktop:event', event);
  if (
    store?.state.settings.notifications &&
    Notification.isSupported() &&
    (event.type === 'attention' || event.type === 'permission') &&
    Date.now() - attentionAt > 3000 &&
    (!window || !window.isFocused())
  ) {
    attentionAt = Date.now();
    const notice = new Notification({
      title:
        event.type === 'permission'
          ? 'Grok needs your approval'
          : event.kind === 'complete'
            ? 'Grok turn completed'
            : 'Grok turn stopped',
      body: 'Open Grok Workbench to review the chat.',
    });
    const id = event.type === 'permission' ? event.permission.threadId : event.id;
    notice.on('click', () => {
      store.selected = id;
      emit({ type: 'focus-chat', id });
      emit({ type: 'state', state: store.snapshot() });
      window.show();
      window.focus();
    });
    notice.show();
  }
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
    case 'organization:projects': {
      store.organization(args);
      for (const id of args.projectIds)
        if (store.project(id).hidden)
          for (const chat of store.state.threads.filter((t) => t.projectId === id)) {
            agents.disconnect(chat.id);
            terminals.close(chat.id);
          }
      return;
    }
    case 'organization:chats': {
      store.bulkChats(args.ids, args);
      if (args.archived === true)
        for (const id of args.ids) {
          agents.disconnect(id);
          terminals.close(id);
        }
      return;
    }
    case 'thread:select':
      store.selected = thread().id;
      return store.snapshot();
    case 'history:page':
      return store.page(thread().id, args.before, args.entryId);
    case 'history:export': {
      const item = thread();
      const result = await dialog.showSaveDialog(window, {
        title: 'Export desktop transcript',
        defaultPath: item.title.replace(/[^A-Za-z0-9_-]/g, '_') + '.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await writeFile(
        result.filePath,
        JSON.stringify({ ...item, entries: store.fullHistory(item.id) }, null, 2),
        'utf8',
      );
      return { saved: true };
    }
    case 'history:prune':
      return mutate(async () => store.prune(args.ids, args.confirmed === true));
    case 'drafts:get':
      return store.history.value('drafts') ?? {};
    case 'drafts:save':
      return store.drafts(args.value);
    case 'preferences:save': {
      const shortcuts = validateShortcuts(args.shortcuts ?? store.state.settings.shortcuts ?? {});
      const budget = args.storageMiB ?? store.state.settings.storageMiB ?? 512;
      if (
        !Number.isInteger(budget) ||
        budget < 64 ||
        budget > 2048 ||
        store.history.stats().bytes > budget * 1024 * 1024
      )
        throw new Error('Choose a 64–2048 MiB budget above current storage usage.');
      if (args.notifications !== undefined && typeof args.notifications !== 'boolean')
        throw new Error('Invalid notification preference.');
      store.history.budget(budget);
      store.state.settings = {
        ...store.state.settings,
        shortcuts,
        storageMiB: budget,
        notifications: args.notifications ?? store.state.settings.notifications,
      };
      store.flush();
      return store.state.settings;
    }
    case 'diagnostics:info':
      return {
        events: diagnostics.list(),
        uptimeSeconds: process.uptime(),
        memory: process.memoryUsage(),
        storage: store.history.stats(),
        cache: store.cacheStats(),
        agents: agents.stats(),
        terminals: terminals.stats(),
        threads: store.state.threads.length,
        storageError: store.storageError,
        recoveryNotice: store.state.recoveryNotice,
      };
    case 'agent:queue':
      return agents.queue(thread().id, string(args.text, 'queued prompt', 20000));
    case 'agent:queue-edit':
      return agents.editQueue(thread().id, args);
    case 'agent:steer':
      return agents.steer(thread().id, string(args.text, 'steering text', 20000));
    case 'tasks:dashboard':
      return agents.dashboard(thread().id);
    case 'tasks:control':
      return agents.taskControl(
        thread().id,
        string(args.operation, 'task operation', 40),
        string(args.target, 'task ID', 200),
      );
    case 'terminal:list':
      return terminals.list(thread().id);
    case 'terminal:shells':
      return terminals.shells().map(({ id, name }) => ({ id, name }));
    case 'terminal:create':
      return terminals.create(thread().id, thread().cwd, string(args.shell, 'shell', 40));
    case 'terminal:context':
      return terminals.context(thread().id, args.terminalId);
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
      if (args.limit !== undefined) {
        if (!Number.isInteger(args.limit) || args.limit < 100 || args.limit > 10000)
          throw new Error('Invalid chat page limit.');
        store.viewLimit = args.limit;
      }
      return store.snapshot();
    case 'chats:search': {
      const request = ++searchRequest;
      return store.search(string(args.query, 'search text', 512), {
        archived: args.archived === true,
        hidden: args.hidden === true,
        offset: args.offset,
        limit: args.limit,
      });
    }
    case 'chats:search-cancel':
      searchRequest++;
      store.cancelSearch();
      return;
    case 'runtime:info':
      return {
        portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
        dataDirectory: app.getPath('userData'),
        sessionDirectory: app.getPath('sessionData'),
        grokHome: process.env.GROK_HOME,
        executable: runtimeExecutable(store.state.settings.executable),
      };
    case 'auth:status':
      return credentials.status();
    case 'auth:save':
    case 'auth:forget':
    case 'auth:mode': {
      if (
        store.state.threads.some((t) => ['running', 'approval', 'connecting'].includes(t.status)) ||
        generating.size
      )
        throw new Error('Stop active turns and media jobs before changing authentication.');
      if (method === 'auth:save') credentials.save(args.key, args.remember === true);
      else if (method === 'auth:forget') credentials.forget();
      else {
        if (!['auto', 'oauth', 'api'].includes(args.mode))
          throw new Error('Choose an authentication mode.');
        store.state.settings.authMode = args.mode;
      }
      await agents.shutdownAndWait();
      store.flush();
      return credentials.status();
    }
    case 'media:list':
      return media.list();
    case 'privacy:status': {
      const info = await agents.native(thread().id, '_x.ai/auth/info');
      return { codingDataRetentionOptOut: info.codingDataRetentionOptOut };
    }
    case 'privacy:set': {
      if (args.reviewed !== true || typeof args.optOut !== 'boolean')
        throw new Error('Review the account privacy change first.');
      if (
        generating.size ||
        store.state.threads.some((t) => ['running', 'approval', 'connecting'].includes(t.status))
      )
        throw new Error('Stop active turns/media jobs before changing account privacy.');
      const result = await agents.native(thread().id, '_x.ai/privacy/setCodingDataRetention', {
        codingDataRetentionOptOut: args.optOut,
      });
      await agents.shutdownAndWait();
      return { codingDataRetentionOptOut: result.codingDataRetentionOptOut };
    }
    case 'media:generate': {
      const item = thread();
      if (generating.size || ['running', 'approval', 'connecting'].includes(item.status))
        throw new Error('Wait for the active turn/media job.');
      const input = generation(args);
      media.capacity();
      generating.add(item.id);
      try {
        const bytes = Buffer.from(await agents.generate(item.id, input));
        const detected = mediaType(
          bytes,
          'generated.' + (input.kind === 'image' ? 'png' : input.kind === 'video' ? 'mp4' : 'mp3'),
        );
        const extension =
          detected === 'image/jpeg'
            ? 'jpg'
            : detected === 'image/webp'
              ? 'webp'
              : input.kind === 'image'
                ? 'png'
                : input.kind === 'video'
                  ? 'mp4'
                  : 'mp3';
        return media.add(bytes, `generated-${input.kind}-${Date.now()}.${extension}`, input.kind);
      } finally {
        generating.delete(item.id);
      }
    }
    case 'media:cancel':
      if (!generating.has(thread().id)) return;
      return agents.disconnect(thread().id);
    case 'media:delete':
      return media.delete(string(args.assetId, 'asset ID', 100));
    case 'media:export': {
      const asset = media.list().find((row) => row.id === args.assetId);
      if (!asset) throw new Error('Asset is no longer stored.');
      const result = await dialog.showSaveDialog(window, {
        title: 'Export media/attachment',
        defaultPath: asset.name,
      });
      if (!result.canceled && result.filePath)
        await writeFile(result.filePath, media.bytes(asset.id));
      return { saved: !result.canceled };
    }
    case 'mcp:list':
      if (store.state.settings.executable === 'embedded')
        return agents.mcp(thread().id, { operation: 'list' });
      return mcp.list(thread().cwd);
    case 'mcp:doctor':
      if (store.state.settings.executable === 'embedded')
        return agents.mcp(thread().id, {
          operation: 'doctor',
          name: string(args.name, 'server name', 100),
        });
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
        if (store.state.settings.executable === 'embedded') {
          const input: Wire = {
            operation: method === 'mcp:add' ? 'add' : args.operation,
            name: string(args.name, 'server name', 100),
            scope: args.scope ?? 'user',
          };
          if (method === 'mcp:add') {
            addArguments(args);
            const pairs = (values: string[], separator: string) =>
              Object.fromEntries(
                values.map((value) => {
                  const index = value.indexOf(separator);
                  return [value.slice(0, index), value.slice(index + 1).trim()];
                }),
              );
            input.config =
              args.transport === 'stdio'
                ? { command: args.command, args: args.args ?? [], env: pairs(args.env ?? [], '=') }
                : { type: args.transport, url: args.url, headers: pairs(args.headers ?? [], ':') };
          }
          const result = await agents.mcp(thread().id, input);
          await agents.shutdownAndWait();
          return result;
        }
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
      if (generating.has(thread().id)) throw new Error('Wait for the media job.');
      const content = ids.map((id) => media.attachment(string(id, 'attachment ID', 100)));
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
        executable !== 'embedded' &&
        (!isAbsolute(executable) ||
          (process.platform === 'win32' && !executable.toLowerCase().endsWith('.exe')))
      )
        throw new Error('Use embedded, grok on PATH, or an absolute path to the Grok executable.');
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
      return mutate(async () => {
        const saved = await saveDocument(
          thread().cwd,
          string(args.path, 'path'),
          string(args.text, 'file text', 1024 * 1024),
          string(args.revision, 'file revision', 64),
        );
        const drafts = store.history.value('drafts') ?? {},
          key = thread().cwd + '\0' + args.path;
        if (drafts.files?.[key]?.text === args.text) {
          delete drafts.files[key];
          store.drafts(drafts);
        }
        return saved;
      });
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
        title: 'Attach files (up to five, 50 MiB each)',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return [];
      if (result.filePaths.length > 5) throw new Error('Choose up to five files.');
      return result.filePaths.map((path) => media.attach(path));
    }
    case 'terminal:open':
      return terminals.open(thread().id, thread().cwd, args.terminalId);
    case 'terminal:write':
      return terminals.write(
        thread().id,
        string(args.data, 'terminal input', 100_000),
        args.terminalId,
      );
    case 'terminal:resize': {
      if (!Number.isInteger(args.cols) || !Number.isInteger(args.rows))
        throw new Error('Invalid terminal dimensions.');
      return terminals.resize(thread().id, args.cols, args.rows, args.terminalId);
    }
    case 'terminal:close':
      return terminals.close(thread().id, args.terminalId, args.forget === true);
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
    title: 'Grok Workbench',
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
            store.drafts({});
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
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.record('renderer-crash', { reason: details.reason, code: details.exitCode });
    agents.shutdown();
    store.flush();
    void dialog
      .showMessageBox(window, {
        type: 'error',
        message: 'The interface stopped. Saved chats and recovery drafts are retained.',
        buttons: ['Reload interface', 'Quit'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) window.reload();
        else app.quit();
      });
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
const githubCliDirectory = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI');
if (process.platform === 'win32' && existsSync(join(githubCliDirectory, 'gh.exe')))
  process.env.PATH = githubCliDirectory + delimiter + (process.env.PATH ?? '');
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
        existsSync(join(process.resourcesPath, 'engine/studio-engine.node')) ||
          existsSync(join(process.cwd(), '.runtime/studio-engine.node'))
          ? 'embedded'
          : existsSync(bundledRuntime())
            ? 'bundled'
            : 'grok',
      );
    } catch (error) {
      dialog.showErrorBox('Cannot load Grok Workbench', (error as Error).message);
      app.quit();
      return;
    }
    // Connections are process-local even when their last session metadata was saved.
    for (const item of store.state.threads) if (item.session) item.session.connected = false;
    if (
      store.state.settings.executable === 'bundled' &&
      existsSync(join(process.resourcesPath, 'engine/studio-engine.node'))
    ) {
      store.state.settings.executable = 'embedded';
      store.flush();
    }
    agents = new Agents(store, emit);
    store.storageFault = () => agents.shutdown();
    credentials = new Credentials(app.getPath('userData'));
    media = new Media(join(app.getPath('userData'), 'media-files'), store.history);
    protocol.handle('grok-media', (request) => media.response(request));
    agents.environment = () => credentials.environment(store.state.settings.authMode ?? 'auto');
    agents.canStart = () => !workspaceMutation && !mcpMutation && !actions?.running();
    sessions = new Sessions(agents, store);
    integrations = new Integrations(agents, store);
    configuration = new Configuration(grokProfile);
    actions = new Actions(store);
    worktrees = new Worktrees(store);
    gitReview = new GitReview(store);
    terminals = new Terminals(emit, store.history);
    diagnostics = new Diagnostics(join(app.getPath('userData'), 'diagnostics'));
    diagnostics.record('startup', { count: store.state.threads.length });
    mcp = new Mcp(() => runtimeExecutable(store.state.settings.executable));
    ipcMain.handle('desktop:call', async (event, method: unknown, args: unknown) => {
      if (!trusted(event.senderFrame)) throw new Error('Untrusted desktop caller.');
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Invalid operation arguments.');
      const operation = string(method, 'operation', 100),
        started = Date.now();
      try {
        const result = await dispatch(operation, args as Wire);
        if (
          ![
            'state',
            'editor:dirty',
            'terminal:write',
            'terminal:resize',
            'drafts:save',
            'chats:search-cancel',
          ].includes(operation)
        )
          diagnostics.record('operation', { method: operation, durationMs: Date.now() - started });
        if (
          result &&
          typeof result === 'object' &&
          'id' in result &&
          store.state.threads.some((t) => t === result)
        )
          return { ...result, entries: store.page((result as any).id).entries };
        return result;
      } catch (error) {
        diagnostics.record('operation-failed', {
          method: operation,
          durationMs: Date.now() - started,
          code: (error as any).code ?? 'error',
        });
        throw error;
      }
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
    store?.cancelSearch();
    store?.flush();
  });
}
