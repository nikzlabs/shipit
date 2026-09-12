import type { WsTurnUsageUpdate } from "../../../server/shared/types.js";
import { turnContextTokens } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleTurnUsageUpdate: Handler<WsTurnUsageUpdate> = (_ctx, data) => {

  useSessionStore.getState().appendTurnUsage(data.sessionId, data.turn);

  // session on screen, so a message for another session must not move it

  if (data.sessionId !== useSessionStore.getState().sessionId) return;
  useUiStore.getState().setContextTokens(turnContextTokens(data.turn));
};
