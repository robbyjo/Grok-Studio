import { chromium, type Browser } from '@playwright/test';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
async function main() {
  if (!process.argv.includes('--run'))
    throw new Error(
      'Pass --run to send one real model prompt and open GitHub OAuth authorization.',
    );
  const home = resolve(process.env.GROK_STUDIO_NATIVE_HOME ?? 'release/Grok Desktop Data/grok');
  const root = await mkdtemp(resolve('.test-data/github-oauth-')),
    data = join(root, 'desktop'),
    cwd = join(root, 'repository');
  await mkdir(data);
  await mkdir(cwd);
  const now = new Date().toISOString();
  await writeFile(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [{ id: 'p', name: 'GitHub OAuth acceptance', path: cwd }],
      settings: { executable: resolve('.runtime/grok.exe') },
      threads: [
        {
          id: 't',
          projectId: 'p',
          title: 'GitHub OAuth',
          cwd,
          status: 'idle',
          archived: false,
          pinned: false,
          entries: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }),
  );
  const port = 19000 + Math.floor(Math.random() * 1000),
    child = spawn(
      resolve('node_modules/electron/dist/electron.exe'),
      ['.', `--remote-debugging-port=${port}`],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          GROK_HOME: home,
          GROK_DESKTOP_DATA_DIR: data,
          GITHUB_PERSONAL_ACCESS_TOKEN: '',
        },
        windowsHide: true,
        stdio: 'ignore',
      },
    );
  let browser: Browser | undefined;
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
      } catch {}
      await new Promise((done) => setTimeout(done, 250));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => !!window.desktop);
    const call = (method: string, input: any = {}) =>
      page.evaluate(({ method, input }) => window.desktop.call(method, input), { method, input });
    const servers = await call('mcp:list', { id: 't' });
    if (!servers.some((server: any) => server.name === 'github-oauth'))
      await call('mcp:add', {
        id: 't',
        name: 'github-oauth',
        scope: 'user',
        transport: 'stdio',
        command: 'github-mcp-server.exe',
        args: ['stdio', '--read-only', '--toolsets', 'context', '--oauth-scopes', 'read:user'],
        env: ['GITHUB_PERSONAL_ACCESS_TOKEN='],
      });
    await call('agent:connect', { id: 't' });
    await call('agent:prompt', {
      id: 't',
      text: 'Do not use tools or modify files. Reply only READY.',
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const integrations = settings.locator('.mcp-settings').filter({
      has: page.getByRole('heading', { name: 'Effective runtime integrations', exact: true }),
    });
    await integrations.getByRole('button', { name: 'Load effective catalog', exact: true }).click();
    let verified = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await call('integration:action', {
        id: 't',
        kind: 'mcp',
        operation: 'sign-in',
        name: 'github-oauth',
      });
      const content =
        result.content
          ?.filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
          .join('\n') ?? '';
      let identity;
      try {
        identity = JSON.parse(content);
      } catch {}
      if (!result.isError && identity?.login) {
        verified = true;
        break;
      }
      if (attempt === 0) console.log('GITHUB_OAUTH_BROWSER_AUTHORIZATION_NEEDED');
      await new Promise((done) => setTimeout(done, 5000));
    }
    if (!verified) throw new Error('GitHub authorization did not complete in ten minutes.');
    await integrations
      .getByRole('button', { name: 'Sign in / verify identity', exact: true })
      .click();
    const nativeResult = integrations
      .locator('details')
      .filter({ has: page.getByText('Native result', { exact: true }) })
      .locator('pre');
    await nativeResult.waitFor();
    const guiResponse = JSON.parse(await nativeResult.innerText());
    const guiText = guiResponse.content
      ?.filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
    if (guiResponse.isError || !JSON.parse(guiText).login)
      throw new Error('GUI did not return an authenticated GitHub identity.');
    await integrations
      .getByRole('button', { name: 'Clear GitHub connection', exact: true })
      .click();
    await integrations
      .getByRole('button', { name: 'Confirm credential logout', exact: true })
      .click();
    await page.waitForFunction(() => document.body.textContent?.includes('"memoryCleared": true'));
    await writeFile(
      join(root, 'report.json'),
      JSON.stringify(
        {
          provider: 'official GitHub MCP v2.0.1 STDIO',
          oauth: true,
          readOnly: true,
          identityVerified: true,
          guiVerification: true,
          connectionCleared: true,
        },
        null,
        2,
      ),
    );
    console.log('GITHUB_OAUTH_IDENTITY_PASS', join(root, 'report.json'));
    await page.close();
    await browser.close();
    browser = undefined;
  } finally {
    await browser?.close().catch(() => {});
    if (child.exitCode === null) child.kill();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
