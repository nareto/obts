#!/usr/bin/env node

import { once } from 'node:events';

import { ObtsPluginClient } from './client/core.js';
import { HeadlessSession, type HeadlessMessage } from './client/headlessProtocol.js';

const MAX_LINE_BYTES = 1024 * 1024;

type StartupConfig = {
  vaultDir: string;
  serverUrl: string;
  deviceName: string;
};

async function main(): Promise<void> {
  const emit = async (message: HeadlessMessage | Record<string, unknown>): Promise<void> => {
    const line = `${JSON.stringify(message)}\n`;
    if (!process.stdout.write(line)) await once(process.stdout, 'drain');
  };

  try {
    const config = readStartupConfig(process.argv.slice(2), process.env);
    const client = new ObtsPluginClient(config.vaultDir, {
      serverUrl: config.serverUrl,
      deviceName: config.deviceName
    });
    const session = new HeadlessSession(client, emit);
    let stopping = false;

    const stop = async (reason: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      await session.stop(reason);
    };

    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));

    await session.start();
    for await (const frame of readBoundedLines(process.stdin, MAX_LINE_BYTES)) {
      if (stopping) break;
      if (frame.tooLarge) {
        await emit({
          type: 'response',
          id: null,
          ok: false,
          error: { code: 'request_too_large', message: `Request exceeds ${MAX_LINE_BYTES} bytes.` }
        });
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(frame.line);
      } catch {
        await emit({ type: 'response', id: null, ok: false, error: { code: 'invalid_json', message: 'Request is not valid JSON.' } });
        continue;
      }
      await session.submit(value);
      if (isShutdownRequest(value)) {
        await stop('shutdown');
        break;
      }
    }
    if (!stopping) await stop('eof');
  } catch (error) {
    await emit({
      type: 'fatal',
      error: {
        code: 'startup_failed',
        message: error instanceof Error ? error.message : 'Headless client startup failed.'
      }
    });
    process.exitCode = 1;
  }
}

async function* readBoundedLines(
  input: NodeJS.ReadableStream,
  maxBytes: number
): AsyncGenerator<{ line: string; tooLarge: false } | { line: ''; tooLarge: true }> {
  let parts: Buffer[] = [];
  let bufferedBytes = 0;
  let discarding = false;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      if (!discarding) {
        if (bufferedBytes + segment.length > maxBytes) {
          parts = [];
          bufferedBytes = 0;
          discarding = true;
        } else if (segment.length > 0) {
          parts.push(segment);
          bufferedBytes += segment.length;
        }
      }
      if (newline === -1) break;
      if (discarding) {
        yield { line: '', tooLarge: true };
      } else {
        const line = Buffer.concat(parts, bufferedBytes);
        const content = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
        yield { line: content.toString('utf8'), tooLarge: false };
      }
      parts = [];
      bufferedBytes = 0;
      discarding = false;
      start = newline + 1;
    }
  }
  if (discarding) yield { line: '', tooLarge: true };
  else if (bufferedBytes > 0) yield { line: Buffer.concat(parts, bufferedBytes).toString('utf8'), tooLarge: false };
}

function readStartupConfig(args: string[], env: NodeJS.ProcessEnv): StartupConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value) throw new Error(`Invalid headless argument near ${flag ?? '<end>'}.`);
    values.set(flag.slice(2), value);
  }
  const vaultDir = values.get('vault-dir') ?? env.OBTS_HEADLESS_VAULT_DIR;
  const serverUrl = values.get('server-url') ?? env.OBTS_HEADLESS_SERVER_URL;
  const deviceName = values.get('device-name') ?? env.OBTS_HEADLESS_DEVICE_NAME;
  if (!vaultDir) throw new Error('--vault-dir or OBTS_HEADLESS_VAULT_DIR is required.');
  if (!serverUrl) throw new Error('--server-url or OBTS_HEADLESS_SERVER_URL is required.');
  if (!deviceName) throw new Error('--device-name or OBTS_HEADLESS_DEVICE_NAME is required.');
  return { vaultDir, serverUrl, deviceName };
}

function isShutdownRequest(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).command === 'shutdown');
}

void main();
