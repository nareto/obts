#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const requested = process.argv[2];
if (!requested) {
  console.error('Usage: just plugin-version <patch|minor|major|VERSION>');
  process.exit(2);
}

const manifestPath = new URL('../obsidian-plugin/manifest.json', import.meta.url);
const versionModulePath = new URL('../obsidian-plugin/src/version.ts', import.meta.url);
const compatibilityPath = new URL('../src/shared/pluginCompatibility.ts', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const current = parseStableVersion(manifest.version);
const version = resolveVersion(requested, current);

manifest.version = version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await replaceVersion(versionModulePath, /PLUGIN_VERSION = '[^']+'/u, `PLUGIN_VERSION = '${version}'`);
await replaceVersion(
  compatibilityPath,
  /RECOMMENDED_PLUGIN_VERSION = '[^']+'/u,
  `RECOMMENDED_PLUGIN_VERSION = '${version}'`
);

const build = spawnSync(process.execPath, ['scripts/build-plugin.mjs'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit'
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
console.log(`Plugin version updated: ${manifest.version}`);

function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (!match) {
    throw new Error(`Automatic bumps require a stable current version, received ${value}. Use an explicit version.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function resolveVersion(value, currentVersion) {
  if (value === 'patch') {
    return `${currentVersion.major}.${currentVersion.minor}.${currentVersion.patch + 1}`;
  }
  if (value === 'minor') {
    return `${currentVersion.major}.${currentVersion.minor + 1}.0`;
  }
  if (value === 'major') {
    return `${currentVersion.major + 1}.0.0`;
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`Invalid plugin version: ${value}`);
  }
  return value;
}

async function replaceVersion(path, pattern, replacement) {
  const source = await readFile(path, 'utf8');
  if (!pattern.test(source)) {
    throw new Error(`Could not update version in ${path.pathname}`);
  }
  await writeFile(path, source.replace(pattern, replacement));
}
