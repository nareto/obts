#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ObtsPluginClient } from '../dist/src/client/core.js';

const fileCount = positiveInteger(process.env.OBTS_BENCH_FILES, 1800);
const bytesPerFile = positiveInteger(process.env.OBTS_BENCH_BYTES, 80 * 1024);
const root = await mkdtemp(join(tmpdir(), 'obts-large-vault-benchmark-'));

try {
  const notes = join(root, 'notes');
  await mkdir(notes, { recursive: true });
  const base = Buffer.alloc(bytesPerFile, 0x61);
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(notes, `${String(index).padStart(5, '0')}.md`), base);
  }

  const plugin = new ObtsPluginClient(root, {
    serverUrl: 'http://127.0.0.1:1',
    deviceName: 'large-vault-benchmark'
  });
  await plugin.initialize();
  const core = plugin.client;

  core.fileWorkConcurrency = 1;
  const serialStarted = performance.now();
  await core.createLocalCommit('benchmark serial baseline');
  const serialMs = performance.now() - serialStarted;

  const serialUnchangedStarted = performance.now();
  await core.createLocalCommit('benchmark serial unchanged checkpoint');
  const serialUnchangedMs = performance.now() - serialUnchangedStarted;

  const changed = Buffer.alloc(bytesPerFile, 0x62);
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(join(notes, `${String(index).padStart(5, '0')}.md`), changed);
  }

  core.fileWorkConcurrency = 4;
  const boundedStarted = performance.now();
  await core.createLocalCommit('benchmark bounded concurrency');
  const boundedMs = performance.now() - boundedStarted;

  const unchangedStarted = performance.now();
  await core.createLocalCommit('benchmark unchanged checkpoint');
  const unchangedMs = performance.now() - unchangedStarted;

  process.stdout.write(`${JSON.stringify({
    files: fileCount,
    bytes_per_file: bytesPerFile,
    total_bytes: fileCount * bytesPerFile,
    serial_ms: Math.round(serialMs),
    serial_unchanged_ms: Math.round(serialUnchangedMs),
    bounded_ms: Math.round(boundedMs),
    bounded_unchanged_ms: Math.round(unchangedMs),
    changed_speedup: Number((serialMs / boundedMs).toFixed(2)),
    unchanged_speedup: Number((serialUnchangedMs / unchangedMs).toFixed(2))
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
