import { copyFile, mkdir, opendir, open, realpath, lstat, writeFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, directory } from './paths';
import { fileHash } from './portable-update';
const xml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const excluded = new Set([
  '.git',
  'node_modules',
  '.runtime',
  '.test-data',
  'grok desktop data',
  '.grok',
  '.claude',
  '.cursor',
  '.ssh',
  '.aws',
  '.azure',
  '.codex',
]);
export function sandboxConfiguration(bundle: string, workspace: string, network: boolean) {
  return `<Configuration>\n<vGPU>Disable</vGPU><Networking>${network ? 'Enable' : 'Disable'}</Networking>\n<AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><ClipboardRedirection>Disable</ClipboardRedirection><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MemoryInMB>8192</MemoryInMB>\n<MappedFolders><MappedFolder><HostFolder>${xml(bundle)}</HostFolder><SandboxFolder>C:\\WorkbenchPayload</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xml(workspace)}</HostFolder><SandboxFolder>C:\\WorkbenchProject</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders>\n<LogonCommand><Command>powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\WorkbenchPayload\\start.ps1</Command></LogonCommand>\n</Configuration>\n`;
}
/** No host profile or original workspace is mapped into the guest. */
export class WindowsSandbox {
  private reviewed = new Map<
    string,
    {
      cwd: string;
      executable: string;
      hash: string;
      network: boolean;
      files: string[];
      bytes: number;
      skipped: number;
    }
  >();
  constructor(
    private root: string,
    private executable: () => string | undefined,
  ) {}
  async preview(cwd: string, network: boolean) {
    const source = this.executable();
    if (process.platform !== 'win32' || !source)
      throw new Error('Windows Sandbox launch requires the portable Windows executable.');
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('Portable executable is linked or unsafe.');
    const executable = await realpath(source),
      canonical = await directory(cwd),
      files: string[] = [];
    let bytes = 0,
      entries = 0,
      skipped = 0;
    async function visit(folder: string, depth: number): Promise<void> {
      if (depth > 20) throw new Error('Project snapshot exceeds 20 directory levels.');
      const dir = await opendir(join(canonical, folder));
      for await (const entry of dir) {
        if (++entries > 10000)
          throw new Error('Project snapshot exceeds 10,000 entries; use a smaller project.');
        if (
          entry.isSymbolicLink() ||
          excluded.has(entry.name.toLowerCase()) ||
          /^(\.env(?:\..*)?|auth\.json|mcp_credentials\.json|credentials(?:\.json)?|.*\.(?:pem|pfx|p12|key))$/i.test(
            entry.name,
          )
        ) {
          skipped++;
          continue;
        }
        const path = folder ? folder + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          skipped++;
          continue;
        }
        const info = await lstat(await inside(canonical, path));
        if (info.nlink !== 1) {
          skipped++;
          continue;
        }
        if (info.size > 50 * 1024 * 1024 || (bytes += info.size) > 256 * 1024 * 1024)
          throw new Error('Project snapshot exceeds 50 MiB per file or 256 MiB total.');
        files.push(path);
      }
    }
    await visit('', 0);
    const token = randomUUID(),
      hash = await fileHash(executable);
    this.reviewed.clear();
    this.reviewed.set(token, { cwd: canonical, executable, hash, network, files, bytes, skipped });
    return {
      token,
      cwd: canonical,
      hash,
      network,
      files: files.length,
      bytes,
      skipped,
      scope:
        'Isolated project copy. No host authentication or original project mapping. Guest data and sign-in disappear when Sandbox closes; project-copy edits remain in the recovery folder.',
    };
  }
  async prepare(token: string) {
    const review = this.reviewed.get(token);
    if (!review) throw new Error('Review the sandbox launch again.');
    this.reviewed.delete(token);
    if ((await fileHash(review.executable)) !== review.hash)
      throw new Error('Executable changed; review again.');
    const base = resolve(this.root),
      root = resolve(base, randomUUID()),
      rel = relative(base, root);
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Invalid sandbox staging path.');
    const bundle = join(root, 'payload'),
      workspace = join(root, 'project');
    await mkdir(bundle, { recursive: true });
    await mkdir(workspace);
    await copyFile(review.executable, join(bundle, 'Workbench.exe'));
    if ((await fileHash(join(bundle, 'Workbench.exe'))) !== review.hash)
      throw new Error('Sandbox payload verification failed.');
    let bytes = 0;
    for (const path of review.files) {
      const target = resolve(workspace, path),
        rel = relative(workspace, target);
      if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new Error('Snapshot path escapes project.');
      const handle = await open(await inside(review.cwd, path), 'r');
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 50 * 1024 * 1024 ||
          (bytes += info.size) > 256 * 1024 * 1024
        )
          throw new Error('Snapshot changed; review again.');
        // Read a bounded opened handle, so concurrent growth cannot exhaust memory.
        const buffer = Buffer.alloc(info.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== info.size) throw new Error('Snapshot file changed; review again.');
        await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, buffer.subarray(0, length), { flag: 'wx' });
      } finally {
        await handle.close();
      }
    }
    await writeFile(
      join(bundle, 'start.ps1'),
      `$ErrorActionPreference='Stop'\nNew-Item -ItemType Directory -Path C:\\Workbench -Force | Out-Null\nCopy-Item -LiteralPath C:\\WorkbenchPayload\\Workbench.exe -Destination C:\\Workbench\\Workbench.exe\n$env:GROK_DESKTOP_DATA_DIR='C:\\Workbench\\Profile'\n$env:GROK_HOME='C:\\Workbench\\Profile\\grok'\n$env:XAI_API_KEY=''\n$env:GROK_DEPLOYMENT_KEY=''\nStart-Process -FilePath C:\\Workbench\\Workbench.exe -WorkingDirectory C:\\Workbench -WindowStyle Normal\n`,
    );
    const config = join(root, 'Workbench.wsb');
    await writeFile(config, sandboxConfiguration(bundle, workspace, review.network), {
      flag: 'wx',
    });
    await writeFile(
      join(root, 'review.json'),
      JSON.stringify(
        {
          hash: review.hash,
          network: review.network,
          source: review.cwd,
          files: review.files.length,
          bytes,
          skipped: review.skipped,
        },
        null,
        2,
      ),
    );
    return { config, recovery: workspace, network: review.network };
  }
}
