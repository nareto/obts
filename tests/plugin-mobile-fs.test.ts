import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';

import { MemoryDataAdapter } from './helpers/memoryDataAdapter.js';

const require = createRequire(import.meta.url);
const { createDataAdapterFs, createPackIndexFs, createReadOverlayFs } = require('../obsidian-plugin/src/data-adapter-fs.cjs') as {
  createDataAdapterFs: (adapter: MemoryDataAdapter) => any;
  createPackIndexFs: (fs: any, packfile: Uint8Array) => any;
  createReadOverlayFs: (fs: any, files: Array<[string, Uint8Array]>) => any;
};

describe('mobile DataAdapter filesystem', () => {
  it('provides byte-safe Node-style filesystem behavior', async () => {
    const adapter = new MemoryDataAdapter();
    const fs = createDataAdapterFs(adapter);
    const bytes = Buffer.from([0, 255, 1, 2, 128]);

    await fs.promises.mkdir('/.obts/state', { recursive: true });
    await fs.promises.writeFile('/.obts/state/data.bin', bytes);

    expect(await fs.promises.readFile('/.obts/state/data.bin')).toEqual(bytes);
    expect((await fs.promises.stat('/.obts/state/data.bin')).isFile()).toBe(true);
    expect((await fs.promises.stat('/.obts/state')).isDirectory()).toBe(true);
    await expect(fs.promises.writeFile('/.obts/state/data.bin', bytes, { flag: 'wx' })).rejects.toMatchObject({ code: 'EEXIST' });

    const entries = await fs.promises.readdir('/.obts/state', { withFileTypes: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('data.bin');
    expect(entries[0].isFile()).toBe(true);

    await fs.promises.rename('/.obts/state/data.bin', '/.obts/state/renamed.bin');
    await expect(fs.promises.readFile('/.obts/state/data.bin')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.promises.readFile('/.obts/state/renamed.bin')).toEqual(bytes);
  });

  it('preserves or recovers the prior file when replacement is interrupted', async () => {
    const adapter = new MemoryDataAdapter();
    const fs = createDataAdapterFs(adapter);
    await fs.promises.mkdir('/.obts', { recursive: true });
    await fs.promises.writeFile('/.obts/state.json', 'old');
    await fs.promises.writeFile('/.obts/state.tmp', 'new');

    adapter.failOnRenameCall = adapter.renameCallCount + 2;
    await expect(fs.promises.rename('/.obts/state.tmp', '/.obts/state.json')).rejects.toMatchObject({ code: 'EIO' });
    expect(await fs.promises.readFile('/.obts/state.json', 'utf8')).toBe('old');

    adapter.failOnRenameCall = null;
    await adapter.rename('.obts/state.json', '.obts/state.json.obts-replace-backup');
    expect(await adapter.exists('.obts/state.json')).toBe(false);
    await fs.promises.recoverReplacements('/.obts');
    expect(await fs.promises.readFile('/.obts/state.json', 'utf8')).toBe('old');
  });

  it('rejects files used as directories and preserves adapter I/O errors', async () => {
    const adapter = new MemoryDataAdapter();
    const fs = createDataAdapterFs(adapter);
    await fs.promises.writeFile('/parent', 'file');
    await expect(fs.promises.mkdir('/parent/child', { recursive: true })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('supports isomorphic-git init, object storage, refs, packs, and reopen', async () => {
    const sourceAdapter = new MemoryDataAdapter();
    const sourceFs = createDataAdapterFs(sourceAdapter);
    const args = { fs: sourceFs, dir: '/', gitdir: '/.obts/git' };

    await git.init({ ...args, defaultBranch: 'local' });
    const blob = await git.writeBlob({ ...args, blob: Buffer.from('mobile vault\n') });
    const tree = await git.writeTree({
      ...args,
      tree: [{ mode: '100644', path: 'note.md', oid: blob, type: 'blob' }]
    });
    const commit = await git.commit({
      ...args,
      ref: 'refs/heads/local',
      tree,
      message: 'mobile commit',
      author: { name: 'obts device', email: 'device@obts.local' },
      committer: { name: 'obts device', email: 'device@obts.local' }
    });

    expect(await git.resolveRef({ ...args, ref: 'refs/heads/local' })).toBe(commit);
    expect(Buffer.from((await git.readBlob({ ...args, oid: commit, filepath: 'note.md' })).blob).toString('utf8')).toBe('mobile vault\n');

    const packed = await git.packObjects({ ...args, oids: [blob, tree, commit] });
    expect(packed.packfile).toBeDefined();

    const destinationAdapter = new MemoryDataAdapter();
    const destinationFs = createDataAdapterFs(destinationAdapter);
    const destinationArgs = { fs: destinationFs, dir: '/', gitdir: '/.obts/git' };
    await git.init({ ...destinationArgs, defaultBranch: 'local' });
    await destinationFs.promises.mkdir('/.obts/git/objects/pack', { recursive: true });
    const oldPackPath = '/.obts/git/objects/pack/old-attempt.pack';
    const packPath = '/.obts/git/objects/pack/import.pack';
    await destinationFs.promises.writeFile(oldPackPath, packed.packfile);
    await destinationFs.promises.writeFile(packPath, packed.packfile);
    const temporarilyUnreadableFs = {
      promises: {
        ...destinationFs.promises,
        async readFile(filePath: string, options: unknown) {
          if (filePath.endsWith('.pack')) throw new Error('simulated mobile pack read miss');
          return await destinationFs.promises.readFile(filePath, options);
        }
      }
    };
    const indexingFs = createReadOverlayFs(temporarilyUnreadableFs, []);
    indexingFs.setReadOverlay(oldPackPath, packed.packfile!);
    const overlaidDestinationArgs = { ...destinationArgs, fs: indexingFs };
    await git.indexPack({
      ...overlaidDestinationArgs,
      fs: createPackIndexFs(indexingFs, packed.packfile!),
      filepath: '.obts/git/objects/pack/old-attempt.pack'
    });
    await git.indexPack({
      ...overlaidDestinationArgs,
      fs: createPackIndexFs(indexingFs, packed.packfile!),
      filepath: '.obts/git/objects/pack/import.pack'
    });
    indexingFs.setReadOverlay(packPath, packed.packfile!);
    await git.writeRef({ ...overlaidDestinationArgs, ref: 'refs/heads/local', value: commit, force: true });

    expect(Buffer.from((await git.readBlob({ ...overlaidDestinationArgs, oid: commit, filepath: 'note.md' })).blob).toString('utf8')).toBe('mobile vault\n');
    expect(await git.resolveRef({ ...overlaidDestinationArgs, ref: 'refs/heads/local' })).toBe(commit);
  });
});
