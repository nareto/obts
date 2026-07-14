import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ServerConfig = {
  dataDir: string;
  gitStoreDir: string;
  tempDir: string;
  transferDir: string;
  publicBaseUrl: string;
  sessionSecret: string;
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  gitBinary: string;
  maxUploadBytes: number;
  transferChunkBytes: number;
  maxTransferBytes: number;
  maxTransferChunks: number;
  maxTransferStorageBytes: number;
  transferTtlSeconds: number;
  diagnosticIngestEnabled: boolean;
  diagnosticRetentionDays: number;
};

export function createServerConfig(overrides: Partial<ServerConfig> & { dataDir: string }): ServerConfig {
  const publicBaseUrl = overrides.publicBaseUrl ?? 'http://127.0.0.1:0';
  const sessionCookieSecure = overrides.sessionCookieSecure ?? publicBaseUrl.startsWith('https://');
  const diagnosticRetentionDays = overrides.diagnosticRetentionDays ?? 14;
  const transferChunkBytes = overrides.transferChunkBytes ?? 16_777_216;
  const maxTransferBytes = overrides.maxTransferBytes ?? 2_147_483_648;
  const maxTransferChunks = overrides.maxTransferChunks ?? 4096;
  const maxTransferStorageBytes = overrides.maxTransferStorageBytes ?? 4_294_967_296;
  const transferTtlSeconds = overrides.transferTtlSeconds ?? 86_400;
  if (!Number.isSafeInteger(transferChunkBytes) || transferChunkBytes < 1_048_576 || transferChunkBytes > 33_554_432) {
    throw new Error('Transfer chunk bytes must be an integer from 1048576 to 33554432.');
  }
  if (!Number.isSafeInteger(maxTransferBytes) || maxTransferBytes < transferChunkBytes || maxTransferBytes > 8_589_934_592) {
    throw new Error('Maximum transfer bytes must be an integer between the chunk size and 8589934592.');
  }
  if (!Number.isSafeInteger(maxTransferChunks) || maxTransferChunks < 1 || maxTransferChunks > 16384) {
    throw new Error('Maximum transfer chunks must be an integer from 1 to 16384.');
  }
  if (!Number.isSafeInteger(maxTransferStorageBytes) || maxTransferStorageBytes < maxTransferBytes || maxTransferStorageBytes > 17_179_869_184) {
    throw new Error('Transfer storage bytes must be an integer between the per-transfer cap and 17179869184.');
  }
  if (!Number.isSafeInteger(transferTtlSeconds) || transferTtlSeconds < 300 || transferTtlSeconds > 604800) {
    throw new Error('Transfer TTL must be an integer from 300 to 604800 seconds.');
  }
  if (!Number.isSafeInteger(diagnosticRetentionDays) || diagnosticRetentionDays < 1 || diagnosticRetentionDays > 90) {
    throw new Error('Diagnostic retention must be an integer from 1 to 90 days.');
  }
  return {
    dataDir: overrides.dataDir,
    gitStoreDir: overrides.gitStoreDir ?? join(overrides.dataDir, 'git'),
    tempDir: overrides.tempDir ?? join(overrides.dataDir, 'tmp'),
    transferDir: overrides.transferDir ?? join(overrides.dataDir, 'transfers'),
    publicBaseUrl,
    sessionSecret: overrides.sessionSecret ?? 'dev-only-session-secret-change-me',
    sessionCookieName: overrides.sessionCookieName ?? (sessionCookieSecure ? '__Host-obts_session' : 'obts_session'),
    sessionCookieSecure,
    gitBinary: overrides.gitBinary ?? 'git',
    maxUploadBytes: overrides.maxUploadBytes ?? 104_857_600,
    transferChunkBytes,
    maxTransferBytes,
    maxTransferChunks,
    maxTransferStorageBytes,
    transferTtlSeconds,
    diagnosticIngestEnabled: overrides.diagnosticIngestEnabled ?? false,
    diagnosticRetentionDays
  };
}

export async function ensureServerDirectories(config: ServerConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.gitStoreDir, { recursive: true, mode: 0o700 });
  await mkdir(config.tempDir, { recursive: true, mode: 0o700 });
  await mkdir(config.transferDir, { recursive: true, mode: 0o700 });
}
