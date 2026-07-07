import type {
  ConflictReviewPackage,
  ConflictResolutionKind,
  ManualFilePlanEntry,
  DashboardSummary,
  DashboardConflict,
  NoteHistoryQueryResponse,
  NoteHistoryVersionResponse,
  Session,
  VaultSummary
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
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

  async reauthenticate(username: string, password: string): Promise<Session> {
    const session = await this.request<Session>('/auth/reauthenticate', {
      method: 'POST',
      csrf: true,
      body: { username, password }
    });
    this.csrfToken = session.csrf_token;
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

  async dashboard(vaultId: string): Promise<DashboardSummary> {
    return await this.request(`/vaults/${vaultId}/dashboard`);
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

  async createPairingToken(vaultId: string, deviceName: string): Promise<{ pairing_token: string; pairing_url: string; expires_at: string }> {
    return await this.request(`/vaults/${vaultId}/pairing-tokens`, {
      method: 'POST',
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

  async resolveConflict(input: {
    vaultId: string;
    conflictId: string;
    expectedMain: string;
    resolutionKind: ConflictResolutionKind;
    manualFiles?: Record<string, string | null>;
    manualFilePlan?: ManualFilePlanEntry[];
  }): Promise<{ resolution_commit: string; main: string; idempotent: boolean }> {
    return await this.request(`/vaults/${input.vaultId}/conflicts/${input.conflictId}/resolve`, {
      method: 'POST',
      csrf: true,
      body: {
        expected_main: input.expectedMain,
        resolution_kind: input.resolutionKind,
        ...(input.manualFiles ? { manual_files: input.manualFiles } : {}),
        ...(input.manualFilePlan ? { manual_file_plan: input.manualFilePlan } : {})
      }
    });
  }

  async historyQuery(vaultId: string, path: string): Promise<NoteHistoryQueryResponse> {
    return await this.request(`/vaults/${vaultId}/history/query`, {
      method: 'POST',
      body: { path, limit: 100 }
    });
  }

  async historyVersion(vaultId: string, path: string, commit: string): Promise<NoteHistoryVersionResponse> {
    return await this.request(`/vaults/${vaultId}/history/version`, {
      method: 'POST',
      body: { path, commit }
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
      error?: { code: string; message: string };
    };
    if (!response.ok) {
      throw new ApiError(response.status, data.error?.code ?? 'request_failed', data.error?.message ?? 'Request failed.');
    }
    return data as T;
  }
}
