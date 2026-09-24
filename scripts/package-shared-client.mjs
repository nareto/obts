#!/usr/bin/env node

import { copyFile, mkdir } from 'node:fs/promises';

const sourceDirectory = new URL('../obsidian-plugin/src/', import.meta.url);
const destinationDirectory = new URL('../dist/obsidian-plugin/src/', import.meta.url);
await mkdir(destinationDirectory, { recursive: true });
for (const file of ['main.cjs', 'data-adapter-fs.cjs', 'work-pool.cjs']) {
  await copyFile(new URL(file, sourceDirectory), new URL(file, destinationDirectory));
}
const sharedDestination = new URL('../dist/src/shared/', import.meta.url);
await mkdir(sharedDestination, { recursive: true });
await copyFile(new URL('../src/shared/rootIgnore.cjs', import.meta.url), new URL('rootIgnore.cjs', sharedDestination));
