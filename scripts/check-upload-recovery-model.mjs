import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const dir = resolve('architecture/models/formal');
const evidence = resolve('tmp/formal-upload-recovery');
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
if (tool('sany', ['OBTSUploadCheckpointRecovery.tla'], 'sany').status !== 0) throw new Error('SANY failed');
const mutations = [
  ['no-protect-old', 'JournalRequiresOldProtection'],
  ['retire-before-classification', 'NoUnprotectedRetirement'],
  ['drop-successor', 'SuccessorPublishedBeforeRetire'],
  ['drop-hints', 'LaterHintsPreserved'],
  ['rebind-base', 'OriginalBasePreserved'],
  ['replay-new-base', 'ReplayPreservesProposal'],
  ['infer-from-ref', 'RealResultRequired'],
  ['forget-publication', 'RestartKeepsPublication']
];
const checks = [['safety', 'none', null], ...mutations.map(([id, inv]) => [id, id, inv])];
for (const [id, mutation, expectedInvariant] of checks) {
  const cfg = join(run, `${id}.cfg`);
  writeFileSync(cfg, `CONSTANTS\n  OldCommit = old\n  Successor = successor\n  OriginalBase = m0\n  ReboundBase = m1\n  NoStatus = no_status\n  Open = open\n  Processing = processing\n  Completed = completed\n  Rejected = rejected\n  Missing = missing\n  Expired = expired\n  NoOutcome = no_outcome\n  Accepted = accepted\n  Conflict = conflict\n  Unknown = unknown\n  Mutation = "${mutation}"\nSPECIFICATION Spec\n${expectedInvariant ? `INVARIANT ${expectedInvariant}\n` : `INVARIANTS\n  OriginalBasePreserved\n  LaterHintsPreserved\n  NoUnprotectedRetirement\n  RealResultRequired\n  ReplayPreservesProposal\n  RestartKeepsPublication\n  JournalRequiresOldProtection\n  SuccessorPublishedBeforeRetire\n`}`);
  const result = tool('tlc', ['-workers', '1', '-fp', '0', '-config', cfg, '-metadir', join(run, id), 'OBTSUploadCheckpointRecovery'], id);
  const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(result.output);
  const depth = /depth of the complete state graph search is (\d+)/.exec(result.output);
  const minimumDistinct = expectedInvariant ? 2 : 500;
  const minimumDepth = expectedInvariant ? 1 : 9;
  if (!stats || !depth || Number(stats[2].replaceAll(',', '')) < minimumDistinct || Number(stats[2].replaceAll(',', '')) > 10000 || Number(depth[1]) < minimumDepth) {
    throw new Error(`${id}: invalid exploration (see ${run})`);
  }
  if (expectedInvariant) {
    const failures = [...result.output.matchAll(/Invariant (\w+) is violated/g)].map(match => match[1]);
    if (result.status === 0 || failures.length !== 1 || failures[0] !== expectedInvariant) throw new Error(`${id}: missing exact counterexample (see ${run})`);
  } else if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) {
    throw new Error(`${id}: positive failure (see ${run})`);
  }
  console.log(`${id}: ${expectedInvariant ? 'REJECTED' : 'PASS'}; generated=${stats[1]}; distinct=${stats[2]}; depth=${depth[1]}`);
}
console.log(`FM010: ${checks.length} checks passed. Evidence: ${run}`);
