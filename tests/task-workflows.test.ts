import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/store';
import { git } from '../electron/git-runner';
import { Worktrees } from '../electron/worktrees';
import { Actions } from '../electron/actions';
import { TaskWorkflows } from '../electron/task-workflows';
async function fixture() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'workbench-task-'))),
    root = join(folder, 'repo');
  await mkdir(root);
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(root, 'a.txt'), 'old\n');
  await writeFile(join(root, 'b.txt'), 'old\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'baseline']);
  const store = new Store(join(folder, 'profile', 'state.json')),
    project = store.openProject(root, 'Task'),
    thread = store.create(project.id, root),
    actions = new Actions(store);
  const action = actions.save(project.id, {
    name: 'Acceptance test',
    command: process.execPath,
    args: [
      '-e',
      "require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8'),'new\\n');console.log('REAL_TASK_TEST_PASSED')",
    ],
    directory: '.',
  });
  const tasks = new TaskWorkflows(store, new Worktrees(store), actions);
  tasks.prompt = async (id) => {
    const chat = store.thread(id);
    await writeFile(join(chat.cwd, 'a.txt'), 'new\n');
    await writeFile(join(chat.cwd, 'b.txt'), 'unselected\n');
    chat.status = 'idle';
  };
  return { root, store, thread, actions, action, tasks };
}
test('task creates a real isolated worktree, executes configured tests, persists review and applies only selected files', async () => {
  const f = await fixture(),
    selection = { mode: 'plan', models: [{ id: 'model', value: 'fixture-selected' }] };
  f.thread.session = {
    modes: { currentModeId: selection.mode },
    configOptions: [{ id: 'model', category: 'model', currentValue: 'fixture-selected' }],
  };
  let inherited: unknown;
  f.tasks.configure = async (_id, choice) => {
    inherited = choice;
  };
  const review = await f.tasks.preview(f.thread.id, 'Edit a and b', [f.action.id]),
    created = await f.tasks.create(review.token);
  await f.tasks.run(created.id, created.prompt);
  assert.deepEqual(inherited, selection);
  const row = f.tasks.list(created.id)[0];
  assert.equal(row.status, 'review');
  assert.match(row.results[0].output, /REAL_TASK_TEST_PASSED/);
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'old\n');
  const patch = await f.tasks.review(created.id, ['a.txt']);
  assert.deepEqual(patch.files, ['a.txt']);
  assert.deepEqual(patch.allFiles.sort(), ['a.txt', 'b.txt']);
  await f.tasks.apply(created.id, patch.revision, ['a.txt']);
  assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'new\n');
  assert.equal(await readFile(join(f.root, 'b.txt'), 'utf8'), 'old\n');
  assert.match(await git(f.root, ['diff', '--cached']), /new/);
  await access(f.store.thread(created.id).cwd);
  const reopened = new TaskWorkflows(f.store, new Worktrees(f.store), f.actions);
  assert.equal(reopened.list(created.id)[0].status, 'applied');
});
test('task refuses stale test approval and dirty source; rejects stale apply and escaping file selection', async () => {
  const f = await fixture(),
    review = await f.tasks.preview(f.thread.id, 'Task', [f.action.id]);
  f.actions.save(f.thread.projectId, { ...f.action, actionId: f.action.id, args: ['--version'] });
  await assert.rejects(f.tasks.create(review.token), /changed/);
  await writeFile(join(f.root, 'a.txt'), 'dirty\n');
  await assert.rejects(f.tasks.preview(f.thread.id, 'Task', [f.action.id]), /preserve/);
  await writeFile(join(f.root, 'a.txt'), 'old\n');
  const current = await f.tasks.preview(f.thread.id, 'Task', [f.action.id]),
    created = await f.tasks.create(current.token);
  await f.tasks.run(created.id, created.prompt);
  await assert.rejects(f.tasks.review(created.id, ['../a.txt']), /Choose changed/);
  const patch = await f.tasks.review(created.id, ['a.txt']);
  await writeFile(join(f.store.thread(created.id).cwd, 'a.txt'), 'newer\n');
  await assert.rejects(f.tasks.apply(created.id, patch.revision, ['a.txt']), /changed/);
});
test('failed tests are retained, cancellation stops owned action and restart never replays the task', async () => {
  const f = await fixture();
  f.actions.save(f.thread.projectId, {
    ...f.action,
    actionId: f.action.id,
    args: ['-e', 'process.exit(7)'],
  });
  let review = await f.tasks.preview(f.thread.id, 'Fail test', [f.action.id]),
    created = await f.tasks.create(review.token);
  await f.tasks.run(created.id, created.prompt);
  assert.equal(f.tasks.list(created.id)[0].status, 'tests-failed');
  assert.equal(f.tasks.list(created.id)[0].results[0].exitCode, 7);
  f.actions.save(f.thread.projectId, {
    ...f.action,
    actionId: f.action.id,
    args: ['-e', 'setTimeout(()=>{},30000)'],
  });
  review = await f.tasks.preview(f.thread.id, 'Cancel test', [f.action.id]);
  created = await f.tasks.create(review.token);
  const running = f.tasks.run(created.id, created.prompt);
  const deadline = Date.now() + 10000;
  while (!f.actions.running() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(f.actions.running());
  f.tasks.cancel(created.id);
  await running;
  assert.equal(f.tasks.list(created.id)[0].status, 'cancelled');
  assert.equal(f.actions.running(), false);
  review = await f.tasks.preview(f.thread.id, 'Interrupted task', [f.action.id]);
  created = await f.tasks.create(review.token);
  const recovered = new TaskWorkflows(f.store, new Worktrees(f.store), f.actions);
  assert.equal(recovered.list(created.id)[0].status, 'interrupted');
  assert.equal(f.actions.running(), false);
});
