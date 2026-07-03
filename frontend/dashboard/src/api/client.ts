import type { ConflictReviewPackage, ConflictResolutionKind, DashboardSummary, Session, VaultSummary } from './types';

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

  async dashboard(vaultId: string): Promise<DashboardSummary> {
    return await this.request(`/vaults/${vaultId}/dashboard`);
  }

  async conflicts(vaultId: string): Promise<{ conflicts: ConflictReviewPackage['conflict'][] }> {
    return await this.request(`/vaults/${vaultId}/conflicts?status=all`);
  }

  async conflict(vaultId: string, conflictId: string): Promise<ConflictReviewPackage> {
    return await this.request(`/vaults/${vaultId}/conflicts/${conflictId}`);
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
  }): Promise<{ resolution_commit: string; main: string; idempotent: boolean }> {
    return await this.request(`/vaults/${input.vaultId}/conflicts/${input.conflictId}/resolve`, {
      method: 'POST',
      csrf: true,
      body: {
        expected_main: input.expectedMain,
        resolution_kind: input.resolutionKind,
        ...(input.manualFiles ? { manual_files: input.manualFiles } : {})
      }
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
