import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formalFamilies } from './validation-groups.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fastDocs = /^(?:README\.md|docs\/[^/]+\.md)$/;
const dashboardStyles = /^frontend\/dashboard\/src\/.*\.(?:css|scss)$/;
const pluginOnly = /^(?:obsidian-plugin\/main\.js|obsidian-plugin\/styles\.css)$/;
const releaseMetadataPaths = new Set(['src/shared/pluginCompatibility.ts', 'obsidian-plugin/src/version.ts', 'obsidian-plugin/manifest.json']);
const formalPaths = new Map([
  ['sync', /^(?:architecture\/models\/formal\/(?:OBTSApplyRecovery(?:\.tla)?|OBTSDistributedSync(?:\.tla)?|checks\.json|configs\/(?!fm00[3456]-)|negative\/|trace\/transition-map\.json|modules\/OBTS(?:ApplyRefinement|Domain|Safety)|OBTSApplyRecovery(?:Liveness)?\.cfg))$/],
  ['bridge-body', /^(?:architecture\/models\/formal\/(?:OBTSBridge(?:BoundedBody|ReadAvailability)(?:\.tla)?|checks-fm(?:003|010)\.json|fm(?:003|010)-.*|configs\/fm003-.*|trace\/fm003-trace-map\.json))$/],
  ['workers', /^(?:architecture\/models\/formal\/(?:OBTSBridgeEmbeddingWorker(?:\.tla)?|checks-fm003-workers\.json|worker-configs\/.*|trace\/fm003-worker.*))$/],
  ['deletion', /^(?:architecture\/models\/formal\/(?:OBTSVaultDeletion(?:\.tla)?|checks-fm004\.json|configs\/fm004-.*))$/],
  ['bridge-protocol', /^(?:architecture\/models\/formal\/(?:OBTSBridgeExternalProtocol(?:\.tla)?|checks-fm005\.json|fm005-.*))$/],
  ['onboarding', /^(?:architecture\/models\/formal\/(?:OBTSOnboarding(?:Recovery)?(?:\.tla)?|checks-fm006\.json|configs\/fm006-.*))$/],
  ['diagnostics', /^(?:architecture\/models\/formal\/OBTSDiagnosticAdmission\.tla)$/],
  ['client-state', /^(?:architecture\/models\/formal\/(?:OBTSClientStateRecovery\.tla|OBTSUploadCheckpointRecovery\.(?:tla|cfg)))$/],
  ['vault-settings', /^(?:architecture\/models\/formal\/(?:OBTSVaultSettings(?:\.tla|\.cfg)?|VaultSettings(?:AutoMerge|ConflictFallback|DeleteLocal|RecomputeMerge|StaleSave)\.cfg|negative\/VaultSettings.*\.cfg))$/],
  ['headless-ownership', /^(?:architecture\/models\/formal\/OBTSManagedHeadlessOwnership\.(?:tla|cfg))$/],
  ['atomic-rename', /^(?:architecture\/models\/formal\/(?:OBTSAtomicRename\.(?:tla|cfg)|configs\/fm014-atomic-rename\.cfg))$/]
]);
function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
}

function canonicalCommit(ref, cwd) {
  if (!ref || /^0+$/.test(ref)) return null;
  const result = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd);
  if (result.status !== 0) return null;
  const sha = result.stdout.toString('utf8').trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

function showFile(ref, path, cwd) {
  const result = git(['show', `${ref}:${path}`], cwd);
  return result.status === 0 ? result.stdout.toString('utf8') : null;
}

function isVersionLiteralChange(path, oldText, newText) {
  if (oldText === null || newText === null) return false;
  if (path === 'obsidian-plugin/manifest.json') {
    try {
      const oldManifest = JSON.parse(oldText);
      const newManifest = JSON.parse(newText);
      if (typeof oldManifest.version !== 'string' || typeof newManifest.version !== 'string') return false;
      delete oldManifest.version;
      delete newManifest.version;
      return JSON.stringify(oldManifest) === JSON.stringify(newManifest);
    } catch {
      return false;
    }
  }
  const identifier = path === 'src/shared/pluginCompatibility.ts' ? 'RECOMMENDED_PLUGIN_VERSION' : 'PLUGIN_VERSION';
  const expression = new RegExp(`(^\\s*export const ${identifier} = ')[^']+(';$)`, 'm');
  const oldMatch = oldText.match(expression);
  const newMatch = newText.match(expression);
  return Boolean(oldMatch && newMatch && oldText.replace(expression, '$1__VERSION__$2') === newText.replace(expression, '$1__VERSION__$2'));
}

function classify(paths, { full = false, reason = '', versionsTrusted = false } = {}) {
  let executableGroup = 'fast';
  let selectedFormal = [];
  let rustTests = false;
  let why = reason;
  if (full) {
    executableGroup = 'all'; selectedFormal = [...formalFamilies]; rustTests = true;
    why ||= 'full validation requested or impact could not be safely bounded';
  } else if (paths.length === 0) {
    why ||= 'empty trusted commit range';
  } else if (paths.every((path) => fastDocs.test(path))) {
    why ||= 'allowlisted presentation/documentation-only changes';
  } else {
    const pluginOnlyChange = paths.every((path) => fastDocs.test(path) || pluginOnly.test(path) || (versionsTrusted && releaseMetadataPaths.has(path)));
    const formalOnlyPaths = paths.filter((path) => path.startsWith('architecture/models/formal/'));
    const matches = new Set();
    let safeFormalOnly = formalOnlyPaths.length > 0;
    for (const path of formalOnlyPaths) {
      const found = formalFamilies.filter((family) => formalPaths.get(family)?.test(path));
      if (found.length !== 1) safeFormalOnly = false;
      found.forEach((family) => matches.add(family));
      if (/README\.md|modules\/|trace\/|checks\.json$/.test(path)) safeFormalOnly = false;
    }
    if (pluginOnlyChange) {
      executableGroup = 'plugin';
      why ||= 'plugin styles, generated output, or verified release-version metadata';
    } else if (paths.every((path) => fastDocs.test(path) || dashboardStyles.test(path))) {
      executableGroup = 'dashboard';
      why ||= 'isolated dashboard styles';
    } else if (safeFormalOnly && paths.every((path) => formalOnlyPaths.includes(path))) {
      selectedFormal = [...matches];
      why ||= 'isolated formal model/check files';
    } else {
      executableGroup = 'all'; selectedFormal = [...formalFamilies]; rustTests = true;
      why ||= 'safety, shared tooling, or unknown-impact change';
    }
  }
  return { reason: why, executableGroup, formalFamilies: selectedFormal, rustUnitTestsRequired: rustTests };
}

export function makePlan(paths, { full = false, reason = '' } = {}) {
  return classify(paths, { full, reason });
}

export function selectValidation({ base, head, full = false, exactBase = false, cwd = root } = {}) {
  if (full) return { changedPaths: [], ...classify([], { full: true, reason: 'explicit full override' }) };
  const checkoutRoot = resolve(cwd);
  const rootResult = git(['rev-parse', '--show-toplevel'], checkoutRoot);
  if (rootResult.status !== 0 || resolve(rootResult.stdout.toString().trim()) !== checkoutRoot) {
    return { changedPaths: [], ...classify([], { full: true, reason: 'checkout identity unavailable' }) };
  }
  const canonicalHead = canonicalCommit(head, checkoutRoot);
  const checkedOutHead = canonicalCommit('HEAD', checkoutRoot);
  const canonicalBase = canonicalCommit(base, checkoutRoot);
  if (!canonicalHead || canonicalHead !== checkedOutHead || !canonicalBase) {
    return { changedPaths: [], ...classify([], { full: true, reason: 'base or head is missing, zero, unavailable, or not the checked-out HEAD' }) };
  }
  let diffBase = canonicalBase;
  if (exactBase) {
    const ancestor = git(['merge-base', '--is-ancestor', canonicalBase, canonicalHead], checkoutRoot);
    if (ancestor.status !== 0) return { changedPaths: [], ...classify([], { full: true, reason: 'exact base is not an ancestor of head' }) };
  } else {
    const mergeBase = git(['merge-base', canonicalBase, canonicalHead], checkoutRoot);
    if (mergeBase.status !== 0) return { changedPaths: [], ...classify([], { full: true, reason: 'commit range is unrelated or unavailable' }) };
    diffBase = mergeBase.stdout.toString('utf8').trim();
    if (!/^[0-9a-f]{40}$/i.test(diffBase)) return { changedPaths: [], ...classify([], { full: true, reason: 'merge base is unavailable' }) };
  }
  const diff = git(['diff', '--name-only', '-z', '--no-renames', diffBase, canonicalHead, '--'], checkoutRoot);
  if (diff.status !== 0) return { changedPaths: [], ...classify([], { full: true, reason: 'diff unavailable' }) };
  const changedPaths = diff.stdout.toString('utf8').split('\0').filter(Boolean);
  const metadataPaths = changedPaths.filter((path) => releaseMetadataPaths.has(path));
  const versionsTrusted = metadataPaths.length > 0 && metadataPaths.every((path) => isVersionLiteralChange(path, showFile(diffBase, path, checkoutRoot), showFile(canonicalHead, path, checkoutRoot)));
  return { changedPaths, ...classify(changedPaths, { versionsTrusted }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  process.stdout.write(`${JSON.stringify(selectValidation({ base: value('--base'), head: value('--head'), full: args.includes('--full'), exactBase: args.includes('--exact-base') }), null, 2)}\n`);
}
