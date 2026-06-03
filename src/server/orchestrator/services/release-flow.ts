/**
 * Release flow (docs/171 Phase 1) — turns the agent's release markers (emitted
 * in its turn text) into release-card state on the `ReleaseStatusPoller`. This
 * is the "emitted as part of the turn, then mirrored into the card" seam.
 *
 * Called from the shared turn executor's post-turn step (every WS turn, commit
 * or not) with the accumulated assistant text. It needs no new agent tool /
 * `gh` shim change — the agent's plain-text marker is the whole protocol.
 */

import type { SessionManager } from "../sessions.js";
import type { ReleaseStatusPoller } from "../release-status-poller.js";
import { parseReleaseMarkers } from "../release-markers.js";
import { detectVersionSource } from "../release-version.js";

export interface ReleaseFlowDeps {
  releaseStatusPoller: ReleaseStatusPoller;
  sessionManager: SessionManager;
}

/**
 * Parse release markers out of a turn's assistant text and drive the poller.
 *
 * Markers are processed in document order so a turn that both proposes and (on
 * a re-run) supersedes itself ends in the right state. Releases require a
 * GitHub remote — without `session.remoteUrl` we no-op (the agent can still
 * tag locally, but there's nothing to publish or poll).
 */
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

  for (const marker of markers) {
    switch (marker.action) {
      case "propose": {
        // Fill the version source from local detection when the agent omitted
        // it, so the card always names where the version came from.
        const versionSource = marker.versionSource ?? detectVersionSource(sessionDir)?.source;
        deps.releaseStatusPoller.propose(sessionId, repoUrl, {
          version: marker.version,
          tag: marker.tag,
          prerelease: marker.prerelease,
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
