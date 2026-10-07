import { Agents } from '../electron/agent';
import { Store } from '../electron/store';
import { RpcProcess } from '../electron/rpc';
import { EmbeddedRpc } from '../electron/embedded-rpc';
import { embeddedEngine } from '../electron/runtime';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to send real billable acceptance prompts.');
  const home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok');
  const root = mkdtempSync(resolve('.test-data/live-tasks-')),
    cwd = join(root, 'repository');
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.grok'));
  writeFileSync(join(cwd, '.grok/config.toml'), '[permission]\nask=["Bash(*)", "Edit"]\n');
  writeFileSync(
    join(cwd, 'wait.cjs'),
    "console.log('BOUNDED_TASK_STARTED'); setTimeout(()=>console.log('BOUNDED_TASK_FINISHED'),120000);\n",
  );
  writeFileSync(join(cwd, 'readme.txt'), 'DISPOSABLE_SUBAGENT_READ_OK\n');
  const store = new Store(join(root, 'desktop/state.json')),
    p = store.openProject(cwd, 'Task acceptance'),
    t = store.create(p.id, cwd);
  const agents = new Agents(
    store,
    () => {},
    (path) =>
      process.env.GROK_STUDIO_ENGINE === 'cli'
        ? new RpcProcess(resolve('.runtime/grok.exe'), ['agent', '--no-leader', 'stdio'], path, {
            ...process.env,
            GROK_HOME: home,
          })
        : new EmbeddedRpc(embeddedEngine(), path, { ...process.env, GROK_HOME: home }, 'oauth'),
  );
  const results: any[] = [];
  const permissions = setInterval(() => {
    for (const permission of agents.permissionsSnapshot()) {
      if (permission.kind === 'trust') agents.approve(permission.id, 'trust');
      else {
        const raw = JSON.stringify(permission.toolCall);
        if (!/wait\.cjs|readme\.txt|Start-Sleep|sleep|node/i.test(raw))
          agents.approve(
            permission.id,
            permission.options.find((o) => o.kind === 'reject_once')?.optionId,
          );
        else
          agents.approve(
            permission.id,
            permission.options.find((o) => o.kind === 'allow_once')?.optionId,
          );
      }
    }
  }, 100);
  async function waitUntil(check: () => boolean, ms = 180000) {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await delay(100);
    assert.ok(check(), 'Acceptance condition timed out');
  }
  try {
    await agents.connect(t.id);
    await waitUntil(() => t.status === 'idle');
    if (!process.argv.includes('--subagent-only')) {
      let done = false,
        failure: unknown;
      const first = agents
        .prompt(
          t.id,
          `Work only in this disposable folder. Use the Bash tool to run the existing wait.cjs using the installed node command in the background (run_in_background true). Do not write files, contact network, or launch subagents. After starting it, do one foreground shell sleep for 8 seconds to give the desktop steering test time to run, then reply TASK_STARTED.`,
          [],
        )
        .then(
          () => {
            done = true;
          },
          (e) => {
            done = true;
            failure = e;
          },
        );
      await waitUntil(() => t.status === 'running');
      agents.queue(t.id, 'Do not use tools. Reply exactly QUEUE_FIRST_OK.');
      agents.queue(t.id, 'Do not use tools. Reply exactly QUEUE_SECOND_OK.');
      const steering = await agents.steer(
        t.id,
        'Keep the requested background command running. End your reply with STEERING_ACCEPTED_OK.',
      );
      results.push({ name: 'real native steering acknowledgement', response: steering });
      await waitUntil(() => done);
      await first;
      if (failure) throw failure;
      await waitUntil(() => !t.queue?.length && t.status === 'idle');
      const user = store
        .fullHistory(t.id)
        .filter((e) => e.type === 'user')
        .map((e) => e.text);
      assert.ok(
        user.indexOf('Do not use tools. Reply exactly QUEUE_FIRST_OK.') <
          user.indexOf('Do not use tools. Reply exactly QUEUE_SECOND_OK.'),
      );
      assert.ok(
        store
          .fullHistory(t.id)
          .some((e) => e.type === 'assistant' && e.text.includes('QUEUE_SECOND_OK')),
      );
      results.push({ name: 'two real queued prompts executed serially', status: 'pass' });
      const report = await agents.dashboard(t.id);
      assert.deepEqual(report.errors, {});
      assert.ok(typeof report.usage?.inputTokens === 'number');
      results.push({
        name: 'native task/subagent inventory and process usage',
        status: 'pass',
        tasks: report.tasks,
        usage: report.usage,
        context: t.runtimeStatus?.context_window,
      });
      const task = report.tasks.find((r: any) => r.status === 'running');
      if (task)
        results.push({
          name: 'real owned background kill',
          response: await agents.taskControl(t.id, 'kill', task.task_id),
        });
      else
        results.push({
          name: 'real background kill',
          status: 'open',
          reason: 'No still-running task was reported after queued prompts.',
        });
      await assert.rejects(agents.taskControl(t.id, 'kill', 'foreign-task-id'), /not owned/);
    }
    // A user-requested application feature acceptance; the native Grok runtime owns this child.
    let childDone = false;
    const childTurn = agents
      .prompt(
        t.id,
        'Use spawn_subagent with background true, agent general-purpose, and description Disposable acceptance child. Give it this prompt: work only in the current folder, use run_terminal_command for Start-Sleep -Seconds 60, then read readme.txt, report its content, and change nothing. Do not create workflows, run network commands, or search for tool definitions. Immediately reply CHILD_STARTED after starting the child. If spawn_subagent is unavailable, say SUBAGENT_TOOL_UNAVAILABLE and use no other tools.',
        [],
      )
      .finally(() => {
        childDone = true;
      });
    let child: any;
    const end = Date.now() + 90000;
    while (!child && Date.now() < end) {
      await delay(500);
      const roster = await agents.dashboard(t.id);
      child = roster.subagents.find((r: any) => r.status === 'running');
    }
    if (child) {
      const inspected = await agents.taskControl(t.id, 'inspect-subagent', child.subagent_id);
      const cancelled = await agents.taskControl(t.id, 'cancel-subagent', child.subagent_id);
      results.push({
        name: 'real native subagent inspect/cancel',
        status: 'pass',
        id: child.subagent_id,
        inspected: Boolean(inspected),
        cancelled,
      });
    } else
      results.push({
        name: 'real subagent inspect/cancel',
        status: 'open',
        reason: 'Model did not expose a running background child.',
      });
    await childTurn;
    writeFileSync(join(root, 'result.json'), JSON.stringify({ root, results }, null, 2));
    console.log(JSON.stringify({ root, results }, null, 2));
  } finally {
    clearInterval(permissions);
    await agents.shutdownAndWait();
    store.flush();
    store.history.db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
