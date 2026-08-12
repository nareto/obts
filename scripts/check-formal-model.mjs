import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = join(root, 'architecture', 'models', 'formal');
const model = 'OBTSApplyRecovery';
const timeout = 60_000;
const maximumDistinctStates = 100_000;
const javaOptions = [process.env.JAVA_TOOL_OPTIONS, '-Xmx1g', '-XX:+UseParallelGC'].filter(Boolean).join(' ');
const runRoot = mkdtempSync(join(tmpdir(), 'obts-tlc-'));

const negativeControls = [
  ['negative/SkipRecovery.cfg', 'RecoveryBeforeMutation'],
  ['negative/StalePreflight.cfg', 'NoLocalVersionLost'],
  ['negative/EarlyCleanup.cfg', 'NoFalseCompletion'],
  ['negative/InferCompletion.cfg', 'NoFalseCompletion']
];

try {
  runSany();
  const safety = runTlc('OBTSApplyRecovery.cfg', 'safety');
  const liveness = runTlc('OBTSApplyRecoveryLiveness.cfg', 'liveness');
  for (const [config, invariant] of negativeControls) runNegativeControl(config, invariant);
  console.log(
    `Formal model passed: safety ${safety.distinct} states/depth ${safety.depth}; ` +
    `liveness ${liveness.distinct} states/depth ${liveness.depth}; ` +
    `${negativeControls.length} negative controls rejected.`
  );
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

function runSany() {
  const command = toolCommand('sany', [model]);
  const result = run(command);
  if (result.status !== 0) fail('SANY validation failed', result);
}

function runTlc(config, name) {
  const command = toolCommand('tlc', [
    '-cleanup',
    '-nowarning',
    '-workers',
    '1',
    '-fp',
    '0',
    '-config',
    config,
    '-metadir',
    join(runRoot, name),
    model
  ]);
  const result = run(command);
  if (result.status !== 0 || !result.output.includes('Model checking completed. No error has been found.')) {
    fail(`${name} model check failed`, result);
  }
  const stats = parseStats(result.output);
  enforceStateLimit(name, stats);
  return stats;
}

function runNegativeControl(config, invariant) {
  const name = config.split('/').at(-1).replace(/\.cfg$/u, '');
  const command = toolCommand('tlc', [
    '-cleanup',
    '-nowarning',
    '-workers',
    '1',
    '-fp',
    '0',
    '-config',
    config,
    '-metadir',
    join(runRoot, `negative-${name}`),
    model
  ]);
  const result = run(command);
  if (result.status === 0 || !result.output.includes(`Invariant ${invariant} is violated.`)) {
    fail(`negative control ${name} did not violate ${invariant}`, result);
  }
  enforceStateLimit(`negative control ${name}`, parseStats(result.output));
}

function toolCommand(tool, args) {
  const jar = process.env.TLA2TOOLS_JAR;
  if (jar) {
    return {
      executable: 'java',
      args: ['-cp', resolve(jar), tool === 'sany' ? 'tla2sany.SANY' : 'tlc2.TLC', ...args]
    };
  }
  return { executable: tool === 'sany' ? 'tla2sany' : 'tlc', args };
}

function run(command) {
  const result = spawnSync(command.executable, command.args, {
    cwd: modelDir,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, JAVA_TOOL_OPTIONS: javaOptions }
  });
  if (result.error?.code === 'ENOENT') {
    const requirement = command.executable === 'java'
      ? 'A Java 21 runtime is required when TLA2TOOLS_JAR is set.'
      : 'Install TLA+ tools that provide the tla2sany and tlc commands, or set TLA2TOOLS_JAR to a verified tla2tools.jar.';
    throw new Error(`${command.executable} is unavailable. ${requirement}`);
  }
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

function parseStats(output) {
  const stateMatch = output.match(/([0-9,]+) states generated, ([0-9,]+) distinct states found/u);
  const depthMatch = output.match(/depth of the complete state graph search is ([0-9,]+)/u);
  if (!stateMatch || !depthMatch) throw new Error(`TLC output did not contain state/depth evidence.\n${output}`);
  return {
    generated: Number(stateMatch[1].replaceAll(',', '')),
    distinct: Number(stateMatch[2].replaceAll(',', '')),
    depth: Number(depthMatch[1].replaceAll(',', ''))
  };
}

function enforceStateLimit(name, stats) {
  if (stats.distinct >= maximumDistinctStates) {
    throw new Error(`${name} model reached the ${maximumDistinctStates} distinct-state limit: ${stats.distinct}`);
  }
}

function fail(message, result) {
  throw new Error(`${message} (exit ${String(result.status)}).\n${result.output}`);
}
