export const MINIMUM_PLUGIN_VERSION = '0.2.0';
// Updated by scripts/plugin-version.mjs after a release version is selected.
export const RECOMMENDED_PLUGIN_VERSION = '0.3.1';
export const PLUGIN_UPDATE_URL = 'obsidian://brat?plugin=nareto%2Fobts';
export const LEGACY_PLUGIN_VERSION = '0.1.17-phase3';

export type PluginCompatibility = {
  current_version: string;
  minimum_version: string;
  recommended_version: string;
  update_required: boolean;
  update_available: boolean;
  update_url: string;
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

export function describePluginCompatibility(version: string): PluginCompatibility {
  const current = parseVersion(version);
  const minimum = parseVersion(MINIMUM_PLUGIN_VERSION);
  const recommended = parseVersion(RECOMMENDED_PLUGIN_VERSION);
  const updateRequired = current === null || minimum === null || compareVersions(current, minimum) < 0;
  const updateAvailable = updateRequired || current === null || recommended === null || compareVersions(current, recommended) < 0;
  return {
    current_version: version,
    minimum_version: MINIMUM_PLUGIN_VERSION,
    recommended_version: RECOMMENDED_PLUGIN_VERSION,
    update_required: updateRequired,
    update_available: updateAvailable,
    update_url: PLUGIN_UPDATE_URL
  };
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? []
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}
