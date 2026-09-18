import type { WsRebaseStarted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleRebaseStarted: Handler<WsRebaseStarted> = (_ctx, data) => {

  if (useSessionStore.getState().sessionId !== data.sessionId) return;
  const git = useGitStore.getState();
  git.setRebaseStatus("in_progress");

  git.setRebaseError(null);
};
