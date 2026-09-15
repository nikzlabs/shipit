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

// docs/298 — a broken checkout is not finished work, exactly as a pin is not.
// The cap exemption in `filterVisibleInSidebar` only gets the row to the client;
// without this it arrives and is then sorted into the collapsible resolved tail.
export function isResolvedForGrouping(
  session: SessionInfo,
  context: { hasVisibleBrood: boolean; isRunning?: boolean },
): boolean {
  return isTerminalPrResolved(session)
    && !session.pinnedAt
    && !session.workspaceBlock
    && !context.hasVisibleBrood
    && context.isRunning !== true;
}
