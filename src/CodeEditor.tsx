import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';

globalThis.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'typescript' || label === 'javascript') return new TypeScriptWorker();
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    return new EditorWorker();
  },
};
monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.typescript.ModuleResolutionKind.NodeJs,
  allowNonTsExtensions: true,
  strict: true,
  noEmit: true,
});
monaco.typescript.typescriptDefaults.setEagerModelSync(true);
const language = (path: string) =>
  (
    ({
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      mts: 'typescript',
      cts: 'typescript',
      jsx: 'javascript',
      json: 'json',
      py: 'python',
      rs: 'rust',
      ps1: 'powershell',
      md: 'markdown',
      html: 'html',
      css: 'css',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'ini',
    }) as Record<string, string>
  )[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';
export default function CodeEditor({
  id,
  path,
  text,
  change,
  save,
  location,
  navigate,
}: {
  id: string;
  path: string;
  text: string;
  change: (text: string) => void;
  save: () => void;
  location?: { line?: number; column?: number };
  navigate: (path: string, location?: { line?: number; column?: number }) => void;
}) {
  const container = useRef<HTMLDivElement>(null),
    view = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined),
    callbacks = useRef({ change, save, navigate });
  callbacks.current = { change, save, navigate };
  const [problems, setProblems] = useState<monaco.editor.IMarker[]>([]),
    [error, setError] = useState('');
  const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
  function run(action: string) {
    view.current?.focus();
    view.current?.trigger('workbench', action, {});
  }
  useEffect(() => {
    const uri = (name: string) =>
      monaco.Uri.parse(
        `file:///workspace/${encodeURIComponent(id)}/${name.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}`,
      );
    const models: monaco.editor.ITextModel[] = [];
    const libraries: monaco.IDisposable[] = [];
    const model = monaco.editor.createModel(text, language(path), uri(path));
    models.push(model);
    const editor = monaco.editor.create(container.current!, {
      model,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      ariaLabel: `Code editor ${path}`,
      fontSize: 13,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      accessibilitySupport: 'auto',
      editContext: false,
    });
    view.current = editor;
    const cursor = editor.onDidChangeCursorPosition((event) => setPosition(event.position));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const edits = model.onDidChangeContent(() => {
      callbacks.current.change(model.getValue());
      clearTimeout(timer);
      timer = setTimeout(loadContext, 500);
    });
    const markers = monaco.editor.onDidChangeMarkers(() =>
      setProblems(monaco.editor.getModelMarkers({ resource: model.uri }).slice(0, 100)),
    );
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selection) {
        const target = models.find((m) => m.uri.toString() === resource.toString());
        if (!target || target === model) return false;
        const prefix = `file:///workspace/${encodeURIComponent(id)}/`;
        const name = resource
          .toString()
          .slice(prefix.length)
          .split('/')
          .map(decodeURIComponent)
          .join('/');
        callbacks.current.navigate(
          name,
          selection &&
            ('startLineNumber' in selection
              ? { line: selection.startLineNumber, column: selection.startColumn }
              : { line: selection.lineNumber, column: selection.column }),
        );
        return true;
      },
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.save());
    let alive = true;
    let generation = 0;
    function loadContext() {
      const request = ++generation;
      void window.desktop
        .call<{ path: string; text: string }[]>('editor:context', {
          id,
          path,
          text: model.getValue(),
        })
        .then((files) => {
          if (!alive || request !== generation) return;
          for (const library of libraries) library.dispose();
          libraries.length = 0;
          for (const dependency of models.splice(1)) dependency.dispose();
          for (const file of files)
            if (file.path !== path && !monaco.editor.getModel(uri(file.path))) {
              models.push(
                monaco.editor.createModel(file.text, language(file.path), uri(file.path)),
              );
              libraries.push(
                monaco.typescript.typescriptDefaults.addExtraLib(
                  file.text,
                  uri(file.path).toString(),
                ),
              );
              libraries.push(
                monaco.typescript.javascriptDefaults.addExtraLib(
                  file.text,
                  uri(file.path).toString(),
                ),
              );
            }
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    }
    loadContext();
    return () => {
      alive = false;
      clearTimeout(timer);
      view.current = undefined;
      edits.dispose();
      cursor.dispose();
      markers.dispose();
      opener.dispose();
      editor.dispose();
      for (const library of libraries) library.dispose();
      for (const model of models) model.dispose();
    };
  }, [id, path]);
  useEffect(() => {
    const model = view.current?.getModel();
    if (model && model.getValue() !== text) {
      const position = view.current!.getPosition();
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      if (position) view.current!.setPosition(position);
    }
  }, [text]);
  useEffect(() => {
    if (!location?.line || !view.current) return;
    const position = { lineNumber: location.line, column: location.column ?? 1 };
    view.current.setPosition(position);
    view.current.revealPositionInCenter(position);
    view.current.focus();
  }, [location]);
  return (
    <div className="code-editor">
      <div className="editor-actions">
        <button onClick={() => run('actions.find')}>Find</button>
        <button onClick={() => run('editor.action.startFindReplaceAction')}>Replace</button>
        <button onClick={() => run('editor.action.revealDefinition')}>Go to definition</button>
        <button
          onClick={() => {
            view.current?.focus();
            view.current?.trigger('workbench', 'editor.action.triggerSuggest', {});
          }}
        >
          Completions
        </button>
      </div>
      <div ref={container} className="monaco-host" />
      <small className="editor-position">
        Ln {position.lineNumber}, Col {position.column}
      </small>
      {error && <p role="alert">{error}</p>}
      <details className="editor-problems">
        <summary>Problems ({problems.length})</summary>
        <small>
          TypeScript/JavaScript/JSON services run locally. Relative imports are bounded; external
          language servers and project build diagnostics are separate.
        </small>
        {problems.map((p, i) => (
          <button
            key={i}
            onClick={() => {
              view.current?.setPosition({ lineNumber: p.startLineNumber, column: p.startColumn });
              view.current?.revealLineInCenter(p.startLineNumber);
              view.current?.focus();
            }}
          >
            {p.startLineNumber}:{p.startColumn} · {p.message}
          </button>
        ))}
      </details>
    </div>
  );
}
