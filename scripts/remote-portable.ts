import { chromium } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { version } from '../package.json';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function main() {
  const host = process.argv[2];
  if (!host || !/^[\w.-]+$/.test(host) || !process.argv.includes('--run'))
    throw new Error('Usage: tsx scripts/remote-portable.ts TRUSTED_HOST --run [--copy-auth].');
  const sshArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
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
  const exe = `Grok-Studio-${version}-Portable.exe`;
  await execute(
    'scp',
    [...sshArgs, resolve('release', exe), `${host}:${root.replaceAll('\\', '/')}/${exe}`],
    { windowsHide: true, timeout: 180000 },
  );
  const hash = createHash('sha256')
    .update(await readFile(resolve('release', exe)))
    .digest('hex');
  assert.equal(
    (
      await remote(`(Get-FileHash -LiteralPath ${quote(root + '\\' + exe)} -Algorithm SHA256).Hash`)
    ).toLowerCase(),
    hash,
  );
  const report: any = {
    version,
    baseline,
    sha256: hash,
    startedAt: new Date().toISOString(),
    results: [],
    root,
  };
  const output = resolve('.test-data', `remote-${token}`);
  await mkdir(output, { recursive: true });
  // Only the selected Grok auth file is transferable. No desktop histories or other app profiles.
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
          `Move-Item -LiteralPath ${quote(root + '\\' + locations[0])} -Destination ${quote(folder)}`,
        );
      }
      // Keep this SSH session alive: Windows OpenSSH owns the launched app's job tree.
      const launchScript = `$ErrorActionPreference='Stop';Remove-Item Env:GROK_HOME,Env:GROK_DESKTOP_DATA_DIR,Env:XAI_API_KEY,Env:GROK_DEPLOYMENT_KEY -ErrorAction SilentlyContinue;$p=Start-Process -FilePath ${quote(folder + '\\' + exe)} -WorkingDirectory ${quote(folder)} -ArgumentList '--remote-debugging-port=${port}' -WindowStyle Hidden -PassThru;Write-Output $p.Id;Wait-Process -Id $p.Id`;
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
      await call('terminal:open', { id: 't' });
      await call('terminal:write', {
        id: 't',
        data: "Write-Output ('REMOTE_' + (40 + 2)); & grok --version\r",
      });
      await page.waitForFunction(
        async () => {
          const result = await window.desktop.call('terminal:open', { id: 't' });
          return result.buffer.includes('REMOTE_42') && result.buffer.includes('grok 1.0.46');
        },
        undefined,
        { timeout: 30000 },
      );
      const state = await call('state');
      if (i === 0) {
        assert.equal(state.threads[0].sessionId, undefined);
        await call('thread:edit', { id: 't', title: 'Persisted on DESKTOP', pinned: true });
        report.results.push({
          name: 'fresh portable launch and bundled runtime/PTY without Node or Grok',
          status: 'pass',
        });
      } else {
        assert.equal(state.threads[0].title, 'Persisted on DESKTOP');
        assert.equal(state.threads[0].pinned, true);
        report.results.push({
          name: 'second-machine relocation and profile persistence',
          status: 'pass',
        });
        if (process.argv.includes('--copy-auth')) {
          await call('agent:disconnect', { id: 't' });
          await remote(
            `New-Item -ItemType Directory -Force -Path ${quote(info.grokHome)}|Out-Null`,
          );
          if (!info.grokHome.toLowerCase().startsWith((root + '\\').toLowerCase()))
            throw new Error('Credential destination leaves the isolated acceptance root.');
          report.authFile = info.grokHome + '\\auth.json';
          await execute(
            'scp',
            [
              ...sshArgs,
              resolve('release/Grok Desktop Data/grok/auth.json'),
              `${host}:${info.grokHome.replaceAll('\\', '/')}/auth.json`,
            ],
            { windowsHide: true, timeout: 30000 },
          );
          await call('agent:connect', { id: 't' });
          await page.evaluate(() => {
            (window as any).remoteTurn = { done: false };
            void window.desktop
              .call('agent:prompt', {
                id: 't',
                text: 'Do not use any tools or change files. Reply exactly CROSS_MACHINE_OK.',
              })
              .then(
                () => {
                  (window as any).remoteTurn.done = true;
                },
                (error) => {
                  (window as any).remoteTurn = { done: true, error: String(error) };
                },
              );
          });
          await page.waitForFunction(() => (window as any).remoteTurn.done, undefined, {
            timeout: 180000,
          });
          const result = await page.evaluate(() => (window as any).remoteTurn);
          assert.equal(result.error, undefined);
          assert.ok(
            (await call('state')).threads[0].entries.some(
              (entry: any) => entry.type === 'assistant' && entry.text.includes('CROSS_MACHINE_OK'),
            ),
          );
          report.results.push({
            name: 'copied selected Grok auth file authenticates real model on second machine',
            status: 'pass',
          });
        }
      }
      await page.screenshot({ path: resolve(output, `launch-${i}.png`) });
      await page.close();
      await browser.close();
      browser = undefined;
      await sleep(3000);
      launcher.kill();
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
    if (report.authFile) {
      try {
        await remote(
          `if(Test-Path -LiteralPath ${quote(report.authFile)}){Remove-Item -LiteralPath ${quote(report.authFile)} -Force};if(Test-Path -LiteralPath ${quote(report.authFile)}){throw 'Credential cleanup failed'}`,
        );
        report.credentialCleanupVerified = true;
      } catch (error) {
        report.credentialCleanupVerified = false;
        report.results.push({
          name: 'credential cleanup',
          status: 'fail',
          error: (error as Error).message,
        });
        process.exitCode = 1;
      }
    }
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
