import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../electron/store';
import { git } from '../electron/git-runner';
import { createWorktree } from '../electron/workspace';
import { Worktrees } from '../electron/worktrees';
import { Configuration, forgetMcpCredential } from '../electron/configuration';
import { publicAgent, publicCatalog, extensionResult } from '../electron/native-extensions';
import { Actions } from '../electron/actions';
import { Sessions } from '../electron/sessions';
import { Integrations } from '../electron/integrations';
import { GitReview } from '../electron/git-review';
import { indexRevision } from '../electron/git-actions';
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'grok-local-')),
    root = join(folder, 'repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(
    join(root, 'value.txt'),
    Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
  );
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'baseline']);
  const store = new Store(join(folder, 'desktop', 'state.json'));
  const project = store.openProject(root, 'Fixture'),
    thread = store.create(project.id, root);
  return { folder, root, store, project, thread };
}
test('configuration edits retain comments/advanced fields, expose duplicates and repair invalid syntax with stale guards', async () => {
  const { folder, root } = await fixture();
  const home = join(folder, 'home');
  await mkdir(home);
  await mkdir(join(root, '.grok'));
  const original =
    '# retain this comment\n[mcp_servers.shared]\ncommand="node"\nargs=["--flag"]\nstartup_timeout_sec=123\n[mcp_servers.shared.env]\nSECRET="never drop"\n';
  await writeFile(join(home, 'config.toml'), original);
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'other' } } }),
  );
  await writeFile(join(root, '.grok', 'config.toml'), 'broken = [');
  const config = new Configuration(() => home),
    sources = await config.list(root);
  const user = sources.find((item) => item.scope === 'user')!;
  assert.equal(user.definitions[0].alsoDefinedIn.length, 1);
  const doc = await config.open(user.id);
  const changed = original.replace('123', '456');
  await config.save(user.id, changed, doc.revision);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), changed);
  await assert.rejects(config.save(user.id, original, doc.revision), /changed/);
  const invalid = sources.find((item) => item.error)!;
  const broken = await config.open(invalid.id);
  await assert.rejects(config.save(invalid.id, 'still=[', broken.revision));
  await config.save(invalid.id, 'valid=true\n', broken.revision);
  assert.equal(await readFile(join(root, '.grok/config.toml'), 'utf8'), 'valid=true\n');
  await assert.rejects(config.open('arbitrary-path'), /select/);
});
test('HTTP OAuth forgetting deletes only the selected canonical server key', async () => {
  const home = await mkdtemp(join(tmpdir(), 'grok-credentials-'));
  const path = join(home, 'mcp_credentials.json');
  await writeFile(
    path,
    JSON.stringify({
      'selected:https://example.com/': { access_token: 'fixture-secret' },
      'other:https://other.example/': { access_token: 'retain-fixture' },
    }),
  );
  assert.deepEqual(await forgetMcpCredential(home, 'selected', 'https://example.com'), {
    removed: true,
  });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
    'other:https://other.example/': { access_token: 'retain-fixture' },
  });
  assert.deepEqual(await forgetMcpCredential(home, 'selected', 'https://example.com'), {
    removed: false,
  });
});
test('native handshake/catalog omit config secrets and unwrap real extension errors', () => {
  const handshake = publicAgent({
    protocolVersion: 1,
    agentInfo: { version: '1' },
    _meta: { mcpServers: [{ env: { SECRET: 'private' } }] },
  });
  assert.ok(!JSON.stringify(handshake).includes('private'));
  const catalog = publicCatalog({
    servers: [
      {
        name: 'server',
        env: [{ name: 'SECRET', value: 'private' }],
        headers: { Authorization: 'private' },
        setupValues: { token: 'private' },
      },
    ],
  });
  assert.deepEqual(catalog.servers[0].envNames, ['SECRET']);
  assert.ok(!JSON.stringify(catalog).includes('private'));
  assert.deepEqual(extensionResult({ result: { ok: true } }), { ok: true });
  assert.throws(() => extensionResult({ error: { message: 'denied' } }), /denied/);
});
test('worktree apply preserves source index and untracked files, rejects stale/dirty targets, archive is recoverable and ignored files block removal', async () => {
  const { folder, root, store, thread } = await fixture();
  const manager = new Worktrees(store);
  const created = await createWorktree(
    root,
    join(folder, 'task with spaces'),
    'codex/task',
    'main',
  );
  await manager.own(thread.id, created.path);
  const task = store.create(thread.projectId, created.path);
  await writeFile(join(task.cwd, 'value.txt'), 'staged\n');
  await git(task.cwd, ['add', '.']);
  await writeFile(join(task.cwd, 'value.txt'), 'unstaged\n');
  await writeFile(join(task.cwd, 'new.txt'), 'untracked\n');
  const index = await indexRevision(task.cwd);
  const review = await manager.previewApply(task.id, root);
  assert.equal(await indexRevision(task.cwd), index);
  assert.match(review.patch, /unstaged/);
  assert.match(review.patch, /untracked/);
  await writeFile(join(task.cwd, 'new.txt'), 'changed\n');
  await assert.rejects(manager.apply(task.id, root, review.revision), /changed/);
  const fresh = await manager.previewApply(task.id, root);
  await manager.apply(task.id, root, fresh.revision);
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'changed\n');
  await assert.rejects(manager.previewApply(task.id, root), /clean/);
  await git(root, ['reset', '--hard']);
  await writeFile(join(task.cwd, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(task.cwd, 'ignored.txt'), 'preserve');
  await assert.rejects(manager.archive(task.id), /ignored/);
  assert.equal(await readFile(join(task.cwd, 'ignored.txt'), 'utf8'), 'preserve');
  await unlink(join(task.cwd, 'ignored.txt'));
  const archived = await manager.archive(task.id);
  await assert.rejects(access(task.cwd));
  assert.equal((await git(root, ['rev-parse', archived.ref])).trim(), archived.commit);
  const restored = await manager.restore(thread.id, store.state.worktrees![0].id);
  assert.equal(await readFile(join(restored.cwd, 'value.txt'), 'utf8'), 'unstaged\n');
  assert.equal(await readFile(join(restored.cwd, 'new.txt'), 'utf8'), 'changed\n');
  assert.equal((await git(restored.cwd, ['status', '--porcelain'])).trim(), '');
});
test('archive rejects embedded repositories and cannot remove the primary checkout', async () => {
  const { folder, root, store, thread } = await fixture();
  const manager = new Worktrees(store);
  await manager.own(thread.id, root);
  if (process.platform === 'win32') thread.cwd = root.toUpperCase();
  await assert.rejects(manager.archive(thread.id), /primary/);
  if (process.platform === 'win32') {
    const alias = join(folder, 'primary-junction');
    await symlink(root, alias, 'junction');
    thread.cwd = alias;
    await assert.rejects(manager.archive(thread.id), /primary/);
    thread.cwd = root;
  }
  const created = await createWorktree(root, join(folder, 'nested-fixture'), 'codex/nested');
  await manager.own(thread.id, created.path);
  const task = store.create(thread.projectId, created.path);
  await mkdir(join(task.cwd, 'embedded'));
  await git(join(task.cwd, 'embedded'), ['init']);
  await assert.rejects(manager.archive(task.id), /embedded/);
  await access(join(task.cwd, 'embedded/.git'));
});
test('reusable actions preserve literal argv/Unicode, reject stale review and cancel owned processes', async () => {
  const { store, thread, project } = await fixture();
  const actions = new Actions(store);
  const action = actions.save(project.id, {
    name: 'Literal args',
    command: process.execPath,
    args: ['-e', 'console.log(process.argv[1])', 'こんにちは & echo not-a-command'],
    directory: '.',
    setup: true,
  });
  const preview = await actions.preview(thread.id, action.id);
  const run = await actions.run(thread.id, action.id, preview.revision);
  for (let i = 0; i < 100 && actions.running(); i++) await delay(30);
  assert.equal(run.status, 'completed');
  assert.match(run.output, /こんにちは & echo not-a-command/);
  actions.save(project.id, {
    ...action,
    actionId: action.id,
    args: ['-e', 'setTimeout(()=>{},30000)'],
  });
  await assert.rejects(actions.run(thread.id, action.id, preview.revision), /changed/);
  const next = await actions.preview(thread.id, action.id),
    active = await actions.run(thread.id, action.id, next.revision);
  actions.cancel(active.id);
  for (let i = 0; i < 100 && actions.running(); i++) await delay(30);
  assert.equal(active.status, 'cancelled');
  assert.equal(actions.running(), false);
});
test('rewind requires preview/confirmation, backs up absent paths and transcript, rejects external edits', async () => {
  const { root, store, thread } = await fixture();
  thread.sessionId = 'native-source';
  thread.entries.push({ id: 'entry', type: 'user', text: 'preserve' });
  const calls: any[] = [];
  const agents = {
    connect: async () => ({}),
    disconnect: () => {},
    native: async (_id: string, method: string, params: any) => {
      calls.push({ method, params });
      return method.endsWith('/points')
        ? { rewind_points: [{ prompt_index: 0 }] }
        : { success: params.force, clean_files: ['deleted.txt'], conflicts: [] };
    },
  };
  const sessions = new Sessions(agents as any, store);
  const preview = await sessions.preview(thread.id, 0, 'files_only');
  assert.ok(calls.every((call) => !call.params.force));
  await writeFile(join(root, 'deleted.txt'), 'external');
  await assert.rejects(sessions.rewind(thread.id, preview.token), /changed/);
  await unlink(join(root, 'deleted.txt'));
  const review = await sessions.preview(thread.id, 0, 'files_only');
  const result = await sessions.rewind(thread.id, review.token);
  assert.equal(result.success, true);
  assert.equal(calls.at(-1).params.force, true);
  assert.equal(store.thread(result.transcriptBackupId).entries[0].text, 'preserve');
  await assert.rejects(sessions.rewind(thread.id, review.token), /again/);
});
test('GitHub STDIO OAuth identity is fixed to advertised get_me and logout clears only process memory', async () => {
  const { store, thread } = await fixture();
  thread.sessionId = 'native';
  const calls: any[] = [];
  let shutdown = false;
  const agents = {
    connect: async () => ({}),
    shutdownAndWait: async () => {
      shutdown = true;
    },
    native: async (_id: string, method: string, params: any) => {
      calls.push({ method, params });
      return method.endsWith('/list')
        ? {
            servers: [
              {
                name: 'github-oauth',
                type: 'stdio',
                session: { tools: [{ name: 'get_me', enabled: true }] },
              },
            ],
          }
        : { content: [{ type: 'text', text: 'identity-fixture' }] };
    },
  };
  const integrations = new Integrations(agents as any, store);
  await integrations.action(thread.id, 'mcp', {
    name: 'github-oauth',
    operation: 'sign-in',
    tool: 'arbitrary',
  });
  assert.equal(calls.at(-1).params.tool, 'get_me');
  await assert.rejects(
    integrations.action(thread.id, 'mcp', { name: 'unknown', operation: 'sign-in' }),
    /select/,
  );
  await assert.rejects(
    integrations.action(thread.id, 'mcp', { name: 'github-oauth', operation: 'logout' }),
    /Confirm/,
  );
  assert.deepEqual(
    await integrations.action(thread.id, 'mcp', {
      name: 'github-oauth',
      operation: 'logout',
      reviewed: true,
    }),
    { memoryCleared: true, providerConsentRevoked: false },
  );
  assert.equal(shutdown, true);
});
test('Git chunks stage/unstage only the selected hunk, reject stale diff, preserve revert recovery and local comments', async () => {
  const { root, store, thread } = await fixture();
  const review = new GitReview(store),
    original = await readFile(join(root, 'value.txt'), 'utf8');
  const modified = original
    .replace('line 2\n', 'modified first\n')
    .replace('line 28\n', 'modified last\n');
  await writeFile(join(root, 'value.txt'), modified);
  const chunks = await review.chunks(thread.id, 'value.txt', false);
  assert.equal(chunks.hunks.length, 2);
  const comment = await review.comment(thread.id, {
    path: 'value.txt',
    side: 'right',
    line: 2,
    body: 'Local feedback',
    revision: chunks.revision,
  });
  assert.equal(
    new Store(join(root, '../desktop/state.json')).thread(thread.id).reviewComments![0].id,
    comment.id,
  );
  await review.chunk(thread.id, {
    path: 'value.txt',
    chunk: 0,
    operation: 'stage',
    revision: chunks.revision,
  });
  const indexed = await git(root, ['diff', '--cached']);
  assert.match(indexed, /modified first/);
  assert.ok(!indexed.includes('modified last'));
  await assert.rejects(
    review.chunk(thread.id, {
      path: 'value.txt',
      chunk: 1,
      operation: 'stage',
      revision: chunks.revision,
    }),
    /changed/,
  );
  const staged = await review.chunks(thread.id, 'value.txt', true);
  await review.chunk(thread.id, {
    path: 'value.txt',
    chunk: 0,
    operation: 'unstage',
    revision: staged.revision,
  });
  assert.equal((await git(root, ['diff', '--cached'])).trim(), '');
  assert.equal(await readFile(join(root, 'value.txt'), 'utf8'), modified);
  const latest = await review.chunks(thread.id, 'value.txt', false);
  const result = await review.chunk(thread.id, {
    path: 'value.txt',
    chunk: 0,
    operation: 'revert',
    revision: latest.revision,
    reviewed: true,
  });
  assert.equal(JSON.parse(await readFile(result.recovery!, 'utf8')).text, modified);
  const after = await readFile(join(root, 'value.txt'), 'utf8');
  assert.ok(!after.includes('modified first'));
  assert.ok(after.includes('modified last'));
});
test('branch selection is clean-only and reviewed push verifies local branch/remote against stale changes', async () => {
  const { folder, root, store, thread } = await fixture();
  const review = new GitReview(store);
  const remote = join(folder, 'remote.git');
  await mkdir(remote);
  await git(remote, ['init', '--bare']);
  await git(root, ['remote', 'add', 'origin', remote]);
  await review.branch(thread.id, 'codex/task', 'main', false);
  assert.equal((await review.branches(thread.id)).current, 'codex/task');
  await review.branch(thread.id, 'main', 'HEAD', true);
  const push = await review.pushPreview(thread.id, 'origin');
  await review.push(thread.id, 'origin', push.revision);
  assert.equal((await git(remote, ['rev-parse', 'refs/heads/main'])).trim(), push.head);
  await review.branch(thread.id, 'codex/other', 'main', false);
  await assert.rejects(review.push(thread.id, 'origin', push.revision), /changed/);
  await writeFile(join(root, 'new.txt'), 'keep');
  await assert.rejects(review.branch(thread.id, 'main', 'HEAD', true), /preserve/);
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'keep');
});

test('PR review binds repository, branch, commit and exact multiline text before publication', async () => {
  const { root, store, thread } = await fixture(),
    review = new GitReview(store);
  await git(root, ['remote', 'add', 'origin', 'https://github.com/fixture/repository.git']);
  await review.branch(thread.id, 'codex/pr', 'main', false);
  const input = {
    title: 'Review title',
    body: 'First line\n\nLiteral $() and backticks remain text.',
    base: 'main',
  };
  const preview = await review.prPreview(thread.id, input);
  assert.equal(preview.repository, 'fixture/repository');
  assert.equal(preview.body, input.body);
  await assert.rejects(
    review.createPr(thread.id, { ...input, body: 'Changed', revision: preview.revision }),
    /changed/,
  );
  await review.branch(thread.id, 'main', 'HEAD', true);
  await assert.rejects(review.prPreview(thread.id, input), /different/);
  await git(root, ['remote', 'set-url', 'origin', 'https://example.invalid/fixture/repository']);
  await assert.rejects(review.prs(thread.id), /github.com/);
});
