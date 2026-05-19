import type { WsGitLog } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleGitLog: Handler<WsGitLog> = (_ctx, data) => {
  useGitStore.getState().setCommits(data.commits);
};
