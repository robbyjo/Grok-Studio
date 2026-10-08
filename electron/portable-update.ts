import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  rename,
  unlink,
  open,
} from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import type { Wire } from '../shared/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function verifyPortableArtifact(path: string, manifest: Wire) {
  const script =
    "$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1');$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:GROK_UPDATE_INSPECT);$s=Get-AuthenticodeSignature -LiteralPath $env:GROK_UPDATE_INSPECT;@{version=(@($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart)-join '.');product=$v.ProductName;signature=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint}|ConvertTo-Json -Compress";
  const result = JSON.parse(
    (
      await promisify(execFile)(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          shell: false,
          timeout: 30000,
          maxBuffer: 65536,
          env: { ...process.env, GROK_UPDATE_INSPECT: path },
        },
      )
    ).stdout,
  );
  if (result.version !== manifest.version || result.product !== 'Grok Workbench')
    throw new Error('Portable executable version/product does not match its manifest.');
  if (
    manifest.signerThumbprint &&
    (result.signature !== 'Valid' ||
      typeof manifest.signerThumbprint !== 'string' ||
      result.thumbprint?.toLowerCase() !== manifest.signerThumbprint.toLowerCase())
  )
    throw new Error('Portable Authenticode signature does not match its manifest.');
  return result;
}
export const updateRepository = 'robbyjo/Grok-Workbench';
export async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function compareVersions(a: string, b: string) {
  const parse = (value: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!m || m.slice(1).some((n) => !Number.isSafeInteger(Number(n))))
      throw new Error('Update versions must use major.minor.patch.');
    return m.slice(1).map(Number);
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function compatibility(manifest: Wire, version: string, engineHash: string) {
  if (
    manifest.format !== 1 ||
    manifest.product !== 'Grok Workbench' ||
    manifest.version !== version ||
    manifest.platform !== 'win32-x64' ||
    manifest.stateSchema !== 1 ||
    manifest.historySchema !== 1 ||
    manifest.bindingVersion !== '0.6.0' ||
    manifest.engineSha256 !== engineHash ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 ||
    manifest.bytes > 512 * 1024 * 1024 ||
    (manifest.signerThumbprint != null &&
      (typeof manifest.signerThumbprint !== 'string' ||
        !/^[a-fA-F0-9]{40}$/.test(manifest.signerThumbprint)))
  )
    throw new Error(
      'Update is missing compatible desktop/history/native version gates. Use a separately reviewed migration for a native or schema change.',
    );
  return manifest;
}
async function updateResponse(url: string) {
  const signal = AbortSignal.timeout(180000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      ![
        'api.github.com',
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(parsed.hostname)
    )
      throw new Error('Untrusted update URL/redirect.');
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Grok-Workbench' },
      signal,
      redirect: 'manual',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Update redirect has no location.');
      url = new URL(location, url).href;
      continue;
    }
    return response;
  }
  throw new Error('Update exceeded its redirect limit.');
}
async function boundedFetch(url: string, limit: number) {
  const response = await updateResponse(url);
  if (!response.ok || !response.body)
    throw new Error(`Update download failed (${response.status}).`);
  if (Number(response.headers.get('content-length')) > limit)
    throw new Error('Update download exceeds its size limit.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > limit) throw new Error('Update download exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function downloadFile(url: string, path: string, limit: number) {
  const response = await updateResponse(url);
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit)
    throw new Error('Portable download failed or exceeds its size limit.');
  const file = await open(path, 'wx'),
    hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body as any) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Portable download exceeds its size limit.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}
export class PortableUpdates {
  private reviews = new Map<string, Wire>();
  constructor(
    readonly root: string,
    readonly executable: string | undefined,
    readonly version: string,
    private engineHash: () => Promise<string>,
    private download = boundedFetch,
    private verifyArtifact = verifyPortableArtifact,
  ) {}
  async status() {
    const journal = await this.journal();
    if (
      journal &&
      this.executable &&
      ['prepared', 'rollbackPrepared', 'repairRequired'].includes(journal.state)
    ) {
      const installed = await fileHash(this.executable).catch(() => '');
      if (
        journal.operation === 'apply' &&
        installed === journal.sha256 &&
        (await fileHash(journal.rollback).catch(() => '')) === journal.previousSha256
      ) {
        journal.state = 'installed';
        journal.recoveredAfterReplacement = true;
        await this.save(journal);
      }
      if (
        journal.operation === 'rollback' &&
        installed === journal.previousSha256 &&
        (await fileHash(journal.displaced).catch(() => '')) === journal.sha256
      ) {
        journal.state = 'rolledBack';
        journal.recoveredAfterReplacement = true;
        await this.save(journal);
      }
    }
    return {
      version: this.version,
      portable: !!this.executable,
      repository: updateRepository,
      journal,
      scope:
        'Reviewed portable replacement, binary rollback and unchanged profile formats. Native/schema migrations are blocked.',
    };
  }
  private async journal(): Promise<Wire | undefined> {
    const path = join(this.root, 'journal.json'),
      info = await lstat(path).catch(() => undefined);
    if (!info) return undefined;
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > 65536)
      throw new Error('Unsafe update journal. Preserve it for repair.');
    const value = JSON.parse(await readFile(path, 'utf8'));
    const root = await realpath(this.root);
    if (
      (await lstat(this.root)).isSymbolicLink() ||
      value.format !== 1 ||
      ![
        'staged',
        'prepared',
        'installed',
        'rollbackPrepared',
        'rolledBack',
        'repairRequired',
        'discarded',
      ].includes(value.state)
    )
      throw new Error('Unsafe update journal. Preserve it for repair.');
    for (const key of ['staged', 'rollback', 'displaced']) {
      const selected = value[key];
      if (selected == null) continue;
      if (
        typeof selected !== 'string' ||
        dirname(selected).toLowerCase() !== root.toLowerCase() ||
        !new RegExp(`^${key}-[a-f0-9-]{36}\\.exe$`).test(basename(selected))
      )
        throw new Error('Unsafe update journal path. Preserve it for repair.');
      const target = await lstat(selected).catch((e) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      });
      if (target && (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1))
        throw new Error('Linked update files are not managed.');
    }
    return value;
  }
  private async save(value: Wire) {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error('Linked update folders are not supported.');
    const temp = join(this.root, 'journal-' + randomUUID() + '.json');
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temp, join(this.root, 'journal.json'));
  }
  async check(alpha: boolean) {
    if (typeof alpha !== 'boolean') throw new Error('Choose the release channel.');
    const releases = JSON.parse(
      (
        await this.download(
          `https://api.github.com/repos/${updateRepository}/releases?per_page=30`,
          1024 * 1024,
        )
      ).toString(),
    );
    if (!Array.isArray(releases)) throw new Error('Unexpected update listing.');
    const choices = releases
      .filter(
        (r: Wire) =>
          !r.draft &&
          (alpha || !r.prerelease) &&
          /^v\d+\.\d+\.\d+$/.test(r.tag_name) &&
          compareVersions(r.tag_name.slice(1), this.version) > 0,
      )
      .sort((a: Wire, b: Wire) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
    if (!choices.length)
      return {
        available: false,
        currentVersion: this.version,
        channel: alpha ? 'alpha included' : 'stable',
      };
    const release = choices[0],
      version = release.tag_name.slice(1),
      name = `Grok-Workbench-${version}-Portable.exe`,
      executable = release.assets.find((a: Wire) => a.name === name),
      manifest = release.assets.find((a: Wire) => a.name === name + '.manifest.json');
    const value = {
      available: true,
      currentVersion: this.version,
      version,
      prerelease: release.prerelease,
      url: release.html_url,
      releaseId: release.id,
      executable,
      manifest,
      compatibleMetadata: !!manifest,
      token: randomUUID(),
    };
    this.reviews.clear();
    this.reviews.set(value.token, value);
    return {
      ...value,
      executable: executable ? { name: executable.name, size: executable.size } : undefined,
      manifest: undefined,
    };
  }
  async stage(token: string, allowUnsigned: boolean) {
    const choice = this.reviews.get(token);
    if (!choice?.executable || !choice.manifest)
      throw new Error('Check updates again. This release has no compatible portable manifest.');
    const old = await this.journal();
    if (old && old.state !== 'discarded')
      throw new Error('Keep or discard the existing rollback before staging another update.');
    const release = JSON.parse(
      (
        await this.download(
          `https://api.github.com/repos/${updateRepository}/releases/${choice.releaseId}`,
          1024 * 1024,
        )
      ).toString(),
    );
    if (
      release.draft ||
      release.tag_name !== 'v' + choice.version ||
      [choice.executable, choice.manifest].some(
        (asset) =>
          !release.assets.some(
            (a: Wire) =>
              a.id === asset.id &&
              a.digest === asset.digest &&
              a.size === asset.size &&
              a.browser_download_url === asset.browser_download_url,
          ),
      )
    )
      throw new Error('Release assets changed. Check again.');
    const expectedPrefix = `https://github.com/${updateRepository}/releases/download/${release.tag_name}/`;
    for (const asset of [choice.executable, choice.manifest])
      if (
        !asset.browser_download_url.startsWith(expectedPrefix) ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')
      )
        throw new Error('Release assets require trusted URLs and GitHub SHA-256 digests.');
    const metadata = await this.download(choice.manifest.browser_download_url, 65536);
    if ('sha256:' + createHash('sha256').update(metadata).digest('hex') !== choice.manifest.digest)
      throw new Error('Update manifest checksum failed.');
    const manifest = compatibility(
      JSON.parse(metadata.toString()),
      choice.version,
      await this.engineHash(),
    );
    if (
      manifest.bytes !== choice.executable.size ||
      'sha256:' + manifest.sha256 !== choice.executable.digest
    )
      throw new Error('Manifest does not match the GitHub executable asset.');
    if (!allowUnsigned && !manifest.signerThumbprint)
      throw new Error(
        'This update is unsigned. Explicitly opt into unsigned updates or wait for a signed release.',
      );
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error('Linked update folders are not supported.');
    const staged = join(await realpath(this.root), 'staged-' + randomUUID() + '.exe');
    try {
      let report;
      if (this.download === boundedFetch)
        report = await downloadFile(choice.executable.browser_download_url, staged, manifest.bytes);
      else {
        const bytes = await this.download(choice.executable.browser_download_url, manifest.bytes);
        await writeFile(staged, bytes, { flag: 'wx' });
        report = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      if (report.bytes !== manifest.bytes || report.sha256 !== manifest.sha256)
        throw new Error('Update executable checksum failed.');
      await this.verifyArtifact(staged, manifest);
    } catch (e) {
      await unlink(staged).catch(() => {});
      throw e;
    }
    await this.save({
      format: 1,
      state: 'staged',
      staged,
      version: choice.version,
      sha256: manifest.sha256,
      signerThumbprint: manifest.signerThumbprint ?? null,
      allowUnsigned: allowUnsigned === true,
      engineSha256: manifest.engineSha256,
      sourceVersion: this.version,
      createdAt: new Date().toISOString(),
    });
    return this.status();
  }
  async prepare(operation: 'apply' | 'rollback', confirmed: boolean) {
    if (confirmed !== true || !this.executable || process.platform !== 'win32')
      throw new Error('Confirm replacement from a portable Windows launch.');
    const executable = resolve(this.executable),
      info = await lstat(executable),
      parent = await realpath(dirname(executable));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      resolve(join(parent, basename(executable))).toLowerCase() !== executable.toLowerCase() ||
      !executable.toLowerCase().endsWith('.exe')
    )
      throw new Error('Portable executable is linked or unsafe.');
    const journal = await this.journal();
    if (
      !journal ||
      journal.format !== 1 ||
      journal.state !== (operation === 'apply' ? 'staged' : 'installed')
    )
      throw new Error('No reviewed update/rollback is ready.');
    const root = await realpath(this.root),
      selected = operation === 'apply' ? journal.staged : journal.rollback;
    if (resolve(root).slice(0, 3).toLowerCase() !== executable.slice(0, 3).toLowerCase())
      throw new Error(
        'Portable update staging must be on the executable volume for atomic replacement.',
      );
    if (
      typeof selected !== 'string' ||
      dirname(selected).toLowerCase() !== root.toLowerCase() ||
      !(await lstat(selected)).isFile() ||
      (await lstat(selected)).isSymbolicLink() ||
      (await lstat(selected)).nlink !== 1 ||
      (await fileHash(selected)) !==
        (operation === 'apply' ? journal.sha256 : journal.previousSha256)
    )
      throw new Error('Update/rollback binary failed verification.');
    const next = {
      ...journal,
      executable,
      operation,
      ownerPid: process.pid,
      workerPid: null,
      launcherPid: null,
      workerReady: false,
      previousSha256: operation === 'apply' ? await fileHash(executable) : journal.previousSha256,
      rollback: journal.rollback ?? join(root, 'rollback-' + randomUUID() + '.exe'),
      displaced: join(root, 'displaced-' + randomUUID() + '.exe'),
      state: operation === 'apply' ? 'prepared' : 'rollbackPrepared',
    };
    await this.save(next);
    return join(root, 'journal.json');
  }
  async discard(confirmed: boolean) {
    if (confirmed !== true)
      throw new Error('Confirm discarding the retained update/rollback files.');
    const journal = await this.journal();
    if (!journal || !['staged', 'installed', 'rolledBack'].includes(journal.state))
      throw new Error('Only inactive staged/completed updates can be discarded.');
    const root = await realpath(this.root),
      targets: string[] = [];
    for (const key of ['staged', 'rollback', 'displaced']) {
      const path = journal[key];
      if (!path) continue;
      if (
        typeof path !== 'string' ||
        dirname(path).toLowerCase() !== root.toLowerCase() ||
        !/^(staged|rollback|displaced)-[a-f0-9-]{36}\.exe$/.test(basename(path))
      )
        throw new Error('Unsafe update cleanup path.');
      const info = await lstat(path).catch((e) => {
        if (e.code === 'ENOENT') return undefined;
        throw e;
      });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1))
        throw new Error('Linked update files are not managed.');
      if (info) targets.push(path);
    }
    for (const path of targets) await unlink(path);
    await this.save({ format: 1, state: 'discarded', discardedAt: new Date().toISOString() });
    return this.status();
  }
  async recover(confirmed: boolean) {
    if (confirmed !== true || !this.executable)
      throw new Error('Confirm recovery from a portable launch.');
    const current = await this.status(),
      journal = current.journal;
    if (!journal || !['prepared', 'rollbackPrepared', 'repairRequired'].includes(journal.state))
      throw new Error('No interrupted update needs recovery.');
    for (const pid of [
      journal.ownerPid === process.pid ? null : journal.ownerPid,
      journal.workerPid,
      journal.launcherPid,
    ]) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      let active = false;
      try {
        process.kill(pid, 0);
        active = true;
      } catch (e: any) {
        if (e.code !== 'ESRCH') active = true;
      }
      if (active)
        throw new Error('The update owner/worker is still running. Wait before recovery.');
    }
    const apply = journal.operation === 'apply';
    if (!apply && journal.operation !== 'rollback')
      throw new Error('Unknown update operation. Preserve the journal for repair.');
    const selected = apply ? journal.staged : journal.rollback;
    if (
      (await fileHash(this.executable)) !== (apply ? journal.previousSha256 : journal.sha256) ||
      (await fileHash(selected)) !== (apply ? journal.sha256 : journal.previousSha256)
    )
      throw new Error(
        'Recovery hashes do not match. Preserve the binaries and journal for repair.',
      );
    journal.state = apply ? 'staged' : 'installed';
    journal.recoveredBeforeReplacement = true;
    await this.save(journal);
    return this.status();
  }
}
