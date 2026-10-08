import type { Wire } from '../shared/types';

export const nativeMethods = new Set([
  '_x.ai/auth/info',
  '_x.ai/privacy/setCodingDataRetention',
  'session/list',
  '_x.ai/session/fork',
  '_x.ai/rewind/points',
  '_x.ai/rewind/execute',
  '_x.ai/mcp/list',
  '_x.ai/mcp/auth_status',
  '_x.ai/mcp/auth_trigger',
  '_x.ai/mcp/setup',
  '_x.ai/mcp/toggle_tool',
  '_x.ai/mcp/read_resource',
  '_x.ai/mcp/browse',
  '_x.ai/mcp/call',
  '_x.ai/skills/list',
  '_x.ai/skills/add',
  '_x.ai/skills/remove',
  '_x.ai/skills/toggle',
  '_x.ai/plugins/list',
  '_x.ai/plugins/action',
  '_x.ai/hooks/list',
  '_x.ai/hooks/action',
]);

export function extensionResult(response: Wire): Wire {
  if (response.error)
    throw new Error(
      typeof response.error === 'string'
        ? response.error
        : (response.error.message ?? 'Native operation failed.'),
    );
  return Object.hasOwn(response, 'result') ? response.result : response;
}

// Initialization metadata may contain native MCP definitions. Persist only the public handshake.
export function publicAgent(agent: Wire): Wire {
  return {
    protocolVersion: agent.protocolVersion,
    agentInfo: agent.agentInfo,
    agentCapabilities: agent.agentCapabilities,
    authMethods: agent.authMethods?.map((method: Wire) => ({
      id: method.id,
      name: method.name,
      description: method.description,
    })),
    _meta: { defaultAuthMethodId: agent._meta?.defaultAuthMethodId },
  };
}

export function publicCatalog(catalog: Wire): Wire {
  return {
    sessionMcpResolved: catalog.sessionMcpResolved,
    servers: (catalog.servers ?? []).map((server: Wire) => ({
      name: server.name,
      displayName: server.displayName,
      source: server.source,
      sourceLabel: server.sourceLabel,
      type: server.type,
      command: server.command,
      url: server.url,
      scope: server.scope,
      scopeName: server.scopeName,
      envNames: Array.isArray(server.env)
        ? server.env.map((entry: Wire) => entry.name)
        : Object.keys(server.env ?? {}),
      // Setup values and configured header/env values remain in the runtime, not renderer/state.
      setup: server.setup
        ? {
            fields: server.setup.fields?.map((item: Wire) => ({
              id: item.id,
              label: item.label,
              type: item.type,
              required: item.required,
              options: item.options,
            })),
          }
        : undefined,
      session: server.session,
    })),
  };
}
