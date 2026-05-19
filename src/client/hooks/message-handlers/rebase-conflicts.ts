import type { WsRebaseConflicts } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseConflicts: Handler<WsRebaseConflicts> = (_ctx, data) => {
  const git = useGitStore.getState();
  git.setRebaseStatus("conflicts");
  git.setRebaseConflicts(data.conflicts);
};
