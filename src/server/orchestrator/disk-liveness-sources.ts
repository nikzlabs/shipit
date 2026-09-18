import type { SessionInfo } from "../shared/types.js";
import { liveOverlayScopeHashes, depDirsForSession } from "./overlay-session.js";
import { livePluginStoreArtifacts } from "./plugin-dep-store.js";

// Warm sessions mount live artifacts too; omit listAll so callers cannot exclude them.
export interface WarmInclusiveSessions {
  listAllIncludingWarm(): SessionInfo[];
}

export function overlayLiveScopeSource(
  sessions: WarmInclusiveSessions,
): () => Set<string> {
  return () => liveOverlayScopeHashes(sessions.listAllIncludingWarm(), depDirsForSession);
}

export function pluginLiveArtifactSource(
  sessions: WarmInclusiveSessions,
): () => Promise<{ scopeHashes: Set<string>; cacheHashes: Set<string> }> {
  return () => livePluginStoreArtifacts(sessions.listAllIncludingWarm());
}
