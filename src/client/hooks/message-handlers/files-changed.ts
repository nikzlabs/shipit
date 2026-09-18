import type { WsFilesChanged } from "../../../server/shared/types.js";
import { useFileStore } from "../../stores/file-store.js";
import { useIssuesStore } from "../../stores/issues-store.js";
import { usePluginReposStore } from "../../stores/plugin-repos-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

function isShipitConfig(path: string): boolean {
  return path.replace(/^\.\//, "") === "shipit.yaml";
}

export const handleFilesChanged: Handler<WsFilesChanged> = (_ctx, data) => {
  const paths: string[] = data.paths;
  const sid = useSessionStore.getState().sessionId;
  const currentRightTab = useUiStore.getState().rightTab;
  const currentViewingFile = useFileStore.getState().viewingFile;

  if (sid) {
    const needsTree = currentRightTab === "files";
    const needsFile = currentViewingFile && paths.some((p) => currentViewingFile.endsWith(p));

    if (needsTree && needsFile) {
      useFileStore.getState().fetchFileWithTree(sid, currentViewingFile).catch((err: unknown) => console.warn("[file-refresh]", err));
    } else if (needsTree) {
      useFileStore.getState().fetchTree(sid).catch((err: unknown) => console.warn("[file-refresh]", err));
    } else if (needsFile) {
      useFileStore.getState().refreshFileContent(sid, currentViewingFile).catch((err: unknown) => console.warn("[file-refresh]", err));
    }
  }

  if (paths.some(isShipitConfig)) {
    void (async () => {
      const changed = await useIssuesStore.getState().fetchTrackers();
      if (changed && useUiStore.getState().rightTab === "issues") {
        await useIssuesStore.getState().fetchIssues();
      }
    })();

    if (sid) {
      void usePluginReposStore.getState().fetchSnapshot(sid);
    }
  }
};
