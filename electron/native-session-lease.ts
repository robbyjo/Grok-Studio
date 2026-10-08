import { spawn } from 'node:child_process';
/** Deny native writers access to existing session lock files while retaining delete sharing.
 * This follows the pinned runtime's .lock convention; separately running clients must still stop.
 */
export async function nativeSessionLease(paths: string[]) {
  if (process.platform !== 'win32' || !paths.length) return async () => {};
  if (paths.length > 4096) throw new Error('Native retention exceeds its lock-file limit.');
  const script =
    "$ErrorActionPreference='Stop';$held=@();try{$paths=([Console]::ReadLine()|ConvertFrom-Json);foreach($p in $paths){$held+=New-Object IO.FileStream($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Delete))};[Console]::WriteLine('LEASE_READY');[Console]::ReadLine()|Out-Null}catch{[Console]::WriteLine('LEASE_FAILED');exit 1}finally{foreach($h in $held){$h.Dispose()}}";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.on('error', () => {});
  const exited = new Promise<void>((done) => child.once('close', () => done()));
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Native session lock inspection timed out. Originals retained.'));
    }, 10000);
    const fail = () => {
      clearTimeout(timeout);
      reject(
        new Error(
          'A native session lock is in use. Stop other Grok clients before pruning. Originals retained.',
        ),
      );
    };
    child.once('error', fail);
    child.once('exit', fail);
    let output = '';
    child.stdout.on('data', (part) => {
      output = (output + part).slice(-1024);
      if (output.includes('LEASE_READY')) {
        clearTimeout(timeout);
        done();
      } else if (output.includes('LEASE_FAILED')) fail();
    });
    child.stdin.write(JSON.stringify(paths) + '\n');
  });
  let released: Promise<void> | undefined;
  return () =>
    (released ??= (async () => {
      child.stdin.end('\n');
      const timeout = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timeout);
    })());
}
