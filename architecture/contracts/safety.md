# Safety Contract

## OBTS-SAF-001: Captured Local Versions Remain Recoverable

Once OBTS acknowledges a coherent local-content version as captured, that exact version remains recoverable from at least one discoverable preservation root until the owner explicitly authorizes its deletion.

Preservation roots are:

- the visible local file or directory state;
- reachable local Git state under `.obts/git`;
- a complete, checksum-verifiable recovery bundle;
- a durable received or processing server proposal;
- a protected server device, conflict, recovery, or canonical-history ref.

Recoverability requires content bytes plus enough path, identity, and provenance information to restore the version. A status label, unverified manifest, commit ID without reachable objects, or metadata row without its Git state is not a preservation root.

## Capture Boundary

A filesystem watcher event is not capture. A version is captured only after OBTS has:

1. flushed relevant editor buffers when the host permits it;
2. obtained one coherent local snapshot;
3. durably published that snapshot as reachable local Git or complete recovery evidence; and
4. persisted enough coordination state to discover it after restart.

Edits that exist only in an application buffer before the capture boundary are outside this guarantee. Total loss of the only device before any off-device preservation root exists is also outside the synchronization guarantee and belongs to independent backup risk.

## Derived Safety Properties

### OBTS-SAF-002: Destructive Apply Requires Recovery

Before overwriting, deleting, renaming, rebuilding, or replacing syncable local content, OBTS must publish complete recovery evidence for every affected captured local version. Failure to create or verify that evidence blocks the operation.

Immediately before each mutation, OBTS revalidates the affected path identity. Unexpected local changes stop the apply or become separately preserved local work; they are never overwritten because an earlier preflight succeeded.

### OBTS-SAF-003: Uploaded Proposals Remain Reachable

Authentication, validation, ref movement, retry, timeout, disconnect, server restart, and merge classification must not discard valid durably received proposal bytes. Equal and covered history is idempotent, descendants may advance the protected device ref, and divergence becomes protected conflict history. Canonical `main` movement changes integration input, not whether accepted bytes remain preserved.

### OBTS-SAF-004: Git And Directory Outcomes Are Atomic

A proposal's Git content and causal explicit-directory outcome are accepted or conflicted as one canonical operation. Recovery must not expose a Git ref movement without the prepared directory, event, conflict, and acknowledgement effects required to finish it.

### OBTS-SAF-005: Restart Rolls Forward Or Blocks

After process termination or inconsistent durable state, startup may resume idempotently, roll forward an already-committed durable transition, or block with preserved recovery evidence. It must not infer completion from an incomplete phase, choose a semantic winner, move refs backward, or clear the last preservation root.

### OBTS-SAF-006: Physical Directory Deletion Is Non-Recursive And Identity-Safe

Canonical directory deletion never authorizes recursive local deletion. Clients remove only pre-existing empty directories, deepest first, after identity and emptiness revalidation. New files, non-empty descendants, changed identities, or unsupported inspection block deletion or become local work.

### OBTS-SAF-007: Recovery And Restore Are Forward-Only

Conflict resolution, note restore, and any future reversal operation advance canonical history through new commits or explicit durable outcomes. They do not rewrite published history or reset refs over later work.

## Fault Model

Required safety analysis and testing cover:

- process termination and restart at every durable phase;
- duplicate, delayed, reordered, lost, and retried network requests or replies;
- stale main, device-ref, event, and directory baselines;
- transient and persistent Git failures;
- disk-full, permission, missing-file, truncated/corrupt-state, and failed-publication errors;
- plugin reload and foreground mobile suspension;
- concurrent local edits during scan, transfer, and apply;
- partial metadata/Git backup restore and inconsistent projections.

Explicit exclusions unless separately mitigated are malicious trusted operators, compromised live server code, simultaneous destruction of all preservation roots, undetectable hardware corruption, and unsaved editor-buffer loss before capture.

## Formalization Policy

Formal models may refine these IDs but never redefine them silently. `OBTS-FM-001` covers `OBTS-SAF-001`, `OBTS-SAF-002`, and `OBTS-SAF-005` for one client, one path, a concurrent local edit, recovery publication, apply phases, one crash, and restart. Its `PublishInitialBundle` and `PublishPostWriteBundle` actions explicitly state the complete, flushed, checksum-verifiable, atomically published storage guarantee they assume; the model does not prove that the implementation or a platform realizes that guarantee.
