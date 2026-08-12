import { execFileSync, spawnSync } from 'node:child_process';

const ZERO_OID = /^0+$/u;

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

function gitResult(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function commitExists(value) {
  if (!value || ZERO_OID.test(value)) return false;
  return gitResult(['cat-file', '-e', `${value}^{commit}`]).status === 0;
}

function mergeBase(left, right) {
  const result = gitResult(['merge-base', left, right]);
  return result.status === 0 ? result.stdout.trim() : '';
}

function resolveBase(requestedBase, head, mode, targetRef) {
  if (mode === 'update') {
    if (!requestedBase || ZERO_OID.test(requestedBase)) {
      throw new Error('an existing-ref update requires the exact previous remote commit');
    }
    if (!commitExists(requestedBase)) {
      throw new Error(`previous remote commit is unavailable locally: ${requestedBase}`);
    }
    return requestedBase;
  }
  if (mode !== 'create') throw new Error(`mode must be update or create, found: ${mode}`);
  if (targetRef === 'refs/heads/main') return '';

  for (const candidate of ['refs/remotes/origin/main', 'refs/heads/main']) {
    if (!commitExists(candidate)) continue;
    const base = mergeBase(head, candidate);
    if (base) return base;
  }
  return '';
}

function authoritativeArchitecturePath(path) {
  return path === 'architecture/README.md'
    || path === 'architecture/workspace.dsl'
    || path === 'openapi/openapi.yaml'
    || path.startsWith('architecture/contracts/')
    || path.startsWith('architecture/models/')
    || path.startsWith('architecture/adrs/')
    || path.startsWith('architecture/migrations/');
}

function codeBearingPath(path) {
  return path === 'Dockerfile'
    || path === '.dockerignore'
    || path === 'Justfile'
    || path === 'package.json'
    || path === 'package-lock.json'
    || path === 'Cargo.toml'
    || path === 'Cargo.lock'
    || path === 'tsconfig.json'
    || path === 'vitest.config.ts'
    || path.startsWith('src/')
    || path.startsWith('tests/')
    || path.startsWith('scripts/')
    || path.startsWith('frontend/')
    || path.startsWith('obsidian-plugin/')
    || path.startsWith('crates/')
    || path.startsWith('architecture/tools/')
    || path.startsWith('.githooks/')
    || path.startsWith('.forgejo/')
    || path.startsWith('.github/');
}

function manifestAt(commit) {
  if (!commit) return { present: false, revision: 0 };
  const exists = gitResult(['cat-file', '-e', `${commit}:architecture/manifest.yaml`]);
  if (exists.status !== 0) return { present: false, revision: 0 };
  const manifest = git(['show', `${commit}:architecture/manifest.yaml`]);
  const matches = [...manifest.matchAll(/^revision:\s*(\d+)\s*$/gmu)];
  if (matches.length !== 1) {
    throw new Error(`${commit.slice(0, 12)} has a malformed architecture revision`);
  }
  return { present: true, revision: Number(matches[0][1]) };
}

function commitsInRange(base, head) {
  const range = base ? `${base}..${head}` : head;
  return git(['rev-list', '--reverse', '--topo-order', range]).split('\n').filter(Boolean);
}

function parents(commit) {
  return git(['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
}

function changedPathsBetween(base, head) {
  const output = base
    ? git(['diff', '--no-renames', '--name-only', `${base}..${head}`])
    : git(['diff-tree', '--root', '--no-renames', '--no-commit-id', '--name-only', '-r', head]);
  return output.split('\n').filter(Boolean);
}

function commitLocalPaths(commit) {
  const commitParents = parents(commit);
  if (commitParents.length <= 1) return changedPathsBetween(commitParents[0] ?? '', commit);
  const output = git(['diff-tree', '--cc', '--no-renames', '--no-commit-id', '--name-only', '-r', commit]);
  return output.split('\n').filter(Boolean);
}

function combinesDifferentArchitectureParents(commit) {
  const commitParents = parents(commit);
  if (commitParents.length < 2) return false;
  const commonBase = mergeBase(commitParents[0], commitParents[1]);
  if (!commonBase) return true;
  const architectureChanges = commitParents.map((parent) => {
    return changedPathsBetween(commonBase, parent).filter(authoritativeArchitecturePath);
  });
  if (architectureChanges.some((paths) => paths.length === 0)) return false;
  const treeIds = commitParents.map((parent) => git(['rev-parse', `${parent}^{tree}`]));
  return new Set(treeIds).size > 1;
}

function hasNoImpactTrailer(commit) {
  const output = git(['show', '-s', '--format=%(trailers:key=Architecture-Impact,valueonly,separator=%x00)', commit]);
  const values = output.split('\0').map((value) => value.trim()).filter(Boolean);
  return values.length === 1 && values[0] === 'none';
}

function parentRevisionFor(commit) {
  const revisions = parents(commit).map((parent) => manifestAt(parent).revision);
  return revisions.length === 0 ? 0 : Math.max(...revisions);
}

function fail(message) {
  console.error(`Architecture synchronization check failed: ${message}`);
  process.exitCode = 1;
}

try {
  const requestedBase = process.argv[2] ?? '';
  const head = process.argv[3] ?? 'HEAD';
  const mode = process.argv[4] ?? (ZERO_OID.test(requestedBase) ? 'create' : 'update');
  const targetRef = process.argv[5] ?? '';
  if (!commitExists(head)) throw new Error(`head commit is unavailable locally: ${head}`);
  const base = resolveBase(requestedBase, head, mode, targetRef);

  for (const commit of commitsInRange(base, head)) {
    const paths = commitLocalPaths(commit);
    const architectureChanged = paths.some(authoritativeArchitecturePath) || combinesDifferentArchitectureParents(commit);
    const manifestChanged = paths.includes('architecture/manifest.yaml');
    const codeChanged = paths.some(codeBearingPath);

    if (architectureChanged) {
      if (!manifestChanged) {
        fail(`${commit.slice(0, 12)} changes authoritative architecture without updating architecture/manifest.yaml`);
      } else {
        const next = manifestAt(commit);
        const previousRevision = parentRevisionFor(commit);
        if (!next.present || next.revision !== previousRevision + 1) {
          fail(`${commit.slice(0, 12)} must increment architecture revision exactly once (${previousRevision} -> ${previousRevision + 1}, found ${next.present ? next.revision : 'absent'})`);
        }
      }
    } else if (manifestChanged) {
      fail(`${commit.slice(0, 12)} changes architecture revision without an authoritative architecture change`);
    }

    if (codeChanged && !architectureChanged && !hasNoImpactTrailer(commit)) {
      fail(`${commit.slice(0, 12)} changes code without authoritative architecture updates or one exact Architecture-Impact: none trailer`);
    }
  }

  if (mode === 'update') {
    const previous = manifestAt(base);
    const current = manifestAt(head);
    if (previous.present && (!current.present || current.revision < previous.revision)) {
      fail(`force-push architecture revision regression (${previous.revision} -> ${current.present ? current.revision : 'absent'})`);
    }
    const architectureDiffers = changedPathsBetween(base, head).some(authoritativeArchitecturePath);
    if (architectureDiffers && previous.present && (!current.present || current.revision <= previous.revision)) {
      fail(`authoritative architecture differs from the previous remote tip without a newer revision than ${previous.revision}`);
    }
  }

  if (!process.exitCode) {
    console.log(`Architecture synchronization check passed for ${base ? `${base.slice(0, 12)}..` : ''}${git(['rev-parse', head]).slice(0, 12)}.`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
