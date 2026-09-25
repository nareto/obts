import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = join(root, 'architecture', 'models', 'formal');
const validateOnly = process.argv.includes('--validate-only');
const updateEvidence = process.argv.includes('--update-evidence');
const testMode = process.env.FORMAL_TEST_MODE === '1';
const manifestPath = resolve(process.env.FORMAL_CHECKS_MANIFEST ?? join(modelDir, 'checks.json'));
const runRoot = mkdtempSync(join(tmpdir(), 'obts-tlc-'));

const requiredChecks = new Map([
  ['fm001-safety', 'positive-safety'], ['fm001-liveness', 'positive-liveness'],
  ['fm001-negative-skip-recovery', 'negative-control'], ['fm001-negative-stale-preflight', 'negative-control'],
  ['fm001-negative-early-cleanup', 'negative-control'], ['fm001-negative-infer-completion', 'negative-control'],
  ...['same-path', 'disjoint-directory', 'server-recovery-contract', 'bridge-handoff', 'all-actors', 'apply-refinement']
    .map((id) => [`fm002-${id}`, 'positive-safety']),
  ...['proposal', 'bridge', 'server-recovery', 'apply-ack'].map((id) => [`fm002-liveness-${id}`, 'positive-liveness']),
  ...['observe', 'bridge-proposal', 'plugin2-proposal', 'rust-write', 'network-fault', 'recovery', 'conflict', 'apply-ack',
    'equal', 'covered', 'divergent', 'reply-loss', 'conflict-partial', 'directory-delete', 'projection', 'proposal-trigger',
    'bridge-trigger', 'recovery-trigger', 'apply-trigger', 'apply-refinement', 'ack-reconstruction'].map((id) => [`fm002-reach-${id}`, 'reachability']),
  ['fm002-server-recovery-implementation', 'positive-safety'],
  ...['root-ignore-safety', 'root-ignore-legacy-safety', 'root-ignore-bridge-race-safety', 'root-ignore-invalid-safety'].map((id) => [`fm002-${id}`, 'positive-safety']),
  ...['root-ignore-transition', 'root-ignore-stale', 'root-ignore-local-only', 'root-ignore-projection', 'root-ignore-legacy-activation', 'root-ignore-rebuild-stale', 'root-ignore-bridge-race-reach',
    'root-ignore-offline-capture', 'root-ignore-invalid-reach', 'root-ignore-bridge-race-write-reach']
    .map((id) => [`fm002-${id}`, 'reachability']),
  ...['root-ignore-negative-discard', 'root-ignore-negative-old-client', 'root-ignore-negative-stale',
    'root-ignore-negative-policy-identity', 'root-ignore-negative-bridge-write', 'root-ignore-negative-projection-rows',
    'root-ignore-negative-legacy-activation', 'root-ignore-negative-candidate', 'root-ignore-bridge-race-negative'].map((id) => [`fm002-${id}`, 'negative-control']),
  ...['replace-inflight', 'drop-accepted', 'ref-rewind', 'discard-divergence', 'main-before-effects', 'early-ack',
    'overwrite-bridge', 'recursive-delete', 'restart-abort', 'duplicate-processing', 'retry-identity',
    'conflict-without-protection', 'cas-uncertain-abort', 'cursor-ack-conflation', 'projection-cursor-early', 'ack-evidence-loss']
    .map((id) => [`fm002-negative-${id}`, 'negative-control'])
]);

try {
  if (!testMode) assertContained(manifestPath, modelDir, 'formal checks manifest');
  const manifest = loadJson(manifestPath, 'formal checks manifest');
  const transitionMapPath = testMode && process.env.FORMAL_TRANSITION_MAP
    ? resolve(process.env.FORMAL_TRANSITION_MAP)
    : containedModelPath(process.env.FORMAL_TRANSITION_MAP ?? manifest.tooling?.transitionMap, 'transition map');
  validateManifest(manifest, transitionMapPath);
  if (validateOnly) {
    console.log(`Formal manifest valid: ${manifest.checks.length} required checks; transition map and source ranges valid.`);
  } else {
    runSany(manifest);
    const summaries = manifest.checks.map((check) => runCheck(manifest, check));
    validateArchitectureStatus(manifest, summaries);
    printSummary(manifest, summaries);
  }
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} ${path}: ${error.message}`);
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertContained(path, parent, label) {
  const rel = relative(parent, path);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return path;
  throw new Error(`${label} escapes its allowed directory: ${path}`);
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) throw new Error(`${label} must be a relative path.`);
  const path = resolve(modelDir, value);
  return assertContained(path, modelDir, label);
}

function containedModelPath(value, label) {
  return safeRelative(value, label);
}

function safeRootRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) throw new Error(`${label} must be a repository-relative path.`);
  const path = resolve(root, value);
  return assertContained(path, root, label);
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not exist: ${path}`);
}

function validateManifest(manifest, transitionMapPath) {
  if (manifest.schemaVersion !== 2 || manifest.modelId !== 'OBTS-FM-002') throw new Error('checks.json must use schemaVersion 2 for OBTS-FM-002.');
  if (!manifest.tooling || !Array.isArray(manifest.sanyModules) || !Array.isArray(manifest.checks)) {
    throw new Error('checks.json must define tooling, sanyModules, and checks.');
  }
  for (const field of ['moduleLibrary', 'transitionMap']) safeRelative(manifest.tooling[field], `tooling.${field}`);
  safeRootRelative(manifest.tooling.architectureManifest, 'tooling.architectureManifest');
  requireFile(safeRelative(manifest.tooling.moduleLibrary + '/OBTSDomain.tla', 'module library'), 'module library');

  const ids = new Set();
  const allowedKinds = new Set(['positive-safety', 'positive-liveness', 'negative-control', 'candidate-counterexample', 'reachability']);
  for (const check of manifest.checks) {
    if (typeof check.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(check.id) || ids.has(check.id)) {
      throw new Error(`Duplicate or unsafe check id: ${String(check.id)}`);
    }
    ids.add(check.id);
    if (!allowedKinds.has(check.kind)) throw new Error(`${check.id} has unknown kind ${String(check.kind)}.`);
    const modelPath = safeRelative(`${check.model}.tla`, `${check.id} model`);
    const configPath = safeRelative(check.config, `${check.id} config`);
    requireFile(modelPath, `${check.id} model`);
    requireFile(configPath, `${check.id} config`);
    for (const [field, fallback] of [['timeoutMs', manifest.tooling.defaultTimeoutMs], ['heapMb', manifest.tooling.defaultHeapMb],
      ['maximumDistinctStates', manifest.tooling.defaultMaximumDistinctStates], ['maximumDepth', undefined]]) {
      const value = check[field] ?? fallback;
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${check.id} has invalid ${field}.`);
    }
    if (check.baseline) validateBaseline(check);
    if (['negative-control', 'candidate-counterexample', 'reachability'].includes(check.kind)) {
      if (!check.expectedInvariant || !check.requiredWitness || !Number.isInteger(check.minimumTraceDepth) || check.minimumTraceDepth < 2) {
        throw new Error(`${check.id} must define expectedInvariant, requiredWitness, and minimumTraceDepth >= 2.`);
      }
    }
    if (check.kind === 'candidate-counterexample') {
      if (!check.evidence || !check.implementationDiscrepancy) throw new Error(`${check.id} must define evidence and implementationDiscrepancy.`);
      safeRelative(check.evidence, `${check.id} evidence`);
    }
  }

  if (!testMode) {
    for (const [id, kind] of requiredChecks) {
      const check = manifest.checks.find((candidate) => candidate.id === id);
      if (!check) throw new Error(`Required formal check removed: ${id}.`);
      if (check.kind !== kind) throw new Error(`Required formal check ${id} must have kind ${kind}.`);
    }
    const extras = manifest.checks.filter((check) => !requiredChecks.has(check.id));
    if (extras.length) throw new Error(`Unexpected formal checks outside the required matrix: ${extras.map((check) => check.id).join(', ')}.`);
    validateDeclaredStatus(manifest);
  }

  for (const module of manifest.sanyModules) requireFile(safeRelative(`${module}.tla`, `SANY module ${module}`), `SANY module ${module}`);
  validateTransitionMap(transitionMapPath);
}

function validateBaseline(check) {
  const baseline = check.baseline;
  for (const field of ['generated', 'distinct', 'depth', 'minGenerated', 'minDistinct', 'minDepth']) {
    if (!Number.isInteger(baseline[field]) || baseline[field] <= 0) throw new Error(`${check.id} has invalid baseline.${field}.`);
  }
  if (baseline.minGenerated > baseline.generated || baseline.minDistinct > baseline.distinct || baseline.minDepth > baseline.depth) {
    throw new Error(`${check.id} baseline floors exceed the recorded baseline.`);
  }
}

function readArchitectureStatus(manifest) {
  const path = safeRootRelative(manifest.tooling.architectureManifest, 'architecture manifest');
  requireFile(path, 'architecture manifest');
  const text = readFileSync(path, 'utf8');
  const match = text.match(/- id: OBTS-FM-002[\s\S]*?\n\s+status:\s*(accepted|candidate)\b/u);
  if (!match) throw new Error('architecture manifest has no OBTS-FM-002 accepted/candidate status.');
  return match[1];
}

function validateDeclaredStatus(manifest) {
  const candidateCount = manifest.checks.filter((check) => check.kind === 'candidate-counterexample').length;
  const architectureStatus = readArchitectureStatus(manifest);
  if (manifest.architectureStatus !== architectureStatus) throw new Error('checks.json architectureStatus disagrees with architecture/manifest.yaml.');
  if (architectureStatus === 'candidate' && candidateCount === 0) throw new Error('Candidate status requires at least one required candidate counterexample.');
  if (architectureStatus === 'accepted' && candidateCount !== 0) throw new Error('Accepted status requires zero candidate counterexamples.');
}

function validateArchitectureStatus(manifest, summaries) {
  const candidates = summaries.filter((summary) => summary.outcome === 'CANDIDATE').length;
  if (manifest.architectureStatus === 'accepted' && candidates !== 0) throw new Error('Accepted OBTS-FM-002 produced a candidate counterexample.');
  if (manifest.architectureStatus === 'candidate' && candidates === 0) throw new Error('Candidate OBTS-FM-002 produced no required candidate counterexample.');
}

function validateTransitionMap(path) {
  requireFile(path, 'transition map');
  const map = loadJson(path, 'transition map');
  if (map.schemaVersion !== 2 || map.modelId !== 'OBTS-FM-002' || !map.actions || !map.productionFamilies) {
    throw new Error('transition-map.json has an unsupported schema or model ID.');
  }
  const rootModule = safeRelative(map.rootModule, 'transition root module');
  requireFile(rootModule, 'transition root module');
  requireFile(safeRelative(map.traceSchema, 'trace schema'), 'trace schema');
  const module = readFileSync(rootModule, 'utf8');
  const match = module.match(/RootActions\s*==\s*\{([\s\S]*?)\n\}/u);
  if (!match) throw new Error('RootActions cannot be extracted from the distributed root module.');
  const rootActions = [...match[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/gu)].map((item) => item[1]);
  const mappedActions = Object.keys(map.actions);
  const missing = rootActions.filter((action) => !mappedActions.includes(action));
  const unknown = mappedActions.filter((action) => !rootActions.includes(action));
  if (missing.length || unknown.length) throw new Error(`transition map mismatch; unmapped root actions: ${missing.join(', ') || 'none'}; unknown mapped actions: ${unknown.join(', ') || 'none'}.`);

  const contractText = ['safety.md', 'sync.md', 'persistence.md', 'verification.md']
    .map((file) => readFileSync(join(root, 'architecture', 'contracts', file), 'utf8')).join('\n');
  const knownContracts = new Set(contractText.match(/OBTS-[A-Z]+(?:-[A-Z]+)*-[0-9]{3}/gu) ?? []);
  for (const [action, entry] of Object.entries(map.actions)) {
    for (const field of ['contracts', 'code', 'tests']) if (!Array.isArray(entry[field]) || entry[field].length === 0) throw new Error(`transition ${action} has no ${field} mapping.`);
    const unknownContracts = entry.contracts.filter((id) => !knownContracts.has(id));
    if (unknownContracts.length) throw new Error(`transition ${action} maps unknown contract IDs: ${unknownContracts.join(', ')}.`);
    for (const ref of [...entry.code, ...entry.tests]) validateSourceReference(ref, `transition ${action}`);
  }
  for (const [family, refs] of Object.entries(map.productionFamilies)) {
    if (!Array.isArray(refs) || refs.length === 0) throw new Error(`production family ${family} has no source evidence.`);
    for (const ref of refs) validateSourceReference(ref, `production family ${family}`);
  }
}

function validateSourceReference(reference, label) {
  if (typeof reference !== 'string') throw new Error(`${label} has a non-string source reference.`);
  const match = reference.match(/^([^:]+)(?::([0-9]+)(?:-([0-9]+))?)?$/u);
  if (!match) throw new Error(`${label} has invalid source range: ${reference}`);
  const path = resolve(root, match[1]);
  assertContained(path, root, `${label} source path`);
  requireFile(path, `${label} source path`);
  if (!match[2]) return;
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  const lines = readFileSync(path, 'utf8').split('\n').length - 1;
  if (start < 1 || end < start || end > lines) throw new Error(`${label} has invalid source range ${reference}; file has ${lines} lines.`);
}

function runSany(manifest) {
  for (const module of manifest.sanyModules) {
    const result = runTool(manifest, 'sany', [module], manifest.tooling.defaultTimeoutMs, manifest.tooling.defaultHeapMb, `sany-${module.replaceAll('/', '-')}`);
    if (result.timedOut) fail(`SANY ${module} timed out`, result);
    if (result.status !== 0 || hasParserOrSemanticError(result.output)) fail(`SANY ${module} validation failed`, result);
  }
}

function runCheck(manifest, check) {
  const timeoutMs = check.timeoutMs ?? manifest.tooling.defaultTimeoutMs;
  const heapMb = check.heapMb ?? manifest.tooling.defaultHeapMb;
  const maximumDistinctStates = check.maximumDistinctStates ?? manifest.tooling.defaultMaximumDistinctStates;
  const args = ['-cleanup', '-workers', String(manifest.tooling.workers), '-fp', String(manifest.tooling.fingerprintPolynomial),
    '-config', check.config, '-metadir', join(runRoot, check.id), check.model];
  const started = Date.now();
  const result = runTool(manifest, 'tlc', args, timeoutMs, heapMb, check.id);
  const elapsedMs = Date.now() - started;
  if (result.timedOut) fail(`${check.id} timed out after ${timeoutMs}ms`, result);
  if (hasParserOrSemanticError(result.output)) fail(`${check.id} failed to parse or evaluate`, result);
  if (/Deadlock reached/u.test(result.output)) fail(`${check.id} reached a deadlock`, result);
  if (/Too many possible next states|OutOfMemoryError|Error: The number of states/u.test(result.output)) fail(`${check.id} exceeded a TLC resource limit`, result);
  const stats = parseStats(result.output);
  enforceBudgets(check, stats, maximumDistinctStates, result);

  if (check.kind === 'positive-safety' || check.kind === 'positive-liveness') {
    if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) fail(`${check.id} positive check failed`, result);
    return { ...stats, elapsedMs, id: check.id, outcome: 'PASS' };
  }
  const counterexample = validateExpectedCounterexample(check, result);
  if (check.kind === 'candidate-counterexample') validateCandidateEvidence(check, result, stats, counterexample);
  return { ...stats, elapsedMs, id: check.id, outcome: check.kind === 'candidate-counterexample' ? 'CANDIDATE' : check.kind === 'reachability' ? 'REACHED' : 'REJECTED' };
}

function enforceBudgets(check, stats, maximumDistinctStates, result) {
  if (stats.distinct >= maximumDistinctStates) fail(`${check.id} reached its ${maximumDistinctStates} distinct-state budget`, result);
  if (stats.depth > check.maximumDepth) fail(`${check.id} reached depth ${stats.depth}, above budget ${check.maximumDepth}`, result);
  if (!check.baseline) return;
  const baseline = check.baseline;
  if (stats.generated < baseline.minGenerated || stats.distinct < baseline.minDistinct || stats.depth < baseline.minDepth) {
    fail(`${check.id} state space collapsed below its baseline floor`, result);
  }
  for (const field of ['generated', 'distinct', 'depth']) if (stats[field] > baseline[field] * 2) fail(`${check.id} unexplained ${field} growth exceeded twice baseline`, result);
}

function validateExpectedCounterexample(check, result) {
  if (result.status === 0) fail(`${check.id} did not produce its required counterexample`, result);
  const invariants = [...result.output.matchAll(/Invariant ([A-Za-z0-9_]+) is violated\./gu)].map((match) => match[1]);
  if (invariants.length !== 1 || invariants[0] !== check.expectedInvariant) fail(`${check.id} violated ${invariants.join(', ') || 'no invariant'} instead of exactly ${check.expectedInvariant}`, result);
  const actions = [...result.output.matchAll(/^State ([0-9]+): <([^>]+)>/gmu)].map((match) => ({ state: Number(match[1]), action: match[2].split(/\s+line\s+/u)[0] }));
  if (!actions.some(({ action }) => action.includes(check.requiredWitness))) fail(`${check.id} counterexample lacks witness action ${check.requiredWitness}`, result);
  const traceDepth = Math.max(0, ...actions.map(({ state }) => state));
  if (traceDepth < check.minimumTraceDepth) fail(`${check.id} witness depth ${traceDepth} is below required meaningful prefix ${check.minimumTraceDepth}`, result);
  if (!/The behavior up to this point is:/u.test(result.output)) fail(`${check.id} did not emit a state-machine witness`, result);
  return { actions: actions.map(({ action }) => action), traceDepth };
}

function validateCandidateEvidence(check, result, stats, counterexample) {
  const modelPath = safeRelative(`${check.model}.tla`, `${check.id} model`);
  const configPath = safeRelative(check.config, `${check.id} config`);
  const version = result.output.match(/^TLC2 Version ([^\n]+)/mu)?.[1];
  if (!version) fail(`${check.id} output has no TLC version`, result);
  const evidence = {
    schemaVersion: 1,
    checkId: check.id,
    expectedInvariant: check.expectedInvariant,
    requiredWitness: check.requiredWitness,
    modelSha256: hashFile(modelPath),
    configSha256: hashFile(configPath),
    checkSha256: hashValue(check),
    tlcVersion: version,
    stats,
    traceDepth: counterexample.traceDepth,
    actions: counterexample.actions
  };
  evidence.runSha256 = hashValue(evidence);
  const path = safeRelative(check.evidence, `${check.id} evidence`);
  if (updateEvidence) writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  else {
    requireFile(path, `${check.id} evidence`);
    const recorded = loadJson(path, `${check.id} evidence`);
    if (JSON.stringify(recorded) !== JSON.stringify(evidence)) fail(`${check.id} evidence is stale or unrelated; run --update-evidence with the current TLC output`, result);
  }
}

function runTool(manifest, tool, args, timeoutMs, heapMb, fixtureId) {
  const fixtureDir = process.env.FORMAL_FIXTURE_DIR;
  if (fixtureDir) {
    const fixture = loadJson(join(fixtureDir, `${fixtureId}.json`), `formal fixture ${fixtureId}`);
    return { status: fixture.status, timedOut: fixture.timedOut === true, output: fixture.output ?? '' };
  }
  const jar = process.env.TLA2TOOLS_JAR;
  const executable = jar ? 'java' : tool === 'sany' ? 'tla2sany' : 'tlc';
  const commandArgs = jar ? ['-cp', resolve(jar), tool === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args] : args;
  const library = safeRelative(manifest.tooling.moduleLibrary, 'module library');
  const javaOptions = [process.env.JAVA_TOOL_OPTIONS, `-Xmx${heapMb}m`, '-XX:+UseParallelGC', `-DTLA-Library=${library}`].filter(Boolean).join(' ');
  const result = spawnSync(executable, commandArgs, { cwd: modelDir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: javaOptions } });
  if (result.error?.code === 'ENOENT') throw new Error(`${executable} is unavailable. Install TLA+ tools or set TLA2TOOLS_JAR.`);
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  return { status: result.status, timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function hasParserOrSemanticError(output) {
  return /Parse Error|Parsing error|Semantic errors:|TLC threw an unexpected exception|Error: Evaluating/u.test(output);
}

function parseStats(output) {
  const stateMatches = [...output.matchAll(/([0-9,]+) states generated, ([0-9,]+) distinct states found/gu)];
  const depthMatches = [...output.matchAll(/[Tt]he depth of the complete state graph search is ([0-9,]+)/gu)];
  const state = stateMatches.at(-1);
  const depth = depthMatches.at(-1);
  if (!state || !depth) throw new Error(`TLC output did not contain final state/depth evidence.\n${output}`);
  return { generated: Number(state[1].replaceAll(',', '')), distinct: Number(state[2].replaceAll(',', '')), depth: Number(depth[1].replaceAll(',', '')) };
}

function printSummary(manifest, summaries) {
  console.log('Formal model evidence:');
  for (const summary of summaries) console.log(`${summary.id}: ${summary.outcome}; generated=${summary.generated}; distinct=${summary.distinct}; depth=${summary.depth}; time=${summary.elapsedMs}ms`);
  const candidates = summaries.filter((summary) => summary.outcome === 'CANDIDATE').length;
  console.log(`Formal checks complete: ${summaries.length} required checks; ${candidates} current candidate counterexample(s); OBTS-FM-002 status is ${manifest.architectureStatus}.`);
}

function fail(message, result) {
  throw new Error(`${message} (exit ${String(result.status)}).\n${result.output}`);
}
