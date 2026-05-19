import type { WsTurnDiff } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleTurnDiff: Handler<WsTurnDiff> = (_ctx, data) => {
  useGitStore.getState().setTurnDiff({ fromCommit: data.fromCommit, toCommit: data.toCommit, files: data.files, stats: data.stats });
};
