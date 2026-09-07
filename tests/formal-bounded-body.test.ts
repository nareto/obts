import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(root, 'scripts', 'check-bridge-bounded-model.mjs');

describe('FM003 Bridge bounded-body harness', () => {
  it('keeps the accepted FM003 check matrix and stage-2 evidence boundary valid', () => {
    const result = spawnSync(process.execPath, [checker, '--validate-only'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('39 required checks');
  });
});
