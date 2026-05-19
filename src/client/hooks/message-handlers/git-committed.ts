import type { WsGitCommitted } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useFileStore } from "../../stores/file-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleGitCommitted: Handler<WsGitCommitted> = (_ctx, data) => {
  const git = useGitStore.getState();
  const prevHash = useGitStore.getState().commits[0]?.hash;
  if (prevHash) {
    git.setLastCommitPair({ from: prevHash, to: data.hash });
    git.setTurnDiff(null);
  }
  git.prependCommit({ hash: data.hash, message: data.message, date: new Date().toISOString(), author: "ShipIt" });
  const currentRightTab = useUiStore.getState().rightTab;
  const currentSessionId = useSessionStore.getState().sessionId;
  if (currentRightTab === "files" && currentSessionId) {
    const currentViewingFile = useFileStore.getState().viewingFile;
    if (currentViewingFile) {
      useFileStore.getState().fetchFileWithTree(currentSessionId, currentViewingFile).catch((err: unknown) => console.warn("[file-refresh]", err));
    } else {
      useFileStore.getState().fetchTree(currentSessionId).catch((err: unknown) => console.warn("[file-refresh]", err));
    }
  }
};
