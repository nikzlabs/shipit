import type { WsRebaseAborted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleRebaseAborted: Handler<WsRebaseAborted> = (_ctx, data) => {
  if (useSessionStore.getState().sessionId !== data.sessionId) return;
  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);

  if (data.reason) git.setRebaseError(data.reason);
};
