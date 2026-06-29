import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ServerConfig = {
  dataDir: string;
  gitStoreDir: string;
  tempDir: string;
  publicBaseUrl: string;
  sessionSecret: string;
  gitBinary: string;
  maxUploadBytes: number;
};

export function createServerConfig(overrides: Partial<ServerConfig> & { dataDir: string }): ServerConfig {
  return {
    dataDir: overrides.dataDir,
    gitStoreDir: overrides.gitStoreDir ?? join(overrides.dataDir, 'git'),
    tempDir: overrides.tempDir ?? join(overrides.dataDir, 'tmp'),
    publicBaseUrl: overrides.publicBaseUrl ?? 'http://127.0.0.1:0',
    sessionSecret: overrides.sessionSecret ?? 'dev-only-session-secret-change-me',
    gitBinary: overrides.gitBinary ?? 'git',
    maxUploadBytes: overrides.maxUploadBytes ?? 104_857_600
  };
}

export async function ensureServerDirectories(config: ServerConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.gitStoreDir, { recursive: true, mode: 0o700 });
  await mkdir(config.tempDir, { recursive: true, mode: 0o700 });
}
