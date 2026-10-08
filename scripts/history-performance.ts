import { Store } from '../electron/store';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

async function main() {
  const durationIndex = process.argv.indexOf('--hours');
  const durationMs = durationIndex < 0 ? 60000 : Number(process.argv[durationIndex + 1]) * 3600000;
  assert.ok(Number.isFinite(durationMs) && durationMs >= 1000 && durationMs <= 86400000);
  mkdirSync('.test-data', { recursive: true });
  const root = mkdtempSync(resolve('.test-data/history-performance-'));
  const store = new Store(join(root, 'state.json'));
  const project = store.openProject(root, 'Sustained history');
  const start = performance.now();
  for (let i = 0; i < 500; i++) {
    store.state.threads.push({
      id: `t${i}`,
      projectId: project.id,
      cwd: root,
      title: `History ${i}`,
      status: 'idle',
      archived: false,
      pinned: false,
      createdAt: '2026-10-07',
      updatedAt: '2026-10-07',
      entries: Array.from({ length: 200 }, (_, n) => ({
        id: `e${i}-${n}`,
        type: 'assistant',
        text: `PERF_NEEDLE ${i} ${n} ${'ordinary content '.repeat(30)}`,
      })),
    });
  }
  store.flush();
  store.selected = 't0';
  const seedMs = performance.now() - start;
  assert.equal(store.history.stats().entries, 100000);
  const searchMs: number[] = [],
    flushMs: number[] = [];
  const began = performance.now();
  let cycles = 0;
  let peakRssBytes = process.memoryUsage().rss;
  while (performance.now() - began < durationMs) {
    const ts = performance.now();
    const result = await store.search('PERF_NEEDLE', {
      archived: true,
      hidden: true,
      offset: (cycles % 10) * 100,
    });
    searchMs.push(performance.now() - ts);
    assert.equal(result.hits.length, 100);
    const fs = performance.now();
    for (let j = 0; j < 8; j++)
      store.update(
        `t${j}`,
        { sessionUpdate: 'agent_message_chunk', content: { text: 'stream chunk ' } },
        `turn${Math.floor(cycles / 100)}`,
      );
    store.flush();
    flushMs.push(performance.now() - fs);
    assert.ok(store.cacheStats().chats <= 8);
    assert.ok(store.cacheStats().entries <= 1600);
    assert.ok(Buffer.byteLength(JSON.stringify(store.snapshot())) < 1024 * 1024);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    assert.ok(peakRssBytes < 1024 * 1024 * 1024, 'Storage soak exceeded 1 GiB RSS.');
    // Bound the measurement buffers as well as the application's history cache.
    if (searchMs.length > 4096) searchMs.shift();
    if (flushMs.length > 4096) flushMs.shift();
    cycles++;
    if (cycles % 100 === 0)
      console.log(JSON.stringify({ cycles, elapsedMs: performance.now() - began, root }));
    await new Promise((r) => setTimeout(r, 30));
  }
  const percentile = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)];
  const report = {
    root,
    seedChats: 500,
    seedEntries: 100000,
    seedMs,
    durationMs: performance.now() - began,
    cycles,
    simulatedConcurrentChats: 8,
    searchP95Ms: percentile(searchMs),
    flushP95Ms: percentile(flushMs),
    maxFlushMs: Math.max(...flushMs),
    cache: store.cacheStats(),
    storage: store.history.stats(),
    rssBytes: process.memoryUsage().rss,
    peakRssBytes,
    requestedDurationMs: durationMs,
    measurementWindow: 'latest 4096 cycles',
  };
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  store.cancelSearch();
  store.history.db.close();
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
