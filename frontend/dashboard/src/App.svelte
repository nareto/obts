<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, DashboardApi } from './api/client';
  import type { AttentionItem } from './components/Attention.svelte';
  import AuthScreen from './components/AuthScreen.svelte';
  import ConflictQueue from './components/ConflictQueue.svelte';
  import ConflictWorkbench from './components/ConflictWorkbench.svelte';
  import ConnectionScreen from './components/ConnectionScreen.svelte';
  import DeviceTable from './components/DeviceTable.svelte';
  import HistoryPage from './components/HistoryPage.svelte';
  import MaintenancePage from './components/MaintenancePage.svelte';
  import Overview from './components/Overview.svelte';
  import ReauthModal from './components/ReauthModal.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import Shell from './components/Shell.svelte';
  import Status from './components/Status.svelte';
  import VaultDeletionModal from './components/VaultDeletionModal.svelte';
  import type {
    DashboardConflict,
    ConnectionReview,
    ConflictResolutionSubmission,
    ConflictReviewPackage,
    DashboardDevice,
    DashboardSummary,
    DiagnosticEventsResponse,
    VaultDeletionStatus,
    MaintenanceRow,
    NoteHistoryQueryResponse,
    NoteHistoryVersion,
    NoteHistoryVersionResponse,
    Session,
    VaultSummary
  } from './api/types';

  const api = new DashboardApi();
  const DASHBOARD_REFRESH_INTERVAL_MS = 15 * 1000;
  const nav = ['Overview', 'Devices', 'Conflicts', 'History', 'Maintenance', 'Settings'] as const;
  type Page = (typeof nav)[number];

  let session: Session | null = null;
  let setupComplete = true;
  let username = '';
  let password = '';
  let authError = '';
  let page: Page = 'Overview';
  let vaults: VaultSummary[] = [];
  let deletions: VaultDeletionStatus[] = [];
  let vaultId = '';
  let newVaultName = '';
  let createVaultOpen = false;
  let renameVaultId = '';
  let renameVaultName = '';
  let renameVaultOpen = false;
  let dashboard: DashboardSummary | null = null;
  let diagnostics: DiagnosticEventsResponse | null = null;
  let diagnosticsError = '';
  let diagnosticsLoading = false;
  let conflicts: DashboardConflict[] = [];
  let selectedConflictId = '';
  let conflictListOpen = false;
  let review: ConflictReviewPackage | null = null;
  const connectionId = window.location.pathname.match(/^\/connect\/([^/]+)$/u)?.[1] ?? '';
  let connectionReview: ConnectionReview | null = null;
  let connectionSelection: 'new_vault' | 'existing_vault' = 'new_vault';
  let connectionVaultId = '';
  let connectionVaultName = '';
  let connectionApproved = false;
  let connectionOperationGeneration = 0;
  let connectionOperationInFlight = false;
  let connectionRequestGeneration = 0;
  let reauthOpen = false;
  let reauthAction: (() => Promise<void>) | null = null;
  let historyPath = '';
  let history: NoteHistoryQueryResponse | null = null;
  let selectedHistory: NoteHistoryVersion | null = null;
  let historyVersion: NoteHistoryVersionResponse | null = null;
  let historyDiffTab: 'rendered' | 'source' = 'source';
  let historyError = '';
  let historyLoading = false;
  let maintenanceDetailOpen = false;
  let busy = false;
  let notice = '';
  let actionError = '';
  let lastRefreshed: string | null = null;
  let nowMs = Date.now();
  let dashboardRefreshInFlight = false;
  let dashboardRefreshGeneration = 0;
  let dashboardRefreshOwner: { vaultId: string; epoch: number; generation: number } | null = null;
  let dashboardStatusCurrent = true;
  let stateEpoch = 0;
  let logoutInFlight = false;
  let logoutFailed = false;
  let accountEpoch = 0;
  let reviewRequestGeneration = 0;
  let historyRequestGeneration = 0;
  let diagnosticsRequestGeneration = 0;
  let diagnosticsDeleteGeneration = 0;
  let diagnosticsDeleteInFlight = false;
  let deletionModalOpen = false;
  let deletionTarget: { vaultId: string; displayName: string; epoch: number; account: number; userId: string; generation: number } | null = null;
  let deletionError = '';
  let deletionRequestGeneration = 0;
  let deletionRequestInFlight = false;
  let deletionRefreshGeneration = 0;
  let deletionRefreshInFlight = false;

  $: selectedVault = vaults.find((vault) => vault.vault_id === vaultId) ?? null;
  $: unresolvedCount = dashboard?.unresolved_conflict_count ?? conflicts.filter((conflict) => conflict.status === 'open').length;
  $: selectedConflict = conflicts.find((conflict) => conflict.conflict_id === selectedConflictId) ?? null;
  $: selectedDeletion = deletions.find((deletion) => deletion.vault_id === vaultId) ?? null;
  $: selectedVaultDeleting = selectedVault?.status === 'deleting' || selectedDeletion?.status === 'deleting';
  $: recentAuthValid = session ? Date.parse(session.recent_auth_expires_at) > nowMs : false;
  $: syncSummary = dashboardSyncSummary(dashboard, dashboardStatusCurrent);

  function clearScopedState(clearAccount = false) {
    stateEpoch += 1;
    dashboardRefreshGeneration += 1;
    reviewRequestGeneration += 1;
    historyRequestGeneration += 1;
    diagnosticsRequestGeneration += 1;
    diagnosticsDeleteGeneration += 1;
    deletionRequestGeneration += 1;
    deletionRefreshGeneration += 1;
    connectionRequestGeneration += 1;
    connectionOperationGeneration += 1;
    connectionOperationInFlight = false;
    diagnosticsDeleteInFlight = false;
    deletionModalOpen = false;
    deletionTarget = null;
    deletionError = '';
    deletionRequestInFlight = false;
    deletionRefreshInFlight = false;
    dashboardRefreshOwner = null;
    dashboardRefreshInFlight = false;
    dashboard = null;
    if (clearAccount) {
      accountEpoch += 1;
      diagnostics = null;
      diagnosticsError = '';
      connectionReview = null;
      connectionApproved = false;
      connectionVaultId = '';
      connectionVaultName = '';
      vaults = [];
      deletions = [];
      vaultId = '';
      page = 'Overview';
    }
    createVaultOpen = false;
    renameVaultOpen = false;
    renameVaultId = '';
    conflictListOpen = false;
    conflicts = [];
    selectedConflictId = '';
    review = null;
    reauthAction = null;
    reauthOpen = false;
    historyPath = '';
    history = null;
    selectedHistory = null;
    historyVersion = null;
    historyError = '';
    historyLoading = false;
    lastRefreshed = null;
    notice = '';
    actionError = '';
    dashboardStatusCurrent = false;
    maintenanceDetailOpen = false;
  }

  function currentRequest(vault: string, epoch: number, generation?: number) {
    return vaultId === vault && stateEpoch === epoch && (generation === undefined || dashboardRefreshGeneration === generation) && !!session;
  }

  function currentConnectionAction(target: { connectionId: string; epoch: number; account: number; userId: string }, generation: number) {
    return connectionId === target.connectionId && connectionReview?.connection_id === target.connectionId && stateEpoch === target.epoch && accountEpoch === target.account && session?.user_id === target.userId && connectionOperationGeneration === generation;
  }

  function currentDiagnosticsDelete(target: { epoch: number; account: number; userId: string }, generation: number) {
    return stateEpoch === target.epoch && accountEpoch === target.account && session?.user_id === target.userId && diagnosticsDeleteGeneration === generation;
  }

  function currentDeletionTarget(target: NonNullable<typeof deletionTarget>, generation = target.generation) {
    return deletionTarget?.vaultId === target.vaultId && deletionTarget.generation === generation && vaultId === target.vaultId && stateEpoch === target.epoch && accountEpoch === target.account && session?.user_id === target.userId;
  }

  function clearTargetPresentation(targetVaultId: string) {
    if (vaultId !== targetVaultId) return;
    stateEpoch += 1;
    dashboardRefreshGeneration += 1;
    reviewRequestGeneration += 1;
    historyRequestGeneration += 1;
    diagnosticsRequestGeneration += 1;
    deletionRequestGeneration += 1;
    deletionRefreshGeneration += 1;
    dashboardRefreshOwner = null;
    dashboardRefreshInFlight = false;
    deletionRefreshInFlight = false;
    dashboard = null;
    conflicts = [];
    selectedConflictId = '';
    conflictListOpen = false;
    review = null;
    historyPath = '';
    history = null;
    selectedHistory = null;
    historyVersion = null;
    historyError = '';
    historyLoading = false;
    dashboardStatusCurrent = false;
    lastRefreshed = null;
    actionError = '';
    deletionModalOpen = false;
    deletionTarget = null;
    deletionError = '';
    deletionRequestInFlight = false;
    vaultId = '';
  }

  function reportAsyncError(error: unknown, fallback: string, epoch = stateEpoch) {
    if (stateEpoch !== epoch) return;
    if (error instanceof ApiError && error.status === 401) {
      session = null;
      clearScopedState(true);
      api.csrfToken = '';
      authError = 'Your session ended. Sign in to continue.';
      busy = false;
      return;
    }
    actionError = error instanceof Error ? error.message : fallback;
  }

  function isActiveStatusLabel(label: string) {
    return ['Deleting', 'Verifying contents', 'Preparing upload', 'Uploading', 'Applying', 'Checking', 'Merging', 'Server retrying', 'Repairing baseline', 'Finishing update', 'Waiting for operation'].some(
      (base) => label === base || label.startsWith(`${base} `)
    );
  }

  function dashboardSyncSummary(value: DashboardSummary | null, statusCurrent: boolean): {
    label: string;
    role: 'success' | 'info' | 'warning' | 'danger' | 'neutral';
  } {
    if (!value) return { label: 'Checking', role: 'neutral' };
    if (!statusCurrent) return { label: 'Status unknown', role: 'warning' };
    if (value.vault.status === 'deleting') return { label: 'Deleting', role: 'info' };
    if (value.vault.status === 'blocked_integrity') return { label: 'Integrity blocked', role: 'danger' };
    if (value.devices.length === 0) return { label: 'Status unknown', role: 'warning' };
    if (value.devices.every((device) => device.status_label === 'Synced')) return { label: 'Synced', role: 'success' };
    if (value.devices.some((device) => ['Blocked', 'Needs recovery', 'Integrity failure', 'Conflict resolution needed', 'Out of sync — file exceeds upload limit', 'Out of sync — upload limit exceeded', 'Out of sync — local recovery required', 'Server repair required'].includes(device.status_label))) {
      return { label: 'Attention required', role: 'danger' };
    }
    if (value.devices.some((device) => isActiveStatusLabel(device.status_label))) {
      return { label: 'Sync in progress', role: 'info' };
    }
    return { label: 'Not converged', role: 'warning' };
  }

  onMount(() => {
    void bootstrap();
    const clockInterval = window.setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    const dashboardInterval = window.setInterval(() => {
      if (!document.hidden) void refreshDashboardStatus();
    }, DASHBOARD_REFRESH_INTERVAL_MS);
    const refreshWhenVisible = () => {
      if (!document.hidden) void refreshDashboardStatus();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      window.clearInterval(clockInterval);
      window.clearInterval(dashboardInterval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  });

  async function bootstrap() {
    const epoch = stateEpoch;
    busy = true;
    try {
      const setup = await api.setupStatus();
      if (stateEpoch !== epoch) return;
      setupComplete = setup.setup_complete;
      if (setupComplete) {
        const restoredSession = await api.session();
        if (stateEpoch !== epoch) return;
        session = restoredSession;
        await refreshAll();
      }
    } catch (error) {
      if (stateEpoch !== epoch) return;
      if (error instanceof ApiError && error.status === 401) {
        session = null;
        return;
      }
      authError = error instanceof Error ? error.message : 'Unable to load dashboard.';
    } finally {
      if (stateEpoch === epoch || !session) busy = false;
    }
  }

  async function authenticate() {
    if (logoutInFlight) {
      authError = 'Signing out is still in progress. Please wait.';
      return;
    }
    if (busy) return;
    authError = '';
    busy = true;
    const requestEpoch = stateEpoch;
    const requestAccountEpoch = accountEpoch;
    const requestUserId = session?.user_id ?? '';
    const pendingAction = reauthAction;
    let operationEpoch = requestEpoch;
    try {
      if (pendingAction && session) {
        const nextSession = await api.reauthenticate(username, password, { publishCsrfToken: false });
        const sameSession = stateEpoch === requestEpoch && accountEpoch === requestAccountEpoch && session?.user_id === requestUserId && nextSession.user_id === requestUserId;
        if (!sameSession) return;
        api.csrfToken = nextSession.csrf_token;
        const actionStillOwned = reauthAction === pendingAction;
        session = nextSession;
        if (!actionStillOwned) return;
        username = '';
        password = '';
        reauthAction = null;
        reauthOpen = false;
        await pendingAction();
      } else {
        clearScopedState(true);
        operationEpoch = stateEpoch;
        const nextSession = setupComplete ? await api.login(username, password) : await api.setup(username, password);
        if (stateEpoch !== operationEpoch || logoutInFlight) return;
        session = nextSession;
        logoutFailed = false;
        setupComplete = true;
        username = '';
        password = '';
        await refreshAll();
      }
    } catch (error) {
      if (stateEpoch === operationEpoch && (pendingAction ? accountEpoch === requestAccountEpoch && session?.user_id === requestUserId && reauthAction === pendingAction : true)) {
        authError = error instanceof Error ? error.message : 'Authentication failed.';
      }
    } finally {
      if (stateEpoch === operationEpoch && (pendingAction ? accountEpoch === requestAccountEpoch : true)) busy = false;
    }
  }

  async function refreshAll() {
    if (!session) return;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session.user_id;
    const deletionGeneration = ++deletionRefreshGeneration;
    if (connectionId) {
      const generation = ++connectionRequestGeneration;
      const connection = await api.connectionReview(connectionId);
      if (!session || stateEpoch !== epoch || accountEpoch !== account || session.user_id !== userId || generation !== connectionRequestGeneration) return;
      connectionReview = connection;
      connectionVaultName ||= connectionReview.local_vault_name;
      connectionVaultId ||= connectionReview.vaults.find((vault) => vault.status === 'active')?.vault_id ?? '';
      return;
    }
    const [listed, deletionList] = await Promise.all([api.vaults(), api.vaultDeletions()]);
    if (!session || stateEpoch !== epoch || accountEpoch !== account || session.user_id !== userId || deletionRefreshGeneration !== deletionGeneration) return;
    const completedIds = new Set(deletionList.deletions.filter((deletion) => deletion.status === 'deleted').map((deletion) => deletion.vault_id));
    const nextVaults = listed.vaults
      .filter((vault) => !completedIds.has(vault.vault_id))
      .map((vault) => deletionList.deletions.some((deletion) => deletion.vault_id === vault.vault_id && deletion.status === 'deleting')
        ? { ...vault, status: 'deleting' as const }
        : vault);
    const previousVaultId = vaultId;
    if (previousVaultId && !nextVaults.some((vault) => vault.vault_id === previousVaultId)) clearTargetPresentation(previousVaultId);
    vaults = nextVaults;
    if (!vaults.some((vault) => vault.vault_id === vaultId)) vaultId = vaults[0]?.vault_id ?? '';
    deletions = deletionList.deletions;
    if (vaults.length === 0 && deletions.length > 0) page = 'Settings';
    await Promise.all([refreshVault(), refreshDiagnostics()]);
  }

  async function refreshDiagnostics() {
    const epoch = accountEpoch;
    const userId = session?.user_id ?? '';
    const generation = ++diagnosticsRequestGeneration;
    diagnosticsError = '';
    diagnosticsLoading = true;
    try {
      const next = await api.diagnosticEvents();
      if (session && session.user_id === userId && accountEpoch === epoch && generation === diagnosticsRequestGeneration) diagnostics = next;
    } catch (error) {
      if (session && session.user_id === userId && accountEpoch === epoch && generation === diagnosticsRequestGeneration) {
        if (error instanceof ApiError && error.status === 401) {
          reportAsyncError(error, 'Unable to load diagnostics.');
        } else {
          diagnosticsError = error instanceof Error ? error.message : 'Unable to load diagnostics.';
        }
      }
    } finally {
      if (accountEpoch === epoch && generation === diagnosticsRequestGeneration) diagnosticsLoading = false;
    }
  }

  async function requestRefreshDiagnostics() {
    if (!session || diagnosticsLoading) return;
    await refreshDiagnostics();
  }

  function openVaultDeletion() {
    if (!session || !selectedVault || selectedVaultDeleting || deletionRequestInFlight) return;
    deletionError = '';
    deletionTarget = {
      vaultId: selectedVault.vault_id,
      displayName: selectedVault.display_name,
      epoch: stateEpoch,
      account: accountEpoch,
      userId: session.user_id,
      generation: deletionRequestGeneration
    };
    deletionModalOpen = true;
  }

  function cancelVaultDeletion() {
    deletionRequestGeneration += 1;
    deletionTarget = null;
    deletionModalOpen = false;
    deletionError = '';
  }

  async function publishDeletionStatus(status: VaultDeletionStatus, targetVaultId: string) {
    const nextDeletions = [status, ...deletions.filter((deletion) => deletion.vault_id !== targetVaultId)];
    const nextVaults = vaults
      .filter((vault) => vault.vault_id !== targetVaultId || status.status !== 'deleted')
      .map((vault) => vault.vault_id === targetVaultId ? { ...vault, status: 'deleting' as const } : vault);
    clearTargetPresentation(targetVaultId);
    deletions = nextDeletions;
    vaults = nextVaults;
    if (status.status === 'deleting') {
      vaultId = targetVaultId;
      dashboardStatusCurrent = true;
      notice = 'Vault deletion accepted. The server is still deleting it; completion is not yet confirmed.';
      return;
    }
    const nextActive = nextVaults.find((vault) => vault.status === 'active');
    if (nextActive) {
      vaultId = nextActive.vault_id;
      await refreshVault();
    } else {
      page = 'Settings';
    }
    notice = 'Vault deletion completed. The 30-day receipt remains available in Settings.';
  }

  async function submitVaultDeletion(confirmation: string) {
    const target = deletionTarget;
    if (!target || deletionRequestInFlight || busy) return;
    if (confirmation !== `DELETE ${target.vaultId}`) {
      deletionError = 'Type the exact confirmation phrase shown above.';
      return;
    }
    if (!currentDeletionTarget(target)) {
      deletionError = 'The selected vault changed. Close this dialog and review the current vault.';
      return;
    }
    deletionRequestInFlight = true;
    busy = true;
    deletionError = '';
    try {
      const status = await api.deleteVault(target.vaultId, confirmation);
      if (!currentDeletionTarget(target)) return;
      deletionRequestInFlight = false;
      busy = false;
      await publishDeletionStatus(status, target.vaultId);
      deletionTarget = null;
      deletionModalOpen = false;
    } catch (error) {
      if (!currentDeletionTarget(target)) return;
      deletionRequestInFlight = false;
      busy = false;
      if (error instanceof ApiError && error.status === 401) reportAsyncError(error, 'Unable to delete this vault.', target.epoch);
      else deletionError = error instanceof Error ? error.message : 'Unable to delete this vault.';
    }
  }

  async function loadMoreDiagnostics() {
    if (!diagnostics?.next_cursor || !session || diagnosticsLoading) return;
    const epoch = accountEpoch;
    const userId = session.user_id;
    const cursor = diagnostics.next_cursor;
    const generation = ++diagnosticsRequestGeneration;
    diagnosticsLoading = true;
    diagnosticsError = '';
    try {
      const next = await api.diagnosticEvents(cursor);
      if (session && session.user_id === userId && accountEpoch === epoch && generation === diagnosticsRequestGeneration && diagnostics?.next_cursor === cursor) {
        diagnostics = { ...next, events: [...diagnostics.events, ...next.events] };
      }
    } catch (error) {
      if (session && session.user_id === userId && accountEpoch === epoch && generation === diagnosticsRequestGeneration) {
        if (error instanceof ApiError && error.status === 401) {
          reportAsyncError(error, 'Unable to load more diagnostics.');
        } else {
          diagnosticsError = error instanceof Error ? error.message : 'Unable to load more diagnostics.';
        }
      }
    } finally {
      if (accountEpoch === epoch && generation === diagnosticsRequestGeneration) diagnosticsLoading = false;
    }
  }

  function deleteDiagnostics() {
    if (!session || diagnosticsDeleteInFlight) return;
    const target = { epoch: stateEpoch, account: accountEpoch, userId: session.user_id };
    const generation = ++diagnosticsDeleteGeneration;
    diagnosticsDeleteInFlight = true;
    withRecentAuth(async () => {
      try {
        if (!currentDiagnosticsDelete(target, generation)) return;
        if (!confirm('Delete all error diagnostics shared with this server?')) return;
        busy = true;
        const result = await api.deleteDiagnosticEvents();
        if (!currentDiagnosticsDelete(target, generation)) return;
        notice = `Deleted ${result.deleted_count} error diagnostic${result.deleted_count === 1 ? '' : 's'}.`;
        await refreshDiagnostics();
      } catch (error) {
        if (!currentDiagnosticsDelete(target, generation)) return;
        if (error instanceof ApiError && error.status === 401) reportAsyncError(error, 'Unable to delete diagnostics.', target.epoch);
        else actionError = error instanceof Error ? error.message : 'Unable to delete diagnostics.';
      } finally {
        if (currentDiagnosticsDelete(target, generation)) {
          diagnosticsDeleteInFlight = false;
          busy = false;
        }
      }
    });
  }

  function reconcileConflictSelection() {
    const currentConflictExists = conflicts.some((conflict) => conflict.conflict_id === selectedConflictId);
    if (!currentConflictExists) {
      selectedConflictId = '';
      review = null;
    }
    if (!selectedConflictId) {
      selectedConflictId = conflicts.find((conflict) => conflict.status === 'open')?.conflict_id ?? '';
    }
  }

  function clearDashboardPresentation() {
    dashboard = null;
    conflicts = [];
    selectedConflictId = '';
    conflictListOpen = false;
    review = null;
    historyPath = '';
    history = null;
    selectedHistory = null;
    historyVersion = null;
    historyError = '';
    historyLoading = false;
    dashboardStatusCurrent = false;
  }

  async function moveFromDeletedVault(targetVaultId: string, nextVaults: VaultSummary[]) {
    const wasSelected = vaultId === targetVaultId;
    vaults = nextVaults.filter((vault) => vault.vault_id !== targetVaultId);
    if (!wasSelected) return;
    clearTargetPresentation(targetVaultId);
    vaults = nextVaults.filter((vault) => vault.vault_id !== targetVaultId);
    const nextActive = vaults.find((vault) => vault.status === 'active');
    if (nextActive) {
      vaultId = nextActive.vault_id;
      await refreshVault();
    } else {
      page = 'Settings';
    }
  }

  async function refreshDeletionRecords() {
    if (!session || connectionId || deletionRefreshInFlight) return;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session.user_id;
    const generation = ++deletionRefreshGeneration;
    deletionRefreshInFlight = true;
    try {
      const result = await api.vaultDeletions();
      if (!session || session.user_id !== userId || stateEpoch !== epoch || accountEpoch !== account || generation !== deletionRefreshGeneration) return;
      deletions = result.deletions;
      if (vaults.length === 0 && deletions.length > 0) page = 'Settings';
    } catch (error) {
      if (session && session.user_id === userId && stateEpoch === epoch && accountEpoch === account && generation === deletionRefreshGeneration) {
        if (error instanceof ApiError && error.status === 401) reportAsyncError(error, 'Unable to refresh vault deletion status.', epoch);
        else actionError = error instanceof Error ? error.message : 'Unable to refresh vault deletion status.';
      }
    } finally {
      if (generation === deletionRefreshGeneration) deletionRefreshInFlight = false;
    }
  }

  async function refreshDashboardStatus(supersede = false) {
    if (!session || connectionId || (dashboardRefreshInFlight && !supersede)) return;
    if (!vaultId) {
      await refreshDeletionRecords();
      return;
    }
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session.user_id;
    const requestGeneration = ++dashboardRefreshGeneration;
    const deletionGeneration = ++deletionRefreshGeneration;
    const deletionBefore = deletions;
    dashboardRefreshOwner = { vaultId: requestedVaultId, epoch, generation: requestGeneration };
    dashboardRefreshInFlight = true;
    deletionRefreshInFlight = true;
    try {
      const deletionPromise = api.vaultDeletions();
      const dashboardPromise = selectedVaultDeleting
        ? Promise.resolve(null)
        : Promise.all([
          api.dashboard(requestedVaultId),
          api.conflicts(requestedVaultId).then((value) => value.conflicts)
        ]);
      const [deletionResult, dashboardResult] = await Promise.allSettled([deletionPromise, dashboardPromise]);
      const owned = !!session && session.user_id === userId && accountEpoch === account && stateEpoch === epoch && vaultId === requestedVaultId && deletionGeneration === deletionRefreshGeneration && currentRequest(requestedVaultId, epoch, requestGeneration);
      if (!owned) return;
      let nextVaults = vaults;
      if (deletionResult.status === 'fulfilled') {
        const nextDeletions = deletionResult.value.deletions;
        const previousTarget = deletionBefore.find((deletion) => deletion.vault_id === requestedVaultId);
        const nextTarget = nextDeletions.find((deletion) => deletion.vault_id === requestedVaultId);
        const targetCompleted = nextTarget?.status === 'deleted' || ((previousTarget?.status === 'deleting' || previousTarget?.status === 'deleted') && !nextTarget);
        const completedIds = new Set(nextDeletions.filter((deletion) => deletion.status === 'deleted').map((deletion) => deletion.vault_id));
        const expiredIds = previousTarget?.status === 'deleted' && !nextTarget ? new Set([requestedVaultId]) : new Set<string>();
        nextVaults = vaults
          .filter((vault) => !completedIds.has(vault.vault_id) && !expiredIds.has(vault.vault_id) && !(previousTarget?.status === 'deleting' && !nextTarget && vault.vault_id === requestedVaultId))
          .map((vault) => nextDeletions.some((deletion) => deletion.vault_id === vault.vault_id && deletion.status === 'deleting')
            ? { ...vault, status: 'deleting' as const }
            : vault);
        deletions = nextDeletions;
        vaults = nextVaults;
        if (targetCompleted) {
          await moveFromDeletedVault(requestedVaultId, nextVaults);
          return;
        }
        if (nextTarget?.status === 'deleting' && !previousTarget?.status) clearDashboardPresentation();
        lastRefreshed = new Date().toLocaleTimeString();
      } else if (deletionResult.reason instanceof ApiError && deletionResult.reason.status === 401) {
        reportAsyncError(deletionResult.reason, 'Unable to refresh vault deletion status.', epoch);
        return;
      } else {
        actionError = deletionResult.reason instanceof Error ? deletionResult.reason.message : 'Unable to refresh vault deletion status.';
      }
      if (dashboardResult.status === 'fulfilled') {
        if (!dashboardResult.value) {
          dashboardStatusCurrent = true;
          return;
        }
        reviewRequestGeneration += 1;
        dashboard = dashboardResult.value[0];
        conflicts = sortConflicts(dashboardResult.value[1]);
        const selected = conflicts.find((conflict) => conflict.conflict_id === selectedConflictId);
        if (review && selectedConflictId && (!selected || selected.status !== 'open' || selected.stale || selected.current_main !== review.expected_main)) {
          review = { ...review, stale: true };
          if (selected) selected.status_label = 'Stale review';
          actionError = selected ? 'This conflict changed while it was open. Refresh before submitting.' : 'This conflict is no longer available. Refresh the conflict queue.';
        }
        dashboardStatusCurrent = true;
        lastRefreshed = new Date().toLocaleTimeString();
      } else if (dashboardResult.reason instanceof ApiError && (dashboardResult.reason.status === 409 || dashboardResult.reason.code === 'vault_deleting')) {
        vaults = vaults.map((vault) => vault.vault_id === requestedVaultId ? { ...vault, status: 'deleting' as const } : vault);
        clearDashboardPresentation();
        dashboardStatusCurrent = true;
        lastRefreshed = new Date().toLocaleTimeString();
      } else if (dashboardResult.reason instanceof ApiError && dashboardResult.reason.status === 404) {
        await moveFromDeletedVault(requestedVaultId, nextVaults);
      } else {
        dashboardStatusCurrent = false;
        reportAsyncError(dashboardResult.reason, 'Unable to refresh dashboard status.', epoch);
      }
    } finally {
      if (deletionRefreshGeneration === deletionGeneration) deletionRefreshInFlight = false;
      if (dashboardRefreshOwner?.generation === requestGeneration) {
        dashboardRefreshInFlight = false;
        dashboardRefreshOwner = null;
      }
    }
  }

  async function refreshVault() {
    if (!vaultId || !session) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session.user_id;
    const requestGeneration = ++dashboardRefreshGeneration;
    const deletionGeneration = ++deletionRefreshGeneration;
    dashboardRefreshOwner = { vaultId: requestedVaultId, epoch, generation: requestGeneration };
    dashboardRefreshInFlight = true;
    deletionRefreshInFlight = true;
    try {
      const [dashboardResult, refreshedConflicts, deletionList] = await Promise.all([
        api.dashboard(requestedVaultId),
        api.conflicts(requestedVaultId).then((value) => value.conflicts),
        api.vaultDeletions()
      ]);
      if (!session || session.user_id !== userId || accountEpoch !== account || !currentRequest(requestedVaultId, epoch, requestGeneration) || deletionGeneration !== deletionRefreshGeneration) return;
      const completedIds = new Set(deletionList.deletions.filter((deletion) => deletion.status === 'deleted').map((deletion) => deletion.vault_id));
      const targetDeletion = deletionList.deletions.find((deletion) => deletion.vault_id === requestedVaultId);
      deletions = deletionList.deletions;
      if (targetDeletion?.status === 'deleted' || completedIds.has(requestedVaultId)) {
        await moveFromDeletedVault(requestedVaultId, vaults);
        return;
      }
      if (targetDeletion?.status === 'deleting' || dashboardResult.vault.status === 'deleting') {
        vaults = vaults.map((vault) => vault.vault_id === requestedVaultId ? { ...vault, status: 'deleting' as const } : vault);
        clearDashboardPresentation();
        lastRefreshed = new Date().toLocaleTimeString();
        return;
      }
      dashboard = dashboardResult;
      conflicts = sortConflicts(refreshedConflicts);
      reconcileConflictSelection();
      dashboardStatusCurrent = true;
      if (selectedConflictId) {
        await loadReview(selectedConflictId);
      } else {
        review = null;
      }
      if (currentRequest(requestedVaultId, epoch, requestGeneration)) lastRefreshed = new Date().toLocaleTimeString();
    } catch (error) {
      if (!currentRequest(requestedVaultId, epoch, requestGeneration) || accountEpoch !== account || session?.user_id !== userId) return;
      if (error instanceof ApiError && (error.status === 409 || error.code === 'vault_deleting')) {
        vaults = vaults.map((vault) => vault.vault_id === requestedVaultId ? { ...vault, status: 'deleting' as const } : vault);
        clearDashboardPresentation();
        dashboardStatusCurrent = true;
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        try {
          const deletionList = await api.vaultDeletions();
          if (!session || session.user_id !== userId || accountEpoch !== account || !currentRequest(requestedVaultId, epoch, requestGeneration)) return;
          deletions = deletionList.deletions;
        } catch {
          if (!session || session.user_id !== userId || accountEpoch !== account || !currentRequest(requestedVaultId, epoch, requestGeneration)) return;
        }
        await moveFromDeletedVault(requestedVaultId, vaults);
        return;
      }
      dashboardStatusCurrent = false;
      reportAsyncError(error, 'Unable to load this vault.', epoch);
      throw error;
    } finally {
      if (deletionRefreshGeneration === deletionGeneration) deletionRefreshInFlight = false;
      if (dashboardRefreshOwner?.generation === requestGeneration) {
        dashboardRefreshInFlight = false;
        dashboardRefreshOwner = null;
      }
    }
  }

  async function selectVault(nextVaultId: string) {
    if (nextVaultId === vaultId) return;
    vaultId = nextVaultId;
    renameVaultOpen = false;
    renameVaultId = '';
    clearScopedState();
    const epoch = stateEpoch;
    busy = true;
    try {
      await refreshVault();
    } catch (error) {
      reportAsyncError(error, 'Unable to load this vault.', epoch);
    } finally {
      if (stateEpoch === epoch) busy = false;
    }
  }

  async function requestRefreshVault() {
    if (selectedVaultDeleting) return;
    const epoch = stateEpoch;
    actionError = '';
    busy = true;
    try {
      await refreshVault();
    } catch (error) {
      reportAsyncError(error, 'Unable to refresh this vault.', epoch);
    } finally {
      if (stateEpoch === epoch) busy = false;
    }
  }

  async function createVault() {
    if (!session || busy || !newVaultName.trim()) return;
    let epoch = stateEpoch;
    const account = accountEpoch;
    busy = true;
    actionError = '';
    try {
      const created = await api.createVault(newVaultName.trim());
      if (!session || stateEpoch !== epoch || accountEpoch !== account) return;
      vaults = [...vaults, created];
      vaultId = created.vault_id;
      clearScopedState();
      epoch = stateEpoch;
      newVaultName = '';
      notice = 'Vault created.';
      await refreshVault();
    } catch (error) {
      if (accountEpoch === account) reportAsyncError(error, 'Unable to create this vault.', epoch);
    } finally {
      if (stateEpoch === epoch && accountEpoch === account) busy = false;
    }
  }

  function openVaultRename() {
    if (!selectedVault) return;
    createVaultOpen = false;
    renameVaultId = selectedVault.vault_id;
    renameVaultName = selectedVault.display_name;
    renameVaultOpen = true;
  }

  async function renameVault() {
    if (!session || busy || selectedVaultDeleting || !renameVaultId || !renameVaultName.trim()) return;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const target = renameVaultId;
    actionError = '';
    busy = true;
    try {
      const renamed = await api.renameVault(target, renameVaultName);
      if (!session || stateEpoch !== epoch || accountEpoch !== account) return;
      vaults = vaults.map((vault) => vault.vault_id === renamed.vault_id ? renamed : vault);
      if (dashboard?.vault.vault_id === renamed.vault_id) {
        dashboard = { ...dashboard, vault: { ...dashboard.vault, display_name: renamed.display_name } };
      }
      renameVaultOpen = false;
      renameVaultId = '';
      notice = `Vault renamed to ${renamed.display_name}.`;
      await refreshDashboardStatus(true);
    } catch (error) {
      if (accountEpoch === account) reportAsyncError(error, 'Unable to rename this vault.', epoch);
    } finally {
      if (stateEpoch === epoch && accountEpoch === account) busy = false;
    }
  }

  async function loadReview(conflictId: string) {
    if (!vaultId || !session) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const generation = ++reviewRequestGeneration;
    selectedConflictId = conflictId;
    review = review?.conflict.conflict_id === conflictId ? { ...review, stale: true } : null;
    try {
      const nextReview = await api.conflict(requestedVaultId, conflictId);
      if (currentRequest(requestedVaultId, epoch) && generation === reviewRequestGeneration && selectedConflictId === conflictId) setReview(nextReview);
    } catch (error) {
      if (currentRequest(requestedVaultId, epoch) && generation === reviewRequestGeneration && selectedConflictId === conflictId) reportAsyncError(error, 'Unable to load conflict review.', epoch);
    }
  }

  function setReview(nextReview: ConflictReviewPackage) {
    review = nextReview;
  }

  async function refreshReview() {
    if (!vaultId || !review) return;
    await refreshConflictReview(review.conflict.conflict_id);
  }

  async function refreshConflictReview(conflictId: string) {
    if (!vaultId || !session) return;
    actionError = '';
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const generation = ++reviewRequestGeneration;
    selectedConflictId = conflictId;
    review = review?.conflict.conflict_id === conflictId ? { ...review, stale: true } : null;
    try {
      const nextReview = await api.refreshConflict(requestedVaultId, conflictId);
      if (!currentRequest(requestedVaultId, epoch) || generation !== reviewRequestGeneration) return;
      const listed = await api.conflicts(requestedVaultId);
      if (!currentRequest(requestedVaultId, epoch) || generation !== reviewRequestGeneration || selectedConflictId !== conflictId) return;
      setReview(nextReview);
      conflicts = sortConflicts(listed.conflicts);
      notice = 'Conflict review refreshed.';
    } catch (error) {
      if (currentRequest(requestedVaultId, epoch) && generation === reviewRequestGeneration && selectedConflictId === conflictId) reportAsyncError(error, 'Unable to refresh conflict review.', epoch);
    }
  }

  async function openConflictFromList(conflict: DashboardConflict) {
    conflictListOpen = false;
    if (conflict.stale) {
      await refreshConflictReview(conflict.conflict_id);
      return;
    }
    await loadReview(conflict.conflict_id);
  }

  async function selectConflict(event: Event) {
    const conflictId = (event.currentTarget as HTMLSelectElement).value;
    const conflict = conflicts.find((candidate) => candidate.conflict_id === conflictId);
    if (conflict) await openConflictFromList(conflict);
  }

  async function handleAttentionAction(item: AttentionItem) {
    if (item.kind === 'maintenance') {
      page = 'Maintenance';
      return;
    }
    if (item.kind === 'devices') {
      page = 'Devices';
      return;
    }
    page = 'Conflicts';
    if (item.kind === 'stale_conflict') {
      await refreshConflictReview(item.conflictId);
      return;
    }
    await loadReview(item.conflictId);
  }

  async function withRecentAuth(action: () => Promise<void>) {
    const epoch = stateEpoch;
    const run = async () => {
      if (!session || stateEpoch !== epoch) return;
      try {
        await action();
      } catch (error) {
        reportAsyncError(error, 'Action failed.', epoch);
      }
    };
    if (recentAuthValid) {
      await run();
      return;
    }
    authError = '';
    reauthAction = run;
    reauthOpen = true;
  }

  function cancelReauth() {
    reauthAction = null;
    reauthOpen = false;
    username = '';
    password = '';
    authError = '';
    connectionOperationGeneration += 1;
    connectionOperationInFlight = false;
    diagnosticsDeleteGeneration += 1;
    diagnosticsDeleteInFlight = false;
    busy = false;
  }

  async function approvePendingConnection() {
    if (!connectionReview || connectionOperationInFlight) return;
    const target = {
      connectionId: connectionReview.connection_id,
      selection: connectionSelection,
      vaultId: connectionVaultId,
      vaultName: connectionVaultName.trim(),
      existingVaultActive: connectionSelection === 'existing_vault' && connectionReview.vaults.some((vault) => vault.vault_id === connectionVaultId && vault.status === 'active'),
      epoch: stateEpoch,
      account: accountEpoch,
      userId: session?.user_id ?? ''
    };
    const generation = ++connectionOperationGeneration;
    connectionOperationInFlight = true;
    await withRecentAuth(async () => {
      try {
        if (!currentConnectionAction(target, generation)) return;
        actionError = '';
        if (target.selection === 'new_vault') {
          if (!target.vaultName) {
            actionError = 'Enter a vault name before approving this connection.';
            return;
          }
          await api.approveConnection(target.connectionId, {
            selection: 'new_vault',
            display_name: target.vaultName
          });
        } else {
          if (!target.existingVaultActive) {
            actionError = 'Choose an active server vault before approving this connection.';
            return;
          }
          await api.approveConnection(target.connectionId, {
            selection: 'existing_vault',
            vault_id: target.vaultId
          });
        }
        if (currentConnectionAction(target, generation)) connectionApproved = true;
      } catch (error) {
        if (currentConnectionAction(target, generation)) {
          if (error instanceof ApiError && error.status === 401) reportAsyncError(error, 'Unable to approve this connection.', target.epoch);
          else actionError = error instanceof Error ? error.message : 'Unable to approve this connection.';
        }
      } finally {
        if (connectionOperationGeneration === generation) connectionOperationInFlight = false;
      }
    });
  }

  async function denyPendingConnection() {
    if (!connectionReview || connectionOperationInFlight) return;
    const target = {
      connectionId: connectionReview.connection_id,
      epoch: stateEpoch,
      account: accountEpoch,
      userId: session?.user_id ?? ''
    };
    const generation = ++connectionOperationGeneration;
    connectionOperationInFlight = true;
    actionError = '';
    try {
      await api.denyConnection(target.connectionId);
      if (currentConnectionAction(target, generation)) connectionReview = { ...connectionReview, status: 'denied' };
    } catch (error) {
      if (currentConnectionAction(target, generation)) {
        if (error instanceof ApiError && error.status === 401) reportAsyncError(error, 'Unable to deny this connection.', target.epoch);
        else actionError = error instanceof Error ? error.message : 'Unable to deny this connection.';
      }
    } finally {
      if (connectionOperationGeneration === generation) connectionOperationInFlight = false;
    }
  }

  async function renameDevice(device: DashboardDevice, deviceName: string) {
    if (!vaultId || selectedVaultDeleting) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    actionError = '';
    try {
      const renamed = await api.renameDevice(requestedVaultId, device.device_id, deviceName);
      if (!currentRequest(requestedVaultId, epoch) || !dashboard) return;
      dashboard = {
        ...dashboard,
        devices: dashboard.devices.map((candidate) => candidate.device_id === renamed.device_id ? { ...candidate, device_name: renamed.device_name } : candidate)
      };
      conflicts = conflicts.map((conflict) => conflict.device_id === renamed.device_id ? { ...conflict, device_name: renamed.device_name } : conflict);
      if (review?.conflict.device_id === renamed.device_id) review = { ...review, device_name: renamed.device_name };
      notice = `Device renamed to ${renamed.device_name}.`;
      await refreshDashboardStatus(true);
    } catch (error) {
      if (!currentRequest(requestedVaultId, epoch)) return;
      if (error instanceof ApiError && error.status === 401) reportAsyncError(error, 'Unable to rename this device.', epoch);
      throw error;
    }
  }

  async function revokeDevice(device: DashboardDevice) {
    if (!vaultId || selectedVaultDeleting) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const deviceId = device.device_id;
    const deviceName = device.device_name;
    return withRecentAuth(async () => {
      if (!confirm(`Revoke ${deviceName}? This stops its sync access. Local vault files are not deleted.`)) return;
      await api.revokeDevice(requestedVaultId, deviceId);
      if (!currentRequest(requestedVaultId, epoch)) return;
      notice = 'Device revoked.';
      await refreshVault();
    });
  }

  async function submitResolution(submission: ConflictResolutionSubmission) {
    if (!vaultId || selectedVaultDeleting || !review || review.stale) return;
    actionError = '';
    notice = '';
    const conflictId = review.conflict.conflict_id;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    try {
      await api.resolveConflict({
        vaultId: requestedVaultId,
        conflictId,
        expectedMain: review.expected_main,
        ...submission
      });
      if (!currentRequest(requestedVaultId, epoch) || selectedConflictId !== conflictId) return;
      notice = 'Conflict resolved.';
      selectedConflictId = '';
      review = null;
      await refreshVault();
    } catch (error) {
      if (!currentRequest(requestedVaultId, epoch) || selectedConflictId !== conflictId) return;
      if (error instanceof ApiError && error.code === 'stale_conflict_review' && review?.conflict.conflict_id === conflictId) {
        review = { ...review, stale: true };
        conflicts = conflicts.map((conflict) =>
          conflict.conflict_id === conflictId ? { ...conflict, stale: true, status_label: 'Stale review' } : conflict
        );
        actionError = 'This conflict review is stale. Refresh it before submitting a resolution.';
        return;
      }
      reportAsyncError(error, 'Unable to resolve this conflict.', epoch);
    }
  }

  async function searchHistory(force = false) {
    if (!vaultId || selectedVaultDeleting || !historyPath.trim() || (busy && !force)) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session?.user_id ?? '';
    const path = historyPath.trim();
    const generation = ++historyRequestGeneration;
    history = null;
    selectedHistory = null;
    historyVersion = null;
    historyError = '';
    historyLoading = true;
    try {
      const nextHistory = await api.historyQuery(requestedVaultId, path);
      if (!currentRequest(requestedVaultId, epoch) || accountEpoch !== account || session?.user_id !== userId || generation !== historyRequestGeneration || historyPath.trim() !== path) return;
      history = nextHistory;
      selectedHistory = nextHistory.versions[0] ?? null;
      historyVersion = null;
      if (selectedHistory) await loadHistoryVersion(selectedHistory);
    } catch (error) {
      if (currentRequest(requestedVaultId, epoch) && accountEpoch === account && session?.user_id === userId && generation === historyRequestGeneration) {
        if (error instanceof ApiError && error.status === 401) {
          reportAsyncError(error, 'Unable to search note history.', epoch);
        } else {
          historyError = error instanceof Error ? error.message : 'Unable to search note history.';
        }
      }
    } finally {
      if (stateEpoch === epoch && accountEpoch === account && generation === historyRequestGeneration) historyLoading = false;
    }
  }

  async function loadHistoryVersion(version: NoteHistoryVersion) {
    if (!vaultId || selectedVaultDeleting || !history || busy) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session?.user_id ?? '';
    const commit = version.commit;
    const path = version.path;
    const generation = ++historyRequestGeneration;
    selectedHistory = version;
    historyVersion = null;
    historyError = '';
    historyLoading = true;
    try {
      const nextVersion = await api.historyVersion(requestedVaultId, path, commit);
      if (!currentRequest(requestedVaultId, epoch) || accountEpoch !== account || session?.user_id !== userId || generation !== historyRequestGeneration || selectedHistory?.commit !== commit || selectedHistory.path !== path) return;
      historyVersion = nextVersion;
      historyDiffTab = nextVersion.rendered_markdown_diff ? 'rendered' : 'source';
    } catch (error) {
      if (currentRequest(requestedVaultId, epoch) && accountEpoch === account && session?.user_id === userId && generation === historyRequestGeneration) {
        if (error instanceof ApiError && error.status === 401) {
          reportAsyncError(error, 'Unable to load history version.', epoch);
        } else {
          historyError = error instanceof Error ? error.message : 'Unable to load history version.';
        }
      }
    } finally {
      if (stateEpoch === epoch && accountEpoch === account && generation === historyRequestGeneration) historyLoading = false;
    }
  }

  function revealPluginHistoryContent() {
    if (!vaultId || selectedVaultDeleting || !selectedHistory || busy) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session?.user_id ?? '';
    const selected = { path: selectedHistory.path, commit: selectedHistory.commit };
    withRecentAuth(async () => {
      if (!currentRequest(requestedVaultId, epoch) || accountEpoch !== account || session?.user_id !== userId || selectedHistory?.commit !== selected.commit || selectedHistory.path !== selected.path) return;
      const generation = ++historyRequestGeneration;
      const revealed = await api.historyVersion(requestedVaultId, selected.path, selected.commit, true);
      if (!currentRequest(requestedVaultId, epoch) || accountEpoch !== account || session?.user_id !== userId || generation !== historyRequestGeneration || selectedHistory?.commit !== selected.commit || selectedHistory.path !== selected.path) return;
      historyVersion = revealed;
      historyDiffTab = 'source';
      notice = 'Sensitive plugin file content revealed for this selected version.';
    });
  }

  async function restoreSelectedVersion() {
    if (!vaultId || selectedVaultDeleting || !history || !selectedHistory || busy) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const target = { path: history.path, sourcePath: selectedHistory.path, commit: selectedHistory.commit, expectedMain: history.current_main };
    await withRecentAuth(async () => {
      if (!currentRequest(requestedVaultId, epoch) || accountEpoch !== account || history?.path !== target.path || selectedHistory?.path !== target.sourcePath || selectedHistory.commit !== target.commit) return;
      if (!confirm(`Restore ${target.sourcePath} from commit ${target.commit} to ${target.path}? This creates a new history entry and does not rewrite existing history.`)) return;
      busy = true;
      try {
        await api.restoreHistoryVersion(requestedVaultId, target.path, target.commit, target.expectedMain, target.sourcePath);
        if (!currentRequest(requestedVaultId, epoch) || accountEpoch !== account) return;
        notice = 'Note restored.';
        await refreshVault();
        if (currentRequest(requestedVaultId, epoch) && accountEpoch === account) await searchHistory(true);
      } finally {
        if (stateEpoch === epoch && accountEpoch === account) busy = false;
      }
    });
  }

  function handleMaintenanceAction(action: NonNullable<MaintenanceRow['action']>) {
    if (action === 'view_backup_contract') {
      maintenanceDetailOpen = page !== 'Maintenance' || !maintenanceDetailOpen;
      page = 'Maintenance';
      return;
    }
    if (!vaultId || selectedVaultDeleting) return;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    withRecentAuth(async () => {
      const result = await api.startGitMaintenance(requestedVaultId);
      if (!currentRequest(requestedVaultId, epoch)) return;
      notice = result.detail;
      await refreshVault();
    });
  }

  async function logout() {
    if (logoutInFlight) return;
    logoutInFlight = true;
    busy = true;
    clearScopedState(true);
    session = null;
    username = '';
    password = '';
    authError = '';
    logoutFailed = false;
    try {
      await api.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        logoutFailed = true;
        authError = 'The local view was cleared, but server sign-out failed. Retry signing out.';
      }
    } finally {
      api.csrfToken = '';
      logoutInFlight = false;
      busy = false;
    }
  }

  function shortId(value: string | null | undefined) {
    return value ? `${value.slice(0, 10)}...` : '-';
  }

  function sortConflicts(items: DashboardConflict[]) {
    return [...items].sort((left, right) => {
      if (left.status !== right.status) return left.status === 'open' ? -1 : 1;
      return right.created_at.localeCompare(left.created_at);
    });
  }

</script>

{#if !session}
  <AuthScreen
    setupComplete={setupComplete}
    bind:username
    bind:password
    authError={authError}
    {busy}
    {logoutFailed}
    {logoutInFlight}
    onSubmit={authenticate}
    onRetryLogout={logout}
  />
{:else if connectionId}
  <ConnectionScreen
    bind:connectionReview
    bind:connectionSelection
    bind:connectionVaultId
    bind:connectionVaultName
    {connectionApproved}
    operationPending={connectionOperationInFlight}
    modalOpen={reauthOpen}
    {actionError}
    onApprove={approvePendingConnection}
    onDeny={denyPendingConnection}
  />
{:else}
  <Shell
    {page}
    {nav}
    {vaults}
    {vaultId}
    {selectedVault}
    {dashboard}
    {unresolvedCount}
    {lastRefreshed}
    {dashboardStatusCurrent}
    {busy}
    modalOpen={reauthOpen || deletionModalOpen}
    vaultDeleting={selectedVaultDeleting}
    refreshing={dashboardRefreshInFlight || deletionRefreshInFlight}
    onPageChange={(nextPage) => (page = nextPage as Page)}
    onVaultChange={selectVault}
    onRefresh={requestRefreshVault}
    onLogout={logout}
  >
    <svelte:fragment slot="actions">
      {#if page === 'Overview'}
        <button class="secondary" disabled={busy || !selectedVault || selectedVaultDeleting} on:click={openVaultRename}>Rename vault</button>
        <button class="primary" disabled={busy} on:click={() => { renameVaultOpen = false; createVaultOpen = true; newVaultName = ''; }}>New vault</button>
      {/if}
    </svelte:fragment>

    {#if notice}<p class="notice" role="status">{notice}</p>{/if}
      {#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}

      {#if renameVaultOpen}
        <main class="page">
          <section class="panel full">
            <h2>Rename vault</h2>
            <p class="muted">This changes server display metadata only. It does not rename the physical Obsidian vault folder on any device.</p>
            <form class="inline-form" on:submit|preventDefault={renameVault}>
              <label>Vault name<input bind:value={renameVaultName} maxlength="80" disabled={busy} /></label>
              <button type="button" class="secondary" disabled={busy} on:click={() => { renameVaultOpen = false; renameVaultId = ''; }}>Cancel</button>
              <button class="primary" disabled={busy || !renameVaultName.trim()}>Save name</button>
            </form>
          </section>
        </main>
      {:else if page === 'Settings'}
        <SettingsPage
          {session}
          recentAuthValid={recentAuthValid}
          {diagnostics}
          {diagnosticsError}
          {diagnosticsLoading}
          {busy}
          onRefreshDiagnostics={requestRefreshDiagnostics}
          onLoadMoreDiagnostics={() => void loadMoreDiagnostics()}
          onDeleteDiagnostics={deleteDiagnostics}
          onSignOut={logout}
          {deletions}
          {selectedVault}
          vaultDeleting={selectedVaultDeleting}
          deletionBusy={deletionRequestInFlight}
          onOpenVaultDeletion={openVaultDeletion}
        >
          <svelte:fragment slot="destructive-actions">
            <section class="panel settings-create-panel" aria-labelledby="settings-create-vault-title">
              {#if createVaultOpen}
                <h2 id="settings-create-vault-title">Create vault</h2>
                <form class="inline-form" on:submit|preventDefault={createVault}>
                  <label>Vault name<input bind:value={newVaultName} maxlength="80" disabled={busy} /></label>
                  <button type="button" class="secondary" disabled={busy} on:click={() => (createVaultOpen = false)}>Cancel</button>
                  <button class="primary" disabled={busy || !newVaultName.trim()}>Create vault</button>
                </form>
              {:else}
                <div class="section-heading"><div><p class="eyebrow">Server scope</p><h2 id="settings-create-vault-title">Create a vault</h2></div><button class="secondary" disabled={busy} on:click={() => { createVaultOpen = true; newVaultName = ''; }}>New vault</button></div>
                <p class="muted">Creating a new server vault does not restore a deleted vault or its receipt.</p>
              {/if}
            </section>
          </svelte:fragment>
        </SettingsPage>
      {:else if createVaultOpen}
        <main class="page">
          <section class="panel full">
            <h2>Create vault</h2>
            <form class="inline-form" on:submit|preventDefault={createVault}>
              <label>Vault name<input bind:value={newVaultName} maxlength="80" disabled={busy} /></label>
              <button type="button" class="secondary" disabled={busy} on:click={() => (createVaultOpen = false)}>Cancel</button>
              <button class="primary" disabled={busy || !newVaultName.trim()}>Create vault</button>
            </form>
          </section>
        </main>
      {:else if vaults.length === 0}
        <main class="page">
          <section class="panel full">
            <h2>Create vault</h2>
            <form class="inline-form" on:submit|preventDefault={createVault}>
              <label>Vault name<input bind:value={newVaultName} maxlength="80" disabled={busy} /></label>
              <button class="primary" disabled={busy || !newVaultName.trim()}>Create vault</button>
            </form>
          </section>
        </main>
      {:else if selectedVaultDeleting && page !== 'Settings'}
        <main class="page">
          <section class="panel full deletion-progress" aria-live="polite">
            <span class="eyebrow">Server vault operation</span>
            <h2>Vault deletion in progress</h2>
            <Status label="Deleting" />
            <p class="muted">The server accepted this deletion and is still working. Dashboard, devices, conflicts, history, and other target actions are unavailable until completion is reported.</p>
            <button class="secondary" on:click={() => (page = 'Settings')}>View deletion status in Settings</button>
          </section>
        </main>
      {:else if page === 'Overview' && dashboard}
        <Overview
          {dashboard}
          {conflicts}
          {unresolvedCount}
          statusCurrent={dashboardStatusCurrent}
          {syncSummary}
          onAttention={handleAttentionAction}
          onMaintenance={handleMaintenanceAction}
          onRename={renameDevice}
          onRevoke={revokeDevice}
        />
      {:else if page === 'Devices' && dashboard}
        <main class="page">
          <section class="panel full">
            <h2>Devices</h2>
            <DeviceTable devices={dashboard.devices} recommendedPluginVersion={dashboard.recommended_plugin_version} statusCurrent={dashboardStatusCurrent} onRename={renameDevice} onRevoke={revokeDevice} />
          </section>
        </main>
      {:else if page === 'Conflicts'}
        <main class="conflict-layout">
          <ConflictQueue
            {conflicts}
            {unresolvedCount}
            selectedConflictId={selectedConflictId}
            listOpen={conflictListOpen}
            showList={conflictListOpen || !review}
            onSelect={selectConflict}
            onOpen={openConflictFromList}
            onToggleList={() => (conflictListOpen = !conflictListOpen)}
          />
          {#if conflictListOpen || !review}<span class="visually-hidden">Conflict queue list shown.</span>{/if}

          {#if review}
            <ConflictWorkbench
              {review}
              conflictType={selectedConflict?.conflict_type ?? 'Path overlap'}
              onSubmit={submitResolution}
              onRefresh={refreshReview}
            />
          {:else if conflicts.length === 0}
            <section class="panel full"><p class="muted">No conflicts to review.</p></section>
          {/if}
        </main>
      {:else if page === 'History'}
        <HistoryPage
          bind:historyPath
          {history}
          {selectedHistory}
          {historyVersion}
          bind:historyDiffTab
          {historyError}
          {historyLoading}
          {busy}
          onSearch={searchHistory}
          onSelectVersion={loadHistoryVersion}
          onReveal={revealPluginHistoryContent}
          onRestore={restoreSelectedVersion}
        />
      {:else if page === 'Maintenance' && dashboard}
        <MaintenancePage
          health={dashboard.health}
          rows={dashboard.maintenance}
          detailOpen={maintenanceDetailOpen}
          onAction={handleMaintenanceAction}
        />
      {:else if page !== 'Settings' && !dashboard}
        <main class="page">
          <section class="panel full loading-state" aria-live="polite">
            <span class="eyebrow">Vault status</span>
            <h2>Loading current vault</h2>
            <p class="muted">The previous vault view is cleared until this vault reports fresh server status.</p>
          </section>
        </main>
      {:else}
        <SettingsPage
          {session}
          recentAuthValid={recentAuthValid}
          {diagnostics}
          {diagnosticsError}
          {diagnosticsLoading}
          {busy}
          onRefreshDiagnostics={requestRefreshDiagnostics}
          onLoadMoreDiagnostics={() => void loadMoreDiagnostics()}
          onDeleteDiagnostics={deleteDiagnostics}
          onSignOut={logout}
          {deletions}
          {selectedVault}
          vaultDeleting={selectedVaultDeleting}
          deletionBusy={deletionRequestInFlight}
          onOpenVaultDeletion={openVaultDeletion}
        />
      {/if}
  </Shell>
{/if}

{#if reauthOpen}
  <ReauthModal
    bind:username
    bind:password
    {authError}
    {busy}
    onSubmit={authenticate}
    onCancel={cancelReauth}
  />
{/if}

{#if deletionModalOpen && deletionTarget}
  <VaultDeletionModal
    displayName={deletionTarget.displayName}
    vaultId={deletionTarget.vaultId}
    busy={deletionRequestInFlight}
    error={deletionError}
    onSubmit={submitVaultDeletion}
    onCancel={cancelVaultDeletion}
  />
{/if}
