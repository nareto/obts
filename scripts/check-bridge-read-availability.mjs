import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = resolve(root, 'architecture/models/formal');
const manifestPath = resolve(modelDir, 'checks-fm010.json');
const runRoot = mkdtempSync(resolve(tmpdir(), 'obts-fm010-'));
const validateOnly = process.argv.includes('--validate-only');
const expectedIds = [
  'fm010-held-sync-safety', 'fm010-own-write-safety',
  'fm010-race-safety', 'fm010-publication-safety',
  'fm010-failure-safety', 'fm010-authorization-safety',
  'fm010-reach-held-sync-read', 'fm010-reach-own-write-read',
  'fm010-reach-unrelated-read', 'fm010-reach-post-response-drift',
  'fm010-negative-partial-publication', 'fm010-negative-body-mismatch',
  'fm010-negative-unauthorized-hydration', 'fm010-negative-sync-lock',
];

const expectedChecks = [
  ['positive', 'fm010-held-sync.cfg'], ['positive', 'fm010-own-write.cfg'],
  ['positive', 'fm010-race.cfg'], ['positive', 'fm010-publication.cfg'],
  ['positive', 'fm010-failed.cfg'], ['positive', 'fm010-unauthorized.cfg'],
  ['reachability', 'fm010-reach-held-sync.cfg', 'NeverHeldRead', 'HydrateRead'],
  ['reachability', 'fm010-reach-own-write.cfg', 'NeverOwnRead', 'HydrateRead'],
  ['reachability', 'fm010-reach-unrelated-read.cfg', 'NeverUnrelatedRead', 'ReadUnrelated'],
  ['reachability', 'fm010-reach-post-response-drift.cfg', 'NeverPostResponseDrift', 'ChangeSource'],
  ['negative-control', 'fm010-negative-partial-publication.cfg', 'CompleteSelection', 'SelectRead'],
  ['negative-control', 'fm010-negative-body-mismatch.cfg', 'BodyAttested', 'HydrateRead'],
  ['negative-control', 'fm010-negative-unauthorized.cfg', 'AuthorizedHydration', 'HydrateRead'],
  ['negative-liveness', 'fm010-negative-sync-lock.cfg', 'ReadEventually', 'Init'],
];

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  if (validateOnly) {
    console.log(`FM010 manifest valid: ${manifest.checks.length} required checks.`);
  } else {
    runSany(manifest);
    const results = manifest.checks.map((check) => runCheck(manifest, check));
    console.log(`FM010 passed: ${results.length} checks; ${results.filter((result) => result.outcome === 'PASS').length} positive, ${results.filter((result) => result.outcome === 'REACHED').length} reachability/negative controls.`);
    for (const result of results) console.log(`${result.id}: ${result.outcome}; generated=${result.generated}; distinct=${result.distinct}; depth=${result.depth}`);
  }
} catch (error) {
  console.error(`FM010 failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

function contained(path, label) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) throw new Error(`${label} must be a relative path.`);
  const resolved = resolve(modelDir, path);
  const rel = relative(modelDir, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the model directory.`);
  return resolved;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not exist: ${path}`);
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.modelId !== 'OBTS-FM-011' || manifest.architectureRevision !== 40 || manifest.architectureStatus !== 'architecture-stage') {
    throw new Error('checks-fm010.json must describe OBTS-FM-011 at architecture revision 40.');
  }
  if (!Array.isArray(manifest.checks) || manifest.checks.map((check) => check.id).join('|') !== expectedIds.join('|')) {
    throw new Error('FM010 required check IDs/order changed.');
  }
  requireFile(contained(manifest.model, 'model'), 'FM010 model');
  for (const [index, check] of manifest.checks.entries()) {
    const descriptor = [check.kind, check.config];
    if (check.kind !== 'positive') descriptor.push(check.expectedInvariant ?? check.expectedProperty, check.requiredWitness);
    if (JSON.stringify(descriptor) !== JSON.stringify(expectedChecks[index])) {
      throw new Error(`${check.id} required control metadata changed.`);
    }
    requireFile(contained(check.config, `${check.id} config`), `${check.id} config`);
    const config = readFileSync(contained(check.config, 'config'), 'utf8');
    const property = check.expectedInvariant ?? check.expectedProperty ?? 'Safety';
    const directive = check.kind === 'negative-liveness' ? 'PROPERTY' : 'INVARIANT';
    if (!new RegExp(`^${directive} ${property}$`, 'mu').test(config)) throw new Error(`${check.id} missing required ${directive}.`);
    if (index < 2 && (!/^SPECIFICATION LiveSpec$/mu.test(config) || !/^PROPERTY ReadEventually$/mu.test(config))) throw new Error(`${check.id} must check read liveness.`);
    if (!Number.isInteger(check.maximumDepth ?? 100) || (check.maximumDepth ?? 100) <= 0) throw new Error(`${check.id} has an invalid depth limit.`);
    if (check.kind !== 'positive' && (!(check.expectedInvariant || check.expectedProperty) || !check.requiredWitness || !Number.isInteger(check.minimumTraceDepth))) {
      throw new Error(`${check.id} lacks its required counterexample gate.`);
    }
  }
}

function runSany(manifest) {
  const result = run('tla2sany', [manifest.model], manifest.tooling.defaultTimeoutMs, manifest.tooling.defaultHeapMb);
  if (result.error || result.status !== 0 || /parse errors|semantic errors/iu.test(result.output)) throw new Error(`SANY failed:\n${result.output}`);
}

function runCheck(manifest, check) {
  const result = run('tlc', ['-cleanup', '-workers', String(manifest.tooling.workers), '-fp', String(manifest.tooling.fingerprintPolynomial), '-config', check.config, '-metadir', resolve(runRoot, check.id), manifest.model.replace(/\.tla$/u, '')], manifest.tooling.defaultTimeoutMs, manifest.tooling.defaultHeapMb);
  if (result.error) throw new Error(`${check.id} could not execute: ${result.error.message}`);
  const states = [...result.output.matchAll(/([0-9,]+) states generated, ([0-9,]+) distinct states found/gu)].at(-1);
  const depth = [...result.output.matchAll(/depth of the complete state graph search is ([0-9,]+)/gu)].at(-1);
  const traceDepth = [...result.output.matchAll(/^State ([0-9]+):/gmu)].at(-1);
  const measuredDepth = depth?.[1] ?? (check.kind === 'negative-liveness' ? traceDepth?.[1] : undefined);
  if (!states || !measuredDepth) throw new Error(`${check.id} did not report complete TLC metrics:\n${result.output}`);
  const metrics = { generated: Number(states[1].replaceAll(',', '')), distinct: Number(states[2].replaceAll(',', '')), depth: Number(measuredDepth.replaceAll(',', '')) };
  if (metrics.distinct > manifest.tooling.maximumDistinctStates || metrics.depth > (check.maximumDepth ?? 100)) throw new Error(`${check.id} exceeded its state/depth budget.`);
  if (check.kind === 'positive') {
    if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) throw new Error(`${check.id} failed:\n${result.output}`);
    return { id: check.id, outcome: 'PASS', ...metrics };
  }
  const violation = check.kind === 'negative-liveness'
    ? result.output.includes('Temporal properties were violated.') && result.output.includes('Stuttering')
    : result.output.includes(`Invariant ${check.expectedInvariant} is violated.`);
  if (result.status === 0 || !violation) throw new Error(`${check.id} did not violate its expected property:\n${result.output}`);
  if (!result.output.includes(`lastAction = "${check.requiredWitness}"`) || metrics.depth < check.minimumTraceDepth) throw new Error(`${check.id} lacks ${check.requiredWitness} at the required depth.`);
  return { id: check.id, outcome: 'REACHED', ...metrics };
}

function run(command, args, timeoutMs, heapMb) {
  const jar = process.env.TLA2TOOLS_JAR;
  const executable = jar ? 'java' : command;
  const commandArgs = jar ? ['-cp', resolve(jar), command === 'tla2sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: modelDir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: `-Xmx${heapMb}m` },
  });
  return { status: result.status, error: result.error, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}
