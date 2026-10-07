const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  crypto = require('node:crypto');
// App-local deployment from the developer's licensed Visual Studio redist tree,
// never from System32. These Microsoft DLLs are not Apache-2.0 source.
module.exports = function prepareRuntime() {
  const locator = path.join(
    process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe',
  );
  const studio = cp
    .execFileSync(
      locator,
      ['-latest', '-prerelease', '-products', '*', '-property', 'installationPath'],
      { encoding: 'utf8', windowsHide: true },
    )
    .trim();
  if (!studio)
    throw new Error(
      'MSVC redistributables are unavailable. Install the Visual Studio C++ build tools including redistributables.',
    );
  const base = path.join(studio, 'VC/Redist/MSVC');
  const versions = fs
    .readdirSync(base)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const version = versions.at(-1);
  if (!version) throw new Error('No licensed MSVC redist version was found.');
  const architecture = path.join(base, version, 'x64');
  const crt = fs.readdirSync(architecture).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name));
  if (!crt) throw new Error('No x64 Visual C++ runtime DLL directory was found.');
  const source = path.join(architecture, crt),
    destination = path.resolve('.runtime/msvc');
  fs.mkdirSync(destination, { recursive: true });
  const files = fs
    .readdirSync(source)
    .filter((name) => /^[\w.-]+\.dll$/i.test(name))
    .sort();
  if (!files.includes('vcruntime140.dll'))
    throw new Error('The required vcruntime140.dll redistributable is missing.');
  const report = { version, architecture: 'x64', files: [] };
  for (const name of files) {
    const from = path.join(source, name);
    const signature = JSON.parse(
      cp.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference='Stop';$env:PSModulePath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules';$s=Get-AuthenticodeSignature -LiteralPath $env:GROK_STUDIO_REDIST_FILE;@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject}|ConvertTo-Json -Compress",
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, GROK_STUDIO_REDIST_FILE: from },
        },
      ),
    );
    if (signature.status !== 'Valid' || !signature.subject.includes('Microsoft Corporation'))
      throw new Error('Microsoft redist signature verification failed: ' + name);
    const bytes = fs.readFileSync(from);
    fs.writeFileSync(path.join(destination, name), bytes);
    report.files.push({ name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  fs.mkdirSync('resources/engine', { recursive: true });
  fs.writeFileSync('resources/engine/msvc-runtime.json', JSON.stringify(report, null, 2) + '\n');
  const notice = path.join(studio, 'Licenses/1033/Redist.txt');
  if (!fs.existsSync(notice)) throw new Error('Visual Studio redistribution notice is missing.');
  fs.copyFileSync(notice, 'resources/engine/MSVC-REDIST.txt');
  console.log('Prepared signed app-local Microsoft C++ runtime:', version);
};
