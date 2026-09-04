/**
 * Repo-aware PR brokering target resolution (docs/211 — Sandbox sessions).
 *
 * The `gh` shim brokers every pull-request operation through the orchestrator's
 * session-scoped routes. For a normal **repo-bound** session that is trivial:
 * the one repo lives at the workspace root and its GitHub URL is on
 * `session.remoteUrl`. A **sandbox** session has no `remoteUrl` and the agent
 * clones whatever repos it wants into `/workspace/<name>` subdirs — so the
 * broker must figure out *which clone* a PR op targets, from the request rather
 * than a fixed session repo.
 *
 * This module resolves two things from the request's optional `cwd`/`repo`
 * overrides (the working directory the shim ran in, and an explicit `--repo`):
 *
 *   - `gitDir`    — the local clone the GitManager operates on (branch, commit,
 *                   push). For repo-bound sessions with no override this stays
 *                   the session workspace root, so behavior is UNCHANGED. For a
 *                   sandbox it becomes the cwd's clone subdir.
 *   - `remoteUrl` — what `resolveGitHubRemote` keys off. Repo-bound: the session
 *                   remote (a `--local` clone's origin is a bare-cache filesystem
 *                   path, so we must NOT read it). Sandbox / cwd-scoped: undefined
 *                   so the service reads the clone's own GitHub origin. `--repo`:
 *                   the explicit owner/name, synthesized to a github.com URL.
 *
 * The no-raw-token property is untouched: the resolution only widens *which*
 * repo the (server-side) broker may act on; the agent still never sees a token.
 */

import path from "node:path";
import { CONTAINER_WORKSPACE_DIR } from "../shared/fs-constants.js";
import { isValidRepoFlag, repoFlagToUrl, REPO_FLAG_FORMS } from "../shared/github-repo-flag.js";
import { ServiceError } from "./services/types.js";
import { repoId } from "./git-utils.js";
import type { SessionInfo } from "../shared/types.js";

// Re-exported so existing importers (and `pr-target.test.ts`) keep resolving
// this from `./pr-target.js` after the move into shared.
export { repoFlagToUrl };

/** Optional per-request overrides forwarded by the `gh` shim. */
export interface PrTargetOverride {
  /** The container working directory `gh` ran in (e.g. `/workspace/myrepo`). */
  cwd?: string;
  /** An explicit `--repo owner/name` (or a github.com URL) target. */
  repo?: string;
}

export interface PrTarget {
  /** Local directory the GitManager operates on. */
  gitDir: string;
  /** remoteUrl passed to the github service, or undefined to read git origin. */
  remoteUrl: string | undefined;
}

/**
 * Map a container working directory to the host clone directory under the
 * session workspace, clamping any path-traversal attempt back to the session
 * root. The container's `/workspace` is bind-mounted from `sessionDir`, so
 * `/workspace/foo` → `<sessionDir>/foo`. Anything that resolves outside
 * `sessionDir` (`..` escapes, an unknown absolute path) degrades to the session
 * root rather than reaching arbitrary host paths.
 */
export function resolveCloneDir(sessionDir: string, cwd: string | undefined): string {
  if (!cwd || typeof cwd !== "string") return sessionDir;

  let rel: string;
  if (cwd === CONTAINER_WORKSPACE_DIR) {
    return sessionDir;
  } else if (cwd.startsWith(`${CONTAINER_WORKSPACE_DIR}/`)) {
    rel = cwd.slice(CONTAINER_WORKSPACE_DIR.length + 1);
  } else if (path.isAbsolute(cwd)) {
    // An absolute path we don't recognize as a workspace mount — ignore it
    // rather than letting the agent point the broker at a host directory.
    return sessionDir;
  } else {
    rel = cwd;
  }

  const resolved = path.resolve(sessionDir, rel);
  if (resolved !== sessionDir && !resolved.startsWith(`${sessionDir}${path.sep}`)) {
    // Path traversal (`../../etc`) — clamp to the session root.
    return sessionDir;
  }
  return resolved;
}

/**
 * Resolve the clone dir + remote a PR operation should act on.
 *
 * Precedence:
 *   1. `--repo owner/name` → target that GitHub repo; operate on the cwd's
 *      clone (where the branch/commits live), falling back to the session root.
 *   2. Repo-bound session (`session.remoteUrl` set) with no `--repo` → UNCHANGED:
 *      the session root + the session remote. The cwd is ignored here on
 *      purpose — a repo-bound session's repo is always at the root, and a
 *      `--local` clone's origin is a bare-cache path we must not read.
 *   3. Otherwise (sandbox / no session remote) → the cwd's clone, reading its
 *      own git origin (remoteUrl undefined).
 *
 * A `--repo` that was **supplied but unparseable** raises rather than falling
 * through to (2)/(3). It used to normalize to `undefined`, which is
 * indistinguishable from "no `--repo` given" — so `gh pr list --repo octocat`
 * (a typo: no owner) silently listed the *session's own* repository's PRs and
 * exited 0. Absent still means absent; only a supplied value that means nothing
 * is refused.
 */
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
    return { gitDir: sessionDir, remoteUrl: session.remoteUrl };
  }
  return { gitDir: resolveCloneDir(sessionDir, override.cwd), remoteUrl: undefined };
}

/**
 * Whether the git-credential broker may issue a token for this session
 * (docs/211 — capability gating at the orchestrator, defense in depth).
 *
 * Only a sandbox session with `git` explicitly off is denied. Repo-bound and
 * ops sessions (`capabilities` undefined) are always allowed — unchanged.
 * Denying here, rather than relying solely on container env, means a missed
 * env/helper wiring path can't silently self-grant GitHub access.
 */
export function gitCredentialAllowed(
  session: Pick<SessionInfo, "kind" | "capabilities">,
): boolean {
  return !(session.kind === "sandbox" && !session.capabilities?.git);
}

/**
 * Whether the agent (via `gh pr merge`) may merge a PR for this session
 * (docs/224 — gated "dangerous GitHub operations"; docs/287 — the per-repository
 * grant).
 *
 * Merge is an outward-facing, effectively-irreversible act and the verb most
 * exposed to prompt-injection, so it is opt-in everywhere. Which opt-in applies
 * depends on what the session is:
 *   - `"allowed"` — a sandbox whose `dangerousGitHubOps` grant is on, or a
 *     repo-bound session in a repository the user granted (req 4, 12).
 *   - `"not-granted"` — a sandbox where the grant was left off at creation. The
 *     403 tells the agent the user must opt in when creating the sandbox.
 *   - `"not-granted-repo"` — a repo-bound session in a repository with the grant
 *     off. Off for every repository until the user turns it on (req 6).
 *   - `"not-sandbox"` — an **ops** session, whose behaviour requirement 13 keeps
 *     unchanged: it merges from the PR lifecycle card, not the shim. The wording
 *     is preserved deliberately, even though it now describes only one kind.
 *
 * `repoAllowsAgentMerge` is a required parameter rather than something this
 * module resolves. Keeping it pure is half the reason; the other half is that a
 * call site which has not consulted the grant cannot compile, so the answer can
 * never default to "allowed" because a caller forgot.
 *
 * Both grants are server-authoritative and never inferred from workspace files
 * — an agent can write `shipit.yaml`, so a permission stated there would be one
 * it could give itself.
 */
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

/** Why a repo-bound agent merge was refused, or `null` when it may proceed. */
export type AgentMergeOwnershipRefusal = { status: number; error: string } | null;

/**
 * docs/287 req 5 — is the pull request the agent asked to merge the one THIS
 * session opened?
 *
 * Every input is server-derived. The agent supplies only the number, and the
 * number is the one thing that proves nothing on its own: it is unique inside a
 * repository, so `#7` names a different pull request in every fork.
 *
 * - **`--repo` is refused**, not ignored. `resolvePrTarget` returns early on a
 *   parsed `--repo` and retargets the whole operation, so a merge carrying one
 *   would be checked against this session's repository and executed against
 *   another.
 * - **`cwd` is ignored, not refused.** The shim sends it on *every* call
 *   (`targetBody()` includes `deps.cwd`, defaulted to `process.cwd()`), so
 *   refusing it would reject the feature's own happy path. `resolvePrTarget`
 *   already ignores it for a repo-bound session.
 * - **The branch** must be the session's own, read with `currentBranchOrNull`
 *   and never `getCurrentBranch`, which answers `"main"` on a detached HEAD —
 *   a wrong answer that would pass a comparison against a `main`-based session.
 * - **The recorded pull request** must match both the number and the repository
 *   identity, re-derived from `remoteUrl` at merge time so a repointed origin
 *   invalidates an older record.
 *
 * Absence refuses, throughout. That is the opposite of `guardMergeSync`, where
 * "cannot tell" correctly proceeds: there the fallback is the status quo, here
 * it is a merge.
 */
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
