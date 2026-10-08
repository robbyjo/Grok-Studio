import { chromium, type Browser } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, writeFile, rename, readFile } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

async function main() {
  const meta = JSON.parse(await readFile('package.json', 'utf8'));
  const inputIndex = process.argv.indexOf('--exe');
  const sourceExecutable =
    inputIndex < 0
      ? resolve('release', `Grok-Workbench-${meta.version}-Portable.exe`)
      : resolve(process.argv[inputIndex + 1]);
  const executableName = basename(sourceExecutable);
  await mkdir('.test-data', { recursive: true });
  const root = await mkdtemp(resolve('.test-data/portable-'));
  const first = join(root, 'Portable location with spaces');
  const second = join(root, 'Relocated portable app');
  const extraction = await mkdtemp(join(tmpdir(), 'Grok Workbench extraction '));
  const extractionAlias = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:GROK_STUDIO_TEST_EXTRACTION).ShortPath',
    ],
    {
      env: { ...process.env, GROK_STUDIO_TEST_EXTRACTION: extraction },
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(first, 'Grok Desktop Data'), { recursive: true });
  await copyFile(sourceExecutable, join(first, executableName));
  const now = new Date().toISOString();
  await writeFile(
    join(first, 'Grok Desktop Data/state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'Portable fixture', path: project }],
      settings: { executable: 'embedded' },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'Portable fixture',
          cwd: project,
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
  const env = { ...process.env, XAI_API_KEY: '', GROK_DEPLOYMENT_KEY: '' };
  delete env.GROK_HOME;
  delete env.GROK_DESKTOP_DATA_DIR;
  delete env.PORTABLE_EXECUTABLE_DIR;
  let child: ChildProcess | undefined, browser: Browser | undefined;
  for (const location of [first, second]) {
    const portServer = createServer();
    await new Promise<void>((done) => portServer.listen(0, '127.0.0.1', done));
    const port = (portServer.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((done) => portServer.close(() => done()));
    let exited = false;
    const launchEnv = { ...env };
    // Preserve the normal temp path first, then exercise a Windows 8.3 path on
    // relocation (where the volume supports short filenames).
    if (location === second) {
      launchEnv.TEMP = extractionAlias;
      launchEnv.TMP = extractionAlias;
    }
    child = spawn(join(location, executableName), [`--remote-debugging-port=${port}`], {
      cwd: location,
      env: launchEnv,
      windowsHide: true,
      stdio: 'ignore',
    });
    const completed = new Promise<void>((done) =>
      child!.once('exit', () => {
        exited = true;
        done();
      }),
    );
    try {
      const deadline = Date.now() + 60000;
      while (true) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`);
          if (response.ok) break;
        } catch {}
        if (exited || Date.now() > deadline)
          throw new Error('Portable launcher did not expose its application window.');
        await new Promise((done) => setTimeout(done, 300));
      }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = browser.contexts()[0].pages()[0];
      await page.waitForFunction(() => Boolean(window.desktop));
      const info = await page.evaluate(() => window.desktop.call('runtime:info'));
      assert.equal(info.portable, true);
      assert.equal(info.dataDirectory, join(location, 'Grok Desktop Data'));
      assert.equal(info.sessionDirectory, join(location, 'Grok Desktop Data'));
      assert.equal(info.grokHome, join(location, 'Grok Desktop Data', 'grok'));
      assert.equal(
        createHash('sha256')
          .update(await readFile(info.executable))
          .digest('hex'),
        JSON.parse(await readFile('.runtime/engine.json', 'utf8')).sha256,
      );
      const state = await page.evaluate(() => window.desktop.call('state'));
      assert.equal(state.settings.executable, 'embedded');
      if (location === first) {
        await page.evaluate((input) => window.desktop.call('mcp:add', input), {
          id: 't',
          name: 'portablefixture',
          scope: 'user',
          transport: 'stdio',
          command: process.execPath,
          args: [resolve('tests/fixtures/mcp.mjs')],
        });
        const report = await page.evaluate(() =>
          window.desktop.call('mcp:doctor', { id: 't', name: 'portablefixture' }),
        );
        assert.equal(report.healthy_count, 1);
        await page.evaluate(() =>
          window.desktop.call('thread:edit', {
            id: 't',
            title: 'Portable persisted',
            pinned: true,
          }),
        );
        await page.evaluate(() => window.desktop.call('terminal:open', { id: 't' }));
        await page.evaluate(() =>
          window.desktop.call('terminal:write', {
            id: 't',
            data: "Write-Output ('PORTABLE_' + (40 + 2))\r",
          }),
        );
        await page.waitForFunction(
          async () =>
            (await window.desktop.call('terminal:open', { id: 't' })).buffer.includes(
              'PORTABLE_42',
            ),
          undefined,
          { timeout: 15000 },
        );
        const embedded = await page.evaluate(() => window.desktop.call('runtime:info'));
        assert.ok(embedded.executable.endsWith('studio-engine.node'));
        await page.screenshot({ path: '.test-data/portable-launch.png' });
      } else {
        assert.equal(state.threads[0].title, 'Portable persisted');
        assert.equal(state.threads[0].pinned, true);
        const servers = await page.evaluate(() => window.desktop.call('mcp:list', { id: 't' }));
        assert.ok(servers.some((server: any) => server.name === 'portablefixture'));
        const report = await page.evaluate(() =>
          window.desktop.call('mcp:doctor', { id: 't', name: 'portablefixture' }),
        );
        assert.equal(report.healthy_count, 1);
      }
      await page.close();
      await browser.close();
      browser = undefined;
      await Promise.race([
        completed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Portable application did not quit.')), 15000),
        ),
      ]);
      console.log(
        location === first
          ? 'PORTABLE_LAUNCH_RUNTIME_MCP_TERMINAL_OK'
          : 'PORTABLE_RELOCATION_PROFILE_PERSISTENCE_OK',
      );
      child = undefined;
    } finally {
      await browser?.close();
      browser = undefined;
      if (child && !exited && child.pid)
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
    if (location === first) {
      // Verify both absolute directory targets stay in this isolated workspace fixture.
      for (const target of [first, second]) assert.ok(resolve(target).startsWith(root + sep));
      await rename(first, second);
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
