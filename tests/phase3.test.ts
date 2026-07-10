import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MetadataStore } from '../src/server/metadataStore.js';

describe('Phase 3 deployable history state', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  it('upgrades Phase 2 metadata in place and initializes rebuildable history indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obts-phase3-upgrade-'));
    roots.push(root);
    const metadataDir = join(root, 'metadata');
    await mkdir(metadataDir, { recursive: true });
    await writeFile(
      join(metadataDir, 'phase1.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          setup_complete: false,
          users: [],
          sessions: [],
          vaults: [],
          devices: [],
          tokens: [],
          login_attempts: [],
          sync_operations: [],
          conflicts: [],
          events: [],
          audit_log: [],
          event_seq_by_vault: {},
          merge_sequence_by_vault: {},
          directory_state_by_vault: {}
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    const store = new MetadataStore(root);
    await store.initialize();
    const upgraded = await store.snapshot();
    expect(upgraded.schema_version).toBe(2);
    expect(upgraded.derived_history_by_vault).toEqual({});

    await store.mutate(() => undefined);
    const reloaded = new MetadataStore(root);
    await reloaded.initialize();
    expect(await reloaded.snapshot()).toMatchObject({
      schema_version: 2,
      derived_history_by_vault: {}
    });
  });
});
