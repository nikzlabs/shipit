/**
 * The one minimum for every compaction ShipIt starts by itself: after a merge
 * (docs/295-compact-context-on-merge req 15), at the agent's request
 * (docs/324-agent-requested-compaction req 12) and when idle (docs/333-idle-compaction req 6).
 * Under it, only the user's `/compact` compacts.
 */
export const AUTOMATIC_COMPACTION_MIN_CONTEXT_TOKENS = 200_000;
