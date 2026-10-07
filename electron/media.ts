import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  createReadStream,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { basename, join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import type { Attachment, Wire } from '../shared/types';
import type { History } from './history';
export interface Asset {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  kind: string;
}
export function mediaType(bytes: Buffer, name: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 6).toString().startsWith('GIF8')) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')
    return 'image/webp';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE')
    return 'audio/wav';
  if (bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224))
    return 'audio/mpeg';
  if (bytes.subarray(4, 8).toString() === 'ftyp')
    return extname(name).toLowerCase() === '.m4a' ? 'audio/mp4' : 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return extname(name).toLowerCase() === '.webm' ? 'video/webm' : 'application/octet-stream';
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  const decoded = bytes.toString('utf8');
  if (bytes.length <= 1024 * 1024 && !bytes.includes(0) && Buffer.from(decoded).equals(bytes))
    return 'text/plain';
  return 'application/octet-stream';
}
export class Media {
  private rows: Asset[];
  constructor(
    private root: string,
    private history: History,
  ) {
    mkdirSync(root, { recursive: true });
    this.rows = history.value('media-assets') ?? [];
  }
  private path(id: string, name?: string) {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid asset identifier.');
    const extension = extname(name ?? this.rows.find((r) => r.id === id)?.name ?? '');
    return join(this.root, id + (/^[.][a-zA-Z0-9]{1,12}$/.test(extension) ? extension : ''));
  }
  list() {
    return this.rows.map((row) => ({ ...row, url: `grok-media://asset/${row.id}` }));
  }
  capacity(reserve = 50 * 1024 * 1024) {
    const files = readdirSync(this.root);
    const total = files.reduce((n, file) => n + statSync(join(this.root, file)).size, 0);
    if (files.length >= 1000 || total + reserve > 256 * 1024 * 1024)
      throw new Error(
        'Media storage is near its 256 MiB budget. Export and delete old assets before adding more.',
      );
  }
  add(bytes: Buffer, name: string, kind: string) {
    if (!bytes.length || bytes.length > 50 * 1024 * 1024)
      throw new Error('Each attachment/output must be 1 byte–50 MiB.');
    this.capacity(bytes.length);
    const row: Asset = {
      id: randomUUID(),
      name: basename(name).slice(0, 180),
      mimeType: mediaType(bytes, name),
      size: bytes.length,
      kind,
      createdAt: new Date().toISOString(),
    };
    const path = this.path(row.id, row.name);
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    try {
      this.history.setValue('media-assets', [...this.rows, row]);
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    this.rows.push(row);
    return { ...row, url: `grok-media://asset/${row.id}` };
  }
  attach(path: string) {
    const size = statSync(path);
    if (!size.isFile() || size.size > 50 * 1024 * 1024)
      throw new Error('Choose a file up to 50 MiB.');
    return this.add(readFileSync(path), basename(path), 'attachment');
  }
  attachment(id: string): Attachment {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('Attachment is no longer stored.');
    const bytes = readFileSync(this.path(id));
    return {
      id: row.id,
      url: `grok-media://asset/${row.id}`,
      name: row.name,
      uri: pathToFileURL(this.path(id)).href,
      text: row.mimeType === 'text/plain' ? bytes.toString('utf8') : '',
      mimeType: row.mimeType,
      data:
        row.mimeType.startsWith('image/') && bytes.length <= 8 * 1024 * 1024
          ? bytes.toString('base64')
          : undefined,
    };
  }
  bytes(id: string) {
    if (!this.rows.some((r) => r.id === id)) throw new Error('Asset is no longer stored.');
    return readFileSync(this.path(id));
  }
  delete(id: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error('Asset is no longer stored.');
    const file = this.path(id);
    this.history.setValue(
      'media-assets',
      this.rows.filter((r) => r.id !== id),
    );
    this.rows = this.rows.filter((r) => r.id !== id);
    if (existsSync(file)) unlinkSync(file);
  }
  async response(request: Request): Promise<Response> {
    const url = new URL(request.url),
      id = url.pathname.slice(1),
      row = this.rows.find((r) => r.id === id);
    if (url.hostname !== 'asset' || !row || !['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 404 });
    if (!existsSync(this.path(id))) return new Response(null, { status: 404 });
    if (
      !row.mimeType.startsWith('image/') &&
      !row.mimeType.startsWith('audio/') &&
      !row.mimeType.startsWith('video/')
    )
      return new Response(null, { status: 415 });
    let start = 0,
      end = row.size - 1,
      status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
      if (!match[1]) start = Math.max(0, row.size - Number(match[2]));
      else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= row.size
      )
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${row.size}` },
        });
      status = 206;
    }
    const headers: Record<string, string> = {
      'Content-Type': row.mimeType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${row.size}`;
    return new Response(
      request.method === 'HEAD'
        ? null
        : (Readable.toWeb(createReadStream(this.path(id), { start, end })) as any),
      { status, headers },
    );
  }
}
export function generation(input: Wire) {
  if (
    !['image', 'audio', 'video'].includes(input.kind) ||
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    input.prompt.length > 20000 ||
    input.prompt.includes('\0')
  )
    throw new Error('Choose a generation type and enter up to 20,000 characters.');
  const aspect = input.aspect ?? '16:9',
    duration = input.duration ?? 5,
    voice = input.voice ?? 'eve';
  if (
    !['1:1', '16:9', '9:16', '4:3', '3:4'].includes(aspect) ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 15 ||
    !['eve', 'ara', 'leo', 'rex', 'sal'].includes(voice)
  )
    throw new Error('Invalid media settings.');
  return { kind: input.kind, prompt: input.prompt, aspect, duration, voice };
}
