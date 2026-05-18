import type { WsRebaseStarted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleRebaseStarted: Handler<WsRebaseStarted> = (_ctx, _data) => {
  useGitStore.getState().setRebaseStatus("in_progress");
};
