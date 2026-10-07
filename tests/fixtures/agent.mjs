import { createInterface } from 'node:readline';
const scenario = process.argv[2] ?? 'normal';
let promptId;
let sessionId = 'fixture-session';
let permission = false;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, result) => send({ id, result });
const update = (update, id = sessionId) =>
  send({ method: 'session/update', params: { sessionId: id, update } });
const session = {
  sessionId,
  modes: {
    currentModeId: 'agent',
    availableModes: [
      { id: 'agent', name: 'Agent' },
      { id: 'plan', name: 'Plan' },
    ],
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'fixture-model',
      options: [{ value: 'fixture-model', name: 'Fixture Model' }],
    },
  ],
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (scenario === 'crash') {
      process.exit(4);
    }
    if (scenario === 'hang') return;
    result(message.id, {
      protocolVersion: scenario === 'version' ? 99 : 1,
      agentCapabilities: {
        loadSession: scenario !== 'no-load',
        promptCapabilities: { embeddedContext: true },
      },
      authMethods: [{ id: 'fixture-auth', name: 'Fixture login' }],
    });
  } else if (message.method === 'session/new' || message.method === 'session/load') {
    if (message.method === 'session/load') {
      sessionId = message.params.sessionId;
      update({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Prior user message.' },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Duplicate replay must not appear.' },
      });
    }
    result(message.id, { ...session, sessionId });
    if (scenario === 'trust')
      send({
        id: 903,
        method: 'x.ai/folder_trust/request',
        params: {
          sessionId,
          cwd: message.params.cwd,
          workspace: message.params.cwd,
          configKinds: ['hooks', 'mcp'],
        },
      });
  } else if (message.method === 'authenticate') result(message.id, {});
  else if (message.method === 'session/set_mode') result(message.id, {});
  else if (message.method === 'session/set_config_option')
    result(message.id, {
      configOptions: [{ ...session.configOptions[0], currentValue: message.params.value.value }],
    });
  else if (message.method === 'session/prompt') {
    promptId = message.id;
    update(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wrong chat data' } },
      'foreign-session',
    );
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    if (scenario === 'cancel' || scenario === 'unresponsive') return;
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Run fixture command',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'fixture-command' },
    });
    permission = true;
    send({
      id: 902,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Run fixture command', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    });
  } else if (message.id === 902 && message.result) {
    if (!permission) throw new Error('Unexpected permission answer');
    const selected = message.result.outcome.optionId;
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: selected === 'allow-once' ? 'completed' : 'failed',
      rawOutput: { selected: selected ?? 'cancelled' },
    });
    result(promptId, { stopReason: selected ? 'end_turn' : 'cancelled' });
  } else if (message.method === 'session/cancel') {
    if (scenario !== 'unresponsive' && promptId) result(promptId, { stopReason: 'cancelled' });
  } else if (message.method === 'fixture/echo') {
    // Verify UTF-8 and framing across arbitrary stdout chunk boundaries.
    const output =
      JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.params }) + '\n';
    process.stdout.write(output.slice(0, 13));
    setTimeout(() => process.stdout.write(output.slice(13)), 10);
  } else if (message.method === 'fixture/error')
    send({
      id: message.id,
      error: { code: -32602, message: 'Fixture error', data: 'precise detail' },
    });
  else if (message.method === 'fixture/unsupported')
    send({ id: 991, method: 'unknown/client_method', params: {} });
});
