# Dashboard overhaul — Signal stage 2

## Classification

Architecture revision 7 records the approved dashboard presentation contract and its frontend request-ownership safeguards. The Signal checkpoints change the shell, Overview, Devices, remaining page presentation, shared visual tokens, and related UI state handling. They do not change C4 boundaries, HTTP operations, polling cadence, sync protocol, persistence, or server-derived convergence truth. No new formal-model behavior or OpenAPI operation is introduced.

`ConflictWorkbench.svelte` and `conflictDiff.ts` remain unmodified. Shared colors and sticky offsets adapt to the shell; comparison and resolution semantics remain protected.

## Checkpoint scope

- Persistent desktop navigation and a mobile drawer with inert background, Escape/focus handling, scroll unlocking, and breakpoint focus handoff. Shared light/dark tokens respect primary-button contrast and reduced motion.
- Compact Overview summaries, independently sized panels, relative activity times, and expandable maintenance checks that do not imply backup freshness.
- Operational device tables become cards in narrow containers. Full technical identifiers remain selectable; details and keyboard-operated action menus expose their expanded state. Rename failures retain the draft; revocation states its target and consequences.
- Account/vault/request ownership guards reject superseded responses. Polling preserves unchanged conflict drafts and marks changed reviews non-submittable. Renames supersede older status snapshots. Sign-out clears local data immediately, blocks overlapping login, and exposes an honest retry on server failure.
- History, Maintenance, Settings, authentication/connection, and the conflict queue use compact responsive presentation. History restore targets are confirmed, diagnostics refresh/pagination are account-scoped, and the queue has touch-sized mobile cards. The Settings deletion UI is backed by synthetic fixtures only; it does not claim server-side deletion completion.

## Reproducible validation

Run from the repository root:

```sh
npm run check
npx vitest run tests/dashboard-live-status.test.ts tests/dashboard-presentation.test.ts tests/conflict-workbench-ui.test.ts tests/conflict-diff.test.ts
node scripts/check-formal-model.mjs --validate-only
npm run test:dashboard:browser
```

The browser command uses the development-only Playwright dependency, a loopback Vite server, and synthetic API fixtures in `tests/fixtures/dashboard.mjs`. It does not connect to a real server or use real accounts, vaults, or credentials. It checks uncaught browser errors and unexpected fixture requests, then closes the browser/server and removes its temporary Vite cache.

A Playwright-managed Chromium must already be installed, or supply an existing executable. Optional screenshot capture produces the responsive light-theme set, desktop dark theme, and mobile navigation:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
DASHBOARD_SCREENSHOT_DIR=/tmp/obts-dashboard-checkpoint \
npm run test:dashboard:browser
```

### Evidence — 2026-09-10

- `npm run check` passed, including generated-plugin freshness, TypeScript, and the dashboard build. The earlier plugin-freshness failure came from shared worktree dependencies; independent installation resolved it. Generated plugin files are unchanged.
- Four targeted Vitest files passed: 13 tests, including eight conflict-diff tests.
- Chromium passed 21/21 scenarios: responsive widths 320–1440px, drawer keyboard/resize behavior, reduced motion, dark primary-button contrast, device details/rename/revoke, history switching, stale-review preservation, refresh ownership/401, logout/login isolation, failed and reordered conflict requests, vault-creation isolation, and rename/status ordering.
- The final independent review identified four additional races. All four were reproduced as browser failures before fixing them; the complete browser run then passed. The read-only review itself did not execute Chromium.
- Formal manifest validation passed: 52 required checks, transition map, and source ranges are valid. This validates metadata, not TLC execution.
- The Phase 1 baseline completed normally: 157/157 backend tests passed in 420.24s, so it was not an import/startup hang. Other full-suite files and the chained formal checks remain unvalidated; the earlier default full-suite timeout is not treated as Phase 1 evidence.

### Stage 2 validation evidence

- `npm run check` passed, including the dashboard build.
- Four targeted Vitest files passed: 13 tests.
- Chromium passed 41/41 synthetic dashboard scenarios, including deletion dialog scope/phrase/focus/inert behavior, no recent-auth re-entry, 202 pending and retry truth, completed and last-vault receipts, deleting-versus-integrity presentation, pending last-vault polling, target 404 cleanup, in-flight modal ownership, and stale account/target response isolation alongside the earlier connection, history, diagnostics, responsive, and request-ownership regressions.
- The pre-fix regression probe recorded all four review findings: mutable Target B approval, focus escaping to Deny, approval overwriting denial, and a truncated restore commit. The fixed harness now asserts frozen targets, modal focus containment, serialized actions, full commit confirmation, and mobile DOM/visual order.
- The older diagnostics deletion race is covered by cancellation and old-account held-reauth scenarios; a same-session cancellation accepts the rotated CSRF token while suppressing deletion.
- No staged files were present; protected conflict comparison/resolution internals were unchanged.

Local review artifacts are transient and regenerable with the command above:

- Screenshots: `/tmp/obts-signal-qa/checkpoint-3/` (18 captures).
- Final browser log: `/tmp/obts-signal-qa/browser-check.log`.
- Before-fix regression log: `/tmp/obts-signal-qa/review-regressions-before.log`.
- Stage 2 follow-up before/after logs: `/tmp/obts-dashboard-stage2/ui-fixes-before.log` and `/tmp/obts-dashboard-stage2/ui-fixes-browser-final-rerun.log`.
- Phase 1 baseline evidence: `/tmp/obts-dashboard-stage2/phase1-baseline-validation.md`.
- Independent findings: `/tmp/obts-signal-qa/final-state-review.md`.
- Full-suite timeout log: `/tmp/obts-signal-qa/full-validation.log`.

## Stage 2 scope and remaining gate

The approved Signal direction now extends through the remaining page presentations. History, Maintenance, Settings, authentication/connection, and the conflict queue use compact responsive layouts while retaining the existing API and workflow semantics.

- History preserves canonical provenance, redaction, empty/loading/error states, and confirms the exact restore source and target before creating a new history entry.
- Maintenance keeps the server-derived checklist and backup contract distinction visible. Settings keeps consented redacted diagnostics and session actions together, with scoped refresh/pagination ownership.
- The conflict queue has a dense desktop table and touch-sized mobile cards; `ConflictWorkbench.svelte` and `conflictDiff.ts` remain protected and unmodified.
- The backend milestone now exposes the approved server-owned deletion lifecycle seam: typed full-ID DELETE with ordinary session CSRF, owner-scoped redacted pending/receipt status, durable intent/final receipt metadata, per-vault admission barriers, transfer ownership markers/inventory, exact Git/temp cleanup, and a Settings status seam. The Settings control surface remains intentionally minimal; it does not claim physical secure erasure or replace local client, Bridge, or backup data.
- The dashboard deletion control is now usable in the synthetic browser harness: it shows the display name and full opaque ID, requires the exact typed phrase, states the server-only boundary, omits recent-auth/password re-entry, treats 202 as pending Deleting, retains completed receipts, polls receipts even after the last vault leaves ordinary selection, keeps an in-flight modal owned, handles target 404 cleanup, and clears deleted-target presentation under guarded refresh/account transitions. No real vault or destructive server operation is used by this evidence.
- Residual backend runtime risk remains outside this UI-only change: the lifecycle review found transfer-directory inventory can fail open on non-ENOENT inspection errors and falsely permit completion. Backend deletion safety, full-suite/TLC execution, physical erasure, and production runtime behavior therefore remain separate acceptance gates; this change does not remediate or conceal those limitations. Dependency installation also reported seven vulnerabilities (three moderate, four high); no audit remediation was attempted in this checkpoint.

No merge, push, deployment, or worktree cleanup is part of this checkpoint.
