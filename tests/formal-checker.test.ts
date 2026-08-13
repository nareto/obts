import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'scripts', 'check-formal-model.mjs');
const formalDir = join(root, 'architecture', 'models', 'formal');
const checksPath = join(formalDir, 'checks.json');
const transitionMapPath = join(formalDir, 'trace', 'transition-map.json');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'obts-formal-checker-'));
  temporaryDirectories.push(directory);
  return directory;
}

function run(args: string[] = ['--validate-only'], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [checker, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function mutateManifest(mutator: (manifest: any) => void, testMode = false) {
  const directory = testMode ? temporaryDirectory() : mkdtempSync(join(formalDir, '.checker-test-'));
  if (!testMode) temporaryDirectories.push(directory);
  const manifest = JSON.parse(readFileSync(checksPath, 'utf8'));
  mutator(manifest);
  const path = join(directory, 'checks.json');
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
  return { path, env: { FORMAL_CHECKS_MANIFEST: path, ...(testMode ? { FORMAL_TEST_MODE: '1' } : {}) } };
}

function mutateMap(mutator: (map: any) => void) {
  const directory = temporaryDirectory();
  const map = JSON.parse(readFileSync(transitionMapPath, 'utf8'));
  mutator(map);
  const path = join(directory, 'transition-map.json');
  writeFileSync(path, `${JSON.stringify(map)}\n`);
  return path;
}

function fixtureRun(options: {
  kind?: string;
  output: string;
  status?: number;
  timedOut?: boolean;
  check?: Record<string, unknown>;
}) {
  const directory = temporaryDirectory();
  const fixtureDirectory = join(directory, 'fixtures');
  const id = 'fixture-check';
  const manifest = JSON.parse(readFileSync(checksPath, 'utf8'));
  manifest.architectureStatus = 'accepted';
  manifest.sanyModules = [];
  manifest.checks = [{
    id,
    model: 'OBTSDistributedSync',
    config: 'configs/apply-refinement.cfg',
    kind: options.kind ?? 'positive-safety',
    timeoutMs: 1000,
    heapMb: 128,
    maximumDistinctStates: 100,
    maximumDepth: 20,
    ...options.check
  }];
  const manifestPath = join(directory, 'checks.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  mkdirSync(fixtureDirectory);
  writeFileSync(join(fixtureDirectory, `${id}.json`), `${JSON.stringify({ status: options.status ?? 0, timedOut: options.timedOut ?? false, output: options.output })}\n`);
  return run([], { FORMAL_TEST_MODE: '1', FORMAL_CHECKS_MANIFEST: manifestPath, FORMAL_FIXTURE_DIR: fixtureDirectory });
}

const stats = '10 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n';
const positive = `TLC2 Version test\nModel checking completed. No error has been found.\n${stats}`;
const counterexample = (invariant = 'ExpectedInvariant', witness = 'WitnessAction', states = 3) =>
  `TLC2 Version test\nError: Invariant ${invariant} is violated.\nError: The behavior up to this point is:\n` +
  Array.from({ length: states }, (_, index) => `State ${index + 1}: <${index + 1 === states ? witness : 'SetupAction'} line 1, col 1 to line 1, col 2 of module Fixture>`).join('\n') +
  `\n${stats}`;

describe('formal manifest and traceability validation', () => {
  it('accepts the exact required matrix and complete source map', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('52 required checks');
  });

  it('rejects required check removal', () => {
    const fixture = mutateManifest((manifest) => manifest.checks.splice(0, 1));
    const result = run(['--validate-only'], fixture.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Required formal check removed');
  });

  it('rejects candidate/accepted mismatch', () => {
    const fixture = mutateManifest((manifest) => { manifest.architectureStatus = 'candidate'; });
    const result = run(['--validate-only'], fixture.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('disagrees with architecture/manifest.yaml');
  });

  it('rejects path traversal', () => {
    const fixture = mutateManifest((manifest) => { manifest.checks[0].config = '../escape.cfg'; }, true);
    const result = run(['--validate-only'], fixture.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('escapes its allowed directory');
  });

  it('rejects invalid source ranges', () => {
    const map = mutateMap((value) => { value.actions.ObservePluginEdit.code[0] = 'obsidian-plugin/src/main.cjs:1-999999'; });
    const result = run(['--validate-only'], { FORMAL_TEST_MODE: '1', FORMAL_TRANSITION_MAP: map });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid source range');
  });

  it('rejects an unmapped or unknown root action', () => {
    const map = mutateMap((value) => {
      delete value.actions.CommitCASMetadata;
      value.actions.UnknownRuntimeAction = value.actions.ObservePluginEdit;
    });
    const result = run(['--validate-only'], { FORMAL_TEST_MODE: '1', FORMAL_TRANSITION_MAP: map });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unmapped root actions: CommitCASMetadata');
    expect(result.stderr).toContain('unknown mapped actions: UnknownRuntimeAction');
  });
});

describe('TLC result gates', () => {
  it('accepts a positive result', () => {
    const result = fixtureRun({ output: positive });
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects timeout', () => {
    const result = fixtureRun({ output: '', status: 1, timedOut: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('timed out');
  });

  it.each(['Parse Error', 'Semantic errors:', 'Error: Evaluating expression'])('rejects parse or semantic failure: %s', (error) => {
    const result = fixtureRun({ output: error, status: 1 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed to parse or evaluate');
  });

  it('rejects deadlock', () => {
    const result = fixtureRun({ output: `Deadlock reached.\n${stats}`, status: 12 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('reached a deadlock');
  });

  it('rejects wrong invariant and missing witness', () => {
    const wrong = fixtureRun({ kind: 'negative-control', output: counterexample('WrongInvariant'), status: 12,
      check: { expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3 } });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('instead of exactly ExpectedInvariant');
    const missing = fixtureRun({ kind: 'negative-control', output: counterexample('ExpectedInvariant', 'OtherAction'), status: 12,
      check: { expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3 } });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('lacks witness action');
  });

  it('rejects state and depth budget excess', () => {
    const statesResult = fixtureRun({ output: positive, check: { maximumDistinctStates: 8 } });
    expect(statesResult.status).not.toBe(0);
    expect(statesResult.stderr).toContain('distinct-state budget');
    const depthResult = fixtureRun({ output: positive, check: { maximumDepth: 4 } });
    expect(depthResult.status).not.toBe(0);
    expect(depthResult.stderr).toContain('above budget');
  });

  it('rejects state-space collapse', () => {
    const result = fixtureRun({ output: positive, check: { baseline: { generated: 20, distinct: 16, depth: 10, minGenerated: 15, minDistinct: 12, minDepth: 8 } } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('state space collapsed');
  });

  it('rejects a shallow negative witness', () => {
    const result = fixtureRun({ kind: 'negative-control', output: counterexample(), status: 12,
      check: { expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 4 } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('below required meaningful prefix');
  });

  it('rejects stale candidate evidence', () => {
    const result = fixtureRun({ kind: 'candidate-counterexample', output: counterexample('ExpectedInvariant', 'WitnessAction', 3), status: 12,
      check: { expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3,
        evidence: 'checks.json', implementationDiscrepancy: 'fixture discrepancy' } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('evidence is stale or unrelated');
  });
});
