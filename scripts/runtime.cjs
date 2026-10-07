const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const version = '1.0.46';
const expected = 'e09c0893cee4850a569bd90e7aed956ea503b34f551637d58187ca4dfb931611';
async function main() {
  const file = path.resolve('.runtime/grok.exe');
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://x.ai/cli/grok-${version}-windows-x86_64.exe`, {
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Grok runtime SHA-256 does not match the pinned release. Packaging stopped.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  console.log(`Verified official Grok ${version} Windows x64 runtime (${expected}).`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
