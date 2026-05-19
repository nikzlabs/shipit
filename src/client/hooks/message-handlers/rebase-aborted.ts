import type { WsRebaseAborted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseAborted: Handler<WsRebaseAborted> = (_ctx, _data) => {
  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);
};
