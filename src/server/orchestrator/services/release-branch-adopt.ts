import type { SessionManager } from "../sessions.js";
import type { PrStatusPoller } from "../pr-status-poller.js";

export interface AdoptReleaseBranchDeps {
  sessionManager: SessionManager;
  prStatusPoller?: PrStatusPoller;
  sseBroadcast: (event: string, data: unknown) => void;
}

// Call only for the session's own repository: the PR poller uses its remote.
export async function adoptReleaseBranch(args: {
  deps: AdoptReleaseBranchDeps;
  sessionId: string;
  releaseHeadBranch: string;
}): Promise<boolean> {
  const { deps, sessionId, releaseHeadBranch } = args;
  const session = deps.sessionManager.get(sessionId);
  if (!session) return false;
  if (session.branch === releaseHeadBranch) return false;

  // The PR poller matches by session.branch; update it before refreshing.
  deps.sessionManager.setBranch(sessionId, releaseHeadBranch);

  if (deps.prStatusPoller) {
    deps.prStatusPoller.reArm(sessionId);
    await deps.prStatusPoller.forceRefreshSession(sessionId);
  }

  deps.sseBroadcast("session_list", { sessions: deps.sessionManager.list() });
  return true;
}
