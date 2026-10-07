import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath as filePath } from 'node:url';
import { History } from '../electron/history';
import { Media, mediaType, generation } from '../electron/media';
test('media retains original binary files, scoped URLs, range playback and explicit deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'studio-media-'));
  const history = new History(join(root, 'history.sqlite'), 64);
  const media = new Media(join(root, 'assets'), history);
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lFEAAAAASUVORK5CYII=',
      'base64',
    );
    const image = media.add(png, 'photo.png', 'attachment'),
      attached = media.attachment(image.id);
    assert.equal(attached.mimeType, 'image/png');
    assert.equal(attached.data, png.toString('base64'));
    assert.ok(attached.uri.endsWith('.png'));
    assert.equal(
      (await media.response(new Request(image.url))).headers.get('content-type'),
      'image/png',
    );
    const range = await media.response(new Request(image.url, { headers: { range: 'bytes=2-7' } }));
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(2, 8));
    assert.equal(
      (await media.response(new Request(image.url, { headers: { range: 'bytes=999-' } }))).status,
      416,
    );
    assert.equal(
      (await media.response(new Request('grok-media://asset/../../state.json'))).status,
      404,
    );
    const binary = media.add(Buffer.from([0, 1, 2, 3]), 'data.bin', 'attachment');
    assert.equal(media.attachment(binary.id).data, undefined);
    assert.equal((await media.response(new Request(binary.url))).status, 415);
    const reopened = new Media(join(root, 'assets'), history);
    assert.equal(reopened.list().length, 2);
    assert.deepEqual(reopened.bytes(binary.id), Buffer.from([0, 1, 2, 3]));
    media.delete(image.id);
    assert.equal(existsSync(filePath(attached.uri)), false);
    assert.equal((await media.response(new Request(image.url))).status, 404);
    assert.throws(() => generation({ kind: 'audio', prompt: 'text', duration: 100 }), /settings/);
    assert.equal(mediaType(Buffer.from('Hello 世界'), 'note.txt'), 'text/plain');
  } finally {
    history.db.close();
  }
});
