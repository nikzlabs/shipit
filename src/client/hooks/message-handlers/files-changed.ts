import type { WsFilesChanged } from "../../../server/shared/types.js";
import { useFileStore } from "../../stores/file-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

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
};
