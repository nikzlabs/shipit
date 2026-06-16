import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ContextDial } from "../ContextDial.js";
import type { ModelInfo } from "../../utils/model-info.js";

/** Stable empty fallback so the zustand selector never returns a fresh array. */
const EMPTY_TURN_USAGE: never[] = [];

/**
 * Pulls the per-turn usage history for the active session out of the session
 * store and feeds it to `ContextDial`. Kept as a tiny inner component so the
 * subscription cost only attaches when the dial is mounted.
 */
export function ContextDialMount({
  modelInfo,
  contextTokensFallback,
  onOpenUsageDetails,
}: {
  modelInfo: ModelInfo | null;
  contextTokensFallback: number;
  onOpenUsageDetails?: () => void;
}) {
  // Two separate selector subscriptions, each returning a stable reference,
  // so React's `useSyncExternalStore` snapshot stays cached across renders.
  // (Combining into one object would create a fresh object every render.)
  const sessionId = useSessionStore((s) => s.sessionId);
  const turnUsage = useSessionStore((s) =>
    sessionId ? s.turnUsage[sessionId] ?? EMPTY_TURN_USAGE : EMPTY_TURN_USAGE,
  );
  // docs/178 — authoritative "compacted recently" signal: a compaction card
  // present after the last user message. Self-clearing — a new user message
  // moves the boundary past the card. Drives the dial's compacted pill, with
  // ContextDial's `wasCompacted` heuristic as the fallback.
  const authoritativeCompacted = useSessionStore((s) => {
    let lastUserIndex = -1;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      if (s.messages[i].role === "user") { lastUserIndex = i; break; }
    }
    for (let i = s.messages.length - 1; i > lastUserIndex; i--) {
      if (s.messages[i].compaction) return true;
    }
    return false;
  });
  // Authoritative session totals so the popover's "Total cost" row matches
  // the value shown in `UsageModal` rather than summing live-only turns.
  const sessionTotalCostUsd = useUiStore((s) => s.currentSessionUsage?.totalCostUsd);
  const cumulativeInputTokens = useUiStore((s) => s.cumulativeInputTokens);
  const cumulativeOutputTokens = useUiStore((s) => s.cumulativeOutputTokens);
  return (
    <ContextDial
      modelInfo={modelInfo}
      turnUsage={turnUsage}
      contextTokensOverride={turnUsage.length > 0 ? undefined : contextTokensFallback}
      sessionTotalCostUsd={sessionTotalCostUsd ?? undefined}
      cumulativeInputTokens={cumulativeInputTokens}
      cumulativeOutputTokens={cumulativeOutputTokens}
      onOpenUsageDetails={onOpenUsageDetails}
      authoritativeCompacted={authoritativeCompacted}
    />
  );
}
