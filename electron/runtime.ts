import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const grokProfile = () => process.env.GROK_HOME || join(homedir(), '.grok');
export function embeddedEngine(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const bundled = resources ? join(resources, 'engine', 'studio-engine.node') : undefined;
  const candidate =
    bundled && existsSync(bundled)
      ? bundled
      : join(process.cwd(), '.runtime', 'studio-engine.node');
  if (!existsSync(candidate))
    throw new Error('Built-in engine is missing. Run npm run engine:build for a source checkout.');
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
