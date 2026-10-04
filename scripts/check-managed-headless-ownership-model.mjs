import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const modelDir = resolve('architecture/models/formal');
const runDir = mkdtempSync(join(tmpdir(), 'obts-fm013-'));
const jar = process.env.TLA2TOOLS_JAR;
const model = 'OBTSManagedHeadlessOwnership';
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
  const checks = [
    ['owner-cardinality', 'none', 'OneProcessOwner'],
    ['lock-child-lifetime', 'none', 'OwnedLockHasLiveChild'],
    ['marker-bound-to-generation', 'none', 'MarkerBoundToLaunch'],
    ['unknown-preserved', 'none', 'UnknownMarkerWasNotReclaimed'],
    ['same-generation-preserved', 'none', 'LiveMarkerWasNotReclaimed'],
    ['replacement-preserved', 'none', 'ReplacementWasNotDeleted'],
    ['truthful-single-report', 'none', 'TruthfulFailureReport'],
    ['single-event-bound', 'none', 'NoDuplicateStateEvent'],
    ['reported-after-failure', 'none', null],
    ['reach-supervisor-death-with-live-child', 'witness', 'NeverDetachedChild'],
    ['reach-surviving-descendant-lock', 'witness', 'NeverTerminatedGroup'],
    ['reach-stale-marker-reconciliation', 'witness', 'NeverReconciled'],
    ['reach-child-exit-and-restart-generation', 'witness', 'NeverRestarted'],
    ['mutant-duplicate-owner', 'duplicate-owner', 'OneProcessOwner'],
    ['mutant-same-generation-reclaim', 'same-generation-reclaim', 'LiveMarkerWasNotReclaimed'],
    ['mutant-replacement-delete', 'replacement-delete', 'ReplacementWasNotDeleted'],
    ['mutant-steal-unknown', 'steal-unknown', 'UnknownMarkerWasNotReclaimed'],
    ['mutant-duplicate-event', 'duplicate-event', 'NoDuplicateStateEvent'],
    ['mutant-supervisor-release', 'supervisor-release', 'OwnedLockHasLiveChild'],
    ['mutant-leader-exit-before-group-termination', 'leader-exit-release', 'OwnedLockHasLiveChild']
  ];
  for (const [id, mutation, property] of checks) {
    const config = join(runDir, `${id}.cfg`);
    writeFileSync(config, `CONSTANTS\n  Mutation = "${mutation}"\nSPECIFICATION ${property === null ? 'FairSpec' : 'Spec'}\n${property === null ? 'PROPERTY FailureReportedAfterFailure' : `INVARIANT ${property}`}\n`);
    const result = run('tlc', ['-workers', '1', '-fp', '0', '-config', config, '-metadir', join(runDir, id), model]);
    const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(result.output);
    const depth = /depth of the complete state graph search is (\d+)/.exec(result.output);
    if (!stats || !depth || Number(stats[2].replaceAll(',', '')) < 2 || Number(stats[2].replaceAll(',', '')) > 10000) {
      throw new Error(`${id}: invalid state exploration:\n${result.output}`);
    }
    if (mutation !== 'none') {
      const failures = [...result.output.matchAll(/Invariant (\w+) is violated/g)].map(match => match[1]);
      if (result.status === 0 || failures.length !== 1 || failures[0] !== property) {
        throw new Error(`${id}: expected counterexample for ${property}:\n${result.output}`);
      }
    } else if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) {
      throw new Error(`${id}: positive check failed:\n${result.output}`);
    }
    const outcome = id.startsWith('reach-') ? 'REACHED' : mutation === 'none' ? 'PASS' : 'REJECTED';
    console.log(`${id}: ${outcome}; generated=${stats[1]}; distinct=${stats[2]}; depth=${depth[1]}`);
  }
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
