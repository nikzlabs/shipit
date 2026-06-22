/**
 * GitHub services — reads (status, repos, search, PR status) and mutations
 * (PR create/merge, token, logout, quick PR creation).
 */

import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { PrAutoMergeError } from "../../shared/types/github-types.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import { parseGitHubRemote } from "../git-utils.js";
import { ServiceError } from "./types.js";
import { getErrorMessage } from "../validation.js";
import type { GitHubStatus } from "./types.js";
import { formatUnresolvedConflictNotice } from "./conflict-marker-notice.js";
import { formatSecretScanNotice } from "./secret-scan-notice.js";
import { emitNoticePostTurn } from "../chat-card-persistence.js";

/**
 * Resolve owner/repo from a known remote URL or by reading git remotes.
 * Prefers the explicit remoteUrl (from session metadata) over reading from git,
 * since local clones from the bare cache may have a filesystem path as origin.
 *
 * Returns `{ owner, repo }` on success, or `{ error }` explaining the failure.
 */
async function resolveGitHubRemote(
  git: GitManager,
  remoteUrl?: string,
): Promise<{ owner: string; repo: string } | { error: string }> {
  if (remoteUrl) {
    const parsed = parseGitHubRemote(remoteUrl);
    if (parsed) {
      // Fix the git remote if it doesn't match (e.g., points to bare cache path).
      // This makes subsequent git push/pull operations work correctly.
      const remotes = await git.getRemotes();
      const origin = remotes.find((r) => r.name === "origin");
      if (origin?.url !== remoteUrl) {
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
 * Repo-scoped variant of {@link getGitCredential} (docs/172 Gap 2-R / SHI-79).
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

/** Generate a PR description using the agent's generateText capability. */
export async function generatePrDescription(
  git: GitManager,
  generateText: (prompt: string, cwd: string) => Promise<string>,
  sessionDir: string,
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

  const description = await generateText(prompt, sessionDir);
  return { description: description.trim() };
}

/** One-click PR creation — push, generate description, create PR. */
export async function quickCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: (prompt: string, cwd: string) => Promise<string>,
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
  // it); otherwise auto-detect main/master from the remote.
  let baseBranch = reArm?.baseBranch?.trim();
  if (!baseBranch) {
    const remoteBranches = await git.listRemoteBranches();
    baseBranch = remoteBranches.includes("main") ? "main" :
      remoteBranches.includes("master") ? "master" :
      remoteBranches[0] ?? "main";
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
 */
async function resolveSessionPr(
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
 * Also clears any scheduled auto-push debounce: we're about to push
 * synchronously, and letting the debounced timer fire afterwards produces a
 * noisy duplicate "Auto-pushed to origin/..." event after the PR is already
 * open.
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
     * emitted, so it survives a reload — not just a reconnect. */
    chatHistory?: ChatHistoryManager;
  },
): Promise<{ commitHash: string | null; secretBlocked: boolean }> {
  const runner = deps.sessionId && deps.runnerRegistry
    ? deps.runnerRegistry.get(deps.sessionId)
    : null;

  // Always cancel any pending debounced push — agentCreatePr pushes
  // synchronously below, so the timer would only produce a duplicate event.
  runner?.clearPushTimer();

  const summary = runner?.turnSummary?.split("\n")[0]?.slice(0, 120) || "Agent turn";
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

  // Resolve base branch. A re-armed branch keeps the prior PR's base unless the
  // caller passed an explicit one.
  let baseBranch = options.base?.trim() || reArmBase;
  if (!baseBranch) {
    const remoteBranches = await git.listRemoteBranches();
    baseBranch = remoteBranches.includes("main") ? "main" :
      remoteBranches.includes("master") ? "master" :
      remoteBranches[0] ?? "main";
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
  const trimmed = body.trim();
  if (!trimmed) throw new ServiceError(400, "Comment body is required");

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
 * Read a single PR's details. When `number` is omitted, returns the open PR
 * for the current branch (or null when there is none).
 */
export async function viewPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { number?: number; remoteUrl?: string } = {},
): Promise<{
  url: string; number: number; base: string; head: string;
  title: string; body: string;
  state: "open" | "closed"; isDraft: boolean; merged: boolean;
  additions: number; deletions: number;
} | null> {
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
  return githubAuthManager.viewPullRequest(remote.owner, remote.repo, prNumber);
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

/** Generate a conversation-aware PR description. */
async function generatePrDescriptionFromContext(
  git: GitManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: (prompt: string, cwd: string) => Promise<string>,
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

    return await generateText(prompt, sessionDir);
  } catch (err) {
    console.warn("[pr] Failed to generate description:", err);
    // Fallback to basic description
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
