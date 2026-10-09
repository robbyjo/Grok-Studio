import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  readOnly?: boolean;
}
export class Configuration {
  private sources = new Map<string, Source>();
  constructor(private home: () => string) {}
  async list(cwd: string) {
    this.sources.clear();
    const candidates: Source[] = [];
    const seen = new Set<string>();
    const add = async (
      root: string,
      path: string,
      scope: string,
      kind: string,
      readOnly = false,
    ) => {
      try {
        const doc = await openDocument(root, path);
        const key = resolve(root, path).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const source: Source = { id: randomUUID(), root, path, scope, kind, names: [], readOnly };
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
    await add(this.home(), 'managed_config.toml', 'managed', 'toml', true);
    await add(this.home(), 'requirements.toml', 'requirements', 'toml', true);
    for (const path of ['AGENTS.md', 'AGENT.md', 'CLAUDE.md'])
      await add(this.home(), path, 'user', 'markdown');
    // Match the native Git boundary: a non-repository project has no ancestor walk.
    const selected = await realpath(cwd);
    const roots = [selected];
    try {
      const result = await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        windowsHide: true,
        timeout: 5000,
      });
      const stop = await realpath(result.stdout.trim());
      const rel = relative(stop, selected);
      if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new Error('Git root is not an ancestor of this project.');
      let current = selected;
      while (current.toLowerCase() !== stop.toLowerCase() && roots.length < 64) {
        const parent = dirname(current);
        if (parent === current) break;
        roots.unshift(parent);
        current = parent;
      }
    } catch {
      /* No Git repository: only the selected project is eligible. */
    }
    for (const root of roots) {
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
          root,
          path,
          root === selected ? 'project' : 'ancestor',
          path.endsWith('.toml') ? 'toml' : path.endsWith('.json') ? 'json' : 'markdown',
        );
      }
      for (const folder of ['.grok/rules', '.claude/rules', '.cursor/rules']) {
        try {
          const target = await inside(root, folder);
          for (const entry of (await readdir(target, { withFileTypes: true })).slice(0, 200))
            if (entry.isFile() && entry.name.endsWith('.md'))
              await add(
                root,
                join(folder, entry.name),
                root === selected ? 'project' : 'ancestor',
                'markdown',
              );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    return candidates.map((source) => ({
      id: source.id,
      path: resolve(source.root, source.path),
      scope: source.scope,
      kind: source.kind,
      readOnly: source.readOnly,
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
    if (source.readOnly)
      throw new Error('Managed policy and requirements are read-only in Workbench.');
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
