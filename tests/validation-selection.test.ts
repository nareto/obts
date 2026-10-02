import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkerTests, dashboardTests, fastTests, formalFamilies, pluginTests } from '../scripts/validation-groups.mjs';
import { makePlan, selectValidation } from '../scripts/select-validation.mjs';
import { needsPluginPublication, normalizeValidationBaseline } from '../scripts/validation-baseline.mjs';
import { verifyArtifactMetadata, verifyPublishedPlugin, writeArtifactMetadata } from '../scripts/validation-artifact.mjs';
import { evaluateGate } from '../scripts/validation-gate.mjs';

const root = process.cwd();
const full = (path: string) => makePlan([path]);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'obts-validation-git-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Validation Test');
  git(cwd, 'config', 'user.email', 'validation@example.invalid');
  return cwd;
}

function commit(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('validation selection', () => {
  it('selects docs as fast, plugin/dashboard styles and plugin metadata into scoped groups', () => {
    expect(makePlan(['README.md']).executableGroup).toBe('fast');
    expect(makePlan(['docs/ops.md']).executableGroup).toBe('fast');
    expect(makePlan(['frontend/dashboard/src/theme.css']).executableGroup).toBe('dashboard');
    expect(makePlan(['obsidian-plugin/styles.css']).executableGroup).toBe('plugin');
    expect(makePlan(['obsidian-plugin/main.js']).executableGroup).toBe('plugin');
    expect(makePlan(['README.md', 'obsidian-plugin/styles.css']).executableGroup).toBe('plugin');
    expect(makePlan(['docs/ops.md', 'frontend/dashboard/src/theme.css']).executableGroup).toBe('dashboard');
    expect(makePlan(['architecture/contracts/safety.md']).executableGroup).toBe('all');
  });

  it('falls back broadly for core, mixed, tooling, unknown, or unproven metadata changes', () => {
    for (const paths of [
      ['obsidian-plugin/src/main.cjs'], ['src/shared/sync.ts'], ['crates/obts-bridge/src/lib.rs'],
      ['scripts/select-validation.mjs'], ['scripts/check-deletion-model.mjs'], ['scripts/build-plugin.mjs'],
      ['package-lock.json'], ['vitest.config.ts'], ['tests/phase1.test.ts'], ['mystery/unknown.bin'],
      ['README.md', 'obsidian-plugin/src/main.cjs'], ['src/removed-safety.ts'], ['src/old-safety.ts', 'src/new-safety.ts'],
      ['src/shared/pluginCompatibility.ts'], ['obsidian-plugin/src/version.ts'], ['obsidian-plugin/manifest.json'],
      ['frontend/dashboard/src/a.css', 'obsidian-plugin/styles.css']
    ]) expect(makePlan(paths).executableGroup).toBe('all');
    expect(full('crates/obts-bridge/src/lib.rs').rustUnitTestsRequired).toBe(true);
    expect(full('mystery/unknown.bin').rustUnitTestsRequired).toBe(true);
  });

  it('only treats committed version-literal changes as scoped plugin metadata', () => {
    const cwd = fixture();
    try {
      mkdirSync(join(cwd, 'src/shared'), { recursive: true });
      mkdirSync(join(cwd, 'obsidian-plugin/src'), { recursive: true });
      mkdirSync(join(cwd, 'obsidian-plugin'), { recursive: true });
      writeFileSync(join(cwd, 'src/shared/pluginCompatibility.ts'), "export const MINIMUM_PLUGIN_VERSION = '0.2.0';\nexport const RECOMMENDED_PLUGIN_VERSION = '0.5.9';\n");
      writeFileSync(join(cwd, 'obsidian-plugin/src/version.ts'), "export const PLUGIN_VERSION = '0.5.9';\n");
      writeFileSync(join(cwd, 'obsidian-plugin/manifest.json'), '{"id":"obts","version":"0.5.9"}\n');
      writeFileSync(join(cwd, 'obsidian-plugin/main.js'), 'generated old bundle');
      writeFileSync(join(cwd, 'obsidian-plugin/styles.css'), '.status { color: red; }');
      const base = commit(cwd, 'base');
      writeFileSync(join(cwd, 'src/shared/pluginCompatibility.ts'), "export const MINIMUM_PLUGIN_VERSION = '0.2.0';\nexport const RECOMMENDED_PLUGIN_VERSION = '0.6.0';\n");
      writeFileSync(join(cwd, 'obsidian-plugin/src/version.ts'), "export const PLUGIN_VERSION = '0.6.0';\n");
      writeFileSync(join(cwd, 'obsidian-plugin/manifest.json'), '{"id":"obts","version":"0.6.0"}\n');
      writeFileSync(join(cwd, 'obsidian-plugin/main.js'), 'generated new bundle');
      writeFileSync(join(cwd, 'obsidian-plugin/styles.css'), '.status { color: green; }');
      writeFileSync(join(cwd, 'README.md'), 'Updated styling');
      const head = commit(cwd, 'style release with generated bundle and version bump');
      const releasePlan = selectValidation({ cwd, base, head });
      expect(releasePlan.executableGroup).toBe('plugin');
      expect(releasePlan.formalFamilies).toEqual([]);

      writeFileSync(join(cwd, 'src/shared/pluginCompatibility.ts'), "export const MINIMUM_PLUGIN_VERSION = '0.3.0';\nexport const RECOMMENDED_PLUGIN_VERSION = '0.6.0';\n");
      const minimumChange = commit(cwd, 'minimum version changed');
      expect(selectValidation({ cwd, base: head, head: minimumChange }).executableGroup).toBe('all');

      writeFileSync(join(cwd, 'obsidian-plugin/src/version.ts'), "export const PLUGIN_VERSION = '0.6.0';\nexport const unrelated = true;\n");
      const extraCode = commit(cwd, 'unrelated source change');
      expect(selectValidation({ cwd, base: minimumChange, head: extraCode }).executableGroup).toBe('all');

      writeFileSync(join(cwd, 'obsidian-plugin/src/version.ts'), "export const PLUGIN_VERSION = '0.6.0';\n");
      git(cwd, 'rm', '-f', 'obsidian-plugin/src/version.ts');
      const deletion = commit(cwd, 'delete version source');
      expect(selectValidation({ cwd, base: extraCode, head: deletion }).executableGroup).toBe('all');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('normalizes missing and zero event baselines to full validation without blocking nonpublication pushes', () => {
    const cwd = fixture();
    try {
      writeFileSync(join(cwd, 'README.md'), 'base');
      const base = commit(cwd, 'base');
      writeFileSync(join(cwd, 'README.md'), 'tip');
      const head = commit(cwd, 'tip');
      git(cwd, 'branch', 'target', base);
      git(cwd, 'checkout', '-q', 'target');
      writeFileSync(join(cwd, 'target-only.txt'), 'target');
      const target = commit(cwd, 'target');
      git(cwd, 'checkout', '-q', '-');
      expect(normalizeValidationBaseline({ eventName: 'push', before: '', head }, cwd)).toEqual({ base: '', full: true, policyRequired: false });
      expect(normalizeValidationBaseline({ eventName: 'push', before: '0'.repeat(40), head }, cwd)).toEqual({ base: '', full: true, policyRequired: false });
      expect(normalizeValidationBaseline({ eventName: 'push', before: 'missing', head }, cwd)).toEqual({ base: '', full: true, policyRequired: false });
      expect(normalizeValidationBaseline({ eventName: 'push', before: base, head }, cwd)).toEqual({ base, full: false, policyRequired: true });
      expect(normalizeValidationBaseline({ eventName: 'pull_request', pullRequestBase: target, head }, cwd)).toEqual({ base, full: false, policyRequired: true });
      expect(normalizeValidationBaseline({ eventName: 'push', publication: true, releaseBase: '', head }, cwd)).toEqual({ base: '', full: true, policyRequired: true });
      expect(normalizeValidationBaseline({ eventName: 'push', publication: true, releaseBase: base, head }, cwd)).toEqual({ base, full: false, policyRequired: true });
      expect(normalizeValidationBaseline({ eventName: 'push', publication: true, releaseBase: target, head }, cwd)).toEqual({ base: '', full: true, policyRequired: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('resolves canonical refs, requires checked-out HEAD, and conservatively handles histories and path changes', () => {
    const cwd = fixture();
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src/core.ts'), 'core');
      const base = commit(cwd, 'base');
      writeFileSync(join(cwd, 'src/core.ts'), 'changed core');
      const core = commit(cwd, 'core change');
      writeFileSync(join(cwd, 'README.md'), 'tip docs');
      const tip = commit(cwd, 'docs tip');
      expect(selectValidation({ cwd, base: 'HEAD~2', head: 'HEAD' }).executableGroup).toBe('all');
      expect(selectValidation({ cwd, base: 'HEAD^', head: 'HEAD^' }).reason).toContain('not the checked-out HEAD');
      expect(selectValidation({ cwd, base: 'HEAD~2', head: core }).reason).toContain('not the checked-out HEAD');
      expect(selectValidation({ cwd, base: 'bad-ref', head: 'HEAD' }).executableGroup).toBe('all');
      expect(selectValidation({ cwd, base: 'HEAD~2', head: tip }).changedPaths).toEqual(['README.md', 'src/core.ts']);

      git(cwd, 'mv', 'src/core.ts', 'src/renamed.ts');
      const renamed = commit(cwd, 'rename core');
      expect(selectValidation({ cwd, base: tip, head: renamed }).changedPaths).toEqual(['src/core.ts', 'src/renamed.ts']);
      git(cwd, 'rm', 'src/renamed.ts');
      const deleted = commit(cwd, 'delete core');
      expect(selectValidation({ cwd, base: renamed, head: deleted }).changedPaths).toEqual(['src/renamed.ts']);
      expect(selectValidation({ cwd, base: deleted, head: deleted, exactBase: true }).changedPaths).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('selects complete affected formal families only for isolated model/config checks', () => {
    expect(makePlan(['architecture/models/formal/checks-fm004.json']).formalFamilies).toEqual(['deletion']);
    expect(makePlan(['architecture/models/formal/OBTSVaultDeletion.tla']).formalFamilies).toEqual(['deletion']);
    expect(makePlan(['architecture/models/formal/configs/fm004-safety.cfg']).formalFamilies).toEqual(['deletion']);
    expect(makePlan(['architecture/models/formal/OBTSApplyRecovery.cfg']).formalFamilies).toEqual(['sync']);
    expect(makePlan(['architecture/models/formal/OBTSApplyRecoveryLiveness.cfg']).formalFamilies).toEqual(['sync']);
    expect(makePlan(['architecture/models/formal/OBTSVaultSettings.tla']).formalFamilies).toEqual(['vault-settings']);
    for (const extension of ['tla', 'cfg']) {
      const plan = makePlan([`architecture/models/formal/OBTSUploadCheckpointRecovery.${extension}`]);
      expect(plan.formalFamilies).toEqual(['client-state']);
      expect(plan.executableGroup).toBe('fast');
    }
    expect(makePlan(['architecture/models/formal/negative/VaultSettingsStaleSave.cfg']).formalFamilies).toEqual(['vault-settings']);
    expect(makePlan(['architecture/models/formal/modules/OBTSDomain.tla']).executableGroup).toBe('all');
    expect(makePlan(['architecture/models/formal/README.md']).executableGroup).toBe('all');
    expect(makePlan(['architecture/models/formal/checks-fm004.json', 'README.md']).executableGroup).toBe('all');
  });

  it('defines fast, scoped, checker, and integration partitions with safe unknown-test fallback', () => {
    const testFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? testFiles(path) : path.endsWith('.test.ts') ? [path.replace(`${root}/`, '')] : [];
    });
    const files = new Set(testFiles(join(root, 'tests')));
    const groups = [fastTests, pluginTests, dashboardTests, checkerTests];
    for (const group of groups) {
      expect(new Set(group).size).toBe(group.length);
      expect(group.every((path) => files.has(path))).toBe(true);
    }
    expect(new Set([...fastTests, ...pluginTests, ...dashboardTests, ...checkerTests]).size).toBe(fastTests.length + pluginTests.length + dashboardTests.length + checkerTests.length);
    expect([...files].filter((path) => !fastTests.includes(path)).length + fastTests.length).toBe(files.size);
    expect(makePlan(['tests/new-unknown.test.ts']).executableGroup).toBe('all');
    expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toContain("group === 'integration' ? fastTests");
  });

  it('rejects artifact source SHA and byte mismatches', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'obts-artifact-test-'));
    const files = ['dist/src/cli.js', 'dist/src/headless.js', 'obsidian-plugin/main.js', 'obsidian-plugin/manifest.json', 'obsidian-plugin/styles.css'];
    try {
      for (const path of files) {
        mkdirSync(join(cwd, path, '..'), { recursive: true });
        writeFileSync(join(cwd, path), path.endsWith('manifest.json') ? '{"version":"0.3.35"}' : path);
      }
      writeArtifactMetadata('a'.repeat(40), cwd);
      expect(() => verifyArtifactMetadata('b'.repeat(40), cwd)).toThrow(/source SHA/);
      verifyArtifactMetadata('a'.repeat(40), cwd);
      writeFileSync(join(cwd, 'obsidian-plugin/main.js'), 'altered');
      expect(() => verifyArtifactMetadata('a'.repeat(40), cwd)).toThrow(/bytes do not match/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rechecks release versions numerically and rejects superseded candidates', () => {
    expect(needsPluginPublication('0.5.10', '0.5.9')).toBe(true);
    expect(needsPluginPublication('1.0.0', '0.99.99')).toBe(true);
    expect(needsPluginPublication('0.5.10', '0.5.10')).toBe(false);
    expect(() => needsPluginPublication('0.5.10', '0.5.11')).toThrow(/must increase/);
    expect(() => needsPluginPublication('0.5.9', '0.5.10')).toThrow(/must increase/);
    expect(() => needsPluginPublication('invalid', '0.5.10')).toThrow(/valid plugin version/);
  });

  it.each(['main.js', 'manifest.json', 'styles.css'])('rejects an existing version with different published %s bytes', (asset) => {
    const cwd = mkdtempSync(join(tmpdir(), 'obts-published-plugin-'));
    const released = join(cwd, 'released');
    try {
      mkdirSync(join(cwd, 'obsidian-plugin'));
      mkdirSync(released);
      for (const name of ['main.js', 'manifest.json', 'styles.css']) {
        writeFileSync(join(cwd, 'obsidian-plugin', name), name);
        writeFileSync(join(released, name), name);
      }
      verifyPublishedPlugin(released, cwd);
      writeFileSync(join(released, asset), 'different release candidate');
      expect(() => verifyPublishedPlugin(released, cwd)).toThrow(/bump the version/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('requires successful selected jobs and allows skipped jobs only when unselected', () => {
    const base = { executableGroup: 'fast', formalFamilies: [], rustUnitTestsRequired: false, results: { build: 'success', checker: 'success', executable: 'success', formal: 'skipped', rust: 'skipped' } };
    expect(evaluateGate(base).passed).toBe(true);
    expect(evaluateGate({ ...base, executableGroup: 'plugin' }).passed).toBe(true);
    expect(evaluateGate({ ...base, executableGroup: 'dashboard' }).passed).toBe(true);
    for (const failure of ['failure', 'cancelled', 'skipped', undefined]) {
      for (const job of ['build', 'checker', 'executable']) {
        expect(evaluateGate({ ...base, results: { ...base.results, [job]: failure } }).passed).toBe(false);
      }
      expect(evaluateGate({ ...base, formalFamilies: ['sync'], results: { ...base.results, formal: failure } }).passed).toBe(false);
      expect(evaluateGate({ ...base, rustUnitTestsRequired: true, results: { ...base.results, rust: failure } }).passed).toBe(false);
    }
  });

  it('installs shared JavaScript dependencies before Rust conformance tests', () => {
    const workflow = parse(readFileSync(join(root, '.github/workflows/plugin-release.yml'), 'utf8'));
    const steps = workflow.jobs.rust.steps;
    const nodeIndex = steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@'));
    const installIndex = steps.findIndex((step: { run?: string }) => step.run === 'npm ci');
    const cargoIndex = steps.findIndex((step: { run?: string }) => step.run === 'cargo test --workspace --locked');
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(steps[nodeIndex].with['node-version']).toBe('24');
    expect(installIndex).toBeGreaterThan(nodeIndex);
    expect(cargoIndex).toBeGreaterThan(installIndex);
  });

  it('keeps single-coordinator publication behind selected gates and correct artifact paths', () => {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts.test).toContain('test:executable:built');
    expect(scripts.test).not.toContain('test:formal');
    expect(scripts['test:all']).toContain('test:formal');
    expect(scripts['test:plugin-focused']).toContain('VITEST_GROUP=plugin');
    expect(scripts['test:dashboard-focused']).toContain('VITEST_GROUP=dashboard');
    expect(scripts['test:all'].split(' && ').filter((command: string) => command === 'npm run build')).toHaveLength(1);
    const workflow = parse(readFileSync(join(root, '.github/workflows/plugin-release.yml'), 'utf8'));
    const formal = parse(readFileSync(join(root, '.github/workflows/formal-model.yml'), 'utf8'));
    expect(workflow.on.push).toBeDefined();
    expect(workflow.on.pull_request).toBeDefined();
    expect(workflow.on.schedule).toBeDefined();
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.jobs.release.needs).toContain('gate');
    expect(workflow.jobs.release.concurrency).toEqual({ group: 'plugin-publication', 'cancel-in-progress': false });
    const publicationCheck = workflow.jobs.release.steps.find((step: { id?: string }) => step.id === 'version').run;
    expect(publicationCheck).toContain('git merge-base --is-ancestor FETCH_HEAD "$GITHUB_SHA"');
    expect(publicationCheck).toContain('validation-baseline.mjs --publication-needed');
    expect(publicationCheck).toContain('gh release download');
    expect(publicationCheck).toContain('validation-artifact.mjs compare-release');
    const downloads = [workflow.jobs.executable, workflow.jobs.release].flatMap((job: { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }) => job.steps.filter((step) => step.uses?.startsWith('actions/download-artifact@')));
    expect(downloads).toHaveLength(2);
    expect(downloads.every((step: { with?: Record<string, unknown> }) => step.with?.['artifact-ids'] === '${{ needs.build.outputs.artifact_id }}' && step.with?.['merge-multiple'] === true && step.with?.path === '.')).toBe(true);
    expect(workflow.jobs.checker.steps.some((step: { run?: string }) => step.run?.includes('VITEST_GROUP=checker'))).toBe(true);
    expect(workflow.jobs.executable.steps.some((step: { run?: string }) => step.run?.includes('GROUP=ci-all'))).toBe(true);
    expect(workflow.jobs.plan.steps.some((step: { run?: string }) => step.run?.includes('scripts/validation-baseline.mjs'))).toBe(true);
    expect(readFileSync(join(root, 'scripts/validation-baseline.mjs'), 'utf8')).toContain("['merge-base', candidate, head]");
    expect(formal.on.push).toBeUndefined();
    expect(formal.on.workflow_call).toBeDefined();
    expect(workflow.jobs.formal.uses).toContain('formal-model.yml');
    expect(workflow.jobs.gate.needs).toContain('formal');
    expect(workflow.jobs.gate.if).toContain('always()');
    expect(makePlan(['src/server/core.ts', 'README.md']).executableGroup).toBe('all');
  });
});
