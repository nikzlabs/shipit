import type { SessionManager } from "../sessions.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import type { SystemTurnDeps } from "../session-runner.js";
import { countReleaseMarkerComments, parseReleaseMarkers } from "../release-markers.js";
import { detectVersionSource } from "../release-version.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { NOTES_DRAFT_FILE, readDraftNotes, repoPublishesAuthoredNotes } from "../release-notes-draft.js";
import type { ReleaseMechanism } from "../../shared/types/release-types.js";

function resolveMechanism(sessionDir: string): ReleaseMechanism | undefined {
  try {
    return resolveShipitConfig(sessionDir).release?.mechanism;
  } catch {
    return undefined;
  }
}

/**
 * The draft the proposed card links to, or why there is none (docs/309).
 *
 * `none` — no notes will be published, so the release is ready to confirm
 * without them (req 10a): a prerelease tags an existing commit and cannot carry
 * a file, and a repo whose workflow ignores `.release-notes/` publishes
 * GitHub's generated list.
 *
 * `missing` — the card is the confirm button and confirming accepts the notes
 * (req 4), so a release that will publish notes it does not have is not ready
 * to be confirmed (req 10).
 */
type NotesDraft = { kind: "none" } | { kind: "draft"; path: string } | { kind: "missing" };

async function resolveNotesDraft(sessionDir: string, prerelease: boolean): Promise<NotesDraft> {
  if (prerelease) return { kind: "none" };
  if (!(await repoPublishesAuthoredNotes(sessionDir))) return { kind: "none" };
  if (!(await readDraftNotes(sessionDir))) return { kind: "missing" };
  return { kind: "draft", path: NOTES_DRAFT_FILE };
}

export interface ReleaseFlowDeps {
  releaseStatusPoller: ReleaseStatusPoller | undefined;
  sessionManager: SessionManager;
}

/** Every set of turn deps (composer and dispatch) takes its release step from here, so no turn path drops markers. */
export function buildPostTurnReleaseFlow(deps: {
  getReleaseStatusPoller: () => ReleaseStatusPoller | undefined;
  sessionManager: SessionManager;
}): NonNullable<SystemTurnDeps["postTurnReleaseFlow"]> {
  return (sessionId, sessionDir, turnText) =>
    reactToReleaseMarkers({
      deps: { releaseStatusPoller: deps.getReleaseStatusPoller(), sessionManager: deps.sessionManager },
      sessionId,
      sessionDir,
      turnText,
    });
}

export async function reactToReleaseMarkers(args: {
  deps: ReleaseFlowDeps;
  sessionId: string;
  sessionDir: string;
  turnText: string;
}): Promise<void> {
  const { deps, sessionId, sessionDir, turnText } = args;
  const markers = parseReleaseMarkers(turnText);
  const malformed = countReleaseMarkerComments(turnText) - markers.length;
  if (malformed > 0) {
    console.warn(`[release-flow] ignoring ${malformed} malformed release marker(s) for ${sessionId}.`);
  }
  if (markers.length === 0) return;
  console.log(`[release-flow] ${sessionId}: ${markers.map((m) => m.action).join(", ")}`);

  const poller = deps.releaseStatusPoller;
  if (!poller) {
    console.warn(`[release-flow] no release card for ${sessionId}: the release status poller is not available.`);
    return;
  }
  const session = deps.sessionManager.get(sessionId);
  const repoUrl = session?.remoteUrl;
  if (!repoUrl) {
    console.warn(`[release-flow] no release card for ${sessionId}: the session has no remote URL.`);
    return;
  }

  // Preserve document order: a later marker can supersede an earlier proposal.
  for (const marker of markers) {
    switch (marker.action) {
      case "propose": {
        const draft = await resolveNotesDraft(sessionDir, marker.prerelease);
        if (draft.kind === "missing") {
          console.warn(
            `[release-flow] ignoring a ${marker.tag} proposal for ${sessionId}: ` +
              `this repo publishes authored notes and "${NOTES_DRAFT_FILE}" is absent or blank.`,
          );
          break;
        }
        const versionSource = marker.versionSource ?? detectVersionSource(sessionDir)?.source;
        const mechanism = marker.mechanism ?? resolveMechanism(sessionDir);
        poller.propose(sessionId, repoUrl, {
          version: marker.version,
          tag: marker.tag,
          prerelease: marker.prerelease,
          ...(marker.bumpType ? { bumpType: marker.bumpType } : {}),
          ...(versionSource ? { versionSource } : {}),
          ...(mechanism ? { mechanism } : {}),
          ...(draft.kind === "draft" ? { notesDraftPath: draft.path } : {}),
        });
        break;
      }
      case "pr-opened": {
        const versionSource = marker.versionSource ?? detectVersionSource(sessionDir)?.source;
        poller.markPrOpened(sessionId, repoUrl, {
          version: marker.version,
          tag: marker.tag,
          prerelease: marker.prerelease ?? marker.tag.includes("-"),
          prNumber: marker.prNumber,
          prUrl: marker.prUrl,
          releaseBranch: marker.releaseBranch,
          ...(marker.bumpType ? { bumpType: marker.bumpType } : {}),
          ...(versionSource ? { versionSource } : {}),
        });
        break;
      }
      case "tagged": {
        poller.markTagged(sessionId, repoUrl, {
          tag: marker.tag,
          version: marker.version ?? marker.tag.replace(/^v/, ""),
          prerelease: marker.prerelease ?? marker.tag.includes("-"),
          ...(marker.sha ? { sha: marker.sha } : {}),
        });
        break;
      }
      case "already-released": {
        poller.markAlreadyReleased(sessionId, repoUrl, {
          tag: marker.tag,
          ...(marker.version ? { version: marker.version } : {}),
        });
        break;
      }
      case "cancelled": {
        poller.cancel(sessionId);
        break;
      }
    }
  }
}
