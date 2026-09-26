import { retainedCatchupHarness } from '../../dist/tests/helpers/retainedCatchupHarness.js';
const { core } = await retainedCatchupHarness(process.argv[2], true, process.argv[3] === 'extra');
const settle = core.settleAppliedQueue.bind(core);
core.settleAppliedQueue = async () => {
  await settle();
  setInterval(() => {}, 1000);
  process.send({ boundary: 'ack-retired' });
  await new Promise(() => {});
};
try { await core.pullAndApply(true); }
catch (error) { process.send({ failed: error.code || error.message }); process.exitCode = 1; process.disconnect(); }
