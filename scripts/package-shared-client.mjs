#!/usr/bin/env node

import { copyFile, mkdir } from 'node:fs/promises';

const sourceDirectory = new URL('../obsidian-plugin/src/', import.meta.url);
const destinationDirectory = new URL('../dist/obsidian-plugin/src/', import.meta.url);
await mkdir(destinationDirectory, { recursive: true });
for (const file of ['main.cjs', 'data-adapter-fs.cjs']) {
  await copyFile(new URL(file, sourceDirectory), new URL(file, destinationDirectory));
}
