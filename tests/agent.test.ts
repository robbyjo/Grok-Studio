import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { RpcError, RpcProcess } from '../electron/rpc';
import { Store } from '../electron/store';
import { Agents } from '../electron/agent';
import type { DesktopEvent } from '../shared/types';
const fixture = resolve('tests/fixtures/agent.mjs');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(20);
  }
  throw new Error('Expected state never arrived.');
}
function setup(scenario = 'normal') {
  const folder = mkdtempSync(join(tmpdir(), 'grok-agent-test-'));
  const store = new Store(join(folder, 'state.json'));
  store.state.projects.push({ id: 'p', name: 'Fixture', path: folder });
  const thread = store.create('p', folder);
  const events: DesktopEvent[] = [];
  const agents = new Agents(
    store,
    (event) => events.push(event),
    (cwd) => new RpcProcess(process.execPath, [fixture, scenario], cwd),
  );
  return { folder, store, thread, agents, events };
}
test('ACP transport supports fragmented Unicode responses and structured errors', async () => {
  const rpc = new RpcProcess(process.execPath, [fixture], process.cwd());
  try {
    assert.deepEqual(await rpc.request('fixture/echo', { text: 'こんにちは 🚀', count: 7 }), {
      text: 'こんにちは 🚀',
      count: 7,
    });
    await assert.rejects(
      rpc.request('fixture/error'),
      (error: unknown) =>
        error instanceof RpcError && error.code === -32602 && error.data === 'precise detail',
    );
    await assert.rejects(rpc.request('ignored', {}, 40), /timed out/);
  } finally {
    rpc.close();
  }
});
test('process crash rejects a pending request promptly', async () => {
  const rpc = new RpcProcess(process.execPath, [fixture, 'crash'], process.cwd());
  await assert.rejects(rpc.request('initialize'), /exited/);
  rpc.close();
});
test('chat stream merges chunks and requires the exact selected approval option', async () => {
  const { agents, thread, store } = setup();
  try {
    const result = agents.prompt(thread.id, 'Review the project', []);
    await until(() => agents.permissionsSnapshot().length === 1);
    assert.equal(thread.status, 'approval');
    const permission = agents.permissionsSnapshot()[0];
    assert.throws(() => agents.approve(permission.id, 'invented'), /Invalid approval/);
    assert.equal(agents.permissionsSnapshot().length, 1);
    assert.equal(thread.entries.find((entry) => entry.type === 'assistant')?.text, 'Hello world');
    assert.ok(!thread.entries.some((entry) => entry.text.includes('Wrong chat')));
    await assert.rejects(agents.prompt(thread.id, 'Concurrent duplicate', []), /busy/);
    agents.approve(permission.id, 'reject-once');
    await result;
    assert.equal(thread.status, 'idle');
    const tools = thread.entries.filter((entry) => entry.type === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].data?.status, 'failed');
    assert.equal(tools[0].data?.rawOutput.selected, 'reject-once');
    store.flush();
    const reopened = new Store(join(store.state.projects[0].path, 'state.json'));
    assert.equal(reopened.thread(thread.id).sessionId, thread.sessionId);
    assert.equal(
      reopened.thread(thread.id).entries.find((entry) => entry.type === 'assistant')?.text,
      'Hello world',
    );
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('allow once, then resume without duplicating saved transcript', async () => {
  const { agents, thread, store } = setup();
  try {
    const prompt = agents.prompt(thread.id, 'Implement a fixture', []);
    await until(() => agents.permissionsSnapshot().length > 0);
    agents.approve(agents.permissionsSnapshot()[0].id, 'allow-once');
    await prompt;
    const before = thread.entries.length;
    agents.disconnect(thread.id);
    await agents.connect(thread.id);
    assert.equal(thread.status, 'idle');
    assert.equal(thread.entries.length, before);
    assert.ok(!thread.entries.some((entry) => entry.text.includes('Duplicate replay')));
    await agents.config(thread.id, '__mode', 'plan');
    assert.equal(thread.session?.modes.currentModeId, 'plan');
    await agents.config(thread.id, 'model', 'fixture-model');
    assert.equal(thread.session?.configOptions[0].currentValue, 'fixture-model');
    await agents.authenticate(thread.id, 'fixture-auth');
    assert.equal(thread.status, 'idle');
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('stop sends session/cancel and preserves an interrupted transcript', async () => {
  const { agents, thread, store } = setup('cancel');
  try {
    const prompt = agents.prompt(thread.id, 'Long task', []);
    await until(() => thread.entries.some((entry) => entry.type === 'assistant'));
    agents.cancel(thread.id);
    await prompt;
    assert.equal(thread.status, 'interrupted');
    assert.ok(thread.entries.some((entry) => entry.text === 'Hello world'));
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('cancelling a pending approval responds with cancelled, never allow', async () => {
  const { agents, thread, store } = setup();
  try {
    const prompt = agents.prompt(thread.id, 'Needs approval', []);
    await until(() => agents.permissionsSnapshot().length > 0);
    agents.cancel(thread.id);
    await prompt;
    assert.equal(agents.permissionsSnapshot().length, 0);
    assert.equal(
      thread.entries.find((entry) => entry.type === 'tool')?.data?.rawOutput.selected,
      'cancelled',
    );
    assert.equal(thread.status, 'interrupted');
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('shutdown closes an active process and never leaves an actionable approval', async () => {
  const { agents, thread, store } = setup();
  try {
    const prompt = agents.prompt(thread.id, 'Shutdown fixture', []);
    await until(() => agents.permissionsSnapshot().length > 0);
    agents.shutdown();
    await assert.rejects(prompt, /stopped/);
    assert.equal(agents.permissionsSnapshot().length, 0);
    assert.equal(thread.status, 'interrupted');
  } finally {
    store.flush();
  }
});
test('unrecognized protocol version is rejected', async () => {
  const { agents, thread, store } = setup('version');
  try {
    await assert.rejects(agents.connect(thread.id), /unsupported ACP version/);
    await assert.rejects(agents.connect(thread.id), /unsupported ACP version/);
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('loading a saved session with no local transcript restores both sides of history', async () => {
  const { agents, thread, store } = setup();
  thread.sessionId = 'existing-session';
  try {
    await agents.connect(thread.id);
    assert.equal(
      thread.entries.find((entry) => entry.type === 'user')?.text,
      'Prior user message.',
    );
    assert.equal(
      thread.entries.find((entry) => entry.type === 'assistant')?.text,
      'Duplicate replay must not appear.',
    );
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('stop during initialization terminates the connection without losing interrupted status', async () => {
  const { agents, thread, store } = setup('hang');
  try {
    const connection = agents.connect(thread.id);
    await until(() => thread.status === 'connecting');
    agents.cancel(thread.id);
    await assert.rejects(connection, /stopped/);
    assert.equal(thread.status, 'interrupted');
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('unsupported session loading never silently replaces the saved session', async () => {
  const { agents, thread, store } = setup('no-load');
  thread.sessionId = 'existing-session';
  try {
    await assert.rejects(agents.connect(thread.id), /cannot resume/);
    assert.equal(thread.sessionId, 'existing-session');
  } finally {
    agents.shutdown();
    store.flush();
  }
});
test('folder trust is explicit and uses the vendor outcome format', async () => {
  const { agents, thread, store } = setup('trust');
  try {
    await agents.connect(thread.id);
    await until(() => agents.permissionsSnapshot().length > 0);
    const trust = agents.permissionsSnapshot()[0];
    assert.equal(trust.kind, 'trust');
    agents.approve(trust.id, 'reject');
    assert.equal(thread.status, 'idle');
    assert.equal(agents.permissionsSnapshot().length, 0);
    await assert.rejects(agents.authenticate(thread.id, 'unadvertised'), /advertised/);
  } finally {
    agents.shutdown();
    store.flush();
  }
});
