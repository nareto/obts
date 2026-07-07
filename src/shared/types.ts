export const API_VERSION = '2026-07-02.full-sync';

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
};

export type PairingTokenResponse = {
  pairing_token: string;
  expires_at: string;
  pairing_url: string;
};

export type ConsumePairingTokenRequest = {
  pairing_token: string;
  device_name: string;
  client_name?: string;
};

export type ConsumePairingTokenResponse = {
  user_id: string;
  vault_id: string;
  device_id: string;
  device_token: string;
  device_ref: string;
  current_main: string;
  is_first_device: boolean;
};

export type DeviceSelfResponse = {
  user_id: string;
  vault_id: string;
  device_id: string;
  device_name: string;
  device_ref: string;
  server_device_ref: string | null;
  current_main: string;
  status: 'paired' | 'synced' | 'ahead' | 'review_needed' | 'blocked_recovery' | 'revoked';
  last_applied_main: string | null;
  event_seq: number;
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
  base_commit?: string | null;
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
  current_local_main_is_ancestor: boolean | null;
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
  validator_results: Record<string, unknown>;
  validator_summary: Record<string, unknown>;
  created_at: string;
  resolved_at?: string;
  resolved_by_user_id?: string;
  resolution_kind?: ConflictResolutionKind;
  resolution_commit?: string;
  resolution_request_hash?: string;
};

export type ConflictResolutionKind =
  | 'keep_server'
  | 'use_device'
  | 'keep_both_files'
  | 'insert_both_blocks'
  | 'manual';

export type ConflictPathOperation = 'absent' | 'unchanged' | 'added' | 'modified' | 'deleted' | 'renamed';

export type ConflictReviewPath = {
  kind: 'same_path' | 'rename_rename' | 'rename_delete' | 'rename_edit' | 'delete_edit' | 'path_collision' | 'path_overlap';
  base_path: string | null;
  server_path: string | null;
  device_path: string | null;
  server_operation: ConflictPathOperation;
  device_operation: ConflictPathOperation;
  affected_paths: string[];
};

export type ConflictReviewFile = {
  path: string;
  base_content: string | null;
  server_content: string | null;
  device_content: string | null;
  source_diff: string;
  rendered_markdown_diff: string | null;
};

export type ConflictReviewPackage = {
  conflict: ConflictRecord;
  stale: boolean;
  expected_main: string;
  current_main: string;
  device_name: string;
  path_conflicts: ConflictReviewPath[];
  files: ConflictReviewFile[];
  choices: ConflictResolutionKind[];
};

export type ManualFilePlanEntry = {
  path: string;
  content: string | null;
};

export type ResolveConflictRequest = {
  expected_main: string;
  resolution_kind: ConflictResolutionKind;
  manual_files?: Record<string, string | null>;
  manual_file_plan?: ManualFilePlanEntry[];
};

export type ResolveConflictResponse = {
  status: 'resolved';
  conflict_id: string;
  main: string;
  resolution_commit: string;
  event_seq: number;
  idempotent: boolean;
};

export type NoteHistoryVersion = {
  commit: string;
  parent_commit: string | null;
  tree: string;
  path: string;
  operation_type: 'create' | 'update' | 'delete' | 'rename' | 'restore' | 'merge' | 'conflict_resolution';
  timestamp: string;
  author_name: string;
  author_email: string;
  subject: string;
  previous_path?: string;
  device_id?: string;
  conflict_id?: string;
  merge_sequence?: number;
};

export type NoteHistoryQueryResponse = {
  path: string;
  current_main: string;
  versions: NoteHistoryVersion[];
};

export type NoteHistoryVersionResponse = {
  path: string;
  commit: string;
  content: string | null;
  source_diff: string;
  rendered_markdown_diff: string | null;
};

export type NoteRestoreResponse = {
  status: 'restored';
  path: string;
  source_path: string;
  source_commit: string;
  main: string;
  restore_commit: string;
  event_seq: number;
};

export type MaintenanceStartResponse = {
  status: 'completed';
  event_seq: number;
  started_event_seq: number;
  detail: string;
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
    | 'conflict_review_refreshed'
    | 'conflict_resolved'
    | 'note_restored'
    | 'device_state_changed'
    | 'vault_maintenance_started'
    | 'vault_maintenance_finished';
  vault_id: string;
  resource_ids: Record<string, string>;
  commit_cursors: Record<string, string | null>;
  payload: Record<string, unknown>;
  created_at: string;
};
