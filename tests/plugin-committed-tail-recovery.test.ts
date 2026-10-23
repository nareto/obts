import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fixture = {
  root: string;
  core: any;
  target: string;
  journalPath: string;
  ackPath: string;
};

/**
 * A vault whose apply journal reached the committed phase: refs already point at
 * the applied target, the tail (preserved local changes, coordinated queue,
 * applied acknowledgement, cleanup) is what remains. This is the state a
 * suspended mobile app leaves behind.
 */
async function committedFixture(options: { tailStep?: string; queuedTail?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'obts-committed-tail-'));
  roots.push(root);
  await writeFile(join(root, 'shared.md'), 'server target bytes\n');
  const initial = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'committed-tail' });
  await initial.initialize();
  const core = (initial as any).client;
  const target = await core.createLocalCommit('applied target');
  await core.updateRef('refs/heads/main', target, null, true);
  await core.updateRef('refs/heads/local', target, null, true);
  await writeFile(join(root, 'shared.md'), 'local edit after the apply\n');
  let localHead = target;
  if (options.queuedTail) {
    localHead = await core.createLocalCommit('obts: preserve local changes after conflict resolution');
    await core.writeQueue({
      pending_commit: localHead,
      expected_device_ref: target,
      status: 'queued_local',
      attempts: 0,
      change_seq: (await core.readQueue()).change_seq,
      changed_paths: ['shared.md'],
      updated_at: new Date().toISOString()
    });
  }
  await core.writeState(Object.assign({}, await core.readState(), {
    vault_id: 'vlt_committed_tail',
    device_id: 'dev_committed_tail',
    device_ref: 'device-ref',
    server_device_ref: target,
    local_main: target,
    local_head: localHead,
    status_label: 'Checking',
    last_error_code: null,
    last_event_seq: 41,
    last_applied_event_seq: 41,
    updated_at: new Date().toISOString()
  }));
  const journalPath = join(root, '.obts', 'apply-journal.json');
  await writeFile(journalPath, `${JSON.stringify({
    journal_version: 7,
    apply_id: 'apply_committed_tail',
    operation_type: 'pull_apply',
    target_main: target,
    target_file_sizes: {},
    expected_prior_local_main: target,
    expected_prior_local_device_ref: null,
    authoring_base: null,
    touched_paths: [],
    target_root_ignore_oid: null,
    local_only_paths: [],
    local_only_presence: {},
    deferred_local_paths: [],
    phase: 'committed',
    affected_paths: [],
    preflight_sha256: {},
    preflight_fingerprints: {},
    directory_intents: [],
    explicit_directories: [],
    pre_apply_directories: [],
    pre_apply_directory_ctimes: {},
    confirmed_directory_roots: [],
    confirmed_directory_inventory: null,
    preserve_local_changes: true,
    event_seq: 41,
    recovery_bundle_id: null,
    last_completed_step: options.tailStep || 'refs_updated',
    redacted_error_category: null
  })}\n`);
  return { root, core, target, journalPath, ackPath: join(root, '.obts', 'pending-applied-ack.json') };
}

async function restart(fixture: Fixture, patch?: (core: any) => void): Promise<ObtsPluginClient> {
  const plugin = new ObtsPluginClient(fixture.root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'committed-tail' });
  if (patch) patch((plugin as any).client);
  return plugin;
}

describe('committed apply tail recovery', () => {
  it('finishes the tail after a restart and preserves the local edit', async () => {
    const fixture = await committedFixture();
    const restarted = await restart(fixture);

    await restarted.initialize();

    expect(await readFile(fixture.journalPath, 'utf8').catch(() => null)).toBeNull();
    const acknowledgement = JSON.parse(await readFile(fixture.ackPath, 'utf8'));
    expect(acknowledgement).toMatchObject({ target_main: fixture.target, event_seq: 41 });
    const queue = await (restarted as any).client.readQueue();
    expect(queue.status).toBe('queued_local');
    expect(typeof queue.pending_commit).toBe('string');
    expect(await (restarted as any).client.readState()).toMatchObject({ status_label: 'Ahead', last_error_code: null });
    const bundles = (await readdir(join(fixture.root, '.obts', 'recovery'))).filter((name) => name.startsWith('rec_'));
    expect(bundles).toHaveLength(1);
  });

  it('resumes a tail whose coordinated queue step already completed without rescanning', async () => {
    const fixture = await committedFixture({ tailStep: 'preserved_queued', queuedTail: true });
    let scans = 0;
    const restarted = await restart(fixture, (core) => {
      const capture = core.captureLocalFileSnapshot.bind(core);
      core.captureLocalFileSnapshot = async (...args: unknown[]) => {
        scans += 1;
        return await capture(...args);
      };
    });

    await restarted.initialize();

    expect(scans).toBe(0);
    expect(await readFile(fixture.journalPath, 'utf8').catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(fixture.ackPath, 'utf8'))).toMatchObject({ target_main: fixture.target });
    const queue = await (restarted as any).client.readQueue();
    expect(queue.pending_commit).toEqual(await (restarted as any).client.readState().then((state: any) => state.local_head));
  });

  it('clears a tail whose applied acknowledgement already reached disk', async () => {
    const fixture = await committedFixture({ tailStep: 'preserved_queued' });
    await writeFile(fixture.ackPath, `${JSON.stringify({
      target_main: fixture.target,
      event_seq: 41,
      created_at: new Date().toISOString()
    })}\n`);
    let scans = 0;
    const restarted = await restart(fixture, (core) => {
      const capture = core.captureLocalFileSnapshot.bind(core);
      core.captureLocalFileSnapshot = async (...args: unknown[]) => {
        scans += 1;
        return await capture(...args);
      };
    });

    await restarted.initialize();

    expect(scans).toBe(0);
    expect(await readFile(fixture.journalPath, 'utf8').catch(() => null)).toBeNull();
  });

  it('defers a path that keeps changing instead of restarting the scan forever', async () => {
    const fixture = await committedFixture();
    let churnReads = 0;
    let scans = 0;
    const restarted = await restart(fixture, (core) => {
      const readBinary = core.adapter.readBinary.bind(core.adapter);
      core.adapter.readBinary = async (filePath: string) => {
        const bytes = await readBinary(filePath);
        if (filePath === 'shared.md') {
          await writeFile(join(fixture.root, 'shared.md'), `rewritten ${++churnReads}\n`);
        }
        return bytes;
      };
      const capture = core.captureLocalFileSnapshot.bind(core);
      core.captureLocalFileSnapshot = async (...args: unknown[]) => {
        scans += 1;
        return await capture(...args);
      };
    });

    await restarted.initialize();

    const core = (restarted as any).client;
    // Three bounded complete-snapshot attempts, never an unbounded loop.
    expect(scans).toBe(3);
    expect(churnReads).toBe(3);
    expect(await readFile(fixture.journalPath, 'utf8').catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(fixture.ackPath, 'utf8'))).toMatchObject({ target_main: fixture.target });
    const state = await core.readState();
    expect(state.status_label).toBe('Checking');
    expect(state.last_error_code).toBeNull();
    const queue = await core.readQueue();
    expect(queue.changed_paths).toContain('shared.md');
  });

  it('reports Checking until the acknowledgement is durable and resumes at its recorded step', async () => {
    const fixture = await committedFixture();
    let scans = 0;
    let failAcknowledgement = true;
    const restarted = await restart(fixture, (core) => {
      const capture = core.captureLocalFileSnapshot.bind(core);
      core.captureLocalFileSnapshot = async (...args: unknown[]) => {
        scans += 1;
        return await capture(...args);
      };
      const writeAcknowledgement = core.writePendingAppliedAcknowledgement.bind(core);
      core.writePendingAppliedAcknowledgement = async (...args: unknown[]) => {
        if (failAcknowledgement) {
          failAcknowledgement = false;
          throw new Error('synthetic suspension during acknowledgement');
        }
        return await writeAcknowledgement(...args);
      };
    });

    await expect(restarted.initialize()).rejects.toThrow('synthetic suspension during acknowledgement');

    const core = (restarted as any).client;
    const interrupted = await core.readState();
    // The local edit is already queued at this point, so Ahead is the honest
    // resting label. What must never appear is a completed-with-nothing-pending
    // status while the acknowledgement is still missing.
    expect(interrupted.status_label).not.toBe('Synced');
    expect(['Ahead', 'Checking']).toContain(interrupted.status_label);
    const persisted = JSON.parse(await readFile(fixture.journalPath, 'utf8'));
    expect(persisted.last_completed_step).toBe('preserved_queued');

    await restarted.initialize();

    expect(scans).toBe(1);
    expect(await readFile(fixture.journalPath, 'utf8').catch(() => null)).toBeNull();
    expect(JSON.parse(await readFile(fixture.ackPath, 'utf8'))).toMatchObject({ target_main: fixture.target });
    expect(await core.readState()).toMatchObject({ status_label: 'Ahead' });
  });
});
