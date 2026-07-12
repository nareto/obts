import {
  API_VERSION,
  type CompleteConnectionRequest,
  type CompleteConnectionResponse,
  type ConnectionBootstrapManifest,
  type ConnectionStatusResponse,
  type CreateConnectionRequest,
  type CreateConnectionResponse,
  type DevicePullManifest,
  type DevicePushManifest,
  type DeviceSelfResponse,
  type DeviceStatusReport,
  type DeviceStatusResponse,
  type EventEnvelope,
  type PushResult
} from '../../../src/shared/types.js';
import { parseDevicePullRequest, parseDevicePushManifest } from '../../../src/shared/validators.js';
import { PLUGIN_VERSION } from '../version.js';

const NETWORK_TIMEOUT_MS = 60_000;

export class TransportClient {
  constructor(private readonly serverUrl: string) {}

  async createConnection(input: CreateConnectionRequest): Promise<CreateConnectionResponse> {
    const response = await fetchWithTimeout(this.url('/api/v1/connections'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    });
    return await readJsonOrThrow<CreateConnectionResponse>(response);
  }

  async connectionStatus(connectionId: string, secret: string): Promise<ConnectionStatusResponse> {
    const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}`), {
      headers: { authorization: `Bearer ${secret}` }
    });
    return await readJsonOrThrow<ConnectionStatusResponse>(response);
  }

  async bootstrapConnection(
    connectionId: string,
    secret: string
  ): Promise<{ manifest: ConnectionBootstrapManifest; packfile: Buffer }> {
    const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}/bootstrap`), {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` }
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    return parseMultipart<ConnectionBootstrapManifest>(
      response.headers.get('content-type') ?? '',
      Buffer.from(await response.arrayBuffer())
    );
  }

  async completeConnection(
    connectionId: string,
    secret: string,
    input: CompleteConnectionRequest
  ): Promise<CompleteConnectionResponse> {
    const response = await fetchWithTimeout(this.url(`/api/v1/connections/${connectionId}/complete`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(input)
    });
    return await readJsonOrThrow<CompleteConnectionResponse>(response);
  }

  async acknowledgeOnboarding(input: { vaultId: string; deviceToken: string; appliedMain: string }): Promise<void> {
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${input.vaultId}/onboarding/complete`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.deviceToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ applied_main: input.appliedMain })
    });
    await readJsonOrThrow(response);
  }

  async getDeviceSelf(deviceToken: string): Promise<DeviceSelfResponse> {
    const response = await fetchWithTimeout(this.url('/api/v1/device/self'), {
      headers: {
        authorization: `Bearer ${deviceToken}`
      }
    });
    return await readJsonOrThrow<DeviceSelfResponse>(response);
  }

  async reportDeviceStatus(input: {
    vaultId: string;
    deviceToken: string;
    report: DeviceStatusReport;
  }): Promise<DeviceStatusResponse> {
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${input.vaultId}/sync/device-status`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.deviceToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(input.report)
    });
    return await readJsonOrThrow<DeviceStatusResponse>(response);
  }

  async push(input: {
    vaultId: string;
    deviceId: string;
    deviceToken: string;
    manifest: DevicePushManifest;
    packfile: Buffer;
  }): Promise<PushResult> {
    parseDevicePushManifest(input.manifest);
    const form = new FormData();
    form.append('manifest', JSON.stringify(input.manifest));
    const packArrayBuffer = new ArrayBuffer(input.packfile.byteLength);
    new Uint8Array(packArrayBuffer).set(input.packfile);
    form.append('packfile', new Blob([packArrayBuffer], { type: 'application/x-git-packed-objects' }), 'pack.pack');
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${input.vaultId}/sync/push`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.deviceToken}`
      },
      body: form
    });
    return await readJsonOrThrow<PushResult>(response);
  }

  async pull(input: {
    vaultId: string;
    deviceId: string;
    deviceToken: string;
    currentLocalMain: string | null;
    requestedTarget?: 'latest' | string;
    currentEventSeq?: number;
  }): Promise<{ manifest: DevicePullManifest; packfile: Buffer }> {
    const manifest = {
      api_version: API_VERSION,
      plugin_version: PLUGIN_VERSION,
      vault_id: input.vaultId,
      device_id: input.deviceId,
      current_local_main: input.currentLocalMain,
      requested_target: input.requestedTarget ?? 'latest',
      ...(input.currentEventSeq === undefined ? {} : { current_event_seq: input.currentEventSeq })
    } as const;
    parseDevicePullRequest(manifest);
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${input.vaultId}/sync/pull`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.deviceToken}`
      },
      body: form
    });
    if (!response.ok) {
      await throwResponseError(response);
    }
    const contentType = response.headers.get('content-type') ?? '';
    const buffer = Buffer.from(await response.arrayBuffer());
    return parseMultipart<DevicePullManifest>(contentType, buffer);
  }

  async pollEvents(input: {
    vaultId: string;
    deviceToken: string;
    after?: number;
  }): Promise<{ events: EventEnvelope[]; current_event_seq: number }> {
    const after = input.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error('Event cursor must be a non-negative safe integer.');
    }
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${input.vaultId}/sync/events?after=${after}`), {
      headers: {
        authorization: `Bearer ${input.deviceToken}`
      }
    });
    return await readJsonOrThrow<{ events: EventEnvelope[]; current_event_seq: number }>(response);
  }

  async unpairDevice(input: { vaultId: string; deviceToken: string }): Promise<{ status: string }> {
    const response = await fetchWithTimeout(this.url(`/api/v1/vaults/${input.vaultId}/sync/unpair`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.deviceToken}`
      }
    });
    return await readJsonOrThrow<{ status: string }>(response);
  }

  private url(path: string): string {
    return `${this.serverUrl.replace(/\/+$/u, '')}${path}`;
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    await throwResponseError(response);
  }
  return (await response.json()) as T;
}

async function throwResponseError(response: Response): Promise<never> {
  let code = 'http_error';
  let message = `HTTP ${response.status}`;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    details = body.error?.details;
  } catch {
    // Keep redacted HTTP status-only error.
  }
  throw new TransportError(response.status, code, message, details);
}

export class TransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

function parseMultipart<T>(contentType: string, data: Buffer): { manifest: T; packfile: Buffer } {
  const boundaryMatch = /boundary=([^;]+)/iu.exec(contentType);
  if (!boundaryMatch?.[1]) {
    throw new Error('Pull response did not include a multipart boundary.');
  }
  const boundary = Buffer.from(`--${boundaryMatch[1]}`);
  const parts: { headers: string; body: Buffer }[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    const start = data.indexOf(boundary, offset);
    if (start < 0) {
      break;
    }
    const afterBoundary = start + boundary.byteLength;
    if (data.subarray(afterBoundary, afterBoundary + 2).toString('utf8') === '--') {
      break;
    }
    const headerStart = afterBoundary + 2;
    const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) {
      break;
    }
    const nextBoundary = data.indexOf(Buffer.from(`\r\n--${boundaryMatch[1]}`), headerEnd + 4);
    if (nextBoundary < 0) {
      break;
    }
    parts.push({
      headers: data.subarray(headerStart, headerEnd).toString('utf8'),
      body: data.subarray(headerEnd + 4, nextBoundary)
    });
    offset = nextBoundary + 2;
  }
  const manifestPart = parts.find((part) => /name="manifest"/iu.test(part.headers));
  const packPart = parts.find((part) => /name="packfile"/iu.test(part.headers));
  if (!manifestPart || !packPart) {
    throw new Error('Pull response did not include manifest and packfile parts.');
  }
  return {
    manifest: JSON.parse(manifestPart.body.toString('utf8')) as T,
    packfile: packPart.body
  };
}
