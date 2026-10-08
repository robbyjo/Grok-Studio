import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcProcess, type RpcClient } from './rpc';
import { Store } from './store';
import { runtimeExecutable, embeddedEngine } from './runtime';
import type { Attachment, DesktopEvent, Permission, Wire } from '../shared/types';
import { version } from '../package.json';
import { nativeMethods, extensionResult, publicAgent } from './native-extensions';

interface Connection {
  rpc: RpcClient;
  initialized?: Wire;
  loading: boolean;
  suppressReplay?: boolean;
  turn?: string;
  cancelTimer?: NodeJS.Timeout;
}
export class Agents {
  canStart = () => true;
  canConnect = () => true;
  beforeWork = async () => {};
  private draining = new Set<string>();
  private connections = new Map<string, Connection>();
  private connecting = new Map<string, Promise<Wire>>();
  private exiting = new Set<RpcClient>();
  private permissions = new Map<
    string,
    { permission: Permission; rpc: RpcClient; rpcId: string | number }
  >();
  constructor(
    private store: Store,
    private emit: (event: DesktopEvent) => void,
    private launch: (cwd: string) => RpcClient = (cwd) =>
      store.state.settings.executable === 'embedded'
        ? new (require('./embedded-rpc').EmbeddedRpc)(
            embeddedEngine(),
            cwd,
            this.environment(),
            store.state.settings.authMode ?? 'auto',
          )
        : new RpcProcess(
            runtimeExecutable(store.state.settings.executable),
            ['agent', '--no-leader', 'stdio'],
            cwd,
            this.environment(),
          ),
  ) {}
  environment = () => process.env;
  hasConnection(id: string) {
    return this.connections.has(id);
  }
  async mcp(id: string, input: Wire) {
    const rpc = this.connection(id).rpc as RpcClient & { mcp(input: Wire): Promise<any> };
    if (!rpc.mcp) throw new Error('The built-in MCP manager is unavailable.');
    return rpc.mcp(input);
  }
  async generate(id: string, input: Wire) {
    await this.beforeWork();
    if (!this.canStart()) throw new Error('Wait for the workspace or configuration operation.');
    await this.connect(id);
    const rpc = this.connections.get(id)?.rpc as RpcClient & {
      generate?: (input: Wire) => Promise<Uint8Array>;
    };
    if (!rpc.generate) throw new Error('Media generation requires the built-in Studio engine.');
    return rpc.generate(input);
  }

  private connection(id: string): Connection {
    const existing = this.connections.get(id);
    if (existing) return existing;
    if (!this.canConnect())
      throw new Error('Workbench is closing. No new native helper can start.');
    if (this.connections.size >= 8)
      throw new Error(
        'Up to eight Grok connections can run at once. Disconnect an idle chat first.',
      );
    const thread = this.store.thread(id);
    thread.usage = undefined;
    thread.runtimeStatus = undefined;
    const connection: Connection = { rpc: this.launch(thread.cwd), loading: false };
    this.connections.set(id, connection);
    connection.rpc.on('notification', (message: Wire) => {
      if (
        ['_x.ai/session_notification', 'x.ai/session_notification'].includes(message.method) &&
        message.params?.sessionId === thread.sessionId
      ) {
        this.store.vendorUpdate(id, message.params.update ?? {});
        return;
      }
      if (message.method === 'session/update' && message.params?.sessionId === thread.sessionId) {
        if (!message.params.update) return;
        if (!connection.loading && message.params.update.sessionUpdate !== 'user_message_chunk')
          this.store.update(id, message.params.update, connection.turn);
        else if (connection.loading && !connection.suppressReplay)
          this.store.update(id, message.params.update, 'replay');
      }
    });
    connection.rpc.on('request', (message: Wire) => {
      if (['x.ai/folder_trust/request', '_x.ai/folder_trust/request'].includes(message.method)) {
        if (resolve(message.params?.cwd ?? '') !== resolve(thread.cwd)) {
          connection.rpc.respond(message.id, { outcome: 'reject' });
          return;
        }
        const permission: Permission = {
          id: randomUUID(),
          threadId: id,
          kind: 'trust',
          toolCall: {
            title: `Trust project configuration in ${message.params.workspace}?`,
            cwd: message.params.cwd,
            configKinds: message.params.configKinds,
          },
          options: [
            { optionId: 'trust', name: 'Trust this folder', kind: 'allow_always' },
            { optionId: 'reject', name: 'Keep restricted', kind: 'reject_once' },
          ],
        };
        this.permissions.set(permission.id, { permission, rpc: connection.rpc, rpcId: message.id });
        thread.status = 'approval';
        this.store.touch();
        this.emit({ type: 'permission', permission });
        return;
      }
      if (message.method !== 'session/request_permission') {
        connection.rpc.reject(message.id, -32601, 'Client method is not supported.');
        return;
      }
      // A request cannot borrow another chat's approval UI.
      if (message.params?.sessionId !== thread.sessionId) {
        connection.rpc.respond(message.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      const permission: Permission = {
        id: randomUUID(),
        threadId: id,
        toolCall: message.params.toolCall ?? {},
        options: message.params.options ?? [],
      };
      this.permissions.set(permission.id, { permission, rpc: connection.rpc, rpcId: message.id });
      thread.status = 'approval';
      this.store.touch();
      this.emit({ type: 'permission', permission });
    });
    connection.rpc.on('closed', (error: Error) => {
      if (this.connections.get(id) !== connection) return;
      this.connections.delete(id);
      clearTimeout(connection.cancelTimer);
      this.clearPermissions(id, false);
      thread.status = 'error';
      thread.error = error.message;
      this.store.touch();
    });
    return connection;
  }
  connect(id: string): Promise<Wire> {
    const inflight = this.connecting.get(id);
    if (inflight) return inflight;
    const promise = this.establish(id).finally(() => this.connecting.delete(id));
    this.connecting.set(id, promise);
    return promise;
  }
  private async establish(id: string) {
    const thread = this.store.thread(id);
    const connection = this.connection(id);
    if (connection.initialized && thread.sessionId && thread.session?.connected) {
      if (thread.status === 'interrupted' && !connection.turn) {
        thread.status = 'idle';
        this.store.touch();
      }
      return thread.session;
    }
    thread.status = 'connecting';
    thread.error = undefined;
    this.store.touch();
    try {
      if (!connection.initialized) {
        connection.initialized = await connection.rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { _meta: { 'x.ai/folderTrust': { interactive: true } } },
          clientInfo: { name: 'grok-workbench', title: 'Grok Workbench', version },
        });
        if (connection.initialized.protocolVersion !== 1) {
          this.connections.delete(id);
          connection.rpc.close();
          thread.status = 'error';
          thread.error = 'Grok negotiated an unsupported ACP version.';
          this.store.touch();
          throw new Error(thread.error);
        }
        thread.session = {
          ...thread.session,
          agent: publicAgent(connection.initialized),
          connected: false,
        };
        this.store.touch();
        const defaultId = connection.initialized._meta?.defaultAuthMethodId;
        if (['cached_token', 'xai.api_key'].includes(defaultId))
          await connection.rpc.request('authenticate', { methodId: defaultId }, 60_000);
      }
      if (thread.sessionId && !connection.initialized.agentCapabilities?.loadSession)
        throw new Error('This Grok version cannot resume sessions. Start a new chat to continue.');
      connection.loading = Boolean(thread.sessionId);
      connection.suppressReplay = Boolean(thread.entries.length);
      const result = await connection.rpc.request(
        thread.sessionId ? 'session/load' : 'session/new',
        {
          ...(thread.sessionId ? { sessionId: thread.sessionId } : {}),
          cwd: thread.cwd,
          mcpServers: [],
        },
        60_000,
      );
      if (!thread.sessionId) {
        if (typeof result.sessionId !== 'string')
          throw new Error('Grok did not return a session ID.');
        thread.sessionId = result.sessionId;
      }
      thread.session = { ...result, agent: publicAgent(connection.initialized), connected: true };
      thread.status = this.permissionsSnapshot().some((item) => item.threadId === id)
        ? 'approval'
        : 'idle';
      thread.error = undefined;
      this.store.touch();
      return thread.session;
    } catch (error) {
      if (this.connections.get(id) === connection) {
        thread.status = 'error';
        thread.error = String((error as Error).message);
        this.store.touch();
      }
      throw error;
    } finally {
      connection.loading = false;
    }
  }
  async authenticate(id: string, methodId: string) {
    const thread = this.store.thread(id);
    if (['running', 'approval', 'connecting'].includes(thread.status))
      throw new Error('Stop the active operation before authenticating.');
    const connection = this.connection(id);
    if (!connection.initialized) {
      try {
        await this.connect(id);
      } catch {
        /* initialization may succeed while session needs auth */
      }
    }
    const methods = connection.initialized?.authMethods ?? [];
    if (!methods.some((method: Wire) => method.id === methodId))
      throw new Error('Select an authentication method advertised by Grok.');
    thread.status = 'connecting';
    thread.error = undefined;
    this.store.touch();
    try {
      await connection.rpc.request('authenticate', { methodId }, 180_000);
      thread.status = 'idle';
      this.store.touch();
      return await this.connect(id);
    } catch (error) {
      if (this.connections.get(id) === connection) {
        thread.status = 'error';
        thread.error = (error as Error).message;
        this.store.touch();
      }
      throw error;
    }
  }
  async prompt(id: string, text: string, attachments: Attachment[], queuedId?: string) {
    if (attachments.reduce((total, item) => total + (item.data?.length ?? 0), 0) > 12 * 1024 * 1024)
      throw new Error('Inline images exceed 12 MiB. Send fewer images in this prompt.');
    const thread = this.store.thread(id);
    this.store.assertCapacity();
    await this.beforeWork();
    if (!this.canStart()) throw new Error('Wait for the workspace or configuration operation.');
    if (thread.archived || this.store.project(thread.projectId).hidden)
      throw new Error('Restore this chat and project before sending a prompt.');
    if (['running', 'approval', 'connecting'].includes(thread.status))
      throw new Error('This chat is busy. Stop its turn before sending another prompt.');
    await this.connect(id);
    if (thread.status !== 'idle') throw new Error('Chat is not ready.');
    const connection = this.connections.get(id)!;
    const turn = randomUUID();
    connection.turn = turn;
    thread.status = 'running';
    thread.error = undefined;
    thread.entries.push({
      id: randomUUID(),
      type: 'user',
      text:
        text +
        (attachments.length
          ? `\n\nAttached: ${attachments.map((item) => item.name).join(', ')}`
          : ''),
      turn,
      data: attachments.length
        ? {
            attachments: attachments.map(({ id, name, url, mimeType }) => ({
              id,
              name,
              url,
              mimeType,
            })),
          }
        : undefined,
    });
    if (thread.title === 'New chat')
      thread.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'Attached files';
    if (queuedId) thread.queue = thread.queue?.filter((row) => row.id !== queuedId);
    // Commit delivery and removal from the queue together. A pre-delivery crash leaves it paused.
    this.store.flush();
    this.store.touch();
    const prompt: Wire[] = [{ type: 'text', text }];
    for (const attachment of attachments) {
      if (attachment.data && attachment.mimeType?.startsWith('image/'))
        prompt.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
      else if (attachment.mimeType && attachment.mimeType !== 'text/plain') {
        // The upstream @mention expander splits paths at spaces; keep binary paths explicit.
        prompt.push({
          type: 'resource_link',
          uri: attachment.uri,
          name: attachment.name,
          mimeType: attachment.mimeType,
          _meta: { source: 'studio-attachment' },
        });
        prompt.push({
          type: 'text',
          text: `User attachment ${JSON.stringify(attachment.name)} is available at ${JSON.stringify(fileURLToPath(attachment.uri))}. Inspect it with an appropriate tool if needed.`,
        });
      } else if (connection.initialized?.agentCapabilities?.promptCapabilities?.embeddedContext)
        prompt.push({
          type: 'resource',
          resource: { uri: attachment.uri, mimeType: 'text/plain', text: attachment.text },
        });
      else prompt.push({ type: 'text', text: `File: ${attachment.name}\n${attachment.text}` });
    }
    try {
      const result = await connection.rpc.request(
        'session/prompt',
        { sessionId: thread.sessionId, prompt },
        0,
      );
      thread.status = result.stopReason === 'cancelled' ? 'interrupted' : 'idle';
      thread.entries.push({
        id: randomUUID(),
        type: 'notice',
        text: result.stopReason === 'cancelled' ? 'Turn stopped' : 'Turn finished',
        data: result,
        turn,
      });
    } catch (error) {
      if (this.connections.get(id) === connection) {
        thread.status = 'error';
        thread.error = (error as Error).message;
      }
      throw error;
    } finally {
      clearTimeout(connection.cancelTimer);
      connection.turn = undefined;
      this.clearPermissions(id, true);
      thread.updatedAt = new Date().toISOString();
      if (thread.status !== 'idle') for (const row of thread.queue ?? []) row.state = 'paused';
      this.store.flush();
      this.emit({ type: 'attention', id, kind: thread.status === 'idle' ? 'complete' : 'failure' });
      if (thread.status === 'idle') setImmediate(() => void this.drainQueue(id));
    }
  }
  queue(id: string, text: string) {
    const t = this.store.thread(id);
    this.store.assertCapacity();
    if (!text.trim() || text.length > 20000 || text.includes('\0'))
      throw new Error('Enter up to 20,000 characters for a queued prompt.');
    if (t.archived || this.store.project(t.projectId).hidden)
      throw new Error('Restore the chat before queuing.');
    if (
      (t.queue?.length ?? 0) >= 20 ||
      this.store.state.threads.reduce((n, t) => n + (t.queue?.length ?? 0), 0) >= 200
    )
      throw new Error('Prompt queue limit reached.');
    t.queue = [...(t.queue ?? []), { id: randomUUID(), text, state: 'queued' }];
    this.store.flush();
    if (t.status === 'idle') setImmediate(() => void this.drainQueue(id));
    return t.queue;
  }
  editQueue(id: string, input: Wire) {
    const t = this.store.thread(id),
      rows = t.queue ?? [];
    if (input.operation === 'resume') {
      for (const r of rows) r.state = 'queued';
      this.store.flush();
      setImmediate(() => void this.drainQueue(id));
      return;
    }
    if (input.operation === 'pause') {
      for (const r of rows) r.state = 'paused';
      this.store.flush();
      return;
    }
    const index = rows.findIndex((r) => r.id === input.queueId);
    if (index < 0) throw new Error('Queued prompt no longer exists.');
    if (input.operation === 'remove') rows.splice(index, 1);
    else if (input.operation === 'edit') {
      if (
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > 20000 ||
        input.text.includes('\0')
      )
        throw new Error('Invalid queued prompt.');
      rows[index].text = input.text;
    } else if (input.operation === 'up' && index > 0)
      [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]];
    else if (input.operation !== 'up') throw new Error('Unknown queue action.');
    this.store.flush();
  }
  private async drainQueue(id: string) {
    if (this.draining.has(id)) return;
    const t = this.store.thread(id),
      next = t.queue?.[0];
    if (!next || next.state !== 'queued' || t.status !== 'idle') return;
    if (!this.canStart()) {
      for (const r of t.queue ?? []) r.state = 'paused';
      this.store.flush();
      return;
    }
    this.draining.add(id);
    next.state = 'paused';
    this.store.flush();
    const before = new Set(t.entries.map((entry) => entry.id));
    try {
      await this.prompt(id, next.text, [], next.id);
    } catch {
      // Restore only prompts rejected before delivery; a failed delivered turn remains in history.
      const delivered = t.entries.some(
        (entry) => !before.has(entry.id) && entry.type === 'user' && entry.text === next.text,
      );
      if (!delivered && !t.queue!.some((row) => row.id === next.id))
        t.queue!.unshift({ ...next, state: 'paused' });
      for (const r of t.queue!) r.state = 'paused';
      this.store.flush();
    } finally {
      this.draining.delete(id);
      if (t.status === 'idle') setImmediate(() => void this.drainQueue(id));
    }
  }
  async live(id: string, method: string, params: Wire = {}) {
    const allowed = [
      '_x.ai/interject',
      '_x.ai/task/list',
      '_x.ai/task/kill',
      '_x.ai/subagent/list_running',
      '_x.ai/subagent/get',
      '_x.ai/subagent/cancel',
      '_x.ai/session/usage',
    ];
    if (!allowed.includes(method)) throw new Error('Unsupported live operation.');
    const t = this.store.thread(id),
      c = this.connections.get(id);
    if (!c?.initialized || !t.sessionId || !t.session?.connected)
      throw new Error('Connect Grok before using live task controls.');
    return extensionResult(
      await c.rpc.request(method, { ...params, sessionId: t.sessionId }, 30000),
    );
  }
  async steer(id: string, text: string) {
    const t = this.store.thread(id);
    if (t.status !== 'running')
      throw new Error(
        'Steering is available while Grok is running. Resolve pending approval first.',
      );
    if (!text.trim() || text.length > 20000 || text.includes('\0'))
      throw new Error('Invalid steering message.');
    const result = await this.live(id, '_x.ai/interject', { text, interjectionId: randomUUID() });
    t.entries.push({
      id: randomUUID(),
      type: 'user',
      text: 'Steering: ' + text,
      turn: this.connections.get(id)?.turn,
    });
    this.store.touch();
    return result;
  }
  async dashboard(id: string) {
    const t = this.store.thread(id),
      errors: Record<string, string> = {};
    for (const [kind, method] of [
      ['tasks', '_x.ai/task/list'],
      ['subagents', '_x.ai/subagent/list_running'],
      ['usage', '_x.ai/session/usage'],
    ]) {
      try {
        const response = await this.live(id, method);
        if (kind === 'usage')
          t.usage = response.usage ? { ...response.usage, _scope: 'process' } : undefined;
        else
          this.store.vendorUpdate(id, {
            sessionUpdate: kind === 'tasks' ? 'background_tasks' : 'subagents_snapshot',
            [kind]: response[kind] ?? [],
          });
      } catch (error) {
        errors[kind] = (error as Error).message;
      }
    }
    this.store.touch();
    return { tasks: t.tasks ?? [], subagents: t.subagents ?? [], usage: t.usage, errors };
  }
  async taskControl(id: string, operation: string, target: string) {
    const t = this.store.thread(id);
    const report = await this.dashboard(id);
    if (report.errors[operation === 'kill' ? 'tasks' : 'subagents'])
      throw new Error('Cannot verify ownership while task inventory is unavailable.');
    if (operation === 'kill') {
      if (!t.tasks?.some((r) => (r.task_id ?? r.taskId) === target))
        throw new Error('Task is not owned by this chat.');
      return this.live(id, '_x.ai/task/kill', { taskId: target, source: 'clientUi' });
    }
    if (!t.subagents?.some((r) => (r.subagent_id ?? r.subagentId) === target))
      throw new Error('Subagent is not owned by this chat.');
    if (operation === 'cancel-subagent')
      return this.live(id, '_x.ai/subagent/cancel', { subagentId: target });
    if (operation === 'inspect-subagent')
      return this.live(id, '_x.ai/subagent/get', {
        subagentId: target,
        block: false,
        timeoutMs: 0,
      });
    throw new Error('Unknown task action.');
  }
  async config(id: string, configId: string, value: string) {
    const thread = this.store.thread(id);
    if (['running', 'approval', 'connecting'].includes(thread.status))
      throw new Error('Change session settings while the chat is idle.');
    await this.connect(id);
    if (thread.status !== 'idle') throw new Error('Chat is not ready.');
    const connection = this.connections.get(id)!;
    const result =
      configId === '__mode'
        ? await connection.rpc.request('session/set_mode', {
            sessionId: thread.sessionId,
            modeId: value,
          })
        : await connection.rpc.request('session/set_config_option', {
            sessionId: thread.sessionId,
            configId,
            value,
          });
    if (configId === '__mode')
      thread.session = {
        ...thread.session,
        modes: { ...thread.session?.modes, currentModeId: value },
      };
    else thread.session = { ...thread.session, configOptions: result.configOptions };
    this.store.touch();
  }
  async native(id: string, method: string, params: Wire = {}) {
    if (!nativeMethods.has(method)) throw new Error('Unsupported native operation.');
    const thread = this.store.thread(id);
    if (['running', 'approval', 'connecting'].includes(thread.status))
      throw new Error('Stop the active operation first.');
    await this.connect(id);
    if (thread.status !== 'idle')
      throw new Error('Resolve project trust before using this operation.');
    const response = await this.connections.get(id)!.rpc.request(method, params, 180000);
    return extensionResult(response);
  }
  permissionsSnapshot() {
    return [...this.permissions.values()].map((item) => item.permission);
  }
  approve(permissionId: string, optionId?: string) {
    const pending = this.permissions.get(permissionId);
    if (!pending) throw new Error('Approval is no longer pending.');
    if (optionId && !pending.permission.options.some((option) => option.optionId === optionId))
      throw new Error('Invalid approval option.');
    pending.rpc.respond(
      pending.rpcId,
      pending.permission.kind === 'trust'
        ? { outcome: optionId === 'trust' ? 'trust' : 'reject' }
        : { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
    );
    this.permissions.delete(permissionId);
    this.emit({ type: 'permission-closed', id: permissionId });
    const thread = this.store.thread(pending.permission.threadId);
    if (!this.permissionsSnapshot().some((item) => item.threadId === thread.id))
      thread.status = this.connections.get(thread.id)?.turn ? 'running' : 'idle';
    this.store.touch();
  }
  private clearPermissions(id: string, respond: boolean) {
    for (const [key, pending] of this.permissions)
      if (pending.permission.threadId === id) {
        if (respond) {
          try {
            pending.rpc.respond(
              pending.rpcId,
              pending.permission.kind === 'trust'
                ? { outcome: 'reject' }
                : { outcome: { outcome: 'cancelled' } },
            );
          } catch {
            /* process closed */
          }
        }
        this.permissions.delete(key);
        this.emit({ type: 'permission-closed', id: key });
      }
  }
  cancel(id: string) {
    const thread = this.store.thread(id);
    for (const row of thread.queue ?? []) row.state = 'paused';
    const connection = this.connections.get(id);
    if (!connection) return;
    if (thread.status === 'connecting' || !thread.sessionId) {
      this.disconnect(id);
      return;
    }
    this.clearPermissions(id, true);
    connection.rpc.notify('session/cancel', { sessionId: thread.sessionId });
    clearTimeout(connection.cancelTimer);
    connection.cancelTimer = setTimeout(() => {
      if (['running', 'approval'].includes(thread.status)) this.disconnect(id);
    }, 8000);
  }
  disconnect(id: string) {
    const connection = this.connections.get(id);
    if (connection) {
      this.connections.delete(id);
      clearTimeout(connection.cancelTimer);
      this.clearPermissions(id, true);
      this.exiting.add(connection.rpc);
      connection.rpc.close();
      void connection.rpc
        .waitForExit()
        .catch(() => {})
        .finally(() => this.exiting.delete(connection.rpc));
    }
    const thread = this.store.thread(id);
    for (const row of thread.queue ?? []) row.state = 'paused';
    for (const task of [...(thread.tasks ?? []), ...(thread.subagents ?? [])])
      if (task.status === 'running') task.status = 'unknown after disconnect';
    thread.session = { ...thread.session, connected: false };
    thread.status = 'interrupted';
    this.store.touch();
  }
  shutdown() {
    for (const id of this.connections.keys()) this.disconnect(id);
  }
  stats() {
    return {
      connections: this.connections.size,
      pendingApprovals: this.permissions.size,
      draining: this.draining.size,
      exiting: this.exiting.size,
    };
  }
  async shutdownAndWait() {
    this.shutdown();
    await Promise.all([...this.exiting].map((rpc) => rpc.waitForExit()));
  }
}
