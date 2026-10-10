import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const modelDir = join(root, 'architecture/models/formal');
const runDir = mkdtempSync(join(tmpdir(), 'obts-fm015-'));
const jar = process.env.TLA2TOOLS_JAR;
const model = 'OBTSOperationHistory';

function run(tool, args) {
  const result = spawnSync(jar ? 'java' : tool === 'sany' ? 'tla2sany' : 'tlc',
    jar ? ['-Xmx1024m', '-cp', resolve(jar), tool === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args,
    { cwd: modelDir, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) throw new Error(`${tool} failed: ${result.error.message}\n${output}`);
  return { ...result, output };
}

try {
  const sany = run('sany', [`${model}.tla`]);
  if (sany.status !== 0) throw new Error(`SANY failed:\n${sany.output}`);
  const architecture = readFileSync(join(root, 'architecture/manifest.yaml'), 'utf8');
  const registration = /- id: OBTS-FM-015\n\s+status: focused bounded model\n\s+path: architecture\/models\/formal\/OBTSOperationHistory\.tla\n\s+architecture_revision: 54\n\s+checks: architecture\/models\/formal\/OBTSOperationHistory\.cfg\n\s+refines:\n\s+- OBTS-PER-HIST-001/u;
  if (!registration.test(architecture)) throw new Error('FM015 is not registered against OBTS-PER-HIST-001 at revision 54.');

  const checks = [
    { id: 'positive', config: 'OBTSOperationHistory.cfg', property: 'Integrity', kind: 'positive', minDistinct: 70, minDepth: 12 },
    { id: 'negative-drop-before-durable', config: 'configs/fm015-negative-drop.cfg', property: 'NoEvidenceLoss', kind: 'negative', actions: ['BrokenDrop'] },
    { id: 'negative-newest-binding', config: 'configs/fm015-negative-newest.cfg', property: 'LookupPreservesEarliest', kind: 'negative', actions: ['SelectNewestAttempt'] },
    { id: 'negative-lost-rename', config: 'configs/fm015-negative-rename.cfg', property: 'NoEvidenceLoss', kind: 'negative', actions: ['BrokenLoseRename'] },
    { id: 'negative-absent-null', config: 'configs/fm015-negative-absent-null.cfg', property: 'NoEvidenceLoss', kind: 'negative', actions: ['BrokenCollapseBase'] },
    { id: 'negative-restore-identity', config: 'configs/fm015-negative-restore.cfg', property: 'RestoreFailsClosed', kind: 'negative', actions: ['CorruptRestore', 'RestoreMismatch'] },
    { id: 'negative-source-mismatch', config: 'configs/fm015-negative-source.cfg', property: 'SourceMismatchFailsClosed', kind: 'negative', actions: ['TamperSource', 'RestoreSourceMismatch'] },
    { id: 'negative-stale-writer', config: 'configs/fm015-negative-stale.cfg', property: 'NoResurrection', kind: 'negative', actions: ['Erase', 'StaleWriter'] },
    { id: 'negative-serve-unverified', config: 'configs/fm015-negative-unsafe-read.cfg', property: 'NoServeUnverified', kind: 'negative', actions: ['UnsafeLookup'] },
    { id: 'negative-archive-unverified', config: 'configs/fm015-negative-unsafe-admission.cfg', property: 'NoArchiveAdmissionUnverified', kind: 'negative', actions: ['UnsafeSelect'] },
    { id: 'reach-initialization', config: 'configs/fm015-reach-initialization.cfg', property: 'NoInitializationWitness', kind: 'reachability', actions: ['InitializeMetadata'], minDistinct: 2, minDepth: 2 },
    { id: 'reach-interrupted-parent-generation-recovery', config: 'configs/fm015-reach-recovery.cfg', property: 'NoRecoveryWitness', kind: 'reachability', actions: ['Crash', 'RecoverParent'] },
    { id: 'reach-interrupted-target-generation-recovery', config: 'configs/fm015-reach-target-recovery.cfg', property: 'NoTargetRecoveryWitness', kind: 'reachability', actions: ['CommitArchive', 'Crash', 'RecoverTarget'] },
    { id: 'reach-foreign-restore-block', config: 'configs/fm015-reach-restore-block.cfg', property: 'NoRestoreBlockWitness', kind: 'reachability', actions: ['CorruptRestore', 'RestoreMismatch'] },
    { id: 'reach-missing-ledger-block', config: 'configs/fm015-reach-missing-block.cfg', property: 'NoMissingBlockWitness', kind: 'reachability', actions: ['RestoreMissingLedger', 'CheckMissingLedger'] },
    { id: 'reach-generation-block', config: 'configs/fm015-reach-generation-block.cfg', property: 'NoGenerationBlockWitness', kind: 'reachability', actions: ['RestoreAhead', 'CheckWrongGeneration'] },
    { id: 'reach-generation-ahead', config: 'configs/fm015-reach-generation-ahead.cfg', property: 'NoAheadWitness', kind: 'reachability', actions: ['RestoreAhead'] },
    { id: 'reach-generation-behind', config: 'configs/fm015-reach-generation-behind.cfg', property: 'NoBehindWitness', kind: 'reachability', actions: ['CommitArchive', 'PublishRemoval', 'RestoreBehind'] },
    { id: 'reach-vault-deletion', config: 'configs/fm015-reach-deletion.cfg', property: 'NoDeletionWitness', kind: 'reachability', actions: ['BeginDelete', 'Erase'] }
  ];
  for (const check of checks) {
    const result = run('tlc', ['-workers', '1', '-fp', '0', '-config', join(modelDir, check.config), '-metadir', join(runDir, check.id), model]);
    const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(result.output);
    const depth = /depth of the complete state graph search is (\d+)/.exec(result.output);
    const distinct = Number(stats?.[2]?.replaceAll(',', ''));
    const depthValue = Number(depth?.[1]);
    const minimumDepth = check.minDepth ?? check.actions?.length ?? 3;
    if (!stats || !depth || distinct < (check.minDistinct ?? 3) || depthValue < minimumDepth || distinct > 10000) {
      throw new Error(`${check.id}: incomplete state exploration:\n${result.output}`);
    }
    if (check.kind === 'positive') {
      if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) throw new Error(`${check.id} failed:\n${result.output}`);
    } else {
      const failures = [...result.output.matchAll(/Invariant (\w+) is violated/g)].map(match => match[1]);
      if (result.status === 0 || failures.length !== 1 || failures[0] !== check.property || check.actions.some(action => !result.output.includes(action))) {
        throw new Error(`${check.id}: expected ${check.property} witness through ${check.actions.join(' -> ')}:\n${result.output}`);
      }
    }
    console.log(`${check.id}: ${check.kind === 'positive' ? 'PASS' : check.kind === 'reachability' ? 'REACHED' : 'REJECTED'}; generated=${stats[1]}; distinct=${stats[2]}; depth=${depth[1]}`);
  }
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
