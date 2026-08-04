import type { WsRebaseStarted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleRebaseStarted: Handler<WsRebaseStarted> = (_ctx, data) => {
  // `useGitStore` is global but this rides a per-session socket, so a message
  // for another session (a replay racing a session switch) would otherwise
  // leave the rebase banner spinning over the wrong session. Same guard
  // `handleAutoResolveStarted` has.
  if (useSessionStore.getState().sessionId !== data.sessionId) return;
  const git = useGitStore.getState();
  git.setRebaseStatus("in_progress");
  // A successful start invalidates any stale error from a previous attempt.
  git.setRebaseError(null);
};
