// Manual CI-only publication: immutable source/artifact identity, draft until all assets verify.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repository = 'robbyjo/Grok-Workbench';
const gh = (...args) =>
  cp.execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const api = (endpoint) => JSON.parse(gh('api', endpoint));
function validateRun(run, head) {
  if (
    !/^[a-f0-9]{40}$/.test(head) ||
    run.head_sha !== head ||
    run.head_branch !== 'main' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    run.conclusion !== 'success' ||
    run.status !== 'completed' ||
    run.path !== '.github/workflows/windows.yml' ||
    run.repository?.full_name !== repository
  )
    throw new Error(
      'Release requires a successful trusted Windows run for this exact main commit.',
    );
}
async function main() {
  const runId = process.env.GROK_RELEASE_RUN_ID,
    head = process.env.GROK_RELEASE_HEAD,
    signed = process.env.GROK_RELEASE_SIGNED === 'true';
  if (!/^\d+$/.test(runId ?? '')) throw new Error('Invalid Windows workflow run ID.');
  validateRun(api(`repos/${repository}/actions/runs/${runId}`), head);
  const source = api(`repos/${repository}/contents/package.json?ref=${head}`),
    version = JSON.parse(Buffer.from(source.content, 'base64').toString()).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid source version.');
  const tag = 'v' + version,
    artifacts = api(`repos/${repository}/actions/runs/${runId}/artifacts`).artifacts;
  const name = `Grok-Workbench-${signed ? 'Signed-' : ''}Windows-x64-${head}`;
  if (artifacts.filter((a) => a.name === name && !a.expired).length !== 1)
    throw new Error('Exact tested artifact is unavailable.');
  // Never replace an existing release or a previously created tag.
  if (
    api(`repos/${repository}/git/matching-refs/tags/${tag}`).some(
      (ref) => ref.ref === 'refs/tags/' + tag,
    )
  )
    throw new Error('Version tag already exists. Choose a new version.');
  const directory = fs.mkdtempSync(path.join(process.cwd(), 'ci-release-'));
  gh('run', 'download', runId, '--repo', repository, '--name', name, '--dir', directory);
  const exeName = `Grok-Workbench-${version}-Portable.exe`,
    exe = path.join(directory, exeName),
    manifestPath = exe + '.manifest.json',
    checksumPath = exe + '.sha256';
  if (
    fs.readdirSync(directory).sort().join('|') !==
    [exeName, exeName + '.manifest.json', exeName + '.sha256'].sort().join('|')
  )
    throw new Error('Unexpected release artifact contents.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(exe)) hash.update(chunk);
  const digest = hash.digest('hex');
  if (
    manifest.format !== 2 ||
    manifest.product !== 'Grok Workbench' ||
    manifest.version !== version ||
    manifest.platform !== 'win32-x64' ||
    manifest.sha256 !== digest ||
    manifest.bytes !== fs.statSync(exe).size ||
    fs.readFileSync(checksumPath, 'utf8').trim() !== digest + '  ' + exeName
  )
    throw new Error('CI artifact checksums/version failed verification.');
  const inspect =
    "$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1');$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:GROK_RELEASE_EXE);$s=Get-AuthenticodeSignature -LiteralPath $env:GROK_RELEASE_EXE;@{version=(@($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart)-join '.');product=$v.ProductName;signature=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint;publisher=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''}}|ConvertTo-Json -Compress";
  const identity = JSON.parse(
    cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspect], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GROK_RELEASE_EXE: exe },
    }),
  );
  if (identity.version !== version || identity.product !== 'Grok Workbench')
    throw new Error('Unexpected executable identity.');
  if (
    signed &&
    (!process.env.GROK_SIGNER_THUMBPRINT ||
      !process.env.GROK_SIGNER_NAME ||
      identity.signature !== 'Valid' ||
      identity.thumbprint?.toLowerCase() !== process.env.GROK_SIGNER_THUMBPRINT.toLowerCase() ||
      identity.publisher !== process.env.GROK_SIGNER_NAME ||
      manifest.signerThumbprint?.toLowerCase() !== identity.thumbprint.toLowerCase())
  )
    throw new Error('Approved signing identity failed verification.');
  if (!signed && (identity.signature !== 'NotSigned' || manifest.signerThumbprint))
    throw new Error('Unsigned release selection does not match artifact signature.');
  const notes = path.join(directory, 'release-notes.md');
  fs.writeFileSync(
    notes,
    `Portable Windows x64 alpha. ${signed ? 'Signed using the approved code-signing policy.' : 'Unsigned; Windows may show SmartScreen warnings.'}\n\nBuilt and accepted by [Windows CI](https://github.com/${repository}/actions/runs/${runId}) from source ${head}.\n\nSee [release gates](https://github.com/${repository}/blob/${head}/docs/RELEASE-GATES.md) for external acceptance limits.\n`,
  );
  // Reserve the exact immutable target explicitly: a draft need not create its
  // Git ref until publication. POST refuses an existing ref rather than moving it.
  gh(
    'api',
    `repos/${repository}/git/refs`,
    '-X',
    'POST',
    '-f',
    `ref=refs/tags/${tag}`,
    '-f',
    `sha=${head}`,
  );
  const reserved = api(`repos/${repository}/git/ref/tags/${tag}`);
  if (reserved.object?.type !== 'commit' || reserved.object.sha !== head)
    throw new Error('Reserved version tag does not match the tested source.');
  gh(
    'release',
    'create',
    tag,
    exe,
    manifestPath,
    checksumPath,
    '--repo',
    repository,
    '--target',
    head,
    '--verify-tag',
    '--title',
    'Grok Workbench ' + tag,
    '--draft',
    '--prerelease',
    '--notes-file',
    notes,
  );
  const release = api(`repos/${repository}/releases/tags/${tag}`);
  const tagged = api(`repos/${repository}/git/ref/tags/${tag}`);
  if (tagged.object?.type !== 'commit' || tagged.object.sha !== head)
    throw new Error('Release tag does not match the tested source. Release remains draft.');
  for (const file of [exe, manifestPath, checksumPath]) {
    const local = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      asset = release.assets.find((a) => a.name === path.basename(file));
    if (!asset || asset.digest !== 'sha256:' + local || asset.size !== fs.statSync(file).size)
      throw new Error('Uploaded asset verification failed. Release remains draft for repair.');
  }
  gh('release', 'edit', tag, '--repo', repository, '--draft=false');
  const published = api(`repos/${repository}/releases/tags/${tag}`);
  if (published.draft) throw new Error('Publication was not confirmed.');
  console.log(published.html_url);
}
module.exports = { validateRun };
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
