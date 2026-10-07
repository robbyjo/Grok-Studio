import { execFile } from 'node:child_process';
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
