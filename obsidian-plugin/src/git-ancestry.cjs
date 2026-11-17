// Exact ancestry from both ends, so the cost follows the distance that decides
// the answer instead of the depth of the history.
//
// Every visited commit carries the walks that reached it: FROM_D (reachable
// from the descendant), FROM_A (reachable from the ancestor), or BOTH, called
// stale. Flags only travel along parent links, so a commit flagged FROM_A that
// is not the ancestor is a strict ancestor of it, and the acyclic history can
// never lead back down to the ancestor below it. Stale commits are expanded
// only to spread staleness, and once every queued commit is stale no remaining
// commit can be the ancestor.
//
// Committer timestamps order the exploration and nothing else: the walk always
// expands the newest queued commit, like Git's own merge-base walk, so both
// frontiers advance through the same region of history and read the same pack
// files instead of alternating between two distant packs. Parent links, never
// timestamps, define ancestry (architecture/contracts/sync.md), so a missing
// or unusable timestamp only sorts as 0.

const FROM_D = 1;
const FROM_A = 2;
const BOTH = FROM_D | FROM_A;

// Stable max-heap: higher priority first, insertion order breaks ties.
function before(a, b) {
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.order < b.order;
}

function pushEntry(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (!before(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function popEntry(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && before(heap[right], heap[left]) ? right : left;
      if (!before(heap[child], heap[index])) break;
      [heap[index], heap[child]] = [heap[child], heap[index]];
      index = child;
    }
  }
  return top;
}

async function isAncestorByParents({ ancestor, descendant, readCommit }) {
  if (ancestor === descendant) return true;
  const flags = new Map([[descendant, FROM_D], [ancestor, FROM_A]]);
  const queue = [];
  const queued = new Set();
  let order = 0;
  // Both endpoints are read first, the descendant before the ancestor.
  const enqueue = (oid, priority) => {
    queued.add(oid);
    pushEntry(queue, { oid, priority, order });
    order += 1;
  };
  enqueue(descendant, Number.POSITIVE_INFINITY);
  enqueue(ancestor, Number.POSITIVE_INFINITY);
  let nonStale = 2;
  while (nonStale > 0) {
    const oid = popEntry(queue).oid;
    queued.delete(oid);
    const reachedBy = flags.get(oid);
    if (reachedBy !== BOTH) nonStale -= 1;
    let commit;
    try {
      commit = await readCommit(oid);
    } catch (error) {
      // The ancestor side only prunes, and a FROM_A commit cannot lie on a path
      // from the descendant unless it is the ancestor, which already answered.
      if (reachedBy & FROM_A) continue;
      throw error;
    }
    const timestamp = Number(commit && commit.committer && commit.committer.timestamp);
    const priority = Number.isFinite(timestamp) ? timestamp : 0;
    for (const parent of (commit && commit.parent) || []) {
      const previous = flags.get(parent) || 0;
      const next = previous | reachedBy;
      if (next === previous) continue;
      if (parent === ancestor && (next & FROM_D)) return true;
      if (parent === descendant && (next & FROM_A)) return false;
      flags.set(parent, next);
      if (queued.has(parent)) {
        // Already queued: it keeps the priority it was queued with.
        if (previous !== BOTH && next === BOTH) nonStale -= 1;
      } else {
        enqueue(parent, priority);
        if (next !== BOTH) nonStale += 1;
      }
    }
  }
  return false;
}

module.exports = { isAncestorByParents };
