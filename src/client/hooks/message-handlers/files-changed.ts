import type { WsFilesChanged } from "../../../server/shared/types.js";
import { useFileStore } from "../../stores/file-store.js";
import { useIssuesStore } from "../../stores/issues-store.js";
import { usePluginReposStore } from "../../stores/plugin-repos-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

/**
 * Whether a watcher-reported path is the workspace's `shipit.yaml`. Paths
 * arrive relative to the workspace root; the `./` strip mirrors the same guard
 * on the orchestrator's config-file detection (`ContainerSessionRunner`).
 */
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

  // planning#323 — `shipit.yaml` is where a repository declares its issue trackers
  // (docs/248 req 16: resolution happens at use). The server re-reads the file
  // on every request, so the browser's copy of the declarations is the only
  // stale view — and that copy IS the reference-resolution context
  // (`trackerDestinations()`), which doc chips, PR-card chips and markdown
  // issue links resolve against. Refresh it whenever the watcher reports the
  // file changed, so an edit takes effect without a session switch or an
  // Issues-tab re-activation. `GET /api/trackers` is a local file read with no
  // tracker-API round-trip, so this is cheap even for an unrelated edit; the
  // issue *list* is a real round-trip, so it only refetches when the declared
  // set actually changed and the tab is showing it.
  if (paths.some(isShipitConfig)) {
    void (async () => {
      const changed = await useIssuesStore.getState().fetchTrackers();
      if (changed && useUiStore.getState().rightTab === "issues") {
        await useIssuesStore.getState().fetchIssues();
      }
    })();
    // docs/262 — shipit.yaml is also where plugin repositories are declared,
    // and the snapshot gates the Plugins tab itself, so refresh it whether or
    // not the tab is open. Same cost profile as the tracker refetch: one local
    // file read on the server.
    if (sid) {
      void usePluginReposStore.getState().fetchSnapshot(sid);
    }
  }
};
