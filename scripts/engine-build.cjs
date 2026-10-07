const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process'),
  crypto = require('node:crypto');
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('The current engine build targets Windows x64.');
  require('./engine-source.cjs');
  const env = { ...process.env };
  if (!env.PROTOC) {
    try {
      cp.execFileSync('protoc', ['--version'], { stdio: 'ignore' });
    } catch {
      const folder = path.resolve('.runtime/protoc');
      fs.mkdirSync(folder, { recursive: true });
      const zip = path.join(folder, 'protoc.zip');
      const response = await fetch(
        'https://github.com/protocolbuffers/protobuf/releases/download/v34.1/protoc-34.1-win64.zip',
        { signal: AbortSignal.timeout(180000) },
      );
      if (!response.ok)
        throw new Error(
          'Could not download the pinned protobuf compiler. Set PROTOC to an existing installation.',
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        crypto.createHash('sha256').update(bytes).digest('hex') !==
        '6d7ebdc75e9c1f0026d4fb28f17ef1d0aae77d36744d83a9e052d79ba493724f'
      )
        throw new Error('Pinned protobuf checksum mismatch.');
      fs.writeFileSync(zip, bytes);
      cp.execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference='Stop'; $env:PSModulePath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'; Expand-Archive -LiteralPath $env:GROK_STUDIO_PROTO_ZIP -DestinationPath $env:GROK_STUDIO_PROTO_DIR -Force",
        ],
        {
          env: { ...env, GROK_STUDIO_PROTO_ZIP: zip, GROK_STUDIO_PROTO_DIR: folder },
          stdio: 'inherit',
        },
      );
      env.PROTOC = path.join(folder, 'bin/protoc.exe');
    }
  }
  cp.execFileSync(
    'cargo',
    [
      '+1.95.0',
      'build',
      '--manifest-path',
      'native/studio-engine/Cargo.toml',
      '--release',
      '--locked',
    ],
    { stdio: 'inherit', env },
  );
  fs.mkdirSync('.runtime', { recursive: true });
  const source = 'native/studio-engine/target/release/grok_studio_engine.dll',
    destination = '.runtime/studio-engine.node';
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (
    !fs.existsSync(destination) ||
    crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') !== sourceHash
  )
    fs.copyFileSync(source, destination);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
  fs.writeFileSync(
    '.runtime/engine.json',
    JSON.stringify(
      {
        revision: '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8',
        sha256,
        platform: 'win32-x64',
        bindingVersion: '0.6.0',
      },
      null,
      2,
    ) + '\n',
  );
  fs.mkdirSync('resources/engine', { recursive: true });
  for (const name of ['LICENSE', 'NOTICE']) {
    const from = path.join('upstream/grok-build', name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join('resources/engine', 'GROK-' + name));
  }
  fs.copyFileSync('native/UPSTREAM-CHANGES.md', 'resources/engine/UPSTREAM-CHANGES.md');
  const metadata = JSON.parse(
    cp.execFileSync(
      'cargo',
      [
        '+1.95.0',
        'metadata',
        '--manifest-path',
        'native/studio-engine/Cargo.toml',
        '--locked',
        '--format-version',
        '1',
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const notices = [
    'Embedded engine dependency notices. Cargo.lock is the reproducible dependency graph.\n',
  ];
  for (const pkg of metadata.packages) {
    const folder = path.dirname(pkg.manifest_path);
    notices.push(
      `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'See source notices'}\nSource: ${pkg.repository ?? pkg.source ?? 'pinned Grok Build checkout'}\n`,
    );
    for (const name of fs
      .readdirSync(folder)
      .filter((name) => /^(license|licence|copying|notice)([._-]|$)/i.test(name))) {
      const file = path.join(folder, name);
      if (fs.statSync(file).isFile() && fs.statSync(file).size < 1024 * 1024)
        notices.push(`\n${name}\n${fs.readFileSync(file, 'utf8')}\n`);
    }
  }
  fs.writeFileSync('resources/engine/CARGO-LICENSES.txt', notices.join(''));
  fs.copyFileSync('.runtime/engine.json', 'resources/engine/engine.json');
  require('./msvc-runtime.cjs')();
  console.log('Built embedded Studio engine:', sha256);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
