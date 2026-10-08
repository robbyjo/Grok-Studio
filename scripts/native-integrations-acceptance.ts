import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Agents } from '../electron/agent';
import { Integrations } from '../electron/integrations';
import { Store } from '../electron/store';
import { RpcProcess } from '../electron/rpc';
import { EmbeddedRpc } from '../electron/embedded-rpc';
import { embeddedEngine } from '../electron/runtime';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
test(
  'real authenticated Grok isolated skill/plugin/hook lifecycle',
  { timeout: 120000 },
  async () => {
    if (!process.env.GROK_STUDIO_NATIVE_HOME)
      throw new Error(
        'Set GROK_STUDIO_NATIVE_HOME to the explicitly selected local acceptance profile. A temporary local auth copy is deleted after this run.',
      );
    await mkdir('.test-data', { recursive: true });
    const root = await mkdtemp(resolve('.test-data/native-integrations-'));
    const repo = join(root, 'repository'),
      cwd = join(repo, 'project'),
      home = join(root, 'grok'),
      skill = join(root, 'skill-source'),
      plugin = join(root, 'plugin-source'),
      hooks = join(home, 'hook-source');
    await mkdir(repo);
    for (const path of [cwd, home, skill, plugin, hooks]) await mkdir(path);
    await execute('git', ['init', '-b', 'main'], { cwd: repo, windowsHide: true });
    await writeFile(join(repo, 'AGENTS.md'), 'WORKBENCH_ROOT_INSTRUCTION');
    await writeFile(join(cwd, 'AGENTS.md'), 'WORKBENCH_CHILD_INSTRUCTION');
    await writeFile(join(home, 'AGENTS.md'), 'WORKBENCH_HOME_INSTRUCTION');
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: studio-fixture\ndescription: Disposable skill lifecycle acceptance.\n---\nReply HELLO when explicitly invoked.\n',
    );
    await writeFile(
      join(plugin, 'plugin.json'),
      JSON.stringify({
        name: 'studio-plugin-fixture',
        version: '1.0.0',
        description: 'Disposable native lifecycle fixture',
      }),
    );
    const pluginGit = (args: string[]) => execute('git', args, { cwd: plugin, windowsHide: true });
    await pluginGit(['init', '-b', 'main']);
    await pluginGit(['config', 'user.name', 'Fixture']);
    await pluginGit(['config', 'user.email', 'fixture@example.invalid']);
    await pluginGit(['add', '.']);
    await pluginGit(['commit', '-m', 'Plugin baseline']);
    const hookMarker = join(root, 'hook-ran.txt'),
      hookScript = join(hooks, 'fixture.cjs');
    await writeFile(
      hookScript,
      `require('node:fs').writeFileSync(${JSON.stringify(hookMarker)},'HOOK_EXECUTED');`,
    );
    await writeFile(
      join(home, 'config.toml'),
      `[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([resolve('tests/fixtures/mcp.mjs')])}\n[[mcp_servers.fixture.setup.fields]]\nid="variant"\nlabel="Fixture variant"\ntype="select"\nrequired=true\n[[mcp_servers.fixture.setup.fields.options]]\nvalue="fixture"\nlabel="Fixture"\n`,
    );
    await writeFile(
      join(hooks, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" "${hookScript}"`,
                  timeout: 5,
                },
              ],
            },
          ],
        },
      }),
    );
    const store = new Store(join(root, 'desktop/state.json'));
    const project = store.openProject(cwd, 'Native fixtures'),
      thread = store.create(project.id, cwd);
    const authPath = join(home, 'auth.json');
    await copyFile(join(resolve(process.env.GROK_STUDIO_NATIVE_HOME), 'auth.json'), authPath);
    const agents = new Agents(
      store,
      () => {},
      (path) => {
        const env = {
          ...process.env,
          GROK_HOME: home,
          XAI_API_KEY: '',
          GROK_DEPLOYMENT_KEY: '',
        };
        return process.env.GROK_STUDIO_ENGINE === 'cli'
          ? new RpcProcess(
              resolve('.runtime/grok.exe'),
              ['agent', '--no-leader', 'stdio'],
              path,
              env,
            )
          : new EmbeddedRpc(embeddedEngine(), path, env, 'oauth');
      },
    );
    const integration = new Integrations(agents, store);
    const results: any[] = [];
    const action = async (kind: string, input: any) => {
      const result = await integration.action(thread.id, kind, { reviewed: true, ...input });
      results.push({ kind, operation: input.operation, result });
      if (result.status) assert.equal(result.status, 'success', result.message);
      if (result.requiresReload) await integration.action(thread.id, kind, { operation: 'reload' });
      return result;
    };
    try {
      await agents.connect(thread.id);
      await delay(500);
      for (const permission of agents.permissionsSnapshot()) {
        assert.equal(permission.kind, 'trust');
        agents.approve(permission.id, 'trust');
      }
      await action('skills', { operation: 'add', path: skill });
      let skills = await integration.list(thread.id, 'skills');
      assert.ok(skills.skills.some((item: any) => item.name === 'studio-fixture'));
      await action('skills', { operation: 'toggle', name: 'studio-fixture', enabled: false });
      skills = await integration.list(thread.id, 'skills');
      assert.equal(
        skills.skills.find((item: any) => item.name === 'studio-fixture').enabled,
        false,
      );
      await action('skills', { operation: 'toggle', name: 'studio-fixture', enabled: true });
      await action('skills', { operation: 'remove', path: skill });
      skills = await integration.list(thread.id, 'skills');
      assert.ok(!skills.skills.some((item: any) => item.name === 'studio-fixture'));
      await action('plugins', { operation: 'install', source: pathToFileURL(plugin).href });
      let plugins = await integration.list(thread.id, 'plugins');
      let installed = plugins.plugins.find((item: any) => item.name === 'studio-plugin-fixture');
      assert.ok(installed, JSON.stringify(results));
      await action('plugins', { operation: 'disable', name: installed.id });
      plugins = await integration.list(thread.id, 'plugins');
      assert.equal(plugins.plugins.find((item: any) => item.id === installed.id).enabled, false);
      await action('plugins', { operation: 'enable', name: installed.id });
      await writeFile(
        join(plugin, 'plugin.json'),
        JSON.stringify({
          name: 'studio-plugin-fixture',
          version: '1.0.1',
          description: 'Updated fixture',
        }),
      );
      await pluginGit(['add', '.']);
      await pluginGit(['commit', '-m', 'Plugin update']);
      await action('plugins', { operation: 'update', name: installed.id });
      assert.equal(
        (await integration.list(thread.id, 'plugins')).plugins.find(
          (item: any) => item.id === installed.id,
        ).version,
        '1.0.1',
      );
      await action('plugins', { operation: 'uninstall', name: installed.id });
      plugins = await integration.list(thread.id, 'plugins');
      assert.ok(!plugins.plugins.some((item: any) => item.name === 'studio-plugin-fixture'));
      assert.ok(existsSync(join(plugin, 'plugin.json')));
      await action('hooks', { operation: 'add', path: hooks });
      const hookList = await integration.list(thread.id, 'hooks');
      const hook = hookList.hooks.find((item: any) => item.sourceDir === hooks);
      assert.ok(hook, JSON.stringify(hookList));
      await action('hooks', { operation: 'disable', name: hook.name });
      assert.equal(
        (await integration.list(thread.id, 'hooks')).hooks.find(
          (item: any) => item.name === hook.name,
        ).disabled,
        true,
      );
      await action('hooks', { operation: 'enable', name: hook.name });
      await action('mcp', { operation: 'setup', name: 'fixture', values: { variant: 'fixture' } });
      await agents.prompt(
        thread.id,
        'Do not use tools or change files. Reply only NATIVE_CATALOG_READY.',
        [],
      );
      assert.equal(await readFile(hookMarker, 'utf8'), 'HOOK_EXECUTED');
      const mcpCatalog = await integration.list(thread.id, 'mcp');
      assert.ok(
        mcpCatalog.servers
          .find((item: any) => item.name === 'fixture')
          .session.tools.some((tool: any) => tool.name === 'say_hello'),
      );
      await action('mcp', {
        operation: 'tool-policy',
        name: 'fixture',
        tool: 'say_hello',
        enabled: false,
      });
      assert.equal(
        (await integration.list(thread.id, 'mcp')).servers
          .find((item: any) => item.name === 'fixture')
          .session.tools.find((tool: any) => tool.name === 'say_hello').enabled,
        false,
      );
      await action('mcp', {
        operation: 'tool-policy',
        name: 'fixture',
        tool: 'say_hello',
        enabled: true,
      });
      const resource = await action('mcp', {
        operation: 'resource-read',
        name: 'fixture',
        uri: 'fixture://hello',
      });
      assert.ok(JSON.stringify(resource).includes('RESOURCE_FROM_MCP_FIXTURE'));
      const resources = await action('mcp', { operation: 'resources', name: 'fixture' });
      assert.equal(resources.resources[0].uri, 'fixture://hello');
      const templates = await action('mcp', { operation: 'templates', name: 'fixture' });
      assert.equal(templates.resourceTemplates[0].uriTemplate, 'fixture://{name}');
      const prompts = await action('mcp', { operation: 'prompts', name: 'fixture' });
      assert.equal(prompts.prompts[0].arguments[0].required, true);
      const prompt = await action('mcp', {
        operation: 'prompt',
        name: 'fixture',
        prompt: 'fixture_prompt',
        arguments: { topic: 'native acceptance' },
      });
      assert.ok(JSON.stringify(prompt).includes('native acceptance'));
      const instructions = await integration.list(thread.id, 'instructions');
      results.push({ kind: 'instructions', result: instructions });
      const paths = instructions.instructions.map((row: any) => row.path.toLowerCase());
      assert.ok(instructions.projectTrusted);
      const rootIndex = paths.indexOf(join(repo, 'AGENTS.md').toLowerCase()),
        childIndex = paths.indexOf(join(cwd, 'AGENTS.md').toLowerCase());
      assert.ok(rootIndex >= 0 && childIndex > rootIndex);
      assert.ok(JSON.stringify(instructions).includes('WORKBENCH_HOME_INSTRUCTION'));
      await action('hooks', { operation: 'remove', path: hooks });
      assert.ok(
        !(await readFile(join(root, 'desktop/state.json'), 'utf8')).includes('access_token'),
      );
    } finally {
      try {
        await agents.shutdownAndWait();
      } finally {
        await unlink(authPath);
        assert.ok(!existsSync(authPath));
        await writeFile(join(root, 'report.json'), JSON.stringify(results, null, 2));
        console.log('NATIVE_INTEGRATIONS_REPORT', join(root, 'report.json'));
      }
    }
  },
);
