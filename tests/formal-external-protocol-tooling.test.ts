import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

it('uses the pinned TLA+ JAR for FM005 when standalone tools are unavailable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'obts-fm005-tooling-'));
  try {
    const java = join(directory, 'java');
    const argumentsPath = join(directory, 'arguments');
    const jar = join(directory, 'tla2tools.jar');
    writeFileSync(java, '#!/bin/sh\nprintf "%s\\n" "$@" > "$FM005_TOOL_ARGS"\nprintf "pinned-jar probe\\n" >&2\nexit 1\n');
    chmodSync(java, 0o755);

    const result = spawnSync(process.execPath, [join(root, 'scripts/check-bridge-external-protocol.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: directory, TLA2TOOLS_JAR: jar, FM005_TOOL_ARGS: argumentsPath }
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pinned-jar probe');
    expect(readFileSync(argumentsPath, 'utf8').split('\n').slice(0, 3)).toEqual(['-cp', jar, 'tla2sany.SANY']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('uses the pinned TLA+ JAR for FM005 model checking', () => {
  const directory = mkdtempSync(join(tmpdir(), 'obts-fm005-tlc-tooling-'));
  try {
    const java = join(directory, 'java');
    const argumentsPath = join(directory, 'arguments');
    const jar = join(directory, 'tla2tools.jar');
    writeFileSync(java, '#!/bin/sh\nif [ "$3" = "tla2sany.SANY" ]; then exit 0; fi\nprintf "%s\\n" "$@" > "$FM005_TOOL_ARGS"\nexit 1\n');
    chmodSync(java, 0o755);

    const result = spawnSync(process.execPath, [join(root, 'scripts/check-bridge-external-protocol.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: directory, TLA2TOOLS_JAR: jar, FM005_TOOL_ARGS: argumentsPath }
    });

    expect(result.status).toBe(1);
    expect(readFileSync(argumentsPath, 'utf8').split('\n').slice(0, 3)).toEqual(['-cp', jar, 'tlc2.TLC']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
