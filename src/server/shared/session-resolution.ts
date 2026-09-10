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

export function isResolvedForGrouping(
  session: SessionInfo,
  context: { hasVisibleBrood: boolean; isRunning?: boolean },
): boolean {
  return isTerminalPrResolved(session)
    && !session.pinnedAt
    && !context.hasVisibleBrood
    && context.isRunning !== true;
}
