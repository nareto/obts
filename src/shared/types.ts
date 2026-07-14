import type { DiagnosticEventV1 } from './diagnostics.js';

export const API_VERSION = '2026-07-12.browser-onboarding';

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

export type ConnectionLocalSummary = {
  has_content: boolean;
  syncable_file_count: number;
  syncable_bytes: number;
  has_detached_baseline: boolean;
};

export type CreateConnectionRequest = {
  plugin_version: string;
  device_name: string;
  local_vault_name: string;
  local_summary: ConnectionLocalSummary;
};

export type CreateConnectionResponse = {
  connection_id: string;
  connection_secret: string;
  authorization_url: string;
  verification_code: string;
  credential_salt: string;
  expires_at: string;
  poll_interval_ms: number;
};

export type ConnectionStatusResponse =
  | { status: 'pending'; expires_at: string }
  | { status: 'denied' | 'expired' }
  | {
      status: 'approved';
      selection: 'new_vault' | 'existing_vault';
      vault_id: string | null;
      vault_name: string;
      expected_main: string | null;
    }
  | {
      status: 'consumed';
      vault_id: string;
      vault_name: string;
      device_id: string;
    };

export type ConnectionBootstrapManifest = {
  api_version: typeof API_VERSION;
  connection_id: string;
  vault_id: string;
  vault_name: string;
  root_commit: string;
  target_main: string;
  changed_paths: string[];
  explicit_directories: string[];
};

export type CompleteConnectionRequest = {
  mode: 'initialize' | 'use_server' | 'merge';
  expected_main: string | null;
  proposal_kind?: 'new_vault_import' | 'independent_vault_merge' | 'shared_baseline_merge';
  proposal_base?: string | null;
};

export type CompleteConnectionResponse = {
  user_id: string;
  vault_id: string;
  vault_name: string;
  root_commit: string;
  current_main: string;
  device_id: string;
  device_token: string;
  device_ref: string;
  mode: CompleteConnectionRequest['mode'];
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

export type DeviceStatusReport = {
  plugin_version: string;
  local_status_label: string;
  local_error_code: string | null;
  local_queue_status: string | null;
  local_main: string | null;
  local_head: string | null;
  path_capabilities?: Record<string, unknown> | null;
};

export type DeviceStatusResponse = {
  status: 'ok';
  plugin: import('./pluginCompatibility.js').PluginCompatibility;
};

export type DiagnosticEventView = DiagnosticEventV1 & {
  received_at: string;
};

export type DiagnosticEventsResponse = {
  ingestion_enabled: boolean;
  retention_days: number;
  events: DiagnosticEventView[];
  next_cursor: string | null;
};

export type DirectoryIntent = {
  op: 'create' | 'delete';
  path: string;
};

export type DevicePushManifest = {
  api_version: typeof API_VERSION;
  plugin_version?: string;
  vault_id: string;
  device_id: string;
  expected_device_ref: string | null;
  target_commit: string;
  packfile_sha256: string;
  packfile_bytes: number;
  client_known_main: string | null;
  base_commit?: string | null;
  attempt_id?: string;
  directory_intents?: DirectoryIntent[];
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
  plugin_version?: string;
  vault_id: string;
  device_id: string;
  current_local_main: string | null;
  requested_target: 'latest' | string;
  current_event_seq?: number;
};

export type DevicePullManifest = {
  api_version: typeof API_VERSION;
  vault_id: string;
  device_id: string;
  target_main: string;
  changed_paths: string[];
  current_local_main_is_ancestor: boolean | null;
  event_seq: number;
  directory_intents?: DirectoryIntent[];
  explicit_directories?: string[];
};

export const CHUNK_TRANSFER_CAPABILITY = 'git-object-pack-chunks-v1' as const;

export type SyncCapabilities = {
  capabilities: [typeof CHUNK_TRANSFER_CAPABILITY];
  max_chunk_bytes: number;
  target_chunk_bytes: number;
  max_transfer_bytes: number;
  max_transfer_chunks: number;
};

export type ChunkPushCreateRequest = {
  api_version: typeof API_VERSION;
  plugin_version?: string;
  vault_id: string;
  device_id: string;
  expected_device_ref: string | null;
  target_commit: string;
  client_known_main: string | null;
  base_commit?: string | null;
  directory_intents?: DirectoryIntent[];
  attempt_id: string;
  chunk_count: number;
  plan_sha256: string;
};

export type ChunkPushDescriptor = {
  transfer_id: string;
  capability: typeof CHUNK_TRANSFER_CAPABILITY;
  status: 'open' | 'completed' | 'aborted';
  target_commit: string;
  chunk_count: number;
  received_chunks: number[];
  max_chunk_bytes: number;
  max_transfer_bytes: number;
  expires_at: string;
  result?: PushResult;
};

export type ChunkPushReceipt = {
  transfer_id: string;
  chunk_index: number;
  chunk_sha256: string;
  received_bytes: number;
  idempotent: boolean;
};

export type ChunkPullRequest = DevicePullRequest & {
  cursor: number;
};

export type ChunkPullManifest = DevicePullManifest & {
  capability: typeof CHUNK_TRANSFER_CAPABILITY;
  cursor: number;
  next_cursor: number;
  complete: boolean;
  chunk_sha256: string;
  chunk_bytes: number;
};

export type ChunkBootstrapRequest = {
  api_version: typeof API_VERSION;
  plugin_version?: string;
  cursor: number;
  requested_target: 'latest' | string;
};

export type ChunkBootstrapManifest = ConnectionBootstrapManifest & {
  capability: typeof CHUNK_TRANSFER_CAPABILITY;
  cursor: number;
  next_cursor: number;
  complete: boolean;
  chunk_sha256: string;
  chunk_bytes: number;
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
  user_id?: string;
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
  metadata_only: boolean;
  content_redacted: boolean;
};

export type DiagnosticsExport = {
  generated_at: string;
  vault: {
    vault_id: string;
    status: 'active' | 'blocked_integrity';
    current_main: string;
  };
  devices: Array<{
    device_id: string;
    status: string;
    last_seen_at: string | null;
    last_successful_sync_at: string | null;
    local_status_label: string | null;
    local_error_code: string | null;
  }>;
  conflicts: Array<{
    conflict_id: string;
    device_id: string;
    status: 'open' | 'resolved';
    affected_path_count: number;
    created_at: string;
    resolved_at?: string;
  }>;
  event_cursor: number;
  operation_counts: Record<string, number>;
  health: {
    status: 'ready' | 'not_ready';
    checks: Record<string, boolean>;
    detail: string | null;
  };
  redactions: string[];
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
