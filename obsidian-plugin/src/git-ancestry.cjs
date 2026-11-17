// Exact ancestry from both ends, so the cost follows the distance that decides
// the answer instead of the depth of the history.
//
// Every visited commit carries the walks that reached it: FROM_D (reachable
// from the descendant), FROM_A (reachable from the ancestor), or BOTH, called
// stale. Flags only travel along parent links, so a commit flagged FROM_A that
// is not the ancestor is a strict ancestor of it, and the acyclic history can
// never lead back down to the ancestor below it. Stale commits are expanded
// only to spread staleness, and once every queued commit is stale no remaining
// commit can be the ancestor. Traversal order changes only the cost.

const FROM_D = 1;
const FROM_A = 2;
const BOTH = FROM_D | FROM_A;

async function isAncestorByParents({ ancestor, descendant, readParents }) {
  if (ancestor === descendant) return true;
  const flags = new Map([[descendant, FROM_D], [ancestor, FROM_A]]);
  const queue = [descendant, ancestor];
  const queued = new Set(queue);
  let nonStale = queue.length;
  while (nonStale > 0) {
    const oid = queue.shift();
    queued.delete(oid);
    const reachedBy = flags.get(oid);
    if (reachedBy !== BOTH) nonStale -= 1;
    let parents;
    try {
      parents = await readParents(oid);
    } catch (error) {
      // The ancestor side only prunes, and a FROM_A commit cannot lie on a path
      // from the descendant unless it is the ancestor, which already answered.
      if (reachedBy & FROM_A) continue;
      throw error;
    }
    for (const parent of parents) {
      const previous = flags.get(parent) || 0;
      const next = previous | reachedBy;
      if (next === previous) continue;
      if (parent === ancestor && (next & FROM_D)) return true;
      if (parent === descendant && (next & FROM_A)) return false;
      flags.set(parent, next);
      if (queued.has(parent)) {
        if (previous !== BOTH && next === BOTH) nonStale -= 1;
      } else {
        queue.push(parent);
        queued.add(parent);
        if (next !== BOTH) nonStale += 1;
      }
    }
  }
  return false;
}

module.exports = { isAncestorByParents };
