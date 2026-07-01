#!/usr/bin/env node
import { join } from 'node:path';
import process from 'node:process';

import { newId, newSecretToken, nowIso } from './shared/ids.js';
import type { SyncProfile } from './shared/types.js';
import { readSyncProfile } from './shared/validators.js';
import { ownedVaultOrThrow, hashPassword, hashToken } from './server/authService.js';
import { createObtsServer, type ObtsServer } from './server/app.js';
import type { ServerConfig } from './server/config.js';

type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type CliEnv = Record<string, string | undefined>;

type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | boolean>;
};

const HELP = `obts Phase 1 CLI

Usage:
  obts serve [--host 0.0.0.0] [--port 3000]
  obts health live|ready [--json]
  obts setup --username USER --password PASSWORD [--display-name NAME] [--json]
  obts vault create --username USER --password PASSWORD --display-name NAME [--json]
  obts pairing-token create --username USER --password PASSWORD --vault-id ID --device-name NAME --sync-profile PROFILE [--sync-plugins] [--json]
  obts devices list --username USER --password PASSWORD --vault-id ID [--json]
  obts conflicts list --username USER --password PASSWORD --vault-id ID [--status open|resolved|all] [--json]
  obts admin-recovery create-reset-token --username USER [--enable-user] [--json]
  obts admin-recovery create-admin --username USER --password PASSWORD [--display-name NAME] [--json]

Environment:
  OBTS_DATA_DIR             Persistent state root. Defaults to ./.obts-server.
  OBTS_GIT_STORE_DIR        Optional Git store override. Defaults to $OBTS_DATA_DIR/git.
  OBTS_TEMP_DIR             Optional temp workspace override. Defaults to $OBTS_DATA_DIR/tmp.
  OBTS_PUBLIC_BASE_URL      Public server URL used in pairing links.
  OBTS_SESSION_SECRET       Dashboard/API session signing secret.
  OBTS_GIT_BINARY           Native git executable. Defaults to git.
  OBTS_MAX_UPLOAD_BYTES     Upload limit in bytes. Defaults to 104857600.
  OBTS_HOST                 Serve host. Defaults to 0.0.0.0.
  OBTS_PORT                 Serve port. Defaults to 3000.
`;

export async function runCli(
  argv = process.argv.slice(2),
  env: CliEnv = process.env,
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  }
): Promise<number> {
  const parsed = parseArgs(argv);
  const [command, subcommand, action] = parsed.positionals;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(HELP);
    return 0;
  }

  let server: ObtsServer | null = null;
  try {
    server = await createObtsServer(configFromEnv(env));
    if (command === 'serve') {
      const host = stringOption(parsed, 'host') ?? env.OBTS_HOST ?? '0.0.0.0';
      const port = integerOption(parsed, 'port') ?? integerEnv(env.OBTS_PORT, 'OBTS_PORT') ?? 3000;
      const address = await server.app.listen({ host, port });
      io.stdout(`obts server listening on ${address}\n`);
      await waitForShutdown(server);
      return 0;
    }

    if (command === 'health') {
      const target = subcommand ?? 'ready';
      if (target !== 'live' && target !== 'ready') {
        throw new CliUsageError('health target must be live or ready.');
      }
      const response = await server.app.inject({ method: 'GET', url: target === 'live' ? '/health/live' : '/health/ready' });
      const body = JSON.parse(response.body) as Record<string, unknown>;
      writeResult(io, parsed, body, target === 'ready' && response.statusCode !== 200 ? `not ready: ${body.detail ?? 'unknown'}\n` : `${body.status}\n`);
      return response.statusCode === 200 ? 0 : 1;
    }

    if (command === 'setup') {
      const setupInput = {
        username: requiredString(parsed, 'username'),
        password: requiredString(parsed, 'password')
      };
      const displayName = stringOption(parsed, 'display-name');
      const result = await server.auth.setupInitialAdmin(
        displayName === undefined ? setupInput : { ...setupInput, displayName }
      );
      writeResult(
        io,
        parsed,
        {
          user_id: result.user.user_id,
          csrf_token: result.csrfToken,
          recent_auth_expires_at: result.recentAuthExpiresAt
        },
        `created initial admin ${result.user.username} (${result.user.user_id})\n`
      );
      return 0;
    }

    if (command === 'vault' && subcommand === 'create') {
      const user = await loginForCli(server, parsed);
      const displayName = requiredString(parsed, 'display-name');
      const vaultId = newId('vlt');
      const rootCommit = await server.git.initializeVault(vaultId);
      const vault = await server.store.mutate((db) => {
        const timestamp = nowIso();
        const row = {
          vault_id: vaultId,
          owner_user_id: user.user_id,
          display_name: displayName,
          status: 'active' as const,
          current_main: rootCommit,
          created_at: timestamp,
          updated_at: timestamp
        };
        db.vaults.push(row);
        db.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: user.user_id,
          actor_device_id: null,
          vault_id: vaultId,
          action: 'vault_created',
          resource_class: 'vault',
          resource_id: vaultId,
          created_at: timestamp
        });
        server!.store.appendEvent(db, {
          event_type: 'main_advanced',
          vault_id: vaultId,
          resource_ids: { vault_id: vaultId },
          commit_cursors: { main: rootCommit, previous_main: null },
          payload: { reason: 'empty_root' }
        });
        return row;
      });
      writeResult(io, parsed, vault, `created vault ${vault.display_name} (${vault.vault_id}) at ${vault.current_main}\n`);
      return 0;
    }

    if (command === 'pairing-token' && subcommand === 'create') {
      const user = await loginForCli(server, parsed);
      const syncProfile = readCliSyncProfile(requiredString(parsed, 'sync-profile'));
      const result = await server.auth.createPairingToken({
        userId: user.user_id,
        vaultId: requiredString(parsed, 'vault-id'),
        deviceName: requiredString(parsed, 'device-name'),
        syncProfile,
        syncPlugins: booleanOption(parsed, 'sync-plugins'),
        publicBaseUrl: server.config.publicBaseUrl
      });
      writeResult(
        io,
        parsed,
        {
          pairing_token: result.token,
          pairing_url: result.pairingUrl,
          expires_at: result.expiresAt
        },
        `pairing token expires at ${result.expiresAt}\n${result.pairingUrl}\n`
      );
      return 0;
    }

    if (command === 'devices' && subcommand === 'list') {
      const user = await loginForCli(server, parsed);
      const vaultId = requiredString(parsed, 'vault-id');
      const db = await server.store.snapshot();
      ownedVaultOrThrow(db, user.user_id, vaultId);
      const devices = db.devices
        .filter((device) => device.vault_id === vaultId && device.user_id === user.user_id)
        .map((device) => ({
          device_id: device.device_id,
          device_name: device.device_name,
          status: device.status,
          sync_profile: device.sync_profile,
          sync_plugins: device.sync_plugins,
          device_ref_head: device.device_ref_head,
          last_applied_main: device.last_applied_main,
          last_seen_at: device.last_seen_at,
          last_successful_sync_at: device.last_successful_sync_at,
          revoked_at: device.revoked_at
        }));
      writeResult(io, parsed, { devices }, table(devices, ['device_name', 'status', 'sync_profile', 'last_seen_at', 'device_id']));
      return 0;
    }

    if (command === 'conflicts' && subcommand === 'list') {
      const user = await loginForCli(server, parsed);
      const vaultId = requiredString(parsed, 'vault-id');
      const status = stringOption(parsed, 'status') ?? 'open';
      if (!['open', 'resolved', 'all'].includes(status)) {
        throw new CliUsageError('--status must be open, resolved, or all.');
      }
      const db = await server.store.snapshot();
      ownedVaultOrThrow(db, user.user_id, vaultId);
      const conflicts = db.conflicts
        .filter((conflict) => conflict.vault_id === vaultId && (status === 'all' || conflict.status === status))
        .map((conflict) => ({
          conflict_id: conflict.conflict_id,
          status: conflict.status,
          device_id: conflict.device_id,
          affected_paths: conflict.affected_paths,
          merge_sequence: conflict.merge_sequence,
          current_main: conflict.current_main,
          device_commit: conflict.device_commit,
          created_at: conflict.created_at
        }));
      writeResult(io, parsed, { conflicts }, table(conflicts, ['status', 'created_at', 'device_id', 'conflict_id']));
      return 0;
    }

    if (command === 'admin-recovery' && subcommand === 'create-reset-token') {
      const username = requiredString(parsed, 'username');
      const resetToken = newSecretToken('obts_reset');
      const tokenHash = hashToken(resetToken);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const result = await server.store.mutate((db) => {
        const user = db.users.find((candidate) => candidate.username === username);
        if (!user || !user.is_admin) {
          throw new CliUsageError('local admin recovery requires an existing admin username.');
        }
        const timestamp = nowIso();
        if (booleanOption(parsed, 'enable-user')) {
          user.disabled = false;
        }
        for (const token of db.tokens) {
          if (token.kind === 'password_reset' && token.user_id === user.user_id && !token.revoked_at && !token.consumed_at) {
            token.revoked_at = timestamp;
          }
        }
        db.tokens.push({
          token_id: newId('tok'),
          kind: 'password_reset',
          lookup_prefix: tokenHash.lookupPrefix,
          token_hash: tokenHash.hash,
          user_id: user.user_id,
          vault_id: null,
          device_id: null,
          expires_at: expiresAt,
          consumed_at: null,
          failed_attempts: 0,
          revoked_at: null,
          metadata: { created_by: 'local_admin_recovery' },
          created_at: timestamp
        });
        db.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: null,
          actor_device_id: null,
          vault_id: null,
          action: 'local_admin_recovery_token_created',
          resource_class: 'user',
          resource_id: user.user_id,
          created_at: timestamp
        });
        return { user_id: user.user_id, username: user.username, reset_token: resetToken, expires_at: expiresAt };
      });
      writeResult(io, parsed, result, `reset token for ${result.username} expires at ${result.expires_at}\n${result.reset_token}\n`);
      return 0;
    }

    if (command === 'admin-recovery' && subcommand === 'create-admin') {
      const username = requiredString(parsed, 'username');
      const password = requiredString(parsed, 'password');
      if (password.length < 12) {
        throw new CliUsageError('admin recovery password must be at least 12 characters.');
      }
      const displayName = stringOption(parsed, 'display-name') ?? username;
      const result = await server.store.mutate(async (db) => {
        if (db.users.some((user) => user.is_admin && !user.disabled)) {
          throw new CliUsageError('local admin creation is allowed only when no enabled admin account exists.');
        }
        if (db.users.some((user) => user.username === username)) {
          throw new CliUsageError('username already exists.');
        }
        const timestamp = nowIso();
        const user = {
          user_id: newId('usr'),
          username,
          display_name: displayName,
          password_hash: await hashPassword(password),
          is_admin: true,
          disabled: false,
          created_at: timestamp,
          last_login_at: null
        };
        db.users.push(user);
        db.setup_complete = true;
        db.audit_log.push({
          audit_id: newId('aud'),
          actor_user_id: null,
          actor_device_id: null,
          vault_id: null,
          action: 'local_admin_recovery_admin_created',
          resource_class: 'user',
          resource_id: user.user_id,
          created_at: timestamp
        });
        return {
          user_id: user.user_id,
          username: user.username,
          display_name: user.display_name,
          is_admin: user.is_admin,
          disabled: user.disabled,
          created_at: user.created_at
        };
      });
      writeResult(io, parsed, result, `created recovery admin ${result.username} (${result.user_id})\n`);
      return 0;
    }

    if (action) {
      throw new CliUsageError(`unknown command: ${command} ${subcommand ?? ''} ${action}`.trim());
    }
    throw new CliUsageError(`unknown command: ${command}${subcommand ? ` ${subcommand}` : ''}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n\n${HELP}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    io.stderr(`obts: ${message}\n`);
    return 1;
  } finally {
    if (server && command !== 'serve') {
      await server.app.close();
    }
  }
}

function configFromEnv(env: CliEnv): Partial<ServerConfig> & { dataDir: string } {
  return {
    dataDir: env.OBTS_DATA_DIR ?? join(process.cwd(), '.obts-server'),
    ...(env.OBTS_GIT_STORE_DIR ? { gitStoreDir: env.OBTS_GIT_STORE_DIR } : {}),
    ...(env.OBTS_TEMP_DIR ? { tempDir: env.OBTS_TEMP_DIR } : {}),
    ...(env.OBTS_PUBLIC_BASE_URL ? { publicBaseUrl: env.OBTS_PUBLIC_BASE_URL } : {}),
    ...(env.OBTS_SESSION_SECRET ? { sessionSecret: env.OBTS_SESSION_SECRET } : {}),
    ...(env.OBTS_GIT_BINARY ? { gitBinary: env.OBTS_GIT_BINARY } : {}),
    ...(env.OBTS_MAX_UPLOAD_BYTES ? { maxUploadBytes: parseInteger(env.OBTS_MAX_UPLOAD_BYTES, 'OBTS_MAX_UPLOAD_BYTES') } : {})
  };
}

async function loginForCli(server: ObtsServer, parsed: ParsedArgs) {
  const result = await server.auth.login({
    username: requiredString(parsed, 'username'),
    password: requiredString(parsed, 'password'),
    sourceIp: 'cli'
  });
  return result.user;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      options[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[withoutPrefix] = next;
      index += 1;
    } else {
      options[withoutPrefix] = true;
    }
  }
  return { positionals, options };
}

function requiredString(parsed: ParsedArgs, name: string): string {
  const value = stringOption(parsed, name);
  if (!value) {
    throw new CliUsageError(`missing required option --${name}.`);
  }
  return value;
}

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

function booleanOption(parsed: ParsedArgs, name: string): boolean {
  const value = parsed.options[name];
  if (typeof value === 'boolean') {
    return value;
  }
  return value === 'true';
}

function integerOption(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringOption(parsed, name);
  return value === undefined ? undefined : parseInteger(value, name);
}

function integerEnv(value: string | undefined, name: string): number | undefined {
  return value === undefined ? undefined : parseInteger(value, name);
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new CliUsageError(`${name} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readCliSyncProfile(value: string): SyncProfile {
  return readSyncProfile({ sync_profile: value }, 'sync_profile');
}

function writeResult(io: CliIo, parsed: ParsedArgs, json: unknown, text: string): void {
  if (booleanOption(parsed, 'json')) {
    io.stdout(`${JSON.stringify(json, null, 2)}\n`);
  } else {
    io.stdout(text);
  }
}

function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) {
    return 'No rows.\n';
  }
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => formatCell(row[column]).length))
  );
  const header = columns.map((column, index) => column.padEnd(widths[index]!)).join('  ');
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');
  const body = rows
    .map((row) => columns.map((column, index) => formatCell(row[column]).padEnd(widths[index]!)).join('  '))
    .join('\n');
  return `${header}\n${separator}\n${body}\n`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.join(',');
  }
  return String(value);
}

async function waitForShutdown(server: ObtsServer): Promise<void> {
  await new Promise<void>((resolve) => {
    const close = (): void => {
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      void server.app.close().then(resolve, resolve);
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
  });
}

class CliUsageError extends Error {}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runCli();
  process.exitCode = code;
}
