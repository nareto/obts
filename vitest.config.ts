import { defineConfig } from 'vitest/config';
import { checkerTests, dashboardTests, fastTests, pluginTests } from './scripts/validation-groups.mjs';

const group = process.env.VITEST_GROUP;
const scopedTests = group === 'plugin' ? [...fastTests, ...pluginTests] : group === 'dashboard' ? [...fastTests, ...dashboardTests] : group === 'checker' ? checkerTests : undefined;
const excludedTests = group === 'integration' ? fastTests : group === 'ci-all' ? checkerTests : undefined;

export default defineConfig({
  test: {
    include: scopedTests ?? (group === 'fast' ? fastTests : ['tests/**/*.test.ts']),
    exclude: excludedTests,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: group === 'fast',
    ...(group === 'fast' ? { maxWorkers: 2 } : {})
  }
});
