import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
export function response(message, log) {
  log?.(message.method);
  if (message.id === undefined) return undefined;
  let result;
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'desktop-mcp-fixture', version: '1.0' },
      };
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'say_hello',
            description: 'Fixture greeting',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'HELLO_FROM_MCP_FIXTURE' }] };
      break;
    case 'ping':
      result = {};
      break;
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown method' } };
  }
  return { jsonrpc: '2.0', id: message.id, result };
}
if (process.argv[1]?.endsWith('mcp.mjs')) {
  const log = (method) => {
    if (process.env.MCP_FIXTURE_LOG) appendFileSync(process.env.MCP_FIXTURE_LOG, method + '\n');
  };
  createInterface({ input: process.stdin }).on('line', (line) => {
    const reply = response(JSON.parse(line), log);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
}
