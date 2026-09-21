import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateUpgradeFixture } from './generate-upgrade-fixture.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..');
const clientPath = join(repositoryRoot, 'scripts', 'deployment-canary-client.mjs');
const image = process.env.OBTS_CANARY_IMAGE ?? process.argv[2];
const outputDir = await mkdtemp(join(tmpdir(), 'obts-deployment-canary-'));
const containerName = `obts-deployment-canary-${process.pid}`;
let containerStarted = false;

try {
  if (!image) throw new Error('OBTS_CANARY_IMAGE or an image argument is required');
  if (!image.includes('@sha256:') && process.env.OBTS_CANARY_ALLOW_LOCAL_TAG !== '1') {
    throw new Error('deployment canary requires a digest-pinned image; set OBTS_CANARY_ALLOW_LOCAL_TAG=1 only for local testing');
  }
  await execFileAsync('docker', ['version'], { timeout: 10_000 });
  const descriptor = await generateUpgradeFixture(outputDir);
  const dataDir = join(outputDir, descriptor.data_dir);
  await execFileAsync('docker', [
    'run',
    '--detach',
    '--rm',
    '--init',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m',
    '--network', 'none',
    '--name', containerName,
    '--env', 'NODE_ENV=production',
    '--env', 'OBTS_DATA_DIR=/var/lib/obts',
    '--env', 'OBTS_HOST=127.0.0.1',
    '--env', 'OBTS_PORT=3000',
    '--env', 'OBTS_PUBLIC_BASE_URL=http://127.0.0.1:3000',
    '--env', 'OBTS_SESSION_SECRET=synthetic-upgrade-fixture-session-secret',
    image,
    'sleep', 'infinity'
  ], { timeout: 30_000 });
  containerStarted = true;
  await execFileAsync('docker', ['cp', `${dataDir}/.`, `${containerName}:/var/lib/obts/`], { timeout: 30_000 });
  await execFileAsync('docker', ['exec', '--user', 'root', containerName, 'mkdir', '-p', '/var/lib/obts/canary'], { timeout: 10_000 });
  await execFileAsync('docker', ['cp', join(outputDir, 'descriptor.json'), `${containerName}:/var/lib/obts/canary/descriptor.json`], { timeout: 10_000 });
  await execFileAsync('docker', ['cp', join(outputDir, descriptor.healthy_packfile), `${containerName}:/var/lib/obts/canary/${descriptor.healthy_packfile}`], { timeout: 10_000 });
  await execFileAsync('docker', ['cp', clientPath, `${containerName}:/var/lib/obts/canary/check.mjs`], { timeout: 10_000 });
  await execFileAsync('docker', [
    'exec', '--user', 'root', containerName, 'sh', '-c',
    "find /var/lib/obts/transfers -name alternates -type f -exec sed -i -E 's#^.*/data/git/#/var/lib/obts/git/#' {} +; find /var/lib/obts -type d -exec chmod 700 {} +; find /var/lib/obts -type f -exec chmod 600 {} +"
  ], { timeout: 10_000 });
  await execFileAsync('docker', ['exec', '--user', 'root', containerName, 'chown', '-R', 'node:node', '/var/lib/obts'], { timeout: 10_000 });
  await execFileAsync('docker', ['exec', '--user', 'node', '--detach', containerName, 'node', 'dist/src/cli.js', 'serve'], { timeout: 10_000 });
  const result = await execFileAsync('docker', ['exec', '--user', 'node', containerName, 'node', '/var/lib/obts/canary/check.mjs'], {
    timeout: 60_000,
    maxBuffer: 1_000_000
  });
  process.stdout.write(result.stdout);
  process.stdout.write('deployment canary: PASS; authoritative data was not mounted\n');
} catch (error) {
  let logs = '';
  if (containerStarted) {
    try {
      const result = await execFileAsync('docker', ['logs', '--tail', '80', containerName], {
        timeout: 10_000,
        maxBuffer: 1_000_000
      });
      logs = result.stdout || result.stderr || '';
    } catch {
      logs = '';
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`deployment canary failed: ${message}${logs ? `\ncontainer logs:\n${logs}` : ''}`);
} finally {
  if (containerStarted) {
    await execFileAsync('docker', ['rm', '--force', containerName], { timeout: 10_000 }).catch(() => undefined);
  }
  await rm(outputDir, { recursive: true, force: true });
}
