import { API_VERSION, type DevicePullManifest, type DevicePushManifest, type PushResult } from '../shared/types.js';
import { parseDevicePullRequest, parseDevicePushManifest } from '../shared/validators.js';

export type PairConsumeResult = {
  user_id: string;
  vault_id: string;
  device_id: string;
  device_token: string;
  device_ref: string;
  current_main: string;
  is_first_device: boolean;
};

export class TransportClient {
  constructor(private readonly serverUrl: string) {}

  async consumePairingToken(input: {
    pairingToken: string;
    deviceName: string;
    syncProfile: string;
    syncPlugins: boolean;
  }): Promise<PairConsumeResult> {
    const response = await fetch(this.url('/api/v1/pair/consume'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_token: input.pairingToken,
        device_name: input.deviceName,
        sync_profile: input.syncProfile,
        sync_plugins: input.syncPlugins
      })
    });
    return await readJsonOrThrow<PairConsumeResult>(response);
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
    const response = await fetch(this.url(`/api/v1/vaults/${input.vaultId}/sync/push`), {
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
  }): Promise<{ manifest: DevicePullManifest; packfile: Buffer }> {
    const manifest = {
      api_version: API_VERSION,
      vault_id: input.vaultId,
      device_id: input.deviceId,
      current_local_main: input.currentLocalMain,
      requested_target: input.requestedTarget ?? 'latest'
    } as const;
    parseDevicePullRequest(manifest);
    const form = new FormData();
    form.append('manifest', JSON.stringify(manifest));
    form.append('packfile', new Blob([new ArrayBuffer(0)], { type: 'application/x-git-packed-objects' }), 'have.pack');
    const response = await fetch(this.url(`/api/v1/vaults/${input.vaultId}/sync/pull`), {
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
    return parseMultipartPull(contentType, buffer);
  }

  private url(path: string): string {
    return `${this.serverUrl.replace(/\/+$/u, '')}${path}`;
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
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // Keep redacted HTTP status-only error.
  }
  throw new TransportError(response.status, code, message);
}

export class TransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function parseMultipartPull(contentType: string, data: Buffer): { manifest: DevicePullManifest; packfile: Buffer } {
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
    manifest: JSON.parse(manifestPart.body.toString('utf8')) as DevicePullManifest,
    packfile: packPart.body
  };
}
