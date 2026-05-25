import type { WsSessionForked } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

// Forks are non-destructive: the parent gets a `forkChild` breadcrumb and
// the user is navigated to the child session — both already confirm the
// action. No toast, no Undo affordance; if the user wants to back out,
// they archive the child session. The server still emits snapshot data
// (used by chat/code/both rewinds), which we deliberately ignore here.
export const handleSessionForked: Handler<WsSessionForked> = (_ctx, data) => {
  const childSessionId = data.childSessionId ?? data.sessionId;
  if (!childSessionId) return;
  useSessionStore.getState().setSessionId(childSessionId);
  window.history.pushState({}, "", `/session/${childSessionId}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
};
