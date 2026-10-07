import { Agents } from './agent';
import { Store } from './store';
import { publicCatalog } from './native-extensions';
import { forgetMcpCredential } from './configuration';
import { grokProfile } from './runtime';
import type { Wire } from '../shared/types';

function text(value: unknown, label: string, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`Invalid ${label}.`);
  return value;
}
export class Integrations {
  constructor(
    private agents: Agents,
    private store: Store,
  ) {}
  async list(id: string, kind: string) {
    const thread = this.store.thread(id);
    if (!['mcp', 'skills', 'plugins', 'hooks'].includes(kind))
      throw new Error('Choose a supported integration category.');
    await this.agents.connect(id);
    const result = await this.agents.native(id, `_x.ai/${kind}/list`, {
      sessionId: thread.sessionId,
      cwd: thread.cwd,
      refresh: true,
      cache: false,
    });
    return kind === 'mcp' ? publicCatalog(result) : result;
  }
  async action(id: string, kind: string, input: Wire) {
    const thread = this.store.thread(id);
    const catalog = await this.list(id, kind);
    const operation = text(input.operation, 'operation', 40);
    if (kind === 'mcp') {
      const server = catalog.servers.find((server: Wire) => server.name === input.name);
      if (!server) throw new Error('Refresh and select a configured server.');
      if (operation === 'logout') {
        if (server.name === 'github-oauth' && server.type === 'stdio') {
          if (input.reviewed !== true) throw new Error('Confirm clearing the GitHub connection.');
          await this.agents.shutdownAndWait();
          return { memoryCleared: true, providerConsentRevoked: false };
        }
        if (input.reviewed !== true || server.type !== 'http' || !server.url)
          throw new Error('Confirm forgetting the selected local HTTP MCP credential.');
        await this.agents.shutdownAndWait();
        return forgetMcpCredential(grokProfile(), server.name, server.url);
      }
      const snake = { session_id: thread.sessionId, server_name: server.name };
      if (operation === 'auth-status' && server.name === 'github-oauth' && server.type === 'stdio')
        return {
          message:
            'GitHub manages OAuth inside its server process. Sign in / verify identity checks the account; disconnecting clears its in-memory token.',
        };
      if (operation === 'auth-status')
        return this.agents.native(id, '_x.ai/mcp/auth_status', { session_id: thread.sessionId });
      if (operation === 'sign-in' && server.name === 'github-oauth' && server.type === 'stdio') {
        if (
          !server.session?.tools?.some(
            (tool: Wire) => tool.name === 'get_me' && tool.enabled !== false,
          )
        )
          throw new Error(
            'Initialize MCP with a first prompt and enable its advertised get_me tool before verifying GitHub identity.',
          );
        return this.agents.native(id, '_x.ai/mcp/call', {
          sessionId: thread.sessionId,
          server: server.name,
          tool: 'get_me',
          arguments: {},
        });
      }
      if (operation === 'sign-in') return this.agents.native(id, '_x.ai/mcp/auth_trigger', snake);
      if (operation === 'tool-policy') {
        if (
          typeof input.enabled !== 'boolean' ||
          !server.session?.tools?.some((tool: Wire) => tool.name === input.tool)
        )
          throw new Error('Choose an advertised tool and policy.');
        return this.agents.native(id, '_x.ai/mcp/toggle_tool', {
          ...snake,
          tool_name: input.tool,
          enabled: input.enabled,
        });
      }
      if (operation === 'resource-read')
        return this.agents.native(id, '_x.ai/mcp/read_resource', {
          sessionId: thread.sessionId,
          server: server.name,
          uri: text(input.uri, 'resource URI'),
        });
      if (operation === 'setup') {
        if (
          !input.values ||
          typeof input.values !== 'object' ||
          Array.isArray(input.values) ||
          JSON.stringify(input.values).length > 16000
        )
          throw new Error('Invalid server setup values.');
        const fields = server.setup?.fields ?? [];
        if (
          !fields.length ||
          Object.keys(input.values).some(
            (key) => !fields.some((field: Wire) => field.id === key),
          ) ||
          fields.some(
            (field: Wire) =>
              (field.required && !input.values[field.id]) ||
              (input.values[field.id] !== undefined &&
                !field.options?.some((option: Wire) => option.value === input.values[field.id])),
          )
        )
          throw new Error('Choose advertised setup options for this server.');
        return this.agents.native(id, '_x.ai/mcp/setup', {
          sessionId: thread.sessionId,
          serverName: server.name,
          values: input.values,
        });
      }
      throw new Error('This runtime has no exposed MCP logout or resource/prompt-list operation.');
    }
    if (kind === 'skills') {
      if (operation === 'add' || operation === 'remove') {
        if (input.reviewed !== true)
          throw new Error(
            'Review the source and its trust scope before changing registered skill paths.',
          );
        return this.agents.native(id, `_x.ai/skills/${operation}`, {
          cwd: thread.cwd,
          path: text(input.path, 'skill source path'),
        });
      }
      if (operation === 'toggle') {
        if (
          typeof input.enabled !== 'boolean' ||
          !catalog.skills?.some((skill: Wire) => skill.name === input.name)
        )
          throw new Error('Choose an inventoried skill.');
        return this.agents.native(id, '_x.ai/skills/toggle', {
          cwd: thread.cwd,
          name: input.name,
          enabled: input.enabled,
        });
      }
    }
    if (kind === 'plugins') {
      let action: Wire;
      if (operation === 'install') {
        if (input.reviewed !== true)
          throw new Error('Review and trust the plugin source before installation.');
        action = { type: 'install', source: text(input.source, 'plugin source') };
      } else if (operation === 'add' || operation === 'remove') {
        if (input.reviewed !== true)
          throw new Error('Review the plugin directory and its trust scope.');
        action = { type: operation, path: text(input.path, 'plugin source path') };
      } else if (['enable', 'disable', 'update', 'uninstall'].includes(operation)) {
        if (!catalog.plugins?.some((plugin: Wire) => plugin.id === input.name))
          throw new Error('Choose an inventoried plugin.');
        if (operation === 'uninstall' && input.reviewed !== true)
          throw new Error('Confirm the selected plugin removal.');
        action = { type: operation, plugin_id: input.name, confirmed: input.reviewed === true };
      } else if (operation === 'reload') action = { type: 'reload' };
      else throw new Error('Unsupported plugin action.');
      return this.agents.native(id, '_x.ai/plugins/action', {
        sessionId: thread.sessionId,
        action,
      });
    }
    if (kind === 'hooks') {
      if (['add', 'remove', 'trust', 'untrust'].includes(operation)) {
        if (input.reviewed !== true)
          throw new Error('Review the hook source and executable policy before this change.');
        const path = ['add', 'remove'].includes(operation)
          ? text(input.path, 'hook source')
          : undefined;
        if (
          operation === 'remove' &&
          catalog.hooks?.some((hook: Wire) => hook.sourceDir === path && hook.pinned)
        )
          throw new Error('Managed hook sources cannot be removed.');
        return this.agents.native(id, '_x.ai/hooks/action', {
          sessionId: thread.sessionId,
          action: { type: operation, ...(path ? { path } : {}) },
        });
      }
      if (operation === 'reload')
        return this.agents.native(id, '_x.ai/hooks/action', {
          sessionId: thread.sessionId,
          action: { type: 'reload' },
        });
      const hook = catalog.hooks?.find((hook: Wire) => hook.name === input.name);
      if (!hook || hook.pinned || !['enable', 'disable'].includes(operation))
        throw new Error('Select an editable hook; managed hooks are read-only.');
      return this.agents.native(id, '_x.ai/hooks/action', {
        sessionId: thread.sessionId,
        action: { type: operation, hook_name: hook.name },
      });
    }
    throw new Error('Unsupported integration action.');
  }
}
