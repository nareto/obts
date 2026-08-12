import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const checker = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-architecture-impact.mjs');

type Repository = { repo: string; base: string };

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo: string, path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function createRepository(): Repository {
  const repo = mkdtempSync(join(tmpdir(), 'obts-architecture-impact-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Architecture Test']);
  git(repo, ['config', 'user.email', 'architecture-test@example.invalid']);
  write(repo, 'architecture/manifest.yaml', 'schema_version: 1\nrevision: 1\n');
  write(repo, 'architecture/contracts/safety.md', '# Safety\n');
  write(repo, 'src/example.ts', 'export const value = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'baseline']);
  return { repo, base: git(repo, ['rev-parse', 'HEAD']) };
}

function commit(repo: string, subject: string, body?: string): string {
  git(repo, ['add', '-A']);
  const args = ['commit', '-q', '-m', subject];
  if (body) args.push('-m', body);
  git(repo, args);
  return git(repo, ['rev-parse', 'HEAD']);
}

function check(repo: string, base: string, head: string, mode = 'update', targetRef = 'refs/heads/topic') {
  return spawnSync(process.execPath, [checker, base, head, mode, targetRef], { cwd: repo, encoding: 'utf8' });
}

function expectPass(result: ReturnType<typeof check>) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('check passed');
}

function expectFailure(result: ReturnType<typeof check>, text: string) {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(text);
}

function changeArchitecture(repo: string, revision: number, suffix: string) {
  write(repo, 'architecture/contracts/safety.md', `# Safety ${suffix}\n`);
  write(repo, 'architecture/manifest.yaml', `schema_version: 1\nrevision: ${revision}\n`);
}

describe('architecture impact acknowledgement', () => {
  it('rejects a code commit without architecture changes or the exact trailer', () => {
    const { repo, base } = createRepository();
    write(repo, 'src/example.ts', 'export const value = 2;\n');
    const head = commit(repo, 'change code');

    expectFailure(check(repo, base, head), 'Architecture-Impact: none');
  });

  it('accepts a code commit with one exact no-impact trailer', () => {
    const { repo, base } = createRepository();
    write(repo, 'src/example.ts', 'export const value = 2;\n');
    const head = commit(repo, 'refactor code', 'Architecture-Impact: none');

    expectPass(check(repo, base, head));
  });

  it('does not accept trailer text embedded in prose or duplicate trailers', () => {
    const prose = createRepository();
    write(prose.repo, 'src/example.ts', 'export const value = 2;\n');
    const proseHead = commit(prose.repo, 'change code', 'The string Architecture-Impact: none appears in prose.');
    expectFailure(check(prose.repo, prose.base, proseHead), 'Architecture-Impact: none');

    const duplicate = createRepository();
    write(duplicate.repo, 'src/example.ts', 'export const value = 2;\n');
    const duplicateHead = commit(duplicate.repo, 'change code', 'Architecture-Impact: none\nArchitecture-Impact: none');
    expectFailure(check(duplicate.repo, duplicate.base, duplicateHead), 'Architecture-Impact: none');
  });

  it('rejects architecture changes without exactly one revision increment', () => {
    const missing = createRepository();
    write(missing.repo, 'architecture/contracts/safety.md', '# Stronger safety\n');
    const missingHead = commit(missing.repo, 'change architecture');
    expectFailure(check(missing.repo, missing.base, missingHead), 'architecture/manifest.yaml');

    const skipped = createRepository();
    changeArchitecture(skipped.repo, 3, 'skipped');
    const skippedHead = commit(skipped.repo, 'skip revision');
    expectFailure(check(skipped.repo, skipped.base, skippedHead), 'must increment');
  });

  it('accepts an architecture change with one revision increment', () => {
    const { repo, base } = createRepository();
    changeArchitecture(repo, 2, 'updated');
    const head = commit(repo, 'change architecture');

    expectPass(check(repo, base, head));
  });

  it('checks every commit in a multi-commit push independently', () => {
    const { repo, base } = createRepository();
    write(repo, 'src/example.ts', 'export const value = 2;\n');
    commit(repo, 'unacknowledged code');
    write(repo, 'README.md', '# Docs\n');
    const head = commit(repo, 'later docs');

    expectFailure(check(repo, base, head), 'Architecture-Impact: none');
  });

  it('fails closed when an existing-ref base is missing', () => {
    const { repo } = createRepository();
    const head = git(repo, ['rev-parse', 'HEAD']);

    expectFailure(check(repo, '1111111111111111111111111111111111111111', head), 'unavailable locally');
  });

  it('allows an empty topic branch at main and scans complete orphan history', () => {
    const normal = createRepository();
    expectPass(check(normal.repo, '0000000000000000000000000000000000000000', normal.base, 'create'));

    const orphan = createRepository();
    git(orphan.repo, ['checkout', '--orphan', 'orphan']);
    git(orphan.repo, ['rm', '-q', '-rf', '.']);
    write(orphan.repo, 'architecture/manifest.yaml', 'schema_version: 1\nrevision: 1\n');
    write(orphan.repo, 'architecture/contracts/safety.md', '# Orphan safety\n');
    const head = commit(orphan.repo, 'orphan architecture');
    expectPass(check(orphan.repo, '0000000000000000000000000000000000000000', head, 'create'));
  });

  it('scans complete history when bootstrapping main', () => {
    const conforming = createRepository();
    expectPass(check(conforming.repo, '0000000000000000000000000000000000000000', conforming.base, 'create', 'refs/heads/main'));

    const repo = mkdtempSync(join(tmpdir(), 'obts-architecture-bootstrap-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Architecture Test']);
    git(repo, ['config', 'user.email', 'architecture-test@example.invalid']);
    write(repo, 'src/example.ts', 'export const value = 1;\n');
    const head = commit(repo, 'code-only initial history');
    expectFailure(check(repo, '0000000000000000000000000000000000000000', head, 'create', 'refs/heads/main'), 'Architecture-Impact: none');
  });

  it('accepts a clean merge that carries already-validated architecture revisions', () => {
    const { repo, base } = createRepository();
    git(repo, ['checkout', '-q', '-b', 'architecture-work']);
    changeArchitecture(repo, 2, 'revision two');
    commit(repo, 'architecture revision two');
    changeArchitecture(repo, 3, 'revision three');
    commit(repo, 'architecture revision three');
    git(repo, ['checkout', '-q', 'main']);
    write(repo, 'README.md', '# Main docs\n');
    commit(repo, 'main docs');
    git(repo, ['merge', '-q', '--no-ff', 'architecture-work', '-m', 'merge architecture']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    expectPass(check(repo, base, head));
  });

  it('requires a new revision when merging divergent architecture parents', () => {
    const { repo, base } = createRepository();
    git(repo, ['checkout', '-q', '-b', 'left']);
    changeArchitecture(repo, 2, 'left');
    commit(repo, 'left architecture revision two');
    git(repo, ['checkout', '-q', '-b', 'right', base]);
    write(repo, 'architecture/contracts/product.md', '# Right product\n');
    write(repo, 'architecture/manifest.yaml', 'schema_version: 1\nrevision: 2\n');
    commit(repo, 'right architecture revision two');
    git(repo, ['merge', '-q', '--no-ff', 'left', '-m', 'merge divergent architecture']);
    let head = git(repo, ['rev-parse', 'HEAD']);
    expectFailure(check(repo, base, head), 'architecture/manifest.yaml');

    write(repo, 'architecture/manifest.yaml', 'schema_version: 1\nrevision: 3\n');
    git(repo, ['add', 'architecture/manifest.yaml']);
    git(repo, ['commit', '-q', '--amend', '--no-edit']);
    head = git(repo, ['rev-parse', 'HEAD']);
    expectPass(check(repo, base, head));
  });

  it('requires reconciliation when an ours merge discards divergent architecture', () => {
    const { repo, base } = createRepository();
    git(repo, ['checkout', '-q', '-b', 'left']);
    changeArchitecture(repo, 2, 'left');
    commit(repo, 'left architecture revision two');
    git(repo, ['checkout', '-q', '-b', 'right', base]);
    write(repo, 'architecture/contracts/product.md', '# Right product\n');
    write(repo, 'architecture/manifest.yaml', 'schema_version: 1\nrevision: 2\n');
    commit(repo, 'right architecture revision two');
    git(repo, ['merge', '-q', '-s', 'ours', '--no-ff', 'left', '-m', 'discard left architecture']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    expectFailure(check(repo, base, head), 'architecture/manifest.yaml');
  });

  it('rejects force-push revision regression and same-revision architecture replacement', () => {
    const regression = createRepository();
    changeArchitecture(regression.repo, 2, 'remote two');
    const remote = commit(regression.repo, 'remote revision two');
    git(regression.repo, ['reset', '-q', '--hard', regression.base]);
    write(regression.repo, 'README.md', '# Replacement history\n');
    const replacement = commit(regression.repo, 'replace history');
    expectFailure(check(regression.repo, remote, replacement), 'revision regression');

    const same = createRepository();
    changeArchitecture(same.repo, 2, 'remote two');
    const sameRemote = commit(same.repo, 'remote revision two');
    git(same.repo, ['reset', '-q', '--hard', same.base]);
    changeArchitecture(same.repo, 2, 'different revision two');
    const sameReplacement = commit(same.repo, 'different revision two');
    expectFailure(check(same.repo, sameRemote, sameReplacement), 'without a newer revision');
  });

  it('rejects malformed existing manifests instead of treating them as absent', () => {
    const { repo, base } = createRepository();
    write(repo, 'architecture/manifest.yaml', 'schema_version: 1\nrevision: wrong\n');
    write(repo, 'architecture/contracts/safety.md', '# Broken manifest\n');
    const head = commit(repo, 'break manifest');

    expectFailure(check(repo, base, head), 'malformed architecture revision');
  });

  it('classifies source renames and embedded migration/config/build inputs as code', () => {
    const renamed = createRepository();
    mkdirSync(join(renamed.repo, 'notes'));
    git(renamed.repo, ['mv', 'src/example.ts', 'notes/example.ts']);
    const renamedHead = commit(renamed.repo, 'rename code out of source root');
    expectFailure(check(renamed.repo, renamed.base, renamedHead), 'Architecture-Impact: none');

    for (const path of [
      'crates/obts-bridge/migrations/0002.sql',
      'crates/obts-bridge/config/mcp_tools.yaml',
      'crates/obts-bridge/Cargo.toml',
      'crates/obts-bridge/Dockerfile',
      'frontend/dashboard/index.html',
      'frontend/dashboard/vite.config.ts'
    ]) {
      const fixture = createRepository();
      write(fixture.repo, path, 'changed\n');
      const head = commit(fixture.repo, `change ${path}`);
      expectFailure(check(fixture.repo, fixture.base, head), 'Architecture-Impact: none');
    }
  });
});
