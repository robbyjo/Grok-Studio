import { utilityProcess } from 'electron';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { RpcError } from './rpc';
import type { Wire } from '../shared/types';
export class EmbeddedRpc extends EventEmitter {
  private child: Electron.UtilityProcess;
  private pending = new Map<
    number,
    { resolve: (v: Wire) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >();
  private sequence = 0;
  private ended = false;
  private closing = false;
  private stopped = false;
  private ready: Promise<void>;
  private exited: Promise<void>;
  private media = new Map<
    string,
    { resolve: (v: Uint8Array) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(path: string, cwd: string, env: NodeJS.ProcessEnv = process.env, mode = 'auto') {
    super();
    const helper = join(__dirname, 'engine-helper.js');
    if (utilityProcess)
      this.child = utilityProcess.fork(helper, [], {
        cwd,
        env,
        stdio: 'pipe',
        serviceName: 'Grok Workbench engine',
      });
    else {
      const child = fork(
        existsSync(helper)
          ? helper
          : join(process.cwd(), 'dist-electron/electron/engine-helper.js'),
        [],
        { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
      );
      (child as any).postMessage = (message: any) => child.send(message);
      this.child = child as unknown as Electron.UtilityProcess;
    }
    this.exited = new Promise((resolve) =>
      this.child.once('exit', () => {
        this.stopped = true;
        resolve();
      }),
    );
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Embedded engine startup timed out.'));
        this.close();
      }, 35000);
      this.child.once('spawn', () =>
        this.child.postMessage({
          kind: 'start',
          path,
          cwd,
          mode,
          secret: randomBytes(32).toString('hex'),
        }),
      );
      this.child.on('message', (data: any) => {
        if (data.kind === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (data.kind === 'failed') {
          clearTimeout(timer);
          reject(new Error(data.error));
          this.finish(new Error(data.error));
          this.child.kill();
        } else if (data.kind === 'rpc') this.consume(data.message);
        else if (data.kind === 'media-result') {
          const row = this.media.get(data.id);
          if (row) {
            clearTimeout(row.timer);
            this.media.delete(data.id);
            if (data.error) row.reject(new Error(data.error));
            else row.resolve(data.bytes);
          }
        }
      });
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        const error = new Error(`Embedded Grok engine exited (${code}).`);
        reject(error);
        this.finish(error);
      });
    });
    // Diagnostics from native code can include prompts/credentials; deliberately do not forward them.
    this.child.stdout?.resume();
    this.child.stderr?.resume();
    void this.ready.catch(() => {});
  }
  async generate(input: Wire): Promise<Uint8Array> {
    return this.operation('media', input);
  }
  async mcp(input: Wire): Promise<any> {
    return this.operation('mcp', input);
  }
  private async operation(kind: string, input: Wire): Promise<any> {
    await this.ready;
    if (this.ended) throw new Error('Embedded engine is closed.');
    const id = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.media.delete(id);
          reject(new Error('Native operation timed out; it may still be processing.'));
        },
        kind === 'mcp' ? 90000 : 600000,
      );
      this.media.set(id, { resolve, reject, timer });
      this.child.postMessage({ kind, id, input });
    });
  }
  private consume(message: Wire) {
    if (message.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string')
      this.emit(message.id !== undefined ? 'request' : 'notification', message);
    else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result ?? {});
    }
  }
  async request(method: string, params: Wire = {}, timeoutMs = 30000): Promise<Wire> {
    await this.ready;
    if (this.ended) throw new Error('Embedded engine is closed.');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out. Reconnect to try again.`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.child.postMessage({ kind: 'rpc', message: { jsonrpc: '2.0', id, method, params } });
    });
  }
  notify(method: string, params: Wire) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  respond(id: number | string, result: Wire) {
    this.send({ jsonrpc: '2.0', id, result });
  }
  reject(id: number | string, code: number, message: string) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
  private send(message: Wire) {
    if (this.ended) throw new Error('Embedded engine is closed.');
    this.child.postMessage({ kind: 'rpc', message });
  }
  private finish(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const row of this.pending.values()) {
      clearTimeout(row.timer);
      row.reject(error);
    }
    this.pending.clear();
    for (const row of this.media.values()) {
      clearTimeout(row.timer);
      row.reject(error);
    }
    this.media.clear();
    this.emit('closed', error);
  }
  close() {
    if (this.closing || this.stopped) return;
    this.closing = true;
    this.finish(new Error('Connection stopped.'));
    const pid = this.child.pid;
    if (process.platform === 'win32' && pid)
      require('node:child_process').execFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true },
        (error: Error | null) => {
          if (error) this.child.kill();
        },
      );
    else this.child.kill();
  }
  async waitForExit() {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Engine shutdown did not finish.')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
