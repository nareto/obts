import { retainedCatchupHarness } from '../../dist/tests/helpers/retainedCatchupHarness.js';
const requestedMode = process.argv[3] || 'ack-retired';
const mode = ['after-provenance', 'after-capture', 'before-remove', 'after-remove'].includes(requestedMode) ? requestedMode : 'ack-retired';
const { core } = await retainedCatchupHarness(process.argv[2], mode === 'ack-retired', requestedMode === 'extra');
async function pause(boundary) {
  setInterval(() => {}, 1000);
  process.send({ boundary });
  await new Promise(() => {});
}
if (mode === 'ack-retired') {
  const settle = core.settleAppliedQueue.bind(core);
  core.settleAppliedQueue = async () => { await settle(); await pause(mode); };
  try { await core.pullAndApply(true); }
  catch (error) { process.send({ failed: error.code || error.message }); process.exitCode = 1; process.disconnect(); }
} else {
  if (mode === 'after-provenance') {
    const mutate = core.mutateStaleProvenance.bind(core);
    core.mutateStaleProvenance = async (...args) => { const result = await mutate(...args); await pause(mode); return result; };
  } else if (mode === 'after-capture') {
    const preserve = core.preserveCatchupEdits.bind(core);
    core.preserveCatchupEdits = async (...args) => { const result = await preserve(...args); await pause(mode); return result; };
  } else if (mode === 'before-remove' || mode === 'after-remove') {
    const rm = core.fsp.rm.bind(core.fsp);
    core.fsp.rm = async (filePath, ...args) => {
      if (filePath === core.catchupPath) {
        if (mode === 'before-remove') await pause(mode);
        const result = await rm(filePath, ...args);
        if (mode === 'after-remove') await pause(mode);
        return result;
      }
      return rm(filePath, ...args);
    };
  } else throw new Error(`Unknown catch-up boundary ${mode}`);
  try { await core.syncOnce(); }
  catch (error) { if (!process.connected) throw error; process.send({ failed: error.code || error.message }); process.disconnect(); }
}
