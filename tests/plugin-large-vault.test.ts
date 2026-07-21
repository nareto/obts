import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ObtsPluginClient } from '../src/client/core.js';

const roots: string[] = [];
const delay = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

async function clientFixture(): Promise<{ root: string; plugin: ObtsPluginClient; core: any }> {
  const root = await mkdtemp(join(tmpdir(), 'obts-large-vault-'));
  roots.push(root);
  const plugin = new ObtsPluginClient(root, { serverUrl: 'http://127.0.0.1:1', deviceName: 'large-vault-test' });
  await plugin.initialize();
  return { root, plugin, core: (plugin as any).client };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('large-vault client checkpoints', () => {
  it('checks files concurrently within the configured bound', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'notes'));
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(root, 'notes', `${index}.md`), `note ${index}\n`);
    }

    core.fileWorkConcurrency = 3;
    const adapter = core.adapter;
    const readBinary = adapter.readBinary.bind(adapter);
    let active = 0;
    let maximum = 0;
    adapter.readBinary = async (path: string) => {
      if (!path.startsWith('.obts/')) {
        active += 1;
        maximum = Math.max(maximum, active);
        await delay(10);
      }
      try {
        return await readBinary(path);
      } finally {
        if (!path.startsWith('.obts/')) active -= 1;
      }
    };

    await expect(core.createLocalCommit('bounded checkpoint')).resolves.toMatch(/^[0-9a-f]{40}$/u);
    expect(maximum).toBe(3);
  });

  it('drains bounded apply writes before returning', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'incoming'));
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, 'incoming', `${index}.md`), `incoming ${index}\n`);
    }
    const target = await core.createLocalCommit('target');
    const targetEntries = await core.listTreeBlobOids(target);
    await rm(join(root, 'incoming'), { recursive: true, force: true });

    core.fileWorkConcurrency = 3;
    const adapterWriteBinary = core.adapterWriteBinary.bind(core);
    let active = 0;
    let maximum = 0;
    core.adapterWriteBinary = async (path: string, content: Buffer) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(10);
      try {
        await adapterWriteBinary(path, content);
      } finally {
        active -= 1;
      }
    };

    const paths = [...targetEntries.keys()];
    await core.writeTargetFilesFromJournal({
      journal_version: 2,
      apply_id: 'apply_bounded_test',
      operation_type: 'pull_apply',
      target_main: target,
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: paths,
      preflight_sha256: Object.fromEntries(paths.map((path) => [path, null])),
      preflight_fingerprints: Object.fromEntries(paths.map((path) => [path, { kind: 'missing', sha256: null, oid: null }])),
      recovery_bundle_id: 'rec_bounded_test',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, targetEntries, new Set());

    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(await readFile(join(root, 'incoming', '7.md'), 'utf8')).toBe('incoming 7\n');
  });

  it('drains active apply writes and stops scheduling after a failure', async () => {
    const { root, core } = await clientFixture();
    await mkdir(join(root, 'incoming'));
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, 'incoming', `${index}.md`), `incoming ${index}\n`);
    }
    const target = await core.createLocalCommit('failure target');
    const targetEntries = await core.listTreeBlobOids(target);
    await rm(join(root, 'incoming'), { recursive: true, force: true });

    core.fileWorkConcurrency = 3;
    const adapterWriteBinary = core.adapterWriteBinary.bind(core);
    const started: string[] = [];
    let active = 0;
    core.adapterWriteBinary = async (path: string, content: Buffer) => {
      started.push(path);
      active += 1;
      try {
        if (path === 'incoming/0.md') {
          await delay(5);
          throw new Error('simulated apply write failure');
        }
        await delay(20);
        await adapterWriteBinary(path, content);
      } finally {
        active -= 1;
      }
    };

    const paths = [...targetEntries.keys()];
    await expect(core.writeTargetFilesFromJournal({
      journal_version: 2,
      apply_id: 'apply_failure_test',
      operation_type: 'pull_apply',
      target_main: target,
      expected_prior_local_main: null,
      expected_prior_local_device_ref: null,
      phase: 'writing_files',
      affected_paths: paths,
      preflight_sha256: Object.fromEntries(paths.map((path) => [path, null])),
      preflight_fingerprints: Object.fromEntries(paths.map((path) => [path, { kind: 'missing', sha256: null, oid: null }])),
      recovery_bundle_id: 'rec_failure_test',
      last_completed_step: 'recovery_bundle',
      redacted_error_category: null
    }, targetEntries, new Set())).rejects.toThrow('simulated apply write failure');

    expect(active).toBe(0);
    expect(started).toEqual(['incoming/0.md', 'incoming/1.md', 'incoming/2.md']);
  });

  it('fails a changing inventory without advancing the local ref', async () => {
    const { root, core } = await clientFixture();
    await writeFile(join(root, 'race.md'), 'before\n');
    const adapter = core.adapter;
    const readBinary = adapter.readBinary.bind(adapter);
    let removed = false;
    adapter.readBinary = async (path: string) => {
      const value = await readBinary(path);
      if (path === 'race.md' && !removed) {
        removed = true;
        await rm(join(root, path));
      }
      return value;
    };

    await expect(core.createLocalCommit('racing checkpoint')).rejects.toMatchObject({ code: 'local_snapshot_changed' });
    expect(await core.resolveRef('refs/heads/local')).toBeNull();
  });
});
