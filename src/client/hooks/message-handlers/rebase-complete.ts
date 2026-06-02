import type { WsRebaseComplete } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleRebaseComplete: Handler<WsRebaseComplete> = (_ctx, data) => {
  const git = useGitStore.getState();
  git.setRebaseStatus("idle");
  git.setRebaseConflicts([]);
  git.setPushRejected(false);
  git.setRebaseError(null);

  // A no-op sync (branch already contained everything from the base) flashes
  // the in-progress banner and immediately returns to idle, so without a toast
  // the click looks like it did nothing. Confirm it explicitly. A real rebase
  // already shows the spinner banner, so we don't toast that case.
  if (data.upToDate) {
    useUiStore.getState().setToast({ message: "Already up to date" });
  }
};
