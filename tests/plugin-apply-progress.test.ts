import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticPoints } from '../src/shared/diagnostics.js';
import { mobileHarness } from './helpers/mobileOnboardingHarness.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  await mkdir('tmp/apply-progress-tests', { recursive: true });
  const root = await mkdtemp(join(process.cwd(), 'tmp/apply-progress-tests/client-'));
  const client = await mobileHarness(root, 'http://127.0.0.1:1');
  cleanups.push(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'first.md'), 'first\n');
  await writeFile(join(root, 'second.md'), 'second\n');
  const progress: Array<{ label: string; point: string }> = [];
  client.plugin.setOperationProgress = (label: string, point: string) => progress.push({ label, point });
  return { ...client, root, progress };
}

describe('mobile post-apply progress', () => {
  it('reports both capture passes with one final inventory verification', async () => {
    const client = await fixture();
    const verificationLabels: string[] = [];
    const verify = client.core.verifyLocalPolicySnapshot.bind(client.core);
    client.core.verifyLocalPolicySnapshot = async (snapshot: unknown) => {
      verificationLabels.push(client.progress.at(-1)?.label || '');
      return await verify(snapshot);
    };
    const result = await client.core.captureStableLocalChanges(new Map());
    expect(result.stable).toBe(true);
    expect(result.paths).toEqual(['first.md', 'second.md']);
    expect(verificationLabels).toEqual(['Applying (listing vault files)']);
    expect(client.progress).toContainEqual({ label: 'Applying (checking local edits) 0/4', point: 'local_preservation' });
    expect(client.progress).toContainEqual({ label: 'Applying (checking local edits) 2/4', point: 'local_preservation' });
    expect(client.progress).toContainEqual({ label: 'Applying (checking local edits) 4/4', point: 'local_preservation' });
    for (const event of client.progress) expect(diagnosticPoints).toContain(event.point);
    expect(JSON.stringify(client.progress)).not.toContain('first.md');
  });

  it('labels the fallback inventory scan without changing pending-scan behavior', async () => {
    const client = await fixture();
    await client.core.writeState({ ...await client.core.readState(), vault_id: 'vault', device_id: 'device' });
    await client.core.markLocalApplyScanPending({ affected_paths: ['remote.md'], deferred_local_paths: [] }, new Map());
    expect(client.progress[0]).toEqual({ label: 'Applying (listing vault files)', point: 'local_preservation' });
    expect(client.plugin.syncQueued).toBe(true);
    expect((await client.core.readQueue()).changed_paths).toEqual(['first.md', 'remote.md', 'second.md']);
  });

  it('throttles intermediate counts while always emitting boundaries and phase transitions', async () => {
    const client = await fixture();
    vm.runInContext('Date.now = () => 1000', client.context);
    const report = client.core.createLocalApplyProgress();
    for (let completed = 0; completed <= 1000; completed += 1) {
      report('Applying (checking local edits)', completed, 1000);
    }
    report('Applying (listing vault files)');
    report('Applying (checking local edits)', 500, 1000);
    expect(client.progress.map(event => event.label)).toEqual([
      'Applying (checking local edits) 0/1000',
      'Applying (checking local edits) 1000/1000',
      'Applying (listing vault files)',
      'Applying (checking local edits) 500/1000'
    ]);
  });

  it('continues reporting when a changed snapshot needs a second attempt', async () => {
    const client = await fixture();
    const capture = client.core.captureLocalFileSnapshot.bind(client.core);
    let captures = 0;
    client.core.captureLocalFileSnapshot = async (...args: unknown[]) => {
      const snapshot = await capture(...args);
      captures += 1;
      if (captures === 1) await writeFile(join(client.root, 'first.md'), 'local edit during capture\n');
      return snapshot;
    };
    const result = await client.core.captureStableLocalChanges(new Map());
    expect(result.stable).toBe(true);
    expect(captures).toBe(4);
    expect(client.progress.filter(event => event.label === 'Applying (checking local edits) 0/4')).toHaveLength(2);
    expect(client.progress.filter(event => event.label === 'Applying (checking local edits) 4/4')).toHaveLength(2);
  });

  it.each(['add', 'delete', 'policy'])('rejects a %s race between captures without publishing a partial snapshot', async (change) => {
    const client = await fixture();
    const capture = client.core.captureLocalFileSnapshot.bind(client.core);
    let captures = 0;
    client.core.captureLocalFileSnapshot = async (...args: unknown[]) => {
      const snapshot = await capture(...args);
      if (++captures === 1) {
        if (change === 'add') await writeFile(join(client.root, 'late.md'), 'late edit\n');
        if (change === 'delete') await rm(join(client.root, 'first.md'));
        if (change === 'policy') await writeFile(join(client.root, '.gitignore'), 'first.md\n');
      }
      return snapshot;
    };
    const before = await client.core.readQueue();
    const result = await client.core.captureStableLocalChanges(new Map(), 1);
    expect(result.stable).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(await client.core.readQueue()).toEqual(before);
  });

  it('keeps interrupted-apply capture on the initialization reporter', async () => {
    const client = await fixture();
    const initializationLabels: string[] = [];
    client.plugin.updateInitializationProgress = (label: string) => initializationLabels.push(label);
    const result = await client.core.captureStableLocalChanges(new Map(), 3, true);
    expect(result.stable).toBe(true);
    expect(client.progress).toEqual([]);
    expect(initializationLabels).toContain('Applying (checking local edits) 4/4');
    expect(initializationLabels).toContain('Applying (listing vault files)');
  });

  it.each([false, true])('reports directory inventory and stat work (initialization=%s)', async (initialization) => {
    const client = await fixture();
    await mkdir(join(client.root, 'empty'));
    const initializationLabels: string[] = [];
    client.plugin.updateInitializationProgress = (label: string) => initializationLabels.push(label);
    await client.core.preserveDirectoryChangesFromTarget(new Map(), [], new Set(), initialization);
    const labels = initialization ? initializationLabels : client.progress.map(event => event.label);
    expect(labels).toContain('Applying (listing vault files)');
    expect(labels).toContain('Applying (checking directories) 0/1');
    expect(labels).toContain('Applying (checking directories) 1/1');
    expect(labels.join('\n')).not.toContain('empty');
    if (initialization) expect(client.progress).toEqual([]);
  });

  it('does not let background provenance maintenance change the measured phase', async () => {
    const client = await fixture();
    await client.core.mutateStaleProvenance(async () => undefined);
    expect(client.progress).toEqual([]);
  });

  it.each([false, true])('finishes a final stalled phase with the actual action outcome (failure=%s)', async (failure) => {
    const client = await fixture();
    const observations: Array<{ observation: string; phaseId: string }> = [];
    client.plugin.reportOperationStall = async (phase: { observation: string; phaseId: string }) => observations.push(phase);
    client.plugin.setOperationProgress = Object.getPrototypeOf(client.plugin).setOperationProgress;
    const error = new Error('operation failed');
    const action = client.plugin.runExclusiveAction(async () => {
      client.plugin.setOperationProgress('Applying (finishing)', 'apply_finalize');
      client.plugin.activeMeasuredPhase.stalled = true;
      if (failure) throw error;
      return 'done';
    });
    if (failure) await expect(action).rejects.toBe(error);
    else await expect(action).resolves.toBe('done');
    expect(observations.map(phase => phase.observation)).toEqual([failure ? 'abandoned' : 'completed']);
    expect(client.plugin.activeMeasuredPhase).toBeNull();
  });

  it('keeps literal operation points and breadcrumb normalization within the server allowlist', async () => {
    const text = await readFile('obsidian-plugin/src/main.cjs', 'utf8');
    const source = ts.createSourceFile('main.cjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const points: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ['setInitializationStage', 'reportOperationProgress', 'setOperationProgress'].includes(node.expression.name.text)) {
        const point = node.arguments[1];
        if (point && ts.isStringLiteral(point)) points.push(point.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(points.length).toBeGreaterThan(10);
    for (const point of points) expect(diagnosticPoints).toContain(point);
    const normalizationPoints = JSON.parse(text.match(/const points = new Set\((\[[^\n]+\])\);/u)![1]!);
    expect(normalizationPoints).toEqual([...diagnosticPoints]);
  });
});
