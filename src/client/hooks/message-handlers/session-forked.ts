import type { WsSessionForked } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSessionForked: Handler<WsSessionForked> = (_ctx, data) => {
  const childSessionId = data.childSessionId ?? data.sessionId;
  if (!childSessionId) return;
  useSessionStore.getState().setSessionId(childSessionId);
  window.history.pushState({}, "", `/session/${childSessionId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};
