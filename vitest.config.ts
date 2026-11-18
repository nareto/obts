import { defineConfig } from 'vitest/config';
import { checkerTests, dashboardTests, fastTests, pluginTests } from './scripts/validation-groups.mjs';

const group = process.env.VITEST_GROUP;
const scopedTests = group === 'plugin' ? [...fastTests, ...pluginTests] : group === 'dashboard' ? [...fastTests, ...dashboardTests] : group === 'checker' ? checkerTests : undefined;
const excludedTests = group === 'integration' ? fastTests : group === 'ci-all' ? checkerTests : undefined;

export default defineConfig({
  test: {
    include: scopedTests ?? (group === 'fast' ? fastTests : ['tests/**/*.test.ts']),
    exclude: excludedTests,
    // A test here drives a real server, a Git repository and a second device over
    // HTTP, so it costs seconds even on an idle machine. On a shared four-core CI
    // host the slower ones crossed 30 s and failed on the deadline while still
    // making progress: a merge-recovery or crash-image case routinely ran 20-30 s.
    // The tests are unchanged; only the deadline matches the hardware again. That
    // host runs up to four pipelines at once, and with three test files in flight
    // the slowest case that still passed cost 77 s, so the same deadline now leaves
    // it the margin the sub-second cases have instead of 1.5x.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Test files run in parallel in every group. Sequential execution made the
    // whole suite cost the sum of every file (over an hour on four cores), while
    // the files themselves spend most of their time waiting on a fixture's server
    // and Git, so several files overlap almost for free.
    fileParallelism: true,
    ...(group === 'fast' ? { maxWorkers: 2 } : {})
  }
});
