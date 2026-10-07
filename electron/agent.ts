import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { RpcProcess } from './rpc';
import { Store } from './store';
import { runtimeExecutable } from './runtime';
import type { Attachment, DesktopEvent, Permission, Wire } from '../shared/types';
import { version } from '../package.json';
import { nativeMethods, extensionResult, publicAgent } from './native-extensions';

interface Connection {
  rpc: RpcProcess;
  initialized?: Wire;
  loading: boolean;
  suppressReplay?: boolean;
  turn?: string;
  cancelTimer?: NodeJS.Timeout;
}
export class Agents {
  private connections = new Map<string, Connection>();
  private connecting = new Map<string, Promise<Wire>>();
  private permissions = new Map<
    string,
    { permission: Permission; rpc: RpcProcess; rpcId: string | number }
  >();
  constructor(
    private store: Store,
    private emit: (event: DesktopEvent) => void,
    private launch: (cwd: string) => RpcProcess = (cwd) =>
      new RpcProcess(
        runtimeExecutable(store.state.settings.executable),
        ['agent', '--no-leader', 'stdio'],
        cwd,
      ),
  ) {}

  private connection(id: string): Connection {
    const existing = this.connections.get(id);
    if (existing) return existing;
    const thread = this.store.thread(id);
    const connection: Connection = { rpc: this.launch(thread.cwd), loading: false };
    this.connections.set(id, connection);
    connection.rpc.on('notification', (message: Wire) => {
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
          clientInfo: { name: 'grok-studio', title: 'Grok Studio', version },
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
  async prompt(id: string, text: string, attachments: Attachment[]) {
    const thread = this.store.thread(id);
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
    });
    if (thread.title === 'New chat')
      thread.title = text.replace(/\s+/g, ' ').slice(0, 60) || 'Attached files';
    this.store.touch();
    const prompt: Wire[] = [{ type: 'text', text }];
    for (const attachment of attachments) {
      if (connection.initialized?.agentCapabilities?.promptCapabilities?.embeddedContext)
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
      this.store.flush();
    }
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
      connection.rpc.close();
    }
    const thread = this.store.thread(id);
    thread.session = { ...thread.session, connected: false };
    thread.status = 'interrupted';
    this.store.touch();
  }
  shutdown() {
    for (const id of this.connections.keys()) this.disconnect(id);
  }
  async shutdownAndWait() {
    const processes = [...this.connections.values()].map((connection) => connection.rpc);
    this.shutdown();
    await Promise.all(processes.map((rpc) => rpc.waitForExit()));
  }
}
