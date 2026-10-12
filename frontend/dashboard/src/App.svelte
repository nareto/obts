<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { ApiError, DashboardApi } from './api/client';
  import {
    currentHistoryIndex,
    currentLocationHref,
    currentRoute,
    initHistoryIndex,
    navigate,
    routeHref,
    shouldInterceptClick,
    subscribe,
    undoNavigation,
    vaultRoute,
    type NavigationSource,
    type Route,
    type Section
  } from './router';
  import type { AttentionItem } from './components/Attention.svelte';
  import AuthScreen from './components/AuthScreen.svelte';
  import ConflictQueue from './components/ConflictQueue.svelte';
  import ConflictWorkbench from './components/ConflictWorkbench.svelte';
  import ConnectionScreen from './components/ConnectionScreen.svelte';
  import DeviceRemovalModal from './components/DeviceRemovalModal.svelte';
  import type { DiscardReason, RemovalMode } from './components/DeviceRemovalModal.svelte';
  import DevicesPage from './components/DevicesPage.svelte';
  import HistoryPage from './components/HistoryPage.svelte';
  import MaintenancePage from './components/MaintenancePage.svelte';
  import Overview from './components/Overview.svelte';
  import ReauthModal from './components/ReauthModal.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import Shell from './components/Shell.svelte';
  import Status from './components/Status.svelte';
  import VaultDeletionModal from './components/VaultDeletionModal.svelte';
  import { LiveUpdates, type LiveRefreshRequest, type LiveState } from './liveUpdates';
  import { isDeviceRevoked, liveAnnouncement, liveIndicator, removalFailureText } from './presentation';
  import { RefreshScheduler, type RefreshScope } from './refreshScheduler';
  import type {
    DashboardConflict,
    ConnectionReview,
    ConflictResolutionPreview,
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
    VaultSummary,
    MetadataConflictRule,
    VaultSyncSettings,
    VaultSyncSettingsPreview
  } from './api/types';

  const api = new DashboardApi();
  const scheduler = new RefreshScheduler({
    run: runScheduledRefresh,
    onRunError: (error) => {
      dashboardStatusCurrent = false;
      reportAsyncError(error, 'Unable to refresh dashboard status.');
    }
  });
  /** Fallback polling while the live stream is not connected. */
  const DASHBOARD_REFRESH_INTERVAL_MS = 15 * 1000;
  /** While live, status is re-read this often so clock-dependent labels keep aging. */
  const DASHBOARD_LIVE_AGING_INTERVAL_MS = 60 * 1000;
  const DIAGNOSTICS_STALE_MS = 60 * 1000;
  const nav = ['Overview', 'Devices', 'Conflicts', 'History', 'Maintenance', 'Settings'] as const;
  type Page = (typeof nav)[number];
  const sectionByPage: Record<Page, Section> = {
    Overview: 'overview', Devices: 'devices', Conflicts: 'conflicts', History: 'history', Maintenance: 'maintenance', Settings: 'settings'
  };
  const pageBySection: Record<Section, Page> = {
    overview: 'Overview', devices: 'Devices', conflicts: 'Conflicts', history: 'History', maintenance: 'Maintenance', settings: 'Settings'
  };

  let session: Session | null = null;
  let setupComplete = true;
  let username = '';
  let password = '';
  let authError = '';
  let route: Route = currentRoute();
  let committedHref = currentLocationHref();
  let committedIndex = currentHistoryIndex();
  let focusToken = 0;
  /** Monotonic count of applied route changes (push, replace, popstate); async completions compare it instead of URLs. */
  let routeSeq = 0;
  let page: Page = 'Overview';
  let vaultsLoaded = false;
  let settingsDraftDirty = false;
  let resolutionDraftDirty = false;
  let unloadGuardActive = false;
  const refreshOnOpen = new Set<string>();
  let vaults: VaultSummary[] = [];
  let deletions: VaultDeletionStatus[] = [];
  let vaultId = '';
  let newVaultName = '';
  let createVaultOpen = false;
  let renameVaultId = '';
  let renameVaultName = '';
  let renameVaultOpen = false;
  let dashboard: DashboardSummary | null = null;
  let vaultSyncSettings: VaultSyncSettings | null = null;
  let vaultSyncSettingsError = '';
  let vaultSyncSettingsLoading = false;
  let vaultSyncSettingsSaving = false;
  let vaultSyncSettingsLoadedFor = '';
  let vaultSyncSettingsGeneration = 0;
  let diagnostics: DiagnosticEventsResponse | null = null;
  let diagnosticsError = '';
  let diagnosticsLoading = false;
  /** The user followed `next_cursor` at least once, so an automatic refetch would collapse the loaded pages. */
  let diagnosticsPaged = false;
  /** Diagnostics changed while paged: the header offers a manual refresh instead of replacing the list. */
  let diagnosticsNewActivity = false;
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
  let reauthTrigger: HTMLElement | null = null;
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
  let noticeLink: { forNotice: string; label: string; route: Route } | null = null;
  let actionError = '';
  let lastRefreshed: string | null = null;
  let nowMs = Date.now();
  let dashboardRefreshInFlight = false;
  let dashboardRefreshGeneration = 0;
  let dashboardRefreshOwner: { vaultId: string; epoch: number; generation: number } | null = null;
  let dashboardStatusCurrent = true;
  let live: LiveUpdates | null = null;
  let liveState: LiveState = 'connecting';
  let liveReconnectingSince: number | null = null;
  let liveAnnouncementText = '';
  let liveKeyPrevious = '';
  /** A stream (re)connect asked for a full snapshot that has not settled yet; `Live` is not shown before it lands. */
  let connectRefreshPending = false;
  /** Bumped per connect request so a run only clears the obligation it actually started after. */
  let connectRefreshToken = 0;
  let diagnosticsRefetchWanted = false;
  let stateEpoch = 0;
  let logoutInFlight = false;
  let logoutFailed = false;
  let accountEpoch = 0;
  let reviewRequestGeneration = 0;
  let previewRequestGeneration = 0;
  let historyRequestGeneration = 0;
  let diagnosticsRequestGeneration = 0;
  let diagnosticsFetchedAt = 0;
  let settingsShownPrevious = false;
  let diagnosticsDeleteGeneration = 0;
  let diagnosticsDeleteInFlight = false;
  let deletionModalOpen = false;
  let deletionTarget: { vaultId: string; displayName: string; epoch: number; account: number; userId: string; generation: number } | null = null;
  let deletionError = '';
  let deletionRequestGeneration = 0;
  let deletionRequestInFlight = false;
  let deletionRefreshGeneration = 0;
  let deletionRefreshInFlight = false;
  type RemovalTarget = { vaultId: string; deviceId: string; deviceName: string; epoch: number; account: number; userId: string; generation: number };
  let removalTarget: RemovalTarget | null = null;
  let removalMode: RemovalMode = 'standard';
  let removalDiscardReason: DiscardReason | null = null;
  let removalError = '';
  let removalFailureNote = '';
  let removalConflictsLink = false;
  let removalRequestGeneration = 0;
  let removalRequestInFlight = false;

  $: selectedVault = vaults.find((vault) => vault.vault_id === vaultId) ?? null;
  $: if (session && page === 'Settings' && selectedVault && vaultSyncSettingsLoadedFor !== selectedVault.vault_id && !vaultSyncSettingsLoading && !vaultSyncSettingsError) {
    void loadVaultSyncSettings();
  }
  $: unresolvedCount = dashboard?.unresolved_conflict_count ?? conflicts.filter((conflict) => conflict.status === 'open').length;
  $: selectedConflict = conflicts.find((conflict) => conflict.conflict_id === selectedConflictId) ?? null;
  $: selectedDeletion = deletions.find((deletion) => deletion.vault_id === vaultId) ?? null;
  $: selectedVaultDeleting = selectedVault?.status === 'deleting' || selectedDeletion?.status === 'deleting';
  $: recentAuthValid = session ? Date.parse(session.recent_auth_expires_at) > nowMs : false;
  $: syncSummary = dashboardSyncSummary(dashboard, dashboardStatusCurrent);
  $: indicator = liveIndicator({ state: liveState, statusCurrent: dashboardStatusCurrent, snapshotPending: connectRefreshPending, reconnectingSince: liveReconnectingSince, now: nowMs });
  $: syncLive(live, session && !connectionId ? session.user_id : '');
  $: page = routePage(route);
  $: routeConflictId = route.kind === 'vault' && route.section === 'conflicts' ? route.conflictId ?? '' : '';
  $: routeProblem = computeRouteProblem(route, vaults, vaultsLoaded);
  $: conflictNotFound = !!routeConflictId && !!dashboard && !review && !conflicts.some((conflict) => conflict.conflict_id === routeConflictId);
  $: navHrefs = Object.fromEntries(nav.map((item) => [item, routeHref(navRoute(item, vaultId, vaults))]));
  $: firstVaultRoute = vaults[0] ? vaultRoute(vaults[0].vault_id, 'overview') : ({ kind: 'account-settings' } as Route);
  $: settingsRouteShown = vaultsLoaded && (route.kind === 'account-settings' || (route.kind === 'vault' && route.section === 'settings' && vaultId === route.vaultId));
  $: if (session && !connectionId && settingsRouteShown && !diagnostics && !diagnosticsLoading && !diagnosticsError) void refreshDiagnostics();
  $: if (settingsRouteShown !== settingsShownPrevious) onSettingsVisibility(settingsRouteShown);
  $: removalDevice = removalTarget && dashboard ? dashboard.devices.find((device) => device.device_id === removalTarget?.deviceId) ?? null : null;
  $: devicesView = route.kind === 'vault' && route.section === 'devices' && route.devicesView === 'revoked' ? 'revoked' as const : 'active' as const;
  $: draftDirty = settingsDraftDirty || resolutionDraftDirty;
  $: setUnloadGuard(draftDirty);
  $: if (!connectionId) document.title = documentTitle(!!session, route, routeProblem, page, selectedVault?.display_name ?? '');

  function routePage(value: Route): Page {
    if (value.kind === 'vault') return pageBySection[value.section];
    return value.kind === 'account-settings' ? 'Settings' : 'Overview';
  }

  function computeRouteProblem(value: Route, list: VaultSummary[], loaded: boolean): 'page' | 'vault' | null {
    if (value.kind === 'not-found') return 'page';
    if (!loaded) return null;
    if (value.kind === 'vault') return list.some((vault) => vault.vault_id === value.vaultId) ? null : 'vault';
    if (value.kind === 'root' && value.legacyVault) return list.some((vault) => vault.vault_id === value.legacyVault) ? null : 'vault';
    return null;
  }

  function documentTitle(signedIn: boolean, value: Route, problem: 'page' | 'vault' | null, current: Page, vaultName: string): string {
    if (!signedIn) return 'obts dashboard';
    if (problem) return `${problem === 'vault' ? 'Vault not found' : 'Page not found'} · OBTS`;
    if (value.kind === 'account-settings') return 'Settings · OBTS';
    if (value.kind === 'vault' && vaultName) return `${current} · ${vaultName} · OBTS`;
    return 'OBTS';
  }

  function navRoute(item: string, activeVaultId: string, list: VaultSummary[]): Route {
    const section = sectionByPage[item as Page];
    if (section === 'settings' && !activeVaultId) return { kind: 'account-settings' };
    const target = activeVaultId || list[0]?.vault_id;
    return target ? vaultRoute(target, section) : { kind: 'root' };
  }

  function discardMessage() {
    return settingsDraftDirty
      ? 'Discard your unsaved sync rule changes?'
      : 'Discard your in-progress conflict resolution?';
  }

  function blockUnload(event: BeforeUnloadEvent) {
    event.preventDefault();
    event.returnValue = '';
  }

  function setUnloadGuard(active: boolean) {
    if (active === unloadGuardActive) return;
    unloadGuardActive = active;
    if (active) window.addEventListener('beforeunload', blockUnload);
    else window.removeEventListener('beforeunload', blockUnload);
  }

  const setSettingsDraftDirty = (dirty: boolean) => { settingsDraftDirty = dirty; };
  const setResolutionDraftDirty = (dirty: boolean) => { resolutionDraftDirty = dirty; };

  /** The only in-app navigation seam: every link, selector and flow goes through the router here. */
  function go(next: Route, options: { replace?: boolean } = {}): boolean {
    const target = resolveBareConflicts(next);
    if (routeHref(target) === currentLocationHref()) return false;
    if (!options.replace && draftDirty && !window.confirm(discardMessage())) return false;
    navigate(target, options);
    if (!options.replace) focusToken += 1;
    return true;
  }

  /** A bare conflicts route resolves to the auto-selected conflict before it is pushed, so no duplicate entry is created. */
  function resolveBareConflicts(next: Route): Route {
    if (next.kind !== 'vault' || next.section !== 'conflicts' || next.conflictId) return next;
    if (vaultId !== next.vaultId || !dashboard || selectedVaultDeleting) return next;
    const first = conflicts.find((conflict) => conflict.status === 'open');
    return first ? vaultRoute(next.vaultId, 'conflicts', { conflictId: first.conflict_id }) : next;
  }

  function onRoute(next: Route, source: NavigationSource) {
    if (source === 'popstate' && draftDirty && currentLocationHref() !== committedHref && !window.confirm(discardMessage())) {
      committedIndex = undoNavigation(committedHref, committedIndex);
      return;
    }
    committedHref = currentLocationHref();
    committedIndex = currentHistoryIndex();
    route = next;
    routeSeq += 1;
    resetRemoval();
    if (source === 'popstate') focusToken += 1;
    void applyRoute();
  }

  function handleLinkClick(event: MouseEvent, target: Route) {
    if (!shouldInterceptClick(event, event.currentTarget as HTMLAnchorElement)) return;
    event.preventDefault();
    go(target);
  }

  function navigateToPage(item: string) {
    go(navRoute(item, vaultId, vaults));
  }

  function changeVault(nextVaultId: string) {
    if (!nextVaultId) return;
    const section = route.kind === 'vault' ? route.section : 'overview';
    go(vaultRoute(nextVaultId, section, section === 'devices' && route.kind === 'vault' ? { devicesView: route.devicesView } : {}));
  }

  /** Reconciles state with the URL; the vault switch reuses selectVault's scope clearing and epoch path. */
  function applyRoute(): Promise<void> | void {
    if (!session || connectionId || !vaultsLoaded) return;
    const current = route;
    if (current.kind === 'root') {
      if (current.legacyVault) {
        if (vaults.some((vault) => vault.vault_id === current.legacyVault)) navigate(vaultRoute(current.legacyVault, 'settings'), { replace: true });
        else if (vaultId) leaveVault();
        return;
      }
      const first = vaults[0];
      navigate(first ? vaultRoute(first.vault_id, 'overview') : { kind: 'account-settings' }, { replace: true });
      return;
    }
    if ((current.kind === 'vault' || current.kind === 'account-settings') && routeHref(current) !== currentLocationHref()) {
      navigate(current, { replace: true });
      return;
    }
    if (current.kind === 'vault' && !vaults.some((vault) => vault.vault_id === current.vaultId) && deletions.some((deletion) => deletion.vault_id === current.vaultId)) {
      navigate({ kind: 'account-settings' }, { replace: true });
      return;
    }
    const target = current.kind === 'vault' ? vaults.find((vault) => vault.vault_id === current.vaultId) : undefined;
    if (!target) {
      if (vaultId) leaveVault();
      return;
    }
    if (vaultId !== target.vault_id) return selectVault(target.vault_id);
    return syncConflictRoute(false);
  }

  function leaveVault() {
    vaultId = '';
    clearScopedState();
    busy = false;
  }

  async function syncConflictRoute(reload: boolean) {
    if (route.kind !== 'vault' || route.section !== 'conflicts' || !vaultId || route.vaultId !== vaultId || !dashboard || selectedVaultDeleting) return;
    const conflictId = route.conflictId;
    const requestedVaultId = vaultId;
    if (!conflictId) {
      selectedConflictId = '';
      review = null;
      const first = conflicts.find((conflict) => conflict.status === 'open');
      if (first) navigate(vaultRoute(requestedVaultId, 'conflicts', { conflictId: first.conflict_id }), { replace: true });
      return;
    }
    if (!conflicts.some((conflict) => conflict.conflict_id === conflictId)) {
      reviewRequestGeneration += 1;
      selectedConflictId = '';
      review = null;
      return;
    }
    if (!reload && selectedConflictId === conflictId && review?.conflict.conflict_id === conflictId) return;
    conflictListOpen = false;
    if (refreshOnOpen.delete(conflictId)) await refreshConflictReview(conflictId);
    else await loadReview(conflictId);
  }

  function openConflict(conflictId: string, refresh = false) {
    if (!vaultId) return;
    const next = vaultRoute(vaultId, 'conflicts', { conflictId });
    if (routeHref(next) === currentLocationHref()) {
      void (refresh ? refreshConflictReview(conflictId) : loadReview(conflictId));
      return;
    }
    if (refresh) refreshOnOpen.add(conflictId);
    if (!go(next)) refreshOnOpen.delete(conflictId);
  }

  function clearScopedState(clearAccount = false) {
    stateEpoch += 1;
    resetScheduler();
    if (clearAccount) live?.stop();
    diagnosticsRefetchWanted = false;
    dashboardRefreshGeneration += 1;
    reviewRequestGeneration += 1;
    previewRequestGeneration += 1;
    historyRequestGeneration += 1;
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
    resetRemoval();
    dashboardRefreshOwner = null;
    dashboardRefreshInFlight = false;
    dashboard = null;
    vaultSyncSettings = null;
    vaultSyncSettingsError = '';
    vaultSyncSettingsLoading = false;
    vaultSyncSettingsSaving = false;
    vaultSyncSettingsLoadedFor = '';
    vaultSyncSettingsGeneration += 1;
    if (clearAccount) {
      accountEpoch += 1;
      diagnosticsRequestGeneration += 1;
      diagnosticsLoading = false;
      diagnostics = null;
      diagnosticsPaged = false;
      diagnosticsNewActivity = false;
      diagnosticsFetchedAt = 0;
      diagnosticsError = '';
      vaultsLoaded = false;
      settingsDraftDirty = false;
      resolutionDraftDirty = false;
      refreshOnOpen.clear();
      connectionReview = null;
      connectionApproved = false;
      connectionVaultId = '';
      connectionVaultName = '';
      vaults = [];
      deletions = [];
      vaultId = '';
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
    resetScheduler();
    dashboardRefreshGeneration += 1;
    reviewRequestGeneration += 1;
    previewRequestGeneration += 1;
    historyRequestGeneration += 1;
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
    resetRemoval();
    vaultId = '';
  }

  function resetRemoval() {
    removalRequestGeneration += 1;
    removalTarget = null;
    removalMode = 'standard';
    removalDiscardReason = null;
    removalError = '';
    removalFailureNote = '';
    removalConflictsLink = false;
    removalRequestInFlight = false;
  }

  function showNotice(text: string, link: { label: string; route: Route } | null = null) {
    notice = text;
    noticeLink = link ? { forNotice: text, ...link } : null;
  }

  function reportAsyncError(error: unknown, fallback: string, epoch = stateEpoch) {
    if (stateEpoch !== epoch) return;
    if (error instanceof ApiError && error.status === 401) {
      session = null;
      clearScopedState(true);
      if (!connectionId) navigate({ kind: 'root' }, { replace: true });
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
    const activeDevices = value.devices.filter((device) => !isDeviceRevoked(device));
    if (activeDevices.length === 0) return { label: 'Status unknown', role: 'warning' };
    if (activeDevices.every((device) => device.status_label === 'Synced')) return { label: 'Synced', role: 'success' };
    if (activeDevices.some((device) => ['Blocked', 'Needs recovery', 'Integrity failure', 'Conflict resolution needed', 'Out of sync — file exceeds upload limit', 'Out of sync — upload limit exceeded', 'Out of sync — local recovery required', 'Server repair required'].includes(device.status_label))) {
      return { label: 'Attention required', role: 'danger' };
    }
    if (activeDevices.some((device) => isActiveStatusLabel(device.status_label))) {
      return { label: 'Sync in progress', role: 'info' };
    }
    return { label: 'Not converged', role: 'warning' };
  }

  onDestroy(() => setUnloadGuard(false));

  onMount(() => {
    initHistoryIndex();
    committedIndex = currentHistoryIndex();
    const unsubscribeRoute = subscribe(onRoute);
    void bootstrap();
    const clockInterval = window.setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    // Coming back to the tab or window refreshes through the same scheduler as stream events and polling. A paused
    // stream resumes (and refreshes) itself, so it is skipped here to avoid a duplicate request.
    const refreshWhenVisible = () => {
      if (document.hidden || !session || connectionId || live?.currentState === 'paused') return;
      scheduler.request('vault');
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    const controller = new LiveUpdates({
      createEventSource: typeof window.EventSource === 'function' ? (url) => new window.EventSource(url) : null,
      requestRefresh: onLiveRefresh,
      getSelectedVaultId: () => vaultId,
      checkSession: verifySession,
      onStateChange: onLiveStateChange,
      fallbackIntervalMs: DASHBOARD_REFRESH_INTERVAL_MS,
      agingIntervalMs: DASHBOARD_LIVE_AGING_INTERVAL_MS,
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
      now: () => Date.now(),
      isHidden: () => document.hidden,
      onVisibilityChange: (listener) => {
        document.addEventListener('visibilitychange', listener);
        return () => document.removeEventListener('visibilitychange', listener);
      }
    });
    live = controller;
    return () => {
      unsubscribeRoute();
      window.clearInterval(clockInterval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
      controller.stop();
      live = null;
      resetScheduler();
    };
  });

  function syncLive(controller: LiveUpdates | null, key: string) {
    if (!controller) return;
    if (key === liveKeyPrevious && controller.isStarted === (key !== '')) return;
    liveKeyPrevious = key;
    controller.stop();
    connectRefreshPending = false;
    if (key) controller.start();
  }

  /** Every scheduler reset also forgets the connect obligation: the reset drops the pending run that would clear it. */
  function resetScheduler() {
    scheduler.reset();
    connectRefreshPending = false;
  }

  function onLiveStateChange(next: LiveState, previous: LiveState) {
    liveState = next;
    if (next !== 'reconnecting') liveReconnectingSince = null;
    else if (previous !== 'reconnecting' || liveReconnectingSince === null) liveReconnectingSince = Date.now();
    liveAnnouncementText = liveAnnouncement(next, previous) ?? (next === 'live' || next === 'reconnecting' ? liveAnnouncementText : '');
  }

  /** The one entry point for stream events, polling and resume: record the obligation, never fetch directly. */
  function onLiveRefresh(request: LiveRefreshRequest) {
    if (!session || connectionId) return;
    noteDiagnosticsInvalidation(request.source);
    if (request.source === 'connect') {
      connectRefreshToken += 1;
      connectRefreshPending = true;
    }
    scheduler.request(request.scope);
  }

  /** Session check used after stream errors: a 401 runs the normal logged-out handling; other failures are not auth failures. */
  async function verifySession(): Promise<boolean> {
    const epoch = stateEpoch;
    try {
      await api.session();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        reportAsyncError(error, 'Your session ended. Sign in to continue.', epoch);
        return false;
      }
      return true;
    }
  }

  /**
   * Settings shows account-level diagnostics. An event (an invalidation for the selected vault or the account) and a
   * stream connect, which may follow missed events, both make them stale. They are refetched once after the coalesced
   * refresh, and only while Settings is shown (never from Overview or other pages). A missing cache (the previous load
   * failed or never ran) does not suppress the refetch.
   */
  function noteDiagnosticsInvalidation(source: LiveRefreshRequest['source']) {
    if (source === 'poll' || source === 'visibility') return;
    diagnosticsFetchedAt = 0;
    if (settingsRouteShown) diagnosticsRefetchWanted = true;
  }

  async function runScheduledRefresh(scope: RefreshScope) {
    // The run fetches after this point, so it serves every connect request recorded so far; a newer one stays pending.
    const serves = connectRefreshToken;
    try {
      if (!session || connectionId) return;
      const epoch = stateEpoch;
      const account = accountEpoch;
      if (scope === 'full') await refreshAll(false);
      if (session && stateEpoch === epoch) await refreshDashboardStatus(true);
      if (connectRefreshToken === serves) connectRefreshPending = false;
      if (diagnosticsRefetchWanted && session && accountEpoch === account) {
        diagnosticsRefetchWanted = false;
        if (settingsRouteShown && !diagnosticsDeleteInFlight) await refreshDiagnostics(true);
      }
    } catch (error) {
      dashboardStatusCurrent = false;
      throw error;
    } finally {
      if (connectRefreshToken === serves) connectRefreshPending = false;
    }
  }

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

  /** Every refresh registers with the scheduler so background triggers queue behind it instead of superseding it. */
  async function tracked<T>(work: () => Promise<T>): Promise<T> {
    const end = scheduler.begin();
    try {
      return await work();
    } finally {
      end();
    }
  }

  /** `reconcileRoute: false` is the quiet account refresh: the route is only re-applied if the selected vault vanished or none is selected. */
  function refreshAll(reconcileRoute = true) {
    return tracked(() => refreshAllNow(reconcileRoute));
  }

  async function refreshAllNow(reconcileRoute: boolean) {
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
    const selectedVanished = !!previousVaultId && !nextVaults.some((vault) => vault.vault_id === previousVaultId);
    if (selectedVanished) clearTargetPresentation(previousVaultId);
    vaults = nextVaults;
    deletions = deletionList.deletions;
    vaultsLoaded = true;
    if (reconcileRoute || selectedVanished || !vaultId) await applyRoute();
  }

  /**
   * `automatic` refetches (events, connects, ageing) never replace pages the user loaded with "Load more": they only
   * flag new activity. A manual refresh always reloads the first page.
   */
  async function refreshDiagnostics(automatic = false) {
    if (automatic && diagnosticsPaged && diagnostics) {
      diagnosticsNewActivity = true;
      return;
    }
    const epoch = accountEpoch;
    const userId = session?.user_id ?? '';
    const generation = ++diagnosticsRequestGeneration;
    diagnosticsError = '';
    diagnosticsLoading = true;
    try {
      const next = await api.diagnosticEvents();
      if (session && session.user_id === userId && accountEpoch === epoch && generation === diagnosticsRequestGeneration) {
        diagnostics = next;
        diagnosticsPaged = false;
        diagnosticsNewActivity = false;
        diagnosticsFetchedAt = Date.now();
      }
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

  /** Entering Settings refreshes cached diagnostics in the background once they are older than the freshness window. */
  function onSettingsVisibility(shown: boolean) {
    settingsShownPrevious = shown;
    if (!shown || !session || connectionId || !diagnostics || diagnosticsLoading) return;
    if (Date.now() - diagnosticsFetchedAt > DIAGNOSTICS_STALE_MS) void refreshDiagnostics(true);
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
    if (route.kind === 'vault' && route.vaultId === targetVaultId) {
      go(nextActive ? vaultRoute(nextActive.vault_id, 'overview') : { kind: 'account-settings' }, { replace: true });
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
        diagnosticsPaged = true;
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
        if (!confirm('Delete all diagnostics shared with this server?')) return;
        busy = true;
        const result = await api.deleteDiagnosticEvents();
        if (!currentDiagnosticsDelete(target, generation)) return;
        notice = `Deleted ${result.deleted_count} diagnostic report${result.deleted_count === 1 ? '' : 's'}.`;
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
    const leavingRoute = route.kind === 'vault' && route.vaultId === targetVaultId;
    const keepSettings = route.kind === 'vault' && route.section === 'settings';
    clearTargetPresentation(targetVaultId);
    vaults = nextVaults.filter((vault) => vault.vault_id !== targetVaultId);
    const nextActive = vaults.find((vault) => vault.status === 'active');
    if (leavingRoute) go(nextActive ? vaultRoute(nextActive.vault_id, keepSettings ? 'settings' : 'overview') : { kind: 'account-settings' }, { replace: true });
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
    return tracked(() => refreshDashboardStatusNow(supersede));
  }

  async function refreshDashboardStatusNow(supersede: boolean) {
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
        : api.dashboard(requestedVaultId);
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
        dashboard = dashboardResult.value;
        conflicts = sortConflicts(dashboardResult.value.conflicts);
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
    return tracked(refreshVaultNow);
  }

  async function refreshVaultNow() {
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
      const [dashboardResult, deletionList] = await Promise.all([
        api.dashboard(requestedVaultId),
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
      conflicts = sortConflicts(dashboardResult.conflicts);
      dashboardStatusCurrent = true;
      await syncConflictRoute(true);
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

  async function loadVaultSyncSettings() {
    const target = selectedVault;
    if (!session || !target || target.status !== 'active' || vaultSyncSettingsLoading) return;
    const generation = ++vaultSyncSettingsGeneration;
    const epoch = stateEpoch;
    const account = accountEpoch;
    const userId = session.user_id;
    vaultSyncSettingsLoading = true;
    vaultSyncSettingsError = '';
    try {
      const result = await api.vaultSyncSettings(target.vault_id);
      if (session?.user_id !== userId || accountEpoch !== account || stateEpoch !== epoch || vaultId !== target.vault_id || generation !== vaultSyncSettingsGeneration) return;
      vaultSyncSettings = result;
      vaultSyncSettingsLoadedFor = target.vault_id;
      return true;
    } catch (error) {
      if (session?.user_id === userId && accountEpoch === account && stateEpoch === epoch && vaultId === target.vault_id && generation === vaultSyncSettingsGeneration) {
        vaultSyncSettingsError = error instanceof Error ? error.message : 'Unable to load vault sync settings.';
      }
      return false;
    } finally {
      if (generation === vaultSyncSettingsGeneration) vaultSyncSettingsLoading = false;
    }
  }

  async function previewVaultSyncSettings(rootIgnore: string | null, rules: MetadataConflictRule[]): Promise<VaultSyncSettingsPreview> {
    if (!vaultSyncSettings || !selectedVault) throw new Error('Load vault settings before previewing changes.');
    return await api.previewVaultSyncSettings(selectedVault.vault_id, {
      expected_main: vaultSyncSettings.current_main,
      expected_root_ignore_oid: vaultSyncSettings.root_ignore_oid,
      root_ignore: rootIgnore,
      metadata_conflict_rules: rules
    });
  }

  async function saveVaultSyncSettings(rootIgnore: string | null, rules: MetadataConflictRule[], preview: VaultSyncSettingsPreview) {
    const original = vaultSyncSettings;
    const target = selectedVault;
    const userId = session?.user_id;
    const epoch = stateEpoch;
    const account = accountEpoch;
    if (!original || !target || !userId) throw new Error('Load vault settings before saving changes.');
    vaultSyncSettingsSaving = true;
    vaultSyncSettingsError = '';
    try {
      const saved = await api.saveVaultSyncSettings(target.vault_id, {
        expected_main: original.current_main,
        expected_root_ignore_oid: original.root_ignore_oid,
        preview_tree: preview.preview_tree,
        review_fingerprint: preview.review_fingerprint,
        root_ignore: rootIgnore,
        metadata_conflict_rules: rules,
        expected_metadata_conflict_rules: original.metadata_conflict_rules
      });
      if (session?.user_id !== userId || accountEpoch !== account || stateEpoch !== epoch || selectedVault?.vault_id !== target.vault_id) return;
      vaultSyncSettings = saved;
      vaultSyncSettingsLoadedFor = target.vault_id;
      notice = 'Vault sync settings saved.';
      try {
        const refreshed = await api.vaultSyncSettings(target.vault_id);
        if (session?.user_id === userId && accountEpoch === account && stateEpoch === epoch && selectedVault?.vault_id === target.vault_id) vaultSyncSettings = refreshed;
      } catch (refreshError) {
        if (session?.user_id === userId && accountEpoch === account && stateEpoch === epoch && selectedVault?.vault_id === target.vault_id) {
          vaultSyncSettingsError = `Settings were saved, but refresh failed: ${refreshError instanceof Error ? refreshError.message : 'unable to load the latest settings.'}`;
        }
      }
      try {
        await refreshVault();
      } catch {
        if (session?.user_id === userId && accountEpoch === account && stateEpoch === epoch && selectedVault?.vault_id === target.vault_id) {
          vaultSyncSettingsError = 'Settings were saved, but dashboard status could not be refreshed.';
        }
      }
    } catch (error) {
      if (session?.user_id === userId && accountEpoch === account && stateEpoch === epoch && selectedVault?.vault_id === target.vault_id) {
        vaultSyncSettingsError = error instanceof Error ? error.message : 'Unable to save vault sync settings.';
      }
      throw error;
    } finally {
      if (session?.user_id === userId && accountEpoch === account && stateEpoch === epoch && selectedVault?.vault_id === target.vault_id) {
        vaultSyncSettingsSaving = false;
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
    const startSeq = routeSeq;
    busy = true;
    actionError = '';
    try {
      const created = await api.createVault(newVaultName.trim());
      if (!session || stateEpoch !== epoch || accountEpoch !== account) return;
      vaults = [...vaults, created];
      newVaultName = '';
      const overview = vaultRoute(created.vault_id, 'overview');
      if (routeSeq === startSeq && !draftDirty) {
        go(overview);
        epoch = stateEpoch;
        showNotice('Vault created.');
      } else {
        createVaultOpen = false;
        showNotice(`Vault ${created.display_name} created.`, { label: 'Open', route: overview });
      }
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

  async function previewResolution(submission: ConflictResolutionSubmission): Promise<ConflictResolutionPreview> {
    if (!vaultId || selectedVaultDeleting || !review || review.stale) {
      throw new Error('This conflict review is not available.');
    }
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const reviewRef = review;
    const conflictId = review.conflict.conflict_id;
    const expectedMain = review.expected_main;
    const generation = ++previewRequestGeneration;
    try {
      const preview = await api.previewConflict({
        vaultId: requestedVaultId,
        conflictId,
        expectedMain,
        ...submission
      });
      if (
        !currentRequest(requestedVaultId, epoch) ||
        generation !== previewRequestGeneration ||
        selectedConflictId !== conflictId ||
        review !== reviewRef ||
        review?.conflict.conflict_id !== conflictId ||
        review.expected_main !== expectedMain
      ) {
        throw new Error('This preview is no longer current.');
      }
      return preview;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_conflict_review' && review?.conflict.conflict_id === conflictId) {
        review = { ...review, stale: true };
        conflicts = conflicts.map((conflict) =>
          conflict.conflict_id === conflictId ? { ...conflict, stale: true, status_label: 'Stale review' } : conflict
        );
        throw new Error('This conflict review is stale. Refresh it before reviewing the result.');
      }
      throw error;
    }
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

  function openConflictFromList(conflict: DashboardConflict) {
    conflictListOpen = false;
    openConflict(conflict.conflict_id, conflict.stale);
  }

  function selectConflict(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const conflict = conflicts.find((candidate) => candidate.conflict_id === select.value);
    if (conflict) openConflictFromList(conflict);
    void tick().then(() => {
      if (select.isConnected && select.value !== selectedConflictId) select.value = selectedConflictId;
    });
  }

  function handleAttentionAction(item: AttentionItem) {
    if (!vaultId) return;
    if (item.kind === 'maintenance') {
      go(vaultRoute(vaultId, 'maintenance'));
      return;
    }
    if (item.kind === 'devices') {
      go(vaultRoute(vaultId, 'devices'));
      return;
    }
    openConflict(item.conflictId, item.kind === 'stale_conflict');
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
    const trigger = document.activeElement;
    reauthTrigger = trigger instanceof HTMLElement && trigger !== document.body ? trigger : null;
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
      showNotice(`${deviceName} was revoked.`, { label: 'View revoked devices', route: vaultRoute(requestedVaultId, 'devices', { devicesView: 'revoked' }) });
      await refreshVault();
    });
  }

  function currentRemovalTarget(target: RemovalTarget, generation = target.generation) {
    return removalTarget === target && removalTarget.generation === generation && removalRequestGeneration === generation && vaultId === target.vaultId && stateEpoch === target.epoch && accountEpoch === target.account && session?.user_id === target.userId;
  }

  function openDeviceRemoval(device: DashboardDevice) {
    if (!session || !vaultId || selectedVaultDeleting || removalRequestInFlight || !isDeviceRevoked(device)) return;
    const removal = device.removal ?? null;
    if (removal?.state === 'pending') return;
    const generation = ++removalRequestGeneration;
    removalError = '';
    removalConflictsLink = false;
    removalMode = 'standard';
    removalDiscardReason = null;
    removalFailureNote = removal?.state === 'failed' ? removalFailureText(removal.error_code) : '';
    removalTarget = {
      vaultId,
      deviceId: device.device_id,
      deviceName: device.device_name,
      epoch: stateEpoch,
      account: accountEpoch,
      userId: session.user_id,
      generation
    };
  }

  function cancelDeviceRemoval() {
    resetRemoval();
  }

  function openConflictsFromRemoval() {
    const target = removalTarget;
    resetRemoval();
    if (target) go(vaultRoute(target.vaultId, 'conflicts'));
  }

  function finishRemoval(target: RemovalTarget, text: string) {
    resetRemoval();
    if (dashboard && dashboard.vault.vault_id === target.vaultId) {
      dashboard = { ...dashboard, devices: dashboard.devices.filter((device) => device.device_id !== target.deviceId) };
    }
    showNotice(text);
    void refreshVault().catch(() => undefined);
    void tick().then(() => {
      if (!document.activeElement || document.activeElement === document.body) focusToken += 1;
    });
  }

  /** The server finished (or found nothing to remove) for a target the user already left: refresh the list quietly if its vault is still shown. */
  function refreshAfterAbandonedRemoval(target: RemovalTarget) {
    if (!session || vaultId !== target.vaultId || stateEpoch !== target.epoch || accountEpoch !== target.account || session.user_id !== target.userId) return;
    void refreshDashboardStatus(true);
  }

  async function submitDeviceRemoval(confirmation: string) {
    const target = removalTarget;
    if (!target || removalRequestInFlight) return;
    const discard = removalMode === 'discard';
    const expected = discard ? `DELETE ${target.deviceId} AND DISCARD UNMERGED WORK` : `DELETE ${target.deviceId}`;
    if (confirmation !== expected) {
      removalError = 'Type the exact confirmation phrase shown above.';
      return;
    }
    if (!currentRemovalTarget(target)) {
      removalError = 'The selected vault changed. Close this dialog and review the current vault.';
      return;
    }
    removalRequestInFlight = true;
    removalError = '';
    removalConflictsLink = false;
    try {
      await api.removeDevice(target.vaultId, target.deviceId, { confirmation, discard_unmerged: discard });
      if (!currentRemovalTarget(target)) {
        refreshAfterAbandonedRemoval(target);
        return;
      }
      finishRemoval(target, `${target.deviceName} permanently removed.`);
    } catch (error) {
      if (!currentRemovalTarget(target)) {
        if (error instanceof ApiError && error.status === 404) refreshAfterAbandonedRemoval(target);
        return;
      }
      removalRequestInFlight = false;
      await handleRemovalError(error, target);
    }
  }

  async function handleRemovalError(error: unknown, target: RemovalTarget) {
    if (!(error instanceof ApiError)) {
      removalError = 'Unable to remove this device. Try again.';
      return;
    }
    const details = error.details ?? {};
    if (error.status === 401) {
      reportAsyncError(error, 'Unable to remove this device.', target.epoch);
      return;
    }
    if (error.status === 409 && error.code === 'device_has_unmerged_work') {
      removalMode = 'discard';
      removalDiscardReason = details.reason === 'staged_transfer' ? 'staged_transfer' : 'device_ref';
      removalFailureNote = '';
      return;
    }
    if (error.status === 409 && error.code === 'device_ref_inconsistent' && details.resolution === 'discard_phrase') {
      removalMode = 'discard';
      removalDiscardReason = 'device_ref_inconsistent';
      removalFailureNote = '';
      return;
    }
    if (error.status === 409 && error.code === 'device_has_open_work') {
      if (details.reason === 'open_conflict') {
        removalError = 'This device still has open conflicts. Resolve them first, then try again.';
        removalConflictsLink = true;
      } else if (details.reason === 'unsettled_operation') {
        removalError = 'This device still has a sync operation in progress. Wait for sync to settle, then try again.';
      } else {
        removalError = 'This device still has open work. Wait for it to finish, then try again.';
      }
      return;
    }
    if (error.status === 409 && error.code === 'device_not_revoked') {
      removalError = 'Revoke the device first.';
      void refreshVault().catch(() => undefined);
      return;
    }
    if (error.status === 409 && error.code === 'vault_deleting') {
      resetRemoval();
      actionError = 'This vault is being deleted, so devices cannot be removed.';
      void refreshVault().catch(() => undefined);
      return;
    }
    if (error.status === 409 && details.retryable === false) {
      removalError = "The server can't safely remove this device from the dashboard: its server-side record is inconsistent. An administrator needs to check the server logs.";
      return;
    }
    if (error.status === 400 && error.code === 'confirmation_mismatch') {
      removalError = 'The confirmation phrase did not match. Check it and try again.';
      return;
    }
    if (error.status === 404) {
      removalRequestInFlight = true;
      try {
        await refreshVault();
      } catch {
        if (currentRemovalTarget(target)) removalError = 'Unable to remove this device. Try again.';
        return;
      } finally {
        if (currentRemovalTarget(target)) removalRequestInFlight = false;
      }
      if (!currentRemovalTarget(target)) return;
      if (!dashboard?.devices.some((device) => device.device_id === target.deviceId)) {
        finishRemoval(target, `${target.deviceName} was already removed.`);
      } else {
        removalError = 'The server could not find this device. The device list was refreshed.';
      }
      return;
    }
    if (error.status === 503) {
      removalError = error.retryAfter !== null
        ? `Temporarily unavailable. Try again in ${error.retryAfter} second${error.retryAfter === 1 ? '' : 's'}.`
        : 'Temporarily unavailable. Try again.';
      return;
    }
    removalError = 'Unable to remove this device. Try again.';
  }

  async function submitResolution(submission: ConflictResolutionSubmission, expectedTree?: string) {
    if (!vaultId || selectedVaultDeleting || !review || review.stale) return;
    actionError = '';
    notice = '';
    const conflictId = review.conflict.conflict_id;
    const requestedVaultId = vaultId;
    const epoch = stateEpoch;
    const startSeq = routeSeq;
    try {
      await api.resolveConflict({
        vaultId: requestedVaultId,
        conflictId,
        expectedMain: review.expected_main,
        ...(expectedTree ? { expectedTree } : {}),
        ...submission
      });
      if (!currentRequest(requestedVaultId, epoch)) return;
      notice = 'Conflict resolved.';
      conflicts = conflicts.map((conflict) => conflict.conflict_id === conflictId ? { ...conflict, status: 'resolved' as const } : conflict);
      const stillSelected = selectedConflictId === conflictId;
      if (stillSelected) {
        selectedConflictId = '';
        review = null;
      }
      const stillOnConflict = stillSelected && routeSeq === startSeq && route.kind === 'vault' && route.vaultId === requestedVaultId && route.section === 'conflicts' && route.conflictId === conflictId;
      if (stillOnConflict) {
        go(vaultRoute(requestedVaultId, 'conflicts'), { replace: true });
        await refreshVault();
      } else {
        await refreshDashboardStatus(true);
      }
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
      if (page === 'Maintenance') {
        maintenanceDetailOpen = !maintenanceDetailOpen;
      } else if (vaultId && go(vaultRoute(vaultId, 'maintenance'))) {
        maintenanceDetailOpen = true;
      }
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
    if (!connectionId) navigate({ kind: 'root' }, { replace: true });
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
    page={routeProblem ? (routeProblem === 'vault' ? 'Vault not found' : 'Page not found') : page}
    {nav}
    {navHrefs}
    {vaults}
    {vaultId}
    {selectedVault}
    {dashboard}
    {unresolvedCount}
    {lastRefreshed}
    {dashboardStatusCurrent}
    liveIndicator={indicator}
    liveAnnouncement={liveAnnouncementText}
    {busy}
    modalOpen={reauthOpen || deletionModalOpen || removalTarget !== null}
    {focusToken}
    vaultDeleting={selectedVaultDeleting}
    refreshing={dashboardRefreshInFlight || deletionRefreshInFlight}
    onNavigate={navigateToPage}
    onVaultChange={changeVault}
    onRefresh={requestRefreshVault}
    onLogout={logout}
  >
    <svelte:fragment slot="actions">
      {#if page === 'Overview' && route.kind === 'vault' && !routeProblem}
        <button class="secondary" disabled={busy || !selectedVault || selectedVaultDeleting} on:click={openVaultRename}>Rename vault</button>
        <button class="primary" disabled={busy} on:click={() => { renameVaultOpen = false; createVaultOpen = true; newVaultName = ''; }}>New vault</button>
      {/if}
    </svelte:fragment>

    {#if notice}
      <p class="notice" role="status">{notice}{#if noticeLink && noticeLink.forNotice === notice} <a href={routeHref(noticeLink.route)} on:click={(event) => noticeLink && handleLinkClick(event, noticeLink.route)}>{noticeLink.label}</a>{/if}</p>
    {/if}
      {#if actionError}<p class="action-error" role="alert">{actionError}</p>{/if}

      {#if routeProblem}
        <main class="page">
          <section class="panel full route-problem" aria-labelledby="route-problem-title">
            <span class="eyebrow">{routeProblem === 'vault' ? 'Vault' : 'Dashboard'}</span>
            <h2 id="route-problem-title">{routeProblem === 'vault' ? 'Vault not found' : 'Page not found'}</h2>
            <p class="muted">{routeProblem === 'vault' ? 'This vault does not exist or is not available to this account. No other vault was opened.' : 'This dashboard address does not match a page.'}</p>
            <p>
              <a class="button-link primary" href={routeHref(firstVaultRoute)} on:click={(event) => handleLinkClick(event, firstVaultRoute)}>{vaults[0] ? `Open ${vaults[0].display_name}` : 'Open account settings'}</a>
            </p>
          </section>
        </main>
      {:else if route.kind === 'root' || !vaultsLoaded}
        <main class="page">
          <section class="panel full loading-state" aria-live="polite">
            <span class="eyebrow">Dashboard</span>
            <h2>Loading dashboard</h2>
            <p class="muted">Checking which vaults this account can open.</p>
          </section>
        </main>
      {:else if renameVaultOpen}
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
          {diagnosticsNewActivity}
          {busy}
          onRefreshDiagnostics={requestRefreshDiagnostics}
          onLoadMoreDiagnostics={() => void loadMoreDiagnostics()}
          onDeleteDiagnostics={deleteDiagnostics}
          onSignOut={logout}
          {deletions}
          {selectedVault}
          currentMain={dashboard?.vault.current_main ?? ''}
          syncSettings={vaultSyncSettings}
          syncSettingsError={vaultSyncSettingsError}
          syncSettingsLoading={vaultSyncSettingsLoading}
          syncSettingsSaving={vaultSyncSettingsSaving}
          onLoadSyncSettings={loadVaultSyncSettings}
          onPreviewSyncSettings={previewVaultSyncSettings}
          onSaveSyncSettings={saveVaultSyncSettings}
          vaultDeleting={selectedVaultDeleting}
          deletionBusy={deletionRequestInFlight}
          onOpenVaultDeletion={openVaultDeletion}
          onDirtyChange={setSettingsDraftDirty}
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
            <button class="secondary" on:click={() => vaultId && go(vaultRoute(vaultId, 'settings'))}>View deletion status in Settings</button>
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
        <DevicesPage
          {vaultId}
          devices={dashboard.devices}
          view={devicesView}
          recommendedPluginVersion={dashboard.recommended_plugin_version}
          statusCurrent={dashboardStatusCurrent}
          onNavigate={handleLinkClick}
          onRename={renameDevice}
          onRevoke={revokeDevice}
          onRemove={openDeviceRemoval}
        />
      {:else if page === 'Conflicts' && dashboard}
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
              onPreview={previewResolution}
              onRefresh={refreshReview}
              onDirtyChange={setResolutionDraftDirty}
            />
          {:else if conflictNotFound}
            <section class="panel full route-problem" aria-labelledby="conflict-not-found-title">
              <h2 id="conflict-not-found-title">Conflict not found</h2>
              <p class="muted">This conflict is not in the current vault's conflict list. It may have been resolved or removed.</p>
              <p><a class="button-link" href={routeHref(vaultRoute(vaultId, 'conflicts'))} on:click={(event) => handleLinkClick(event, vaultRoute(vaultId, 'conflicts'))}>View all conflicts</a></p>
            </section>
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
          {diagnosticsNewActivity}
          {busy}
          onRefreshDiagnostics={requestRefreshDiagnostics}
          onLoadMoreDiagnostics={() => void loadMoreDiagnostics()}
          onDeleteDiagnostics={deleteDiagnostics}
          onSignOut={logout}
          {deletions}
          {selectedVault}
          currentMain={dashboard?.vault.current_main ?? ''}
          syncSettings={vaultSyncSettings}
          syncSettingsError={vaultSyncSettingsError}
          syncSettingsLoading={vaultSyncSettingsLoading}
          syncSettingsSaving={vaultSyncSettingsSaving}
          onLoadSyncSettings={loadVaultSyncSettings}
          onPreviewSyncSettings={previewVaultSyncSettings}
          onSaveSyncSettings={saveVaultSyncSettings}
          vaultDeleting={selectedVaultDeleting}
          deletionBusy={deletionRequestInFlight}
          onOpenVaultDeletion={openVaultDeletion}
          onDirtyChange={setSettingsDraftDirty}
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
    returnFocusTo={reauthTrigger}
    onSubmit={authenticate}
    onCancel={cancelReauth}
  />
{/if}

{#if removalTarget}
  <DeviceRemovalModal
    deviceName={removalDevice?.device_name ?? removalTarget.deviceName}
    deviceId={removalTarget.deviceId}
    mode={removalMode}
    discardReason={removalDiscardReason}
    busy={removalRequestInFlight}
    error={removalError}
    failureText={removalFailureNote}
    conflictsHref={removalConflictsLink ? routeHref(vaultRoute(removalTarget.vaultId, 'conflicts')) : null}
    onSubmit={submitDeviceRemoval}
    onCancel={cancelDeviceRemoval}
    onOpenConflicts={openConflictsFromRemoval}
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
