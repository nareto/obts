/**
 * How long a forked crash-image child may take to reach the durable seam its parent
 * kills it at. The child boots the whole plugin against a fixture server, so it costs
 * seconds on an idle machine and far more when several pipelines share four cores; a
 * 15 s bound gave up on children that were still working instead of reporting a seam
 * that never arrived.
 */
export const CHILD_SEAM_DEADLINE_MS = 60_000;
