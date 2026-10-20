import type {
  ConflictResolutionPreview,
  ConflictReviewPackage,
  ConnectionReview,
  ConflictResolutionKind,
  ManualFilePlanEntry,
  PerFileResolutionEntry,
  DashboardSummary,
  NameRepairPreview,
  NameRepairResult,
  DashboardConflict,
  DiagnosticEventsResponse,
  NoteHistoryQueryResponse,
  NoteHistoryVersionResponse,
  Session,
  VaultDeletionListResponse,
  VaultDeletionStatus,
  VaultSummary,
  VaultSyncSettings,
  VaultSyncSettingsPreview,
  MetadataConflictRule
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> | null = null,
    readonly retryAfter: number | null = null
  ) {
    super(message);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value || !/^\d{1,6}$/u.test(value.trim())) return null;
  return Number(value.trim());
}

export class DashboardApi {
  csrfToken = '';

  async setup(username: string, password: string): Promise<Session> {
    const session = await this.request<Session>('/setup', {
      method: 'POST',
      body: { username, password }
    });
    this.csrfToken = session.csrf_token;
    return session;
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await this.request<Session>('/auth/login', {
      method: 'POST',
      body: { username, password }
    });
    this.csrfToken = session.csrf_token;
    return session;
  }

  async reauthenticate(username: string, password: string, options: { publishCsrfToken?: boolean } = {}): Promise<Session> {
    const session = await this.request<Session>('/auth/reauthenticate', {
      method: 'POST',
      csrf: true,
      body: { username, password }
    });
    if (options.publishCsrfToken !== false) this.csrfToken = session.csrf_token;
    return session;
  }

  async session(): Promise<Session> {
    const session = await this.request<Session>('/auth/session');
    this.csrfToken = session.csrf_token;
    return session;
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' });
    this.csrfToken = '';
  }

  async setupStatus(): Promise<{ setup_complete: boolean }> {
    return await this.request('/setup/status');
  }

  async vaults(): Promise<{ vaults: VaultSummary[] }> {
    return await this.request('/vaults');
  }

  async createVault(displayName: string): Promise<VaultSummary> {
    return await this.request('/vaults', {
      method: 'POST',
      csrf: true,
      body: { display_name: displayName }
    });
  }

  async vaultDeletions(): Promise<VaultDeletionListResponse> {
    return await this.request('/vault-deletions');
  }

  async vaultDeletion(vaultId: string): Promise<VaultDeletionStatus> {
    return await this.request(`/vault-deletions/${vaultId}`);
  }

  async deleteVault(vaultId: string, confirmation: string): Promise<VaultDeletionStatus> {
    return await this.request(`/vaults/${vaultId}`, {
      method: 'DELETE',
      csrf: true,
      body: { confirmation }
    });
  }

  async renameVault(vaultId: string, displayName: string): Promise<VaultSummary> {
    return await this.request(`/vaults/${vaultId}`, {
      method: 'PATCH',
      csrf: true,
      body: { display_name: displayName }
    });
  }

  async vaultSyncSettings(vaultId: string): Promise<VaultSyncSettings> {
    return await this.request(`/vaults/${vaultId}/sync-settings`);
  }

  async previewVaultSyncSettings(vaultId: string, input: {
    expected_main: string; expected_root_ignore_oid: string | null; root_ignore: string | null;
    metadata_conflict_rules: MetadataConflictRule[];
  }): Promise<VaultSyncSettingsPreview> {
    return await this.request(`/vaults/${vaultId}/sync-settings/preview`, {
      method: 'POST', csrf: true, body: input
    });
  }

  async saveVaultSyncSettings(vaultId: string, input: {
    expected_main: string; expected_root_ignore_oid: string | null; preview_tree: string; review_fingerprint: string;
    root_ignore: string | null; metadata_conflict_rules: MetadataConflictRule[];
    expected_metadata_conflict_rules: MetadataConflictRule[];
  }): Promise<VaultSyncSettings> {
    return await this.request(`/vaults/${vaultId}/sync-settings`, {
      method: 'PUT', csrf: true, body: input
    });
  }

  async previewNameRepair(vaultId: string): Promise<NameRepairPreview> {
    return await this.request(`/vaults/${vaultId}/name-repair/preview`, { method: 'POST', csrf: true });
  }

  async applyNameRepair(vaultId: string, preview: Pick<NameRepairPreview, 'expected_main' | 'preview_tree' | 'review_fingerprint'>): Promise<NameRepairResult> {
    return await this.request(`/vaults/${vaultId}/name-repair`, {
      method: 'POST', csrf: true,
      body: { expected_main: preview.expected_main, preview_tree: preview.preview_tree, review_fingerprint: preview.review_fingerprint }
    });
  }

  async dashboard(vaultId: string): Promise<DashboardSummary> {
    return await this.request(`/vaults/${vaultId}/dashboard`);
  }

  async diagnosticEvents(cursor: string | null = null): Promise<DiagnosticEventsResponse> {
    return await this.request(`/diagnostic-events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
  }

  async deleteDiagnosticEvents(): Promise<{ deleted_count: number }> {
    return await this.request('/diagnostic-events', {
      method: 'DELETE',
      csrf: true
    });
  }

  async conflicts(vaultId: string): Promise<{ conflicts: DashboardConflict[] }> {
    return await this.request(`/vaults/${vaultId}/conflicts?status=all`);
  }

  async conflict(vaultId: string, conflictId: string): Promise<ConflictReviewPackage> {
    return await this.request(`/vaults/${vaultId}/conflicts/${conflictId}`);
  }

  async refreshConflict(vaultId: string, conflictId: string): Promise<ConflictReviewPackage> {
    return await this.request(`/vaults/${vaultId}/conflicts/${conflictId}/refresh`, {
      method: 'POST',
      csrf: true,
      body: {}
    });
  }

  async previewConflict(input: {
    vaultId: string;
    conflictId: string;
    expectedMain: string;
    resolutionKind: ConflictResolutionKind;
    manualFiles?: Record<string, string | null>;
    manualFilePlan?: ManualFilePlanEntry[];
    perFile?: PerFileResolutionEntry[];
  }): Promise<ConflictResolutionPreview> {
    return await this.request(`/vaults/${input.vaultId}/conflicts/${input.conflictId}/preview`, {
      method: 'POST',
      csrf: true,
      body: {
        expected_main: input.expectedMain,
        resolution_kind: input.resolutionKind,
        ...(input.manualFiles ? { manual_files: input.manualFiles } : {}),
        ...(input.manualFilePlan ? { manual_file_plan: input.manualFilePlan } : {}),
        ...(input.perFile ? { per_file: input.perFile } : {})
      }
    });
  }

  async connectionReview(connectionId: string): Promise<ConnectionReview> {
    return await this.request(`/connections/${connectionId}/review`);
  }

  async approveConnection(
    connectionId: string,
    input: { selection: 'new_vault'; display_name: string } | { selection: 'existing_vault'; vault_id: string }
  ): Promise<void> {
    await this.request(`/connections/${connectionId}/approve`, {
      method: 'POST',
      csrf: true,
      body: input
    });
  }

  async denyConnection(connectionId: string): Promise<void> {
    await this.request(`/connections/${connectionId}/deny`, {
      method: 'POST',
      csrf: true,
      body: {}
    });
  }

  async renameDevice(vaultId: string, deviceId: string, deviceName: string): Promise<{ device_id: string; device_name: string }> {
    return await this.request(`/vaults/${vaultId}/devices/${deviceId}`, {
      method: 'PATCH',
      csrf: true,
      body: { device_name: deviceName }
    });
  }

  async revokeDevice(vaultId: string, deviceId: string): Promise<void> {
    await this.request(`/vaults/${vaultId}/devices/${deviceId}/revoke`, {
      method: 'POST',
      csrf: true,
      body: {}
    });
  }

  async removeDevice(vaultId: string, deviceId: string, input: { confirmation: string; discard_unmerged: boolean }): Promise<{ status: 'removed'; device_id: string }> {
    return await this.request(`/vaults/${encodeURIComponent(vaultId)}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      csrf: true,
      body: input
    });
  }

  async resolveConflict(input: {
    vaultId: string;
    conflictId: string;
    expectedMain: string;
    expectedTree?: string;
    resolutionKind: ConflictResolutionKind;
    manualFiles?: Record<string, string | null>;
    manualFilePlan?: ManualFilePlanEntry[];
    perFile?: PerFileResolutionEntry[];
  }): Promise<{ resolution_commit: string; main: string; idempotent: boolean }> {
    return await this.request(`/vaults/${input.vaultId}/conflicts/${input.conflictId}/resolve`, {
      method: 'POST',
      csrf: true,
      body: {
        expected_main: input.expectedMain,
        resolution_kind: input.resolutionKind,
        ...(input.expectedTree ? { expected_tree: input.expectedTree } : {}),
        ...(input.manualFiles ? { manual_files: input.manualFiles } : {}),
        ...(input.manualFilePlan ? { manual_file_plan: input.manualFilePlan } : {}),
        ...(input.perFile ? { per_file: input.perFile } : {})
      }
    });
  }

  async historyQuery(vaultId: string, path: string): Promise<NoteHistoryQueryResponse> {
    return await this.request(`/vaults/${vaultId}/history/query`, {
      method: 'POST',
      body: { path, limit: 100 }
    });
  }

  async historyVersion(
    vaultId: string,
    path: string,
    commit: string,
    includeContent = false
  ): Promise<NoteHistoryVersionResponse> {
    return await this.request(`/vaults/${vaultId}/history/version`, {
      method: 'POST',
      csrf: includeContent,
      body: { path, commit, ...(includeContent ? { include_content: true } : {}) }
    });
  }

  async restoreHistoryVersion(
    vaultId: string,
    path: string,
    sourceCommit: string,
    expectedMain: string,
    sourcePath = path
  ): Promise<{ restore_commit: string; main: string; source_path: string }> {
    return await this.request(`/vaults/${vaultId}/history/restore`, {
      method: 'POST',
      csrf: true,
      body: {
        path,
        source_path: sourcePath,
        source_commit: sourceCommit,
        expected_main: expectedMain
      }
    });
  }

  async startGitMaintenance(vaultId: string): Promise<{ status: string; detail: string; event_seq: number }> {
    return await this.request(`/vaults/${vaultId}/maintenance/git-gc/start`, {
      method: 'POST',
      csrf: true,
      body: {}
    });
  }

  private async request<T = Record<string, never>>(
    path: string,
    options: { method?: string; csrf?: boolean; body?: unknown } = {}
  ): Promise<T> {
    const response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.csrf ? { 'x-obts-csrf': this.csrfToken } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: { code: string; message: string; details?: unknown };
    };
    if (!response.ok) {
      const details = data.error?.details && typeof data.error.details === 'object' && !Array.isArray(data.error.details)
        ? (data.error.details as Record<string, unknown>)
        : null;
      throw new ApiError(
        response.status,
        data.error?.code ?? 'request_failed',
        data.error?.message ?? 'Request failed.',
        details,
        parseRetryAfter(response.headers.get('retry-after'))
      );
    }
    return data as T;
  }
}
