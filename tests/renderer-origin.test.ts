import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { rendererUrlMatches } from '../electron/renderer-origin';

test('renderer origin accepts equivalent tilde/Unicode file encoding but rejects other sources', () => {
  const path = resolve(tmpdir(), 'GROKST~1', 'spaces and ü %', 'index.html');
  const encoded = pathToFileURL(path).href;
  assert.equal(rendererUrlMatches(encoded, path), true);
  assert.equal(rendererUrlMatches(encoded.replaceAll('%7E', '~'), path), true);
  assert.equal(rendererUrlMatches(encoded.replace('index.html', 'other.html'), path), false);
  assert.equal(rendererUrlMatches(encoded + '?query=1', path), false);
  assert.equal(rendererUrlMatches(encoded + '#fragment', path), false);
  assert.equal(rendererUrlMatches('https://example.invalid/index.html', path), false);
  assert.equal(rendererUrlMatches('data:text/html,untrusted', path), false);
  assert.equal(rendererUrlMatches(encoded.replace('index.html', '%2Findex.html'), path), false);
  assert.equal(rendererUrlMatches('invalid URL', path), false);
});
