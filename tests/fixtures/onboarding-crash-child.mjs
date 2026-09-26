import { mobileHarness, click, waitUntil } from '../../dist/tests/helpers/mobileOnboardingHarness.js';

const [root, serverUrl, boundary] = process.argv.slice(2);
let armed = true;
const cursors = [];
async function stop(point) {
  if (!armed || point !== boundary) return;
  armed = false;
  process.send({ boundary: point });
  await new Promise(() => {});
}
const harness = await mobileHarness(root, serverUrl, { request: async (request, send) => {
  if (request.url.endsWith('/sync/pull-chunk')) cursors.push(JSON.parse(request.body).cursor);
  const response = await send();
  if (request.url.includes('/connections/') && request.url.endsWith('/complete')) await stop('accepted');
  if (request.url.endsWith('/sync/applied')) await stop('acknowledged');
  if (request.url.endsWith('/onboarding/complete')) await stop('activated');
  return response;
} });
const core = harness.core;
const rename = core.fsp.rename.bind(core.fsp);
core.fsp.rename = async (source, destination) => {
  await rename(source, destination);
  if (destination.endsWith('/onboarding.json')) {
    const journal = JSON.parse(await core.fsp.readFile(destination, 'utf8'));
    if (journal.stage === 'registering' && journal.analysis) await stop('enrollment');
    if (journal.registered_device_id) await stop('registered');
    if (journal.stage === 'uploading_proposal' && journal.proposal_commit) await stop('proposal');
  }
  if (destination.endsWith('/device-token.json')) await stop('credential');
  if (destination.endsWith('/state.json')) {
    const state = JSON.parse(await core.fsp.readFile(destination, 'utf8'));
    if (state.device_id) await stop('identity');
  }
  if (destination.endsWith('/pull-transfer.json')) {
    const checkpoint = JSON.parse(await core.fsp.readFile(destination, 'utf8'));
    if (checkpoint.complete) await stop('checkpoint');
    else if (checkpoint.next_cursor > 0) await stop('chunk');
  }
  if (/\/recovery\/rec_/.test(destination)) await stop('recovery');
  if (destination.endsWith('/apply-journal.json')) {
    const journal = JSON.parse(await core.fsp.readFile(destination, 'utf8'));
    if (journal.phase === 'committed') await stop('committed');
    if (journal.phase === 'recovery_bundle_written') await stop('apply-recovery');
  }
  if (destination.endsWith('/pending-applied-ack.json')) await stop('pending-ack');
};
const updateRef = core.updateRef.bind(core);
core.updateRef = async (...args) => {
  await updateRef(...args);
  const state = await core.readState();
  if (args[0] === 'refs/heads/local' && state.local_main && args[1] !== state.local_main) await stop('proposal-ref');
};
const displace = core.displaceApplyPath.bind(core);
core.displaceApplyPath = async (...args) => {
  await displace(...args);
  if (args[1] === 'note.md') await stop('displaced');
};
const write = core.writeTargetFilesFromJournal.bind(core);
core.writeTargetFilesFromJournal = async (...args) => { await write(...args); await stop('files'); };
try {
  const modal = await harness.open();
  const label = ['Resume setup', 'Replace local contents', 'Create vault and upload'].find(text => modal.contentEl.buttons.some(button => button.text === text));
  await click(modal, label);
  await waitUntil(() => !modal.onboardingRunning);
  if (!modal.contentEl.allText.includes('Sync is ready')) throw new Error(`Setup did not complete: ${(await core.readPendingOnboarding())?.journal.last_error_code || (await core.readState()).last_error_code || 'unknown'}`);
  process.send({ complete: true, cursors });
} catch (error) {
  process.send({ failed: error.code || error.message });
  process.exitCode = 1;
} finally {
  harness.dispose();
  process.disconnect();
}
