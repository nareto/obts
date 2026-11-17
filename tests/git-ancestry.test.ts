import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type Commit = { parent: string[]; committer: { timestamp: number } };
type ReadCommit = (oid: string) => Promise<Commit>;
const { isAncestorByParents } = require('../obsidian-plugin/src/git-ancestry.cjs') as {
  isAncestorByParents(options: { ancestor: string; descendant: string; readCommit: ReadCommit }): Promise<boolean>;
};

// Deterministic scores so a failing seed is reproducible without a dependency.
function scores(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Dag = { ids: string[]; parents: Map<string, string[]> };

// A seeded DAG shaped like real history: rootless commits for disconnected
// histories, mostly one parent with long chains, and two or three parent merges
// whose lines cross.
function dag(seed: number, size: number): Dag {
  const next = scores(seed);
  const ids: string[] = [];
  const parents = new Map<string, string[]>();
  const componentStarts = seed % 3 === 0 ? 7 : size;
  for (let index = 0; index < size; index += 1) {
    const id = `c${index}`;
    ids.push(id);
    const earlier = ids.slice(0, index);
    if (index === 0 || (index % componentStarts === 0) || (index > 0 && next() < 0.08)) {
      parents.set(id, []);
      continue;
    }
    const chosen = new Set<string>();
    const chain = index > 0 && next() < 0.65 ? ids[index - 1] : undefined;
    if (chain) chosen.add(chain);
    const wanted = Math.min(1 + Math.floor(next() * 3), earlier.length);
    while (chosen.size < wanted) {
      chosen.add(earlier[Math.floor(next() * earlier.length)]!);
    }
    parents.set(id, [...chosen]);
  }
  return { ids, parents };
}

// The walk only orders its reads with committer timestamps, so the verdict must
// hold whether they follow history, contradict it, or repeat.
type TimestampMode = 'realistic' | 'reversed' | 'tied';
const TIMESTAMP_MODES: TimestampMode[] = ['realistic', 'reversed', 'tied'];

function timestamps({ ids }: Dag, mode: TimestampMode, seed: number): Map<string, number> {
  const next = scores(seed * 7 + 1);
  const stamps = new Map<string, number>();
  ids.forEach((id, index) => {
    if (mode === 'realistic') stamps.set(id, index);
    else if (mode === 'reversed') stamps.set(id, ids.length - index);
    else stamps.set(id, Math.floor(next() * 4));
  });
  return stamps;
}

function referenceIsAncestor(parents: Map<string, string[]>, ancestor: string, descendant: string): boolean {
  const pending = [descendant];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const oid = pending.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    for (const parent of parents.get(oid) ?? []) pending.push(parent);
  }
  return false;
}

function chain(length: number): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (let index = 0; index < length; index += 1) parents.set(`c${index}`, index === 0 ? [] : [`c${index - 1}`]);
  return parents;
}

// One commit per second, so the parent of a commit is always older than it.
function increasing(parents: Map<string, string[]>): Map<string, number> {
  const stamps = new Map<string, number>();
  let index = 0;
  for (const oid of parents.keys()) stamps.set(oid, 1_700_000_000 + index++);
  return stamps;
}

function counted(parents: Map<string, string[]>, stamps: Map<string, number> = new Map(), missing: Set<string> = new Set()) {
  const reads: string[] = [];
  const readCommit: ReadCommit = async (oid) => {
    reads.push(oid);
    if (missing.has(oid)) throw Object.assign(new Error(`missing ${oid}`), { code: 'NotFoundError' });
    return { parent: parents.get(oid) ?? [], committer: { timestamp: stamps.get(oid) ?? 0 } };
  };
  return { readCommit, reads };
}

describe('two-sided ancestry walk', () => {
  it('agrees with reference reachability for every ordered pair of a seeded DAG under realistic, reversed and tied timestamps', async () => {
    let pairs = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      const graph = dag(seed, 36);
      for (const mode of TIMESTAMP_MODES) {
        const stamps = timestamps(graph, mode, seed);
        const readCommit: ReadCommit = async (oid) =>
          ({ parent: graph.parents.get(oid) ?? [], committer: { timestamp: stamps.get(oid) ?? 0 } });
        for (const ancestor of graph.ids) {
          for (const descendant of graph.ids) {
            const expected = referenceIsAncestor(graph.parents, ancestor, descendant);
            expect(await isAncestorByParents({ ancestor, descendant, readCommit })).toBe(expected);
            pairs += 1;
          }
        }
      }
    }
    expect(pairs).toBe(24 * 3 * 36 * 36);
  });

  it('reads about the distance in both directions on a long chain, never walking past the older endpoint', async () => {
    const parents = chain(5000);
    const stamps = increasing(parents);
    const tip = 'c4999';
    for (const distance of [1, 10, 100]) {
      const older = `c${4999 - distance}`;
      // isAncestor(tip, older): the ancestor side has to walk the distance.
      const forward = counted(parents, stamps);
      expect(await isAncestorByParents({ ancestor: tip, descendant: older, readCommit: forward.readCommit })).toBe(false);
      expect(forward.reads.length).toBeLessThanOrEqual(distance + 3);
      expect(Math.min(...forward.reads.map((oid) => Number(oid.slice(1))))).toBeGreaterThanOrEqual(Number(older.slice(1)) - 2);

      // isAncestor(older, tip): the descendant side walks the distance while
      // the ancestor side waits, so both frontiers stay in the same region.
      const backward = counted(parents, stamps);
      expect(await isAncestorByParents({ ancestor: older, descendant: tip, readCommit: backward.readCommit })).toBe(true);
      expect(backward.reads.length).toBeLessThanOrEqual(distance + 3);
      expect(Math.min(...backward.reads.map((oid) => Number(oid.slice(1))))).toBeGreaterThanOrEqual(Number(older.slice(1)) - 2);
    }
  });

  it('stops at the fork for a divergent pair near the tip and walks the distance for ancestors on a branch', async () => {
    const parents = chain(5000);
    const stamps = increasing(parents);
    const fork = 'c4990';
    const forkStamp = stamps.get(fork)!;
    for (let index = 1; index <= 5; index += 1) {
      parents.set(`a${index}`, [index === 1 ? fork : `a${index - 1}`]);
      parents.set(`b${index}`, [index === 1 ? fork : `b${index - 1}`]);
      stamps.set(`a${index}`, forkStamp + index);
      stamps.set(`b${index}`, forkStamp + index);
    }
    // Both five-commit branch tips, then the shared fork once.
    const divergent = counted(parents, stamps);
    expect(await isAncestorByParents({ ancestor: 'a5', descendant: 'b5', readCommit: divergent.readCommit })).toBe(false);
    expect(divergent.reads.length).toBeLessThanOrEqual(12);

    const branch = counted(parents, stamps);
    expect(await isAncestorByParents({ ancestor: 'a2', descendant: 'a5', readCommit: branch.readCommit })).toBe(true);
    expect(branch.reads.length).toBeLessThanOrEqual(3 + 3);
  });

  it('walks disconnected roots fully and still answers false', async () => {
    const parents = chain(400);
    parents.set('x0', []);
    for (let index = 1; index <= 100; index += 1) parents.set(`x${index}`, [`x${index - 1}`]);
    const { readCommit } = counted(parents, increasing(parents));
    expect(await isAncestorByParents({ ancestor: 'x100', descendant: 'c399', readCommit })).toBe(false);
    expect(await isAncestorByParents({ ancestor: 'c399', descendant: 'x100', readCommit })).toBe(false);
  });

  it('treats a missing or non-finite timestamp as an ordering-only zero', async () => {
    const parents = chain(50);
    const readCommit: ReadCommit = async (oid) => ({ parent: parents.get(oid) ?? [], committer: { timestamp: Number.NaN } });
    expect(await isAncestorByParents({ ancestor: 'c10', descendant: 'c40', readCommit })).toBe(true);
    expect(await isAncestorByParents({ ancestor: 'c40', descendant: 'c10', readCommit })).toBe(false);
  });

  it('finds the ancestor through a parent link even when its own object is unreadable', async () => {
    const parents = new Map<string, string[]>([['R', []], ['X', ['R']], ['Y', ['X']]]);
    const { readCommit } = counted(parents, new Map(), new Set(['X']));
    expect(await isAncestorByParents({ ancestor: 'X', descendant: 'Y', readCommit })).toBe(true);
  });

  it('skips an unreadable ancestor-side commit and rejects an unreadable descendant-side one', async () => {
    const parents = new Map<string, string[]>([['R', []], ['X', ['R']], ['Y', ['X']]]);
    const ancestorSide = counted(parents, new Map(), new Set(['X']));
    expect(await isAncestorByParents({ ancestor: 'Y', descendant: 'R', readCommit: ancestorSide.readCommit })).toBe(false);
    expect(ancestorSide.reads).toContain('X');

    const descendantSide = counted(parents, new Map(), new Set(['Y']));
    await expect(isAncestorByParents({ ancestor: 'X', descendant: 'Y', readCommit: descendantSide.readCommit }))
      .rejects.toThrow(/missing Y/u);
  });

  it('skips an unreadable commit both walks reached', async () => {
    const parents = new Map<string, string[]>([['M', []], ['a', ['M']], ['b', ['M']]]);
    const { readCommit } = counted(parents, new Map(), new Set(['M']));
    expect(await isAncestorByParents({ ancestor: 'a', descendant: 'b', readCommit })).toBe(false);
  });
});
