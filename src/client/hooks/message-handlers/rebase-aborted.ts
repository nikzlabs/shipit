import type { WsRebaseAborted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseAborted: Handler<WsRebaseAborted> = (_ctx, data) => {
  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);
  // `reason` is present when the abort is server-internal (fetch failed,
  // base ref unresolvable, runner busy, non-conflict rebase error). Absent
  // for user-initiated aborts — leave any prior error untouched so a
  // stale error isn't cleared by an unrelated explicit abort.
  if (data.reason) git.setRebaseError(data.reason);
};
