import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const modelDir = resolve('architecture/models/formal');
const runDir = mkdtempSync(join(tmpdir(), 'obts-fm014-'));
const jar = process.env.TLA2TOOLS_JAR;
const model = 'OBTSAtomicRename';
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
  const architecture = readFileSync(resolve('architecture/manifest.yaml'), 'utf8');
  const revision = Number(/^revision:\s*(\d+)$/mu.exec(architecture)?.[1]);
  const registration = /- id: OBTS-FM-014\n\s+status: focused bounded model\n\s+path: architecture\/models\/formal\/OBTSAtomicRename\.tla\n\s+architecture_revision: 46\n\s+checks: architecture\/models\/formal\/configs\/fm014-atomic-rename\.cfg\n\s+refines:\n\s+- OBTS-SYNC-RENAME-001\n\s+- OBTS-PER-RENAME-001/u;
  if (!registration.test(architecture) || !Number.isInteger(revision) || revision < 46) {
    throw new Error('architecture/manifest.yaml must register FM014 against both rename contracts at revision 46 or later.');
  }
  const checks = [
    { id: 'rename-safety', mutation: 'none', property: 'AllSafety', minDistinct: 100, minDepth: 12 },
    { id: 'reach-capture-through-integration', mutation: 'reach-capture-integration', property: 'WitnessNotReached', actions: ['RecordWatcherPair', 'CapturePair', 'IntegrateClean'], minDepth: 5 },
    { id: 'reach-crash-restart-through-integration', mutation: 'reach-restart-integration', property: 'WitnessNotReached', actions: ['CrashAndRestart', 'IntegrateClean'], minDepth: 6 },
    { id: 'reach-successor-rename-through-integration', mutation: 'reach-successor-integration', property: 'WitnessNotReached', actions: ['SuccessorRenameWithEdit', 'IntegrateClean'], minDepth: 6 },
    { id: 'reach-occupied-destination-conflict', mutation: 'reach-conflict-ownership', property: 'WitnessNotReached', actions: ['RemoteOccupyDestination', 'IntegrateConflict'], minDepth: 6 },
    { id: 'mutant-half-pair-capture', mutation: 'half-capture', property: 'CapturedPairComplete', actions: ['CapturePair'], minDepth: 3 },
    { id: 'mutant-half-pair-integration', mutation: 'half-integration', property: 'MergedTreeContainsPair', actions: ['IntegrateClean'], minDepth: 6 },
    { id: 'mutant-early-retirement', mutation: 'early-retire', property: 'NoEarlyRetirement', actions: ['EarlyRetire'], minDepth: 2 },
    { id: 'mutant-rebind-retry', mutation: 'rebind', property: 'ImmutableAttempt', actions: ['RetryAttempt'], minDepth: 4 }
  ];
  for (const check of checks) {
    const config = check.mutation === 'none'
      ? join(modelDir, 'configs/fm014-atomic-rename.cfg') : join(runDir, `${check.id}.cfg`);
    if (check.mutation !== 'none') {
      writeFileSync(config, `CONSTANTS\n  Mutation = "${check.mutation}"\nSPECIFICATION Spec\nINVARIANT ${check.property}\n`);
    }
    const result = run('tlc', ['-workers', '1', '-fp', '0', '-config', config, '-metadir', join(runDir, check.id), model]);
    const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(result.output);
    const depth = /depth of the complete state graph search is (\d+)/.exec(result.output);
    const distinct = Number(stats?.[2]?.replaceAll(',', ''));
    const depthValue = Number(depth?.[1]);
    if (!stats || !depth || distinct < (check.minDistinct || 2) || distinct > 10000 || depthValue < check.minDepth) {
      throw new Error(`${check.id}: invalid state exploration:\n${result.output}`);
    }
    if (check.mutation === 'none') {
      if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) {
        throw new Error(`${check.id}: positive check failed:\n${result.output}`);
      }
    } else {
      const failures = [...result.output.matchAll(/Invariant (\w+) is violated/g)].map(match => match[1]);
      if (result.status === 0 || failures.length !== 1 || failures[0] !== check.property) {
        throw new Error(`${check.id}: expected counterexample for ${check.property}:\n${result.output}`);
      }
    }
    if (check.actions && (depthValue < check.minDepth || check.actions.some(action => !result.output.includes(action)))) {
      throw new Error(`${check.id}: required action witness/depth missing (${check.actions.join(', ')}, depth ${check.minDepth}+):\n${result.output}`);
    }
    const outcome = check.mutation.startsWith('reach-') ? 'REACHED' : check.mutation === 'none' ? 'PASS' : 'REJECTED';
    console.log(`${check.id}: ${outcome}; generated=${stats[1]}; distinct=${stats[2]}; depth=${depth[1]}`);
  }
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
