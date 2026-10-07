import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { Mcp, addArguments } from '../electron/mcp';
import { desktopDataDirectory } from '../electron/runtime';

test('portable directory routing and overrides do not depend on extraction path', () => {
  assert.equal(
    desktopDataDirectory({ PORTABLE_EXECUTABLE_DIR: 'E:\\Portable App' }),
    join('E:\\Portable App', 'Grok Desktop Data'),
  );
  assert.equal(
    desktopDataDirectory({
      PORTABLE_EXECUTABLE_DIR: 'E:\\Portable App',
      GROK_DESKTOP_DATA_DIR: 'E:\\Isolated',
    }),
    'E:\\Isolated',
  );
  assert.equal(desktopDataDirectory({}), undefined);
});
test('MCP configuration keeps command arguments literal and validates transport and scope', () => {
  assert.deepEqual(
    addArguments({
      name: 'fixture',
      scope: 'project',
      transport: 'stdio',
      command: 'C:\\space path\\node.exe',
      args: ['a b', '$(literal)', '`literal`'],
      env: ['TOKEN=${API_TOKEN}'],
    }),
    [
      'mcp',
      'add',
      '--scope',
      'project',
      '--transport',
      'stdio',
      'fixture',
      '-e',
      'TOKEN=${API_TOKEN}',
      '--',
      'C:\\space path\\node.exe',
      'a b',
      '$(literal)',
      '`literal`',
    ],
  );
  for (const name of ['--evil', 'bad__name', 'bad_', 'has space'])
    assert.throws(() => addArguments({ name, scope: 'user', transport: 'stdio', command: 'node' }));
  assert.throws(() =>
    addArguments({ name: 'fixture', scope: 'invalid', transport: 'stdio', command: 'node' }),
  );
  assert.throws(() =>
    addArguments({ name: 'fixture', scope: 'user', transport: 'http', url: 'file:///secret' }),
  );
  assert.throws(() =>
    addArguments({
      name: 'fixture',
      scope: 'user',
      transport: 'http',
      url: 'https://user:pass@example.invalid',
    }),
  );
});

test(
  'official Grok MCP: STDIO/HTTP/SSE handshake, tool discovery, config lifecycle and failed diagnostics',
  { skip: !existsSync(resolve('.runtime/grok.exe')), timeout: 120_000 },
  async () => {
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/mcp-'));
    const project = join(root, 'project with spaces');
    await mkdir(project);
    const home = join(root, 'home');
    await mkdir(home);
    const log = join(root, 'stdio.log');
    const mcp = new Mcp(() => resolve('.runtime/grok.exe'), {
      ...process.env,
      GROK_HOME: home,
      XAI_API_KEY: '',
      GROK_DEPLOYMENT_KEY: '',
    });
    const methods: string[] = [];
    const { response } = await import('./fixtures/mcp.mjs' as string);
    let sse: import('node:http').ServerResponse | undefined;
    const http = createServer(async (request, reply) => {
      if (request.method === 'GET' && request.url === '/sse') {
        reply.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        sse = reply;
        reply.write('event: endpoint\ndata: /message\n\n');
        return;
      }
      if (request.method !== 'POST') {
        reply.writeHead(405).end();
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      const result = response(message, (method: string) => methods.push(method));
      if (request.url === '/message') {
        reply.writeHead(202).end();
        if (result) sse?.write('event: message\ndata: ' + JSON.stringify(result) + '\n\n');
      } else if (!result) reply.writeHead(202).end();
      else reply.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(http.address() as import('node:net').AddressInfo).port}`;
    try {
      await mcp.add(project, {
        name: 'fixture',
        scope: 'user',
        transport: 'stdio',
        command: process.execPath,
        args: [resolve('tests/fixtures/mcp.mjs')],
        env: [`MCP_FIXTURE_LOG=${log}`, 'TEST_SECRET=do-not-send-to-renderer'],
      });
      let inventory = await mcp.list(project);
      assert.equal(inventory[0].scope, 'user');
      assert.equal(inventory[0].enabled, true);
      assert.ok(!JSON.stringify(inventory).includes('do-not-send-to-renderer'));
      const report = await mcp.doctor(project, { name: 'fixture' });
      assert.equal(report.healthy_count, 1, JSON.stringify(report));
      assert.match(await readFile(log, 'utf8'), /initialize/);
      assert.match(await readFile(log, 'utf8'), /tools\/list/);
      await mcp.add(project, {
        name: 'projectfixture',
        scope: 'project',
        transport: 'stdio',
        command: process.execPath,
        args: [resolve('tests/fixtures/mcp.mjs')],
      });
      const untrusted = await mcp.doctor(project, { name: 'projectfixture' });
      assert.equal(untrusted.failing_count, 1);
      assert.equal(untrusted.servers[0].checks[0].label, 'folder untrusted');
      const trusted = await mcp.run(
        project,
        ['--trust', 'mcp', 'doctor', '--json', 'projectfixture'],
        true,
      );
      assert.equal(trusted.healthy_count, 1, JSON.stringify(trusted));
      await assert.rejects(
        mcp.add(project, { name: 'fixture', scope: 'user', transport: 'stdio', command: 'node' }),
        /already exists/,
      );
      await mcp.change(project, 'disable', { name: 'fixture' });
      inventory = await mcp.list(project);
      assert.equal(inventory[0].enabled, false);
      await mcp.change(project, 'enable', { name: 'fixture' });
      assert.equal((await mcp.list(project))[0].enabled, true);
      for (const transport of ['http', 'sse']) {
        await mcp.add(project, {
          name: transport,
          scope: 'user',
          transport,
          url: url + (transport === 'http' ? '/mcp' : '/sse'),
        });
        const remote = await mcp.doctor(project, { name: transport });
        assert.equal(remote.healthy_count, 1, JSON.stringify(remote));
        assert.ok(methods.includes('initialize'));
        assert.ok(methods.includes('tools/list'));
        await mcp.change(project, 'remove', { name: transport, scope: 'user' });
      }
      await mcp.add(project, {
        name: 'broken',
        scope: 'user',
        transport: 'stdio',
        command: join(root, 'missing.exe'),
      });
      const broken = await mcp.doctor(project, { name: 'broken' });
      assert.equal(broken.failing_count, 1);
      assert.equal(broken.servers[0].healthy, false);
      await mcp.change(project, 'remove', { name: 'fixture', scope: 'user' });
      assert.ok(!(await mcp.list(project)).some((item) => item.name === 'fixture'));
    } finally {
      mcp.shutdown();
      sse?.end();
      http.closeAllConnections();
      await new Promise<void>((done) => http.close(() => done()));
    }
  },
);
