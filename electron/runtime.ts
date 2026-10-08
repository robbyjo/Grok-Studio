import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const grokProfile = () => process.env.GROK_HOME || join(homedir(), '.grok');
let engineVerified: string;
export function embeddedEngine(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundled = resources ? join(resources, 'engine', 'studio-engine.node') : undefined;
  const candidate =
    bundled && existsSync(bundled)
      ? bundled
      : join(process.cwd(), '.runtime', 'studio-engine.node');
  if (!existsSync(candidate))
    throw new Error('Built-in engine is missing. Run npm run engine:build for a source checkout.');
  const info = statSync(candidate),
    identity = `${candidate}:${info.size}:${info.mtimeMs}`;
  if (engineVerified !== identity) {
    const metadata =
      bundled && candidate === bundled
        ? join(resources!, 'engine/notices/engine.json')
        : join(process.cwd(), '.runtime/engine.json');
    const value = JSON.parse(readFileSync(metadata, 'utf8'));
    if (
      value.bindingVersion !== '0.6.0' ||
      value.platform !== 'win32-x64' ||
      value.revision !== '2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8' ||
      createHash('sha256').update(readFileSync(candidate)).digest('hex') !== value.sha256
    )
      throw new Error(
        'Built-in engine version/checksum is incompatible. Restore a matching Workbench package.',
      );
    engineVerified = identity;
  }
  return candidate;
}

export function desktopDataDirectory(env: NodeJS.ProcessEnv, appData?: string): string | undefined {
  return (
    env.GROK_DESKTOP_DATA_DIR ||
    (env.PORTABLE_EXECUTABLE_DIR
      ? join(env.PORTABLE_EXECUTABLE_DIR, 'Grok Desktop Data')
      : appData
        ? join(appData, 'grok-desktop')
        : undefined)
  );
}

export function bundledRuntime(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return resources
    ? join(resources, 'runtime', 'grok.exe')
    : join(process.cwd(), '.runtime', 'grok.exe');
}

export function runtimeExecutable(selected: string): string {
  if (selected === 'embedded') return embeddedEngine();
  if (selected !== 'bundled') return selected;
  const executable = bundledRuntime();
  if (!existsSync(executable))
    throw new Error('Bundled Grok runtime is missing. Select a Grok executable in Settings.');
  return executable;
}
