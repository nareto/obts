import { PluginBlockedError, type ObtsPluginClient, type OnboardingAnalysis } from './core.js';
import { TransportError } from '../../obsidian-plugin/src/core/transport.js';

export type HeadlessRequest = {
  id: string | number;
  command: string;
  [key: string]: unknown;
};

export type HeadlessResponse =
  | { type: 'response'; id: string | number | null; ok: true; result: unknown }
  | { type: 'response'; id: string | number | null; ok: false; error: { code: string; message: string } };

export type HeadlessEvent =
  | { type: 'event'; event: 'ready' | 'state'; state: Awaited<ReturnType<ObtsPluginClient['readState']>> }
  | { type: 'event'; event: 'stopping'; reason: string };

export type HeadlessMessage = HeadlessResponse | HeadlessEvent;

export type HeadlessClient = Pick<
  ObtsPluginClient,
  | 'initialize'
  | 'readState'
  | 'readQueue'
  | 'readPendingOnboarding'
  | 'startOnboarding'
  | 'pollOnboarding'
  | 'analyzeOnboarding'
  | 'finishOnboarding'
  | 'cancelOnboarding'
  | 'recordLocalChangeHint'
  | 'syncOnce'
  | 'pollRemoteEventsAndApply'
  | 'replaceLocalWithServer'
  | 'rebuildFromServerMain'
  | 'renameCurrentDevice'
  | 'unpairCurrentDevice'
  | 'resetLocalPairingState'
>;

export class HeadlessSession {
  private tail: Promise<void> = Promise.resolve();
  private stopping = false;

  constructor(
    private readonly client: HeadlessClient,
    private readonly emit: (message: HeadlessMessage) => Promise<void>
  ) {}

  async start(): Promise<void> {
    await this.client.initialize();
    await this.emit({ type: 'event', event: 'ready', state: await this.client.readState() });
  }

  submit(value: unknown): Promise<void> {
    const operation = this.tail.then(async () => {
      let request: HeadlessRequest;
      try {
        request = parseRequest(value);
      } catch (error) {
        await this.emit({ type: 'response', id: requestId(value), ok: false, error: protocolError(error) });
        return;
      }
      if (this.stopping && request.command !== 'shutdown') {
        await this.emit({
          type: 'response',
          id: request.id,
          ok: false,
          error: { code: 'shutting_down', message: 'The headless client is shutting down.' }
        });
        return;
      }
      try {
        const { result, stateChanged, shouldStop } = await this.dispatch(request);
        await this.emit({ type: 'response', id: request.id, ok: true, result });
        if (stateChanged) {
          await this.emit({ type: 'event', event: 'state', state: await this.client.readState() });
        }
        if (shouldStop) this.stopping = true;
      } catch (error) {
        await this.emit({ type: 'response', id: request.id, ok: false, error: protocolError(error) });
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async stop(reason: string): Promise<void> {
    this.stopping = true;
    await this.tail;
    await this.emit({ type: 'event', event: 'stopping', reason });
  }

  private async dispatch(request: HeadlessRequest): Promise<{ result: unknown; stateChanged: boolean; shouldStop?: boolean }> {
    switch (request.command) {
      case 'read-state':
        return { result: await this.client.readState(), stateChanged: false };
      case 'read-queue':
        return { result: await this.client.readQueue(), stateChanged: false };
      case 'read-pending-onboarding':
        return { result: await this.client.readPendingOnboarding(), stateChanged: false };
      case 'start-onboarding':
        return { result: await this.client.startOnboarding(requiredString(request, 'localVaultName')), stateChanged: true };
      case 'poll-onboarding':
        return {
          result: await this.client.pollOnboarding(requiredString(request, 'connectionId'), requiredString(request, 'secret')),
          stateChanged: true
        };
      case 'analyze-onboarding':
        return {
          result: await this.client.analyzeOnboarding(requiredString(request, 'connectionId'), requiredString(request, 'secret')),
          stateChanged: true
        };
      case 'finish-onboarding': {
        const mode = requiredString(request, 'mode');
        if (mode !== 'initialize' && mode !== 'use_server' && mode !== 'merge') {
          throw new ProtocolInputError('invalid_mode', 'mode must be initialize, use_server, or merge.');
        }
        return {
          result: await this.client.finishOnboarding({
            connectionId: requiredString(request, 'connectionId'),
            secret: requiredString(request, 'secret'),
            analysis: requiredObject(request, 'analysis') as OnboardingAnalysis,
            mode
          }),
          stateChanged: true
        };
      }
      case 'cancel-onboarding':
        await this.client.cancelOnboarding();
        return { result: { status: 'cancelled' }, stateChanged: true };
      case 'record-local-change':
        await this.client.recordLocalChangeHint(requiredStringArray(request, 'paths'));
        return { result: { status: 'recorded' }, stateChanged: true };
      case 'sync-once': {
        const confirmInitialImport = optionalBoolean(request, 'confirmInitialImport');
        return {
          result: await this.client.syncOnce(confirmInitialImport === undefined ? {} : { confirmInitialImport }),
          stateChanged: true
        };
      }
      case 'poll-remote-events':
        return { result: await this.client.pollRemoteEventsAndApply(), stateChanged: true };
      case 'replace-local-with-server':
        return { result: await this.client.replaceLocalWithServer(), stateChanged: true };
      case 'rebuild-from-server-main':
        return { result: await this.client.rebuildFromServerMain(), stateChanged: true };
      case 'rename-device':
        return { result: { deviceName: await this.client.renameCurrentDevice(requiredString(request, 'deviceName')) }, stateChanged: true };
      case 'unpair-device':
        return { result: await this.client.unpairCurrentDevice(), stateChanged: true };
      case 'reset-local-pairing':
        return { result: await this.client.resetLocalPairingState(), stateChanged: true };
      case 'shutdown':
        return { result: { status: 'stopping' }, stateChanged: false, shouldStop: true };
      default:
        throw new ProtocolInputError('unknown_command', `Unknown headless command: ${request.command}`);
    }
  }
}

export class ProtocolInputError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function parseRequest(value: unknown): HeadlessRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolInputError('invalid_request', 'Each request must be a JSON object.');
  }
  const request = value as Record<string, unknown>;
  if ((typeof request.id !== 'string' && typeof request.id !== 'number') || String(request.id).length === 0) {
    throw new ProtocolInputError('invalid_request', 'Each request requires a non-empty string or number id.');
  }
  if (typeof request.command !== 'string' || request.command.trim().length === 0) {
    throw new ProtocolInputError('invalid_request', 'Each request requires a command.');
  }
  return { ...request, id: request.id, command: request.command.trim() };
}

function requiredString(request: HeadlessRequest, field: string): string {
  const value = request[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProtocolInputError('invalid_request', `${field} must be a non-empty string.`);
  }
  return value;
}

function requiredStringArray(request: HeadlessRequest, field: string): string[] {
  const value = request[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ProtocolInputError('invalid_request', `${field} must be an array of strings.`);
  }
  return value;
}

function requiredObject(request: HeadlessRequest, field: string): Record<string, unknown> {
  const value = request[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolInputError('invalid_request', `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(request: HeadlessRequest, field: string): boolean | undefined {
  const value = request[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ProtocolInputError('invalid_request', `${field} must be a boolean.`);
  return value;
}

function requestId(value: unknown): string | number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function protocolError(error: unknown): { code: string; message: string } {
  if (error instanceof ProtocolInputError || error instanceof PluginBlockedError || error instanceof TransportError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal_error', message: error instanceof Error ? error.message : 'Unknown headless client error.' };
}
