import { spawnSync } from 'node:child_process';

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function resolveCommit(ref, cwd) {
  if (!ref || /^0+$/.test(ref)) return null;
  const result = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

export function needsPluginPublication(candidate, latest) {
  const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const versions = [candidate, latest].map((version) => {
    const match = typeof version === 'string' && version.match(pattern);
    if (!match) throw new Error('Publication requires valid plugin version tags.');
    return match.slice(1, 4).map(BigInt);
  });
  if (candidate === latest) return false;
  for (let index = 0; index < 3; index += 1) {
    if (versions[0][index] > versions[1][index]) return true;
    if (versions[0][index] < versions[1][index]) break;
  }
  throw new Error('Plugin version must increase beyond the latest published release.');
}

export function normalizeValidationBaseline({ eventName, publication = false, before = '', pullRequestBase = '', releaseBase = '', head: headRef = 'HEAD', full = false }, cwd = process.cwd()) {
  if (full && !publication) return { base: '', full: true, policyRequired: false };
  const head = resolveCommit(headRef, cwd);
  const trustedHead = head && resolveCommit('HEAD', cwd) === head;
  let candidate = publication ? releaseBase : eventName === 'pull_request' ? pullRequestBase : before;
  candidate = resolveCommit(candidate, cwd);
  if (!candidate || !trustedHead) return { base: '', full: true, policyRequired: publication };
  if (eventName === 'pull_request' && !publication) {
    const result = git(['merge-base', candidate, head], cwd);
    candidate = result.status === 0 ? resolveCommit(result.stdout.trim(), cwd) : null;
  }
  const isAncestor = candidate && git(['merge-base', '--is-ancestor', candidate, head], cwd).status === 0;
  if (!isAncestor) return { base: '', full: true, policyRequired: publication };
  return { base: candidate, full, policyRequired: true };
}

if (process.argv[1]?.endsWith('validation-baseline.mjs')) {
  const result = process.argv[2] === '--publication-needed'
    ? needsPluginPublication(process.argv[3], process.argv[4])
    : normalizeValidationBaseline({
    eventName: process.env.EVENT_NAME,
    publication: process.env.PUBLICATION === 'true',
    before: process.env.EVENT_BEFORE,
    pullRequestBase: process.env.EVENT_BASE_SHA,
    releaseBase: process.env.RELEASE_BASE,
    head: process.env.EVENT_HEAD,
    full: process.env.FULL === 'true'
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
