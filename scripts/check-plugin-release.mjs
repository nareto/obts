#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const [base, target = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('Usage: node scripts/check-plugin-release.mjs BASE [TARGET]');
  process.exit(2);
}

const zero = /^0+$/u.test(base);
const changed = zero ? [] : git(['diff', '--name-only', base, target]).split('\n').filter(Boolean);
const pluginChanged = changed.some(isPluginImpactPath);
if (pluginChanged) {
  const previousVersion = readManifestVersion(base);
  const nextVersion = readManifestVersion(target);
  if (previousVersion === nextVersion || compareSemver(nextVersion, previousVersion) <= 0) {
    console.error(`Plugin-impacting files changed without a version increase (${previousVersion} -> ${nextVersion}).`);
    console.error('Run: just plugin-version <patch|minor|major|VERSION>');
    process.exit(1);
  }
}

execFileSync(process.execPath, ['scripts/build-plugin.mjs', '--check'], { stdio: 'inherit' });

function isPluginImpactPath(path) {
  return (
    path.startsWith('obsidian-plugin/src/') ||
    path === 'obsidian-plugin/manifest.json' ||
    path === 'obsidian-plugin/styles.css' ||
    path === 'obsidian-plugin/main.js' ||
    path.startsWith('src/shared/') ||
    path === 'scripts/build-plugin.mjs'
  );
}

function readManifestVersion(ref) {
  const manifest = JSON.parse(git(['show', `${ref}:obsidian-plugin/manifest.json`]));
  if (typeof manifest.version !== 'string') {
    throw new Error(`Plugin manifest at ${ref} has no version.`);
  }
  return manifest.version;
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function parseSemver(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u.exec(value);
  if (!match) {
    throw new Error(`Invalid semantic version: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}
