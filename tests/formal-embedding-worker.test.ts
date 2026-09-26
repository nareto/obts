import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const formal = 'architecture/models/formal';
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(directory = root) {
  return spawnSync(process.execPath, [join(directory, 'scripts/check-bridge-bounded-model.mjs'), '--worker-companion', '--validate-only'], {
    cwd: directory, encoding: 'utf8', env: process.env
  });
}

function fixture(path: string, mutate: (value: any, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'obts-worker-formal-test-'));
  directories.push(directory);
  cpSync(join(root, 'architecture'), join(directory, 'architecture'), { recursive: true });
  mkdirSync(join(directory, 'scripts'));
  cpSync(join(root, 'scripts/check-bridge-bounded-model.mjs'), join(directory, 'scripts/check-bridge-bounded-model.mjs'));
  const trace = JSON.parse(readFileSync(join(root, formal, 'trace/fm003-worker-trace-map.json'), 'utf8'));
  for (const source of trace.currentImplementationContext) {
    mkdirSync(dirname(join(directory, source.path)), { recursive: true });
    cpSync(join(root, source.path), join(directory, source.path));
  }
  const target = join(directory, formal, path);
  const value = JSON.parse(readFileSync(target, 'utf8'));
  mutate(value, directory);
  writeFileSync(target, `${JSON.stringify(value)}\n`);
  return run(directory);
}

describe('FM003 embedding-worker companion gate', () => {
  it('validates all 48 checks, action ranges and actual reduced counterexamples', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('48 required checks');
  });

  it('includes every accepted model gate in default formal validation without dropping parent commands', () => {
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(scripts['test:formal'].split(' && ')).toEqual([
      'node scripts/check-formal-model.mjs',
      'node scripts/check-bridge-bounded-model.mjs',
      'node scripts/check-bridge-bounded-model.mjs --worker-companion',
      'node scripts/check-deletion-model.mjs',
      'node scripts/check-bridge-external-protocol.mjs',
      'node scripts/check-onboarding-model.mjs',
      'node scripts/check-onboarding-recovery-model.mjs'
    ]);
    expect(scripts['test:formal:bridge'].split(' && ')).toEqual([
      'node scripts/check-bridge-bounded-model.mjs',
      'node scripts/check-bridge-bounded-model.mjs --worker-companion',
      'node scripts/check-bridge-external-protocol.mjs'
    ]);
    expect(scripts['test:formal:onboarding']).toBe('node scripts/check-onboarding-model.mjs && node scripts/check-onboarding-recovery-model.mjs');
    expect(scripts['test:bridge:stack']).toContain('node scripts/check-bridge-stack.mjs');
    const workflow = readFileSync(join(root, '.github/workflows/formal-model.yml'), 'utf8');
    expect(workflow).toContain('run: npm run test:formal');
    expect(workflow).toContain('run: npx vitest run tests/formal-checker.test.ts tests/formal-bounded-body.test.ts tests/formal-embedding-worker.test.ts');
    expect(JSON.parse(readFileSync(join(root, formal, 'checks.json'), 'utf8')).checks).toHaveLength(77);
    expect(JSON.parse(readFileSync(join(root, formal, 'checks-fm003.json'), 'utf8')).checks).toHaveLength(39);
    expect(JSON.parse(readFileSync(join(root, formal, 'checks-fm003-workers.json'), 'utf8')).checks).toHaveLength(48);
  });

  it('rejects a removed required check', () => {
    const result = fixture('checks-fm003-workers.json', (value) => value.checks.shift());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly 48 checks');
  });

  it('rejects retyping an actual deadlock control as ordinary reachability', () => {
    const result = fixture('checks-fm003-workers.json', (value) => {
      value.checks.find((check: any) => check.id === 'fm003-worker-negative-completion-lock').kind = 'reachability';
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('required kind changed');
  });

  it('rejects a weakened stale-failure outcome', () => {
    const result = fixture('checks-fm003-workers.json', (value) => {
      value.checks.find((check: any) => check.id === 'fm003-worker-negative-id-failure').expectedInvariant = 'TypeOK';
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('required expectedInvariant changed');
  });

  it('rejects config traversal and a different model', () => {
    const traversal = fixture('checks-fm003-workers.json', (value) => { value.checks[0].config = '../escape.cfg'; });
    expect(traversal.status).not.toBe(0);
    expect(traversal.stderr).toContain('escapes the formal model directory');
    const model = fixture('checks-fm003-workers.json', (value) => { value.model = 'OBTSBridgeBoundedBody.tla'; });
    expect(model.status).not.toBe(0);
    expect(model.stderr).toContain('model/companion mismatch');
  });

  it('rejects missing transition mappings and wrong action ranges', () => {
    const missing = fixture('trace/fm003-worker-trace-map.json', (value) => { delete value.actions.CompleteSQL; });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('omits a transition');
    const range = fixture('trace/fm003-worker-trace-map.json', (value) => {
      value.actions.CompleteSQL.model = value.actions.TakeQueue.model;
    });
    expect(range.status).not.toBe(0);
    expect(range.stderr).toContain('range starts at the wrong action');
  });

  it.each(['InverseBody', 'InverseHeadless', 'ProviderFailure', 'ReplaceBlock', 'Cancel', 'RejectAttestation', 'SchemaReset'])('rejects valid IDs whose config never exercises %s', (action) => {
    const result = fixture('trace/fm003-worker-trace-map.json', (value) => {
      value.actions[action].checks = ['fm003-worker-note-safety', 'fm003-worker-note-liveness'];
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Worker trace action ${action} is not exercised by`);
  });

  it('rejects coverage evidence after configuration or model changes', () => {
    const config = fixture('checks-fm003-workers.json', (value) => { value.checks[0].config = value.checks[2].config; });
    expect(config.status).not.toBe(0);
    expect(config.stderr).toContain('action coverage config digest is stale');
    const model = fixture('trace/fm003-worker-action-coverage.json', (_value, directory) => {
      const path = join(directory, formal, 'OBTSBridgeEmbeddingWorker.tla');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    });
    expect(model.status).not.toBe(0);
    expect(model.stderr).toContain('metadata/model digest is stale');
  });

  it('requires generated successors rather than mere action names in coverage', () => {
    const result = fixture('trace/fm003-worker-action-coverage.json', (value) => {
      value.checks['fm003-worker-schema-note-safety'].generatedActions.SchemaReset = 0;
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SchemaReset is not exercised');
  });

  it('keeps independent schema reset and note/block failure checks in the matrix', () => {
    const manifest = JSON.parse(readFileSync(join(root, formal, 'checks-fm003-workers.json'), 'utf8'));
    for (const work of ['note', 'block', 'reindex']) {
      const id = `fm003-worker-schema-${work}-liveness`;
      const check = manifest.checks.find((entry: any) => entry.id === id);
      const config = readFileSync(join(root, formal, check.config), 'utf8');
      expect(config).toContain(`WorkKind = "${work}"`);
      expect(config).toContain('Drift = "schema"');
      expect(config).toContain('Fault = "failure"');
      expect(config).toContain('SchemaGenerationRetry');
    }
    for (const work of ['note', 'block']) {
      for (const outcome of ['success', 'failure']) {
        expect(manifest.checks.some((entry: any) => entry.id === `fm003-worker-negative-schema-${work}-${outcome}`)).toBe(true);
      }
    }
  });

  it('does not accept current core evidence as worker implementation conformance', () => {
    const result = fixture('trace/fm003-worker-trace-map.json', (value) => {
      value.implementationEvidenceStatus = 'partial-stage2-request-projection';
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('worker-specific implementation status');
  });

  it('requires the acceptance receipt before promoting worker implementation evidence', () => {
    const result = fixture('trace/fm003-worker-trace-map.json', value => { delete value.localAcceptance; });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lacks its local acceptance receipt');
    const downgraded = fixture('trace/fm003-worker-trace-map.json', value => { value.implementationEvidenceStatus = 'forthcoming-stage2'; });
    expect(downgraded.status).not.toBe(0);
    expect(downgraded.stderr).toContain('lacks its acceptance gate');
  });

  it('rejects missing worker profiles or reports from different binaries', () => {
    for (const change of ['mode', 'binary']) {
      const result = fixture('trace/fm003-worker-trace-map.json', (value, directory) => {
        const path = join(directory, value.localAcceptance.stackReports[1]);
        const report = JSON.parse(readFileSync(path, 'utf8'));
        if (change === 'mode') report.embeddingMode = 'disabled';
        else report.bridgeBinarySha256 = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(report));
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(change === 'mode' ? 'passing local stack report' : 'different binaries');
    }
  });

  it('rejects a reduced deadlock trace without the exact final lock cycle', () => {
    const result = fixture('trace/fm003-worker-counterexamples.json', (value) => {
      value.traces.find((trace: any) => trace.check === 'fm003-worker-negative-completion-lock').states.at(-1).values.headless = 'none';
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lacks the final lock cycle');
  });

  it('rejects counterexamples with omitted or invented witness actions', () => {
    const missing = fixture('trace/fm003-worker-counterexamples.json', (value) => { value.traces.pop(); });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('evidence is incomplete');
    const action = fixture('trace/fm003-worker-counterexamples.json', (value) => {
      value.traces[1].states[1].action = 'InventedCapture';
    });
    expect(action.status).not.toBe(0);
    expect(action.stderr).toContain('invalid state/action sequence');
  });
});
