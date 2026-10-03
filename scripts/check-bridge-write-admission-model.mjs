import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = resolve(root, 'architecture/models/formal');
const model = 'OBTSBridgeWriteAdmission.tla';
const runRoot = mkdtempSync(resolve(tmpdir(), 'obts-fm012-'));
const checks = [
  ['success', 'positive'], ['timeout', 'positive'], ['stale', 'positive'], ['cancel', 'positive'],
  ['reach-success', 'witness', 'NeverDone', 'WriteCurrent'],
  ['reach-read', 'witness', 'NeverReadQueued', 'ReadDuringWait'],
  ['reach-timeout', 'witness', 'NeverTimedOut', 'Timeout'],
  ['reach-cancel', 'witness', 'NeverCancelled', 'CancelWait'],
  ['reach-stale', 'witness', 'NeverStale', 'RejectStale'],
  ['negative-cancel', 'negative', 'HealthyWaitPreserved', 'CancelWait'],
  ['negative-write', 'negative', 'OwnedRevisionWrite', 'UnsafeWrite'],
];

function run(command, args) {
  const jar = process.env.TLA2TOOLS_JAR;
  const executable = jar ? 'java' : command;
  const commandArgs = jar
    ? ['-cp', resolve(jar), command === 'tla2sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: modelDir, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: '-Xmx1024m' },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

try {
  if (!existsSync(resolve(modelDir, model))) throw new Error('Missing FM012 model.');
  for (const [name, kind, invariant] of checks) {
    const config = readFileSync(resolve(modelDir, `configs/write-admission-${name}.cfg`), 'utf8');
    if (!new RegExp(`^INVARIANT ${invariant ?? 'Safety'}$`, 'mu').test(config)) {
      throw new Error(`${name} missing required invariant.`);
    }
    if (name === 'success' && (!/^SPECIFICATION LiveSpec$/mu.test(config) || !/^PROPERTY WriterDone$/mu.test(config))) {
      throw new Error('Success must check non-vacuous writer liveness.');
    }
    if (!['positive', 'witness', 'negative'].includes(kind)) throw new Error('Invalid check kind.');
  }
  if (process.argv.includes('--validate-only')) {
    console.log(`FM012 metadata valid: ${checks.length} required checks.`);
  } else {
    const sany = run('tla2sany', [model]);
    if (sany.status !== 0 || /parse errors|semantic errors/iu.test(sany.output)) throw new Error(`SANY failed:\n${sany.output}`);
    for (const [name, kind, invariant, witness] of checks) {
      const result = run('tlc', ['-cleanup', '-workers', '1', '-fp', '0', '-config', `configs/write-admission-${name}.cfg`, '-metadir', resolve(runRoot, name), model.replace(/\.tla$/u, '')]);
      const states = [...result.output.matchAll(/([0-9,]+) states generated, ([0-9,]+) distinct states found/gu)].at(-1);
      const depth = [...result.output.matchAll(/depth of the complete state graph search is ([0-9,]+)/gu)].at(-1);
      if (!states || !depth) throw new Error(`${name} lacks complete TLC metrics:\n${result.output}`);
      const distinct = Number(states[2].replaceAll(',', ''));
      if (distinct < 2 || distinct > 10000 || Number(depth[1].replaceAll(',', '')) > 100) throw new Error(`${name} exceeded exploration bounds.`);
      if (kind === 'positive') {
        if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) throw new Error(`${name} failed:\n${result.output}`);
      } else if (result.status === 0 || !result.output.includes(`Invariant ${invariant} is violated.`) || !result.output.includes(`lastAction = "${witness}"`)) {
        throw new Error(`${name} lacks its exact invariant/witness:\n${result.output}`);
      }
      console.log(`fm012-${name}: ${kind === 'positive' ? 'PASS' : kind === 'witness' ? 'REACHED' : 'REJECTED'}; generated=${states[1]}; distinct=${states[2]}; depth=${depth[1]}`);
    }
  }
} catch (error) {
  console.error(`FM012 failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}
