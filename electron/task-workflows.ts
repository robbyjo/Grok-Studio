import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Store } from './store';
import { Worktrees } from './worktrees';
import { Actions } from './actions';
import { createWorktree } from './workspace';
import { git } from './git-runner';
import type { Wire, ProjectAction } from '../shared/types';
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const active = (row: Wire) => ['preparing', 'running', 'testing'].includes(row.status);
export class TaskWorkflows {
  private rows: Wire[];
  private reviews = new Map<string, Wire>();
  private stopped = new Set<string>();
  prompt: (id: string, text: string) => Promise<unknown> = async () => {
    throw new Error('Agent unavailable.');
  };
  stopAgent: (id: string) => unknown = () => {};
  configure: (id: string, selection: Wire) => Promise<unknown> = async () => {};
  test: (id: string, actionId: string, revision: string) => Promise<Wire>;
  constructor(
    private store: Store,
    private worktrees: Worktrees,
    private actions: Actions,
  ) {
    this.test = (id, actionId, revision) => actions.run(id, actionId, revision);
    this.rows = store.history.value('task-workflows') ?? [];
    for (const row of this.rows)
      if (active(row)) {
        row.status = 'interrupted';
        row.error =
          'Workbench stopped. Review the preserved worktree before continuing the chat or running tests manually.';
      }
    this.persist();
  }
  private persist() {
    this.store.history.setValue('task-workflows', this.rows);
    this.store.flush();
  }
  list(id: string) {
    return this.rows.filter((row) => row.threadId === id || row.sourceId === id);
  }
  owns(id: string) {
    return this.rows.some((row) => row.threadId === id && active(row));
  }
  busy() {
    return this.rows.some(active);
  }
  async preview(id: string, text: string, actionIds: string[]) {
    if (typeof text !== 'string' || !text.trim() || text.length > 200000 || text.includes('\0'))
      throw new Error('Enter a task prompt.');
    if (
      !Array.isArray(actionIds) ||
      !actionIds.length ||
      actionIds.length > 10 ||
      new Set(actionIds).size !== actionIds.length
    )
      throw new Error('Choose one to ten configured test actions.');
    const source = this.store.thread(id);
    if (source.queue?.length)
      throw new Error('Clear or finish queued prompts before creating a task.');
    if ((await git(source.cwd, ['status', '--porcelain', '--untracked-files=all'])).trim())
      throw new Error('Commit or preserve source changes before starting a task from HEAD.');
    const tests = [];
    for (const actionId of actionIds) tests.push((await this.actions.preview(id, actionId)).action);
    if (Buffer.byteLength(JSON.stringify(tests)) > 65536)
      throw new Error('Task test commands exceed 64 KiB.');
    const selection = {
      mode: source.session?.modes?.currentModeId,
      models: (source.session?.configOptions ?? [])
        .filter(
          (option: Wire) => option.category === 'model' && typeof option.currentValue === 'string',
        )
        .map((option: Wire) => ({ id: option.id, value: option.currentValue })),
    };
    const value = {
      id,
      text,
      tests,
      selection,
      head: (await git(source.cwd, ['rev-parse', 'HEAD'])).trim(),
      token: randomUUID(),
    };
    this.reviews.clear();
    this.reviews.set(value.token, value);
    return {
      ...value,
      cwd: source.cwd,
      note: 'Creates a sibling worktree from reviewed HEAD. Runs these executables after the agent finishes. Applying changes is a separate review.',
    };
  }
  async create(token: string) {
    if (this.rows.some(active)) throw new Error('Finish or cancel the current managed task.');
    const review = this.reviews.get(token);
    if (!review) throw new Error('Review this task again.');
    const refreshed = await this.preview(
      review.id,
      review.text,
      review.tests.map((t: ProjectAction) => t.id),
    );
    if (
      refreshed.head !== review.head ||
      fingerprint(refreshed.tests) !== fingerprint(review.tests) ||
      fingerprint(refreshed.selection) !== fingerprint(review.selection)
    )
      throw new Error('Source or test actions changed. Review again.');
    this.reviews.clear();
    const source = this.store.thread(review.id),
      key = randomUUID();
    const parent = join(dirname(source.cwd), '.grok-workbench-tasks');
    await mkdir(parent, { recursive: true });
    const worktree = await createWorktree(
      source.cwd,
      join(parent, key),
      'workbench/task-' + key,
      review.head,
    );
    await this.worktrees.own(source.id, worktree.path);
    const thread = this.store.create(source.projectId, worktree.path);
    const row: Wire = {
      id: key,
      threadId: thread.id,
      sourceId: source.id,
      target: source.cwd,
      head: review.head,
      status: 'preparing',
      tests: review.tests,
      selection: review.selection,
      results: [],
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    this.rows = this.rows.slice(-100);
    this.persist();
    return { id: thread.id, workflowId: key, prompt: review.text };
  }
  async run(threadId: string, text: string) {
    const row = this.rows.find((row) => row.threadId === threadId);
    if (!row || !active(row)) return;
    try {
      row.status = 'running';
      this.persist();
      await this.configure(threadId, row.selection);
      if (this.stopped.has(row.id)) return;
      await this.prompt(threadId, text);
      if (this.stopped.has(row.id)) return;
      if (this.store.thread(threadId).status !== 'idle')
        throw new Error('Agent did not finish successfully. Worktree preserved for review.');
      row.status = 'testing';
      this.persist();
      for (const action of row.tests as ProjectAction[]) {
        if (this.stopped.has(row.id)) return;
        const preview = await this.actions.preview(threadId, action.id);
        if (fingerprint(preview.action) !== fingerprint(action))
          throw new Error('Test action changed since approval. Review and run it manually.');
        const run = await this.test(threadId, action.id, preview.revision);
        row.runId = run.id;
        this.persist();
        while (['running', 'stopping'].includes(run.status))
          await new Promise((resolve) => setTimeout(resolve, 100));
        row.results.push({
          name: action.name,
          status: run.status,
          exitCode: run.exitCode,
          output: run.output.slice(-20000),
          error: run.error,
          finishedAt: run.finishedAt,
        });
        delete row.runId;
        this.persist();
        if (this.stopped.has(row.id)) return;
        if (run.status !== 'completed') {
          row.status = 'tests-failed';
          this.persist();
          return;
        }
      }
      row.status = 'review';
      this.persist();
    } catch (e) {
      if (!this.stopped.has(row.id)) {
        row.status = 'interrupted';
        row.error = String(e);
        this.persist();
      }
    } finally {
      this.stopped.delete(row.id);
    }
  }
  cancel(id: string) {
    const row = this.rows.find((row) => row.threadId === id && active(row));
    if (!row) return false;
    this.stopped.add(row.id);
    row.status = 'cancelled';
    if (row.runId) this.actions.cancel(row.runId);
    this.stopAgent(id);
    this.persist();
    return true;
  }
  private row(id: string) {
    const row = this.rows.find((row) => row.threadId === id);
    if (!row || active(row)) throw new Error('Finish or cancel the task before reviewing changes.');
    return row;
  }
  async review(id: string, files?: string[]) {
    return this.worktrees.previewApply(id, this.row(id).target, files);
  }
  async apply(id: string, revision: string, files: string[]) {
    const row = this.row(id);
    const result = await this.worktrees.apply(id, row.target, revision, files);
    row.status = 'applied';
    row.appliedFiles = result.files;
    this.persist();
    return result;
  }
}
