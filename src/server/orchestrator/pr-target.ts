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
import type { SessionInfo } from "../shared/types.js";

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
 * Normalize an explicit `--repo` value into a canonical github.com clone URL.
 * Accepts `owner/name`, `github.com/owner/name`, or an `https://github.com/...`
 * URL. Returns undefined when absent or unparseable (the caller then falls back
 * to the session/cwd default, and the github service surfaces a clear error if
 * no origin can be resolved at all).
 */
export function repoFlagToUrl(repo: string | undefined): string | undefined {
  if (!repo || typeof repo !== "string") return undefined;
  const trimmed = repo.trim();
  if (!trimmed) return undefined;
  const match = /^(?:https?:\/\/)?(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}.git`;
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
 */
export function resolvePrTarget(
  session: Pick<SessionInfo, "remoteUrl">,
  sessionDir: string,
  override: PrTargetOverride = {},
): PrTarget {
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
 * (docs/224 — gated "dangerous GitHub operations").
 *
 * Merge is an outward-facing, effectively-irreversible act and the verb most
 * exposed to prompt-injection, so it is opt-in and **sandbox-only**:
 *   - `"allowed"` — a sandbox session whose `dangerousGitHubOps` grant is on.
 *   - `"not-sandbox"` — any non-sandbox (repo-bound / ops) session. These merge
 *     from the PR lifecycle card in the ShipIt UI, not the shim; the route
 *     turns this into a 403 pointing the agent back at that card.
 *   - `"not-granted"` — a sandbox where the grant was left off at creation. The
 *     403 tells the agent the user must opt in when creating the sandbox.
 *
 * The grant is set server-authoritatively at creation and never inferred from
 * workspace files, so an agent cannot self-elevate into a merge.
 */
export function mergeDisposition(
  session: Pick<SessionInfo, "kind" | "capabilities">,
): "allowed" | "not-sandbox" | "not-granted" {
  if (session.kind !== "sandbox") return "not-sandbox";
  return session.capabilities?.dangerousGitHubOps ? "allowed" : "not-granted";
}
