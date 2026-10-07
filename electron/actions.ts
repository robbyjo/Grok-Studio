import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store';
import { inside, directory } from './paths';
import type { ProjectAction, Wire } from '../shared/types';
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Actions {
  private runs = new Map<string, { child: ChildProcess; record: Wire }>();
  constructor(private store: Store) {}
  running() {
    return [...this.runs.values()].some((run) =>
      ['running', 'stopping'].includes(run.record.status),
    );
  }
  list(projectId: string) {
    return {
      actions: this.store.project(projectId).actions ?? [],
      runs: [...this.runs.values()]
        .filter((run) => run.record.projectId === projectId)
        .map((run) => run.record),
    };
  }
  save(projectId: string, input: Wire) {
    const valid = (value: unknown, max = 4000) =>
      typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
    if (
      !valid(input.name, 120) ||
      !valid(input.command) ||
      !valid(input.directory) ||
      !Array.isArray(input.args) ||
      input.args.length > 100 ||
      input.args.some(
        (arg: unknown) => typeof arg !== 'string' || arg.length > 10000 || arg.includes('\0'),
      )
    )
      throw new Error('Enter a name, executable, workspace directory and separate arguments.');
    const project = this.store.project(projectId);
    const action: ProjectAction = {
      id: input.actionId ?? randomUUID(),
      name: input.name,
      command: input.command,
      args: input.args,
      directory: input.directory,
      setup: input.setup === true,
    };
    if (input.actionId && !project.actions?.some((action) => action.id === input.actionId))
      throw new Error('Action is no longer configured.');
    project.actions = [...(project.actions ?? []).filter((item) => item.id !== action.id), action];
    this.store.flush();
    return action;
  }
  remove(projectId: string, actionId: string) {
    const project = this.store.project(projectId);
    project.actions = project.actions?.filter((action) => action.id !== actionId);
    this.store.flush();
  }
  async preview(id: string, actionId: string) {
    const thread = this.store.thread(id);
    const action = this.store
      .project(thread.projectId)
      .actions?.find((action) => action.id === actionId);
    if (!action) throw new Error('Choose a configured action.');
    const cwd = await directory(await inside(thread.cwd, action.directory));
    return { action, cwd, revision: fingerprint({ action, cwd }) };
  }
  async run(id: string, actionId: string, revision: string) {
    if (this.running()) throw new Error('Wait for or cancel the running project action.');
    const preview = await this.preview(id, actionId);
    if (preview.revision !== revision) throw new Error('Action changed. Review it again.');
    const thread = this.store.thread(id),
      runId = randomUUID();
    const record: Wire = {
      id: runId,
      projectId: thread.projectId,
      threadId: id,
      actionId,
      status: 'running',
      output: '',
      startedAt: new Date().toISOString(),
    };
    const child = spawn(preview.action.command, preview.action.args, {
      cwd: preview.cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.runs.set(runId, { child, record });
    while (this.runs.size > 20) {
      const old = [...this.runs].find(([, run]) => run.record.status !== 'running');
      if (!old) break;
      this.runs.delete(old[0]);
    }
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    const append = (chunk: string) => (record.output = (record.output + chunk).slice(-100000));
    child.stdout!.on('data', append);
    child.stderr!.on('data', append);
    child.on('error', (error) => {
      record.status = 'failed';
      record.error = error.message;
    });
    child.on('close', (code) => {
      if (record.status === 'running') record.status = code === 0 ? 'completed' : 'failed';
      if (record.status === 'stopping') record.status = 'cancelled';
      record.exitCode = code;
      record.finishedAt = new Date().toISOString();
    });
    return record;
  }
  cancel(runId: string) {
    const run = this.runs.get(runId);
    if (!run || run.record.status !== 'running') return;
    run.record.status = 'stopping';
    if (process.platform === 'win32' && run.child.pid)
      execFile(
        'taskkill',
        ['/PID', String(run.child.pid), '/T', '/F'],
        { windowsHide: true },
        () => {},
      );
    else run.child.kill();
  }
  shutdown() {
    for (const id of this.runs.keys()) this.cancel(id);
  }
}
