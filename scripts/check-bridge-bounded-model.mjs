import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = join(root, 'architecture', 'models', 'formal');
const workerCompanion = process.argv.includes('--worker-companion');
const manifestPath = join(modelDir, workerCompanion ? 'checks-fm003-workers.json' : 'checks-fm003.json');
const modelName = workerCompanion ? 'OBTSBridgeEmbeddingWorker.tla' : 'OBTSBridgeBoundedBody.tla';
const architectureManifestPath = join(root, 'architecture', 'manifest.yaml');
const validateOnly = process.argv.includes('--validate-only');
const runRoot = mkdtempSync(join(tmpdir(), 'obts-fm003-'));
const projectionRequiredChecks = [
  'fm003-bounded-body-safety', 'fm003-bounded-body-liveness', 'fm003-source-failure-safety',
  'fm003-source-failure-drain', 'fm003-caller-denial-safety', 'fm003-reach-two-body-slots',
  'fm003-reach-large-corpus', 'fm003-reach-revision-drift', 'fm003-reach-denied-body',
  'fm003-reach-release', 'fm003-reach-failure', 'fm003-reach-failure-release',
  'fm003-reach-source-failure', 'fm003-reach-source-failure-release', 'fm003-reach-caller-denied',
  'fm003-reach-db-failure', 'fm003-negative-all-corpus-retention', 'fm003-negative-cursor-early',
  'fm003-negative-unverified-rows', 'fm003-negative-skip-release', 'fm003-negative-total-admission',
  'fm003-negative-drop-audit',
  'fm003-cancel-safety', 'fm003-cancel-drain', 'fm003-restart-safety', 'fm003-restart-liveness',
  'fm003-reach-singleton', 'fm003-reach-singleton-cleanup', 'fm003-reach-partial-restart',
  'fm003-reach-replay-ready', 'fm003-reach-cancel-singleton', 'fm003-reach-multirow-file',
  'fm003-reach-final-cursor', 'fm003-negative-row-overflow', 'fm003-negative-oversized-starvation',
  'fm003-negative-mixed-oversized', 'fm003-negative-omitted-row', 'fm003-negative-early-permit-release',
  'fm003-reach-normal-byte-pressure'
];

const workerRequirements = [
  {"id": "fm003-worker-note-safety","kind": "positive-safety"},
  {"id": "fm003-worker-note-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-block-hash-safety","kind": "positive-safety"},
  {"id": "fm003-worker-block-hash-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-block-epoch-safety","kind": "positive-safety"},
  {"id": "fm003-worker-block-epoch-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-failure-safety","kind": "positive-safety"},
  {"id": "fm003-worker-failure-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-cancel-safety","kind": "positive-safety"},
  {"id": "fm003-worker-cancel-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-reindex-safety","kind": "positive-safety"},
  {"id": "fm003-worker-reindex-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-reach-stale-note-success","kind": "reachability","requiredWitness": "CompleteSQL","expectedInvariant": "NeverStaleSuccess"},
  {"id": "fm003-worker-reach-stale-block-success","kind": "reachability","requiredWitness": "CompleteSQL","expectedInvariant": "NeverStaleSuccess"},
  {"id": "fm003-worker-reach-stale-note-failure","kind": "reachability","requiredWitness": "CompleteSQL","expectedInvariant": "NeverStaleFailure"},
  {"id": "fm003-worker-reach-stale-block-failure","kind": "reachability","requiredWitness": "CompleteSQL","expectedInvariant": "NeverStaleFailure"},
  {"id": "fm003-worker-reach-old-source-result","kind": "reachability","requiredWitness": "CompleteSQL","expectedInvariant": "NeverOldSourceResult"},
  {"id": "fm003-worker-reach-late-cancelled-result","kind": "reachability","requiredWitness": "LateReply","expectedInvariant": "NeverLateIgnored"},
  {"id": "fm003-worker-reach-new-generation-retry","kind": "reachability","requiredWitness": "CompleteSQL","expectedInvariant": "NeverNewReady"},
  {"id": "fm003-worker-reach-api-wait","kind": "reachability","requiredWitness": "ApiHeadless","expectedInvariant": "NeverApiWait"},
  {"id": "fm003-worker-reach-attestation-reject","kind": "reachability","requiredWitness": "RejectAttestation","expectedInvariant": "NeverRejected"},
  {"id": "fm003-worker-negative-empty-inner","kind": "negative-liveness","requiredWitness": "LegacyEmptySnapshot","expectedProperty": "EventuallyReady"},
  {"id": "fm003-worker-negative-id-success","kind": "negative-control","requiredWitness": "CompleteSQL","expectedInvariant": "GenerationSafe"},
  {"id": "fm003-worker-negative-id-failure","kind": "negative-control","requiredWitness": "CompleteSQL","expectedInvariant": "GenerationSafe"},
  {"id": "fm003-worker-negative-ignored-hash","kind": "negative-control","requiredWitness": "CompleteSQL","expectedInvariant": "GenerationSafe"},
  {"id": "fm003-worker-negative-ignored-epoch","kind": "negative-control","requiredWitness": "CompleteSQL","expectedInvariant": "GenerationSafe"},
  {"id": "fm003-worker-negative-reindex-id","kind": "negative-control","requiredWitness": "CompleteSQL","expectedInvariant": "GenerationSafe"},
  {"id": "fm003-worker-negative-cancelled-result","kind": "negative-control","requiredWitness": "LateReply","expectedInvariant": "CancelledSafe"},
  {"id": "fm003-worker-negative-inverse-acquire","kind": "negative-deadlock","requiredWitness": "ApiHeadless","requiredState": ["body |-> \"worker\"","headless |-> \"api\"","api |-> \"WaitBody\"","w |-> \"WantHeadless\""]},
  {"id": "fm003-worker-negative-completion-lock","kind": "negative-deadlock","requiredWitness": "ApiHeadless","requiredState": ["body |-> \"worker\"","headless |-> \"api\"","api |-> \"WaitBody\"","w |-> \"Complete\""]},
  {"id": "fm003-worker-schema-note-safety","kind": "positive-safety"},
  {"id": "fm003-worker-schema-note-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-schema-block-safety","kind": "positive-safety"},
  {"id": "fm003-worker-schema-block-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-schema-reindex-safety","kind": "positive-safety"},
  {"id": "fm003-worker-schema-reindex-liveness","kind": "positive-liveness"},
  {"id": "fm003-worker-reach-schema-note-success","kind": "reachability","expectedInvariant": "NeverStaleSuccess","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-reach-schema-note-failure","kind": "reachability","expectedInvariant": "NeverStaleFailure","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-reach-schema-block-success","kind": "reachability","expectedInvariant": "NeverStaleSuccess","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-reach-schema-block-failure","kind": "reachability","expectedInvariant": "NeverStaleFailure","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-reach-schema-retry","kind": "reachability","expectedInvariant": "NeverSchemaReady","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-reach-schema-pending-sql","kind": "reachability","expectedInvariant": "NeverResetPendingSQL","requiredWitness": "SchemaReset"},
  {"id": "fm003-worker-reach-inverse-headless","kind": "reachability","expectedInvariant": "NeverInverseHeadless","requiredWitness": "InverseHeadless"},
  {"id": "fm003-worker-negative-schema-note-success","kind": "negative-control","expectedInvariant": "GenerationSafe","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-negative-schema-note-failure","kind": "negative-control","expectedInvariant": "GenerationSafe","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-negative-schema-block-success","kind": "negative-control","expectedInvariant": "GenerationSafe","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-negative-schema-block-failure","kind": "negative-control","expectedInvariant": "GenerationSafe","requiredWitness": "CompleteSQL"},
  {"id": "fm003-worker-negative-schema-reindex","kind": "negative-control","expectedInvariant": "GenerationSafe","requiredWitness": "CompleteSQL"},

];
const requiredChecks = workerCompanion ? workerRequirements.map((check) => check.id) : projectionRequiredChecks;

try {
  const manifest = loadJson(manifestPath, 'FM003 checks manifest');
  validateManifest(manifest);
  if (validateOnly) {
    console.log(`${workerCompanion ? 'FM003 worker companion' : 'FM003'} manifest valid: ${manifest.checks.length} required checks; trace ranges valid.`);
  } else {
    runSany(manifest);
    const summaries = manifest.checks.map((check) => runCheck(manifest, check));
    console.log(`${workerCompanion ? 'FM003 worker companion' : 'FM003'} passed: ${summaries.length} checks; ${summaries.filter((summary) => summary.outcome === 'PASS').length} positive, ${summaries.filter((summary) => summary.outcome === 'REACHED').length} reachability/negative controls.`);
    for (const summary of summaries) console.log(`${summary.id}: ${summary.outcome}; generated=${summary.generated}; distinct=${summary.distinct}; depth=${summary.depth}`);
  }
} catch (error) {
  console.error(`FM003 failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
}

function containedModelPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) throw new Error(`${label} must be relative.`);
  const path = resolve(modelDir, value);
  const rel = relative(modelDir, path);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the formal model directory.`);
  return path;
}

function containedRootPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) throw new Error(`${label} must be repository-relative.`);
  const path = resolve(root, value);
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${label} escapes the repository.`);
  return path;
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not exist: ${path}`);
}

function validateManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.modelId !== 'OBTS-FM-003' || manifest.architectureRevision !== 6 || manifest.architectureStatus !== 'accepted') {
    throw new Error('checks-fm003.json must describe accepted OBTS-FM-003 at architecture revision 6.');
  }
  const architectureManifest = readFileSync(architectureManifestPath, 'utf8');
  if (!/id: OBTS-FM-003[\s\S]*?architecture_revision: 6/u.test(architectureManifest)) {
    throw new Error('architecture/manifest.yaml does not register OBTS-FM-003 at revision 6.');
  }
  const tooling = manifest.tooling;
  for (const field of ['workers', 'defaultTimeoutMs', 'defaultHeapMb', 'defaultMaximumDistinctStates']) {
    if (!Number.isInteger(tooling?.[field]) || tooling[field] <= 0) throw new Error(`tooling.${field} must be a positive integer.`);
  }
  if (!Number.isInteger(tooling.fingerprintPolynomial) || tooling.fingerprintPolynomial < 0) throw new Error('tooling.fingerprintPolynomial must be non-negative.');
  if (manifest.model !== modelName || (workerCompanion && manifest.companion !== 'embedding-worker')) throw new Error('FM003 model/companion mismatch.');
  if (workerCompanion && !architectureManifest.includes('companion_path: architecture/models/formal/OBTSBridgeEmbeddingWorker.tla')) throw new Error('FM003 worker companion is not registered.');
  const model = containedModelPath(manifest.model, 'model');
  requireFile(model, 'FM003 model');
  requireFile(containedRootPath(`architecture/models/formal/${tooling.moduleLibrary}/OBTSDomain.tla`, 'tooling.moduleLibrary/OBTSDomain.tla'), 'FM003 module library');
  const traceMapPath = containedRootPath(join('architecture/models/formal', tooling.traceMap), 'tooling.traceMap');
  validateTraceMap(traceMapPath, model);
  if (workerCompanion) validateWorkerCounterexamples(manifest, model);
  if (!Array.isArray(manifest.checks) || manifest.checks.length !== requiredChecks.length) throw new Error(`FM003 must contain exactly ${requiredChecks.length} checks.`);
  const ids = manifest.checks.map((check) => check.id);
  if (ids.some((id, index) => id !== requiredChecks[index])) throw new Error('FM003 required check IDs/order changed.');
  const allowedKinds = new Set(['positive-safety', 'positive-liveness', 'reachability', 'negative-control', 'negative-liveness', ...(workerCompanion ? ['negative-deadlock'] : [])]);
  for (const check of manifest.checks) {
    if (workerCompanion) {
      const required = workerRequirements.find((entry) => entry.id === check.id);
      for (const [field, value] of Object.entries(required)) {
        if (JSON.stringify(check[field]) !== JSON.stringify(value)) throw new Error(`${check.id} required ${field} changed.`);
      }
    }
    if (!allowedKinds.has(check.kind)) throw new Error(`${check.id} has an unsupported kind.`);
    requireFile(containedModelPath(check.config, `${check.id} config`), `${check.id} config`);
    for (const field of ['timeoutMs', 'heapMb', 'maximumDistinctStates', 'maximumDepth']) {
      if (!Number.isInteger(check[field]) || check[field] <= 0) throw new Error(`${check.id}.${field} must be positive.`);
    }
    if (check.maximumDistinctStates >= 1000000) throw new Error(`${check.id} has an unreasonable distinct-state budget.`);
    if (['reachability', 'negative-control', 'negative-liveness', 'negative-deadlock'].includes(check.kind)) {
      if (!(check.kind === 'negative-deadlock' ? check.requiredState?.length : check.kind === 'negative-liveness' ? check.expectedProperty : check.expectedInvariant) || !check.requiredWitness || !Number.isInteger(check.minimumTraceDepth)) throw new Error(`${check.id} lacks counterexample gates.`);
      if (check.minimumTraceDepth < 2 || check.minimumTraceDepth > check.maximumDepth) throw new Error(`${check.id} has invalid trace-depth gates.`);
    }
    if (['positive-safety', 'positive-liveness'].includes(check.kind) && !check.baseline) throw new Error(`${check.id} must declare a state-space baseline.`);
    if (check.baseline) validateBaseline(check);
  }
  if (workerCompanion) validateWorkerActionCoverage(manifest, model);
}

function validateBaseline(check) {
  for (const field of ['generated', 'distinct', 'depth', 'minGenerated', 'minDistinct', 'minDepth']) {
    if (!Number.isInteger(check.baseline[field]) || check.baseline[field] < 1) throw new Error(`${check.id} has invalid baseline.${field}.`);
  }
  if (check.baseline.minGenerated > check.baseline.generated || check.baseline.minDistinct > check.baseline.distinct || check.baseline.minDepth > check.baseline.depth) throw new Error(`${check.id} baseline floor exceeds baseline.`);
}

function validateTraceMap(path, model) {
  const map = loadJson(path, 'FM003 trace map');
  if (map.schemaVersion !== 1 || map.modelId !== 'OBTS-FM-003' || map.architectureRevision !== 6 || !['forthcoming-stage2', 'partial-stage2-request-projection', 'checked-worker'].includes(map.implementationEvidenceStatus)) throw new Error('FM003 trace map metadata is invalid.');
  if (map.model !== `architecture/models/formal/${modelName}` || map.checks !== `architecture/models/formal/${workerCompanion ? 'checks-fm003-workers.json' : 'checks-fm003.json'}`) throw new Error('FM003 trace map does not identify its model/checks.');
  if (!workerCompanion && map.implementationEvidenceStatus === 'checked-worker') throw new Error('Worker implementation status belongs to the worker companion only.');
  const contractText = readFileSync(join(root, 'architecture/contracts/persistence.md'), 'utf8');
  const knownContracts = new Set(contractText.match(/OBTS-[A-Z]+(?:-[A-Z]+)*-[0-9]{3}/gu) ?? []);
  if (workerCompanion) {
    if (!['forthcoming-stage2', 'checked-worker'].includes(map.implementationEvidenceStatus)) throw new Error('Worker evidence requires a worker-specific implementation status.');
    if (map.implementationEvidenceStatus === 'checked-worker') {
      if (map.localAcceptance?.independentReview !== 'passed' || !Array.isArray(map.localAcceptance.stackReports) || map.localAcceptance.stackReports.length !== 2) throw new Error('Checked worker evidence lacks its local acceptance receipt.');
      const reports = map.localAcceptance.stackReports.map(path => loadJson(containedRootPath(path, 'worker stack report'), 'worker stack report'));
      for (const mode of ['disabled', 'local']) {
        const report = reports.find(value => value.embeddingMode === mode);
        if (report?.passed !== true || report.syntheticResourcesRemoved !== true || !Array.isArray(report.checks) || report.checks.length < (mode === 'local' ? 34 : 30) || !/^[a-f0-9]{64}$/.test(report.bridgeBinarySha256 ?? '')) throw new Error(`Checked worker evidence lacks a passing ${mode} stack report.`);
      }
      if (reports[0].bridgeBinarySha256 !== reports[1].bridgeBinarySha256) throw new Error('Worker stack reports identify different binaries.');
    }
    const text = readFileSync(model, 'utf8');
    const actions = [...text.matchAll(/^([A-Za-z]+) ==\n  \/\\ /gmu)].map((match) => match[1]);
    if (actions.length < 20 || actions.some((action) => !map.actions?.[action])) throw new Error('Worker trace map omits a transition.');
    if (Object.keys(map.actions ?? {}).some((action) => !actions.includes(action))) throw new Error('Worker trace map has an unknown transition.');
  }
  for (const context of map.currentImplementationContext ?? []) validateRootSourceReference(`${context.path}:${context.range}`, 'current implementation context');
  for (const [action, entry] of Object.entries(map.actions ?? {})) {
    const match = entry.model?.match(/^([^:]+):([0-9]+)-([0-9]+)$/u);
    if (!match || resolve(root, match[1]) !== model) throw new Error(`FM003 trace action ${action} has an invalid model range.`);
    validateLineRange(model, Number(match[2]), Number(match[3]), `FM003 trace action ${action}`);
    if (workerCompanion && !readFileSync(model, 'utf8').split('\n')[Number(match[2]) - 1].startsWith(`${action} ==`)) throw new Error(`Worker trace action ${action} range starts at the wrong action.`);
    if (workerCompanion && (!Array.isArray(entry.checks) || entry.checks.length === 0 || entry.checks.some((id) => !requiredChecks.includes(id)))) throw new Error(`Worker trace action ${action} lacks valid check evidence.`);
    if (!Array.isArray(entry.contracts) || entry.contracts.length === 0 || entry.contracts.some((id) => !knownContracts.has(id))) throw new Error(`FM003 trace action ${action} has an unknown/empty contract mapping.`);
    if (!['forthcoming-stage2', 'checked-request-projection-lane', 'checked-worker', 'negative-control-only'].includes(entry.codeStatus)) throw new Error(`FM003 trace action ${action} has an invalid code status.`);
    if (entry.codeStatus === 'checked-worker' && (!workerCompanion || map.implementationEvidenceStatus !== 'checked-worker')) throw new Error(`Checked worker action ${action} lacks its acceptance gate.`);
  }
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateWorkerActionCoverage(manifest, model) {
  const evidence = loadJson(containedModelPath(manifest.tooling.actionCoverage, 'worker action coverage'), 'worker action coverage');
  if (evidence.schemaVersion !== 1 || evidence.modelId !== 'OBTS-FM-003' || evidence.architectureRevision !== 6 || evidence.modelSha256 !== fileSha256(model)) throw new Error('Worker action coverage metadata/model digest is stale.');
  if (Object.keys(evidence.checks ?? {}).length !== manifest.checks.length) throw new Error('Worker action coverage matrix is incomplete.');
  for (const check of manifest.checks) {
    const row = evidence.checks[check.id];
    if (!row || row.configSha256 !== fileSha256(containedModelPath(check.config, check.id))) throw new Error(`${check.id} action coverage config digest is stale.`);
    validateWorkerCoverageCounts(manifest, check, row.generatedActions);
  }
}

function validateWorkerCoverageCounts(manifest, check, counts) {
  const map = loadJson(containedModelPath(manifest.tooling.traceMap, 'worker trace map'), 'worker trace map');
  for (const [action, entry] of Object.entries(map.actions)) {
    if (entry.checks.includes(check.id) && (!Number.isInteger(counts?.[action]) || counts[action] <= 0)) throw new Error(`Worker trace action ${action} is not exercised by ${check.id}.`);
  }
}

function parseWorkerCoverage(output) {
  return Object.fromEntries([...output.matchAll(/^<([A-Za-z]+) line [^\n>]+>: ([0-9,]+):([0-9,]+)$/gmu)].map((match) => [match[1], Number(match[3].replaceAll(',', ''))]));
}

function validateWorkerCounterexamples(manifest, model) {
  const evidence = loadJson(containedModelPath(manifest.tooling.counterexamples, 'worker counterexamples'), 'worker counterexamples');
  if (evidence.schemaVersion !== 1 || evidence.modelId !== 'OBTS-FM-003' || evidence.companion !== 'embedding-worker' || evidence.architectureRevision !== 6) throw new Error('Worker counterexample metadata is invalid.');
  const controls = workerRequirements.filter((check) => check.kind.startsWith('negative'));
  if (!Array.isArray(evidence.traces) || evidence.traces.length !== controls.length) throw new Error('Worker counterexample evidence is incomplete.');
  const modelText = readFileSync(model, 'utf8');
  for (const [index, required] of controls.entries()) {
    const trace = evidence.traces[index];
    const check = manifest.checks.find((entry) => entry.id === required.id);
    if (trace.check !== required.id || trace.expected !== (required.expectedInvariant ?? required.expectedProperty ?? 'Deadlock reached')) throw new Error('Worker counterexample identity/outcome changed.');
    if (!Array.isArray(trace.states) || trace.states.length < check.minimumTraceDepth || !trace.states.some((state) => state.action === required.requiredWitness)) throw new Error('Worker counterexample lacks its required witness/depth.');
    for (const [stateIndex, state] of trace.states.entries()) {
      if (state.state !== stateIndex + 1 || (state.action !== 'Initial predicate' && !modelText.includes(`\n${state.action} ==`))) throw new Error('Worker counterexample has invalid state/action sequence.');
    }
    if (required.kind === 'negative-deadlock') {
      const final = trace.states.at(-1).values;
      if (required.requiredState.some((value) => {
        const [field, expected] = value.split(' |-> ');
        return final[field] !== JSON.parse(expected);
      })) throw new Error('Worker counterexample lacks the final lock cycle.');
    }
  }
}

function validateRootSourceReference(reference, label) {
  const match = reference.match(/^([^:]+):([0-9]+)-([0-9]+)$/u);
  if (!match) throw new Error(`${label} has invalid source range ${reference}.`);
  const path = containedRootPath(match[1], label);
  requireFile(path, label);
  validateLineRange(path, Number(match[2]), Number(match[3]), label);
}

function validateLineRange(path, start, end, label) {
  const content = readFileSync(path, 'utf8');
  const lines = content.length === 0 ? 0 : content.split('\n').length - Number(content.endsWith('\n'));
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines) throw new Error(`${label} has invalid source range ${start}-${end}; file has ${lines} lines.`);
}

function runSany(manifest) {
  const result = runTool(manifest, 'sany', [manifest.model], 'fm003-sany');
  const output = result.output;
  if (result.timedOut || result.status !== 0 || /Parse Error|Semantic errors:|Fatal errors/u.test(output)) throw new Error(`SANY failed: ${result.errorMessage ?? output.trim()}`);
}

function runCheck(manifest, check) {
  const result = runTool(manifest, 'tlc', [
    '-cleanup', '-workers', String(manifest.tooling.workers), '-fp', String(manifest.tooling.fingerprintPolynomial),
    ...(workerCompanion ? ['-coverage', '1'] : []),
    '-config', check.config, '-metadir', join(runRoot, check.id), manifest.model
  ], check.id, check.timeoutMs, check.heapMb);
  const output = result.output;
  if (result.timedOut) throw new Error(`${check.id} timed out after ${check.timeoutMs}ms.`);
  if (/Parse Error|Semantic errors:|TLC threw an unexpected exception|Error: Evaluating expression|OutOfMemoryError/u.test(output)) throw new Error(`${check.id} failed to parse/evaluate or deadlocked: ${output.trim()}`);
  if (output.includes('Deadlock reached') && check.kind !== 'negative-deadlock') throw new Error(`${check.id} unexpectedly deadlocked.`);
  const stats = parseStats(output, check.id, check.kind === 'negative-liveness');
  if (workerCompanion) validateWorkerCoverageCounts(manifest, check, parseWorkerCoverage(output));
  if (stats.distinct >= check.maximumDistinctStates) throw new Error(`${check.id} reached distinct-state budget ${check.maximumDistinctStates}.`);
  if (stats.depth > check.maximumDepth) throw new Error(`${check.id} exceeded depth budget ${check.maximumDepth}.`);
  if (check.baseline) {
    if (stats.generated < check.baseline.minGenerated || stats.distinct < check.baseline.minDistinct || stats.depth < check.baseline.minDepth) throw new Error(`${check.id} state-space collapsed below its declared floor.`);
    for (const field of ['generated', 'distinct', 'depth']) if (stats[field] > check.baseline[field] * 2) throw new Error(`${check.id} unexplained ${field} growth exceeded twice baseline.`);
  }
  if (check.kind === 'positive-safety' || check.kind === 'positive-liveness') {
    if (result.status !== 0 || !output.includes('Model checking completed. No error has been found.')) throw new Error(`${check.id} positive TLC check failed: ${output.trim()}`);
    return { ...stats, id: check.id, outcome: 'PASS' };
  }
  const invariants = [...output.matchAll(/Invariant ([A-Za-z0-9_]+) is violated\./gu)].map((match) => match[1]);
  if (check.kind === 'negative-deadlock') {
    const lastState = output.split(/^State [0-9]+: /mu).at(-1);
    if (result.status === 0 || invariants.length !== 0 || !output.includes('Deadlock reached') || check.requiredState.some((value) => !lastState.includes(value))) throw new Error(`${check.id} did not reach its exact lock-cycle deadlock.`);
  } else if (check.kind === 'negative-liveness') {
    const config = readFileSync(containedModelPath(check.config, check.id), 'utf8');
    const properties = [...config.matchAll(/^PROPERTY ([A-Za-z0-9_]+)$/gmu)].map((match) => match[1]);
    if (result.status === 0 || invariants.length !== 0 || !output.includes('Temporal properties were violated.') || properties.length !== 1 || properties[0] !== check.expectedProperty) throw new Error(`${check.id} did not violate exactly its configured property ${check.expectedProperty}.`);
  } else if (result.status === 0 || invariants.length !== 1 || invariants[0] !== check.expectedInvariant) throw new Error(`${check.id} did not produce exactly invariant ${check.expectedInvariant}.`);
  const actions = [...output.matchAll(/^State ([0-9]+): <([^>]+)>/gmu)].map((match) => ({ state: Number(match[1]), action: match[2].split(/\s+line\s+/u)[0] }));
  if (!actions.some(({ action }) => action.includes(check.requiredWitness))) throw new Error(`${check.id} counterexample lacks witness ${check.requiredWitness}.`);
  const traceDepth = Math.max(0, ...actions.map(({ state }) => state));
  if (traceDepth < check.minimumTraceDepth) throw new Error(`${check.id} witness depth ${traceDepth} is below ${check.minimumTraceDepth}.`);
  if (!/The behavior up to this point is:|The following behavior constitutes a counter-example:/u.test(output)) throw new Error(`${check.id} did not emit a state-machine witness.`);
  return { ...stats, id: check.id, outcome: 'REACHED' };
}

function runTool(manifest, tool, args, fixtureId, timeoutMs = manifest.tooling.defaultTimeoutMs, heapMb = manifest.tooling.defaultHeapMb) {
  const jar = process.env.TLA2TOOLS_JAR;
  const executable = jar ? 'java' : tool === 'sany' ? 'tla2sany' : 'tlc';
  const commandArgs = jar ? ['-cp', resolve(jar), tool === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args;
  const library = resolve(modelDir, manifest.tooling.moduleLibrary);
  const javaOptions = [process.env.JAVA_TOOL_OPTIONS, `-Xmx${heapMb}m`, '-XX:+UseParallelGC', `-DTLA-Library=${library}`].filter(Boolean).join(' ');
  const result = spawnSync(executable, commandArgs, {
    cwd: modelDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: javaOptions }
  });
  if (result.error?.code === 'ENOENT') throw new Error(`${executable} is unavailable. Install TLA+ tools or set TLA2TOOLS_JAR.`);
  return {
    status: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM',
    errorMessage: result.error?.message,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

function parseStats(output, id, temporalCounterexample = false) {
  const stateMatches = [...output.matchAll(/([0-9,]+) states generated, ([0-9,]+) distinct states found/gu)];
  const depthMatches = [...output.matchAll(/[Tt]he depth of the complete state graph search is ([0-9,]+)/gu)];
  const state = stateMatches.at(-1);
  const depth = depthMatches.at(-1) ?? (temporalCounterexample && /0 states left on queue/u.test(output) ? [...output.matchAll(/Progress\(([0-9,]+)\)/gu)].at(-1) : undefined);
  if (!state || !depth) throw new Error(`${id} produced no TLC state statistics.`);
  return { generated: Number(state[1].replaceAll(',', '')), distinct: Number(state[2].replaceAll(',', '')), depth: Number(depth[1].replaceAll(',', '')) };
}
