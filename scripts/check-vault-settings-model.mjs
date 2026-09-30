import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const modelDir = resolve('architecture/models/formal');
const runDir = mkdtempSync(join(tmpdir(), 'obts-vault-settings-'));
const jar = process.env.TLA2TOOLS_JAR;

function run(tool, args, id) {
  const result = spawnSync(jar ? 'java' : tool, jar
    ? ['-Xmx1024m', '-cp', resolve(jar), tool === 'tla2sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args]
    : args, {
      cwd: modelDir,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, '-Xmx1024m', '-XX:+UseParallelGC', `-DTLA-Library=${join(modelDir, 'modules')}`].filter(Boolean).join(' ') }
    });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(join(runDir, `${id}.log`), output);
  if (result.error || /Parse Error|Semantic errors:|OutOfMemory|unexpected exception|Deadlock reached/u.test(output)) {
    throw new Error(`${id}: tool failure; evidence in ${runDir}`);
  }
  return { ...result, output };
}

const sany = run('tla2sany', ['OBTSVaultSettings.tla'], 'sany');
if (sany.status !== 0) throw new Error(`SANY failed; evidence in ${runDir}`);

const checks = [
  { id: 'safety', cfg: 'OBTSVaultSettings.cfg', positive: true },
  { id: 'auto-merge-recovery', cfg: 'VaultSettingsAutoMerge.cfg', positive: true, property: 'EventuallyMergeCommitted' },
  { id: 'invalid-timestamp-fallback', cfg: 'VaultSettingsConflictFallback.cfg', positive: true, property: 'EventuallyConflictRequired' },
  { id: 'stale-save', cfg: 'negative/VaultSettingsStaleSave.cfg', invariant: 'PreparedSettingsCurrent', witness: 'UnsafePrepareStaleSettings' },
  { id: 'delete-local', cfg: 'negative/VaultSettingsDeleteLocal.cfg', invariant: 'LocalCopyNeverDeleted', witness: 'UnsafeApplyExcludedTarget' },
  { id: 'recompute-merge', cfg: 'negative/VaultSettingsRecomputeMerge.cfg', invariant: 'MergeManifestPinned', witness: 'UnsafeRecomputeMergeAfterPolicyChange' }
];
for (const check of checks) {
  const result = run('tlc', ['-workers', '1', '-fp', '0', '-config', check.cfg, '-metadir', join(runDir, check.id), 'OBTSVaultSettings'], check.id);
  const stats = /([\d,]+) states generated, ([\d,]+) distinct states found/u.exec(result.output);
  const depth = /depth of the complete state graph search is (\d+)/u.exec(result.output);
  if (!stats || !depth || Number(stats[2].replaceAll(',', '')) < 1 || Number(depth[1]) < 2) {
    throw new Error(`${check.id}: invalid exploration; evidence in ${runDir}`);
  }
  if (check.positive) {
    if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.') ||
        check.property && !result.output.includes('Checking temporal properties for the complete state space')) {
      throw new Error(`${check.id}: positive model failed; evidence in ${runDir}`);
    }
  } else {
    const failures = [...result.output.matchAll(/Invariant (\w+) is violated/gu)].map((match) => match[1]);
    if (result.status === 0 || failures.length !== 1 || failures[0] !== check.invariant || !result.output.includes(`<${check.witness} line`)) {
      throw new Error(`${check.id}: expected counterexample missing; evidence in ${runDir}`);
    }
  }
  console.log(`${check.id}: ${check.positive ? 'PASS' : 'REACHED'}; generated=${stats[1]}; distinct=${stats[2]}; depth=${depth[1]}`);
}
console.log(`FM009: ${checks.length} checks passed. Evidence: ${runDir}`);
