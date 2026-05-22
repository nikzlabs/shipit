import { useSessionStore } from "../stores/session-store.js";
import { usePrStore } from "../stores/pr-store.js";
import type { PrCardState } from "../stores/pr-store.js";
import type { PrStatusSummary } from "../../server/shared/types/github-types.js";

export interface AttentionInputs {
  card: PrCardState | undefined;
  status: PrStatusSummary | undefined;
  isAgentRunning: boolean;
}

/**
 * Pure derivation of a session's attention reason from store snapshots.
 * Returns the highest-priority reason string, or `null` if no attention
 * is needed. This is the single source of truth for "session needs
 * attention" — the sidebar border, the tooltip, and notifications all
 * derive from this function so they can never disagree.
 */
export function computeAttentionReason({ card, status, isAgentRunning }: AttentionInputs): string | null {
  const checks = card?.checks;
  const autoFix = card?.autoFix;
  const autoMerge = card?.autoMerge;
  const prState = status?.prState;
  const mergeable = status?.mergeable;

  if (isAgentRunning) return null;

  if (checks?.state === "failure" && autoFix?.status !== "running") {
    if (autoFix?.status === "exhausted") {
      return "CI fix failed after 3 attempts";
    }
    return "CI checks failed";
  }

  if (prState === "open" && mergeable === "conflicting") {
    return "PR has merge conflicts";
  }

  if (autoMerge?.error) {
    return "Auto-merge needs repo configuration";
  }

  if (checks?.state === "pending") return null;

  if (prState === "merged" || prState === "closed") return null;

  return "Waiting for your input";
}

/** Returns the highest-priority attention reason for a session, or null if no attention needed. */
export function useAttentionInfo(sessionId: string): string | null {
  const card = usePrStore((s) => s.cardBySession[sessionId]);
  const status = usePrStore((s) => s.statusBySession[sessionId]);
  const isAgentRunning = useSessionStore((s) => s.activeRunnerSessions.has(sessionId));
  return computeAttentionReason({ card, status, isAgentRunning });
}
