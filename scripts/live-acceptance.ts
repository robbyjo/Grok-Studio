import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Permission, State, Wire } from '../shared/types';
import { version } from '../package.json';

// Explicitly invoked only. This suite sends real, billable model prompts using the selected profile.
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to send authenticated model prompts.');
  const grokHome = resolve(process.env.GROK_STUDIO_LIVE_HOME ?? 'release/Grok Desktop Data/grok');
  await access(grokHome);
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/live-'));
  const cwd = join(root, 'repository'),
    data = join(root, 'desktop');
  await mkdir(cwd);
  await mkdir(data);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Grok Studio acceptance']);
  git(['config', 'user.email', 'acceptance@example.invalid']);
  await writeFile(join(cwd, 'value.txt'), 'original\n');
  await writeFile(
    join(cwd, 'check.cjs'),
    "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('value.txt','utf8').trim(),'edited by Grok');console.log('LIVE_TEST_OK');\n",
  );
  await writeFile(
    join(cwd, 'delayed.cjs'),
    "const fs=require('node:fs');fs.writeFileSync('command-started.txt','started');setTimeout(()=>fs.writeFileSync('late-marker.txt','unexpected'),30000);\n",
  );
  await mkdir(join(cwd, '.grok'));
  await writeFile(
    join(cwd, '.grok/config.toml'),
    '[permission]\nask = ["Bash(*)", "Edit", "MCPTool(*)"]\n',
  );
  git(['add', '.']);
  git(['commit', '-m', 'Live acceptance baseline']);
  const now = new Date().toISOString();
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'live-project', name: 'Live Grok acceptance', path: cwd }],
      settings: {
        executable: process.env.GROK_STUDIO_ENGINE ?? 'embedded',
      },
      threads: [
        {
          id: 'live-chat',
          projectId: 'live-project',
          title: 'Authenticated acceptance',
          cwd,
          status: 'idle',
          archived: false,
          pinned: false,
          createdAt: now,
          updatedAt: now,
          entries: [],
        },
      ],
    }),
  );
  const report: Wire = {
    appVersion: version,
    startedAt: now,
    repository: cwd,
    baseline: git(['rev-parse', 'HEAD']).trim(),
    profile: grokHome,
    results: [],
    approvals: [],
  };
  let child: ChildProcess | undefined, browser: Browser | undefined, page: Page;
  const serverName = `live-${randomUUID().slice(0, 8)}`;
  let mcpAdded = false;
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const call = <T = any>(method: string, input: Wire = {}) =>
    page.evaluate(({ method, input }) => window.desktop.call(method, input), {
      method,
      input,
    }) as Promise<T>;
  const state = () => call<State>('state');
  const active = async () => (await state()).threads.find((thread) => thread.id === 'live-chat')!;
  async function step(name: string, run: () => Promise<unknown>) {
    console.log(`LIVE_START ${name}`);
    try {
      const evidence = await run();
      report.results.push({ name, status: 'pass', evidence });
      console.log(`LIVE_PASS ${name}`);
    } catch (error) {
      report.results.push({ name, status: 'fail', error: (error as Error).message });
      console.log(`LIVE_FAIL ${name}: ${(error as Error).message}`);
      await call('agent:cancel', { id: 'live-chat' }).catch(() => {});
    }
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  }
  async function launch() {
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    const port = (listener.address() as any).port;
    await new Promise<void>((done) => listener.close(() => done()));
    const exe =
      process.env.GROK_STUDIO_LIVE_EXE ?? resolve('node_modules/electron/dist/electron.exe');
    child = spawn(
      exe,
      [...(process.env.GROK_STUDIO_LIVE_EXE ? [] : ['.']), `--remote-debugging-port=${port}`],
      {
        cwd: resolve('.'),
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          GROK_HOME: grokHome,
          GROK_DESKTOP_DATA_DIR: data,
          XAI_API_KEY: '',
          GROK_DEPLOYMENT_KEY: '',
        },
      },
    );
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {}
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error('Native live acceptance application did not launch.');
      await sleep(250);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => Boolean(window.desktop));
  }
  async function close() {
    await page.close();
    await browser?.close();
    browser = undefined;
    for (let i = 0; child?.exitCode === null && i < 100; i++) await sleep(100);
    if (child?.exitCode === null) throw new Error('Application did not quit normally.');
    child = undefined;
  }
  async function decide(policy: 'allow' | 'reject') {
    for (const permission of await call<Permission[]>('permissions')) {
      const option =
        permission.kind === 'trust'
          ? permission.options.find((item) => item.optionId === 'trust')
          : permission.options.find(
              (item) => item.kind === (policy === 'allow' ? 'allow_once' : 'reject_once'),
            );
      if (!option)
        throw new Error(
          `No exact ${policy}-once option advertised for ${permission.toolCall.title}.`,
        );
      report.approvals.push({
        tool: permission.toolCall,
        choices: permission.options,
        selected: option.optionId,
        phase: report.phase,
      });
      await page.getByRole('button', { name: option.name, exact: true }).click();
    }
  }
  async function prompt(
    text: string,
    policy: 'allow' | 'reject' = 'allow',
    started?: () => Promise<boolean>,
  ) {
    const before = (await active()).entries.length;
    await page.evaluate((text) => {
      (window as any).liveTurn = { done: false };
      void window.desktop.call('agent:prompt', { id: 'live-chat', text }).then(
        () => {
          (window as any).liveTurn.done = true;
        },
        (error) => {
          (window as any).liveTurn = { done: true, error: String(error) };
        },
      );
    }, text);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await decide(policy);
      if (started && (await started())) {
        await page.getByRole('button', { name: 'Stop turn', exact: true }).click();
        started = undefined;
      }
      const result = await page.evaluate(() => (window as any).liveTurn);
      if (result.done) {
        if (result.error) throw new Error(result.error);
        return (await active()).entries.slice(before);
      }
      await sleep(250);
    }
    throw new Error('Model turn exceeded the 3-minute acceptance limit.');
  }
  try {
    await launch();
    await step('authenticated connection', async () => {
      // Trust is granted only to the generated fixture policy above.
      const connection = call('agent:connect', { id: 'live-chat' });
      let done = false;
      void connection
        .finally(() => {
          done = true;
        })
        .catch(() => {});
      while (!done) {
        await decide('allow');
        await sleep(200);
      }
      await connection;
      // Grok can send its folder-trust callback immediately after session/new resolves.
      await sleep(500);
      await decide('allow');
      assert.equal((await active()).status, 'idle');
      const thread = await active();
      report.sessionId = thread.sessionId;
      report.configuration = {
        configs: thread.session?.configOptions,
        modes: thread.session?.modes,
      };
      return { sessionId: thread.sessionId, runtime: thread.session?.agent?.agentInfo };
    });
    const rules =
      'Work only in this disposable repository. Do not use the network, web search or subagents. Use the requested tools, do not merely describe commands. ';
    await step('real edit and test', async () => {
      report.phase = 'edit/test';
      const entries = await prompt(
        rules +
          `Read value.txt, replace its content with exactly edited by Grok followed by a newline, then run "${process.execPath}" check.cjs. Do not modify any other files.`,
      );
      assert.equal((await readFile(join(cwd, 'value.txt'), 'utf8')).trim(), 'edited by Grok');
      assert.equal(git(['diff', '--name-only']).trim(), 'value.txt');
      assert.ok(
        entries.some(
          (entry) => entry.type === 'tool' && JSON.stringify(entry.data).includes('LIVE_TEST_OK'),
        ),
        'Tool output must prove the actual test ran.',
      );
      await page.screenshot({ path: join(root, 'edit-test.png') });
      return entries;
    });
    await step('one-time approve', async () => {
      report.phase = 'approve';
      const count = report.approvals.length;
      const entries = await prompt(
        rules +
          'Run a shell command that writes the text approved to approved-marker.txt. Do not use a file editing tool.',
      );
      assert.equal((await readFile(join(cwd, 'approved-marker.txt'), 'utf8')).trim(), 'approved');
      assert.ok(
        report.approvals
          .slice(count)
          .some(
            (item: Wire) =>
              item.selected &&
              item.choices.find((choice: Wire) => choice.optionId === item.selected)?.kind ===
                'allow_once',
          ),
        'A real approval must be observed.',
      );
      return entries;
    });
    await step('reject', async () => {
      report.phase = 'reject';
      const count = report.approvals.length;
      const entries = await prompt(
        rules +
          'Attempt once to run a shell command writing rejected-marker.txt. If denied, stop without retrying or using another tool.',
        'reject',
      );
      assert.ok(!(await exists(join(cwd, 'rejected-marker.txt'))));
      assert.ok(
        report.approvals
          .slice(count)
          .some(
            (item: Wire) =>
              item.choices.find((choice: Wire) => choice.optionId === item.selected)?.kind ===
              'reject_once',
          ),
        'A real rejection must be observed.',
      );
      return entries;
    });
    await step('cancel underlying command', async () => {
      report.phase = 'cancel';
      const entries = await prompt(
        rules +
          `Run "${process.execPath}" delayed.cjs in the foreground. Wait for it; do not modify files yourself.`,
        'allow',
        () => exists(join(cwd, 'command-started.txt')),
      );
      assert.ok(
        await exists(join(cwd, 'command-started.txt')),
        'The command must have actually started.',
      );
      await sleep(35000);
      assert.ok(
        !(await exists(join(cwd, 'late-marker.txt'))),
        'Cancellation left the underlying command running.',
      );
      assert.equal((await call<Permission[]>('permissions')).length, 0);
      return entries;
    });
    const phrase = `LIVE_CONTEXT_${randomUUID()}`;
    await step('restart and model context resume', async () => {
      report.phase = 'resume';
      await prompt(
        rules +
          `Remember this distinctive phrase for the next turn: ${phrase}. Reply only remembered.`,
      );
      const saved = await active();
      const ids = saved.entries.map((entry) => entry.id);
      await close();
      await launch();
      const entries = await prompt(
        rules + 'What was the distinctive phrase I asked you to remember? Reply with it verbatim.',
      );
      assert.equal((await active()).sessionId, saved.sessionId);
      assert.deepEqual(
        (await active()).entries.slice(0, ids.length).map((entry) => entry.id),
        ids,
      );
      assert.ok(
        entries
          .filter((entry) => entry.type === 'assistant')
          .some((entry) => entry.text.includes(phrase)),
      );
      return { sessionId: saved.sessionId, entries };
    });
    await step('model and effort switches', async () => {
      report.phase = 'config';
      const controls = (await active()).session?.configOptions ?? [];
      const evidence = [];
      for (const control of controls) {
        const options = control.options.flatMap((option: Wire) => option.options ?? [option]);
        const next = options.find((option: Wire) => option.value !== control.currentValue);
        if (!next) continue;
        await call('agent:config', { id: 'live-chat', configId: control.id, value: next.value });
        assert.equal(
          (await active()).session?.configOptions?.find((item: Wire) => item.id === control.id)
            ?.currentValue,
          next.value,
        );
        evidence.push({
          id: control.id,
          value: next.value,
          entries: await prompt(rules + 'Reply only SWITCH_OK.'),
        });
        await call('agent:config', {
          id: 'live-chat',
          configId: control.id,
          value: control.currentValue,
        });
      }
      report.results.push({
        name: 'mode switch',
        status: 'unavailable',
        reason: 'No ACP modes advertised by this authenticated runtime.',
      });
      if ((await active()).session?.modes?.availableModes?.length)
        throw new Error('Advertised modes require a separate switch check.');
      return evidence;
    });
    await step('model-backed MCP call', async () => {
      report.phase = 'mcp';
      const log = join(root, 'mcp-calls.log');
      await call('mcp:add', {
        id: 'live-chat',
        name: serverName,
        scope: 'user',
        transport: 'stdio',
        command: process.execPath,
        args: [resolve('tests/fixtures/mcp.mjs')],
        env: [`MCP_FIXTURE_LOG=${log}`],
      });
      mcpAdded = true;
      const doctor = await call('mcp:doctor', { id: 'live-chat', name: serverName });
      assert.equal(doctor.healthy_count, 1);
      const entries = await prompt(
        rules +
          `Invoke the ${serverName} MCP server's say_hello tool exactly once and report its actual result. It is a known local acceptance server.`,
      );
      assert.ok(
        (await readFile(log, 'utf8')).split('\n').includes('tools/call'),
        'Discovery alone is insufficient.',
      );
      assert.ok(
        entries.some(
          (entry) =>
            entry.type === 'tool' && JSON.stringify(entry.data).includes('HELLO_FROM_MCP_FIXTURE'),
        ),
      );
      return { doctor, entries };
    });
    report.final = {
      status: git(['status', '--short']),
      diff: git(['diff']),
      pendingApprovals: (await call<Permission[]>('permissions')).length,
    };
  } finally {
    if (browser) {
      await call('agent:cancel', { id: 'live-chat' }).catch(() => {});
      if (mcpAdded)
        await call('mcp:change', {
          id: 'live-chat',
          name: serverName,
          scope: 'user',
          operation: 'remove',
        }).catch((error) => {
          report.cleanupError = String(error);
        });
      await close().catch(() => {});
    }
    if (child?.pid && child.exitCode === null)
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    report.finishedAt = new Date().toISOString();
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`LIVE_REPORT ${join(root, 'report.json')}`);
    if (report.cleanupError || report.results.some((result: Wire) => result.status === 'fail'))
      process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
