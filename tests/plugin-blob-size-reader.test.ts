import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeDataAdapter } from '../src/client/nodeDataAdapter.js';

const require = createRequire(import.meta.url);
const { blobSizeFromGit } = require('../obsidian-plugin/src/blob-size-reader.cjs');
const { createDataAdapterFs } = require('../obsidian-plugin/src/data-adapter-fs.cjs');
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'obts-blob-size-'));
  roots.push(root);
  const gitdir = join(root, '.obts/git');
  execFileSync('git', ['init', '-q', '--bare', gitdir]);
  const command = (args: string[], input?: Buffer) => execFileSync('git', ['--git-dir', gitdir, ...args], { input, encoding: 'utf8' }).trim();
  const adapter = new NodeDataAdapter(root);
  const fsp = createDataAdapterFs(adapter).promises;
  return { root, gitdir, command, adapter, fsp };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('bounded Git blob-size recovery', () => {
  it('rejects symlinks at the target and in an ancestor of a ranged read', async () => {
    const { root, adapter } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'obts-size-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret'), 'not in the vault');
    await symlink(join(outside, 'secret'), join(root, 'final-link'));
    await symlink(outside, join(root, 'ancestor-link'));
    expect(Buffer.from(await adapter.readBinaryRange('/.obts/git/config', 0, 12)).length).toBe(12);
    await expect(adapter.readBinaryRange('/final-link', 0, 12)).rejects.toThrow();
    await expect(adapter.readBinaryRange('/ancestor-link/secret', 0, 12)).rejects.toThrow();
    await expect(adapter.readBinaryRange('/../secret', 0, 12)).rejects.toThrow();
  });
  it('reads only bounded ranges for large loose blobs, rejects non-blobs and corrupt headers', async () => {
    const { gitdir, command, adapter, fsp } = await fixture();
    const oid = command(['hash-object', '-w', '--stdin'], Buffer.alloc(4 * 1024 * 1024, 97));
    const tree = command(['mktree'], Buffer.alloc(0));
    let readBytes = 0;
    const original = adapter.readBinaryRange.bind(adapter);
    adapter.readBinaryRange = async (file, position, length) => {
      readBytes += length;
      return original(file, position, length);
    };
    expect(await blobSizeFromGit(fsp, '/.obts/git', oid)).toBe(4 * 1024 * 1024);
    expect(readBytes).toBeLessThanOrEqual(1024);
    expect(await blobSizeFromGit(fsp, '/.obts/git', tree)).toBeNull();
    expect(await blobSizeFromGit(fsp, '/.obts/git', 'f'.repeat(40))).toBeNull();
    const noRangeAdapter = { readBinary: vi.fn(async () => { throw new Error('Full object read'); }) };
    expect(await blobSizeFromGit(createDataAdapterFs(noRangeAdapter).promises, '/.obts/git', oid)).toBeNull();
    expect(noRangeAdapter.readBinary).not.toHaveBeenCalled();
    const loosePath = join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
    await chmod(loosePath, 0o600);
    await writeFile(loosePath, Buffer.from([0x78, 0x9c, 0x01]));
    expect(await blobSizeFromGit(fsp, '/.obts/git', oid)).toBeNull();
    expect(await stat(loosePath)).toBeDefined();
  });

  for (const [name, offsetDeltas] of [['OFS_DELTA', true], ['REF_DELTA', false]] as const) {
    it(`reads packed full objects and actual ${name} entries`, async () => {
      const { gitdir, command, adapter, fsp } = await fixture();
      const original = Buffer.from('abcde'.repeat(400_000));
      const changed = Buffer.from(original);
      changed.write('DIFFERENT', 100);
      const first = command(['hash-object', '-w', '--stdin'], original);
      const second = command(['hash-object', '-w', '--stdin'], changed);
      command(['update-ref', 'refs/tags/first', first]);
      command(['update-ref', 'refs/tags/second', second]);
      command(['-c', `repack.useDeltaBaseOffset=${offsetDeltas}`, 'repack', '-adf', '--window=50', '--depth=50']);
      const pack = (await readdir(join(gitdir, 'objects/pack'))).find((file) => file.endsWith('.idx'))!;
      const details = command(['verify-pack', '-v', join(gitdir, 'objects/pack', pack)]);
      const delta = [first, second].find((oid) => details.split('\n').some((line) =>
        line.startsWith(`${oid} blob `) && line.trim().split(/\s+/u).length === 7
      ));
      expect(delta, details).toBeDefined();
      const index = await readFile(join(gitdir, 'objects/pack', pack));
      const packBytes = await readFile(join(gitdir, 'objects/pack', pack.replace('.idx', '.pack')));
      const row = details.split('\n').find((line) => line.startsWith(`${delta} blob `))!;
      const offset = Number(row.split(/\s+/u)[4]);
      expect((packBytes[offset]! >> 4) & 7).toBe(offsetDeltas ? 6 : 7);
      expect(index.readUInt32BE(4)).toBe(2);
      let packedReadBytes = 0;
      let largestRead = 0;
      const rangeRead = adapter.readBinaryRange.bind(adapter);
      adapter.readBinaryRange = async (file, position, length) => {
        if (file.includes('/objects/pack/')) packedReadBytes += length;
        largestRead = Math.max(largestRead, length);
        return rangeRead(file, position, length);
      };
      expect(await blobSizeFromGit(fsp, '/.obts/git', first)).toBe(original.length);
      expect(await blobSizeFromGit(fsp, '/.obts/git', second)).toBe(changed.length);
      expect(largestRead).toBeLessThanOrEqual(256);
      expect(packedReadBytes).toBeLessThanOrEqual(4096);
      if (offsetDeltas) {
        const count = index.readUInt32BE(8 + 255 * 4);
        const oidTable = 8 + 1024;
        let ordinal = -1;
        for (let candidate = 0; candidate < count; candidate += 1) {
          if (index.subarray(oidTable + candidate * 20, oidTable + (candidate + 1) * 20)
            .equals(Buffer.from(first, 'hex'))) ordinal = candidate;
        }
        expect(ordinal).toBeGreaterThanOrEqual(0);
        const broken = Buffer.from(index);
        broken.writeUInt32BE(0x8000000f, oidTable + count * 24 + ordinal * 4);
        const idxPath = join(gitdir, 'objects/pack', pack);
        await chmod(idxPath, 0o600);
        await writeFile(idxPath, broken);
        expect(await blobSizeFromGit(fsp, '/.obts/git', first)).toBeNull();
        broken.writeUInt32BE(3, 4);
        await writeFile(idxPath, broken);
        expect(await blobSizeFromGit(fsp, '/.obts/git', first)).toBeNull();
      }
    });
  }
});
