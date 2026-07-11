#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const checkOnly = process.argv.includes('--check');
const manifestPath = new URL('../obsidian-plugin/manifest.json', import.meta.url);
const sourcePath = new URL('../obsidian-plugin/src/main.js', import.meta.url);
const outputPath = new URL('../obsidian-plugin/main.js', import.meta.url);
const apiTypesPath = new URL('../src/shared/types.ts', import.meta.url);
const versionModulePath = new URL('../obsidian-plugin/src/version.ts', import.meta.url);
const compatibilityPath = new URL('../src/shared/pluginCompatibility.ts', import.meta.url);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (typeof manifest.version !== 'string' || !isSemver(manifest.version)) {
  throw new Error('obsidian-plugin/manifest.json must contain a semantic version.');
}

const apiTypes = await readFile(apiTypesPath, 'utf8');
const apiVersion = apiTypes.match(/export const API_VERSION = '([^']+)'/u)?.[1];
if (!apiVersion) {
  throw new Error('Could not read API_VERSION from src/shared/types.ts.');
}

const versionModule = await readFile(versionModulePath, 'utf8');
const sourceVersion = versionModule.match(/PLUGIN_VERSION = '([^']+)'/u)?.[1];
if (sourceVersion !== manifest.version) {
  throw new Error(`Plugin version mismatch: manifest=${manifest.version}, source=${sourceVersion ?? 'missing'}.`);
}

const compatibility = await readFile(compatibilityPath, 'utf8');
const recommendedVersion = compatibility.match(/RECOMMENDED_PLUGIN_VERSION = '([^']+)'/u)?.[1];
if (recommendedVersion !== manifest.version) {
  throw new Error(`Plugin version mismatch: manifest=${manifest.version}, recommended=${recommendedVersion ?? 'missing'}.`);
}

const source = await readFile(sourcePath, 'utf8');
const pluginPlaceholder = '__OBTS_PLUGIN_VERSION__';
const apiPlaceholder = '__OBTS_API_VERSION__';
if (count(source, pluginPlaceholder) !== 1 || count(source, apiPlaceholder) !== 1) {
  throw new Error('Plugin source must contain exactly one plugin-version and API-version placeholder.');
}
const built = source.replace(pluginPlaceholder, manifest.version).replace(apiPlaceholder, apiVersion);

if (checkOnly) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== built) {
    console.error('obsidian-plugin/main.js is stale; run npm run build:plugin.');
    process.exit(1);
  }
} else {
  await writeFile(outputPath, built);
}

function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function count(value, needle) {
  return value.split(needle).length - 1;
}
