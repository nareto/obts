import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { packageSharedClient } from '../scripts/package-shared-client.mjs';

const siblingPattern = /require\(\s*["']\.\/([A-Za-z0-9._-]+\.cjs)["']\s*\)/gu;
const scriptUrl = pathToFileURL(join(process.cwd(), 'scripts', 'package-shared-client.mjs'));

describe('packaged shared client', () => {
  it('ships every sibling module the headless client requires', async () => {
    const destination = await mkdtemp(join(tmpdir(), 'obts-package-'));
    try {
      const packaged = await packageSharedClient(scriptUrl, pathToFileURL(join(destination, 'scripts', 'package-shared-client.mjs')));
      const pluginDirectory = join(destination, 'dist', 'obsidian-plugin', 'src');

      expect(packaged).toContain('main.cjs');
      expect(packaged).toContain('blob-size-reader.cjs');
      expect(await readFile(join(destination, 'dist', 'src', 'shared', 'rootIgnore.cjs'), 'utf8')).not.toBe('');

      const present = await readdir(pluginDirectory);
      const source = await readFile('obsidian-plugin/src/main.cjs', 'utf8');
      const required = [...source.matchAll(siblingPattern)].map((match) => match[1]);
      expect(required.length).toBeGreaterThan(0);
      for (const file of required) expect(present).toContain(file);

      for (const file of packaged) {
        const text = await readFile(join(pluginDirectory, file), 'utf8');
        for (const match of text.matchAll(siblingPattern)) expect(present).toContain(match[1]);
      }
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
});
