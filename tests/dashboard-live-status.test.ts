import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('dashboard live device status', () => {
  it('refreshes server-derived status instead of ageing cached device reports locally', async () => {
    const [app, shell, overview, deviceTable, status] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/Shell.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/Overview.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/DeviceTable.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/Status.svelte', 'utf8')
    ]);

    expect(app).toContain('DASHBOARD_REFRESH_INTERVAL_MS = 15 * 1000');
    expect(app).toContain('refreshDashboardStatus()');
    expect(app).toContain("document.addEventListener('visibilitychange', refreshWhenVisible)");
    expect(app).toContain("window.addEventListener('focus', refreshWhenVisible)");
    expect(app).toContain('dashboardRefreshGeneration');
    expect(app).toContain('dashboardStatusCurrent = false');
    expect(app).toContain('api.conflicts(requestedVaultId)');
    expect(app).not.toContain('effectiveStatusLabel');
    const backgroundRefresh = app.slice(app.indexOf('async function refreshDashboardStatus'), app.indexOf('async function refreshVault'));
    expect(backgroundRefresh).not.toContain('reconcileConflictSelection');
    expect(app).toContain('requestRefreshVault');
    expect(app).toContain('dashboard = null');
    expect(app).toContain('const deviceName = device.device_name');
    expect(app).toContain('confirm(`Revoke ${deviceName}? This stops its sync access. Local vault files are not deleted.`)');
    expect(deviceTable).toContain('<Status label={effectiveStatus(device)} />');
    expect(deviceTable).toContain("if (!statusCurrent) return 'Status unknown'");
    expect(deviceTable).toContain("device.status === 'revoked' ? 'Revoked' : device.status_label");
    expect(deviceTable).toContain('device.status_report_fresh');
    expect(deviceTable).toContain('scope="col">Plugin</th>');
    expect(deviceTable).toContain("{device.plugin_version ?? 'Unknown'}");
    expect(deviceTable).toContain('class:success={device.plugin_version === recommendedPluginVersion}');
    expect(deviceTable).toContain('class:warning={device.plugin_version !== recommendedPluginVersion}');
    expect(deviceTable).toContain("disabled={renameBusy || device.status === 'revoked'}");
    expect(deviceTable).toContain('expandedDeviceId');
    expect(overview).toContain('recommendedPluginVersion={dashboard.recommended_plugin_version}');
    expect(app).toContain('isActiveStatusLabel(device.status_label)');
    expect(status).toContain('value.startsWith(`${base} `)');
    expect(deviceTable).not.toContain('nowMs');
    expect(deviceTable).not.toContain('Date.parse(device.last_status_report_at)');
    expect(shell).toContain('drawer-backdrop');
    expect(shell).toContain("event.key === 'Escape'");
    expect(shell).toContain("document.body.style.overflow = 'hidden'");
    expect(app).toContain('conflicts = []');
  });
});
