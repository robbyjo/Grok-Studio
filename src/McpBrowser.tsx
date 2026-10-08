import { useState } from 'react';
import type { Wire } from '../shared/types';
export default function McpBrowser({ id, server }: { id: string; server: string }) {
  const [kind, setKind] = useState('resources'),
    [page, setPage] = useState<Wire>(),
    [selected, setSelected] = useState<Wire>(),
    [values, setValues] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function run(operation: string, args: Wire = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.call<Wire>('integration:action', {
        id,
        kind: 'mcp',
        name: server,
        operation,
        ...args,
      });
      if (['resources', 'templates', 'prompts'].includes(operation)) {
        setPage(result);
        setSelected(undefined);
        setPreview('');
      } else {
        const content =
          operation === 'prompt'
            ? (result.messages ?? [])
                .map((message: Wire) => {
                  const text = message.content?.text;
                  return typeof text === 'string'
                    ? `${message.role}: ${text}`
                    : '[Non-text prompt content omitted]';
                })
                .join('\n\n')
            : (result.contents ?? [])
                .map((item: Wire) => item.text ?? '[Binary resource: use the resource result view]')
                .join('\n\n');
        if (content.length > 64000)
          throw new Error('Prompt/resource exceeds the 64,000-character draft limit.');
        setPreview(content);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="mcp-browser">
      <summary>Browse resources and reusable prompts</summary>
      <select
        aria-label={`MCP discovery for ${server}`}
        value={kind}
        onChange={(e) => {
          setKind(e.target.value);
          setPage(undefined);
          setSelected(undefined);
          setPreview('');
        }}
      >
        <option value="resources">Resources</option>
        <option value="templates">Resource templates</option>
        <option value="prompts">Prompts</option>
      </select>
      <button disabled={busy} onClick={() => void run(kind)}>
        Discover {kind}
      </button>
      {error && <p role="alert">{error}</p>}
      {(page?.[kind === 'templates' ? 'resourceTemplates' : kind] ?? []).map((item: Wire) => (
        <button
          key={item.uri ?? item.uriTemplate ?? item.name}
          disabled={busy}
          onClick={() => {
            setSelected(item);
            setValues({});
            setPreview('');
          }}
        >
          {item.title ?? item.name ?? item.uri}
          <small>{item.description}</small>
        </button>
      ))}
      {page?.nextCursor && (
        <button disabled={busy} onClick={() => void run(kind, { cursor: page.nextCursor })}>
          Next provider page
        </button>
      )}
      {selected && (
        <div>
          <strong>{selected.name}</strong>
          {kind === 'prompts' ? (
            <>
              <p>{selected.description}</p>
              {(selected.arguments ?? []).map((arg: Wire) => (
                <label key={arg.name}>
                  {arg.name}
                  {arg.required ? ' (required)' : ''}
                  <input
                    aria-label={`Prompt argument ${arg.name}`}
                    value={values[arg.name] ?? ''}
                    onChange={(e) => setValues({ ...values, [arg.name]: e.target.value })}
                  />
                </label>
              ))}
              <button
                disabled={
                  busy ||
                  selected.arguments?.some((arg: Wire) => arg.required && !values[arg.name]?.trim())
                }
                onClick={() => void run('prompt', { prompt: selected.name, arguments: values })}
              >
                Preview prompt
              </button>
            </>
          ) : kind === 'resources' ? (
            <button
              disabled={busy}
              onClick={() => void run('resource-read', { uri: selected.uri })}
            >
              Preview resource
            </button>
          ) : (
            <>
              <code>{selected.uriTemplate}</code>
              <p>Fill the template and use the resource URI field below.</p>
            </>
          )}
        </div>
      )}
      {preview && (
        <>
          <textarea
            aria-label={`MCP preview from ${server}`}
            value={preview}
            onChange={(e) => setPreview(e.target.value)}
            maxLength={64000}
          />
          <button
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('workbench:insert-prompt', {
                  detail: { id, text: `MCP source: ${server}\n\n${preview}` },
                }),
              )
            }
          >
            Insert reviewed text into chat draft
          </button>
        </>
      )}
      <small>
        Provider content is untrusted. Preview/edit before inserting; insertion never sends a
        prompt. Unsupported methods are reported by the provider.
      </small>
    </details>
  );
}
