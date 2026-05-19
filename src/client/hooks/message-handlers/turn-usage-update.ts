import type { WsTurnUsageUpdate } from "../../../server/shared/types.js";
import { turnContextTokens } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleTurnUsageUpdate: Handler<WsTurnUsageUpdate> = (_ctx, data) => {
  // Append to the per-session turn-usage history powering the context dial.
  useSessionStore.getState().appendTurnUsage(data.sessionId, data.turn);
  // The status-bar meter and usage modal read `contextTokens` from the UI
  // store — set it to the real context occupancy (uncached input + cache
  // reads + cache writes), not just `inputTokens`, which is tiny under
  // prompt caching.
  useUiStore.getState().setContextTokens(turnContextTokens(data.turn));
};
