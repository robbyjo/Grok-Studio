import { safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export class Credentials {
  private file: string;
  private session?: string;
  constructor(root: string) {
    this.file = join(root, 'xai-api-key.bin');
  }
  status() {
    return {
      saved: existsSync(this.file),
      session: Boolean(this.session),
      environment: Boolean(process.env.XAI_API_KEY),
      encryptedStorage: safeStorage.isEncryptionAvailable(),
    };
  }
  save(key: string, remember: boolean) {
    if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n\0]/.test(key))
      throw new Error('Enter a valid xAI API key in this local window.');
    if (remember) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('Encrypted credential storage is unavailable. Use session-only storage.');
      writeFileSync(this.file, safeStorage.encryptString(key.trim()), { mode: 0o600 });
    } else if (existsSync(this.file)) unlinkSync(this.file);
    this.session = key.trim();
  }
  forget() {
    this.session = undefined;
    if (existsSync(this.file)) unlinkSync(this.file);
  }
  environment(mode: string) {
    const env = { ...process.env };
    if (mode === 'oauth') {
      delete env.XAI_API_KEY;
      delete env.GROK_CODE_XAI_API_KEY;
      return env;
    }
    let key = this.session;
    if (!key && existsSync(this.file)) {
      try {
        key = safeStorage.decryptString(readFileSync(this.file));
      } catch {
        throw new Error(
          'The saved API key cannot be decrypted on this Windows account/machine. Re-enter it locally or choose OAuth.',
        );
      }
    }
    if (key) env.XAI_API_KEY = key;
    if (mode === 'api' && !env.XAI_API_KEY && !env.GROK_CODE_XAI_API_KEY)
      throw new Error('Enter an API key in Settings or choose OAuth.');
    return env;
  }
}
