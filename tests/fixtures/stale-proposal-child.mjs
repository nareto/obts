import { ObtsPluginClient } from '../../dist/src/client/core.js';

const [dir, url, seam] = process.argv.slice(2);
const client = new ObtsPluginClient(dir, { serverUrl: url, deviceName: 'stale-client' });
const core = client.client;
await client.initialize();
const stop = async () => {
  setInterval(() => {}, 1000); // Keep the seam live until the parent sends SIGKILL.
  process.send({ seam });
  await new Promise(() => {});
};
if (seam === 'held-rebuild') { await core.rebuildFromServerMain(); await stop(); }
if (seam === 'journal') core.writeTargetFilesFromJournal = stop;
if (seam === 'horizon') core.clearApplyState = stop;
if (seam === 'obligation') core.createStaleCohortCommit = stop;
if (seam === 'queued') core.writeState = stop;
if (seam === 'upload') {
  const put = core.putPushChunk.bind(core);
  core.putPushChunk = async (...args) => { await put(...args); await stop(); };
}
if (seam === 'replacement-intent' || seam === 'replacement-ref') {
  const updateRef = core.updateRef.bind(core);
  core.updateRef = async (ref, ...args) => {
    if (ref === 'refs/heads/local' && seam === 'replacement-intent') await stop();
    const result = await updateRef(ref, ...args);
    if (ref === 'refs/heads/local' && seam === 'replacement-ref') await stop();
    return result;
  };
  const queue = await client.readQueue();
  await core.rebuildQueuedCommitForRootPolicy(queue.pending_commit, await client.readState(), queue);
} else if (seam === 'accepted-record' || seam === 'accepted-clear') {
  if (seam === 'accepted-record') {
    const record = core.recordStaleProposalResult.bind(core);
    core.recordStaleProposalResult = async (...args) => { await record(...args); await stop(); };
  } else {
    const update = core.updateQueue.bind(core);
    core.updateQueue = async (...args) => {
      const result = await update(...args);
      if (!result.pending_commit && (await core.readStaleProvenance()).accepted_proposal) await stop();
      return result;
    };
  }
  await core.uploadQueuedCommit(await client.readQueue());
} else if (seam === 'journal' || seam === 'horizon') await core.pullAndApply(true);
else if (seam === 'upload') await core.uploadQueuedCommit(await client.readQueue());
else {
  const state = await client.readState();
  await core.queueStaleCohort(state.local_main, state.server_device_ref);
}
throw new Error('The selected durable seam was not reached');
