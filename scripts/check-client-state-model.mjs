import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dir = resolve('architecture/models/formal');
const evidence = resolve('tmp/formal-client-state');
mkdirSync(evidence, { recursive: true });
const run = mkdtempSync(join(evidence, 'run-'));
const jar = process.env.TLA2TOOLS_JAR;
function tool(name, args, id) {
  const result = spawnSync(jar ? 'java' : name === 'sany' ? 'tla2sany' : 'tlc',
    jar ? ['-Xmx1024m', '-cp', resolve(jar), name === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args,
    { cwd: dir, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(join(run, `${id}.log`), output);
  if (result.error || /Parse Error|Semantic errors:|OutOfMemory|unexpected exception|Deadlock reached/.test(output)) {
    throw new Error(`${id}: tool failure (see ${run})`);
  }
  return { ...result, output };
}
if (tool('sany', ['OBTSClientStateRecovery.tla'], 'sany').status !== 0) throw new Error('SANY failed');
const checks = [
  ['safety', 'none', 'Safety', null],
  ['liveness', 'none', 'Safety', null],
  ['restart-recovery', 'none', 'NeverRestartedRecovery', 'Read'],
  ['queue-rollback', 'queue-authority', 'ObservationPreserved', 'Read'],
  ['stale-primary', 'always-primary', 'LocalRefsRecovered', 'Read'],
  ['attempt-rewrite', 'rewrite-attempt', 'AttemptUnchanged', 'Read'],
  ['equal-ref-error', 'copy-backup-error', 'ObservationPreserved', 'Read'],
  ['incomparable-head', 'incomparable-head', 'SplitRefsPreserved', 'Read'],
  ['settled-proposal-restore', 'restore-settled', 'ApplyKeepsRefWithState', 'PreserveEdits'],
  ['state-follows-ref', 'state-follows-ref', 'ProposalOnResolution', 'Repair'],
  ['unverified-ref-repair', 'unverified-repair', 'NoAncestorRevertProposal', 'Repair'],
  ['missing-ref-repair', 'no-repair', 'Safety', 'liveness']
];
const properties = 'PROPERTY EventuallyRead\nPROPERTY EventuallyProposedOrPreserved\n';
for (const [id, mutation, invariant, witness] of checks) {
  const cfg = join(run, `${id}.cfg`);
  const fair = id === 'liveness' || witness === 'liveness';
  writeFileSync(cfg, `CONSTANT Mutation = "${mutation}"\nSPECIFICATION ${fair ? 'FairSpec' : 'Spec'}\nINVARIANT ${invariant}\n${fair ? properties : ''}`);
  const result = tool('tlc', ['-workers', '1', '-fp', '0', '-config', cfg, '-metadir', join(run, id), 'OBTSClientStateRecovery'], id);
  const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(result.output);
  const depth = /depth of the complete state graph search is (\d+)/.exec(result.output)
    || (witness === 'liveness' ? [...result.output.matchAll(/Progress\((\d+)\)/g)].pop() : null);
  if (!stats || !depth || Number(stats[2].replaceAll(',', '')) < 5 || Number(stats[2].replaceAll(',', '')) > 10000 || Number(depth[1]) < 3) throw new Error(`${id}: invalid exploration (see ${run})`);
  if (witness === 'liveness') {
    if (result.status === 0 || /Invariant \w+ is violated/.test(result.output) || !result.output.includes('Temporal properties were violated') || !/Stuttering|Back to state/.test(result.output)) throw new Error(`${id}: missing exact liveness counterexample (see ${run})`);
  } else if (witness) {
    const failures = [...result.output.matchAll(/Invariant (\w+) is violated/g)].map(x => x[1]);
    if (result.status === 0 || failures.length !== 1 || failures[0] !== invariant || !result.output.includes(`<${witness} line`)) throw new Error(`${id}: missing exact counterexample (see ${run})`);
  } else if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) throw new Error(`${id}: positive failure`);
  console.log(`${id}: ${witness ? 'REACHED' : 'PASS'}; generated=${stats[1]}; distinct=${stats[2]}; depth=${depth[1]}`);
}
console.log(`FM008: ${checks.length} checks passed. Evidence: ${run}`);
