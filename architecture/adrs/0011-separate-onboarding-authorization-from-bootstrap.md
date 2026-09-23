# ADR 0011: Separate onboarding authorization from bootstrap transfer

- Status: Accepted
- Date: 2026-09-22
- Architecture revision: 13

## Context

Existing-vault onboarding used one ten-minute browser connection for authorization, remote bootstrap analysis, local classification, user confirmation, device registration, and initial transfer. Approval did not renew the deadline. Mobile suspension or a sufficiently large vault could therefore expire an approved setup before registration. The empty-local use-server path downloaded the server object graph during analysis and then pulled it again after registration. Completion also required canonical `main` to remain equal to the approval-time head, so normal edits by an already paired device invalidated destructive replacement consent.

The supervised Bridge amplified the same lifecycle error by treating a long headless operation as one five-minute request. A timeout killed the Node process even when chunk import or local recovery was progressing. Client transfer checkpoints removed the final-chunk record before the next durable onboarding/apply boundary, allowing a crash in that gap to restart a complete transfer.

## Decision

Separate browser authorization from device bootstrap.

An unapproved connection retains the ten-minute one-time deadline. Approval pins an immutable selected-vault baseline and atomically replaces the pending deadline with a finite one-hour enrollment lease. Polling does not renew the lease. Device registration consumes the connection before bulk transfer; subsequent pull, apply, acknowledgement, restart, and catch-up use the scoped device credential. An initializing device remains restricted from ordinary proposal publication until onboarding completes.

An empty local vault selected for an existing server vault is classified without downloading remote objects. Use-server validates the submitted baseline against the approval-pinned baseline but does not require equality with the current canonical head. It registers once, pulls a resumable immutable snapshot through the device protocol, applies it with required local recovery, and catches up to newer canonical state. The device remains initializing until the current canonical head is durably applied and acknowledged; activation serializes with canonical mutation, and a concurrent canonical advance rejects activation and drives another catch-up pass. Non-empty merge analysis and registration likewise use the pinned trusted baseline rather than requiring equality with a later canonical head, while retaining changed-local-snapshot consent checks; ordinary merge/conflict processing incorporates subsequent canonical changes.

Terminal pre-registration expiry or denial remains a durable local onboarding result until explicit restart or cancellation. Imported transfer chunks publish monotonic checkpoints; a complete final manifest remains durable until the next equivalent or later onboarding/apply boundary is published.

The Node headless client emits redacted startup and operation progress, including repeated heartbeats while server-side work remains active. Rust supervision treats its configured limit as an inactivity timeout reset by each closed-schema protocol event, including during startup recovery, rather than a whole-command deadline. Request writes, complete stdout frames, and response reads are bounded; cancellation, silence, extra fields, oversized frames, or invalid protocol traffic quarantines the child. Progress never changes durable onboarding authority, which remains under `.obts/`.

## Formalization

`OBTS-FM-006` (`architecture/models/formal/OBTSOnboarding.tla`) is the focused bounded refinement of `OBTS-SYNC-ONB-001`, `OBTS-SAF-002`, `OBTS-SAF-005`, and `OBTS-SAF-009`. It separates pending and approved clocks, pins one immutable baseline while canonical state may advance, consumes authorization at registration, transfers with a durable cursor/final checkpoint, preserves non-empty local state before apply, and resumes after one crash without returning a registered device to browser approval.

Positive safety and liveness checks cover empty and non-empty local state. Reachability and negative controls cover crash/restart, reuse of the pending deadline after approval, snapshot retargeting, transfer before registration, apply before recovery, and final-checkpoint removal before the next durable phase. The model does not prove cryptography, Git object/manifest correctness, iOS scheduling, filesystem durability, HTTP proxy behavior, or implementation conformance.

## Consequences

- First-time empty-vault use-server onboarding performs one server bulk transfer after registration.
- Existing clients may advance canonical `main` during onboarding; the new device applies its pinned/canonical transfer and catches up without reapproval.
- Approved connections remain finite and revocable without forcing data-plane work into the browser authorization window.
- Abandoned initializing devices are visible and revocable; ordinary proposal upload remains blocked until onboarding completion.
- Progress events are liveness signals only and contain no paths, content, credentials, or manifests.
- Real iOS suspension, throttled Bridge transfer, moving-main, and final-chunk kill/restart remain mandatory deployment evidence.
