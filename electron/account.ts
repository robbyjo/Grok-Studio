import type { RpcClient } from './rpc';
import type { Wire } from '../shared/types';
import { version } from '../package.json';
import { extensionResult } from './native-extensions';

/** Profile authentication only: never creates a project, session, prompt or tool approval. */
export class Account {
  private active?: RpcClient;
  private pending?: Promise<Wire>;
  private cancelled = false;
  private generation = 0;
  private status: Wire = { signedIn: false };
  constructor(private launch: () => RpcClient) {}
  snapshot() {
    return { ...this.status };
  }
  refresh(): Promise<Wire> {
    return this.pending ?? this.run(false);
  }
  async signIn() {
    const generation = this.generation;
    // Let the initial noninteractive profile inspection finish first.
    await this.pending?.catch(() => {});
    if (generation !== this.generation) throw new Error('Grok sign-in cancelled.');
    return this.run(true);
  }
  cancel() {
    this.generation++;
    this.cancelled = true;
    this.active?.close();
  }
  async shutdownAndWait() {
    const rpc = this.active;
    const pending = this.pending;
    this.cancel();
    // Keep Electron alive until the native helper releases the portable profile.
    await pending?.catch(() => {});
    await rpc?.waitForExit();
  }
  private run(signIn: boolean): Promise<Wire> {
    const rpc = this.launch();
    this.active = rpc;
    this.cancelled = false;
    // Authentication has no authority to approve any project or execute tools.
    rpc.on('request', (message: Wire) => {
      if (['_x.ai/folder_trust/request', 'x.ai/folder_trust/request'].includes(message.method))
        rpc.respond(message.id, { outcome: 'reject' });
      else rpc.reject(message.id, -32601, 'Account sign-in does not support project operations.');
    });
    const operation = (async () => {
      try {
        const initialized = await rpc.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'grok-workbench', title: 'Grok Workbench', version },
        });
        if (initialized.protocolVersion !== 1) throw new Error('Unsupported protocol.');
        const methods: Wire[] = initialized.authMethods ?? [];
        if (signIn) {
          const method =
            methods.find((m) => m.id === 'cached_token') ??
            methods.find((m) => ['grok.com', 'oidc'].includes(m.id));
          if (!method) throw new Error('OAuth is not available under the current policy.');
          await rpc.request('authenticate', { methodId: method.id }, 180000);
        }
        const info = extensionResult(await rpc.request('_x.ai/auth/info'));
        if (this.cancelled) throw new Error('Cancelled.');
        const label = [info.firstName, info.lastName]
          .filter((s) => typeof s === 'string')
          .join(' ')
          .trim();
        // Whitelist profile display fields. Never expose native token/key responses.
        this.status = {
          signedIn: signIn || methods.some((m) => m.id === 'cached_token'),
          label: (label || (typeof info.email === 'string' ? info.email : ''))
            .replace(/[\x00-\x1f]/g, '')
            .slice(0, 160),
        };
        return this.snapshot();
      } catch {
        throw new Error(
          this.cancelled
            ? 'Grok sign-in cancelled.'
            : signIn
              ? 'Grok sign-in did not complete. Try again and check your account or authentication policy.'
              : 'Could not check the saved Grok account. You can retry sign-in.',
        );
      } finally {
        rpc.close();
        try {
          await rpc.waitForExit();
        } finally {
          this.active = undefined;
          this.pending = undefined;
        }
      }
    })();
    this.pending = operation;
    return operation;
  }
}
