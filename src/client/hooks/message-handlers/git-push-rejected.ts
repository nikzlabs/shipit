import type { WsGitPushRejected } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleGitPushRejected: Handler<WsGitPushRejected> = (_ctx, _data) => {
  useGitStore.getState().setPushRejected(true);
};
