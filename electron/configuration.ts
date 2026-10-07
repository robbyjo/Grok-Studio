import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openDocument, saveDocument } from './editor';
import { inside } from './paths';
import type { Wire } from '../shared/types';
async function parseToml(text: string) {
  return (await import('smol-toml')).parse(text.replace(/^\uFEFF/, ''));
}

interface Source {
  id: string;
  root: string;
  path: string;
  scope: string;
  kind: string;
  names: string[];
}
export class Configuration {
  private sources = new Map<string, Source>();
  constructor(private home: () => string) {}
  async list(cwd: string) {
    this.sources.clear();
    const candidates: Source[] = [];
    const seen = new Set<string>();
    const add = async (root: string, path: string, scope: string, kind: string) => {
      try {
        const doc = await openDocument(root, path);
        const key = resolve(root, path).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const source: Source = { id: randomUUID(), root, path, scope, kind, names: [] };
        candidates.push(source);
        this.sources.set(source.id, source);
        let names: string[] = [];
        try {
          if (kind === 'toml') {
            const data = await parseToml(doc.text);
            names = Object.keys(data.mcp_servers ?? {});
          }
          if (kind === 'json') {
            const data = JSON.parse(doc.text.replace(/^\uFEFF/, ''));
            names = Object.keys(data.mcpServers ?? {});
          }
          source.names = names;
        } catch (error) {
          Object.assign(source, { error: (error as Error).message });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          candidates.push({
            id: randomUUID(),
            root,
            path,
            scope,
            kind,
            names: [],
            ...{ error: (error as Error).message },
          });
      }
    };
    await add(this.home(), 'config.toml', 'user', 'toml');
    for (const path of [
      '.grok/config.toml',
      '.mcp.json',
      '.claude/settings.json',
      '.cursor/mcp.json',
      'AGENTS.md',
      'Agents.md',
      'AGENT.md',
      'CLAUDE.md',
      '.grok/hooks.json',
      '.grok/grok-studio.json',
    ]) {
      await add(
        cwd,
        path,
        'project',
        path.endsWith('.toml') ? 'toml' : path.endsWith('.json') ? 'json' : 'markdown',
      );
    }
    for (const folder of ['.grok/rules', '.claude/rules', '.cursor/rules']) {
      try {
        const target = await inside(cwd, folder);
        for (const entry of (await readdir(target, { withFileTypes: true })).slice(0, 200))
          if (entry.isFile() && entry.name.endsWith('.md'))
            await add(cwd, join(folder, entry.name), 'project', 'markdown');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return candidates.map((source) => ({
      id: source.id,
      path: resolve(source.root, source.path),
      scope: source.scope,
      kind: source.kind,
      error: (source as any).error,
      definitions: source.names.map((name) => ({
        name,
        alsoDefinedIn: candidates
          .filter((other) => other !== source && other.names.includes(name))
          .map((other) => resolve(other.root, other.path)),
      })),
    }));
  }
  async open(id: string) {
    const source = this.sources.get(id);
    if (!source) throw new Error('Refresh and select a configuration source.');
    return openDocument(source.root, source.path);
  }
  async save(id: string, text: string, revision: string) {
    const source = this.sources.get(id);
    if (!source) throw new Error('Refresh and select a configuration source.');
    if (source.kind === 'toml') await parseToml(text);
    if (source.kind === 'json') JSON.parse(text.replace(/^\uFEFF/, ''));
    // Save exactly the reviewed text. Do not regenerate TOML or reconstruct server definitions.
    return saveDocument(source.root, source.path, text, revision);
  }
}

export async function forgetMcpCredential(home: string, name: string, url: string) {
  const path = 'mcp_credentials.json';
  let doc;
  try {
    doc = await openDocument(home, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false };
    throw error;
  }
  const credentials = JSON.parse(doc.text);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))
    throw new Error('Unsupported MCP credential store.');
  const key = name + ':' + new URL(url).href;
  if (!Object.hasOwn(credentials, key)) return { removed: false };
  delete credentials[key];
  await saveDocument(home, path, JSON.stringify(credentials, null, 2), doc.revision);
  return { removed: true };
}
