import { fileURLToPath } from 'node:url';

export function rendererUrlMatches(actual: string, expectedPath: string): boolean {
  try {
    const url = new URL(actual);
    return (
      url.protocol === 'file:' && !url.search && !url.hash && fileURLToPath(url) === expectedPath
    );
  } catch {
    return false;
  }
}
