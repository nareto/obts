#!/usr/bin/env node

import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
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

  const settledMain = await core.resolveRef('refs/heads/local');
  await core.updateRef('refs/heads/main', settledMain, null, true);
  const retainedFiles = Math.min(17, Math.max(0, fileCount - 1));
  for (let index = 0; index < fileCount - retainedFiles; index += 1) {
    await unlink(join(notes, `${String(index).padStart(5, '0')}.md`));
  }
  const deletionCheckpointStarted = performance.now();
  const deletionCommit = await core.createLocalCommit('benchmark large deletion');
  const deletionCheckpointMs = performance.now() - deletionCheckpointStarted;
  const deletionPlanStarted = performance.now();
  const deletionGroups = await core.planPackChunks(deletionCommit, [settledMain], 16 * 1024 * 1024, 32 * 1024 * 1024);
  const deletionPlanMs = performance.now() - deletionPlanStarted;
  const deletionPacks = await Promise.all(deletionGroups.map((group) => core.packObjectChunk(group, 32 * 1024 * 1024)));

  process.stdout.write(`${JSON.stringify({
    files: fileCount,
    bytes_per_file: bytesPerFile,
    total_bytes: fileCount * bytesPerFile,
    serial_ms: Math.round(serialMs),
    serial_unchanged_ms: Math.round(serialUnchangedMs),
    bounded_ms: Math.round(boundedMs),
    bounded_unchanged_ms: Math.round(unchangedMs),
    changed_speedup: Number((serialMs / boundedMs).toFixed(2)),
    unchanged_speedup: Number((serialUnchangedMs / unchangedMs).toFixed(2)),
    deletion_changed_paths: fileCount - retainedFiles,
    deletion_checkpoint_ms: Math.round(deletionCheckpointMs),
    deletion_plan_ms: Math.round(deletionPlanMs),
    deletion_object_count: deletionGroups.reduce((total, group) => total + group.length, 0),
    deletion_pack_bytes: deletionPacks.reduce((total, pack) => total + pack.byteLength, 0)
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
