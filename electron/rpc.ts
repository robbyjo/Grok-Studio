import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Wire } from '../shared/types';
export type RpcClient = Pick<
  RpcProcess,
  'request' | 'notify' | 'respond' | 'reject' | 'close' | 'waitForExit'
> &
  Pick<EventEmitter, 'on'>;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** ACP: newline-delimited, bidirectional JSON-RPC over a private child's stdio. */
export class RpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (value: Wire) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >();
  private nextId = 1;
  private buffer = '';
  private ended = false;
  private closing = false;
  private exited: Promise<void>;
  constructor(executable: string, args: string[], cwd: string, env = process.env) {
    super();
    this.child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: 'pipe',
    });
    this.exited = new Promise((done) => {
      this.child.once('close', () => done());
      this.child.once('error', () => done());
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.emit('diagnostic', chunk.slice(0, 8000)));
    this.child.stdin.on('error', (error) => this.finish(error));
    this.child.on('error', (error) => this.finish(error));
    this.child.on('exit', (code, signal) =>
      this.finish(new Error(`Grok process exited (${signal ?? code}).`)),
    );
  }
  private consume(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
      this.close();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        this.finish(new Error('Invalid JSON on ACP stdout. Check your Grok executable.'));
        this.child.kill();
        return;
      }
      if (!message || message.jsonrpc !== '2.0') continue;
      if (typeof message.method === 'string') {
        if (message.id !== undefined) this.emit('request', message);
        else this.emit('notification', message);
      } else {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
          request.reject(
            new RpcError(message.error.code, message.error.message, message.error.data),
          );
        else request.resolve(message.result ?? {});
      }
    }
  }
  request(method: string, params: Wire = {}, timeoutMs = 30_000): Promise<Wire> {
    if (this.ended) return Promise.reject(new Error('Grok connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out. Reconnect to try again.`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
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
    if (this.ended || !this.child.stdin.writable) throw new Error('Grok connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private finish(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    this.finish(new Error('Connection stopped.'));
    this.child.stdin.destroy();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    // --no-leader ensures this is an app-owned process, not a shared agent.
    if (process.platform === 'win32' && this.child.pid) {
      spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => this.child.kill(),
      );
    } else this.child.kill();
  }
  async waitForExit() {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_done, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native process shutdown did not finish.')),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
