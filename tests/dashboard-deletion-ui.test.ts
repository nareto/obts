import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('dashboard whole-vault deletion UI contract', () => {
  it('keeps confirmation user-entered and operation-scoped', async () => {
    const [app, client, modal, settings] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/api/client.ts', 'utf8'),
      readFile('frontend/dashboard/src/components/VaultDeletionModal.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/SettingsPage.svelte', 'utf8')
    ]);
    const deletionFlow = app.slice(app.indexOf('function openVaultDeletion'), app.indexOf('async function loadMoreDiagnostics'));
    expect(client).toContain('async deleteVault(vaultId: string, confirmation: string)');
    expect(client).toContain('body: { confirmation }');
    expect(client).not.toContain('body: { confirmation: `DELETE ${vaultId}` }');
    expect(deletionFlow).toContain('confirmation !== `DELETE ${target.vaultId}`');
    expect(deletionFlow).toContain('currentDeletionTarget(target)');
    expect(deletionFlow).toContain('api.deleteVault(target.vaultId, confirmation)');
    expect(deletionFlow).not.toContain('withRecentAuth');
    expect(modal).toContain('DELETE ${vaultId}');
    expect(modal).toContain('Git content and history');
    expect(modal).toContain('local client files, independent Bridge state, and existing backups');
    expect(modal).toContain('without a password or recent-authentication step');
    expect(modal).toContain('role="dialog"');
    expect(settings).toContain('Full vault ID');
    expect(settings).toContain('Delete this server vault');
  });

  it('keeps an in-flight dialog owned and polls receipts with no selected vault', async () => {
    const [app, modal] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/VaultDeletionModal.svelte', 'utf8')
    ]);
    expect(modal).toContain('if (closing || busy) return;');
    expect(modal).toContain('if (!busy) void cancel();');
    expect(app).toContain('async function refreshDeletionRecords()');
    expect(app).toContain("if (!vaultId) {\n      await refreshDeletionRecords();\n      return;\n    }");
  });

  it('polls deletion state with ownership guards and keeps Settings ahead of the empty-vault branch', async () => {
    const [app, shell, connection, status] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/Shell.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/ConnectionScreen.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/Status.svelte', 'utf8')
    ]);
    expect(app).toContain('api.vaultDeletions()');
    expect(app).toContain('deletionRefreshGeneration');
    expect(app).toContain('accountEpoch === account');
    expect(app).toContain('Promise.allSettled');
    expect(app).toContain('moveFromDeletedVault');
    expect(app.indexOf(":else if page === 'Settings'")).toBeLessThan(app.indexOf("{:else if vaults.length === 0}"));
    expect(app).toContain("if (value.vault.status === 'deleting') return { label: 'Deleting', role: 'info' }");
    expect(shell).toContain('vaultDeleting');
    expect(shell).toContain('>Deleting</small>');
    expect(shell).toContain('Integrity blocked');
    expect(connection).toContain("vault.status === 'deleting' ? ' — deleting'");
    expect(status).toContain("const activeStatusBases = ['Deleting'");
  });
});
