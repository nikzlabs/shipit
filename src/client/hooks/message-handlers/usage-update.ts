import type { WsUsageUpdate } from "../../../server/shared/types.js";
import { useUiStore } from "../../stores/ui-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleUsageUpdate: Handler<WsUsageUpdate> = (_ctx, data) => {

  // token pair) — so a message naming a DIFFERENT session must not be applied

  if (data.sessionId !== useSessionStore.getState().sessionId) return;
  const ui = useUiStore.getState();
  const update = data;
  ui.setCurrentSessionUsage({
    sessionId: update.sessionId,
    totals: update.totals,

    groups: update.groups,
    totalDurationMs: update.totalDurationMs,
    turnCount: update.turnCount,
  });

  // this message on its own (docs/144) never had a reading to contribute

  ui.setCumulativeTokens(
    update.cumulativeInputTokens ?? 0,
    update.cumulativeOutputTokens ?? 0,
  );
};
