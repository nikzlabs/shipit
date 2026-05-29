import type { WsRebaseComplete } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseComplete: Handler<WsRebaseComplete> = (_ctx, _data) => {
  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);
  git.setPushRejected(false);
  git.setRebaseError(null);
};
