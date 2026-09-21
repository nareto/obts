import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = resolve(root, 'architecture/models/formal');
const manifestPath = resolve(modelDir, 'checks-fm005.json');
const architectureManifestPath = resolve(root, 'architecture/manifest.yaml');
const validateOnly = process.argv.includes('--validate-only');
const runRoot = mkdtempSync(resolve(tmpdir(), 'obts-fm005-'));
const requiredChecks = [
  'fm005-revision-safety',
  'fm005-revision-liveness',
  'fm005-missing-safety',
  'fm005-reach-missing-rejection',
  'fm005-stale-safety',
  'fm005-reach-stale-rejection',
  'fm005-drift-safety',
  'fm005-reach-drift-rejection',
  'fm005-negative-missing-bypass',
  'fm005-negative-stale-bypass',
  'fm005-negative-drift-bypass',
  'fm005-export-safety',
  'fm005-export-liveness',
  'fm005-export-cancel-safety',
  'fm005-export-cancel-drain',
  'fm005-reach-export-ready',
  'fm005-reach-export-cancel',
  'fm005-negative-denied-hydration',
  'fm005-negative-entry-before-manifest',
  'fm005-negative-export-lease',
];

try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);
  if (validateOnly) {
    console.log(`FM005 manifest valid: ${manifest.checks.length} required checks.`);
  } else {
    runSany(manifest);
    const summaries = manifest.checks.map((check) => runCheck(manifest, check));
    console.log(`FM005 passed: ${summaries.length} checks; ${summaries.filter((summary) => summary.outcome === 'PASS').length} positive, ${summaries.filter((summary) => summary.outcome === 'REACHED').length} reachability/negative controls.`);
    for (const summary of summaries) {
      console.log(`${summary.id}: ${summary.outcome}; generated=${summary.generated}; distinct=${summary.distinct}; depth=${summary.depth}`);
    }
  }
} catch (error) {
  console.error(`FM005 failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

function contained(path, label) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) {
    throw new Error(`${label} must be a nonempty relative path.`);
  }
  const resolved = resolve(modelDir, path);
  const rel = relative(modelDir, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the formal-model directory.`);
  }
  return resolved;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist: ${path}`);
  }
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.modelId !== 'OBTS-FM-005' || manifest.architectureRevision !== 12 || manifest.architectureStatus !== 'accepted') {
    throw new Error('checks-fm005.json must describe accepted OBTS-FM-005 at architecture revision 12.');
  }
  const architectureManifest = readFileSync(architectureManifestPath, 'utf8');
  if (!/id: OBTS-FM-005[\s\S]*?architecture_revision: 12/u.test(architectureManifest)) {
    throw new Error('architecture/manifest.yaml does not register OBTS-FM-005 at revision 12.');
  }
  requireFile(contained(manifest.model, 'model'), 'FM005 model');
  if (!Array.isArray(manifest.checks) || manifest.checks.length !== requiredChecks.length) {
    throw new Error(`FM005 must contain exactly ${requiredChecks.length} checks.`);
  }
  const ids = manifest.checks.map((check) => check.id);
  if (ids.some((id, index) => id !== requiredChecks[index])) {
    throw new Error('FM005 required check IDs/order changed.');
  }
  const allowedKinds = new Set(['positive-safety', 'positive-liveness', 'reachability', 'negative-control']);
  for (const check of manifest.checks) {
    if (!allowedKinds.has(check.kind)) throw new Error(`${check.id} has an unsupported kind.`);
    requireFile(contained(check.config, `${check.id} config`), `${check.id} config`);
    for (const field of ['timeoutMs', 'heapMb', 'maximumDistinctStates', 'maximumDepth']) {
      if (!Number.isInteger(check[field]) || check[field] <= 0) throw new Error(`${check.id}.${field} must be positive.`);
    }
    if (check.kind.startsWith('positive-')) {
      for (const field of ['generated', 'distinct', 'depth', 'minGenerated', 'minDistinct', 'minDepth']) {
        if (!Number.isInteger(check.baseline?.[field]) || check.baseline[field] <= 0) throw new Error(`${check.id}.baseline.${field} must be positive.`);
      }
    } else if (!check.expectedInvariant || !check.requiredWitness || !Number.isInteger(check.minimumTraceDepth) || check.minimumTraceDepth < 2) {
      throw new Error(`${check.id} lacks exact counterexample gates.`);
    }
  }
}

function runSany(manifest) {
  const result = run('tla2sany', [manifest.model], manifest.tooling.defaultTimeoutMs, manifest.tooling.defaultHeapMb);
  if (result.error || result.status !== 0 || /parse errors|semantic errors/iu.test(result.output)) {
    throw new Error(`SANY failed:\n${result.output}`);
  }
}

function runCheck(manifest, check) {
  const result = run(
    'tlc',
    ['-cleanup', '-workers', String(manifest.tooling.workers), '-fp', String(manifest.tooling.fingerprintPolynomial), '-config', check.config, '-metadir', resolve(runRoot, check.id), manifest.model.replace(/\.tla$/u, '')],
    check.timeoutMs,
    check.heapMb,
  );
  if (result.error) throw new Error(`${check.id} could not execute: ${result.error.message}`);
  const metrics = parseMetrics(check.id, result.output);
  if (metrics.distinct > check.maximumDistinctStates || metrics.depth > check.maximumDepth) {
    throw new Error(`${check.id} exceeded its state/depth budget.`);
  }
  if (check.kind.startsWith('positive-')) {
    if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) {
      throw new Error(`${check.id} failed unexpectedly:\n${result.output}`);
    }
    const baseline = check.baseline;
    if (metrics.generated < baseline.minGenerated || metrics.distinct < baseline.minDistinct || metrics.depth < baseline.minDepth) {
      throw new Error(`${check.id} collapsed below its baseline floor.`);
    }
    if (metrics.generated > baseline.generated * 2 || metrics.distinct > baseline.distinct * 2 || metrics.depth > baseline.depth * 2) {
      throw new Error(`${check.id} grew beyond twice its recorded baseline.`);
    }
    return { id: check.id, outcome: 'PASS', ...metrics };
  }
  if (result.status === 0 || !result.output.includes(`Invariant ${check.expectedInvariant} is violated.`)) {
    throw new Error(`${check.id} did not violate ${check.expectedInvariant} as required:\n${result.output}`);
  }
  if (!result.output.includes(`lastAction = "${check.requiredWitness}"`) || metrics.depth < check.minimumTraceDepth) {
    throw new Error(`${check.id} lacks witness ${check.requiredWitness} at depth ${check.minimumTraceDepth}.`);
  }
  return { id: check.id, outcome: 'REACHED', ...metrics };
}

function run(command, args, timeoutMs, heapMb) {
  const result = spawnSync(command, args, {
    cwd: modelDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: `-Xmx${heapMb}m` },
  });
  return { status: result.status, error: result.error, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function parseMetrics(id, output) {
  const states = [...output.matchAll(/([0-9,]+) states generated, ([0-9,]+) distinct states found/gu)].at(-1);
  const depth = [...output.matchAll(/depth of the complete state graph search is ([0-9,]+)/gu)].at(-1);
  if (!states || !depth) throw new Error(`${id} did not report complete TLC metrics.`);
  return {
    generated: Number(states[1].replaceAll(',', '')),
    distinct: Number(states[2].replaceAll(',', '')),
    depth: Number(depth[1].replaceAll(',', '')),
  };
}
