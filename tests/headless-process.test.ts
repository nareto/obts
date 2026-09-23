import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('headless client process', () => {
  it('uses stdout exclusively for correlated JSON-lines protocol messages', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'obts-headless-process-'));
    temporaryDirectories.push(vaultDir);
    const child = spawn(
      process.execPath,
      [
        'dist/src/headless.js',
        '--vault-dir',
        vaultDir,
        '--server-url',
        'http://127.0.0.1:9',
        '--device-name',
        'headless-test'
      ],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.stdin.write('{"id":1,"command":"read-state"}\n');
    child.stdin.write('{"id":2,"command":"read-index-delta"}\n');
    child.stdin.write('{"id":3,"command":"shutdown"}\n');
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    const messages = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const protocolMessages = messages.filter((message) => message.event !== 'progress');
    expect(messages.some((message) => message.event === 'progress' && typeof message.diagnosticPoint === 'string' && message.diagnosticPoint.startsWith('startup'))).toBe(true);
    expect(protocolMessages.map((message) => [message.type, message.event ?? message.id])).toEqual([
      ['event', 'ready'],
      ['response', 1],
      ['response', 2],
      ['response', 3],
      ['event', 'stopping']
    ]);
    expect(protocolMessages[1]).toMatchObject({ ok: true, result: { status_label: 'Checking' } });
    expect(protocolMessages[2]).toMatchObject({
      ok: true,
      result: { head: null, base: null, mode: 'unavailable', files: [], changes: [] }
    });
  });

  it('rejects an oversized unterminated input frame without buffering it as a request', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'obts-headless-oversized-'));
    temporaryDirectories.push(vaultDir);
    const child = spawn(
      process.execPath,
      [
        'dist/src/headless.js',
        '--vault-dir',
        vaultDir,
        '--server-url',
        'http://127.0.0.1:9',
        '--device-name',
        'headless-test'
      ],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));

    child.stdin.write('x'.repeat(1024 * 1024 + 1));
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(exitCode).toBe(0);
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'response',
      id: null,
      ok: false,
      error: expect.objectContaining({ code: 'request_too_large' })
    }));
  });

  it('fails startup cleanly when required configuration is missing', async () => {
    const child = spawn(process.execPath, ['dist/src/headless.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ type: 'fatal', error: { code: 'startup_failed' } });
  });
});
