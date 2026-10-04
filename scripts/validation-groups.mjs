export const fastTests = [
  'tests/conflict-diff.test.ts',
  'tests/dashboard-presentation.test.ts',
  'tests/headless-protocol.test.ts',
  'tests/plugin-mobile-fs.test.ts',
  'tests/work-pool.test.ts',
  'tests/path-mutation-gate.test.ts',
  'tests/conflict-workbench-ui.test.ts',
  'tests/dashboard-deletion-ui.test.ts',
  'tests/dashboard-live-status.test.ts',
  'tests/openapi-contract.test.ts'
];

export const pluginTests = [
  'tests/plugin-in-place-apply.test.ts',
  'tests/plugin-apply-progress.test.ts',
  'tests/plugin-adapter-write-gate.test.ts',
  'tests/plugin-stale-proposal.test.ts',
  'tests/plugin-upload-recovery.test.ts',
  'tests/plugin-mobile-build.test.ts',
  'tests/plugin-packaged-client.test.ts',
  'tests/plugin-root-ignore-scan.test.ts',
  'tests/plugin-root-ignore-apply.test.ts',
  'tests/managed-headless-ownership.test.ts',
  'tests/managed-headless-reporting.test.ts',
  'tests/client-state-authority.test.ts',
  'tests/applied-ack-barrier.test.ts'
];

export const dashboardTests = ['tests/vault-deletion.test.ts'];

export const checkerTests = [
  'tests/formal-checker.test.ts',
  'tests/formal-bounded-body.test.ts',
  'tests/formal-embedding-worker.test.ts',
  'tests/formal-deletion-checker.test.ts',
  'tests/formal-external-protocol-tooling.test.ts',
  'tests/validation-selection.test.ts'
];

export const formalFamilies = [
  'sync', 'bridge-body', 'workers', 'deletion', 'bridge-protocol', 'onboarding', 'diagnostics', 'client-state', 'vault-settings', 'headless-ownership'
];
