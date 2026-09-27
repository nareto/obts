# Separate client observations and diagnostic admission

Status: accepted. Architecture revision: 23.

A queued upload records an immutable historical compare-and-swap baseline. Treating that value as the latest server observation can select an old backup after successful reconciliation, restore a cleared block, and prevent a pull. A process-local exception for one queue state cannot make the observation durable.

Client state recovery now separates local cursor evidence, authenticated server observations and immutable proposals. Queue agreement never ranks state generations. Actual local pointers with existing commits can justify local repair; ancestry fallback must justify every changed local cursor. One cursor cannot authorize an incomparable replacement of another. Local repair preserves primary error/status/details independently of server-ref equality. A proven newer backup with no apply journal may clear a stale local-state error; it cannot clear an unrelated server block. Failed publication propagates instead of silently returning an unmerged backup. Pending proposals, checkpoints, apply journals and acknowledgements retain their own authority.

Diagnostic acceptance uses authenticated identities rather than a shared socket-peer identity. Automatic and manually requested device reports have separate finite partitions within shared ceilings. A manual trigger remains an untrusted claim with a bounded allowance. Connection-origin reports retain their original admission lane after enrollment backfills their device association. Only persisted acceptances charge the admission ledger; duplicates and rejections do not. Payload-free admission records survive report deletion during the running process, with retained rows seeding the ledger at startup. Authentication is rechecked at queued acceptance.

The ledger remains process-local and single-instance. Reports deleted before restart cannot reconstruct prior usage. Legacy rows already filling total storage/owner limits remain protected by those limits until ordinary retention or explicit owner deletion makes space; this change does not delete them to establish the new partitions. Acceptance reservation does not promise bounded HTTP queue latency under arbitrary request flooding.

The plugin coalesces automatic reports by sanitized signature, cools down failed attempts and displays only allowlisted rejection categories. Interrupted apply notices use the retained bounded journal category instead of an absent state field; this does not authorize new retries or discard recovery evidence.

HTTP payload schemas, protocol versions, component allocation and trust boundaries remain unchanged. FM007 and FM008 model the new bounded ownership/admission decisions; their limits and implementation mappings are recorded alongside them. Physical-device recovery remains a separate release requirement.
