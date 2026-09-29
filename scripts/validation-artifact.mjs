import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginFiles = ['obsidian-plugin/main.js', 'obsidian-plugin/manifest.json', 'obsidian-plugin/styles.css'];
const files = ['dist/src/cli.js', 'dist/src/headless.js', ...pluginFiles];

function digest(path, cwd) {
  return createHash('sha256').update(readFileSync(join(cwd, path))).digest('hex');
}

export function verifyPublishedPlugin(releaseDirectory, cwd = process.cwd()) {
  for (const path of pluginFiles) {
    if (digest(path, cwd) !== digest(basename(path), releaseDirectory)) {
      throw new Error(`Plugin version already exists with different ${basename(path)} bytes; bump the version.`);
    }
  }
}

export function writeArtifactMetadata(sourceSha, cwd = process.cwd()) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha ?? '')) throw new Error('A full source commit SHA is required.');
  const manifestSha = digest('obsidian-plugin/manifest.json', cwd);
  const metadata = { sourceSha, manifestSha, files: Object.fromEntries(files.map((path) => [path, digest(path, cwd)])) };
  mkdirSync(join(cwd, 'tmp'), { recursive: true });
  writeFileSync(join(cwd, 'tmp/validation-artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`);
}

export function verifyArtifactMetadata(sourceSha, cwd = process.cwd()) {
  const metadata = JSON.parse(readFileSync(join(cwd, 'tmp/validation-artifact.json'), 'utf8'));
  if (metadata.sourceSha !== sourceSha) throw new Error('Validation artifact source SHA does not match the checked-out commit.');
  if (!metadata.files || Object.keys(metadata.files).sort().join('\0') !== [...files].sort().join('\0')) {
    throw new Error('Validation artifact file inventory is incomplete.');
  }
  if (metadata.manifestSha !== digest('obsidian-plugin/manifest.json', cwd)) throw new Error('Plugin manifest does not match the validated artifact.');
  for (const path of files) {
    if (digest(path, cwd) !== metadata.files[path]) throw new Error(`Validation artifact bytes do not match for ${path}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, sha] = process.argv.slice(2);
  if (mode === 'write') writeArtifactMetadata(sha);
  else if (mode === 'verify') verifyArtifactMetadata(sha);
  else if (mode === 'compare-release') verifyPublishedPlugin(sha);
  else throw new Error('Usage: node scripts/validation-artifact.mjs write|verify SOURCE_SHA or compare-release DIRECTORY');
}
