import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
  if (selected !== 'bundled') return selected;
  const executable = bundledRuntime();
  if (!existsSync(executable))
    throw new Error('Bundled Grok runtime is missing. Select a Grok executable in Settings.');
  return executable;
}
