#!/usr/bin/env node

import { builtinModules } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { build } from 'esbuild';

const checkOnly = process.argv.includes('--check');
const manifestPath = new URL('../obsidian-plugin/manifest.json', import.meta.url);
const sourcePath = new URL('../obsidian-plugin/src/main.cjs', import.meta.url);
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
const versionedSource = source.replace(pluginPlaceholder, manifest.version).replace(apiPlaceholder, apiVersion);
const bundled = await bundlePlugin(versionedSource);
assertMobileSafeBundle(bundled.code, bundled.metafile);

if (checkOnly) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== bundled.code) {
    console.error('obsidian-plugin/main.js is stale; run npm run build:plugin.');
    process.exit(1);
  }
} else {
  await writeFile(outputPath, bundled.code);
}

async function bundlePlugin(contents) {
  const forbidden = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const result = await build({
    stdin: {
      contents,
      loader: 'js',
      resolveDir: new URL('../obsidian-plugin/src/', import.meta.url).pathname,
      sourcefile: 'main.js'
    },
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: ['es2020'],
    banner: { js: 'var __obtsCwd = () => "/";' },
    define: { 'process.cwd': '__obtsCwd' },
    external: ['obsidian'],
    metafile: true,
    write: false,
    legalComments: 'none',
    plugins: [{
      name: 'reject-node-builtins',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /.*/ }, (args) => {
          if (args.path !== 'buffer' && forbidden.has(args.path)) {
            return { errors: [{ text: `Mobile plugin cannot import Node builtin: ${args.path}` }] };
          }
          return undefined;
        });
      }
    }]
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error('Plugin bundler produced no JavaScript output.');
  return { code: output, metafile: result.metafile };
}

function assertMobileSafeBundle(code, metafile) {
  const externalInputs = Object.entries(metafile.inputs)
    .flatMap(([, input]) => input.imports)
    .filter((entry) => entry.external)
    .map((entry) => entry.path);
  const unexpected = [...new Set(externalInputs.filter((entry) => entry !== 'obsidian'))];
  if (unexpected.length) {
    throw new Error(`Plugin bundle has unexpected external imports: ${unexpected.join(', ')}`);
  }
  for (const forbidden of ['node:child_process', 'node:fs', 'node:crypto', 'node:path', 'requireDesktopVaultPath', 'process.cwd(', 'spawn(']) {
    if (code.includes(forbidden)) {
      throw new Error(`Plugin bundle contains desktop-only runtime marker: ${forbidden}`);
    }
  }
}

function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

function count(value, needle) {
  return value.split(needle).length - 1;
}
