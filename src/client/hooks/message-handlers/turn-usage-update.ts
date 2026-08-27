import type { WsTurnUsageUpdate } from "../../../server/shared/types.js";
import { turnContextTokens } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleTurnUsageUpdate: Handler<WsTurnUsageUpdate> = (_ctx, data) => {
  // Append to the per-session turn-usage history powering the context dial.
  // Keyed by the message's OWN session, so this half is safe to apply whichever
  // session is on screen.
  useSessionStore.getState().appendTurnUsage(data.sessionId, data.turn);
  // The status-bar meter and usage modal read `contextTokens` from the UI
  // store — set it to the real context occupancy (uncached input + cache
  // reads + cache writes), not just `inputTokens`, which is tiny under
  // prompt caching.
  //
  // Unlike the append above, this field is a session-LESS global describing the
  // session on screen, so a message for another session must not move it
  // (planning#482 — see `usage-update.ts` for the window in which the two differ).
  if (data.sessionId !== useSessionStore.getState().sessionId) return;
  useUiStore.getState().setContextTokens(turnContextTokens(data.turn));
};
