import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

const BRIDGE_ALLOWED_STATE_KEYS = [
  'user_id',
  'vault_id',
  'device_id',
  'device_name',
  'device_ref',
  'server_device_ref',
  'local_main',
  'local_head',
  'initial_import_confirmed',
  'status_label',
  'last_error_code',
  'apply_validation_reason',
  'last_error_details',
  'last_event_seq',
  'last_applied_event_seq',
  'unpaired_baseline_vault_id',
  'unpaired_baseline_main',
  'updated_at'
];

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

  it('emits only Bridge protocol state keys when persisted state carries internal fields', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'obts-headless-projection-'));
    temporaryDirectories.push(vaultDir);
    await mkdir(join(vaultDir, '.obts'), { recursive: true });
    await writeFile(join(vaultDir, '.obts', 'state.json'), JSON.stringify({
      user_id: null,
      vault_id: null,
      device_id: null,
      device_name: null,
      device_ref: null,
      server_device_ref: null,
      local_main: null,
      local_head: null,
      initial_import_confirmed: false,
      status_label: 'Checking',
      last_error_code: null,
      apply_validation_reason: null,
      last_event_seq: 0,
      last_applied_event_seq: 0,
      unpaired_baseline_vault_id: null,
      unpaired_baseline_main: null,
      internal_future_field: { note: 'not part of the Bridge protocol' },
      updated_at: new Date().toISOString()
    }));
    const child = spawn(
      process.execPath,
      ['dist/src/headless.js', '--vault-dir', vaultDir, '--server-url', 'http://127.0.0.1:9', '--device-name', 'headless-test'],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stdin.write('{"id":1,"command":"read-state"}\n');
    child.stdin.write('{"id":2,"command":"shutdown"}\n');
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    expect(exitCode).toBe(0);
    const persisted = JSON.parse(await readFile(join(vaultDir, '.obts', 'state.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted).toHaveProperty('internal_future_field');
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const ready = messages.find((message) => message.event === 'ready') as { state: Record<string, unknown> } | undefined;
    const readState = messages.find((message) => message.type === 'response' && message.id === 1) as { result: Record<string, unknown> } | undefined;
    expect(ready).toBeDefined();
    expect(readState).toMatchObject({ ok: true });
    for (const state of [ready!.state, readState!.result]) {
      expect(BRIDGE_ALLOWED_STATE_KEYS).toEqual(expect.arrayContaining(Object.keys(state)));
      expect(state).toHaveProperty('apply_validation_reason', null);
    }
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
