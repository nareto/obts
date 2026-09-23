import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = join(root, 'architecture', 'models', 'formal');
const manifestPath = resolve(process.env.FM006_CHECKS_MANIFEST ?? join(modelDir, 'checks-fm006.json'));
const architectureManifestPath = join(root, 'architecture', 'manifest.yaml');
const validateOnly = process.argv.includes('--validate-only');
const testMode = process.env.FM006_TEST_MODE === '1';
const runRoot = mkdtempSync(join(tmpdir(), 'obts-fm006-'));
const requiredChecks = [
  ['fm006-empty-safety', 'positive-safety'],
  ['fm006-empty-liveness', 'positive-liveness'],
  ['fm006-nonempty-safety', 'positive-safety'],
  ['fm006-nonempty-liveness', 'positive-liveness'],
  ['fm006-reach-restart', 'reachability'],
  ['fm006-negative-pending-deadline', 'negative-control'],
  ['fm006-negative-retarget', 'negative-control'],
  ['fm006-negative-transfer-before-registration', 'negative-control'],
  ['fm006-negative-apply-before-recovery', 'negative-control'],
  ['fm006-negative-final-checkpoint', 'negative-control'],
  ['fm006-negative-complete-before-ack', 'negative-control']
];

try {
  const manifest = loadJson(manifestPath, 'FM006 checks manifest');
  validateManifest(manifest);
  if (validateOnly) {
    console.log(`FM006 manifest valid: ${manifest.checks.length} required checks; bounds/configs valid.`);
  } else {
    runSany(manifest);
    const summaries = manifest.checks.map((check) => runCheck(manifest, check));
    console.log(`FM006 passed: ${summaries.length} checks; ${summaries.filter(x => x.outcome === 'PASS').length} positive, ${summaries.filter(x => x.outcome === 'REACHED').length} reachability/negative controls.`);
    for (const summary of summaries) console.log(`${summary.id}: ${summary.outcome}; generated=${summary.generated}; distinct=${summary.distinct}; depth=${summary.depth}`);
  }
} catch (error) {
  console.error(`FM006 failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

function loadJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`cannot read ${label}: ${error.message}`); }
}
function containedModelPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) throw new Error(`${label} must be relative.`);
  const path = resolve(modelDir, value), rel = relative(modelDir, path);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the formal model directory.`);
  return path;
}
function requireFile(path, label) { if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not exist: ${path}`); }
function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.modelId !== 'OBTS-FM-006' || manifest.architectureRevision !== 13 || !['candidate', 'accepted'].includes(manifest.architectureStatus)) throw new Error('checks manifest metadata is invalid.');
  const arch = readFileSync(architectureManifestPath, 'utf8');
  if (!/- id: OBTS-FM-006[\s\S]*?\n\s+status:\s*(candidate|accepted)\b[\s\S]*?\n\s+architecture_revision:\s*13\b/u.test(arch)) throw new Error('architecture inventory lacks FM006 revision 13.');
  if (manifest.model !== 'OBTSOnboarding.tla' || !Array.isArray(manifest.sanyModules) || (!testMode && (manifest.sanyModules.length !== 1 || manifest.sanyModules[0] !== 'OBTSOnboarding'))) throw new Error('model/SANY declaration is invalid.');
  const t = manifest.tooling;
  for (const field of ['workers', 'defaultTimeoutMs', 'defaultHeapMb', 'defaultMaximumDistinctStates']) if (!Number.isInteger(t?.[field]) || t[field] <= 0) throw new Error(`tooling.${field} must be positive.`);
  if (t.workers !== 1 || t.fingerprintPolynomial !== 0) throw new Error('FM006 requires one worker and fingerprint polynomial 0.');
  requireFile(containedModelPath(manifest.model, 'model'), 'FM006 model');
  requireFile(containedModelPath(join(t.moduleLibrary, 'OBTSDomain.tla'), 'module library'), 'module library');
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) throw new Error('checks must be non-empty.');
  if (!testMode) {
    if (manifest.checks.length !== requiredChecks.length) throw new Error(`FM006 requires exactly ${requiredChecks.length} checks.`);
    manifest.checks.forEach((check, index) => {
      const [id, kind] = requiredChecks[index];
      if (check.id !== id || check.kind !== kind) throw new Error(`required check matrix drift at ${id}.`);
    });
  }
  for (const check of manifest.checks) {
    if (!['positive-safety', 'positive-liveness', 'reachability', 'negative-control'].includes(check.kind)) throw new Error(`${check.id} has unsupported kind.`);
    requireFile(containedModelPath(check.config, `${check.id} config`), `${check.id} config`);
    for (const field of ['timeoutMs', 'heapMb', 'maximumDistinctStates', 'maximumDepth']) if (!Number.isInteger(check[field]) || check[field] <= 0) throw new Error(`${check.id}.${field} must be positive.`);
    if (check.maximumDistinctStates > 10000) throw new Error(`${check.id} exceeds the FM006 bounded-state budget.`);
    if (['reachability', 'negative-control'].includes(check.kind)) {
      if (!check.expectedInvariant || !check.requiredWitness || !Number.isInteger(check.minimumTraceDepth) || check.minimumTraceDepth < 2 || check.minimumTraceDepth > check.maximumDepth) throw new Error(`${check.id} has invalid witness gates.`);
    } else validateBaseline(check);
  }
}
function validateBaseline(check) {
  for (const field of ['generated', 'distinct', 'depth', 'minGenerated', 'minDistinct', 'minDepth']) if (!Number.isInteger(check.baseline?.[field]) || check.baseline[field] < 1) throw new Error(`${check.id} has invalid baseline.`);
  if (check.baseline.minGenerated > check.baseline.generated || check.baseline.minDistinct > check.baseline.distinct || check.baseline.minDepth > check.baseline.depth) throw new Error(`${check.id} baseline floor exceeds baseline.`);
}
function runSany(manifest) {
  for (const module of manifest.sanyModules) {
    const result = runTool(manifest, 'sany', [module], `sany-${module}`);
    if (result.timedOut || result.status !== 0 || /Parse Error|Semantic errors:|Fatal errors/u.test(result.output)) throw new Error(`SANY ${module} failed: ${result.output.trim()}`);
  }
}
function runCheck(manifest, check) {
  const result = runTool(manifest, 'tlc', ['-cleanup', '-workers', String(manifest.tooling.workers), '-fp', '0', '-config', check.config, '-metadir', join(runRoot, check.id), manifest.model], check.id, check.timeoutMs, check.heapMb);
  const output = result.output;
  if (result.timedOut) throw new Error(`${check.id} timed out.`);
  if (/Parse Error|Parsing error|Semantic errors:|TLC threw an unexpected exception|Error: Evaluating expression|OutOfMemoryError|Too many possible next states|The number of states/u.test(output)) throw new Error(`${check.id} parse/semantic/resource failure: ${output.trim()}`);
  if (output.includes('Deadlock reached')) throw new Error(`${check.id} unexpectedly deadlocked.`);
  const stats = parseStats(output, check.id);
  if (stats.distinct >= check.maximumDistinctStates || stats.depth > check.maximumDepth) throw new Error(`${check.id} exceeded state/depth budget.`);
  if (check.baseline) {
    for (const field of ['generated', 'distinct', 'depth']) {
      const floor = check.baseline[`min${field[0].toUpperCase()}${field.slice(1)}`];
      if (stats[field] < floor) throw new Error(`${check.id} state space collapsed below its ${field} floor.`);
      if (stats[field] > check.baseline[field] * 2) throw new Error(`${check.id} unexplained ${field} growth exceeded twice baseline.`);
    }
  }
  if (check.kind === 'positive-safety' || check.kind === 'positive-liveness') {
    if (result.status !== 0 || !output.includes('Model checking completed. No error has been found.')) throw new Error(`${check.id} positive TLC failure.`);
    return { ...stats, id: check.id, outcome: 'PASS' };
  }
  const invariants = [...output.matchAll(/Invariant ([A-Za-z0-9_]+) is violated\./gu)].map(m => m[1]);
  if (result.status === 0 || invariants.length !== 1 || invariants[0] !== check.expectedInvariant) throw new Error(`${check.id} did not violate exactly ${check.expectedInvariant}.`);
  const actions = [...output.matchAll(/^State ([0-9]+): <([^>]+)>/gmu)].map(m => ({ state: Number(m[1]), action: m[2].split(/\s+line\s+/u)[0] }));
  if (!actions.some(x => x.action.includes(check.requiredWitness))) throw new Error(`${check.id} witness ${check.requiredWitness} missing.`);
  const depth = Math.max(0, ...actions.map(x => x.state));
  if (depth < check.minimumTraceDepth) throw new Error(`${check.id} witness depth ${depth} below ${check.minimumTraceDepth}.`);
  if (!/The behavior up to this point is:|The following behavior constitutes a counter-example:/u.test(output)) throw new Error(`${check.id} emitted no TLC witness.`);
  return { ...stats, id: check.id, outcome: 'REACHED' };
}
function runTool(manifest, tool, args, fixtureId, timeoutMs = manifest.tooling.defaultTimeoutMs, heapMb = manifest.tooling.defaultHeapMb) {
  const fixtureDir = process.env.FM006_FIXTURE_DIR;
  if (fixtureDir) {
    const fixture = loadJson(join(fixtureDir, `${fixtureId}.json`), `fixture ${fixtureId}`);
    return { status: fixture.status, timedOut: fixture.timedOut === true, output: fixture.output ?? '' };
  }
  const jar = process.env.TLA2TOOLS_JAR;
  const executable = jar ? 'java' : tool === 'sany' ? 'tla2sany' : 'tlc';
  const commandArgs = jar ? ['-cp', resolve(jar), tool === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args;
  const library = resolve(modelDir, manifest.tooling.moduleLibrary);
  const result = spawnSync(executable, commandArgs, { cwd: modelDir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, `-Xmx${heapMb}m`, '-XX:+UseParallelGC', `-DTLA-Library=${library}`].filter(Boolean).join(' ') } });
  if (result.error?.code === 'ENOENT') throw new Error(`${executable} unavailable.`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const evidenceDir = process.env.FM006_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `${fixtureId}.log`), output);
  }
  return { status: result.status, timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM', output };
}
function parseStats(output, id) {
  const states = [...output.matchAll(/([0-9,]+) states generated, ([0-9,]+) distinct states found/gu)].at(-1);
  const depths = [...output.matchAll(/[Tt]he depth of the complete state graph search is ([0-9,]+)/gu)].at(-1);
  if (!states || !depths) throw new Error(`${id} produced no TLC state statistics.`);
  return { generated: Number(states[1].replaceAll(',', '')), distinct: Number(states[2].replaceAll(',', '')), depth: Number(depths[1].replaceAll(',', '')) };
}
