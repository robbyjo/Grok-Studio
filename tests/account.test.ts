import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Account } from '../electron/account';
import type { Wire } from '../shared/types';

class ProfileRpc extends EventEmitter {
  methods: string[] = [];
  closed = false;
  hold?: (error: Error) => void;
  constructor(
    private file: string,
    private wait = false,
  ) {
    super();
  }
  async request(method: string, params: Wire = {}) {
    this.methods.push(method);
    if (method === 'initialize')
      return {
        protocolVersion: 1,
        authMethods: [
          ...(existsSync(this.file) ? [{ id: 'cached_token', name: 'Saved sign-in' }] : []),
          { id: 'grok.com', name: 'Grok' },
          { id: 'xai.api_key', name: 'API key' },
        ],
      };
    if (method === 'authenticate') {
      assert.notEqual(params.methodId, 'xai.api_key');
      if (this.wait)
        await new Promise((_, reject) => {
          this.hold = reject;
        });
      writeFileSync(this.file, 'fixture credential; never a real account token');
      return {};
    }
    if (method === '_x.ai/auth/info')
      return {
        result: {
          email: existsSync(this.file) ? 'fixture@example.invalid' : undefined,
          token: 'secret-not-for-renderer',
          apiKey: 'also-private',
          codingDataRetentionOptOut: true,
        },
      };
    throw new Error('Project/session operations are forbidden in the account test.');
  }
  notify() {}
  respond() {}
  reject() {}
  close() {
    this.closed = true;
    this.hold?.(new Error('closed'));
  }
  async waitForExit() {}
}

test('OAuth sign-in works without a project/session and survives a new account controller', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'grok-account-')), 'auth.json');
  const rpcs: ProfileRpc[] = [];
  const launch = () => {
    const rpc = new ProfileRpc(file);
    rpcs.push(rpc);
    return rpc;
  };
  const first = new Account(launch);
  assert.equal((await first.refresh()).signedIn, false);
  const result = await first.signIn();
  assert.deepEqual(result, { signedIn: true, label: 'fixture@example.invalid' });
  assert.ok(!JSON.stringify(result).includes('private'));
  const restarted = new Account(launch);
  assert.equal((await restarted.refresh()).signedIn, true);
  await restarted.signIn();
  assert.ok(rpcs.every((rpc) => rpc.closed));
  assert.ok(rpcs.every((rpc) => !rpc.methods.some((method) => method.startsWith('session/'))));
});

test('cancel closes the owned pending login and allows a subsequent sign-in', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'grok-account-cancel-')), 'auth.json');
  let rpc: ProfileRpc;
  let wait = true;
  const account = new Account(() => (rpc = new ProfileRpc(file, wait)));
  const pending = account.signIn();
  const rejected = assert.rejects(pending, /cancelled/);
  for (let i = 0; i < 100 && !rpc!?.hold; i++) await new Promise((r) => setTimeout(r, 5));
  account.cancel();
  await rejected;
  assert.ok(rpc!.closed);
  assert.equal(existsSync(file), false);
  wait = false;
  assert.equal((await account.signIn()).signedIn, true);
});
test('failed saved-account verification clears stale signed-in status and subsequent login recovers', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'grok-account-reconnect-')), 'auth.json');
  let fail = false;
  const account = new Account(() => {
    const rpc = new ProfileRpc(file);
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params = {}) => {
      if (fail && method === '_x.ai/auth/info') throw new Error('401 expiry secret-token');
      return request(method, params);
    };
    return rpc;
  });
  assert.equal((await account.signIn()).signedIn, true);
  fail = true;
  await assert.rejects(account.refresh(), /Could not check/);
  assert.equal(account.snapshot().signedIn, false);
  assert.equal(account.snapshot().needsReconnect, true);
  assert.ok(!JSON.stringify(account.snapshot()).includes('secret-token'));
  assert.equal(existsSync(file), true);
  fail = false;
  assert.equal((await account.signIn()).signedIn, true);
});

test('shutdown waits for the owned helper to exit before releasing the profile', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'grok-account-exit-')), 'auth.json');
  const rpc = new ProfileRpc(file, true);
  let release!: () => void;
  const exited = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpc.waitForExit = () => exited;
  const account = new Account(() => rpc);
  const login = account.signIn();
  const rejected = assert.rejects(login, /cancelled/);
  for (let i = 0; i < 100 && !rpc.hold; i++) await new Promise((r) => setTimeout(r, 5));
  let finished = false;
  const shutdown = account.shutdownAndWait().then(() => {
    finished = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rpc.closed, true);
  assert.equal(finished, false);
  release();
  await Promise.all([shutdown, rejected]);
  assert.equal(finished, true);
  assert.equal(existsSync(file), false);
});
