# Synchronization Contract

## Canonical History

- Each vault has one server-authoritative `refs/heads/main`.
- Each paired device uploads through a protected `refs/obts/devices/{device_id}` ref.
- Devices create local commits but never advance server `main` directly.
- Git object identity and parent links, never timestamps, define content identity and ancestry.
- Device identity and proposal merge base remain separate; using a trusted vault commit as a base never adopts another device's ref.
- The vault-root `.gitignore` is plugin-managed shared content edited in Obsidian settings; it is never a server setting or a per-device exclusion override.
- Server merge and resolution decisions are deterministic, auditable, and serialized per vault.

## Browser-Assisted Onboarding

### OBTS-SYNC-ONB-001: Durable Enrollment Before Bulk Transfer

The plugin initiates a short-lived, one-time connection request containing only redacted counts and device/vault display metadata. The authenticated owner reviews the matching verification code and selects a new or existing owned vault. Approval pins an immutable enrollment baseline for the selected vault and starts the finite approved-enrollment lease defined by the security contract. No manual pairing-token dialog, plugin-stored account password, or copied reusable credential is part of normal onboarding.

Before device registration the client classifies local state as empty, identical, clean stale, divergent with trusted ancestry, or divergent without trusted ancestry. An empty local vault joining an existing server vault is classified from the coherent local snapshot and approved server metadata without downloading remote objects. Non-empty classification that needs ancestry or byte identity uses the approval-pinned baseline; it must not silently retarget when canonical `main` advances.

Destructive use-server paths require recovery first. Use-server consent authorizes replacement from the selected server vault, not replacement with only the exact head visible at approval. Completion validates the submitted baseline against the approved baseline, registers an initializing device, and consumes the browser connection before bulk transfer. The device then pulls and applies a resumable immutable server snapshot and catches up to newer canonical state. It becomes active only through an atomic check that the current canonical head is durably applied and acknowledged; a concurrent advance keeps it initializing and requires another pull/apply/acknowledgement pass. Canonical `main` movement after approval does not require reapproval and does not invalidate use-server consent.

Independent merge uses the server-authored empty root so remote-only and local-only paths survive and differing same-path additions conflict. A changed local snapshot invalidates stale consent and must be reviewed again. An expired or denied pre-registration attempt remains a durable terminal local onboarding state until the user explicitly restarts or cancels it; it is never presented as registered-device recovery.

## Local Reconciliation

The visible local vault is the device source of truth; coordination metadata is recoverable state, not authoritative content. Each client owns a separate local vault, potentially on a separate operating system; other clients cannot write it directly. Cross-client changes pass through the server and are applied by the receiving client. In the Bridge client, its Rust API and embedded headless client coordinate their writes to their shared local vault; independently editing the Bridge volume is outside the supported topology.

- Watcher-invalidated paths are durable and drive normal reconciliation.
- Immutable in-flight upload identity cannot be replaced by later watcher hints or edits.
- Metadata inventory is a bounded fallback for missed events; complete byte-level audit is separately scheduled and user-invocable.
- Cached blob identities are reused only when reliable filesystem identity and the trusted Git base still match.
- Missing or corrupt `state.json` is repaired from the valid device token and intact local Git journal before destructive work.
- Local edits are committed or recoverably snapshotted before upload.

## OBTS-SYNC-IMM-001: Immutable Transfer And Integration

One upload attempt has immutable target commit, expected device ref, proposal base, directory proposal, object plan, root-ignore policy identity, attempt ID, and transfer ID until an authoritative outcome is consumed.

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
- Delete/edit, incompatible rename, file/directory hierarchy collision, unsupported, ambiguous, or unsafe cases create durable conflicts. Pull manifests list every changed syncable path, including both source and destination of a rename, so replacement and recovery cover deletions as well as new content.

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

### OBTS-SYNC-IGN-001: Version-Bound Root Exclusions

Only the vault-root `.gitignore` defines user exclusions. It is itself syncable even if a rule would match it. Apply standard Git ignore matching for root-file patterns, including negation, slash anchoring, `**`, escaping and directory rules, to canonical NFC `/` paths with case-sensitive matching on every platform. An absent file means no user exclusions. An unreadable, invalid or over-budget policy fails closed; neither the client nor server guesses a narrower interpretation. Hard exclusions always prevail, and visible `.git` remains a validation error. Nested `.gitignore` files are ordinary synced files, not policy sources. The implementation and supported rule-size budget are versioned and parity-tested across plugin, server and Bridge.

A coherent local snapshot pins the exact root policy bytes and their Git blob identity before constructing a candidate tree. The policy never prevents a user's local write on any client, including Bridge. A newly ignored tracked path is omitted from that tree without deleting its visible local copy. The policy file and its blob identity are part of the immutable upload attempt and durable transfer checkpoint; later edits create a new attempt. An unaccepted queued attempt whose pinned policy the current local root file no longer matches is rebuilt under the current policy before packing when its retained ancestry is exactly the accepted device ref, so newly excluded paths never enter the uploaded pack; content already accepted into shared history remains subject to the reviewed reconciliation path. The server verifies the attested policy against the proposed Git tree in quarantine and rejects a candidate that still contains excluded paths, including entries in ignored subtrees. It never silently strips proposal content. A completed received transfer remains queryable and protected even if a later policy change prevents integration.

The canonical `main` tree is valid under its own root policy. A policy-changing proposal reconciles newly excluded tracked paths by a forward-only canonical transition; prior bytes remain reachable in history and protected refs. A moving canonical policy cannot silently reinterpret an accepted in-flight proposal: a differing concurrent policy edit, or a candidate whose retained paths would become excluded by current canonical policy, enters protected conflict/review or a recoverable blocked outcome before any canonical ref move. Resolution and restore validate their complete final tree under its resulting policy. Unignoring does not resurrect an old canonical version automatically: each independently retained local copy is proposed from its actual content and normal add/add or edit conflict review preserves divergent copies.

Before any canonical policy transition that removes synced content, server admission requires a capable plugin/headless protocol on pull, acknowledgement, onboarding, push/finalize and recovery. An enrolled offline old client may remain paired but is barred from unsafe sync until it upgrades; no forced reset or silent revocation is authorized. Capability evidence is bound to authenticated device operations, not an untrusted status label alone. Pull manifests, apply journals and Bridge projections bind the target policy identity. A removal caused by the target ignore policy is local-only disposition, never a physical deletion; an unrelated ordinary deletion remains a deletion. Apply and restart honor the recorded disposition rather than interpreting a newer mutable `.gitignore`. A file/directory collision involving preserved local-only content blocks pending explicit reconciliation and cannot use a recursive directory delete as a shortcut.

## Event Contract

Vault events use a monotonic sequence, persistent bounded retention, authorized polling/streaming envelopes, and redacted payloads. A pruned cursor returns `410` and requires a full authorized state refresh. Event delivery never substitutes for durable apply acknowledgement.
