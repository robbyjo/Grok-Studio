import { chromium, _electron as electron } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { version } from '../package.json';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function main() {
  const host = process.argv[2];
  const option = (name: string) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const sourceExe = resolve(option('--exe') ?? `release/Grok-Workbench-${version}-Portable.exe`);
  const knownHosts = option('--known-hosts');
  if (process.argv.includes('--copy-auth'))
    throw new Error('Credential export is not supported. Sign in freshly on the target machine.');
  if (!host || !/^(?:[\w][\w.-]*@)?[\w][\w.-]*$/.test(host) || !process.argv.includes('--run'))
    throw new Error(
      'Usage: tsx scripts/remote-portable.ts TRUSTED_HOST --run [--exe PATH] [--known-hosts PATH].',
    );
  const sshArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    ...(knownHosts ? ['-o', 'UserKnownHostsFile=' + resolve(knownHosts)] : []),
  ];
  const remote = async (script: string) => {
    const { stdout } = await execute(
      'ssh',
      [
        ...sshArgs,
        host,
        'powershell',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script,
          'utf16le',
        ).toString('base64'),
      ],
      { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  };
  const baseline = JSON.parse(
    await remote(
      '[pscustomobject]@{machine=$env:COMPUTERNAME;windows=(Get-CimInstance Win32_OperatingSystem).Caption;node=[bool](Get-Command node -ErrorAction SilentlyContinue);git=[bool](Get-Command git -ErrorAction SilentlyContinue);grok=[bool](Get-Command grok -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress',
    ),
  );
  const token = randomUUID();
  const root = await remote(
    `$p=Join-Path $env:LOCALAPPDATA 'GrokStudioAcceptance/${token}';New-Item -ItemType Directory -Path $p|Out-Null;$p`,
  );
  if (!/^[A-Za-z]:\\/.test(root) || !root.endsWith(token))
    throw new Error('Unexpected remote acceptance path.');
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const exe = basename(sourceExe);
  if (!/^[\w.-]+\.exe$/.test(exe)) throw new Error('Use a plain executable filename.');
  await execute('scp', [...sshArgs, sourceExe, `${host}:${root.replaceAll('\\', '/')}/${exe}`], {
    windowsHide: true,
    timeout: 180000,
  });
  const hash = createHash('sha256')
    .update(await readFile(sourceExe))
    .digest('hex');
  assert.equal(
    (
      await remote(`(Get-FileHash -LiteralPath ${quote(root + '\\' + exe)} -Algorithm SHA256).Hash`)
    ).toLowerCase(),
    hash,
  );
  const report: any = {
    version,
    sourceExecutable: basename(sourceExe),
    liveCredentialTransfer: false,
    fakeEncryptedKeyFixture: true,
    baseline,
    sha256: hash,
    startedAt: new Date().toISOString(),
    results: [],
    root,
  };
  const output = resolve('.test-data', `remote-${token}`);
  await mkdir(output, { recursive: true });
  // Generate a fake value in a new local profile. No real API/OAuth credential is read.
  const localFixture = resolve(output, 'fake-key-profile');
  const localApp = await electron.launch({
    args: ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      GROK_DESKTOP_DATA_DIR: localFixture,
      GROK_HOME: resolve(localFixture, 'grok'),
      XAI_API_KEY: '',
      GROK_CODE_XAI_API_KEY: '',
    },
  });
  try {
    const localPage = await localApp.firstWindow();
    await localPage.evaluate(() =>
      window.desktop.call('auth:save', {
        key: 'FAKE_DPAPI_PORTABILITY_CANARY_NOT_A_REAL_API_KEY',
        remember: true,
      }),
    );
  } finally {
    await localApp.close();
  }
  const fakeCipher = resolve(localFixture, 'xai-api-key.bin');
  assert.ok(!(await readFile(fakeCipher)).includes(Buffer.from('FAKE_DPAPI')));
  // Only the executable is copied. Both launches use a fresh, isolated profile.
  let tunnel: ReturnType<typeof spawn> | undefined;
  let launcher: ReturnType<typeof spawn> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let pid: number | undefined;
  const port = 20000 + Math.floor(Math.random() * 15000);
  try {
    const locations = ['Portable location with spaces', 'Relocated portable app'];
    let folder = '';
    for (let i = 0; i < locations.length; i++) {
      folder = root + '\\' + locations[i];
      if (i === 0) {
        await remote(
          `$root=${quote(root)};$folder=${quote(folder)};New-Item -ItemType Directory -Path $folder|Out-Null;Move-Item -LiteralPath (Join-Path $root ${quote(exe)}) -Destination $folder;$project=Join-Path $root 'project';New-Item -ItemType Directory -Path $project|Out-Null;$data=Join-Path $folder 'Grok Desktop Data';New-Item -ItemType Directory -Path $data|Out-Null;$now=[DateTime]::UtcNow.ToString('o');@{version=1;projects=@(@{id='p';name='Remote portable acceptance';path=$project});settings=@{executable='bundled'};threads=@(@{id='t';projectId='p';title='Remote acceptance';cwd=$project;status='idle';archived=$false;pinned=$false;createdAt=$now;updatedAt=$now;entries=@()})}|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $data 'state.json') -Encoding UTF8`,
        );
        // Windows PowerShell Set-Content adds a BOM; Store expects JSON without one.
        await remote(
          `$p=Join-Path ${quote(folder)} 'Grok Desktop Data/state.json';$s=Get-Content -LiteralPath $p -Raw;[IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding($false)))`,
        );
      } else {
        await remote(
          `$testRoot=[IO.Path]::GetFullPath(${quote(root)}).TrimEnd('\\')+'\\';$from=[IO.Path]::GetFullPath(${quote(root + '\\' + locations[0])});$to=[IO.Path]::GetFullPath(${quote(folder)});if(-not $from.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)-or -not $to.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Move target escapes acceptance workspace'};Move-Item -LiteralPath $from -Destination $to`,
        );
      }
      // Keep this SSH session alive: Windows OpenSSH owns the launched app's job tree.
      const launchScript = `$ErrorActionPreference='Stop';Remove-Item Env:GROK_HOME,Env:GROK_DESKTOP_DATA_DIR,Env:XAI_API_KEY,Env:GROK_DEPLOYMENT_KEY,Env:GROK_CODE_XAI_API_KEY -ErrorAction SilentlyContinue;$p=Start-Process -FilePath ${quote(folder + '\\' + exe)} -WorkingDirectory ${quote(folder)} -ArgumentList '--remote-debugging-port=${port}' -WindowStyle Hidden -PassThru;Write-Output $p.Id;Wait-Process -Id $p.Id`;
      launcher = spawn(
        'ssh',
        [
          ...sshArgs,
          host,
          'powershell',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(launchScript, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let launchOutput = '',
        launchError = '';
      launcher.stdout!.on('data', (chunk) => {
        launchOutput += chunk;
      });
      launcher.stderr!.on('data', (chunk) => {
        launchError = (launchError + chunk).slice(-2000);
      });
      for (let n = 0; n < 40 && !launchOutput.includes('\n') && launcher.exitCode === null; n++)
        await sleep(250);
      pid = Number(launchOutput.trim().split(/\s/)[0]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0, `Remote launcher failed: ${launchError}`);
      tunnel = spawn(
        'ssh',
        [
          ...sshArgs,
          '-o',
          'ExitOnForwardFailure=yes',
          '-N',
          '-L',
          `${port}:127.0.0.1:${port}`,
          host,
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
      let ready = false;
      for (let n = 0; n < 120; n++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
            ready = true;
            break;
          }
        } catch {}
        await sleep(500);
      }
      assert.ok(
        ready,
        `Remote portable application failed to launch (SSH exit ${launcher.exitCode}): ${launchError}`,
      );
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(() => Boolean(window.desktop));
      const call = (method: string, input: any = {}) =>
        page.evaluate(({ method, input }) => window.desktop.call(method, input), { method, input });
      const info = await call('runtime:info');
      assert.equal(info.portable, true);
      assert.equal(
        info.dataDirectory.toLowerCase(),
        (folder + '\\Grok Desktop Data').toLowerCase(),
      );
      assert.equal(
        info.grokHome.toLowerCase(),
        (folder + '\\Grok Desktop Data\\grok').toLowerCase(),
      );
      if (i === 0) {
        await call('agent:disconnect', { id: 't' });
        const remoteCipher = info.dataDirectory + '\\xai-api-key.bin';
        assert.equal(await remote(`Test-Path -LiteralPath ${quote(remoteCipher)}`), 'False');
        await execute(
          'scp',
          [...sshArgs, fakeCipher, `${host}:${remoteCipher.replaceAll('\\', '/')}`],
          { windowsHide: true, timeout: 30000 },
        );
        await call('auth:mode', { mode: 'api' });
        const error = await page.evaluate(() =>
          window.desktop.call('agent:connect', { id: 't' }).then(
            () => '',
            (e) => String(e),
          ),
        );
        assert.match(error, /cannot be decrypted on this Windows account\/machine/);
        await call('auth:forget');
        await call('auth:mode', { mode: 'oauth' });
        assert.equal(await remote(`Test-Path -LiteralPath ${quote(remoteCipher)}`), 'False');
        report.results.push({
          name: 'fake DPAPI key copied across machines refuses decryption with actionable guidance; copied fixture removed',
          status: 'pass',
        });
      }
      await call('terminal:open', { id: 't' });
      await call('terminal:write', {
        id: 't',
        data: "Write-Output ('REMOTE_' + (40 + 2))\r",
      });
      await page.waitForFunction(
        async () => {
          const result = await window.desktop.call('terminal:open', { id: 't' });
          return result.buffer.includes('REMOTE_42');
        },
        undefined,
        { timeout: 30000 },
      );
      const state = await call('state');
      assert.ok(info.executable.endsWith('studio-engine.node'));
      const fixture = await call('mcp:list', { id: 't' });
      assert.ok(Array.isArray(fixture));
      if (i === 0) {
        const server = root + '\\portable-mcp-fixture.ps1';
        const text = `$ErrorActionPreference='Stop'
while ($null -ne ($line=[Console]::ReadLine())) {
  $message=$line|ConvertFrom-Json
  if ($null -eq $message.id) { continue }
  $result = switch ($message.method) {
    'initialize' { @{protocolVersion=$message.params.protocolVersion;capabilities=@{tools=@{}};serverInfo=@{name='portable-powershell-fixture';version='1.0'}};break }
    'tools/list' { @{tools=@(@{name='say_hello';description='Local acceptance greeting';inputSchema=@{type='object';properties=@{}}})};break }
    'tools/call' { @{content=@(@{type='text';text='PORTABLE_MCP_OK'})};break }
    default { @{} }
  }
  [Console]::WriteLine((@{jsonrpc='2.0';id=$message.id;result=$result}|ConvertTo-Json -Depth 15 -Compress))
}`;
        await remote(
          `[IO.File]::WriteAllText(${quote(server)},[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text).toString('base64')}')),(New-Object Text.UTF8Encoding($false)))`,
        );
        await call('mcp:add', {
          id: 't',
          name: 'portablepowershell',
          scope: 'user',
          transport: 'stdio',
          command: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', server],
        });
        assert.equal(
          (await call('mcp:doctor', { id: 't', name: 'portablepowershell' })).healthy_count,
          1,
        );
        report.results.push({
          name: 'native STDIO MCP initialize/tool inventory with Windows PowerShell; no external Node fixture dependency',
          status: 'pass',
        });
        assert.equal(state.threads[0].sessionId, undefined);
        await call('thread:edit', { id: 't', title: 'Persisted on remote Windows', pinned: true });
        report.results.push({
          name: 'fresh portable launch with embedded runtime and PowerShell PTY',
          status: 'pass',
        });
      } else {
        assert.ok(fixture.some((s: any) => s.name === 'portablepowershell'));
        assert.equal(
          (await call('mcp:doctor', { id: 't', name: 'portablepowershell' })).healthy_count,
          1,
        );
        assert.equal(state.threads[0].title, 'Persisted on remote Windows');
        assert.equal(state.threads[0].pinned, true);
        report.results.push({
          name: 'second-machine relocation and profile persistence',
          status: 'pass',
        });
      }
      await page.screenshot({ path: resolve(output, `launch-${i}.png`) });
      await page.close();
      await browser.close();
      browser = undefined;
      if (launcher.exitCode == null) {
        await new Promise<void>((done, reject) => {
          const timeout = setTimeout(
            () =>
              reject(
                new Error(
                  'Remote portable did not finish shutdown. Original test location retained.',
                ),
              ),
            20000,
          );
          launcher!.once('close', () => {
            clearTimeout(timeout);
            done();
          });
        });
      }
      launcher = undefined;
      tunnel.kill();
      tunnel = undefined;
      console.log(`REMOTE_PASS ${report.results.at(-1).name}`);
    }
  } catch (error) {
    report.results.push({
      name: 'remote acceptance',
      status: 'fail',
      error: (error as Error).message,
    });
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    tunnel?.kill();
    // Stop only the launcher tree from this uniquely identified test directory, if still running.
    if (pid)
      await remote(
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p -and $p.Path -and $p.Path.StartsWith(${quote(root + '\\')},[StringComparison]::OrdinalIgnoreCase)){& taskkill /PID ${pid} /T /F|Out-Null}`,
      ).catch(() => {});
    launcher?.kill();
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`REMOTE_REPORT ${resolve(output, 'report.json')}`);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
