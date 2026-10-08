import Prism from 'prismjs';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/themes/prism-tomorrow.css';
const extensions: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  json: 'json',
  sh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  html: 'markup',
  svg: 'markup',
  css: 'css',
};
export function highlight(text: string, path: string) {
  const language = extensions[path.split('.').pop()?.toLowerCase() ?? ''];
  if (text.length > 100000 || !Prism.languages[language]) return undefined;
  return Prism.highlight(text.replace(/\r\n/g, '\n') + '\n', Prism.languages[language], language);
}
