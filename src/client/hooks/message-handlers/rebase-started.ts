import type { WsRebaseStarted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseStarted: Handler<WsRebaseStarted> = (_ctx, _data) => {
  const git = useGitStore.getState();
  git.setRebaseStatus("in_progress");
  // A successful start invalidates any stale error from a previous attempt.
  git.setRebaseError(null);
};
