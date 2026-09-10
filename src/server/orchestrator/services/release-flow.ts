import type { SessionManager } from "../sessions.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import { parseReleaseMarkers } from "../release-markers.js";
import { detectVersionSource } from "../release-version.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import type { ReleaseMechanism } from "../../shared/types/release-types.js";

function resolveMechanism(sessionDir: string): ReleaseMechanism | undefined {
  try {
    return resolveShipitConfig(sessionDir).release?.mechanism;
  } catch {
    return undefined;
  }
}

export interface ReleaseFlowDeps {
  releaseStatusPoller: ReleaseStatusPoller;
  sessionManager: SessionManager;
}

export async function reactToReleaseMarkers(args: {
  deps: ReleaseFlowDeps;
  sessionId: string;
  sessionDir: string;
  turnText: string;
}): Promise<void> {
  const { deps, sessionId, sessionDir, turnText } = args;
  const markers = parseReleaseMarkers(turnText);
  if (markers.length === 0) return;

  const session = deps.sessionManager.get(sessionId);
  const repoUrl = session?.remoteUrl;
  if (!repoUrl) return;

  // Preserve document order: a later marker can supersede an earlier proposal.
  for (const marker of markers) {
    switch (marker.action) {
      case "propose": {
        const versionSource = marker.versionSource ?? detectVersionSource(sessionDir)?.source;
        const mechanism = marker.mechanism ?? resolveMechanism(sessionDir);
        deps.releaseStatusPoller.propose(sessionId, repoUrl, {
          version: marker.version,
          tag: marker.tag,
          prerelease: marker.prerelease,
          ...(marker.bumpType ? { bumpType: marker.bumpType } : {}),
          ...(versionSource ? { versionSource } : {}),
          ...(mechanism ? { mechanism } : {}),
          ...(marker.notes ? { notes: marker.notes } : {}),
        });
        break;
      }
      case "pr-opened": {
        const versionSource = marker.versionSource ?? detectVersionSource(sessionDir)?.source;
        deps.releaseStatusPoller.markPrOpened(sessionId, repoUrl, {
          version: marker.version,
          tag: marker.tag,
          prerelease: marker.prerelease ?? marker.tag.includes("-"),
          prNumber: marker.prNumber,
          prUrl: marker.prUrl,
          releaseBranch: marker.releaseBranch,
          ...(marker.bumpType ? { bumpType: marker.bumpType } : {}),
          ...(versionSource ? { versionSource } : {}),
          ...(marker.notes ? { notes: marker.notes } : {}),
        });
        break;
      }
      case "tagged": {
        deps.releaseStatusPoller.markTagged(sessionId, repoUrl, {
          tag: marker.tag,
          version: marker.version ?? marker.tag.replace(/^v/, ""),
          prerelease: marker.prerelease ?? marker.tag.includes("-"),
          ...(marker.sha ? { sha: marker.sha } : {}),
          ...(marker.notes ? { notes: marker.notes } : {}),
        });
        break;
      }
      case "already-released": {
        deps.releaseStatusPoller.markAlreadyReleased(sessionId, repoUrl, {
          tag: marker.tag,
          ...(marker.version ? { version: marker.version } : {}),
        });
        break;
      }
      case "cancelled": {
        deps.releaseStatusPoller.cancel(sessionId);
        break;
      }
    }
  }
}
