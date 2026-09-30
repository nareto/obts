#!/usr/bin/env node

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const requirePattern = /require\(\s*["']\.\/([A-Za-z0-9._-]+\.cjs)["']\s*\)/gu;

export async function packageSharedClient(sourceRoot, destinationRoot) {
  const sourceDirectory = new URL('../obsidian-plugin/src/', sourceRoot);
  const destinationDirectory = new URL('../dist/obsidian-plugin/src/', destinationRoot);
  await mkdir(destinationDirectory, { recursive: true });
  const pending = ['main.cjs'];
  const packaged = new Set();
  while (pending.length > 0) {
    const file = pending.shift();
    if (packaged.has(file)) continue;
    packaged.add(file);
    const source = await readFile(new URL(file, sourceDirectory), 'utf8');
    for (const match of source.matchAll(requirePattern)) pending.push(match[1]);
    await copyFile(new URL(file, sourceDirectory), new URL(file, destinationDirectory));
  }
  const sharedDestination = new URL('../dist/src/shared/', destinationRoot);
  await mkdir(sharedDestination, { recursive: true });
  await copyFile(new URL('../src/shared/rootIgnore.cjs', sourceRoot), new URL('rootIgnore.cjs', sharedDestination));
  return [...packaged].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageSharedClient(import.meta.url, import.meta.url);
}
