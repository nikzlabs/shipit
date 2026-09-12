import type { WsRebaseComplete } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleRebaseComplete: Handler<WsRebaseComplete> = (_ctx, data) => {
  if (useSessionStore.getState().sessionId !== data.sessionId) return;
  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);
  git.setPushRejected(false);
  git.setRebaseError(null);

  if (data.upToDate && !data.baseMoved) {
    useUiStore.getState().setToast({ message: "Already up to date" });
  }
};
