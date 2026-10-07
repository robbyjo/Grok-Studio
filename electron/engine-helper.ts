// Loaded by Electron's utilityProcess, isolated from the GUI/main process.
// All native global state (cwd, auth refresh, Rust runtime) belongs to this helper.
const parent = (process as NodeJS.Process & { parentPort: any }).parentPort ?? {
  // Node IPC is used by source acceptance scripts; packaged launches use utilityProcess.
  on: (_event: string, listener: (event: { data: any }) => void) =>
    process.on('message', (data) => listener({ data })),
  postMessage: (data: any) => process.send?.(data),
};
let socket: WebSocket | undefined;
let native: {
  start(cwd: string, secret: string, mode: string): number;
  status(): string;
  mcp(input: string): Promise<string>;
  generate(
    kind: string,
    prompt: string,
    aspect: string,
    duration: number,
    voice: string,
  ): Promise<Buffer>;
};
let ended = false;
parent.on('message', async ({ data }: { data: any }) => {
  if (data.kind === 'start') {
    try {
      native = require(data.path);
      const port = native.start(data.cwd, data.secret, data.mode);
      const deadline = Date.now() + 30000;
      while (!ended && Date.now() < deadline) {
        const candidate = new WebSocket(
          `ws://127.0.0.1:${port}/ws?server-key=${encodeURIComponent(data.secret)}`,
        );
        const ready = await new Promise<boolean>((resolve) => {
          candidate.addEventListener('open', () => resolve(true), { once: true });
          candidate.addEventListener('error', () => resolve(false), { once: true });
        });
        if (ready) {
          socket = candidate;
          socket.addEventListener('message', ({ data }) => {
            if (typeof data !== 'string' || Buffer.byteLength(data) > 16 * 1024 * 1024) {
              socket?.close();
              return;
            }
            try {
              parent.postMessage({ kind: 'rpc', message: JSON.parse(data) });
            } catch {
              parent.postMessage({ kind: 'failed', error: 'Invalid native ACP message.' });
            }
          });
          socket.addEventListener('close', () =>
            parent.postMessage({ kind: 'failed', error: 'Embedded engine connection closed.' }),
          );
          parent.postMessage({ kind: 'ready' });
          return;
        }
        candidate.close();
        if (native.status() !== 'starting') throw new Error(native.status());
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('Embedded engine startup timed out.');
    } catch {
      parent.postMessage({
        kind: 'failed',
        error: 'Embedded engine could not start. Check its build and project configuration.',
      });
    }
  } else if (data.kind === 'mcp') {
    try {
      parent.postMessage({
        kind: 'media-result',
        id: data.id,
        bytes: JSON.parse(await native.mcp(JSON.stringify(data.input))),
      });
    } catch (error) {
      parent.postMessage({
        kind: 'media-result',
        id: data.id,
        error: String((error as Error).message).slice(0, 1000),
      });
    }
  } else if (data.kind === 'media') {
    try {
      const i = data.input;
      const bytes = await native.generate(i.kind, i.prompt, i.aspect, i.duration, i.voice);
      parent.postMessage({ kind: 'media-result', id: data.id, bytes });
    } catch (error) {
      parent.postMessage({
        kind: 'media-result',
        id: data.id,
        error: String((error as Error).message).slice(0, 1000),
      });
    }
  } else if (data.kind === 'rpc' && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data.message));
  } else if (data.kind === 'stop') {
    ended = true;
    socket?.close();
    process.exit(0);
  }
});
