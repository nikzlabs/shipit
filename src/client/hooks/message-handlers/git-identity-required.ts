import type { WsGitIdentityRequired } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleGitIdentityRequired: Handler<WsGitIdentityRequired> = (_ctx, _data) => {
  useGitStore.getState().setIdentityNeeded(true);
};
