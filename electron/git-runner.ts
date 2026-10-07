import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function git(root: string, args: string[]) {
  const { stdout } = await execute('git', ['--no-pager', ...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
export async function gitInput(
  root: string,
  args: string[],
  input = '',
  env: NodeJS.ProcessEnv = {},
) {
  return new Promise<string>((done, fail) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
      windowsHide: true,
      shell: false,
      stdio: 'pipe',
    });
    let output = '',
      error = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('Git operation timed out.'));
    }, 30000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) {
        child.kill();
        fail(new Error('Git output exceeded 8 MiB.'));
      }
    });
    child.stderr.on('data', (chunk) => (error = (error + chunk).slice(-8000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? done(output) : fail(new Error(error || `Git failed (${code}).`));
    });
    child.stdin.end(input);
  });
}
