import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ObtsPluginClient } from '../../src/client/core.js';

// Legacy replay fixtures must include actual complete preservation evidence.
// The normal writer retains visible snapshots and the full reachable Git closure.
export async function publishRecoveryFixture(vaultDir: string) {
  const journalPath = join(vaultDir, '.obts/apply-journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const wrapper = new ObtsPluginClient(vaultDir, { serverUrl: 'http://127.0.0.1:1', deviceName: 'recovery-fixture' });
  const core = (wrapper as any).client;
  journal.recovery_bundle_id = await core.createRecoveryBundle(journal.operation_type, journal.target_main, journal.affected_paths, journal);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}
