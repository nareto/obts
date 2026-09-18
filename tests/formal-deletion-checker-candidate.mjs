import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'scripts/check-deletion-model.mjs');
const matrix = JSON.parse(readFileSync(join(root, 'architecture/models/formal/checks-fm004.json'), 'utf8'));
const stats = '10 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n';
const positive = `TLC2 Version test\nModel checking completed. No error has been found.\n${stats}`;
const counterexample = (invariant, witness, depth = 3) => `TLC2 Version test\nError: Invariant ${invariant} is violated.\nError: The behavior up to this point is:\n${Array.from({ length: depth }, (_, i) => `State ${i + 1}: <${i + 1 === depth ? witness : 'SetupAction'} line 1, col 1 to line 1, col 2 of module Fixture>`).join('\n')}\n${stats}`;

function run(output, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'obts-fm004-candidate-gates-'));
  try {
    const fixtures = join(dir, 'fixtures'); mkdirSync(fixtures);
    const check = { id: 'fixture-check', model: undefined, config: 'configs/fm004-safety.cfg', kind: 'positive-safety', timeoutMs: 1000, heapMb: 128, maximumDistinctStates: 100, maximumDepth: 20, baseline: { generated: 10, distinct: 8, depth: 5, minGenerated: 5, minDistinct: 4, minDepth: 2 }, ...(options.check ?? {}) };
    delete check.model;
    const manifest = { ...matrix, sanyModules: [], checks: [check] };
    writeFileSync(join(dir, 'checks.json'), JSON.stringify(manifest));
    writeFileSync(join(fixtures, 'fixture-check.json'), JSON.stringify({ status: options.status ?? 0, timedOut: options.timedOut ?? false, output }));
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', env: { ...process.env, FM004_TEST_MODE: '1', FM004_CHECKS_MANIFEST: join(dir, 'checks.json'), FM004_FIXTURE_DIR: fixtures } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const validPositive = run(positive);
if (validPositive.status !== 0 || !validPositive.stdout.includes('passed: 1 checks; 1 positive')) throw new Error('valid positive baseline was rejected');
const collapsedPositive = run(`TLC2 Version test\nModel checking completed. No error has been found.\n4 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n`);
if (collapsedPositive.status === 0 || !collapsedPositive.stderr.includes('state space collapsed below its generated floor')) throw new Error('collapsed positive baseline was accepted');
const growingPositive = run(`TLC2 Version test\nModel checking completed. No error has been found.\n21 states generated, 8 distinct states found, 0 states left on queue.\nThe depth of the complete state graph search is 5.\n`);
if (growingPositive.status === 0 || !growingPositive.stderr.includes('unexplained generated growth exceeded twice baseline')) throw new Error('growing positive baseline was accepted');
const resourceOverflow = run('TLC worker failed: Too many possible next states.\n', { status: 1 });
if (resourceOverflow.status === 0 || !resourceOverflow.stderr.includes('parse/semantic/resource failure')) throw new Error('resource-overflow output was accepted');
const shallow = run(counterexample('ExpectedInvariant', 'WitnessAction', 2), { status: 12, check: { kind: 'negative-control', expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3 } });
if (shallow.status === 0 || !shallow.stderr.includes('below 3')) throw new Error('shallow witness was accepted');
const deadlock = run(`Deadlock reached.\n${stats}`, { status: 12 });
if (deadlock.status === 0 || !deadlock.stderr.includes('unexpectedly deadlocked')) throw new Error('deadlock was accepted');
const timeout = run('', { status: 1, timedOut: true });
if (timeout.status === 0 || !timeout.stderr.includes('timed out')) throw new Error('timeout was accepted');
const wrongInvariant = run(counterexample('WrongInvariant', 'WitnessAction'), { status: 12, check: { kind: 'negative-control', expectedInvariant: 'ExpectedInvariant', requiredWitness: 'WitnessAction', minimumTraceDepth: 3 } });
if (wrongInvariant.status === 0 || !wrongInvariant.stderr.includes('did not violate exactly ExpectedInvariant')) throw new Error('wrong invariant was accepted');
console.log('candidate checker gates passed: positive baseline, baseline collapse/growth, resource overflow, shallow witness, deadlock, timeout, wrong invariant');
