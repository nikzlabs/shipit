import type { WsGitPushRejected } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import type { Handler } from "./types.js";

export const handleGitPushRejected: Handler<WsGitPushRejected> = (_ctx, _data) => {
  const git = useGitStore.getState();

  // A rejection can race with the rebase flow's progress events. The rebase
  // banner already owns the surface while that flow is active, so do not arm a
  // stale "Branch is behind" nudge that could appear when the flow settles.
  if (git.rebaseStatus !== "idle") return;

  git.setPushRejected(true);
};
