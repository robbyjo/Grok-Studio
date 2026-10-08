// Run after packaging/signing; creates metadata locally and never publishes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
async function main() {
  const version = require('../package.json').version,
    engine = JSON.parse(fs.readFileSync('.runtime/engine.json', 'utf8')),
    file = path.resolve('release', `Grok-Workbench-${version}-Portable.exe`);
  const hash = crypto.createHash('sha256');
  for await (const part of fs.createReadStream(file)) hash.update(part);
  const sha256 = hash.digest('hex');
  const script =
    "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); $s=Get-AuthenticodeSignature -LiteralPath $env:GROK_SIGN_CHECK_FILE; $publisher=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{''}; @{status=$s.Status.ToString(); thumbprint=$s.SignerCertificate.Thumbprint; publisher=$publisher} | ConvertTo-Json -Compress";
  const signature = JSON.parse(
    cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GROK_SIGN_CHECK_FILE: file },
    }),
  );
  if (
    (process.env.GROK_REQUIRE_SIGNING === '1' || process.argv.includes('--require-signing')) &&
    signature.status !== 'Valid'
  )
    throw new Error('A valid Windows code-signing certificate is required for this build.');
  if (
    process.env.GROK_SIGNER_THUMBPRINT &&
    signature.thumbprint?.toLowerCase() !== process.env.GROK_SIGNER_THUMBPRINT.toLowerCase()
  )
    throw new Error('Unexpected code-signing certificate.');
  if (process.env.GROK_SIGNER_NAME && signature.publisher !== process.env.GROK_SIGNER_NAME)
    throw new Error('Unexpected code-signing publisher.');
  const manifest = {
    format: 1,
    product: 'Grok Workbench',
    version,
    platform: 'win32-x64',
    bytes: fs.statSync(file).size,
    sha256,
    stateSchema: 1,
    historySchema: 1,
    bindingVersion: engine.bindingVersion,
    engineSha256: engine.sha256,
    signerThumbprint: signature.status === 'Valid' ? signature.thumbprint : null,
    signerPublisher: signature.status === 'Valid' ? signature.publisher : null,
  };
  fs.writeFileSync(file + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(file + '.sha256', sha256 + '  ' + path.basename(file) + '\n');
  console.log(
    'Local portable manifest:',
    path.basename(file) + '.manifest.json',
    'signature:',
    signature.status,
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
