/**
 * GitHub services — reads (status, repos, search, PR status) and mutations
 * (PR create/merge, token, logout, quick PR creation).
 */

import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { WorkflowRunSummary, WorkflowJobSummary, WorkflowSummary } from "../github-auth-actions.js";
import type { PullRequestDetail, PrConversation } from "../github-auth-prs.js";
import type { ChatHistoryManager, PersistedMessage } from "../chat-history.js";
import type { PrAutoMergeError } from "../../shared/types/github-types.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import { parseGitHubRemote } from "../git-utils.js";
import { resolvePrBaseBranch } from "./git.js";
import { ServiceError } from "./types.js";
import { validateNonEmptyString } from "./validation.js";
import { getErrorMessage } from "../validation.js";
import type { GitHubStatus } from "./types.js";
import { formatUnresolvedConflictNotice } from "./conflict-marker-notice.js";
import { formatSecretScanNotice } from "./secret-scan-notice.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";
import type { GenerateText } from "../non-turn-model.js";

/**
 * Resolve owner/repo from a known remote URL or by reading git remotes.
 * Prefers the explicit remoteUrl (from session metadata) over reading from git,
 * since local clones from the bare cache may have a filesystem path as origin.
 *
 * Returns `{ owner, repo }` on success, or `{ error }` explaining the failure.
 *
 * **This must not give the workspace an `origin` it didn't have.** It is on the
 * read path of ~15 GitHub operations, including `gh pr list` / `gh pr view`, and
 * `remoteUrl` is frequently NOT the session's own repo: `resolvePrTarget` maps an
 * explicit `gh --repo owner/name` straight through to it. It used to
 * `addRemote("origin", remoteUrl)` on any mismatch, so a *read* naming another
 * repo wired that repo into the workspace as `origin` — permanently, and
 * invisibly to the caller that did it.
 *
 * That is how an ops session ended up pointed at the ShipIt repo: `gh pr list
 * --repo nikzlabs/shipit` created `origin` in its throwaway template workspace,
 * and the next post-turn auto-push — which had been correctly inert on a
 * remote-less session — sailed past `pushToOrigin`'s no-origin guard and tried to
 * push the ops workspace's `main` at the real repo. It failed only because the
 * two histories are unrelated; a workspace seeded from a clone would have pushed.
 *
 * So the repair is narrowed to the single case it was written for: an origin that
 * is a **local filesystem path**, i.e. the `git clone --local` artifact pointing
 * at the bare cache (`RepoGit.cloneFromCache` normally rewrites it, so this is the
 * legacy-clone safety net). Repointing that at the GitHub URL loses nothing — a
 * cache path was never a push target. Anything else is left alone: an absent
 * origin stays absent, and a real remote is never silently swapped for another.
 */
async function resolveGitHubRemote(
  git: GitManager,
  remoteUrl?: string,
): Promise<{ owner: string; repo: string } | { error: string }> {
  if (remoteUrl) {
    const parsed = parseGitHubRemote(remoteUrl);
    if (parsed) {
      const remotes = await git.getRemotes();
      const origin = remotes.find((r) => r.name === "origin");
      if (origin && origin.url !== remoteUrl && path.isAbsolute(origin.url)) {
        await git.addRemote("origin", remoteUrl);
      }
      return parsed;
    }
  }
  const remotes = await git.getRemotes();
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return { error: "No 'origin' remote configured" };
  const parsed = parseGitHubRemote(origin.url);
  if (!parsed) return { error: "Remote URL is not a GitHub repository" };
  return parsed;
}

/**
 * Resolve the PR associated with the current branch, rebase-stably and
 * state-aware.
 *
 * Resolution is by **branch name** (the GitHub `head=owner:ref` filter matches
 * the ref, not a commit SHA), so a rebase that rewrites the branch's head SHA
 * never loses the association. We prefer an OPEN PR; when none is open we fall
 * back to the most-recent PR in ANY state so a branch whose PR already
 * **merged or closed** is recognized as having had a PR — rather than looking
 * PR-less, which is what made ShipIt spawn a fresh PR on every post-merge turn
 * (the duplicate-PR bug: #1302 → #1312 → #1314 → …).
 *
 * Returns `null` only when the branch has never had a PR in any state.
 */
async function findBranchPr(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
  head: string,
): Promise<{
  number: number; url: string; base: string; title: string; body: string;
  state: "open" | "closed"; merged: boolean;
} | null> {
  const open = await githubAuthManager.findPullRequest(owner, repo, head);
  if (open) return { ...open, state: "open", merged: false };

  const any = await githubAuthManager.findPullRequestAnyState(owner, repo, head);
  if (!any) return null;
  return {
    number: any.number,
    url: any.url,
    base: any.base,
    title: any.title,
    body: any.body,
    state: any.state,
    merged: any.merged_at !== null,
  };
}

// Re-export CI-fix logic for backwards compatibility
export {
  fetchCIFailureLogs,
  stripCILogBloat,
  extractErrorLines,
  buildCIFixPrompt,
  triggerCIFix,
} from "./github-ci-fix.js";

// ---- Read operations ----

/** Get GitHub authentication status. */
export function getGitHubStatus(githubAuthManager: GitHubAuthManager): GitHubStatus {
  return githubAuthManager.getStatus();
}

/** Get user's GitHub repos (empty array if not authenticated). */
export async function getGitHubRepos(
  githubAuthManager: GitHubAuthManager,
): Promise<{ fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }[]> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listUserRepos();
}

/** List the user's GitHub organizations (empty array if not authenticated). */
export async function listGitHubOrgs(
  githubAuthManager: GitHubAuthManager,
): Promise<{ login: string; avatarUrl: string }[]> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listOrgs();
}

/** Search GitHub repos. Returns user's repos when query is empty. */
export async function searchGitHubRepos(
  githubAuthManager: GitHubAuthManager,
  query: string,
) {
  if (!githubAuthManager.authenticated) return [];
  if (!query || query.length < 2) return githubAuthManager.listUserRepos();
  return githubAuthManager.searchRepos(query);
}

/** Get PR status for a session (returns null if no PR or not authenticated). */
export async function getPrStatus(
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
  remoteUrl?: string,
) {
  if (!githubAuthManager.authenticated) return null;

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return null;

  const head = await git.getCurrentBranch();
  // State-aware, rebase-stable lookup: surfaces a merged/closed PR for the
  // branch so `gh pr status` reports it instead of "No PR for the current
  // branch" once the branch's PR has merged.
  const pr = await findBranchPr(githubAuthManager, resolved.owner, resolved.repo, head);
  if (!pr) return null;

  const stats = await git.diffStatVsBranch(pr.base);
  const checks = await githubAuthManager.getCheckStatus(resolved.owner, resolved.repo, head);

  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    baseBranch: pr.base,
    headBranch: head,
    state: pr.state,
    merged: pr.merged,
    insertions: stats.insertions,
    deletions: stats.deletions,
    checks,
    autoMergeEnabled: false,
    // One-shot fetch: we don't query GraphQL's `mergeable`/`reviewDecision`
    // fields here. The poller fills in the real values on its next tick.
    // Default to "unknown"/"none" so the UI doesn't gate on a placeholder.
    mergeable: "unknown",
    reviewDecision: "none",
  };
}

/**
 * Resolve a git credential for the in-container brokering credential helper
 * (`shipit-git-credential`, see `src/server/session/agent-shim/git-credential.ts`).
 *
 * This is the orchestrator side of finding #5 in docs/088-security-audit: the
 * GitHub PAT is NOT written into the container's gitconfig. Instead the
 * helper asks the worker (over localhost) for the credential at git-time, and
 * the worker brokers to this route. The token is returned only over the
 * worker→helper→git stdout channel and never lands on disk or in the
 * container's environment.
 *
 * Returns the credential only for `github.com` (the only host the
 * orchestrator holds a token for); any other host yields `null` so git falls
 * back to its other helpers / anonymous access. Mirrors the format the
 * orchestrator's own inline helper echoes: username `x-access-token`, password
 * = the PAT.
 */
export function getGitCredential(
  githubAuthManager: GitHubAuthManager,
  host: string | undefined,
): { username: string; password: string } | null {
  const normalizedHost = (host ?? "").trim().toLowerCase();
  // The orchestrator only ever holds a GitHub token. Returning it for any
  // other host would hand the PAT to an arbitrary git remote the agent could
  // configure (an exfiltration channel). Scope it strictly to github.com.
  if (normalizedHost !== "github.com") return null;
  const token = githubAuthManager.getToken();
  if (!token) return null;
  return { username: "x-access-token", password: token };
}

/**
 * Repo-scoped variant of {@link getGitCredential} (docs/172 Gap 2-R / planning#81).
 *
 * When the orchestrator has a GitHub App configured, this prefers a short-lived,
 * single-repo-scoped installation token over the long-lived PAT — so the
 * credential the caller-blind broker hands into the container has a minimal
 * blast radius (one repo, a narrow permission set, a bounded TTL) if it's
 * extracted. When App tokens aren't configured, or minting fails, or the
 * repo can't be identified, it falls back to {@link getGitCredential} (the PAT
 * path), preserving today's behavior and never hard-failing git for lack of an
 * installation token.
 *
 * Host scoping (github.com only) is enforced first, exactly as in the PAT path —
 * the token is never handed to an arbitrary remote.
 */
export async function getRepoScopedGitCredential(
  githubAuthManager: GitHubAuthManager,
  args: { host: string | undefined; owner?: string; repo?: string },
): Promise<{ username: string; password: string } | null> {
  const normalizedHost = (args.host ?? "").trim().toLowerCase();
  if (normalizedHost !== "github.com") return null;

  if (args.owner && args.repo && githubAuthManager.appTokensEnabled()) {
    const minted = await githubAuthManager.mintRepoScopedToken(args.owner, args.repo);
    if (minted) return { username: "x-access-token", password: minted };
    // Mint failed (network, uninstalled repo, …) — fall through to the PAT so
    // git keeps working. Availability over tightness; the PAT is still the
    // operator's configured credential, the App token is the enhancement.
    console.warn(
      `[github] App-token mint failed for ${args.owner}/${args.repo}; falling back to PAT for the git credential broker`,
    );
  }
  return getGitCredential(githubAuthManager, args.host);
}

// ---- Mutation operations ----

/** Create a pull request. */
export async function createPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  title: string,
  body: string,
  base: string,
  draft?: boolean,
  remoteUrl?: string,
): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const trimmedTitle = title.trim();
  const trimmedBase = base.trim();
  if (!trimmedTitle) throw new ServiceError(400, "PR title is required");
  if (trimmedTitle.length > 256) throw new ServiceError(400, "PR title too long (max 256 characters)");
  if (!trimmedBase) throw new ServiceError(400, "Base branch is required");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  const head = await git.getCurrentBranch();
  const result = await githubAuthManager.createPullRequest({
    owner: resolved.owner,
    repo: resolved.repo,
    title: trimmedTitle,
    body: body.trim(),
    head,
    base: trimmedBase,
    draft,
  });
  return { success: result.success, url: result.url, number: result.number, message: result.message };
}

/** Merge a pull request. */
export async function mergePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  method?: string,
  remoteUrl?: string,
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return { success: false, message: resolved.error };

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (!pr) return { success: false, message: "No active PR for current branch" };

  const mergeMethod = (method || "merge") as "merge" | "squash" | "rebase";
  const result = await githubAuthManager.mergePullRequest(resolved.owner, resolved.repo, pr.number, mergeMethod);

  if (result.success) return { success: true, message: "Pull request merged" };

  // If merge failed because checks are pending, enable auto-merge
  const checks = await githubAuthManager.getCheckStatus(resolved.owner, resolved.repo, head);
  if (checks.state === "pending") {
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const autoResult = await githubAuthManager.enableAutoMerge(resolved.owner, resolved.repo, pr.number, graphqlMethod);
    return { success: autoResult.success, message: autoResult.message, autoMergeEnabled: autoResult.success };
  }

  return { success: false, message: result.message };
}

/**
 * docs/224 — agent-driven merge backing `gh pr merge`, gated behind the sandbox
 * `dangerousGitHubOps` grant at the route. Distinct from {@link mergePullRequest}
 * (the UI card's current-branch merge): the agent passes an explicit PR number,
 * and because the agent is *mid-turn* the PR-status poller's cached checks/review
 * state is unavailable (sandbox PRs aren't tracked), so the guardrails are
 * enforced inline against the GitHub API:
 *   - Refuse a draft PR (mark it ready first).
 *   - Refuse unless required checks are green — unless `auto`, which enables
 *     GitHub auto-merge (merge-when-green) instead of merging now.
 *   - Branch protection / required reviews are enforced by GitHub server-side;
 *     its rejection message is surfaced verbatim rather than forced.
 *   - No admin/force path (the shim rejects `--admin` before it reaches here).
 */
export async function agentMergePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  opts: { number: number; method?: string; auto?: boolean; remoteUrl?: string },
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean; url?: string }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, opts.remoteUrl);
  if ("error" in resolved) return { success: false, message: resolved.error };

  const { owner, repo } = resolved;
  const pr = await githubAuthManager.viewPullRequest(owner, repo, opts.number);
  if (!pr) return { success: false, message: `PR #${opts.number} not found` };
  if (pr.merged) return { success: true, message: `PR #${opts.number} is already merged`, url: pr.url };
  if (pr.state === "closed") return { success: false, message: `PR #${opts.number} is closed` };
  if (pr.isDraft) {
    return { success: false, message: `PR #${opts.number} is a draft — mark it ready first (gh pr ready ${opts.number})` };
  }

  const mergeMethod = (opts.method || "merge") as "merge" | "squash" | "rebase";

  // Guardrail: required checks must be green. Checked directly against the PR
  // head's combined status — the poller doesn't track sandbox PRs.
  const checks = await githubAuthManager.getCheckStatus(owner, repo, pr.head);
  if (checks.state === "failure") {
    return {
      success: false,
      message: `Cannot merge PR #${opts.number}: ${checks.failed} required check(s) failing. Fix CI before merging.`,
    };
  }
  if (checks.state === "pending") {
    if (opts.auto) {
      const graphqlMethod =
        mergeMethod === "merge" ? ("MERGE" as const)
        : mergeMethod === "squash" ? ("SQUASH" as const)
        : ("REBASE" as const);
      const autoResult = await githubAuthManager.enableAutoMerge(owner, repo, opts.number, graphqlMethod);
      return {
        success: autoResult.success,
        message: autoResult.success
          ? `Auto-merge enabled for PR #${opts.number} — it will merge once checks pass.`
          : autoResult.message,
        autoMergeEnabled: autoResult.success,
        url: pr.url,
      };
    }
    return {
      success: false,
      message: `Cannot merge PR #${opts.number}: ${checks.pending} check(s) still running. Wait for green, or pass --auto to merge when checks pass.`,
    };
  }

  // checks.state is "success" or "none" (no checks configured) → merge now.
  const result = await githubAuthManager.mergePullRequest(owner, repo, opts.number, mergeMethod);
  if (result.success) return { success: true, message: `Merged PR #${opts.number}`, url: pr.url };
  // GitHub rejected the merge (branch protection, required review, conflicts).
  // Surface its reason verbatim — never force.
  return { success: false, message: result.message };
}

/**
 * Generate a PR description using the agent's generateText capability.
 *
 * docs/252 phase 7 — `sessionId` is what routes this through req 9's model:
 * the generator needs a session both to spawn through and to attribute the
 * spend to. Optional so a caller with no session degrades exactly as before.
 */
export async function generatePrDescription(
  git: GitManager,
  generateText: GenerateText,
  sessionDir: string,
  sessionId?: string,
): Promise<{ description: string }> {
  const log = await git.log(20);
  const diff = await git.diffSummary();

  if (log.length === 0) {
    return { description: "" };
  }

  const prompt = [
    "Write a pull request description summarizing these changes.",
    "Format as markdown with ## Summary (1-2 sentences) and ## Changes (bullet points).",
    "Keep it concise — 5-10 bullet points maximum.",
    "Return ONLY the markdown description, no extra commentary.",
    "",
    "Recent commits:",
    ...log.map((c) => `- ${c.message}`),
    "",
    "Files changed:",
    ...(diff.length > 0
      ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
      : ["(no file-level diff available)"]),
  ].join("\n");

  const description = await generateText(prompt, sessionDir, {
    ...(sessionId ? { sessionId } : {}),
    purpose: "pr-description",
  });
  return { description: description.trim() };
}

/** One-click PR creation — push, generate description, create PR. */
export async function quickCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: GenerateText,
  sessionId: string,
  sessionTitle: string,
  sessionDir: string,
  remoteUrl?: string,
  /**
   * docs/202 — re-arm overrides for a merged-then-rebased session. `baseBranch`
   * targets the prior PR's base instead of auto-detecting main/master (re-arm is
   * the one case where ShipIt knows the correct base). `forceWithLease` pushes
   * with `--force-with-lease` because the old remote branch often survives
   * (auto-delete off / best-effort delete failed) and the rebased branch
   * diverges from it, so a plain push is rejected non-fast-forward. Gated on the
   * re-arm state by the caller so normal create pushes are never force-pushed.
   */
  reArm?: { baseBranch?: string; forceWithLease?: boolean },
): Promise<{
  number: number;
  url: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
}> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  const head = await git.getCurrentBranch();

  // Check if there's already a PR for this branch
  const existingPr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (existingPr) {
    const stats = await git.diffStatVsBranch(existingPr.base);
    return {
      number: existingPr.number,
      url: existingPr.url,
      title: existingPr.title,
      body: existingPr.body,
      baseBranch: existingPr.base,
      headBranch: head,
      insertions: stats.insertions,
      deletions: stats.deletions,
    };
  }

  // Push the branch. For a re-armed (rebased, superseded) branch, force-with-
  // lease so a surviving diverged remote branch doesn't reject the push.
  try {
    if (reArm?.forceWithLease) {
      await git.forcePush("origin", head);
    } else {
      await git.push("origin", head);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes("workflow")) {
      throw new ServiceError(403,
        "Your GitHub token is missing the `workflow` scope, which is required because this branch modifies GitHub Actions workflow files.\n" +
        "Please update your token at https://github.com/settings/tokens to include the `workflow` scope, then reconnect.");
    }
    throw new ServiceError(500, `Push failed: ${msg}`);
  }

  // Base branch: for a re-armed branch use the prior PR's base (re-arm knows
  // it); otherwise the remote's actual default branch.
  let baseBranch = reArm?.baseBranch?.trim();
  if (!baseBranch) {
    baseBranch = await resolvePrBaseBranch(git, await git.listRemoteBranches());
  }

  // Generate title from session title
  const title = sessionTitle || head;

  // Generate description from conversation context
  const description = await generatePrDescriptionFromContext(
    git, chatHistoryManager, generateText, sessionId, baseBranch, sessionDir,
  );

  // Create PR
  const result = await githubAuthManager.createPullRequest({
    owner: resolved.owner,
    repo: resolved.repo,
    title,
    body: description,
    head,
    base: baseBranch,
  });

  if (!result.success || !result.url || !result.number) {
    throw new ServiceError(500, result.message ?? "Failed to create pull request");
  }

  const stats = await git.diffStatVsBranch(baseBranch);

  return {
    number: result.number,
    url: result.url,
    title,
    body: description,
    baseBranch,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

// ---- Agent-driven PR operations (used by the `gh` shim) ----

/**
 * Look up an open PR for the session's branch. Returns `null` if none exists.
 * Throws ServiceError on auth/remote-resolution failures so callers can map to HTTP.
 *
 * Exported for docs/239's self-merge-watch arm, which must resolve the PR by a
 * LIVE lookup rather than from the `pr_status` snapshot: at a chain boundary the
 * agent arms seconds after `gh pr create` returns, while the session still sits
 * in the poller's `mergedSessions` set (which it skips), so the snapshot still
 * describes the previous, just-merged PR.
 */
export async function resolveSessionPr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  remoteUrl?: string,
): Promise<{ owner: string; repo: string; head: string; pr: { number: number; url: string; base: string; title: string } | null }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);
  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  return { owner: resolved.owner, repo: resolved.repo, head, pr };
}

/**
 * Apply agent-requested labels to a PR, best-effort. Labeling must NEVER block
 * the PR create/edit: a label name that doesn't exist on the repo, a token
 * without label-write scope, etc. all degrade to a non-fatal warning string the
 * caller surfaces on the shim's stderr while the PR URL is still printed and
 * the command exits 0.
 *
 * Labels are normalized (trimmed, empties dropped) here so callers can forward
 * the agent's raw array. Returns `undefined` when there is nothing to warn
 * about (no labels requested, or all applied cleanly).
 */
async function applyPrLabels(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[] | undefined,
): Promise<string | undefined> {
  const normalized = (labels ?? []).map((l) => l.trim()).filter(Boolean);
  if (normalized.length === 0) return undefined;
  const result = await githubAuthManager.addLabelsToPullRequest(owner, repo, prNumber, normalized);
  if (!result.success) {
    return `Warning: could not apply label(s) ${normalized.join(", ")}: ${result.message ?? "unknown error"}. The PR was still created/updated.`;
  }
  return undefined;
}

/**
 * Remove agent-requested labels from a PR, best-effort — the removal sibling of
 * {@link applyPrLabels}. GitHub's label-removal endpoint is per-label (DELETE
 * `issues/{n}/labels/{name}`), so we issue one call per name. A label that
 * isn't on the PR comes back as a 404, which the auth layer maps to success
 * (removal is idempotent), so it never produces a warning. Genuine failures
 * (e.g. a token without Issues:write) are collected into a single non-fatal
 * warning string the caller surfaces on the shim's stderr — they never block
 * the edit. Returns `undefined` when there's nothing to remove or all removals
 * succeeded.
 */
async function removePrLabels(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
  prNumber: number,
  labels: string[] | undefined,
): Promise<string | undefined> {
  const normalized = (labels ?? []).map((l) => l.trim()).filter(Boolean);
  if (normalized.length === 0) return undefined;
  const failed: string[] = [];
  let lastMessage = "unknown error";
  for (const label of normalized) {
    const result = await githubAuthManager.removeLabelFromPullRequest(owner, repo, prNumber, label);
    if (!result.success) {
      failed.push(label);
      lastMessage = result.message ?? "unknown error";
    }
  }
  if (failed.length > 0) {
    return `Warning: could not remove label(s) ${failed.join(", ")}: ${lastMessage}. The PR was still updated.`;
  }
  return undefined;
}

/**
 * Flush any pending working-tree changes into a commit before a synchronous
 * push/PR operation. The agent calls `gh pr create` mid-turn, *before* the
 * normal end-of-turn `postTurnCommit` has run — without this flush, the new
 * PR would be opened against the branch's previously-committed state and the
 * agent's just-made edits would not appear on the PR.
 *
 * Note: this function does NOT cancel the scheduled auto-push debounce. That
 * is the caller's job, and it must happen *after* a synchronous push actually
 * lands — see `agentCreatePr`. Cancelling here (the previous behavior) dropped
 * the pending push whenever a caller short-circuited before its synchronous
 * push (e.g. `secretBlocked`), leaving the commit local with no retry and no
 * surfaced error (planning#200).
 *
 * Chat-history linkage is deferred via `runner.pendingCommitLink`: writing
 * `commitHash` onto any row that exists right now would either land on a
 * transient in_progress=1 row (which the next `replaceInProgress` wipes) or
 * the user message (which is misleading). Instead we stash the commit info
 * on the runner; the agent_result handler in `wireAgentListeners` applies
 * it after `replaceInProgress` finalizes the rows — that's the same fallback
 * `postTurnCommit` uses for the codex double-`turn/completed` race.
 *
 * Returns `commitHash` (null when there was nothing to commit) and
 * `secretBlocked` — true when `autoCommit` refused because the staged diff
 * carried a likely secret (docs/213). Callers that push/open a PR must abort on
 * `secretBlocked`: the secret-bearing change was NOT committed, so proceeding
 * would silently push/PR the prior (stale) branch state, hiding the agent's
 * just-made edit. The redacted warning notice is already emitted/persisted here.
 */
export async function flushPendingTurnCommit(
  git: GitManager,
  deps: {
    sessionId?: string;
    runnerRegistry?: SessionRunnerRegistry;
    /** When provided, the conflict notice is persisted (append) as well as
     * emitted, so it survives a reload — not just a reconnect. Structural (only
     * `append` is used) so non-`ChatHistoryManager` callers can pass a stub. */
    chatHistory?: { append(sessionId: string, message: PersistedMessage): unknown };
    /**
     * planning#301 — override the commit subject. The default (`runner.turnSummary`)
     * is right for the mid-turn `gh pr create` flush, where the work being
     * committed IS the turn's work. It is wrong for a flush that happens outside
     * a turn — a sub-agent consult finishing after its parent turn already
     * committed — where the last turn's summary would misattribute the commit to
     * work the agent did not do. Callers on that path pass their own subject.
     */
    summary?: string;
  },
): Promise<{ commitHash: string | null; secretBlocked: boolean }> {
  const runner = deps.sessionId && deps.runnerRegistry
    ? deps.runnerRegistry.get(deps.sessionId)
    : null;

  const summary =
    deps.summary?.split("\n")[0]?.slice(0, 120)
    || runner?.turnSummary?.split("\n")[0]?.slice(0, 120)
    || "Agent turn";
  const parentHash = await git.getHeadHash();
  const { commitHash, conflictedFiles, rebaseInProgress, secretFindings } = await git.autoCommit(summary);
  const secretBlocked = secretFindings.length > 0;
  if (secretBlocked && runner) {
    const message = formatSecretScanNotice(secretFindings);
    if (deps.chatHistory) {
      emitNoticePostTurn((m) => runner.emitMessage(m), deps.chatHistory, runner.sessionId, message, "warn");
    } else {
      runner.emitMessage({ type: "system_notice", sessionId: runner.sessionId, level: "warn", message });
    }
  }
  if ((conflictedFiles.length > 0 || rebaseInProgress) && runner) {
    const message = formatUnresolvedConflictNotice({ conflictedFiles, rebaseInProgress });
    if (deps.chatHistory) {
      emitNoticePostTurn((m) => runner.emitMessage(m), deps.chatHistory, runner.sessionId, message, "warn");
    } else {
      runner.emitMessage({ type: "system_notice", sessionId: runner.sessionId, level: "warn", message });
    }
  }
  if (!commitHash) return { commitHash: null, secretBlocked };

  if (runner && parentHash) {
    runner.pendingCommitLink = { commitHash, parentCommitHash: parentHash };
  }
  runner?.emitMessage({ type: "git_committed", hash: commitHash, message: summary });
  return { commitHash, secretBlocked: false };
}

/**
 * Agent-driven PR create. Like `quickCreatePr` but takes an explicit title and
 * body from the agent and skips the LLM-derived description path. Pushes the
 * branch first (same as `quickCreatePr`) and short-circuits if a PR already
 * exists for this branch.
 *
 * When `sessionId` + `runnerRegistry` are supplied, pending working-tree
 * changes are committed via `flushPendingTurnCommit` *before* the push.
 * This is required when the agent calls `gh pr create` mid-turn (the normal
 * end-of-turn auto-commit hasn't run yet). The deps are optional so older
 * callers (and tests) can still invoke the service without runner context.
 *
 * Returns the new (or existing) PR's metadata.
 */
export async function agentCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: {
    title?: string;
    body?: string;
    /** Optional override; auto-detects main/master from remote when not given. */
    base?: string;
    /** Open the PR as a draft. Defaults to false. */
    draft?: boolean;
    /** When true and body is empty/missing, fall back to a basic git-log description. */
    fill?: boolean;
    /**
     * Labels to apply to the PR (e.g. `["feature"]`). Applied best-effort after
     * the PR is opened — a label that doesn't exist on the repo surfaces a
     * non-fatal `labelWarning` rather than failing the create.
     */
    labels?: string[];
    sessionTitle?: string;
    remoteUrl?: string;
    /** Session id for resolving the runner (to flush pending commits + cancel auto-push). */
    sessionId?: string;
    /** Runner registry — when provided alongside sessionId, enables mid-turn commit flush. */
    runnerRegistry?: SessionRunnerRegistry;
    /** When provided, an unresolved-conflict notice from the pre-push flush is
     * persisted (so it survives a reload), not just emitted. */
    chatHistory?: ChatHistoryManager;
  },
): Promise<{
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  alreadyExisted: boolean;
  /** Non-fatal warning when one or more labels could not be applied. */
  labelWarning?: string;
}> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  // Commit any pending working-tree changes *before* checking for an existing
  // PR or pushing. This ensures the just-made edits are part of the branch
  // state we either push to the existing PR or use to create a new one.
  const flush = await flushPendingTurnCommit(git, {
    sessionId: options.sessionId,
    runnerRegistry: options.runnerRegistry,
    ...(options.chatHistory ? { chatHistory: options.chatHistory } : {}),
  });
  // docs/213 — a secret in the just-made edit means `autoCommit` refused it, so
  // the working-tree change is NOT on the branch. Pushing / opening a PR now
  // would silently publish the prior (stale) state without the agent's edit —
  // and the agent would believe its change shipped. Abort with a clear error;
  // the redacted warning notice was already surfaced by the flush.
  if (flush.secretBlocked) {
    throw new ServiceError(
      422,
      "Refused to create the PR: a likely secret was found in the staged changes, so they were not committed. " +
        "Remove the secret (use an env var / ShipIt secret) — or add a `gitleaks:allow` comment to the line if it's a false positive — then try again.",
    );
  }

  const head = await git.getCurrentBranch();

  // Resolve the runner so we can cancel the debounced auto-push *after* a
  // synchronous push lands below. We deliberately do NOT cancel before pushing:
  // a pending debounced push is only safe to drop once a synchronous push has
  // actually replaced it (planning#200). On branches that don't push synchronously
  // (e.g. a not-progressed merged PR returns without pushing), the debounce is
  // left armed so the commit still reaches the remote.
  const pushRunner = options.sessionId && options.runnerRegistry
    ? options.runnerRegistry.get(options.sessionId)
    : null;

  // A PR already on this branch short-circuits creation — but only when it can't
  // legitimately host the new work. The rule (matches /shipit-docs/github.md and
  // the re-arm flow, docs/202):
  //   - An OPEN PR always wins: push the freshly-flushed commits to it and return
  //     its metadata. This is the documented "skip creation if a PR is open".
  //   - A CLOSED/MERGED PR blocks a duplicate ONLY when the branch hasn't moved
  //     past what was merged. A merged PR can't be reopened, so if the branch was
  //     rebased onto the current base and carries genuinely new work
  //     (squash-safe `advancedBeyondMergedBase`, docs/202), we fall through and
  //     open a NEW PR rather than pointing the agent back at a dead PR (#1357).
  const existingPr = await findBranchPr(githubAuthManager, resolved.owner, resolved.repo, head);
  let reArmBase: string | undefined;
  if (existingPr) {
    // Build the "return the existing PR" response (used for both the open and
    // the not-progressed-merged short-circuits).
    const returnExistingPr = async () => {
      const stats = await git.diffStatVsBranch(existingPr.base);
      // Apply any requested labels additively to the existing PR — best-effort.
      const labelWarning = await applyPrLabels(
        githubAuthManager, resolved.owner, resolved.repo, existingPr.number, options.labels,
      );
      return {
        number: existingPr.number,
        url: existingPr.url,
        title: existingPr.title,
        baseBranch: existingPr.base,
        headBranch: head,
        insertions: stats.insertions,
        deletions: stats.deletions,
        alreadyExisted: true as const,
        labelWarning,
      };
    };

    if (existingPr.state === "open") {
      // Push so the open PR picks up the commits we just flushed.
      try {
        await git.push("origin", head);
      } catch (err) {
        const msg = getErrorMessage(err);
        if (msg.includes("workflow")) {
          throw new ServiceError(403,
            "Your GitHub token is missing the `workflow` scope, which is required because this branch modifies GitHub Actions workflow files.\n" +
            "Please update your token at https://github.com/settings/tokens to include the `workflow` scope, then reconnect.");
        }
        throw new ServiceError(500, `Push failed: ${msg}`);
      }
      // Synchronous push landed — now safe to drop any pending debounce.
      pushRunner?.clearPushTimer();
      return await returnExistingPr();
    }

    // Closed/merged PR. Only re-arm for a NEW PR when the branch has genuinely
    // progressed beyond the merged base (rebased onto the current base + new
    // work). Otherwise keep blocking the duplicate and return its metadata.
    const progressed = await git.advancedBeyondMergedBase(existingPr.base);
    if (!progressed) {
      return await returnExistingPr();
    }
    // Progressed: open a NEW PR targeting the prior PR's base. The old remote
    // branch often survives the merge (repos with auto-delete off) pointing at
    // the pre-rebase commits, so the create-path push below must force-with-lease.
    reArmBase = existingPr.base;
  }

  // Push the branch (same flow as quickCreatePr). When re-arming past a merged
  // PR the surviving remote branch has diverged, so force-with-lease instead.
  try {
    if (reArmBase !== undefined) {
      await git.forcePush("origin", head);
    } else {
      await git.push("origin", head);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    if (msg.includes("workflow")) {
      throw new ServiceError(403,
        "Your GitHub token is missing the `workflow` scope, which is required because this branch modifies GitHub Actions workflow files.\n" +
        "Please update your token at https://github.com/settings/tokens to include the `workflow` scope, then reconnect.");
    }
    throw new ServiceError(500, `Push failed: ${msg}`);
  }
  // Synchronous push landed — now safe to drop any pending debounce.
  pushRunner?.clearPushTimer();

  // Resolve base branch. A re-armed branch keeps the prior PR's base unless the
  // caller passed an explicit one.
  let baseBranch = options.base?.trim() || reArmBase;
  if (!baseBranch) {
    baseBranch = await resolvePrBaseBranch(git, await git.listRemoteBranches());
  }

  // Resolve title — fall back to session title or branch name.
  const title = options.title?.trim() || options.sessionTitle || head;
  if (!title) throw new ServiceError(400, "PR title is required");
  if (title.length > 256) throw new ServiceError(400, "PR title too long (max 256 characters)");

  // Resolve body — agent provides it directly; with --fill we synthesize a
  // basic markdown description from recent commits.
  let body = options.body?.trim() ?? "";
  if (!body && options.fill) {
    try {
      const log = await git.log(10);
      body = [
        "## Summary",
        "Changes from ShipIt session.",
        "",
        "## Changes",
        ...log.map((c) => `- ${c.message}`),
      ].join("\n");
    } catch {
      body = "Changes from ShipIt session.";
    }
  }

  const result = await githubAuthManager.createPullRequest({
    owner: resolved.owner,
    repo: resolved.repo,
    title,
    body,
    head,
    base: baseBranch,
    draft: options.draft ?? false,
  });

  if (!result.success || !result.url || !result.number) {
    throw new ServiceError(500, result.message ?? "Failed to create pull request");
  }

  // Apply requested labels after the PR exists — best-effort so a bad label
  // name never turns a successful create into a failure.
  const labelWarning = await applyPrLabels(
    githubAuthManager, resolved.owner, resolved.repo, result.number, options.labels,
  );

  const stats = await git.diffStatVsBranch(baseBranch);
  return {
    number: result.number,
    url: result.url,
    title,
    baseBranch,
    headBranch: head,
    insertions: stats.insertions,
    deletions: stats.deletions,
    alreadyExisted: false,
    labelWarning,
  };
}

/**
 * Edit an existing PR (title/body and/or labels). When `prNumber` is not
 * provided, the service resolves the open PR for the current branch.
 *
 * `addLabels` and `removeLabels` mirror real `gh pr edit --add-label` /
 * `--remove-label`: both are applied best-effort after any title/body PATCH, so
 * a typo'd or nonexistent label name surfaces a non-fatal `labelWarning` rather
 * than failing the edit. Adds run before removes; if the same name appears in
 * both, the remove wins (matching gh).
 */
export async function editPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: {
    number?: number;
    title?: string;
    body?: string;
    addLabels?: string[];
    removeLabels?: string[];
    remoteUrl?: string;
  },
): Promise<{ number: number; url: string; labelWarning?: string }> {
  const resolved = await resolveSessionPr(git, githubAuthManager, options.remoteUrl);

  let prNumber = options.number;
  if (typeof prNumber !== "number") {
    if (!resolved.pr) throw new ServiceError(404, "No open PR for the current branch");
    prNumber = resolved.pr.number;
  }

  const addLabels = (options.addLabels ?? []).map((l) => l.trim()).filter(Boolean);
  const removeLabels = (options.removeLabels ?? []).map((l) => l.trim()).filter(Boolean);
  const hasTitleOrBody = typeof options.title === "string" || typeof options.body === "string";
  if (!hasTitleOrBody && addLabels.length === 0 && removeLabels.length === 0) {
    throw new ServiceError(400, "Provide a title, body, or label to update");
  }

  let url: string;
  let number: number;
  if (hasTitleOrBody) {
    const update = await githubAuthManager.updatePullRequest(
      resolved.owner, resolved.repo, prNumber,
      { title: options.title, body: options.body },
    );
    if (!update.success || !update.url || !update.number) {
      throw new ServiceError(500, update.message ?? "Failed to update PR");
    }
    url = update.url;
    number = update.number;
  } else {
    // Labels-only edit: there's no title/body PATCH to make, but we still need
    // a URL to print. Prefer the resolved PR's URL; fall back to the canonical
    // github.com URL when the number was passed explicitly for a PR that isn't
    // the current branch's.
    url = resolved.pr?.url ?? `https://github.com/${resolved.owner}/${resolved.repo}/pull/${prNumber}`;
    number = prNumber;
  }

  // Both label operations are best-effort and independent; collect any warnings
  // so a failed add and a failed remove can both be reported in one shot.
  const warnings: string[] = [];
  const addWarning = await applyPrLabels(githubAuthManager, resolved.owner, resolved.repo, prNumber, addLabels);
  if (addWarning) warnings.push(addWarning);
  const removeWarning = await removePrLabels(githubAuthManager, resolved.owner, resolved.repo, prNumber, removeLabels);
  if (removeWarning) warnings.push(removeWarning);

  return { number, url, labelWarning: warnings.length > 0 ? warnings.join("\n") : undefined };
}

/** Comment on an existing PR. */
export async function commentOnPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  body: string,
  options: { number?: number; remoteUrl?: string } = {},
): Promise<{ number: number; commentUrl: string }> {
  const trimmed = validateNonEmptyString(body, "Comment body").trim();

  const resolved = await resolveSessionPr(git, githubAuthManager, options.remoteUrl);
  let prNumber = options.number;
  if (typeof prNumber !== "number") {
    if (!resolved.pr) throw new ServiceError(404, "No open PR for the current branch");
    prNumber = resolved.pr.number;
  }

  const result = await githubAuthManager.addPullRequestComment(
    resolved.owner, resolved.repo, prNumber, trimmed,
  );
  if (!result.success || !result.url) {
    throw new ServiceError(500, result.message ?? "Failed to add comment");
  }
  return { number: prNumber, commentUrl: result.url };
}

/**
 * Add a PR-level (issue) comment to the session's current-branch PR
 * (docs/133 Phase 4's Conversation composer). Thin wrapper over
 * `commentOnPullRequest` that always resolves the open PR for the current
 * branch — the panel only ever shows that session's single PR.
 */
export async function addIssueComment(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  body: string,
  options: { remoteUrl?: string } = {},
): Promise<{ number: number; commentUrl: string }> {
  return commentOnPullRequest(git, githubAuthManager, body, { remoteUrl: options.remoteUrl });
}

/** Mark a draft PR as ready for review. */
export async function markPrReady(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { number?: number; remoteUrl?: string } = {},
): Promise<{ number: number; message: string }> {
  const resolved = await resolveSessionPr(git, githubAuthManager, options.remoteUrl);
  let prNumber = options.number;
  if (typeof prNumber !== "number") {
    if (!resolved.pr) throw new ServiceError(404, "No open PR for the current branch");
    prNumber = resolved.pr.number;
  }
  const result = await githubAuthManager.markPullRequestReady(resolved.owner, resolved.repo, prNumber);
  if (!result.success) throw new ServiceError(500, result.message);
  return { number: prNumber, message: result.message };
}

/** Close an open PR. */
export async function closePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { number?: number; remoteUrl?: string } = {},
): Promise<{ number: number; url: string }> {
  const resolved = await resolveSessionPr(git, githubAuthManager, options.remoteUrl);
  let prNumber = options.number;
  if (typeof prNumber !== "number") {
    if (!resolved.pr) throw new ServiceError(404, "No open PR for the current branch");
    prNumber = resolved.pr.number;
  }
  const result = await githubAuthManager.updatePullRequest(
    resolved.owner, resolved.repo, prNumber, { state: "closed" },
  );
  if (!result.success || !result.url || !result.number) {
    throw new ServiceError(500, result.message ?? "Failed to close PR");
  }
  return { number: result.number, url: result.url };
}

/** Reopen a closed PR. */
export async function reopenPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { number?: number; remoteUrl?: string } = {},
): Promise<{ number: number; url: string }> {
  if (typeof options.number !== "number") {
    throw new ServiceError(400, "PR number is required to reopen");
  }
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);
  const result = await githubAuthManager.updatePullRequest(
    remote.owner, remote.repo, options.number, { state: "open" },
  );
  if (!result.success || !result.url || !result.number) {
    throw new ServiceError(500, result.message ?? "Failed to reopen PR");
  }
  return { number: result.number, url: result.url };
}

/**
 * A PR as `gh pr view` returns it: always the PR's own details, plus the
 * conversation when `comments` was requested — or `conversationError` when that
 * second fetch failed (docs/255).
 */
export type PullRequestView =
  & PullRequestDetail
  & Partial<PrConversation>
  & { conversationError?: string };

/**
 * Read a single PR's details. When `number` is omitted, returns the open PR
 * for the current branch (or null when there is none). With `comments: true`
 * the PR's conversation (issue comments, reviews, inline review threads) is
 * merged in — docs/255.
 */
export async function viewPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { number?: number; remoteUrl?: string; comments?: boolean } = {},
): Promise<PullRequestView | null> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);

  let prNumber = options.number;
  if (typeof prNumber !== "number") {
    const head = await git.getCurrentBranch();
    // State-aware, rebase-stable lookup so `gh pr view` resolves the branch's
    // PR even after it has merged/closed (the Stop hook relies on this to stop
    // re-prompting `gh pr create` once a PR already exists).
    const pr = await findBranchPr(githubAuthManager, remote.owner, remote.repo, head);
    if (!pr) return null;
    prNumber = pr.number;
  }
  // Read through the result-carrying variant so a 403 on a private repo (or a
  // GitHub 5xx) surfaces as an error instead of "No pull request found" —
  // failure and absence must stay distinguishable here too.
  const read = await githubAuthManager.viewPullRequestResult(remote.owner, remote.repo, prNumber);
  if (!read.ok) throw new ServiceError(502, `Failed to read PR #${prNumber}: ${read.error}`);
  const pr = read.pr;
  if (!pr || options.comments !== true) return pr;

  // docs/255 — the conversation is a second round-trip, so it is fetched only
  // when the caller asked for it. A FAILED fetch must not read as "no
  // comments": we return `conversationError` and no arrays at all, and the
  // caller decides whether that is fatal (an explicit `--comments`/`--json
  // comments` request) or a note (a plain view's summary line).
  const conversation = await githubAuthManager.viewPullRequestConversation(
    remote.owner, remote.repo, prNumber,
  );
  if (!conversation.ok) return { ...pr, conversationError: conversation.error };
  return { ...pr, ...conversation.conversation };
}

/** List PRs for the session's repo. */
export async function listPullRequests(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { state?: "open" | "closed" | "all"; remoteUrl?: string } = {},
): Promise<{ url: string; number: number; base: string; head: string; title: string; state: "open" | "closed"; isDraft: boolean }[]> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);
  return githubAuthManager.listPullRequests(remote.owner, remote.repo, options.state ?? "open");
}

// ---- GitHub Actions (backs `gh run` / `gh workflow`) ----

/** Per-job log tail and total-output caps for `gh run view --log[-failed]`. */
const RUN_LOG_TAIL_LINES = 200;
const RUN_LOG_MAX_CHARS = 50_000;

/** Conclusions that count as "failed" for `--log-failed`. */
const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

/** A workflow ref the GitHub API accepts directly: a numeric id or a `*.yml` file. */
function isDirectWorkflowRef(ref: string): boolean {
  return /^\d+$/.test(ref) || /\.ya?ml$/i.test(ref);
}

/** Keep only the last `n` lines of `text`. */
function lastLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

/**
 * Resolve a user-supplied `--workflow` value (a name, filename, repo-relative
 * path, or numeric id) to the `{workflow_id}` the Actions API endpoint accepts
 * (a numeric id or a bare filename). Numeric ids and `*.yml`/`*.yaml` refs pass
 * through (paths are reduced to their basename); anything else is matched
 * against the repo's workflow list by name/path/filename. Throws a 404
 * ServiceError when a name can't be resolved so the agent gets a clear message
 * rather than a silently-empty run list.
 */
async function resolveWorkflowFile(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  if (isDirectWorkflowRef(ref)) {
    return ref.includes("/") ? (ref.split("/").pop() ?? ref) : ref;
  }
  const all = await githubAuthManager.listWorkflows(owner, repo);
  const match = all.find(
    (w) => w.name === ref || w.path === ref || w.path.split("/").pop() === ref,
  );
  if (!match) {
    throw new ServiceError(404, `No workflow matching "${ref}" found in ${owner}/${repo}`);
  }
  return String(match.id);
}

/** Concatenate (tail-capped) logs for a run's jobs, optionally only failed ones. */
async function collectRunLogs(
  githubAuthManager: GitHubAuthManager,
  owner: string,
  repo: string,
  jobs: WorkflowJobSummary[],
  onlyFailed: boolean,
): Promise<string> {
  const selected = onlyFailed
    ? jobs.filter((j) => j.conclusion !== null && FAILED_CONCLUSIONS.has(j.conclusion))
    : jobs;
  const parts: string[] = [];
  let total = 0;
  for (const job of selected) {
    if (total >= RUN_LOG_MAX_CHARS) {
      parts.push("… (log output truncated)");
      break;
    }
    const raw = await githubAuthManager.getJobLogs(owner, repo, job.databaseId);
    const header = `===== ${job.name} (${job.conclusion ?? job.status}) =====`;
    const chunk = `${header}\n${lastLines(raw, RUN_LOG_TAIL_LINES)}`.slice(0, RUN_LOG_MAX_CHARS - total);
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.join("\n\n");
}

/**
 * List workflow runs for the session's repo, most-recent first. `workflow`
 * filters to a single workflow (by name/filename/path/id); `branch`/`status`
 * map to GitHub's filters; `limit` caps the count (1–100, default 20).
 */
export async function listWorkflowRuns(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { workflow?: string; branch?: string; status?: string; limit?: number; remoteUrl?: string } = {},
): Promise<WorkflowRunSummary[]> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);

  const workflowFile = options.workflow
    ? await resolveWorkflowFile(githubAuthManager, remote.owner, remote.repo, options.workflow)
    : undefined;

  return githubAuthManager.listWorkflowRuns(remote.owner, remote.repo, {
    ...(workflowFile ? { workflowFile } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
  });
}

/**
 * View a single workflow run with its jobs (and optionally logs). When `runId`
 * is omitted, resolves the most recent run for the current branch, falling back
 * to the most recent run overall. Returns null when no run can be resolved.
 */
export async function viewWorkflowRun(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { runId?: number; log?: boolean; logFailed?: boolean; remoteUrl?: string } = {},
): Promise<{ run: WorkflowRunSummary; jobs: WorkflowJobSummary[]; logs: string } | null> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);

  let runId = options.runId;
  if (typeof runId !== "number") {
    // No id given — default to the latest run, preferring the current branch so
    // "fetch the result of the workflow I just dispatched" resolves naturally.
    const head = await git.getCurrentBranch();
    let recent = await githubAuthManager.listWorkflowRuns(remote.owner, remote.repo, { branch: head, limit: 1 });
    if (recent.length === 0) {
      recent = await githubAuthManager.listWorkflowRuns(remote.owner, remote.repo, { limit: 1 });
    }
    if (recent.length === 0) return null;
    runId = recent[0].databaseId;
  }

  const run = await githubAuthManager.getWorkflowRun(remote.owner, remote.repo, runId);
  if (!run) return null;
  const jobs = await githubAuthManager.listWorkflowRunJobs(remote.owner, remote.repo, runId);
  const wantLogs = options.log === true || options.logFailed === true;
  const logs = wantLogs
    ? await collectRunLogs(githubAuthManager, remote.owner, remote.repo, jobs, options.logFailed === true)
    : "";
  return { run, jobs, logs };
}

/**
 * Events whose runs the agent may re-run. Both are runs the agent's own pushes
 * caused. `workflow_dispatch`, `schedule`, `release`, `repository_dispatch` and
 * friends are excluded on purpose: a human (or another system) chose to start
 * those, and re-running one is re-making that choice, not retrying the agent's
 * own CI. The shim cannot dispatch a workflow, so it should not be able to
 * replay a dispatched one either.
 */
const RERUNNABLE_RUN_EVENTS = new Set(["push", "pull_request"]);

/**
 * Re-run an existing workflow run for the session's repo.
 *
 * The one Actions *write* the agent gets. What makes it defensible is NOT that
 * re-running is harmless in the abstract — a workflow can deploy or publish —
 * but that three guardrails together bound it to CI the agent already causes.
 * ShipIt auto-pushes the session branch after every turn, so the agent already
 * triggers exactly these runs; blocking re-run never removed that capability, it
 * only forced the agent to reach it by pushing an empty commit. Each guardrail
 * closes a way the run could be something *other* than that:
 *
 * 1. **Same branch.** Otherwise an explicit run id re-executes a merged deploy
 *    or release workflow on `main`/`stable` — genuinely new authority.
 * 2. **Same commit.** GitHub re-runs against the run's original `GITHUB_SHA`,
 *    so without this the agent could replay an arbitrary historical commit's CI;
 *    pushing can only ever run the *current* tree.
 * 3. **Push / PR events only.** A `workflow_dispatch` run on this branch was
 *    started by a human; replaying it is dispatching by proxy.
 *
 * (1) and (2) are both load-bearing and neither subsumes the other: a fresh
 * session branch points at the base branch's tip, so its runs share a SHA with
 * `main`'s — the branch check is what stops that — while a long-lived branch has
 * many runs at the same name and different SHAs.
 *
 * With no `runId`, resolves the latest run for the current branch. Note the
 * deliberate difference from {@link viewWorkflowRun}: that one falls back to the
 * latest run *overall* when the branch has none, which for a write would silently
 * reach outside the branch scope. Here "no run on this branch" is an error. That
 * function also reads the branch with `getCurrentBranch()`; this one must not
 * (see the call site).
 */
export async function rerunWorkflowRun(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { runId?: number; onlyFailed?: boolean; remoteUrl?: string } = {},
): Promise<{ run: WorkflowRunSummary; onlyFailed: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);

  // `currentBranchOrNull`, NOT `getCurrentBranch` — the latter falls back to
  // "main" on a detached HEAD (mid-rebase, mid-cherry-pick), which for a guard
  // comparing branch names would silently authorize re-running `main`'s runs.
  const branch = await git.currentBranchOrNull();
  if (!branch) {
    throw new ServiceError(
      409,
      "HEAD is detached (a rebase or cherry-pick may be in progress), so there is no branch to scope the re-run to. " +
        "Finish or abort it, then re-run.",
    );
  }
  const head = await git.getHeadHash();
  if (!head) throw new ServiceError(409, "Could not resolve HEAD, so there is no commit to scope the re-run to.");

  let run: WorkflowRunSummary | null;
  if (typeof options.runId === "number") {
    run = await githubAuthManager.getWorkflowRun(remote.owner, remote.repo, options.runId);
    if (!run) throw new ServiceError(404, `No workflow run ${options.runId} in ${remote.owner}/${remote.repo}`);
  } else {
    const recent = await githubAuthManager.listWorkflowRuns(remote.owner, remote.repo, { branch, limit: 1 });
    if (recent.length === 0) {
      throw new ServiceError(404, `No workflow run found for branch "${branch}" — pass a run id explicitly.`);
    }
    run = recent[0];
  }

  const refusal = rerunRefusal(run, branch, head);
  if (refusal) throw new ServiceError(403, refusal);

  const onlyFailed = options.onlyFailed === true;
  const result = await githubAuthManager.rerunWorkflowRun(remote.owner, remote.repo, run.databaseId, { onlyFailed });
  if (!result.ok) throw new ServiceError(result.status, rerunErrorMessage(result, run, onlyFailed));
  return { run, onlyFailed };
}

/**
 * The three guardrails, as one message-producing check. Returns `null` when the
 * run is in scope. Kept separate from the flow above so each refusal states the
 * concrete mismatch — an agent that gets "not allowed" learns nothing.
 */
function rerunRefusal(run: WorkflowRunSummary, branch: string, head: string): string | null {
  const scope = "gh run rerun only covers CI your own branch's pushes caused";
  if (run.headBranch !== branch) {
    return `Run ${run.databaseId} is on branch "${run.headBranch}", not the branch you are working on ("${branch}"). ` +
      `${scope} — re-running a run on another branch could re-execute a deploy or release workflow. ` +
      `If that is what the user wants, they can re-run it from GitHub.`;
  }
  if (run.headSha !== head) {
    return `Run ${run.databaseId} is for commit ${run.headSha.slice(0, 8)}, but HEAD is ${head.slice(0, 8)}. ` +
      `${scope}, at the commit you are on — GitHub re-runs against the run's original commit, so this would replay ` +
      `an older tree. Push the current branch and let CI run on it instead.`;
  }
  if (!RERUNNABLE_RUN_EVENTS.has(run.event)) {
    return `Run ${run.databaseId} was triggered by "${run.event}", not a push or pull request. ` +
      `${scope} — a run someone started by hand is theirs to re-run.`;
  }
  return null;
}

/**
 * Turn GitHub's refusal into something the agent can act on.
 *
 * A 403 here is ambiguous, so name the likely causes rather than assert one —
 * and always keep GitHub's own message, which is often the most specific thing
 * available.
 */
function rerunErrorMessage(
  result: { status: number; message: string },
  run: WorkflowRunSummary,
  onlyFailed: boolean,
): string {
  const what = onlyFailed ? "re-run the failed jobs in" : "re-run";
  const base = `Could not ${what} run ${run.databaseId} (${run.workflowName}): ${result.message}`;
  if (result.status === 403) {
    return `${base}\n\nCommon causes, most actionable first:\n` +
      `- The connected GitHub token lacks Actions write access. A fine-grained PAT needs the repository's "Actions" permission set to Read and write; a classic token needs \`repo\`. Ask the user to reconnect GitHub or widen the token.\n` +
      `- GitHub refused this particular run: still in progress, more than 30 days old, past its 50-re-run limit, or (with --failed) no failed jobs to re-run. \`gh run view ${run.databaseId}\` shows its state.\n` +
      `- An organization policy or SSO requirement applies to the token.`;
  }
  return base;
}

/** List the repo's workflow definitions. */
export async function listWorkflows(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { remoteUrl?: string } = {},
): Promise<WorkflowSummary[]> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);
  return githubAuthManager.listWorkflows(remote.owner, remote.repo);
}

/**
 * View a single workflow definition (by name/filename/path/id) along with its
 * most recent runs. Returns null when the workflow can't be found.
 */
export async function viewWorkflow(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { workflow: string; remoteUrl?: string },
): Promise<{ workflow: WorkflowSummary; runs: WorkflowRunSummary[] } | null> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const ref = (options.workflow ?? "").trim();
  if (!ref) throw new ServiceError(400, "A workflow name, filename, or id is required");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);

  // Resolve to the API's {workflow_id} (numeric id or filename), then read it.
  const file = await resolveWorkflowFile(githubAuthManager, remote.owner, remote.repo, ref);
  const workflow = await githubAuthManager.getWorkflow(remote.owner, remote.repo, file);
  if (!workflow) return null;
  const runs = await githubAuthManager.listWorkflowRuns(remote.owner, remote.repo, {
    workflowFile: String(workflow.id),
    limit: 10,
  });
  return { workflow, runs };
}

/** Generate a conversation-aware PR description. */
async function generatePrDescriptionFromContext(
  git: GitManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: GenerateText,
  sessionId: string,
  baseBranch: string,
  sessionDir: string,
): Promise<string> {
  try {
    const messages = chatHistoryManager.load(sessionId);
    const firstUserMsg = messages.find((m) => m.role === "user")?.text ?? "";

    // Build conversation excerpt (last N exchanges, ~2000 chars)
    const exchanges: string[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0 && charCount < 2000; i--) {
      const msg = messages[i];
      const prefix = msg.role === "user" ? "User" : "Assistant";
      const text = msg.text.slice(0, 500);
      exchanges.unshift(`${prefix}: ${text}`);
      charCount += text.length;
    }

    const log = await git.log(20);
    const diff = await git.diffSummary();

    // Get diff stat vs base branch
    let diffStatLine = "";
    try {
      const stats = await git.diffStatVsBranch(baseBranch);
      diffStatLine = `+${stats.insertions} -${stats.deletions}`;
    } catch { /* ignore */ }

    const prompt = [
      "Generate a pull request description for the following changes.",
      "",
      "## What the user asked for",
      `"${firstUserMsg.slice(0, 300)}"`,
      "",
      "## Key conversation exchanges",
      ...exchanges,
      "",
      "## Code changes",
      ...(diff.length > 0
        ? diff.map((f) => `- ${f.file} (+${f.insertions} -${f.deletions})`)
        : ["(no file-level diff available)"]),
      diffStatLine ? `Total: ${diffStatLine}` : "",
      "",
      "## Commit log",
      ...log.map((c) => `- ${c.message}`),
      "",
      "Write a concise GitHub PR description in markdown:",
      '1. A "## Summary" section (2-3 sentences explaining why)',
      '2. A "## Changes" section (bullet list of key changes)',
      '3. A "## Test plan" section (how to verify)',
      "Return ONLY the markdown description, no extra commentary.",
    ].join("\n");

    const generated = await generateText(prompt, sessionDir, {
      sessionId,
      purpose: "pr-description",
    });
    // docs/252 phase 7 (req 9) — **a blank generation is a failure, and this is
    // the line that says so.** The generic prose below used to live only in the
    // `catch`, so it was reached on a thrown error and not on an empty result —
    // and in containerized production an empty result was the ONLY outcome,
    // because the orchestrator had no agent and the default generator returned
    // `""`. Every pull request ShipIt opened therefore had an empty body and
    // nothing anywhere said why. Req 9 calls that a change to make, not a
    // behaviour to preserve.
    if (generated.trim()) return generated;
    console.warn("[pr] Description generation returned nothing; using the generic fallback");
    return await basicPrDescription(git);
  } catch (err) {
    console.warn("[pr] Failed to generate description:", err);
    return await basicPrDescription(git);
  }
}

/**
 * The generic description a failed or blank generation falls back to. Extracted
 * so the rejection path and the blank-success path cannot drift — they are the
 * same outcome from the user's side, and only one of them used to reach this.
 */
async function basicPrDescription(git: GitManager): Promise<string> {
  try {
    const log = await git.log(5);
    return [
      "## Summary",
      "Changes from ShipIt session.",
      "",
      "## Changes",
      ...log.map((c) => `- ${c.message}`),
    ].join("\n");
  } catch {
    return "Changes from ShipIt session.";
  }
}

// ---- Auto-merge operations ----

const GRAPHQL_MERGE_METHOD = {
  merge: "MERGE",
  squash: "SQUASH",
  rebase: "REBASE",
} as const;

function parseRepoFromPrUrl(prUrl: string): { owner: string; repo: string } | null {
  const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prUrl);
  if (!urlMatch) return null;
  return { owner: urlMatch[1], repo: urlMatch[2] };
}

/**
 * If auto-merge was enabled before a PR existed, apply that preference to the
 * newly-created PR now that GitHub has a pull request number to target.
 */
export async function activatePendingAutoMergeForPr(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  prUrl: string,
  prNumber: number,
): Promise<void> {
  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  if (!autoMergeState?.enabled) return;

  const resolved = parseRepoFromPrUrl(prUrl);
  if (!resolved) return;

  const graphqlMethod = GRAPHQL_MERGE_METHOD[autoMergeState.mergeMethod];
  const result = await githubAuth.enableAutoMerge(resolved.owner, resolved.repo, prNumber, graphqlMethod);

  if (!result.success) {
    const branchSettingsUrl = `https://github.com/${resolved.owner}/${resolved.repo}/settings/branches`;
    prStatusPoller.setAutoMergeManaged(sessionId, true, branchSettingsUrl);
    return;
  }

  prStatusPoller.setAutoMergeEnabled(sessionId, true);
  prStatusPoller.setAutoMergeManaged(sessionId, false);
}

/** Toggle auto-merge on/off for a session's PR. */
export async function toggleAutoMerge(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  enabled: boolean,
): Promise<{ enabled: boolean; mergeMethod: "squash" | "merge" | "rebase"; managed?: boolean; reason?: string } | { error: PrAutoMergeError }> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const prStatus = prStatusPoller.getStatus(sessionId);
  if (!prStatus) {
    const state = prStatusPoller.setAutoMergeEnabled(sessionId, enabled);
    return {
      enabled: state.enabled,
      mergeMethod: state.mergeMethod,
      managed: state.managed,
    };
  }

  const resolved = parseRepoFromPrUrl(prStatus.prUrl);
  if (!resolved) throw new ServiceError(400, "Cannot parse repository from PR URL");
  const { owner, repo } = resolved;

  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  const mergeMethod = autoMergeState?.mergeMethod ?? "squash";

  if (enabled) {
    const graphqlMethod = GRAPHQL_MERGE_METHOD[mergeMethod];
    const result = await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);

    if (!result.success) {
      // Fallback: ShipIt-managed auto-merge when GitHub native isn't available.
      // Thread the real GitHub error (`result.message`) through as `reason` so
      // the managed-merge tooltip names the actual missing precondition (e.g.
      // "Allow auto-merge" off in repo settings) instead of a generic guess.
      // Link to repo General settings — that's where the "Allow auto-merge"
      // checkbox lives (the most common missing precondition) and it links out
      // to branch protection / rulesets from the same page.
      const settingsUrl = `https://github.com/${owner}/${repo}/settings`;

      prStatusPoller.setAutoMergeEnabled(sessionId, true);
      prStatusPoller.setAutoMergeManaged(sessionId, true, settingsUrl, result.message);
      return { enabled: true, mergeMethod, managed: true, reason: result.message };
    }

    prStatusPoller.setAutoMergeEnabled(sessionId, true);
    return { enabled: true, mergeMethod };
  } else {
    const currentState = prStatusPoller.getAutoMergeState(sessionId);
    // Skip GitHub API call if this was ShipIt-managed (nothing to disable on GitHub)
    if (!currentState?.managed) {
      await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
    }
    prStatusPoller.setAutoMergeEnabled(sessionId, false);
    return { enabled: false, mergeMethod };
  }
}

/** Update the preferred merge method for a session. */
export async function updateMergeMethod(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  method: "squash" | "merge" | "rebase",
): Promise<{ mergeMethod: "squash" | "merge" | "rebase" }> {
  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  prStatusPoller.setMergeMethod(sessionId, method);

  // If auto-merge is active, re-enable with the new method
  if (autoMergeState?.enabled) {
    const prStatus = prStatusPoller.getStatus(sessionId);
    if (prStatus) {
      const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prStatus.prUrl);
      if (urlMatch) {
        const [, owner, repo] = urlMatch;
        await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
        const graphqlMethod = method === "merge" ? "MERGE" as const : method === "squash" ? "SQUASH" as const : "REBASE" as const;
        await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);
      }
    }
  }

  return { mergeMethod: method };
}

/** Set GitHub token. Returns status and repos.
 *
 * Backfills the per-repo credential helper into every existing session's
 * workspace. `configureGitCredentials` is otherwise only invoked at session
 * creation (new, fork, unarchive, warm), so sessions that pre-date the auth
 * have no `credential.helper` in their `.git/config` and `git push` falls back
 * to interactive auth — which GitHub rejects with "Password authentication is
 * not supported."
 */
export async function setGitHubToken(
  githubAuthManager: GitHubAuthManager,
  token: string,
  sessionManager?: SessionManager,
): Promise<{
  status: GitHubStatus;
  repos: { fullName: string; description: string | null; private: boolean; defaultBranch: string; cloneUrl: string }[];
}> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) throw new ServiceError(400, "GitHub token cannot be empty");
  const success = await githubAuthManager.setToken(trimmed);
  if (!success) throw new ServiceError(400, "Invalid GitHub token");

  if (sessionManager) {
    for (const s of sessionManager.list()) {
      if (!s.workspaceDir) continue;
      try {
        githubAuthManager.configureGitCredentials(s.workspaceDir);
      } catch (err) {
        console.error(`[github-auth] Failed to configure credentials for session ${s.id}:`, getErrorMessage(err));
      }
    }
  }

  const repos = await githubAuthManager.listUserRepos();
  return { status: githubAuthManager.getStatus(), repos };
}

/** Logout from GitHub. Returns updated status. */
export function gitHubLogout(
  githubAuthManager: GitHubAuthManager,
): { status: GitHubStatus } {
  githubAuthManager.clearCredentials();
  return { status: githubAuthManager.getStatus() };
}
