import type { WsAutoResolveStarted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleAutoResolveStarted: Handler<WsAutoResolveStarted> = (_ctx, data) => {
  if (useSessionStore.getState().sessionId !== data.sessionId) return;

  useGitStore.setState({
    rebaseStatus: "in_progress",
    rebaseConflicts: [],
    rebaseError: null,
    pushRejected: false,
  });
};
