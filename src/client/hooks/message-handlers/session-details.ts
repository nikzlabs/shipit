import type { WsSessionDetails } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

// Keyed by session rather than dropped on a mismatch: a switch can deliver it before the store's session moves.
export const handleSessionDetails: Handler<WsSessionDetails> = (_ctx, data) => {
  useSessionStore.getState().setSessionDetails(data.sessionId, {
    sessionStatus: data.sessionStatus,
    agentGoal: data.agentGoal,
  });
};
