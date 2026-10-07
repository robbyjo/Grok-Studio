import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
// Logs intentionally contain event names/codes/IDs only: no prompts, files, RPC bodies,
// model output, provider stderr, credentials or URLs with query strings.
export class Diagnostics {
  private path: string;
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
    this.path = join(root, 'events.jsonl');
  }
  record(event: string, fields: Record<string, string | number | boolean> = {}) {
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (
        !['method', 'threadId', 'code', 'durationMs', 'count', 'reason', 'rssBytes'].includes(key)
      )
        continue;
      safe[key] =
        typeof value === 'string'
          ? value
              .replace(
                /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+)/gi,
                '[redacted]',
              )
              .slice(0, 160)
          : value;
    }
    if (existsSync(this.path) && statSync(this.path).size > 512 * 1024) {
      const oldest = this.path + '.3';
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = 2; i >= 1; i--)
        if (existsSync(this.path + '.' + i))
          renameSync(this.path + '.' + i, this.path + '.' + (i + 1));
      renameSync(this.path, this.path + '.1');
    }
    appendFileSync(
      this.path,
      JSON.stringify({ time: new Date().toISOString(), event: event.slice(0, 80), ...safe }) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  list() {
    const rows = [];
    for (const file of [this.path + '.3', this.path + '.2', this.path + '.1', this.path])
      if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean))
          try {
            rows.push(JSON.parse(line));
          } catch {
            /* incomplete last record after crash */
          }
      }
    return rows.slice(-1000);
  }
}
