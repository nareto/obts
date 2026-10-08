export function addSyntheticHistory(db, historySize) {
  const vault = db.vaults[0];
  const device = db.devices[0];
  const timestamp = new Date().toISOString();
  const padded = (row, targetBytes, field) => {
    row[field] = 'x'.repeat(Math.max(0, targetBytes - Buffer.byteLength(JSON.stringify(row, null, 2)) - 20));
    return row;
  };
  for (let index = 0; index < historySize; index++) {
    db.sync_operations.push({
      operation_id: `op_synthetic${index}`, vault_id: vault.vault_id, device_id: device.device_id,
      operation_type: 'git_maintenance', expected_refs: {}, target_refs: {}, target_commit: null,
      status: 'aborted', prepared_manifest: padded({ validator: 'synthetic' }, 1700, 'observation'),
      result: { reason: 'synthetic' }, created_at: timestamp, updated_at: timestamp
    });
    const eventSeq = (db.event_seq_by_vault[vault.vault_id] ?? 0) + 1;
    db.event_seq_by_vault[vault.vault_id] = eventSeq;
    db.events.push({
      event_id: `evt_synthetic${index}`, event_seq: eventSeq, event_type: 'device_ref_updated',
      vault_id: vault.vault_id, resource_ids: { device_id: device.device_id },
      commit_cursors: { main: vault.current_main }, payload: padded({ decision: 'synthetic' }, 400, 'observation'),
      created_at: timestamp
    });
  }
  for (let index = 0; index < Math.round(historySize * 1209 / 2124); index++) {
    db.audit_log.push({
      audit_id: `aud_synthetic${index}`, actor_user_id: device.user_id, actor_device_id: device.device_id,
      vault_id: vault.vault_id, action: 'main_advanced', resource_class: 'vault', resource_id: vault.vault_id,
      created_at: timestamp
    });
  }
  for (let index = 0; index < Math.round(historySize * 415 / 2124); index++) {
    db.diagnostic_events.push({
      schema_version: 1, event_id: `dgr_${index.toString(16).padStart(32, '0')}`,
      plugin_version: device.plugin_version ?? 'unknown', obsidian_version: 'unknown', platform_family: 'desktop',
      flow: 'sync', stage: 'sync_request', failure_code: 'request_failed', error_class: 'transport_error', retryable: true,
      breadcrumbs: [{ point: 'sync_request', outcome: 'failed', value_kind: 'unknown', size_bucket: 'unknown', error_code: 'unknown' }],
      owner_user_id: device.user_id, connection_id: null, vault_id: vault.vault_id, device_id: device.device_id,
      received_at: timestamp, expires_at: new Date(Date.now() + 86400000).toISOString()
    });
  }
  device.last_applied_event_seq = db.event_seq_by_vault[vault.vault_id] ?? 0;
  return db;
}
