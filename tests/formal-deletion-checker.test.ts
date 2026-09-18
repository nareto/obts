import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'scripts', 'check-deletion-model.mjs');
const candidateRegression = join(root, 'tests', 'formal-deletion-checker-candidate.mjs');
const matrix = JSON.parse(readFileSync(join(root, 'architecture/models/formal/checks-fm004.json'), 'utf8'));

function runFixture(output: string, options: { status?: number; timedOut?: boolean; check?: Record<string, unknown> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'obts-fm004-checker-'));
  try {
    const fixtureId = 'fixture-check';
    const manifest = {
      ...matrix,
      sanyModules: [],
      checks: [{
        id: fixtureId,
        model: undefined,
        config: 'configs/fm004-safety.cfg',
        kind: 'positive-safety',
        timeoutMs: 1000,
        heapMb: 128,
        maximumDistinctStates: 100,
        maximumDepth: 20,
        baseline: { generated: 10, distinct: 8, depth: 5, minGenerated: 5, minDistinct: 4, minDepth: 2 },
        ...options.check
      }]
    };
    delete manifest.checks[0].model;
    const manifestPath = join(directory, 'checks.json');
    const fixtures = join(directory, 'fixtures');
    mkdirSync(fixtures);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(join(fixtures, 'fixture-check.json'), `${JSON.stringify({ status: options.status ?? 0, timedOut: options.timedOut ?? false, output })}\n`);
    return spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FM004_TEST_MODE: '1',
        FM004_CHECKS_MANIFEST: manifestPath,
        FM004_FIXTURE_DIR: fixtures
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const stats = '10 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n';
const positive = `TLC2 Version test\nModel checking completed. No error has been found.\n${stats}`;
const counterexample = (invariant: string, witness: string, states = 3) => `TLC2 Version test\nError: Invariant ${invariant} is violated.\nError: The behavior up to this point is:\n${Array.from({ length: states }, (_, index) => `State ${index + 1}: <${index + 1 === states ? witness : 'SetupAction'} line 1, col 1 to line 1, col 2 of module Fixture>`).join('\n')}\n${stats}`;

describe('FM004 deletion checker gates', () => {
  it('accepts the checked matrix in validate-only mode', () => {
    const result = spawnSync(process.execPath, [checker, '--validate-only'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('29 required checks');
  });

  it('runs the supplementary candidate checker regression', () => {
    const result = spawnSync(process.execPath, [candidateRegression], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('candidate checker gates passed');
  });

  it('accepts a valid positive baseline fixture', () => {
    const result = runFixture(positive);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('passed: 1 checks; 1 positive');
  });

  it('rejects a collapsed positive baseline', () => {
    const result = runFixture(`TLC2 Version test\nModel checking completed. No error has been found.\n4 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('state space collapsed below its generated floor');
  });

  it('rejects unexplained positive baseline growth', () => {
    const result = runFixture(`TLC2 Version test\nModel checking completed. No error has been found.\n21 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexplained generated growth exceeded twice baseline');
  });

  it('rejects resource-overflow output', () => {
    const result = runFixture('TLC worker failed: Too many possible next states.\n', { status: 1 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('parse/semantic/resource failure');
  });

  it('rejects a shallow negative witness', () => {
    const result = runFixture(counterexample('ExpectedInvariant', 'WitnessAction', 2), {
      status: 12,
      check: { kind: 'negative-control', expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3 }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('below 3');
  });

  it('rejects an unexpected deadlock', () => {
    const result = runFixture(`Deadlock reached.\n${stats}`, { status: 12 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpectedly deadlocked');
  });

  it('rejects a timeout', () => {
    const result = runFixture('', { status: 1, timedOut: true });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('timed out');
  });

  it('rejects a wrong invariant', () => {
    const result = runFixture(counterexample('WrongInvariant', 'WitnessAction'), {
      status: 12,
      check: { kind: 'negative-control', expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3 }
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('did not violate exactly ExpectedInvariant');
  });
});
