import type { WsAutoResolveResult } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleAutoResolveResult: Handler<WsAutoResolveResult> = (_ctx, data) => {
  if (useSessionStore.getState().sessionId !== data.sessionId) return;

  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);
};
