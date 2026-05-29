import type { WsRewindRestored } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useGitStore } from "../../stores/git-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { loadSessionHistory } from "../../utils/session-data.js";
import type { Handler } from "./types.js";

export const handleRewindRestored: Handler<WsRewindRestored> = (_ctx, data) => {
  const session = useSessionStore.getState();
  if (session.sessionId === data.archivedSessionId) {
    session.setSessionId(data.sessionId);
    window.history.pushState({}, "", `/session/${data.sessionId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  session.setRewindRecovery(null);
  const currentSessionId = useSessionStore.getState().sessionId;
  if (currentSessionId === data.sessionId) {
    void loadSessionHistory(data.sessionId);
    // Code/both restore calls rollback() server-side, which moves HEAD.
    if (data.action === "code" || data.action === "both") {
      useGitStore.getState().fetchLog(data.sessionId).catch((err: unknown) => console.warn("[git-log-refresh]", err));
    }
  }
  useUiStore.getState().setToast({ message: "Recent rewind recovered." });
};
