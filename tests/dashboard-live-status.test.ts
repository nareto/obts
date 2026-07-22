import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('dashboard live device status', () => {
  it('refreshes server-derived status instead of ageing cached device reports locally', async () => {
    const [app, deviceTable] = await Promise.all([
      readFile('frontend/dashboard/src/App.svelte', 'utf8'),
      readFile('frontend/dashboard/src/components/DeviceTable.svelte', 'utf8')
    ]);

    expect(app).toContain('DASHBOARD_REFRESH_INTERVAL_MS = 15 * 1000');
    expect(app).toContain('refreshDashboardStatus()');
    expect(app).toContain("document.addEventListener('visibilitychange', refreshWhenVisible)");
    expect(app).toContain("window.addEventListener('focus', refreshWhenVisible)");
    expect(app).toContain('dashboardRefreshGeneration');
    expect(app).toContain('dashboardStatusCurrent = false');
    expect(app).toContain('api.conflicts(requestedVaultId)');
    expect(app).not.toContain('effectiveStatusLabel');
    expect(deviceTable).toContain('<Status label={effectiveStatus(device)} />');
    expect(deviceTable).toContain("statusCurrent ? device.status_label : 'Status unknown'");
    expect(deviceTable).toContain('device.status_report_fresh');
    expect(deviceTable).not.toContain('nowMs');
    expect(deviceTable).not.toContain('Date.parse(device.last_status_report_at)');
  });
});
