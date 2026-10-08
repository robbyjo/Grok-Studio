import { chromium, type Browser } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const execute = promisify(execFile);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function main() {
  const option = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  if (
    !process.argv.includes('--run') ||
    !process.argv.includes('--host') ||
    !process.argv.includes('--report')
  )
    throw new Error(
      'Use --run --host USER@HOST --report prior-portable-report.json --known-hosts FILE. Sign in freshly on that machine first. Credentials are never copied.',
    );
  const host = option('--host');
  assert.match(host, /^[\w][\w.-]*@[\w][\w.-]*$/);
  const prior = JSON.parse(await readFile(resolve(option('--report')), 'utf8'));
  assert.match(
    prior.root,
    /^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\GrokStudioAcceptance\\[0-9a-f-]{36}$/i,
  );
  assert.match(prior.sourceExecutable, /^[\w.-]+\.exe$/);
  const folder = prior.root + '\\Relocated portable app';
  const executable = folder + '\\' + prior.sourceExecutable;
  const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
  const ssh = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=8',
    '-o',
    'UserKnownHostsFile=' + resolve(option('--known-hosts')),
  ];
  const remote = async (script: string) =>
    (
      await execute(
        'ssh',
        [
          ...ssh,
          host,
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64'),
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1048576 },
      )
    ).stdout.trim();
  await remote(
    `$owned=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -ieq ${quote(executable)}});if($owned.Count){$all=@(Get-CimInstance Win32_Process);foreach($row in $all){$id=$row.ProcessId;for($n=0;$n -lt 12;$n++){$ancestor=$all|Where-Object ProcessId -eq $id|Select-Object -First 1;if(-not $ancestor){break};if($owned.ProcessId -contains $id){$p=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;if($p -and $p.MainWindowHandle -ne 0){[void]$p.CloseMainWindow()};break};$id=$ancestor.ParentProcessId}};foreach($p in $owned){Wait-Process -Id $p.ProcessId -Timeout 20 -ErrorAction SilentlyContinue}}`,
  );
  assert.equal(
    await remote(
      `@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -ieq ${quote(executable)}}).Count`,
    ),
    '0',
    'Close the owned test app first.',
  );
  let hash = prior.sha256;
  if (process.argv.includes('--candidate')) {
    const candidate = resolve(option('--candidate'));
    hash = createHash('sha256')
      .update(await readFile(candidate))
      .digest('hex');
    const staged = prior.root + '\\oauth-candidate.exe';
    await execute('scp', [...ssh, candidate, `${host}:${staged.replaceAll('\\', '/')}`], {
      windowsHide: true,
      timeout: 180000,
    });
    assert.equal(
      (
        await remote(`(Get-FileHash -LiteralPath ${quote(staged)} -Algorithm SHA256).Hash`)
      ).toLowerCase(),
      hash,
    );
    await remote(
      `Move-Item -LiteralPath ${quote(staged)} -Destination ${quote(executable)} -Force`,
    );
  }
  assert.equal(
    (
      await remote(`(Get-FileHash -LiteralPath ${quote(executable)} -Algorithm SHA256).Hash`)
    ).toLowerCase(),
    hash,
  );
  const output = resolve('.test-data', 'remote-oauth-' + randomUUID());
  await mkdir(output, { recursive: true });
  let browser: Browser | undefined,
    launcher: ChildProcess | undefined,
    tunnel: ChildProcess | undefined,
    pid: number | undefined;
  const port = 21000 + Math.floor(Math.random() * 13000);
  let sessionId: string | undefined;
  try {
    for (let launch = 0; launch < 2; launch++) {
      const script = `$ErrorActionPreference='Stop';Remove-Item Env:GROK_HOME,Env:GROK_DESKTOP_DATA_DIR,Env:XAI_API_KEY,Env:GROK_CODE_XAI_API_KEY,Env:GROK_DEPLOYMENT_KEY -ErrorAction SilentlyContinue;$p=Start-Process -FilePath ${quote(executable)} -WorkingDirectory ${quote(folder)} -ArgumentList '--remote-debugging-port=${port}' -WindowStyle Hidden -PassThru;Write-Output $p.Id;Wait-Process -Id $p.Id`;
      launcher = spawn(
        'ssh',
        [
          ...ssh,
          host,
          'powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      pid = await new Promise<number>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('Remote launch timed out.')), 30000);
        launcher!.stdout!.once('data', (s) => {
          clearTimeout(timer);
          const id = Number(String(s).trim());
          if (!Number.isSafeInteger(id) || id <= 0)
            reject(new Error('Invalid owned launcher PID.'));
          else done(id);
        });
        launcher!.once('error', reject);
      });
      tunnel = spawn(
        'ssh',
        [...ssh, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${port}:127.0.0.1:${port}`, host],
        { windowsHide: true, stdio: 'ignore' },
      );
      for (let n = 0; n < 100; n++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
            break;
          }
        } catch {}
        await delay(500);
      }
      assert.ok(browser, 'Owned app did not start.');
      const page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(() => Boolean(window.desktop));
      const call = (method: string, args: any = {}) =>
        page.evaluate(({ method, args }) => window.desktop.call(method, args), { method, args });
      assert.equal(
        (await call('auth:account')).account.signedIn,
        true,
        'Fresh OAuth sign-in is required on the target machine.',
      );
      let checking = false,
        rejectedTools = 0;
      const permissions = setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => {
          for (const p of await call('permissions')) {
            assert.equal(p.threadId, 't');
            const choice =
              p.kind === 'trust'
                ? 'trust'
                : p.options.find((o: any) => o.kind === 'reject_once')?.optionId;
            if (p.kind !== 'trust') rejectedTools++;
            if (!choice) throw new Error('No safe permission outcome.');
            await call('permission:answer', { permissionId: p.id, optionId: choice });
          }
        })()
          .catch(() => {})
          .finally(() => {
            checking = false;
          });
      }, 150);
      try {
        await call('agent:connect', { id: 't' });
        if (launch === 0) {
          await call('agent:prompt', {
            id: 't',
            text: 'Do not use tools. Reply with exactly USERPC_OAUTH_ACCEPTANCE_OK.',
            attachments: [],
          });
          const thread = (await call('state')).threads.find((t: any) => t.id === 't');
          assert.equal(thread.status, 'idle');
          assert.ok(
            thread.entries
              .filter((e: any) => e.type === 'assistant')
              .some((e: any) => e.text?.includes('USERPC_OAUTH_ACCEPTANCE_OK')),
          );
          sessionId = thread.sessionId;
          assert.ok(sessionId);
          assert.equal(rejectedTools, 0);
        } else
          assert.equal(
            (await call('state')).threads.find((t: any) => t.id === 't').sessionId,
            sessionId,
          );
        await call('agent:disconnect', { id: 't' });
      } finally {
        clearInterval(permissions);
      }
      await page.close();
      await browser.close();
      browser = undefined;
      if (launcher.exitCode == null)
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Remote shutdown did not finish.')),
            20000,
          );
          launcher!.once('close', () => {
            clearTimeout(timer);
            done();
          });
        });
      launcher = undefined;
      tunnel.kill();
      tunnel = undefined;
    }
    const result = {
      testedAt: new Date().toISOString(),
      machine: prior.baseline.machine,
      sha256: hash,
      outcome: 'pass',
      freshOAuthSignedInOnTarget: true,
      realModelRequest: true,
      accountPersistedAcrossAppRestart: true,
      nativeSessionResumed: true,
      liveCredentialTransfer: false,
      scope: 'Full app restart, not Windows reboot or forced account expiry.',
    };
    await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser?.close().catch(() => {});
    tunnel?.kill();
    if (pid)
      await remote(
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p -and $p.Path -ieq ${quote(executable)}){& taskkill /PID ${pid} /T /F|Out-Null}`,
      ).catch(() => {});
    launcher?.kill();
  }
}
main().catch((e) => {
  // Child-process errors include the full encoded PowerShell command. Keep
  // routine acceptance failures useful without dumping remote command bodies.
  console.error(
    typeof e?.cmd === 'string'
      ? `Remote OAuth acceptance command failed (exit ${String(e.code ?? 'unknown')}). Check SSH connectivity and the owned test app.`
      : e.message,
  );
  process.exitCode = 1;
});
