import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { ContextDial } from "../ContextDial.js";
import type { ModelInfo } from "../../utils/model-info.js";

/** Stable empty fallback so the zustand selector never returns a fresh array. */
const EMPTY_TURN_USAGE: never[] = [];

export function ContextDialMount({
  modelInfo,
  contextTokensFallback,
  onOpenUsageDetails,
  compact = false,
}: {
  modelInfo: ModelInfo | null;
  contextTokensFallback: number;
  onOpenUsageDetails?: () => void;

  compact?: boolean;
}) {

  const sessionId = useSessionStore((s) => s.sessionId);
  const turnUsage = useSessionStore((s) =>
    sessionId ? s.turnUsage[sessionId] ?? EMPTY_TURN_USAGE : EMPTY_TURN_USAGE,
  );

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

  const sessionTotals = useUiStore((s) => s.currentSessionUsage?.totals);
  const cumulativeInputTokens = useUiStore((s) => s.cumulativeInputTokens);
  const cumulativeOutputTokens = useUiStore((s) => s.cumulativeOutputTokens);
  return (
    <ContextDial
      modelInfo={modelInfo}
      turnUsage={turnUsage}
      contextTokensOverride={turnUsage.length > 0 ? undefined : contextTokensFallback}
      sessionTotals={sessionTotals}
      cumulativeInputTokens={cumulativeInputTokens}
      cumulativeOutputTokens={cumulativeOutputTokens}
      onOpenUsageDetails={onOpenUsageDetails}
      authoritativeCompacted={authoritativeCompacted}
      compact={compact}
    />
  );
}
