------------------------- MODULE OBTSDashboardProtocols -------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS MaxAge, Minute, AccountA, AccountB, Mutation
ASSUME MaxAge = 1 /\ Minute = 1

VARIABLES now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt,
          previousPersistedAt, writes, subscribed, authorized, committed,
          invalidations, refreshed, requestRevision, requestInFlight, trailing,
          owner
vars == <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt,
          previousPersistedAt, writes, subscribed, authorized, committed,
          invalidations, refreshed, requestRevision, requestInFlight, trailing,
          owner>>

Init ==
  /\ now = 0
  /\ sample = "missing"
  /\ sampleAt = 0
  /\ activeSamplers = 0
  /\ sessionSeen = 0
  /\ persistedAt = 0
  /\ previousPersistedAt = 0
  /\ writes = 0
  /\ subscribed = FALSE
  /\ authorized = TRUE
  /\ committed = 0
  /\ invalidations = 0
  /\ refreshed = 0
  /\ requestRevision = 0
  /\ requestInFlight = FALSE
  /\ trailing = FALSE
  /\ owner = AccountA

Tick == now < 2 /\ now' = now + 1 /\ UNCHANGED <<sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
StartSample == (activeSamplers = 0 \/ Mutation = "overlap-sampler") /\ activeSamplers < 2 /\ activeSamplers' = activeSamplers + 1 /\ UNCHANGED <<now, sample, sampleAt, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
CompleteSample == activeSamplers = 1 /\ activeSamplers' = 0 /\ sample' = "healthy" /\ sampleAt' = now /\ UNCHANGED <<now, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
FailSample == activeSamplers = 1 /\ activeSamplers' = 0 /\ sample' = "failed" /\ sampleAt' = now /\ UNCHANGED <<now, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
ReadSession == authorized /\ sessionSeen' = now /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
PersistLiveness == authorized /\ (sessionSeen > persistedAt \/ Mutation = "ignore-liveness-throttle") /\ (now - persistedAt >= Minute \/ Mutation = "ignore-liveness-throttle") /\ writes < 2 /\ previousPersistedAt' = persistedAt /\ persistedAt' = now /\ writes' = writes + 1 /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, subscribed, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
Subscribe == authorized /\ ~subscribed /\ subscribed' = TRUE /\ trailing' = TRUE /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, owner>>
CommitOwnerChange == owner = AccountA /\ committed < 1 /\ committed' = (IF Mutation = "precommit" THEN committed ELSE committed + 1) /\ invalidations' = invalidations + (IF (subscribed /\ authorized) \/ Mutation = "precommit" THEN 1 ELSE 0) /\ trailing' = (trailing \/ (subscribed /\ authorized) \/ (Mutation = "precommit")) /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, refreshed, requestRevision, requestInFlight, owner>>
BeginRefresh == ~requestInFlight /\ refreshed < 3 /\ requestRevision' = committed /\ requestInFlight' = TRUE /\ trailing' = FALSE /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, refreshed, owner>>
FinishRefresh == requestInFlight /\ requestInFlight' = FALSE /\ refreshed' = (IF Mutation = "magic-refresh" THEN committed ELSE requestRevision) /\ trailing' = (IF Mutation = "drop-trailing" THEN FALSE ELSE trailing \/ (committed > requestRevision)) /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, subscribed, authorized, committed, invalidations, requestRevision, owner>>
Disconnect == subscribed /\ subscribed' = FALSE /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
Reconnect == authorized /\ ~subscribed /\ refreshed < 3 /\ subscribed' = TRUE /\ trailing' = TRUE /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, authorized, committed, invalidations, refreshed, requestRevision, requestInFlight, owner>>
Revoke == authorized /\ authorized' = FALSE /\ subscribed' = FALSE /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, committed, invalidations, refreshed, requestRevision, requestInFlight, trailing, owner>>
SwitchOwner == owner = AccountA /\ owner' = AccountB /\ subscribed' = FALSE /\ refreshed' = 0 /\ requestRevision' = 0 /\ requestInFlight' = FALSE /\ trailing' = FALSE /\ invalidations' = (IF Mutation = "owner-leak" THEN 1 ELSE 0) /\ committed' = 0 /\ UNCHANGED <<now, sample, sampleAt, activeSamplers, sessionSeen, persistedAt, previousPersistedAt, writes, authorized>>

Next == Tick \/ StartSample \/ CompleteSample \/ FailSample \/ ReadSession \/ PersistLiveness \/ Subscribe \/ CommitOwnerChange \/ BeginRefresh \/ FinishRefresh \/ Disconnect \/ Reconnect \/ Revoke \/ SwitchOwner
Spec == Init /\ [][Next]_vars
IsVerifiedHealthy == sample = "healthy" /\ (Mutation = "unsafe-stale-health" \/ now - sampleAt <= MaxAge)
HealthHonest == IsVerifiedHealthy => now - sampleAt <= MaxAge
SingleFlight == activeSamplers <= 1
LivenessCoalesced == writes < 2 \/ persistedAt - previousPersistedAt >= Minute
NoPrecommitInvalidation == invalidations <= committed
NoRefreshClaimsUnfetched == refreshed <= requestRevision
OwnerIsolation == owner = AccountB => committed = 0 /\ invalidations = 0
TrailingAfterStaleResponse == ~requestInFlight /\ subscribed /\ authorized /\ committed > refreshed => trailing

ReachSampler == activeSamplers = 1 => FALSE
ReachTrailingRefresh == trailing /\ committed > requestRevision => FALSE

=============================================================================
