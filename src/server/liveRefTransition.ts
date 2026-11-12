/**
 * A server Git ref and the ref recorded in metadata can legitimately differ for a short while: a writer
 * updates the ref first and only then commits the metadata row that records it. Integrity checks read the
 * two out of band, so they honour that gap only for a prepared operation whose record was refreshed within
 * this window (`preparedRefTransitionAllows` / `preparedConflictRefTransitionAllows` in `app.ts`).
 */
export const LIVE_REF_TRANSITION_GRACE_MS = 2 * 60 * 1000;

/**
 * A prepared operation's record is rewritten once its age reaches this threshold, so a slow write cannot
 * leave an aged record behind that the next integrity check refuses to honour.
 *
 * The invariant this threshold has to keep: the distance between the ref update and the metadata commit
 * that records it must stay below `LIVE_REF_TRANSITION_GRACE_MS - PREPARED_TRANSITION_REFRESH_MS`. The
 * record is refreshed immediately before its ref update, so the grace window is measured from that
 * refresh; the worst case is a record that just missed a refresh and is therefore up to
 * `PREPARED_TRANSITION_REFRESH_MS` old when the ref moves. Staying below the difference keeps an
 * in-flight push inside the window even in that worst case, and an expired window would make
 * `checkVaultPersistentState` report an inconsistent vault and can durably block it.
 */
export const PREPARED_TRANSITION_REFRESH_MS = LIVE_REF_TRANSITION_GRACE_MS / 4;
