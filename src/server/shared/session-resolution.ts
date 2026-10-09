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

// docs/324-scheduled-sessions — a run's "finished" (req 22) is ShipIt's saved
// decision; any other session's is its PR's.
export function isWorkResolved(session: SessionInfo): boolean {
  return session.scheduleId ? !!session.runFinishedAt : isTerminalPrResolved(session);
}

export function workResolvedAt(session: SessionInfo): string | undefined {
  return session.scheduleId ? session.runFinishedAt : resolvedAt(session);
}

// docs/324-scheduled-sessions req 20 — a run, and the sessions its spawn tree
// holds, belong to the Scheduled view and not to the regular list.
export function scheduledViewTest(sessions: readonly SessionInfo[]): (session: SessionInfo) => boolean {
  const runIds = new Set(sessions.filter((s) => s.scheduleId).map((s) => s.id));
  return (session) => !!session.scheduleId || (!!session.rootSessionId && runIds.has(session.rootSessionId));
}

// Legacy archived rows can retain the flag without owning a reservation.
export function holdsActiveReservation(session: SessionInfo | undefined | null): boolean {
  return !!session?.keepPreviewRunning && !session.userArchived && !session.archived && !session.warm;
}

// docs/298 — a broken checkout is not finished work, exactly as a pin is not.
function isOwnWorkFinished(session: SessionInfo): boolean {
  return isWorkResolved(session)
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
