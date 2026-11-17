import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
type ReadParents = (oid: string) => Promise<string[]>;
const { isAncestorByParents } = require('../obsidian-plugin/src/git-ancestry.cjs') as {
  isAncestorByParents(options: { ancestor: string; descendant: string; readParents: ReadParents }): Promise<boolean>;
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

function counted(parents: Map<string, string[]>, missing: Set<string> = new Set()) {
  const reads: string[] = [];
  const readParents: ReadParents = async (oid) => {
    reads.push(oid);
    if (missing.has(oid)) throw Object.assign(new Error(`missing ${oid}`), { code: 'NotFoundError' });
    return parents.get(oid) ?? [];
  };
  return { readParents, reads };
}

describe('two-sided ancestry walk', () => {
  it('agrees with reference reachability for every ordered pair of a seeded DAG', async () => {
    let pairs = 0;
    for (let seed = 1; seed <= 24; seed += 1) {
      const { ids, parents } = dag(seed, 36);
      const readParents: ReadParents = async (oid) => parents.get(oid) ?? [];
      for (const ancestor of ids) {
        for (const descendant of ids) {
          const expected = referenceIsAncestor(parents, ancestor, descendant);
          expect(await isAncestorByParents({ ancestor, descendant, readParents })).toBe(expected);
          pairs += 1;
        }
      }
    }
    expect(pairs).toBe(24 * 36 * 36);
  });

  it('reads a bounded number of commits for nearby pairs on a long chain in both directions', async () => {
    const parents = chain(5000);
    const tip = 'c4999';
    for (const distance of [1, 10]) {
      const older = `c${4999 - distance}`;
      const forward = counted(parents);
      expect(await isAncestorByParents({ ancestor: tip, descendant: older, readParents: forward.readParents })).toBe(false);
      expect(forward.reads.length).toBeLessThanOrEqual(4 * distance + 4);

      const backward = counted(parents);
      expect(await isAncestorByParents({ ancestor: older, descendant: tip, readParents: backward.readParents })).toBe(true);
      expect(backward.reads.length).toBeLessThanOrEqual(4 * distance + 4);
    }
  });

  it('stops at the fork for a divergent pair near the tip and walks the distance for ancestors on a branch', async () => {
    const parents = chain(5000);
    const fork = 'c4990';
    for (let index = 1; index <= 5; index += 1) {
      parents.set(`a${index}`, [index === 1 ? fork : `a${index - 1}`]);
      parents.set(`b${index}`, [index === 1 ? fork : `b${index - 1}`]);
    }
    const divergent = counted(parents);
    expect(await isAncestorByParents({ ancestor: 'a5', descendant: 'b5', readParents: divergent.readParents })).toBe(false);
    expect(divergent.reads.length).toBeLessThan(60);

    const branch = counted(parents);
    expect(await isAncestorByParents({ ancestor: 'a2', descendant: 'a5', readParents: branch.readParents })).toBe(true);
    expect(branch.reads.length).toBeLessThanOrEqual(4 * 3 + 4);
  });

  it('walks disconnected roots fully and still answers false', async () => {
    const parents = chain(400);
    parents.set('x0', []);
    for (let index = 1; index <= 100; index += 1) parents.set(`x${index}`, [`x${index - 1}`]);
    const { readParents } = counted(parents);
    expect(await isAncestorByParents({ ancestor: 'x100', descendant: 'c399', readParents })).toBe(false);
    expect(await isAncestorByParents({ ancestor: 'c399', descendant: 'x100', readParents })).toBe(false);
  });

  it('finds the ancestor through a parent link even when its own object is unreadable', async () => {
    const parents = new Map<string, string[]>([['R', []], ['X', ['R']], ['Y', ['X']]]);
    const { readParents } = counted(parents, new Set(['X']));
    expect(await isAncestorByParents({ ancestor: 'X', descendant: 'Y', readParents })).toBe(true);
  });

  it('skips an unreadable ancestor-side commit and rejects an unreadable descendant-side one', async () => {
    const parents = new Map<string, string[]>([['R', []], ['X', ['R']], ['Y', ['X']]]);
    const ancestorSide = counted(parents, new Set(['X']));
    expect(await isAncestorByParents({ ancestor: 'Y', descendant: 'R', readParents: ancestorSide.readParents })).toBe(false);
    expect(ancestorSide.reads).toContain('X');

    const descendantSide = counted(parents, new Set(['Y']));
    await expect(isAncestorByParents({ ancestor: 'X', descendant: 'Y', readParents: descendantSide.readParents }))
      .rejects.toThrow(/missing Y/u);
  });

  it('skips an unreadable commit both walks reached', async () => {
    const parents = new Map<string, string[]>([['M', []], ['a', ['M']], ['b', ['M']]]);
    const { readParents } = counted(parents, new Set(['M']));
    expect(await isAncestorByParents({ ancestor: 'a', descendant: 'b', readParents })).toBe(false);
  });
});
