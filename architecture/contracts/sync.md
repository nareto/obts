# Synchronization Contract

## Canonical History

- Each vault has one server-authoritative `refs/heads/main`.
- Each paired device uploads through a protected `refs/obts/devices/{device_id}` ref.
- Devices create local commits but never advance server `main` directly.
- Git object identity and parent links, never timestamps, define content identity and ancestry.
- Device identity and proposal merge base remain separate; using a trusted vault commit as a base never adopts another device's ref.
- Server merge and resolution decisions are deterministic, auditable, and serialized per vault.

## Browser-Assisted Onboarding

The plugin initiates a short-lived, one-time connection request containing only redacted counts and device/vault display metadata. The authenticated owner reviews the matching verification code and selects a new or existing owned vault. No manual pairing-token dialog, plugin-stored account password, or copied reusable credential is part of normal onboarding.

Before device registration the client classifies local state as empty, identical, clean stale, divergent with trusted ancestry, or divergent without trusted ancestry. Destructive use-server paths require recovery first. Independent merge uses the server-authored empty root so remote-only and local-only paths survive and differing same-path additions conflict. A changed local snapshot invalidates stale consent and must be reviewed again.

## Local Reconciliation

The visible local vault is the device source of truth; coordination metadata is recoverable state, not authoritative content.

- Watcher-invalidated paths are durable and drive normal reconciliation.
- Immutable in-flight upload identity cannot be replaced by later watcher hints or edits.
- Metadata inventory is a bounded fallback for missed events; complete byte-level audit is separately scheduled and user-invocable.
- Cached blob identities are reused only when reliable filesystem identity and the trusted Git base still match.
- Missing or corrupt `state.json` is repaired from the valid device token and intact local Git journal before destructive work.
- Local edits are committed or recoverably snapshotted before upload.

## OBTS-SYNC-IMM-001: Immutable Transfer And Integration

One upload attempt has immutable target commit, expected device ref, proposal base, directory proposal, object plan, attempt ID, and transfer ID until an authoritative outcome is consumed.

Transfer receipt is distinct from integration. Durable chunks and processing state survive request loss and restart. Internal server processing failure remains retryable processing, not proposal rejection. Valid proposals are rejected only for authorization, integrity, unsafe path/provenance, limits/abuse, revocation, or pre-existing blocked-state failures.

Device-ref classification is:

- equal target: return the prior result or idempotent no-op;
- target descends from current device ref: accept the fast-forward;
- target is already covered: accept as superseded without moving backward;
- target diverges: protect it as conflict history without moving the device ref.

Canonical `main` movement does not invalidate a valid proposal. Each accepted proposal is evaluated against canonical state at its integration turn.

## Merge Policy

Disjoint changes merge automatically when path and directory policy agree. Same-file semantic merge is conservative:

- Markdown requires a clean or validated merge, no conflict markers, and compatible heading/block/link/frontmatter effects; same-key frontmatter changes conflict.
- JSON Canvas first requires a valid object root with `nodes` and `edges` arrays, unique node/edge IDs, valid required fields, and no dangling edge references. Nodes and edges merge as maps keyed by stable ID. One-sided add/delete/edit and disjoint-field edits merge; differing same-field edits, incompatible type changes, and delete-versus-edit/reference conflict. A one-sided reorder of surviving base IDs is accepted, equivalent concurrent reorder is accepted, and divergent concurrent reorder conflicts. One-sided additions retain their side-relative position. Accepted output is deterministic pretty JSON.
- Obsidian Bases first requires valid supported YAML. `formulas`, `properties`, and `summaries` merge as maps keyed by name; one-sided entry changes and disjoint nested-key edits merge, while differing same-key expression/value edits conflict. Top-level `filters` is one semantic field and concurrent differing edits conflict. Views are keyed by `(type,name)` and duplicate keys conflict. Any reorder of surviving base views conflicts. Same-view type, filter, or order edits and concurrent edits to plugin-specific or unknown view keys conflict when both sides changed the same view; otherwise disjoint known-key edits may merge. Accepted output is deterministic YAML.
- Binary content auto-merges only when identity is equal or paths are disjoint.
- Delete/edit, incompatible rename, file/directory hierarchy collision, unsupported, ambiguous, or unsafe cases create durable conflicts.

Every decision records base, current main, device commit, merge order, policy version, and validator results.

## Directory Intent

Git does not represent empty directories. OBTS therefore carries a causal directory proposal with stable proposal and intent identities, generations, acknowledged main/event baseline, and delete-then-create ancestry.

The server compares the proposal with the device's acknowledged explicit-directory snapshot and canonical directory state. Equivalent and disjoint operations merge; opposing same- or ancestor/descendant create/delete intent creates a directory or mixed conflict. Git and directory state settle atomically.

Clients materialize explicit directories and remove tombstones only according to `OBTS-SAF-006`. Historical state without directory intent cannot invent right-click folder deletion from a Git tree.

## Recovery And Rebuild

Lost coordination metadata is repaired before rebuild when a valid device token and intact local Git journal can recover identity and ancestry. Visible filesystem differences are captured before any destructive server apply.

When explicit replacement/rebuild is required, OBTS publishes a recovery bundle, applies canonical server state, then classifies preserved local work:

- repeated or already-covered commits settle idempotently;
- pending same-device commits that descend from the protected server device ref remain queued and upload normally;
- visible differences proven to match pending conflicted history outside already resolved paths are preserved, recommitted on current main, and submitted normally;
- uncommitted or snapshot-only differences become a new local recovery commit on rebuilt main;
- divergent same-device history that cannot fast-forward the protected device ref remains in the recovery bundle, enters blocked recovery, and is never uploaded through a non-fast-forward ref update.

Reset/reconnect without a trusted same-device cursor treats valid local content as an independent proposal from a trusted vault base, never as another device's ref identity.

## Pull And Apply

### OBTS-SYNC-ACK-001: Durable Apply Acknowledgement

A client pulls required objects and a manifest for canonical `main`, then applies through Obsidian `Vault`/`DataAdapter` APIs under a local lock and durable apply journal.

- Recovery is published before destructive file operations.
- Preflight fingerprints are checked immediately before mutation.
- OBTS-authored watcher events are suppressed or tagged.
- Seen-event and durably-applied-event cursors remain separate.
- The server advances `last_applied_main` only after explicit durable apply acknowledgement.
- Restart finishes idempotently or blocks with recovery options.
- Semantic ambiguity is never presented as a client-side winner choice.

## Conflict Review

The owner reviews server and named-device provenance, affected paths, rendered/source differences, structural path variants, and directory outcomes. Content conflicts may support server, device, keep-both, insert-both, line, or manual final results according to content kind. Structural manual resolution includes final path and content.

Submission carries conflict ID and expected current main. If main advanced, the package is stale and cannot resolve until refreshed. Accepted resolution creates a two-parent merge commit whose tree exactly represents the accepted final package while preserving non-conflicting device changes. Duplicate submission is idempotent.

Conflict resolution uses the valid dashboard session, CSRF protection, stale-review checks, and audit logging. It does not require password re-entry.

## History, Restore, And Maintenance

Note history is derived from canonical Git history plus path and provenance indexes. It covers create, update, delete, rename, merge, conflict, and restore. Markdown supports rendered and source comparison; Canvas and Bases support source comparison. Sensitive plugin content is redacted by default.

Restore creates new canonical history through the same safe merge/resolution machinery. Git maintenance verifies and repacks while retaining every object reachable from main, device, conflict, and recovery refs. No destructive history truncation exists.

## Path Policy

Canonical paths use `/`, Unicode NFC, no absolute/traversal/empty/control segments, no symlinks, and regular supported Git modes. `.obts/**`, `.obsidian/cache/**`, `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, and `.obsidian/plugins/obts/**` are deterministic hard exclusions. Any visible `.git` path segment is a sync-blocking validation error rather than a silently excluded subtree. `.trash/**`, attachments, allowed `.obsidian/**`, and other community-plugin files are normal vault content.

OS-specific filename limitations are device capability failures, not global server rejection. An incapable device blocks locally without changing canonical state.

## Event Contract

Vault events use a monotonic sequence, persistent bounded retention, authorized polling/streaming envelopes, and redacted payloads. A pruned cursor returns `410` and requires a full authorized state refresh. Event delivery never substitutes for durable apply acknowledgement.
