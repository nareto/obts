export const API_VERSION = '2026-06-29.phase1';

export type SyncProfile = 'notes_only' | 'notes_plus_attachments' | 'full_vault_config';

export type StatusLabel =
  | 'Synced'
  | 'Uploading'
  | 'Applying'
  | 'Checking'
  | 'Merging'
  | 'Ahead'
  | 'Behind'
  | 'Offline'
  | 'Review needed'
  | 'Stale review'
  | 'Blocked'
  | 'Needs recovery'
  | 'Unsafe local state'
  | 'Integrity failure';

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
};

export type SetupRequest = {
  username: string;
  password: string;
  display_name?: string;
};

export type LoginRequest = {
  username: string;
  password: string;
};

export type LoginResponse = {
  user_id: string;
  csrf_token: string;
  recent_auth_expires_at: string;
};

export type CreateVaultRequest = {
  display_name: string;
};

export type VaultSummary = {
  vault_id: string;
  display_name: string;
  owner_user_id: string;
  current_main: string;
  status: 'active' | 'blocked_integrity';
  created_at: string;
  updated_at: string;
};

export type CreatePairingTokenRequest = {
  device_name: string;
  sync_profile: SyncProfile;
  sync_plugins?: boolean;
};

export type PairingTokenResponse = {
  pairing_token: string;
  expires_at: string;
  pairing_url: string;
};

export type ConsumePairingTokenRequest = {
  pairing_token: string;
  device_name: string;
  sync_profile: SyncProfile;
  sync_plugins?: boolean;
  client_name?: string;
};

export type ConsumePairingTokenResponse = {
  user_id: string;
  vault_id: string;
  device_id: string;
  device_token: string;
  device_ref: string;
  current_main: string;
};

export type DevicePushManifest = {
  api_version: typeof API_VERSION;
  vault_id: string;
  device_id: string;
  expected_device_ref: string | null;
  target_commit: string;
  packfile_sha256: string;
  packfile_bytes: number;
  client_known_main: string | null;
  attempt_id?: string;
};

export type PushResult =
  | {
      status: 'noop';
      device_ref: string;
      main: string;
      event_seq: number;
    }
  | {
      status: 'merged';
      device_ref: string;
      main: string;
      merge_commit: string;
      event_seq: number;
    }
  | {
      status: 'conflicted';
      device_ref: string;
      main: string;
      conflict_id: string;
      event_seq: number;
    }
  | {
      status: 'rejected';
      code: string;
      message: string;
    };

export type DevicePullRequest = {
  api_version: typeof API_VERSION;
  vault_id: string;
  device_id: string;
  current_local_main: string | null;
  requested_target: 'latest' | string;
};

export type DevicePullManifest = {
  api_version: typeof API_VERSION;
  vault_id: string;
  device_id: string;
  target_main: string;
  changed_paths: string[];
  event_seq: number;
};

export type ConflictRecord = {
  conflict_id: string;
  vault_id: string;
  device_id: string;
  status: 'open' | 'resolved';
  base_commit: string;
  current_main: string;
  device_commit: string;
  expected_main: string;
  affected_paths: string[];
  affected_path_count: number;
  merge_sequence: number;
  merge_policy_version: string;
  validator_summary: Record<string, unknown>;
  created_at: string;
  resolved_at?: string;
};

export type EventEnvelope = {
  event_id: string;
  event_seq: number;
  event_type:
    | 'main_advanced'
    | 'device_ref_updated'
    | 'device_sync_rejected'
    | 'device_recovery_required'
    | 'conflict_created'
    | 'conflict_resolved'
    | 'device_state_changed';
  vault_id: string;
  resource_ids: Record<string, string>;
  commit_cursors: Record<string, string | null>;
  payload: Record<string, unknown>;
  created_at: string;
};
