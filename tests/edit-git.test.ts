import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  link,
  readdir,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDocument, saveDocument } from '../electron/editor';
import { git, gitState } from '../electron/workspace';
import { changeIndex, commitIndex, fileDiff, parseChanges } from '../electron/git-actions';

test('editor atomically saves UTF-8/BOM/CRLF, rejects changed content and leaves no temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-editor-'));
  const path = join(root, 'file.txt');
  await writeFile(path, '\ufeffHello 世界\r\n');
  const first = await openDocument(root, 'file.txt');
  assert.equal(first.text, '\ufeffHello 世界\r\n');
  const saved = await saveDocument(root, 'file.txt', '\ufeffEdited 🌍\r\n', first.revision);
  assert.equal(await readFile(path, 'utf8'), saved.text);
  assert.notEqual(saved.revision, first.revision);
  await assert.rejects(saveDocument(root, 'file.txt', '\ud800', saved.revision), /invalid Unicode/);
  assert.equal(await readFile(path, 'utf8'), saved.text);
  await writeFile(path, 'Changed by another process');
  await assert.rejects(
    saveDocument(root, 'file.txt', 'overwrite', saved.revision),
    /changed on disk/,
  );
  assert.equal(await readFile(path, 'utf8'), 'Changed by another process');
  assert.deepEqual(await readdir(root), ['file.txt']);
});
test('editor rejects traversal, external symlinks, hardlinks, Git metadata, binary and invalid UTF-8', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'grok-editor-path-')),
    root = join(folder, 'project');
  await mkdir(root);
  const outside = join(folder, 'private.txt');
  await writeFile(outside, 'private');
  await symlink(folder, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openDocument(root, '../private.txt'), /leaves/);
  await assert.rejects(saveDocument(root, 'escape/private.txt', 'bad', 'a'.repeat(64)), /leaves/);
  await link(outside, join(root, 'hardlink.txt'));
  await assert.rejects(openDocument(root, 'hardlink.txt'), /Hard-linked/);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git/config'), 'metadata');
  await assert.rejects(openDocument(root, '.git/config'), /metadata/);
  await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1]));
  await assert.rejects(openDocument(root, 'binary.txt'), /Binary/);
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x61]));
  await assert.rejects(openDocument(root, 'invalid.txt'));
  await writeFile(join(root, 'large.txt'), 'a'.repeat(1024 * 1024 + 1));
  await assert.rejects(openDocument(root, 'large.txt'), /1 MiB/);
  assert.equal(await readFile(outside, 'utf8'), 'private');
});
test('Git porcelain parser handles renames and filenames with spaces/newlines without splitting paths', () => {
  assert.deepEqual(
    parseChanges('R  new name.txt\0old name.txt\0?? line\nbreak.txt\0UU conflicted.txt\0'),
    [
      {
        path: 'new name.txt',
        originalPath: 'old name.txt',
        index: 'R',
        worktree: ' ',
        conflicted: false,
      },
      {
        path: 'line\nbreak.txt',
        originalPath: undefined,
        index: '?',
        worktree: '?',
        conflicted: false,
      },
      {
        path: 'conflicted.txt',
        originalPath: undefined,
        index: 'U',
        worktree: 'U',
        conflicted: true,
      },
    ],
  );
});
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'grok-index-'));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  return root;
}
test('file staging is literal, unstaging preserves edits, commits require the reviewed index and retain unstaged work', async () => {
  const root = await repository();
  for (const name of ['[x].txt', 'x.txt']) await writeFile(join(root, name), 'original\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'baseline']);
  await writeFile(join(root, '[x].txt'), 'reviewed\n');
  await writeFile(join(root, 'x.txt'), 'other\n');
  let state = await gitState(root);
  assert.equal(state.files.length, 2);
  assert.match(await fileDiff(root, '[x].txt', false), /\+reviewed/);
  await changeIndex(root, 'stage', '[x].txt', state.indexRevision);
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '[x].txt\n');
  await assert.rejects(changeIndex(root, 'stage', 'x.txt', state.indexRevision), /index changed/);
  state = await gitState(root);
  await changeIndex(root, 'unstage', '[x].txt', state.indexRevision);
  assert.equal(await readFile(join(root, '[x].txt'), 'utf8'), 'reviewed\n');
  state = await gitState(root);
  await changeIndex(root, 'stage', '[x].txt', state.indexRevision);
  state = await gitState(root);
  await writeFile(join(root, '[x].txt'), 'still unstaged\n');
  const id = await commitIndex(root, 'Commit reviewed stage', state.indexRevision);
  assert.equal(id, (await git(root, ['rev-parse', 'HEAD'])).trim());
  assert.equal(await git(root, ['show', 'HEAD:[x].txt']), 'reviewed\n');
  assert.equal(await readFile(join(root, '[x].txt'), 'utf8'), 'still unstaged\n');
  assert.equal(await readFile(join(root, 'x.txt'), 'utf8'), 'other\n');
  await assert.rejects(
    changeIndex(root, 'stage', '../private.txt', (await gitState(root)).indexRevision),
    /inside/,
  );
});
test('Git supports unborn index unstage and staged rename unstage without deleting working files', async () => {
  const root = await repository();
  await writeFile(join(root, 'old.txt'), 'text');
  let state = await gitState(root);
  assert.equal(state.indexRevision, 'absent');
  await changeIndex(root, 'stage', 'old.txt', state.indexRevision);
  state = await gitState(root);
  await changeIndex(root, 'unstage', 'old.txt', state.indexRevision);
  assert.equal(await readFile(join(root, 'old.txt'), 'utf8'), 'text');
  state = await gitState(root);
  await changeIndex(root, 'stage', 'old.txt', state.indexRevision);
  await commitIndex(root, 'Initial commit', (await gitState(root)).indexRevision);
  await rename(join(root, 'old.txt'), join(root, 'new name.txt'));
  await git(root, ['add', '.']);
  state = await gitState(root);
  assert.equal(state.files[0].originalPath, 'old.txt');
  await changeIndex(root, 'unstage', 'new name.txt', state.indexRevision);
  assert.equal(await git(root, ['diff', '--cached', '--name-only']), '');
  assert.equal(await readFile(join(root, 'new name.txt'), 'utf8'), 'text');
});
test('commit refuses conflicts and staged files outside a selected nested workspace', async () => {
  const root = await repository(),
    nested = join(root, 'nested');
  await mkdir(nested);
  await writeFile(join(root, 'outside.txt'), 'base');
  await writeFile(join(nested, 'inside.txt'), 'base');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'baseline']);
  await writeFile(join(root, 'outside.txt'), 'outside');
  await writeFile(join(nested, 'inside.txt'), 'inside');
  await git(root, ['add', '.']);
  const state = await gitState(nested);
  assert.equal(state.files.length, 1);
  assert.ok(!state.diff.includes('outside'));
  assert.ok(!state.staged.includes('outside'));
  await assert.rejects(
    commitIndex(nested, 'Must not commit outside', state.indexRevision),
    /outside/,
  );
  await git(root, ['reset', '--hard', 'HEAD']);
  await git(root, ['checkout', '-b', 'other']);
  await writeFile(join(root, 'outside.txt'), 'other');
  await git(root, ['commit', '-am', 'other']);
  await git(root, ['checkout', 'main']);
  await writeFile(join(root, 'outside.txt'), 'main');
  await git(root, ['commit', '-am', 'main']);
  await assert.rejects(git(root, ['merge', 'other']));
  const conflict = await gitState(root);
  assert.equal(conflict.files[0].conflicted, true);
  await assert.rejects(commitIndex(root, 'Must resolve', conflict.indexRevision), /conflicts/);
});
