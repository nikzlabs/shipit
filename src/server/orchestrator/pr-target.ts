import path from "node:path";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { isValidRepoFlag, repoFlagToUrl, REPO_FLAG_FORMS } from "../shared/github-repo-flag.js";
import { ServiceError } from "./services/types.js";
import { repoId } from "./git-utils.js";
import type { SessionInfo } from "../shared/types.js";

export { repoFlagToUrl };

export interface PrTargetOverride {
  cwd?: string;
  repo?: string;
}

export interface PrTarget {
  gitDir: string;
  /** Undefined tells the service to read the clone's origin. */
  remoteUrl: string | undefined;
}

export function resolveCloneDir(sessionDir: string, cwd: string | undefined): string {
  if (!cwd || typeof cwd !== "string") return sessionDir;

  let rel: string;
  if (cwd === CONTAINER_WORKSPACE_DIR) {
    return sessionDir;
  } else if (cwd.startsWith(`${CONTAINER_WORKSPACE_DIR}/`)) {
    rel = cwd.slice(CONTAINER_WORKSPACE_DIR.length + 1);
  } else if (path.isAbsolute(cwd)) {
    return sessionDir;
  } else {
    rel = cwd;
  }

  const resolved = path.resolve(sessionDir, rel);
  if (resolved !== sessionDir && !resolved.startsWith(`${sessionDir}${path.sep}`)) {
    return sessionDir;
  }
  return resolved;
}

export function resolvePrTarget(
  session: Pick<SessionInfo, "remoteUrl">,
  sessionDir: string,
  override: PrTargetOverride = {},
): PrTarget {
  if (!isValidRepoFlag(override.repo)) {
    throw new ServiceError(
      400,
      `Invalid --repo "${override.repo}". Expected ${REPO_FLAG_FORMS}.`,
    );
  }
  const repoUrl = repoFlagToUrl(override.repo);
  if (repoUrl) {
    return { gitDir: resolveCloneDir(sessionDir, override.cwd), remoteUrl: repoUrl };
  }
  if (session.remoteUrl) {
    // A local-cache clone's origin is a filesystem path; use the recorded remote.
    return { gitDir: sessionDir, remoteUrl: session.remoteUrl };
  }
  return { gitDir: resolveCloneDir(sessionDir, override.cwd), remoteUrl: undefined };
}

export function gitCredentialAllowed(
  session: Pick<SessionInfo, "kind" | "capabilities">,
): boolean {
  return !(session.kind === "sandbox" && !session.capabilities?.git);
}

// Grants must come from server state, never agent-writable workspace files.
export function mergeDisposition(
  session: Pick<SessionInfo, "kind" | "capabilities">,
  repoAllowsAgentMerge: boolean,
): "allowed" | "not-sandbox" | "not-granted" | "not-granted-repo" {
  if (session.kind === "sandbox") {
    return session.capabilities?.dangerousGitHubOps ? "allowed" : "not-granted";
  }
  if (session.kind === "ops") return "not-sandbox";
  return repoAllowsAgentMerge ? "allowed" : "not-granted-repo";
}

export type AgentMergeOwnershipRefusal = { status: number; error: string } | null;

// currentBranch must preserve detached HEAD as null; a fallback branch would bypass the check.
export function agentMergeOwnership(args: {
  session: Pick<SessionInfo, "remoteUrl" | "branch" | "prNumber" | "prRepoId">;
  requestedNumber: number;
  currentBranch: string | null;
  repoOverride: string | undefined;
}): AgentMergeOwnershipRefusal {
  const { session, requestedNumber, currentBranch, repoOverride } = args;

  if (repoOverride) {
    return {
      status: 400,
      error:
        "gh pr merge cannot take --repo in a repo-bound session: ShipIt only lets an agent merge "
        + "the pull request its own session opened, in its own repository. Run it without --repo.",
    };
  }

  const identity = repoId(session.remoteUrl ?? "");
  if (!identity) {
    return {
      status: 403,
      error:
        "Not merged — this session's remote is not a GitHub repository ShipIt can identify, "
        + "so it cannot tell whether the pull request belongs to this session.",
    };
  }

  if (!session.branch || currentBranch !== session.branch) {
    return {
      status: 409,
      error:
        `Not merged — this session is on branch "${session.branch ?? "(none)"}" but the workspace `
        + `is on ${currentBranch === null ? "a detached HEAD" : `"${currentBranch}"`}. `
        + "Switch back to the session's branch and try again.",
    };
  }

  if (session.prNumber === undefined || session.prRepoId === undefined) {
    return {
      status: 403,
      error:
        "Not merged — ShipIt has no record of opening a pull request for this session, so it "
        + "cannot merge one on the agent's behalf. Open the pull request with `gh pr create` "
        + "(ShipIt records the ones it opens), or merge from the PR card in the ShipIt UI.",
    };
  }

  if (session.prRepoId !== identity) {
    return {
      status: 403,
      error:
        "Not merged — this session's pull request was opened in a different repository than the "
        + "one `origin` points at now. Merge from the PR card in the ShipIt UI.",
    };
  }

  if (session.prNumber !== requestedNumber) {
    return {
      status: 403,
      error:
        `Not merged — ShipIt can only merge the pull request this session opened (#${session.prNumber}), `
        + `not #${requestedNumber}.`,
    };
  }

  return null;
}
