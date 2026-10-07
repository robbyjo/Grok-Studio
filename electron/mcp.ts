import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { Wire } from '../shared/types';

function field(value: unknown, label: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`Invalid ${label}.`);
  return value;
}
function name(value: unknown): string {
  const result = field(value, 'server name', 100);
  if (!/^[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9-]$|^[A-Za-z]$/.test(result) || result.includes('__'))
    throw new Error(
      'Use a server name starting with a letter, with letters, numbers, hyphens or single underscores; do not end with an underscore.',
    );
  return result;
}
function scope(value: unknown): string {
  if (value !== 'user' && value !== 'project') throw new Error('Choose user or project scope.');
  return value;
}
function lines(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${label}.`);
  return value.map((item) => field(item, label));
}

export function addArguments(input: Wire): string[] {
  const args = ['mcp', 'add', '--scope', scope(input.scope), '--transport'];
  if (!['stdio', 'http', 'sse'].includes(input.transport))
    throw new Error('Unknown MCP transport.');
  args.push(input.transport, name(input.name));
  if (input.transport === 'stdio') {
    for (const entry of lines(input.env ?? [], 'environment variables')) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry))
        throw new Error('Environment variables use KEY=value, one per line.');
      args.push('-e', entry);
    }
    // Separate argv elements; never execute a constructed shell command.
    args.push(
      '--',
      field(input.command, 'server command', 2000),
      ...lines(input.args ?? [], 'arguments'),
    );
  } else {
    const url = new URL(field(input.url, 'server URL', 4000));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    args.push(url.href);
    for (const header of lines(input.headers ?? [], 'headers')) {
      if (!/^[A-Za-z0-9-]+:\s*[^\r\n]+$/.test(header))
        throw new Error('Headers use Name: value, one per line.');
      args.push('--header', header);
    }
  }
  return args;
}

export class Mcp {
  private children = new Set<ChildProcess>();
  constructor(
    private executable: () => string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}
  private kill(child: ChildProcess) {
    if (process.platform === 'win32' && child.pid)
      execFile(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => {},
      );
    else child.kill();
  }
  shutdown() {
    for (const child of this.children) this.kill(child);
  }
  async run(cwd: string, args: string[], diagnostic = false): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable(), args, {
        cwd,
        env: this.env,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.add(child);
      let stdout = '',
        stderr = '',
        size = 0,
        stopped = false;
      const fail = (message: string) => {
        if (!stopped) {
          stopped = true;
          this.kill(child);
          reject(new Error(message));
        }
      };
      const timer = setTimeout(() => fail('MCP operation timed out after 90 seconds.'), 90_000);
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 8 * 1024 * 1024) fail('MCP output exceeded 8 MiB.');
        else stdout += chunk;
      });
      child.stderr!.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-8000);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (!stopped) {
          stopped = true;
          reject(error);
        }
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (stopped) return;
        stopped = true;
        if (diagnostic || args.includes('--json')) {
          try {
            const data = JSON.parse(stdout);
            // doctor deliberately exits 1 for failed health checks: preserve its report.
            if (code === 0 || (diagnostic && Array.isArray(data.servers))) {
              resolve(data);
              return;
            }
          } catch {}
        } else if (code === 0) {
          resolve({ saved: true });
          return;
        }
        reject(new Error(stderr.trim() || `Grok MCP operation failed (exit ${code}).`));
      });
    });
  }
  async list(cwd: string) {
    const data = await this.run(cwd, ['mcp', 'list', '--json']);
    if (!Array.isArray(data)) throw new Error('Unexpected Grok MCP inventory format.');
    // Keep configured secrets in Grok's config, outside the renderer/transcript/store.
    return data.map((server: Wire) => ({
      name: server.name,
      scope: server.scope,
      enabled: server.enabled,
      transport: server.command ? 'stdio' : (server.type ?? 'http'),
      target: server.command ?? server.url,
      blocked_reason: server.blocked_reason,
    }));
  }
  async add(cwd: string, input: Wire) {
    const args = addArguments(input);
    if ((await this.list(cwd)).some((item: Wire) => item.name === input.name))
      throw new Error(
        'This server already exists. Edit advanced settings in Grok config; adding here cannot overwrite an existing server.',
      );
    return this.run(cwd, args);
  }
  async change(cwd: string, operation: string, input: Wire) {
    if (!['enable', 'disable', 'remove'].includes(operation))
      throw new Error('Unknown MCP operation.');
    const args = ['mcp', operation];
    if (operation === 'remove') args.push('--scope', scope(input.scope));
    args.push('--', field(input.name, 'server name', 256));
    return this.run(cwd, args);
  }
  doctor(cwd: string, input: Wire) {
    return this.run(
      cwd,
      ['mcp', 'doctor', '--json', '--', field(input.name, 'server name', 256)],
      true,
    );
  }
}
