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

// docs/316-done-sessions-return-memory: "done" puts a row under Recently
// resolved, lets the sidebar cap hide it, and lets the idle enforcer stop it.
// docs/298 — a broken checkout is not finished work, exactly as a pin is not.
export function isSessionDone(session: SessionInfo, context: { hasLiveChild: boolean }): boolean {
  return isTerminalPrResolved(session)
    && !session.pinnedAt
    && !session.workspaceBlock
    && !holdsActiveReservation(session)
    && !context.hasLiveChild;
}

// Browser and server must both decide "done" through this, from the session
// list, so the two cannot compute the child context differently.
export function doneSessionTest(sessions: readonly SessionInfo[]): (session: SessionInfo) => boolean {
  const parentsWithLiveChild = new Set<string>();
  for (const s of sessions) {
    if (s.parentSessionId && !s.userArchived && !s.archived) parentsWithLiveChild.add(s.parentSessionId);
  }
  return (session) => isSessionDone(session, { hasLiveChild: parentsWithLiveChild.has(session.id) });
}
