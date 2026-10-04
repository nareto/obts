import { mkdtemp, mkdir, open, link, lstat, unlink, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const modulePath = fileURLToPath(new URL('../dist/src/client/managedHeadlessOwnership.js', import.meta.url));

function waitForFile(path: string, child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = async (): Promise<void> => {
      try {
        resolve(await readFile(path, 'utf8'));
      } catch {
        if (child.exitCode !== null || Date.now() >= deadline) {
          reject(new Error('Managed Node child did not publish its lock capability.'));
          return;
        }
        setTimeout(() => void poll(), 20);
      }
    };
    void poll();
  });
}

describe('managed Linux headless ownership', () => {
  it.each(['missing .obts directory', 'missing stable ownership lock'])('declines ownership when there is a %s', async (missingState) => {
    const { createManagedHeadlessOwnership } = await import(modulePath);
    const root = await mkdtemp(join(tmpdir(), 'obts-managed-missing-state-'));
    if (missingState === 'missing stable ownership lock') await mkdir(join(root, '.obts'), { mode: 0o700 });
    try {
      expect(createManagedHeadlessOwnership(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['write', 'close'])('cleans an unpublished marker after injected %s failure', async (failurePoint) => {
    const { publishManagedApplyMarker } = await import(modulePath);
    const root = await mkdtemp(join(tmpdir(), 'obts-managed-publish-'));
    const obts = join(root, '.obts');
    const marker = join(obts, 'apply.lock');
    await mkdir(obts, { mode: 0o700 });
    const ops = { open: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return {
        stat: () => handle.stat(),
        sync: () => handle.sync(),
        writeFile: async (contents: string) => {
          if (failurePoint === 'write') {
            await handle.writeFile('{"version":');
            throw new Error('injected write failure');
          }
          return handle.writeFile(contents);
        },
        close: async () => {
          await handle.close();
          if (failurePoint === 'close') throw new Error('injected close failure');
        }
      };
    }, link, lstat, unlink };
    try {
      await expect(publishManagedApplyMarker(obts, marker, '{"complete":true}', ops)).rejects.toThrow(`injected ${failurePoint} failure`);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(obts)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not replace an existing marker during atomic publication', async () => {
    const { publishManagedApplyMarker } = await import(modulePath);
    const root = await mkdtemp(join(tmpdir(), 'obts-managed-publish-'));
    const obts = join(root, '.obts');
    const marker = join(obts, 'apply.lock');
    await mkdir(obts, { mode: 0o700 });
    const contents = '{"replacement":true}';
    await writeFile(marker, contents, { mode: 0o600 });
    try {
      await expect(publishManagedApplyMarker(obts, marker, '{"ours":true}')).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(marker, 'utf8')).toBe(contents);
      expect(await readdir(obts)).toEqual(['apply.lock']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps the flock through supervisor death and releases it only when the Node child exits', async () => {
    if (process.platform !== 'linux') return;
    const root = await mkdtemp(join(tmpdir(), 'obts-managed-lock-'));
    const obts = join(root, '.obts');
    const lock = join(obts, 'headless-owner.lock');
    const ready = join(root, 'ready.json');
    const pidFile = join(root, 'child.pid');
    await mkdir(obts, { mode: 0o700 });
    await writeFile(lock, '', { mode: 0o600 });
    const childCode = `Promise.all([import(${JSON.stringify(`file://${modulePath}`)}),import('node:fs')]).then(([mod,fs])=>{const owner=mod.createManagedHeadlessOwnership(${JSON.stringify(root)});if(!owner)process.exit(7);const base={version:2,domain:'obts-managed-linux-headless',generation:'11111111-1111-4111-8111-111111111111',apply_id:'apply_old'};const accepted=owner.canReclaim(base);const extra=owner.canReclaim({...base,extra:true});const loose=owner.canReclaim({...base,generation:'11111111-1111-1111-1111-111111111111'});const badApply=owner.canReclaim({...base,apply_id:'bad'});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({generation:owner.generation,accepted,extra,loose,badApply}));setInterval(()=>{},1000)})`;
    const script = `flock --exclusive --nonblock --no-fork ${JSON.stringify(lock)} node --input-type=module -e ${JSON.stringify(childCode)} & echo $! > ${JSON.stringify(pidFile)}; wait`;
    const supervisor = spawn('sh', ['-c', script], { stdio: 'ignore' });
    try {
      const ownership = JSON.parse(await waitForFile(ready, supervisor)) as {
        generation: string; accepted: boolean; extra: boolean; loose: boolean; badApply: boolean;
      };
      expect(ownership.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
      expect(ownership).toMatchObject({ accepted: true, extra: false, loose: false, badApply: false });
      expect(spawnSync('flock', ['--exclusive', '--nonblock', lock, 'true']).status).not.toBe(0);
      const childPid = Number(await readFile(pidFile, 'utf8'));
      supervisor.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(spawnSync('flock', ['--exclusive', '--nonblock', lock, 'true']).status).not.toBe(0);
      process.kill(childPid, 'SIGTERM');
      const deadline = Date.now() + 5000;
      let acquired = false;
      while (Date.now() < deadline) {
        if (spawnSync('flock', ['--exclusive', '--nonblock', lock, 'true']).status === 0) {
          acquired = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(acquired).toBe(true);
    } finally {
      supervisor.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
});
