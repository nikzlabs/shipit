import type { SessionInfo } from "./types.js";
import { parseTimestampMs } from "./utils.js";

export function resolvedAt(session: SessionInfo): string | undefined {
  return session.mergedAt ?? session.closedAt;
}

// SQLite and ISO timestamps must be compared as UTC instants.
export function isTerminalPrResolved(session: SessionInfo): boolean {
  const terminalAt = resolvedAt(session);
  if (!terminalAt) return false;
  const terminalMs = parseTimestampMs(terminalAt);
  const lastUsedMs = parseTimestampMs(session.lastUsedAt);
  if (Number.isNaN(terminalMs) || Number.isNaN(lastUsedMs)) return true;
  return lastUsedMs <= terminalMs;
}

// Legacy archived rows can retain the flag without owning a reservation.
export function holdsActiveReservation(session: SessionInfo | undefined | null): boolean {
  return !!session?.keepPreviewRunning && !session.userArchived && !session.archived && !session.warm;
}

// docs/298 — a broken checkout is not finished work, exactly as a pin is not.
function isOwnWorkFinished(session: SessionInfo): boolean {
  return isTerminalPrResolved(session)
    && !session.pinnedAt
    && !session.workspaceBlock
    && !holdsActiveReservation(session);
}

// docs/316-done-sessions-return-memory: "done" puts a row under Recently
// resolved, lets the sidebar cap hide it, and lets the idle enforcer stop it.
export function isSessionDone(session: SessionInfo, context: { hasUnfinishedDescendant: boolean }): boolean {
  return isOwnWorkFinished(session) && !context.hasUnfinishedDescendant;
}

const isLive = (s: SessionInfo): boolean => !s.userArchived && !s.archived;

// Browser and server must both decide "done" through this, from the session
// list. Only unfinished, unarchived descendants count, and the walk stops at an
// archived ancestor: the server list holds rows the browser never gets (archived
// ones, and done ones the cap hides), and none of them may change the answer.
export function doneSessionTest(sessions: readonly SessionInfo[]): (session: SessionInfo) => boolean {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const withUnfinishedDescendant = new Set<string>();
  for (const s of sessions) {
    if (!isLive(s) || isOwnWorkFinished(s)) continue;
    if (s.rootSessionId && s.rootSessionId !== s.id) withUnfinishedDescendant.add(s.rootSessionId);
    const seen = new Set([s.id]);
    let parent = s.parentSessionId ? byId.get(s.parentSessionId) : undefined;
    while (parent && isLive(parent) && !seen.has(parent.id)) {
      seen.add(parent.id);
      withUnfinishedDescendant.add(parent.id);
      parent = parent.parentSessionId ? byId.get(parent.parentSessionId) : undefined;
    }
  }
  return (session) => isSessionDone(session, { hasUnfinishedDescendant: withUnfinishedDescendant.has(session.id) });
}
