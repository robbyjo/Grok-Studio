import { useEffect, useRef, useState } from 'react';
import type { Thread, Wire } from '../shared/types';
export function UsageIndicators({ thread }: { thread: Thread }) {
  const usage = thread.usage,
    context = thread.runtimeStatus?.context_window;
  const knownCost =
    usage &&
    typeof usage.costUsdTicks === 'number' &&
    !usage.usageIsIncomplete &&
    !usage.costIsPartial;
  return (
    <div className="usage-indicators" role="status" aria-live="polite">
      <span>
        {usage
          ? `${usage._scope === 'process' ? 'Current process' : 'Last turn'}: ${usage.inputTokens ?? '?'} input · ${usage.outputTokens ?? '?'} output tokens`
          : 'Usage unavailable'}
      </span>
      <span>
        {context?.used_percentage !== undefined
          ? `Context ${context.used_percentage}% (${context.context_tokens ?? '?'} / ${context.context_window_size ?? '?'})`
          : 'Context unavailable'}
      </span>
      <span>
        {knownCost ? `Cost $${(usage.costUsdTicks / 1e10).toFixed(4)}` : 'Cost unavailable'}
        {usage?.usageIsIncomplete ? ' · incomplete' : ''}
        {usage?.costIsPartial ? ' · partial' : ''}
      </span>
    </div>
  );
}
export default function TaskDashboard({ thread, close }: { thread: Thread; close: () => void }) {
  const [report, setReport] = useState<Wire>(),
    [error, setError] = useState(''),
    [inspection, setInspection] = useState(''),
    [busy, setBusy] = useState(false);
  const refreshing = useRef(false);
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      setReport(await window.desktop.call('tasks:dashboard', { id: thread.id }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [thread.id]);
  async function control(operation: string, target: string) {
    setBusy(true);
    try {
      const result = await window.desktop.call('tasks:control', {
        id: thread.id,
        operation,
        target,
      });
      setInspection(JSON.stringify(result, null, 2).slice(0, 64000));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const tasks = report?.tasks ?? thread.tasks ?? [],
    subagents = report?.subagents ?? thread.subagents ?? [];
  return (
    <div className="modal-backdrop">
      <section
        className="modal workflow-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Tasks and queued prompts"
      >
        <div className="modal-header">
          <h2>Tasks and queued prompts</h2>
          <button onClick={close}>Close</button>
        </div>
        <div className="input-row">
          <button disabled={busy} onClick={() => void refresh()}>
            Refresh tasks
          </button>
          <button
            disabled={busy || ['running', 'approval', 'connecting'].includes(thread.status)}
            onClick={async () => {
              try {
                await window.desktop.call('agent:connect', { id: thread.id });
                await refresh();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            Connect Grok
          </button>
        </div>
        <UsageIndicators thread={thread} />
        <p className="muted">
          Usage is scoped to the runtime process or last turn; it is not a lifetime bill. Stopped or
          restarted connections require a fresh task refresh.
        </p>
        {(error || Object.keys(report?.errors ?? {}).length > 0) && (
          <p role="alert">
            {error ||
              Object.entries(report!.errors)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' · ')}
          </p>
        )}
        <h3>Queued prompts</h3>
        <div className="input-row">
          <button
            onClick={() =>
              void window.desktop
                .call('agent:queue-edit', { id: thread.id, operation: 'pause' })
                .catch((e) => setError(String(e)))
            }
          >
            Pause queue
          </button>
          <button
            onClick={() =>
              void window.desktop
                .call('agent:queue-edit', { id: thread.id, operation: 'resume' })
                .catch((e) => setError(String(e)))
            }
          >
            Resume queue
          </button>
        </div>
        <p className="muted">
          Queued prompts run serially after a successful turn. Stop, errors and app restart pause
          the queue.
        </p>
        {(thread.queue ?? []).map((row, index) => (
          <div className="workflow-row" key={row.id}>
            <strong>{row.state}</strong>
            <p>{row.text}</p>
            <button
              disabled={index === 0}
              onClick={() =>
                void window.desktop
                  .call('agent:queue-edit', { id: thread.id, queueId: row.id, operation: 'up' })
                  .catch((e) => setError(String(e)))
              }
            >
              Move up
            </button>
            <button
              onClick={() => {
                const text = window.prompt('Edit queued prompt', row.text);
                if (text !== null)
                  void window.desktop
                    .call('agent:queue-edit', {
                      id: thread.id,
                      queueId: row.id,
                      operation: 'edit',
                      text,
                    })
                    .catch((e) => setError(String(e)));
              }}
            >
              Edit
            </button>
            <button
              onClick={() =>
                void window.desktop
                  .call('agent:queue-edit', { id: thread.id, queueId: row.id, operation: 'remove' })
                  .catch((e) => setError(String(e)))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <h3>Background commands</h3>
        {!tasks.length && <p>No reported background tasks.</p>}
        {tasks.map((row: Wire) => {
          const id = row.task_id ?? row.taskId;
          return (
            <div className="workflow-row" key={id}>
              <strong>{row.status}</strong>
              <p>{row.description ?? row.command ?? id}</p>
              <button
                disabled={busy || row.status !== 'running'}
                onClick={() => void control('kill', id)}
              >
                Stop command
              </button>
            </div>
          );
        })}
        <h3>Subagents</h3>
        {!subagents.length && <p>No reported subagents.</p>}
        {subagents.map((row: Wire) => {
          const id = row.subagent_id ?? row.subagentId;
          return (
            <div className="workflow-row" key={id}>
              <strong>
                {row.status} · {row.subagent_type ?? 'subagent'}
              </strong>
              <p>{row.description ?? id}</p>
              <small>
                {row.tokens_used ?? '?'} context tokens ·{' '}
                {row.tool_call_count ?? row.tool_calls ?? '?'} tools
              </small>
              <button disabled={busy} onClick={() => void control('inspect-subagent', id)}>
                Inspect
              </button>
              <button
                disabled={busy || row.status !== 'running'}
                onClick={() => void control('cancel-subagent', id)}
              >
                Cancel subagent
              </button>
            </div>
          );
        })}
        {inspection && <pre>{inspection}</pre>}
      </section>
    </div>
  );
}
