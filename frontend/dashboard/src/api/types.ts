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

export type Session = {
  user_id: string;
  csrf_token: string;
  recent_auth_expires_at: string;
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

export type DashboardDevice = {
  device_id: string;
  device_name: string;
  status: string;
  status_label: StatusLabel;
  last_seen_at: string | null;
  device_ref_head: string | null;
  last_applied_main: string | null;
  last_successful_sync_at: string | null;
  ahead_of_main: boolean;
  behind_main: boolean;
  blocked: boolean;
  offline: boolean;
};

export type DashboardConflict = ConflictRecord & {
  device_name: string;
  conflict_type: string;
  stale: boolean;
  status_label: StatusLabel;
};

export type DashboardActivity = {
  event_id: string;
  event_seq: number;
  event_type: string;
  label: string;
  created_at: string;
  device_id?: string;
  conflict_id?: string;
  main?: string | null;
};

export type MaintenanceRow = {
  key: string;
  label: string;
  status_label: StatusLabel;
  last_checked_at: string;
  detail: string;
  action?: 'start_git_maintenance' | 'view_backup_contract';
};

export type DashboardSummary = {
  vault: Pick<VaultSummary, 'vault_id' | 'display_name' | 'current_main' | 'status'>;
  devices: DashboardDevice[];
  unresolved_conflict_count: number;
  conflicts: DashboardConflict[];
  recent_activity: DashboardActivity[];
  maintenance: MaintenanceRow[];
  health: {
    status: 'ready' | 'not_ready';
    checks: Record<string, boolean>;
    detail: string | null;
    git_version: string;
  };
};

export type ConflictResolutionKind =
  | 'keep_server'
  | 'use_device'
  | 'keep_both_files'
  | 'insert_both_blocks'
  | 'manual';

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
  resolution_kind?: ConflictResolutionKind;
  resolution_commit?: string;
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
  files: ConflictReviewFile[];
  choices: ConflictResolutionKind[];
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
