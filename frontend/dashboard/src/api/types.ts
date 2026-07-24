export type StatusLabel =
  | 'Synced'
  | 'Preparing upload'
  | 'Uploading'
  | 'Applying'
  | 'Checking'
  | 'Merging'
  | 'Ahead'
  | 'Behind'
  | 'Offline'
  | 'Status unknown'
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

export type ConnectionReview = {
  connection_id: string;
  verification_code: string;
  status: 'pending' | 'approved' | 'consumed' | 'denied' | 'expired';
  plugin_version: string;
  device_name: string;
  local_vault_name: string;
  local_summary: {
    has_content: boolean;
    syncable_file_count: number;
    syncable_bytes: number;
    has_detached_baseline: boolean;
  };
  vaults: Array<Pick<VaultSummary, 'vault_id' | 'display_name' | 'current_main' | 'status'>>;
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
  local_status_label: StatusLabel | null;
  local_error_code: string | null;
  local_queue_status: string | null;
  local_main: string | null;
  local_head: string | null;
  plugin_version: string | null;
  path_capabilities: Record<string, unknown> | null;
  last_status_report_at: string | null;
  status_report_fresh: boolean;
  status_report_age_seconds: number | null;
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

export type DiagnosticBreadcrumb = {
  point: string;
  outcome: string;
  value_kind: string;
  size_bucket: string;
  error_code: string;
};

export type DiagnosticEvent = {
  schema_version: 1;
  event_id: string;
  plugin_version: string;
  obsidian_version: string;
  platform_family: string;
  flow: string;
  stage: string;
  failure_code: string;
  error_class: string;
  retryable: boolean;
  breadcrumbs: DiagnosticBreadcrumb[];
  received_at: string;
};

export type DiagnosticEventsResponse = {
  ingestion_enabled: boolean;
  retention_days: number;
  events: DiagnosticEvent[];
  next_cursor: string | null;
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

export type DirectoryProposalIntent = {
  intent_id: string;
  generation: number;
  op: 'create' | 'delete';
  path: string;
};

export type DirectoryConflictContext = {
  proposal: { proposal_id: string; intents: DirectoryProposalIntent[] };
  affected_roots: string[];
  expected_event_seq: number;
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
  conflict_kind: 'content' | 'directory' | 'mixed';
  directory_context?: DirectoryConflictContext;
  validator_results: Record<string, unknown>;
  validator_summary: Record<string, unknown>;
  created_at: string;
  resolved_at?: string;
  resolution_kind?: ConflictResolutionKind;
  resolution_commit?: string;
};

export type ConflictPathOperation = 'absent' | 'unchanged' | 'added' | 'modified' | 'deleted' | 'renamed';

export type ConflictReviewPath = {
  group_id: string;
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
  content_kind: 'text' | 'large_text' | 'binary';
  base_content: string | null;
  server_content: string | null;
  device_content: string | null;
  base_bytes: number | null;
  server_bytes: number | null;
  device_bytes: number | null;
  base_sha256: string | null;
  server_sha256: string | null;
  device_sha256: string | null;
  source_diff: string;
  rendered_markdown_diff: string | null;
};

export type DirectoryConflictReview = {
  root: string;
  server_state: 'present' | 'deleted';
  device_state: 'present' | 'deleted';
  affected_paths: string[];
};

export type ConflictReviewPackage = {
  conflict: ConflictRecord;
  stale: boolean;
  expected_main: string;
  current_main: string;
  device_name: string;
  path_conflicts: ConflictReviewPath[];
  files: ConflictReviewFile[];
  directory_conflicts: DirectoryConflictReview[];
  choices: ConflictResolutionKind[];
};

export type ManualFilePlanEntry = {
  path: string;
  content: string | null;
};

export type ConflictResolutionSubmission = {
  resolutionKind: ConflictResolutionKind;
  manualFiles?: Record<string, string | null>;
  manualFilePlan?: ManualFilePlanEntry[];
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
