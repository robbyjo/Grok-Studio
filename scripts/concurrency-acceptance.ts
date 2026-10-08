import { Agents } from '../electron/agent';
import { Store } from '../electron/store';
import { EmbeddedRpc } from '../electron/embedded-rpc';
import { embeddedEngine } from '../electron/runtime';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run for eight real billable OAuth prompts.');
  mkdirSync('.test-data', { recursive: true });
  const home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok'),
    root = mkdtempSync(resolve('.test-data/live-concurrency-')),
    cwd = join(root, 'repository');
  mkdirSync(cwd);
  execFileSync('git', ['init', '-b', 'main'], { cwd, windowsHide: true });
  mkdirSync(join(cwd, '.grok'));
  writeFileSync(join(cwd, '.grok/config.toml'), '[permission]\nask=["Bash(*)", "Edit"]\n');
  const store = new Store(join(root, 'desktop/state.json')),
    project = store.openProject(cwd, 'Disposable concurrency acceptance'),
    threads = Array.from({ length: 8 }, () => store.create(project.id, cwd));
  let peakRunning = 0,
    pendingTurns = 0,
    rejectedTools = 0;
  const agents = new Agents(
    store,
    () => {
      peakRunning = Math.max(peakRunning, threads.filter((t) => t.status === 'running').length);
    },
    (path) => {
      const rpc = new EmbeddedRpc(
        embeddedEngine(),
        path,
        { ...process.env, GROK_HOME: home, XAI_API_KEY: undefined, GROK_DEPLOYMENT_KEY: undefined },
        'oauth',
      );
      const request = rpc.request.bind(rpc);
      rpc.request = async (method, params, timeout) => {
        if (method !== 'session/prompt') return request(method, params, timeout);
        pendingTurns++;
        peakRunning = Math.max(peakRunning, pendingTurns);
        try {
          return await request(method, params, timeout);
        } finally {
          pendingTurns--;
        }
      };
      return rpc;
    },
  );
  const permissions = setInterval(() => {
    for (const p of agents.permissionsSnapshot()) {
      if (p.kind === 'trust') agents.approve(p.id, 'trust');
      else {
        rejectedTools++;
        agents.approve(p.id, p.options.find((o) => o.kind === 'reject_once')?.optionId);
      }
    }
  }, 100);
  const started = Date.now();
  const deadline = setTimeout(() => {
    console.error('Live concurrency deadline exceeded.');
    agents.shutdown();
  }, 180000);
  try {
    await Promise.all(threads.map((t) => agents.connect(t.id)));
    assert.ok(threads.every((t) => t.status === 'idle'));
    const results = await Promise.allSettled(
      threads.map((t, i) =>
        agents.prompt(
          t.id,
          `Use no tools, network, files, or subagents. Reply exactly WORKBENCH_CONCURRENT_${i}_OK.`,
          [],
        ),
      ),
    );
    assert.ok(
      results.every((r) => r.status === 'fulfilled'),
      JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))),
    );
    assert.equal(peakRunning, 8, 'Eight real turns must overlap.');
    assert.equal(new Set(threads.map((t) => t.sessionId)).size, 8);
    assert.ok(
      threads.every((t, i) =>
        store
          .fullHistory(t.id)
          .some((e) => e.type === 'assistant' && e.text.includes(`WORKBENCH_CONCURRENT_${i}_OK`)),
      ),
    );
    const report = {
      testedAt: new Date().toISOString(),
      root,
      durationMs: Date.now() - started,
      sessions: threads.map((t) => t.sessionId),
      realSessions: 8,
      peakRunning,
      rejectedTools,
      outcome: 'pass',
      scope: 'Eight overlapping real model turns; separate storage soak uses simulated streams.',
    };
    writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(permissions);
    clearTimeout(deadline);
    await agents.shutdownAndWait();
    store.flush();
    store.history.db.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
