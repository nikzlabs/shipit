import type { WsFilesChanged } from "../../../server/shared/types.js";
import { useFileStore } from "../../stores/file-store.js";
import { useIssuesStore } from "../../stores/issues-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

/**
 * docs/248 / SHI-321 — tracker declarations live in the workspace's
 * `shipit.yaml`, and the server reads them fresh on every request
 * (`readDeclaredTrackers`), so an edit takes effect on the next request with no
 * restart. The browser's `trackers` list is its ONLY view of those declarations
 * — `trackerDestinations()` builds the whole client-side reference-resolution
 * context from it — but it was refreshed only on session change and on
 * Issues-tab activation. With the tab already open, an edit left doc chips,
 * PR-card chips and markdown issue links resolving against the *previous*
 * declarations until the user switched sessions or bounced the tab.
 *
 * The file watcher already reports `shipit.yaml` (it is not in the watcher's
 * ignore set, and `ContainerSessionRunner` keys its own config re-evaluation off
 * this same path list), so re-fetching here is what makes the browser match the
 * server's "fresh at use" model. `paths` are workspace-relative; the runner
 * tolerates a `./` prefix on the same comparison, so we do too.
 */
function isShipitConfigPath(p: string): boolean {
  return p.replace(/^\.\//, "") === "shipit.yaml";
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

    if (paths.some(isShipitConfigPath)) {
      void (async () => {
        await useIssuesStore.getState().fetchTrackers();
        // The declared set drives the sub-tabs, so an edit can retire the
        // active one — `fetchTrackers` then re-points `activeTracker` at a
        // tracker whose list was never loaded. Only the Issues panel renders
        // that list, so the follow-up fetch is gated on the tab being open;
        // the resolution context above is refreshed either way, because doc
        // chips and markdown links resolve against it from any tab.
        if (useUiStore.getState().rightTab === "issues") {
          await useIssuesStore.getState().fetchIssues();
        }
      })();
    }
  }
};
