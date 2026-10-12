<script lang="ts">
  import type { DashboardDevice } from '../api/types';
  import { exactTime, relativeTime, removalFailureText } from '../presentation';
  import Icon from './Icon.svelte';
  import Status from './Status.svelte';

  export let devices: DashboardDevice[];
  export let disabled = false;
  export let onRemove: (device: DashboardDevice, trigger: HTMLElement) => void;

  function removalLabel(device: DashboardDevice) {
    const removal = device.removal ?? null;
    if (!removal) return 'Remove permanently';
    if (removal.state === 'pending') return 'Removal in progress';
    return removal.retryable ? 'Removal failed — Retry' : 'Needs your decision';
  }

  function removalHint(device: DashboardDevice) {
    const removal = device.removal ?? null;
    if (!removal) return '';
    if (removal.state === 'pending') return 'The server is removing this device. This page updates when it finishes.';
    const reason = removalFailureText(removal.error_code);
    return removal.retryable
      ? `${reason} You can retry it.`
      : `${reason} It cannot be retried automatically; open it to see your options.`;
  }
</script>

{#if devices.length === 0}
  <div class="revoked-empty" role="status">
    <strong>No revoked devices</strong>
    <p class="muted">When you revoke a device it moves here. From here you can remove it permanently, which deletes its identity, credentials and pending transfer data.</p>
  </div>
{:else}
  <ul class="revoked-list" aria-label="Revoked devices">
    {#each devices as device (device.device_id)}
      {@const removal = device.removal ?? null}
      <li class="revoked-device" data-device-id={device.device_id}>
        <div class="revoked-head">
          <div class="revoked-title">
            <strong title={device.device_name}>{device.device_name}</strong>
            <Status label="Revoked" />
          </div>
          <button class="icon-button device-actions-trigger" disabled title="Revoked devices cannot be renamed or revoked again" aria-label={`${device.device_name} actions`}><Icon name="more" size={17} /></button>
        </div>
        <p class="mono revoked-id" aria-label={`Device ID ${device.device_id}`}>{device.device_id}</p>
        <dl class="revoked-facts">
          {#if device.revoked_at}
            <div><dt>Revoked at</dt><dd><time datetime={device.revoked_at} title={exactTime(device.revoked_at)} aria-label={`Revoked ${relativeTime(device.revoked_at)}; ${exactTime(device.revoked_at)}`}>{relativeTime(device.revoked_at)}</time></dd></div>
          {/if}
          <div>
            <dt>Last seen</dt>
            <dd>
              {#if device.last_seen_at}
                <time datetime={device.last_seen_at} title={exactTime(device.last_seen_at)} aria-label={`Last seen ${relativeTime(device.last_seen_at)}; ${exactTime(device.last_seen_at)}`}>{relativeTime(device.last_seen_at)}</time>
              {:else}<span class="muted">Not reported</span>{/if}
            </dd>
          </div>
        </dl>
        <div class="revoked-removal">
          <button
            class={removal?.state === 'pending' ? 'secondary' : 'danger'}
            disabled={disabled || removal?.state === 'pending'}
            aria-label={`${removalLabel(device)}: ${device.device_name}`}
            on:click={(event) => onRemove(device, event.currentTarget)}
          >{removalLabel(device)}</button>
          {#if removalHint(device)}<small class="muted">{removalHint(device)}</small>{/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}
