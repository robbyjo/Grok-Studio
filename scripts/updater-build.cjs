// Windows GUI bootstrapper: no agent runtime, credentials or model requests.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.platform !== 'win32')
  throw new Error('Updater bootstrap builds currently support Windows x64 only.');
fs.mkdirSync('.runtime', { recursive: true });
cp.execFileSync(
  'rustup',
  [
    'run',
    '1.95.0',
    'rustc',
    '--edition',
    '2024',
    '--target',
    'x86_64-pc-windows-msvc',
    '-C',
    'opt-level=s',
    '-C',
    'target-feature=+crt-static',
    '-C',
    'strip=symbols',
    path.resolve('native/updater-launcher.rs'),
    '-o',
    path.resolve('.runtime/updater-launcher.exe'),
  ],
  { stdio: 'inherit', windowsHide: true },
);
console.log('Built local Windows updater GUI bootstrapper (static CRT).');
