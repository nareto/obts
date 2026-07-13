import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ServerConfig = {
  dataDir: string;
  gitStoreDir: string;
  tempDir: string;
  publicBaseUrl: string;
  sessionSecret: string;
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  gitBinary: string;
  maxUploadBytes: number;
  diagnosticIngestEnabled: boolean;
  diagnosticRetentionDays: number;
};

export function createServerConfig(overrides: Partial<ServerConfig> & { dataDir: string }): ServerConfig {
  const publicBaseUrl = overrides.publicBaseUrl ?? 'http://127.0.0.1:0';
  const sessionCookieSecure = overrides.sessionCookieSecure ?? publicBaseUrl.startsWith('https://');
  const diagnosticRetentionDays = overrides.diagnosticRetentionDays ?? 14;
  if (!Number.isSafeInteger(diagnosticRetentionDays) || diagnosticRetentionDays < 1 || diagnosticRetentionDays > 90) {
    throw new Error('Diagnostic retention must be an integer from 1 to 90 days.');
  }
  return {
    dataDir: overrides.dataDir,
    gitStoreDir: overrides.gitStoreDir ?? join(overrides.dataDir, 'git'),
    tempDir: overrides.tempDir ?? join(overrides.dataDir, 'tmp'),
    publicBaseUrl,
    sessionSecret: overrides.sessionSecret ?? 'dev-only-session-secret-change-me',
    sessionCookieName: overrides.sessionCookieName ?? (sessionCookieSecure ? '__Host-obts_session' : 'obts_session'),
    sessionCookieSecure,
    gitBinary: overrides.gitBinary ?? 'git',
    maxUploadBytes: overrides.maxUploadBytes ?? 104_857_600,
    diagnosticIngestEnabled: overrides.diagnosticIngestEnabled ?? false,
    diagnosticRetentionDays
  };
}

export async function ensureServerDirectories(config: ServerConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.gitStoreDir, { recursive: true, mode: 0o700 });
  await mkdir(config.tempDir, { recursive: true, mode: 0o700 });
}
