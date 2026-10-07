import { Agents } from '../electron/agent';
import { Store } from '../electron/store';
import { Sessions } from '../electron/sessions';
import { RpcProcess } from '../electron/rpc';
import { EmbeddedRpc } from '../electron/embedded-rpc';
import { embeddedEngine } from '../electron/runtime';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const execute = promisify(execFile),
  delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to send real model prompts in a disposable repository.');
  const home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok'),
    executable = resolve('.runtime/grok.exe');
  const root = await mkdtemp(resolve('.test-data/native-sessions-')),
    cwd = join(root, 'repository');
  await mkdir(cwd);
  await mkdir(join(cwd, '.grok'));
  const git = (args: string[]) => execute('git', args, { cwd, windowsHide: true });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Acceptance']);
  await git(['config', 'user.email', 'acceptance@example.invalid']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(join(cwd, 'value.txt'), 'before rewind\n');
  await writeFile(join(cwd, '.grok/config.toml'), '[permission]\nask=["Edit", "Bash(*)"]\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'Acceptance baseline']);
  const cliId = randomUUID(),
    env = { ...process.env, GROK_HOME: home };
  const seed = await execute(
    executable,
    [
      '--cwd',
      cwd,
      '--session-id',
      cliId,
      '--no-subagents',
      '--disable-web-search',
      '-p',
      'Do not use any tools or change files. Reply only CLI_IMPORT_OK.',
    ],
    { env, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.match(seed.stdout, /CLI_IMPORT_OK/);
  const store = new Store(join(root, 'desktop/state.json')),
    project = store.openProject(cwd, 'Native session acceptance'),
    browser = store.create(project.id, cwd);
  const agents = new Agents(
      store,
      () => {},
      (path) =>
        process.env.GROK_STUDIO_ENGINE === 'cli'
          ? new RpcProcess(executable, ['agent', '--no-leader', 'stdio'], path, env)
          : new EmbeddedRpc(embeddedEngine(), path, env, 'oauth'),
    ),
    sessions = new Sessions(agents, store);
  const report: any = { results: [], repository: cwd, cliSessionId: cliId };
  const resolveTrust = async () => {
    await delay(500);
    for (const permission of agents.permissionsSnapshot()) {
      assert.equal(permission.kind, 'trust');
      agents.approve(permission.id, 'trust');
    }
  };
  try {
    await agents.connect(browser.id);
    await resolveTrust();
    let list = await sessions.list(browser.id);
    while (!list.sessions.some((item: any) => item.sessionId === cliId) && list.nextCursor)
      list = await sessions.list(browser.id, list.nextCursor);
    assert.ok(list.sessions.some((item: any) => item.sessionId === cliId));
    const imported = await sessions.import(browser.id, cliId);
    await resolveTrust();
    assert.ok(
      imported.entries.some(
        (entry) => entry.type === 'assistant' && entry.text.includes('CLI_IMPORT_OK'),
      ),
    );
    report.results.push({ name: 'actual CLI seed, import and history replay', status: 'pass' });
    const fork = await sessions.fork(imported.id);
    await resolveTrust();
    assert.notEqual(fork.sessionId, cliId);
    assert.ok(fork.entries.some((entry) => entry.text.includes('CLI_IMPORT_OK')));
    report.results.push({ name: 'native fork preserves CLI transcript', status: 'pass' });
    let done = false,
      failure: unknown;
    const prompt = agents
      .prompt(
        fork.id,
        'Work only in this disposable repository. Do not use shell, network, web search or subagents. Read value.txt and use the Edit tool to replace its contents with exactly after rewind followed by a newline. Change no other files.',
        [],
      )
      .then(
        () => {
          done = true;
        },
        (error) => {
          done = true;
          failure = error;
        },
      );
    const deadline = Date.now() + 180000;
    while (!done && Date.now() < deadline) {
      for (const permission of agents.permissionsSnapshot()) {
        const serialized = JSON.stringify(permission.toolCall);
        if (permission.kind === 'trust') agents.approve(permission.id, 'trust');
        else {
          assert.ok(
            permission.toolCall.kind === 'edit' || /value\.txt/.test(serialized),
            'Unexpected tool approval in bounded edit acceptance.',
          );
          const option = permission.options.find((option) => option.kind === 'allow_once');
          assert.ok(option);
          agents.approve(permission.id, option.optionId);
        }
      }
      await delay(100);
    }
    assert.ok(done, 'Native edit exceeded acceptance timeout');
    await prompt;
    if (failure) throw failure;
    assert.equal((await readFile(join(cwd, 'value.txt'), 'utf8')).trim(), 'after rewind');
    const points = await sessions.points(fork.id),
      point = [...points.rewind_points].reverse().find((point: any) => point.has_file_changes);
    assert.ok(point, JSON.stringify(points));
    const filePreview = await sessions.preview(fork.id, point.prompt_index, 'files_only');
    const files = await sessions.rewind(fork.id, filePreview.token);
    assert.equal(files.success, true);
    assert.equal(await readFile(join(cwd, 'value.txt'), 'utf8'), 'before rewind\n');
    report.results.push({
      name: 'real edit, file checkpoint rewind and recovery backup',
      status: 'pass',
    });
    const conversation = await sessions.preview(fork.id, point.prompt_index, 'conversation_only');
    assert.equal((await sessions.rewind(fork.id, conversation.token)).success, true);
    report.results.push({ name: 'native conversation checkpoint rewind', status: 'pass' });
    const target = join(root, 'handoff');
    await git(['worktree', 'add', '-b', 'codex/handoff', target, 'main']);
    const previous = fork.sessionId;
    await sessions.handoff(fork.id, target);
    await resolveTrust();
    assert.notEqual(fork.sessionId, previous);
    assert.equal(fork.cwd, target);
    assert.ok(fork.entries.some((entry) => entry.text.includes('CLI_IMPORT_OK')));
    report.results.push({
      name: 'native session handoff preserves conversation at another worktree',
      status: 'pass',
    });
  } finally {
    agents.shutdown();
    store.flush();
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log('NATIVE_SESSION_REPORT', join(root, 'report.json'));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
