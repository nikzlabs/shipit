import type { WsUsageUpdate } from "../../../server/shared/types.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleUsageUpdate: Handler<WsUsageUpdate> = (_ctx, data) => {
  const ui = useUiStore.getState();
  const update = data;
  ui.setCurrentSessionUsage({
    sessionId: update.sessionId,
    totalCostUsd: update.totalCostUsd,
    totalDurationMs: update.totalDurationMs,
    turnCount: update.turnCount,
  });
  // contextTokens reflects the *last turn's* context occupancy. The
  // `turn_usage_update` handler below sets the precise value (input +
  // cache reads + cache writes); this is just a coarse fallback for
  // sessions that don't emit per-turn data. `lastTurnInputTokens` alone
  // undercounts heavily when prompt caching is active, so prefer the
  // cumulative figure when that's all we have.
  //
  // A sub-agent consult (docs/144) is excluded: it contributes to the cost +
  // cumulative-token rollups below, but the context dial tracks the PINNED
  // agent's window — a one-shot consult must not move that needle.
  if (!update.subAgent) {
    if (update.cumulativeInputTokens !== undefined) {
      ui.setContextTokens(update.cumulativeInputTokens);
    } else if (update.lastTurnInputTokens !== undefined) {
      ui.setContextTokens(update.lastTurnInputTokens);
    }
  }
  ui.setCumulativeTokens(
    update.cumulativeInputTokens ?? 0,
    update.cumulativeOutputTokens ?? 0,
  );
};
