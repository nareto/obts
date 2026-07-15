import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';

import { MemoryDataAdapter } from './helpers/memoryDataAdapter.js';

const require = createRequire(import.meta.url);
const { createDataAdapterFs, createPackIndexFs, createReadOverlayFs } = require('../obsidian-plugin/src/data-adapter-fs.cjs') as {
  createDataAdapterFs: (adapter: MemoryDataAdapter) => any;
  createPackIndexFs: (fs: any, packfile: Uint8Array, observer?: (event: Record<string, unknown>) => void) => any;
  createReadOverlayFs: (
    fs: any,
    files: Array<[string, Uint8Array]>,
    options?: { maxBytes?: number; cacheRead?: (filePath: string) => boolean; readAttempts?: number; retryDelayMs?: number }
  ) => any;
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

    await adapter.rename('.obts/state.json', '.obts/state.json.obts-replace-backup-crash-one');
    await fs.promises.recoverReplacements('/.obts');
    expect(await fs.promises.readFile('/.obts/state.json', 'utf8')).toBe('old');
  });

  it('bounds replacement recovery and stops when plugin unload aborts it', async () => {
    const adapter = new MemoryDataAdapter();
    const fs = createDataAdapterFs(adapter);
    await fs.promises.mkdir('/.obts/nested', { recursive: true });
    await fs.promises.writeFile('/.obts/state.json.obts-replace-backup-crash', 'root');
    await fs.promises.writeFile('/.obts/nested/queue.json.obts-replace-backup-crash', 'nested');

    await fs.promises.recoverReplacements('/.obts', { maxDepth: 0 });
    expect(await fs.promises.readFile('/.obts/state.json', 'utf8')).toBe('root');
    expect(await fs.promises.readFile('/.obts/nested/queue.json.obts-replace-backup-crash', 'utf8')).toBe('nested');

    const controller = new AbortController();
    controller.abort();
    await expect(fs.promises.recoverReplacements('/.obts/nested', { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORT_ERR'
    });

    const traversalController = new AbortController();
    const list = adapter.list.bind(adapter);
    adapter.list = async (filePath: string) => {
      const listing = await list(filePath);
      if (filePath === '.obts/nested') traversalController.abort();
      return listing;
    };
    await expect(fs.promises.recoverReplacements('/.obts', { signal: traversalController.signal })).rejects.toMatchObject({
      code: 'ABORT_ERR'
    });
    expect(await fs.promises.readFile('/.obts/nested/queue.json.obts-replace-backup-crash', 'utf8')).toBe('nested');
    await expect(fs.promises.stat('/.obts/nested/queue.json')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes same-destination replacements across filesystem wrappers and cleans owned temps', async () => {
    const adapter = new MemoryDataAdapter();
    const first = createDataAdapterFs(adapter);
    const second = createDataAdapterFs(adapter);
    await first.promises.mkdir('/.obts', { recursive: true });
    await first.promises.writeFile('/.obts/queue.json', '{"version":0}');
    await first.promises.writeFile('/.obts/queue.json.tmp-a-1', '{"version":1}');
    await second.promises.writeFile('/.obts/queue.json.tmp-b-2', '{"version":2}');

    await Promise.all([
      first.promises.rename('/.obts/queue.json.tmp-a-1', '/.obts/queue.json'),
      second.promises.rename('/.obts/queue.json.tmp-b-2', '/.obts/queue.json')
    ]);
    expect(['{"version":1}', '{"version":2}']).toContain(await first.promises.readFile('/.obts/queue.json', 'utf8'));
    expect((await first.promises.readdir('/.obts')).filter((name: string) => name.includes('replace-backup'))).toEqual([]);

    await first.promises.writeFile('/.obts/state.json.tmp-dead-1', '{"valid":true}');
    await first.promises.writeFile('/.obts/state.json.tmp-bad-2', 'not-json');
    await first.promises.recoverReplacements('/.obts');
    await expect(first.promises.stat('/.obts/state.json.tmp-dead-1')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await first.promises.readFile('/.obts/state.json.tmp-bad-2', 'utf8')).toBe('not-json');
  });

  it('rejects files used as directories and preserves adapter I/O errors', async () => {
    const adapter = new MemoryDataAdapter();
    const fs = createDataAdapterFs(adapter);
    await fs.promises.writeFile('/parent', 'file');
    await expect(fs.promises.mkdir('/parent/child', { recursive: true })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('observes the hidden pack read failure without exposing its path or message', async () => {
    const events: Array<Record<string, unknown>> = [];
    const fs = createPackIndexFs(
      {
        promises: {
          async stat() { return { isFile: () => true }; },
          async readFile() {
            const error = new Error('private-note.md diagnostic-secret-body') as Error & { code: string };
            error.code = 'EIO';
            throw error;
          },
          async writeFile() {}
        }
      },
      Buffer.from('PACKdata'),
      (event) => events.push(event)
    );

    expect(Buffer.from(await fs.read('/secret/current.pack')).toString()).toBe('PACKdata');
    expect(await fs.read('/secret/prior.pack')).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({
      point: 'index_fs_read',
      outcome: 'failed',
      valueKind: 'null',
      errorCode: 'eio'
    }));
    expect(JSON.stringify(events)).not.toContain('private-note.md');
    expect(JSON.stringify(events)).not.toContain('/secret/');
    expect(JSON.stringify(events)).not.toContain('diagnostic-secret-body');
  });

  it('loads persisted packs lazily with a bounded retrying cache', async () => {
    const packs = new Map([
      ['.obts/git/objects/pack/a.pack', Buffer.alloc(8, 1)],
      ['.obts/git/objects/pack/b.pack', Buffer.alloc(8, 2)]
    ]);
    const reads = new Map<string, number>();
    let failFirstRead = true;
    const fs = createReadOverlayFs(
      {
        promises: {
          async readFile(filePath: string) {
            const count = (reads.get(filePath) ?? 0) + 1;
            reads.set(filePath, count);
            if (filePath.endsWith('a.pack') && failFirstRead) {
              failFirstRead = false;
              throw new Error('transient mobile pack read miss');
            }
            return Buffer.from(packs.get(filePath)!);
          }
        }
      },
      [],
      {
        maxBytes: 8,
        cacheRead: (filePath: string) => filePath.endsWith('.pack'),
        readAttempts: 2
      }
    );

    expect(await fs.promises.readFile('.obts/git/objects/pack/a.pack')).toEqual(packs.get('.obts/git/objects/pack/a.pack'));
    expect(await fs.promises.readFile('.obts/git/objects/pack/a.pack')).toEqual(packs.get('.obts/git/objects/pack/a.pack'));
    expect(reads.get('.obts/git/objects/pack/a.pack')).toBe(2);

    await fs.promises.readFile('.obts/git/objects/pack/b.pack');
    await fs.promises.readFile('.obts/git/objects/pack/a.pack');
    expect(reads.get('.obts/git/objects/pack/a.pack')).toBe(3);
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
    const diagnosticEvents: Array<Record<string, unknown>> = [];
    await git.indexPack({
      ...overlaidDestinationArgs,
      fs: createPackIndexFs(indexingFs, packed.packfile!, (event) => diagnosticEvents.push(event)),
      filepath: '.obts/git/objects/pack/import.pack'
    });
    expect(diagnosticEvents).toContainEqual(expect.objectContaining({
      point: 'index_fs_read',
      outcome: 'returned',
      valueKind: 'buffer'
    }));
    expect(JSON.stringify(diagnosticEvents)).not.toContain('old-attempt.pack');
    expect(JSON.stringify(diagnosticEvents)).not.toContain('import.pack');
    indexingFs.setReadOverlay(packPath, packed.packfile!);
    await git.writeRef({ ...overlaidDestinationArgs, ref: 'refs/heads/local', value: commit, force: true });

    expect(Buffer.from((await git.readBlob({ ...overlaidDestinationArgs, oid: commit, filepath: 'note.md' })).blob).toString('utf8')).toBe('mobile vault\n');
    expect(await git.resolveRef({ ...overlaidDestinationArgs, ref: 'refs/heads/local' })).toBe(commit);

    let firstPersistedPackRead = true;
    const reopenedFs = createReadOverlayFs(
      {
        promises: {
          ...destinationFs.promises,
          async readFile(filePath: string, options: unknown) {
            if (filePath.endsWith('.pack') && firstPersistedPackRead) {
              firstPersistedPackRead = false;
              throw new Error('transient restart pack read miss');
            }
            return await destinationFs.promises.readFile(filePath, options);
          }
        }
      },
      [],
      {
        maxBytes: 1024 * 1024,
        cacheRead: (filePath: string) => filePath.endsWith('.pack'),
        readAttempts: 2
      }
    );
    const reopenedArgs = { ...destinationArgs, fs: reopenedFs };
    expect(Buffer.from((await git.readBlob({ ...reopenedArgs, oid: commit, filepath: 'note.md' })).blob).toString('utf8')).toBe('mobile vault\n');
  });
});
