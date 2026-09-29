export function evaluateGate({ executableGroup, formalFamilies = [], rustUnitTestsRequired = false, results }) {
  const required = ['build', 'checker', 'executable'];
  if (formalFamilies.length > 0) required.push('formal');
  if (rustUnitTestsRequired) required.push('rust');
  for (const job of required) {
    if (results[job] !== 'success') return { passed: false, reason: `${job} must succeed (received ${results[job] ?? 'missing'}).` };
  }
  for (const job of ['formal', 'rust']) {
    if (required.includes(job)) continue;
    if (!['success', 'skipped'].includes(results[job])) return { passed: false, reason: `unselected ${job} job has unexpected result ${results[job] ?? 'missing'}.` };
  }
  if (!['all', 'fast', 'plugin', 'dashboard', 'integration'].includes(executableGroup)) return { passed: false, reason: 'Executable selection is invalid.' };
  return { passed: true, reason: 'All selected validation jobs succeeded.' };
}

if (process.argv[1] && process.argv[1].endsWith('validation-gate.mjs')) {
  const input = process.env.VALIDATION_GATE_INPUT ? JSON.parse(process.env.VALIDATION_GATE_INPUT) : {
    executableGroup: process.env.EXECUTABLE_GROUP,
    formalFamilies: JSON.parse(process.env.FORMAL_FAMILIES ?? '[]'),
    rustUnitTestsRequired: process.env.RUST_REQUIRED === 'true',
    results: {
      build: process.env.BUILD_RESULT,
      checker: process.env.CHECKER_RESULT,
      executable: process.env.EXECUTABLE_RESULT,
      formal: process.env.FORMAL_RESULT,
      rust: process.env.RUST_RESULT
    }
  };
  const result = evaluateGate(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}
