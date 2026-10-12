import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const modelDir = resolve('architecture/models/formal');
const runDir = resolve('tmp/dashboard-ux/formal-dashboard-protocols');
const jar = process.env.TLA2TOOLS_JAR;
const checks = [
  { id: 'dashboard-positive', model: 'OBTSDashboardProtocols', config: 'configs/dashboard-positive.cfg', pass: true },
  { id: 'dashboard-reach-sampler', model: 'OBTSDashboardProtocols', invariants: ['ReachSampler'], action: 'StartSample', reach: true },
  { id: 'dashboard-reach-trailing-refresh', model: 'OBTSDashboardProtocols', invariants: ['ReachTrailingRefresh'], action: 'CommitOwnerChange', reach: true },
  { id: 'dashboard-negative-stale-health', model: 'OBTSDashboardProtocols', mutation: 'unsafe-stale-health', invariants: ['HealthHonest'], action: 'Tick' },
  { id: 'dashboard-negative-overlap-sampler', model: 'OBTSDashboardProtocols', mutation: 'overlap-sampler', invariants: ['SingleFlight'], action: 'StartSample' },
  { id: 'dashboard-negative-liveness-throttle', model: 'OBTSDashboardProtocols', mutation: 'ignore-liveness-throttle', invariants: ['LivenessCoalesced'], action: 'PersistLiveness' },
  { id: 'dashboard-negative-precommit', model: 'OBTSDashboardProtocols', mutation: 'precommit', invariants: ['NoPrecommitInvalidation'], action: 'CommitOwnerChange' },
  { id: 'dashboard-negative-magic-refresh', model: 'OBTSDashboardProtocols', mutation: 'magic-refresh', invariants: ['NoRefreshClaimsUnfetched'], action: 'FinishRefresh' },
  { id: 'dashboard-negative-trailing-refresh', model: 'OBTSDashboardProtocols', mutation: 'drop-trailing', invariants: ['TrailingAfterStaleResponse'], action: 'FinishRefresh' },
  { id: 'dashboard-negative-owner-isolation', model: 'OBTSDashboardProtocols', mutation: 'owner-leak', invariants: ['OwnerIsolation'], action: 'SwitchOwner' },
  { id: 'device-removal-positive-covered', model: 'OBTSDeviceRemoval', config: 'configs/device-removal-positive.cfg', pass: true },
  { id: 'device-removal-positive-unmerged', model: 'OBTSDeviceRemoval', mode: 'unmerged', invariants: ['IntentBeforeRef', 'DrainBeforeRef', 'ConflictAndPreparedGate', 'UnmergedRequiresDiscard', 'CASUsesExpectedOID', 'CanonicalAndOtherDevicePreserved', 'CompletionAfterCleanup', 'OwnerIsolation', 'StartupBarrierBeforeReady'], pass: true },
  { id: 'device-removal-reach-intent', model: 'OBTSDeviceRemoval', invariants: ['ReachDurableIntent'], action: 'PublishIntent', reach: true },
  { id: 'device-removal-reach-covered-success', model: 'OBTSDeviceRemoval', mode: 'covered', invariants: ['ReachCoveredRemoval'], action: 'PublishCompletion', reach: true },
  { id: 'device-removal-reach-discard-success', model: 'OBTSDeviceRemoval', mode: 'unmerged', invariants: ['ReachDiscardRemoval'], action: 'PublishCompletion', reach: true, requiredActions: ['ConfirmDiscard'] },
  { id: 'device-removal-reach-retry-intent', model: 'OBTSDeviceRemoval', mode: 'covered', invariants: ['ReachRebasedIntent'], action: 'RetryIntent', reach: true, requiredActions: ['FinishCoveredWork'] },
  { id: 'device-removal-reach-crash-restart', model: 'OBTSDeviceRemoval', mode: 'covered', invariants: ['ReachRestartAfterRefRemoval'], action: 'StartupReady', reach: true, requiredActions: ['Crash', 'Restart', 'RestoreBarrier'] },
  { id: 'device-removal-negative-intent-order', model: 'OBTSDeviceRemoval', mutation: 'intent-before-ref', invariants: ['IntentBeforeRef'], action: 'RemoveRef' },
  { id: 'device-removal-negative-drain', model: 'OBTSDeviceRemoval', mutation: 'skip-drain', invariants: ['DrainBeforeRef'], action: 'RemoveRef' },
  { id: 'device-removal-negative-conflict', model: 'OBTSDeviceRemoval', mutation: 'skip-conflict', invariants: ['ConflictAndPreparedGate'], action: 'RemoveRef' },
  { id: 'device-removal-negative-prepared', model: 'OBTSDeviceRemoval', mutation: 'skip-prepared', invariants: ['ConflictAndPreparedGate'], action: 'RemoveRef' },
  { id: 'device-removal-negative-unmerged-confirmation', model: 'OBTSDeviceRemoval', mode: 'unmerged', mutation: 'skip-unmerged', invariants: ['UnmergedRequiresDiscard'], action: 'RemoveRef' },
  { id: 'device-removal-negative-wrong-cas', model: 'OBTSDeviceRemoval', mutation: 'wrong-cas', invariants: ['CASUsesExpectedOID'], action: 'RemoveRef' },
  { id: 'device-removal-negative-premature-completion', model: 'OBTSDeviceRemoval', mutation: 'premature-completion', invariants: ['CompletionAfterCleanup'], action: 'PublishCompletion' },
  { id: 'device-removal-negative-preservation', model: 'OBTSDeviceRemoval', mutation: 'damage-preserved-state', invariants: ['CanonicalAndOtherDevicePreserved'], action: 'RemoveRef' },
  { id: 'device-removal-negative-owner-isolation', model: 'OBTSDeviceRemoval', mutation: 'owner-bypass', invariants: ['OwnerIsolation'], action: 'RemoveRef' },
  { id: 'vault-creation-positive', model: 'OBTSVaultCreationReadiness', invariants: ['TypeOK', 'NoFalseOrphan', 'FailClosedOnOrphan'], pass: true },
  { id: 'vault-creation-reach-skipped', model: 'OBTSVaultCreationReadiness', invariants: ['ReachSkippedCreation'], action: 'Conclude', reach: true, requiredActions: ['Reserve', 'List'] },
  { id: 'vault-creation-reach-recheck', model: 'OBTSVaultCreationReadiness', invariants: ['ReachRecheckRescue'], action: 'Conclude', reach: true, requiredActions: ['Commit', 'Release'] },
  { id: 'vault-creation-reach-orphan', model: 'OBTSVaultCreationReadiness', invariants: ['ReachOrphanDetected'], action: 'Conclude', reach: true, requiredActions: ['Fail'] },
  { id: 'vault-creation-negative-no-reservation', model: 'OBTSVaultCreationReadiness', mutation: 'no-reservation', invariants: ['NoFalseOrphan'], action: 'Conclude', requiredActions: ['InitPartial'] },
  { id: 'vault-creation-negative-no-skip', model: 'OBTSVaultCreationReadiness', mutation: 'no-skip', invariants: ['NoFalseOrphan'], action: 'Conclude', requiredActions: ['InitPartial'] },
  { id: 'vault-creation-negative-no-recheck', model: 'OBTSVaultCreationReadiness', mutation: 'no-recheck', invariants: ['NoFalseOrphan'], action: 'Conclude', requiredActions: ['Commit', 'Release'] },
  { id: 'vault-creation-negative-early-release', model: 'OBTSVaultCreationReadiness', mutation: 'early-release', invariants: ['NoFalseOrphan'], action: 'Conclude', requiredActions: ['ReleaseEarly'] },
  { id: 'vault-creation-negative-leaked-reservation', model: 'OBTSVaultCreationReadiness', mutation: 'leak-reservation', invariants: ['FailClosedOnOrphan'], action: 'Conclude', requiredActions: ['Fail'] },
  { id: 'vault-creation-negative-ignore-unknown', model: 'OBTSVaultCreationReadiness', mutation: 'ignore-unknown', invariants: ['FailClosedOnOrphan'], action: 'Conclude', requiredActions: ['Fail'] }
];

function run(tool, args, cwd) {
  const result = spawnSync(jar ? 'java' : tool === 'sany' ? 'tla2sany' : 'tlc',
    jar ? ['-Xmx1024m', '-cp', resolve(jar), tool === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args,
    { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) throw new Error(`${tool} failed: ${result.error.message}\n${output}`);
  return { ...result, output };
}

function configFor(check) {
  if (check.config) return resolve(modelDir, check.config);
  const values = check.model === 'OBTSDashboardProtocols'
    ? '  MaxAge = 1\n  Minute = 1\n  AccountA = "owner-a"\n  AccountB = "owner-b"\n'
    : check.model === 'OBTSDeviceRemoval'
      ? `  OwnerA = "owner-a"\n  OwnerB = "owner-b"\n  ExpectedOID = "device-commit"\n  CanonicalOID = "main-commit"\n  OtherOID = "other-device-ref"\n  WorkMode = "${check.mode ?? 'covered'}"\n`
      : '';
  const text = `CONSTANTS\n${values}  Mutation = "${check.mutation ?? 'none'}"\nSPECIFICATION Spec\n${check.invariants.map(name => `INVARIANT ${name}`).join('\n')}\n`;
  const path = join(runDir, `${check.id}.cfg`);
  writeFileSync(path, text);
  return path;
}

try {
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  for (const model of ['OBTSDashboardProtocols', 'OBTSDeviceRemoval', 'OBTSVaultCreationReadiness']) {
    const sany = run('sany', [`${model}.tla`], modelDir);
    if (sany.status !== 0) throw new Error(`SANY failed for ${model}:\n${sany.output}`);
  }
  for (const check of checks) {
    const config = configFor(check);
    const metaDir = join(runDir, 'meta', check.id);
    mkdirSync(metaDir, { recursive: true });
    const result = run('tlc', ['-workers', '1', '-fp', '0', '-config', config, '-metadir', metaDir, check.model], modelDir);
    const counts = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(result.output);
    const depth = /depth of the complete state graph search is (\d+)/.exec(result.output);
    if (!counts || !depth) throw new Error(`${check.id}: TLC/tool output lacks complete exploration evidence:\n${result.output}`);
    const distinct = Number(counts[2].replaceAll(',', ''));
    if (distinct < (check.pass ? 5 : 2) || distinct > 30000 || Number(depth[1]) < 2 || Number(depth[1]) > 60) {
      throw new Error(`${check.id}: unexpected state/depth bounds ${counts[1]}/${counts[2]}/${depth[1]}`);
    }
    if (check.pass) {
      if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) {
        throw new Error(`${check.id}: positive model check failed (exit ${result.status}):\n${result.output}`);
      }
      console.log(`${check.id}: PASS; generated=${counts[1]}; distinct=${counts[2]}; depth=${depth[1]}`);
      continue;
    }
    const found = [...result.output.matchAll(/Invariant (\w+) is violated/g)].map(match => match[1]);
    const missingWitnessActions = (check.requiredActions ?? []).filter(action => !result.output.includes(`<${action} `));
    if (result.status === 0 || found.length !== 1 || found[0] !== check.invariants[0] || !result.output.includes(`<${check.action} `) || missingWitnessActions.length > 0) {
      throw new Error(`${check.id}: expected exact invariant ${check.invariants[0]} and witness actions ${[check.action, ...(check.requiredActions ?? [])].join(', ')} (exit ${result.status}):\n${result.output}`);
    }
    console.log(`${check.id}: ${check.reach ? 'REACHED' : 'REJECTED'} (${found[0]}); generated=${counts[1]}; distinct=${counts[2]}; depth=${depth[1]}`);
  }
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
