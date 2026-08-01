import type { WsRebaseConflicts } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseConflicts: Handler<WsRebaseConflicts> = (_ctx, data) => {
  const git = useGitStore.getState();
  // The server immediately hands these conflicts to a system-owned agent turn.
  // Keep the active rebase surface visible for that whole turn instead of
  // briefly swapping to an actionable conflict card the user does not need to
  // operate.
  git.setRebaseStatus("resolving");
  git.setRebaseConflicts(data.conflicts);
};
