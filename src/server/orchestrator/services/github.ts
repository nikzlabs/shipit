import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { WorkflowRunSummary, WorkflowJobSummary, WorkflowSummary } from "../github-auth-actions.js";
import type { PullRequestDetail, PrConversation, PrListState, ListedPullRequest } from "../github-auth-prs.js";
import type { ChatHistoryManager, PersistedMessage } from "../chat-history.js";
import type { AutoMergeManagedReason, PrAutoMergeError } from "../../shared/types/github-types.js";
import type { PrStatusPoller } from "../pr-status-poller.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { SessionManager } from "../sessions.js";
import { parseGitHubRemote } from "../git-utils.js";
import type { GitRemoteCredentialResolver } from "../../shared/git-remote-credential.js";
import { resolvePrBaseBranch } from "./git.js";
import { ServiceError } from "./types.js";
import { validateNonEmptyString } from "./validation.js";
import { getErrorMessage } from "../validation.js";
import type { GitHubStatus } from "./types.js";
import { logMergePerformed } from "./merge-attribution.js";
import { decideMerge, readMergeObservation } from "./merge-gate.js";
import { formatUnresolvedConflictNotice } from "./conflict-marker-notice.js";
import { formatSecretScanNotice } from "./secret-scan-notice.js";
import { freshenBaseRef } from "./freshen-base-ref.js";
import { formatUnreadableWorkspaceNotice } from "./unreadable-workspace-notice.js";
import { emitNoticePostTurn, persistNoticeUnattached } from "../chat-card-persistence.js";
import type { GenerateText } from "../non-turn-model.js";

/** Repair only local-cache origins. Reads with --repo must not create or replace a push target. */
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

/** Include terminal PRs so a merged branch does not appear PR-less and cause duplicates. */
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

/** Release preflight: check the existing PR's base before agentCreatePr can push to it. */
export async function findBranchPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  head: string,
  remoteUrl?: string,
): Promise<{ number: number; base: string; state: "open" | "closed"; merged: boolean } | null> {
  if (!githubAuthManager.authenticated) return null;
  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return null;
  const pr = await findBranchPr(githubAuthManager, resolved.owner, resolved.repo, head);
  if (!pr) return null;
  return { number: pr.number, base: pr.base, state: pr.state, merged: pr.merged };
}

export {
  fetchCIFailureLogs,
  stripCILogBloat,
  extractErrorLines,
  buildCIFixPrompt,
  triggerCIFix,
} from "./github-ci-fix.js";

export function getGitHubStatus(githubAuthManager: GitHubAuthManager): GitHubStatus {
  return githubAuthManager.getStatus();
}

export async function listGitHubOrgs(
  githubAuthManager: GitHubAuthManager,
): Promise<{ login: string; avatarUrl: string }[]> {
  if (!githubAuthManager.authenticated) return [];
  return githubAuthManager.listOrgs();
}

export async function searchGitHubRepos(
  githubAuthManager: GitHubAuthManager,
  query: string,
) {
  if (!githubAuthManager.authenticated) return [];
  if (!query || query.length < 2) return githubAuthManager.listUserRepos();
  return githubAuthManager.searchRepos(query);
}

export async function getPrStatus(
  githubAuthManager: GitHubAuthManager,
  git: GitManager,
  remoteUrl?: string,
) {
  if (!githubAuthManager.authenticated) return null;

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return null;

  const head = await git.getCurrentBranch();
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
    // The poller fills these fields; this read does not fetch them.
    mergeable: "unknown",
    reviewDecision: "none",
  };
}

export function getGitCredential(
  githubAuthManager: GitHubAuthManager,
  host: string | undefined,
): { username: string; password: string } | null {
  const normalizedHost = (host ?? "").trim().toLowerCase();
  // Never give the GitHub token to an arbitrary remote host.
  if (normalizedHost !== "github.com") return null;
  const token = githubAuthManager.getToken();
  if (!token) return null;
  return { username: "x-access-token", password: token };
}

export async function getRepoScopedGitCredential(
  githubAuthManager: GitHubAuthManager,
  args: { host: string | undefined; owner?: string; repo?: string },
): Promise<{ username: string; password: string } | null> {
  const normalizedHost = (args.host ?? "").trim().toLowerCase();
  if (normalizedHost !== "github.com") return null;

  if (args.owner && args.repo && githubAuthManager.appTokensEnabled()) {
    const minted = await githubAuthManager.mintRepoScopedToken(args.owner, args.repo);
    if (minted) return { username: "x-access-token", password: minted };
    console.warn(
      `[github] App-token mint failed for ${args.owner}/${args.repo}; falling back to PAT for the git credential broker`,
    );
  }
  return getGitCredential(githubAuthManager, args.host);
}

export const REMOTE_CREDENTIAL_DEADLINE_MS = 5_000;

/** Bound App-token minting so it cannot stall post-turn push; fall back to the configured PAT. */
export async function resolveOrchestratorGitRemoteCredential(
  githubAuthManager: GitHubAuthManager,
  args: { host: string | undefined; owner?: string; repo?: string },
  deadlineMs: number = REMOTE_CREDENTIAL_DEADLINE_MS,
): Promise<{ username: string; password: string } | null> {
  const pat = getGitCredential(githubAuthManager, args.host);
  if (!args.owner || !args.repo || !githubAuthManager.appTokensEnabled()) return pat;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => { resolve(TIMED_OUT); }, deadlineMs);
    timer.unref?.();
  });
  try {
    const resolved = await Promise.race([
      getRepoScopedGitCredential(githubAuthManager, args),
      deadline,
    ]);
    if (resolved === TIMED_OUT) {
      console.warn(
        `[github] repo-scoped git credential for ${args.owner}/${args.repo} did not resolve within `
        + `${deadlineMs}ms — using the PAT so the remote operation is not held up`,
      );
      return pat;
    }
    return resolved;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol("credential-deadline");

export function gitRemoteCredentialResolver(
  githubAuthManager: GitHubAuthManager,
): GitRemoteCredentialResolver {
  return (remote) => resolveOrchestratorGitRemoteCredential(githubAuthManager, {
    host: remote.host,
    owner: remote.owner,
    repo: remote.repo,
  });
}

export async function createPullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  title: string,
  body: string,
  base: string,
  draft?: boolean,
  remoteUrl?: string,
): Promise<{
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
  owner: string;
  repo: string;
}> {
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
  return {
    success: result.success,
    url: result.url,
    number: result.number,
    message: result.message,
    owner: resolved.owner,
    repo: resolved.repo,
  };
}

/** The caller records managed auto-merge state when a pending-check response requests it. */
export async function mergePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  method: string | undefined,
  remoteUrl: string | undefined,
  opts: { preferManaged?: boolean; sessionId: string },
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean; managed?: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) return { success: false, message: resolved.error };

  const head = await git.getCurrentBranch();
  const pr = await githubAuthManager.findPullRequest(resolved.owner, resolved.repo, head);
  if (!pr) return { success: false, message: "No active PR for current branch" };

  const mergeMethod = (method || "merge") as "merge" | "squash" | "rebase";
  const result = await githubAuthManager.mergePullRequest(resolved.owner, resolved.repo, pr.number, mergeMethod);

  if (result.success) {
    logMergePerformed({
      owner: resolved.owner,
      repo: resolved.repo,
      prNumber: pr.number,
      sessionId: opts.sessionId,
      via: "the ShipIt merge button",
      method: mergeMethod,
    });
    return { success: true, message: "Pull request merged" };
  }

  const checks = await githubAuthManager.getCheckStatus(resolved.owner, resolved.repo, head);
  if (checks.state === "pending") {
    if (opts.preferManaged) {
      return {
        success: true,
        message: "Checks are still running — ShipIt will merge this PR once they pass and this session finishes.",
        autoMergeEnabled: true,
        managed: true,
      };
    }
    const graphqlMethod = mergeMethod === "merge" ? "MERGE" as const : mergeMethod === "squash" ? "SQUASH" as const : "REBASE" as const;
    const autoResult = await githubAuthManager.enableAutoMerge(resolved.owner, resolved.repo, pr.number, graphqlMethod);
    return { success: autoResult.success, message: autoResult.message, autoMergeEnabled: autoResult.success };
  }

  return { success: false, message: result.message };
}

export async function agentMergePullRequest(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  opts: {
    number: number;
    sessionId: string;
    method?: string;
    auto?: boolean;
    remoteUrl?: string;
    repoBound?: boolean;
    localHead?: { kind: "head"; sha: string } | { kind: "unreadable"; reason: string };
    graceSaysWait?: (headSha: string) => Promise<boolean>;
    /** Recheck authorization and persist the claim immediately before the merge call. */
    beforeMerge?: (expectedSha: string) => string | null;
    onMerged?: (expectedSha: string) => Promise<"settled" | "deferred">;
    onRefused?: (expectedSha: string) => Promise<void>;
    /** Keep the claim until reconciliation resolves the uncertain outcome. */
    onIndeterminate?: (expectedSha: string) => Promise<void>;
    onArm?: (expectedSha: string) => string | null;
  },
): Promise<{ success: boolean; message: string; autoMergeEnabled?: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, opts.remoteUrl);
  if ("error" in resolved) return { success: false, message: resolved.error };

  const { owner, repo } = resolved;
  const mergeMethod = (opts.method || "merge") as "merge" | "squash" | "rebase";

  const arming = opts.auto === true && opts.repoBound === true;

  const observation = await readMergeObservation(githubAuthManager, owner, repo, opts.number);

  const decision = await decideMerge({
    observation,
    prNumber: opts.number,
    ...(arming ? { arming: true } : {}),
    localHead: opts.repoBound ? (opts.localHead ?? { kind: "unreadable", reason: "no local commit was supplied" }) : { kind: "sandbox" },
    graceSaysWait: async () => {
      if (!opts.graceSaysWait || observation.kind !== "read") return false;
      return opts.graceSaysWait(observation.headRefOid);
    },
  });

  if (decision.action === "already-merged") {
    return { success: true, message: `PR #${opts.number} is already merged` };
  }

  // Repo-bound --auto records an exact-commit request, even when checks are already green.
  if (decision.action === "arm") {
    const refusal = opts.onArm?.(decision.sha);
    if (refusal) return { success: false, message: refusal };
    return {
      success: true,
      message:
        `ShipIt will merge PR #${opts.number} at ${decision.sha.slice(0, 8)} once its checks pass. `
        + "It merges that exact commit — pushing again cancels the request, and so does withdrawing "
        + "the repository's merge permission. The result appears in this session's transcript.",
      autoMergeEnabled: true,
    };
  }

  if (decision.action === "refuse") {
    if (decision.reason === "checks-pending" && opts.auto && !opts.repoBound) {
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
      };
    }
    if (decision.reason === "checks-pending" && !opts.repoBound) {
      return {
        success: false,
        message: `${decision.message} Or pass --auto to merge when checks pass.`,
      };
    }
    return { success: false, message: decision.message };
  }

  // No await between the final authorization/claim and the merge request.
  const refusal = opts.beforeMerge?.(decision.sha);
  if (refusal) return { success: false, message: refusal };

  // GitHub rejects atomically if the examined head has moved.
  const attempt = await githubAuthManager.mergePullRequestAttempt(
    owner, repo, opts.number, mergeMethod, decision.sha,
  );

  if (attempt.outcome === "indeterminate") {
    await opts.onIndeterminate?.(decision.sha);
    return { success: false, message: attempt.message };
  }
  if (attempt.outcome === "refused") {
    await opts.onRefused?.(decision.sha);
    return { success: false, message: attempt.message };
  }

  logMergePerformed({
    owner,
    repo,
    prNumber: opts.number,
    sessionId: opts.sessionId,
    via: "gh pr merge",
    method: mergeMethod,
  });
  // Settle before the next branch-reset call can inspect local merge state.
  const settlement = await opts.onMerged?.(decision.sha);
  if (settlement === "deferred") {
    return {
      success: true,
      message:
        `Merged PR #${opts.number} — but ShipIt could not finish recording it, so this session's `
        + "state may not show the merge yet. Wait a moment before running "
        + "`shipit branch reset-to-base`; ShipIt retries the recording on its own.",
    };
  }
  return { success: true, message: `Merged PR #${opts.number}` };
}

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
  const trimmed = description.trim();
  if (trimmed) return { description: trimmed };
  console.warn("[pr] Description generation returned nothing; using the generic fallback");
  return { description: await basicPrDescription(git) };
}

export async function quickCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  chatHistoryManager: ChatHistoryManager,
  generateText: GenerateText,
  sessionId: string,
  sessionTitle: string,
  sessionDir: string,
  remoteUrl?: string,
  /** Caller-gated recovery for a rewritten branch whose old remote may survive. */
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
  /** Discovering a PR does not establish that this session created it. */
  alreadyExisted: boolean;
  owner: string;
  repo: string;
}> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  const head = await git.getCurrentBranch();

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
      alreadyExisted: true,
      owner: resolved.owner,
      repo: resolved.repo,
    };
  }

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

  let baseBranch = reArm?.baseBranch?.trim();
  if (!baseBranch) {
    baseBranch = await resolvePrBaseBranch(git, await git.listRemoteBranches());
  }

  const title = sessionTitle || head;

  const description = await generatePrDescriptionFromContext(
    git, chatHistoryManager, generateText, sessionId, baseBranch, sessionDir,
  );

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
    alreadyExisted: false,
    owner: resolved.owner,
    repo: resolved.repo,
  };
}

/** Read live: the poller's snapshot may still describe a previous merged PR. */
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

/** Label failures are warnings; the PR operation has already succeeded. */
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

/** Only committed and nothing-to-commit confirm that the whole tree is on the branch. */
export type TurnCommitFlush =
  | { kind: "committed"; commitHash: string }
  | { kind: "nothing-to-commit" }
  | { kind: "blocked-secret" }
  | { kind: "blocked-unreadable" }
  | { kind: "blocked-conflict"; conflictedFiles: string[]; rebaseInProgress: boolean }
  | { kind: "partial-unreadable"; commitHash: string | null };

export async function flushPendingTurnCommit(
  git: GitManager,
  deps: {
    sessionId?: string;
    runnerRegistry?: SessionRunnerRegistry;
    chatHistory?: { append(sessionId: string, message: PersistedMessage): unknown };
    /** Outside-turn callers must override the previous turn's summary. */
    summary?: string;
  },
): Promise<TurnCommitFlush> {
  const runner = deps.sessionId && deps.runnerRegistry
    ? deps.runnerRegistry.get(deps.sessionId)
    : null;

  const summary =
    deps.summary?.split("\n")[0]?.slice(0, 120)
    || runner?.turnSummary?.split("\n")[0]?.slice(0, 120)
    || "Agent turn";
  const parentHash = await git.getHeadHash();
  const { commitHash, conflictedFiles, rebaseInProgress, secretFindings, unreadable } =
    await git.autoCommit(summary);
  const secretBlocked = secretFindings.length > 0;
  if (unreadable) {
    const message = formatUnreadableWorkspaceNotice(unreadable, {
      committed: commitHash !== null,
      what: "This work",
    });
    // A late consult can outlive its runner; persist its notice without one.
    if (deps.chatHistory && deps.sessionId) {
      if (runner) {
        emitNoticePostTurn((m) => runner.emitMessage(m), deps.chatHistory, deps.sessionId, message, "warn");
      } else {
        persistNoticeUnattached(deps.chatHistory, deps.sessionId, message, "warn");
      }
    } else {
      runner?.emitMessage({ type: "system_notice", sessionId: runner.sessionId, level: "warn", message });
    }
  }
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
  const unreadableBlocked = unreadable?.kind === "blocked";

  if (commitHash) {
    if (runner && parentHash) {
      // Link after history rows are final; in-progress rows can be replaced.
      runner.pendingCommitLink = { commitHash, parentCommitHash: parentHash };
    }
    runner?.emitMessage({ type: "git_committed", hash: commitHash, message: summary });
  }

  // Preserve this precedence if failures overlap.
  if (secretBlocked) return { kind: "blocked-secret" };
  if (unreadableBlocked) return { kind: "blocked-unreadable" };
  if (conflictedFiles.length > 0 || rebaseInProgress) {
    return { kind: "blocked-conflict", conflictedFiles, rebaseInProgress };
  }
  if (unreadable) return { kind: "partial-unreadable", commitHash };
  if (!commitHash) return { kind: "nothing-to-commit" };
  return { kind: "committed", commitHash };
}

export async function agentCreatePr(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: {
    title?: string;
    body?: string;
    base?: string;
    draft?: boolean;
    fill?: boolean;
    labels?: string[];
    sessionTitle?: string;
    remoteUrl?: string;
    sessionId?: string;
    runnerRegistry?: SessionRunnerRegistry;
    /** Cancel only after a synchronous push has replaced the scheduled push. */
    cancelAutoPush?: (sessionId: string) => void;
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
  /** Resolved destination, which --repo can override. */
  owner: string;
  repo: string;
  alreadyExistedReason?: "open" | "merged-not-progressed" | "closed-not-progressed";
  notProgressedBecause?: "base-not-contained" | "no-new-work" | "base-unknown" | "fetch-failed";
  labelWarning?: string;
}> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const resolved = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in resolved) throw new ServiceError(400, resolved.error);

  // Mid-turn PR creation must include edits not yet committed by post-turn work.
  const flush = await flushPendingTurnCommit(git, {
    sessionId: options.sessionId,
    runnerRegistry: options.runnerRegistry,
    ...(options.chatHistory ? { chatHistory: options.chatHistory } : {}),
  });
  if (flush.kind === "blocked-secret") {
    throw new ServiceError(
      422,
      "Refused to create the PR: a likely secret was found in the staged changes, so they were not committed. " +
        "Remove the secret (use an env var / ShipIt secret) — or add a `gitleaks:allow` comment to the line if it's a false positive — then try again.",
    );
  }
  if (flush.kind === "blocked-unreadable") {
    throw new ServiceError(
      422,
      "Refused to create the PR: ShipIt could not read part of the workspace, so `git add` staged "
        + "nothing and this turn's changes are not committed. Fix that path's permissions (or "
        + "gitignore it — a compose service running as its own `user:` is the usual cause), then "
        + "try again. The chat transcript names the exact path.",
    );
  }

  const head = await git.getCurrentBranch();

  // Leave the scheduled push armed on paths that return without pushing.
  const { sessionId, cancelAutoPush } = options;
  const dropPendingAutoPush = (): void => {
    if (sessionId) cancelAutoPush?.(sessionId);
  };

  // Reuse an open PR; require new work on the current base to replace a terminal PR.
  const existingPr = await findBranchPr(githubAuthManager, resolved.owner, resolved.repo, head);
  let reArmBase: string | undefined;
  let reArmedPastDeadPr = false;
  if (existingPr) {
    const returnExistingPr = async (
      alreadyExistedReason: "open" | "merged-not-progressed" | "closed-not-progressed",
      notProgressedBecause?: "base-not-contained" | "no-new-work" | "base-unknown" | "fetch-failed",
    ) => {
      const stats = await git.diffStatVsBranch(existingPr.base);
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
        owner: resolved.owner,
        repo: resolved.repo,
        alreadyExistedReason,
        ...(notProgressedBecause ? { notProgressedBecause } : {}),
        labelWarning,
      };
    };

    if (existingPr.state === "open") {
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
      dropPendingAutoPush();
      return await returnExistingPr("open");
    }

    // A stale base ref can make already-shipped work appear new. Fetch before checking.
    const baseRefIsFresh = await freshenBaseRef(
      git, existingPr.base, `pr-create ${options.sessionId ?? head}`,
    );
    const progress = baseRefIsFresh
      ? await git.mergedBaseProgress(existingPr.base)
      : ("fetch-failed" as const);
    // A deleted prior base must not block creation against an explicit or default base.
    if (progress !== "progressed" && progress !== "base-unknown") {
      return await returnExistingPr(
        existingPr.merged ? "merged-not-progressed" : "closed-not-progressed",
        progress,
      );
    }
    if (progress === "progressed") reArmBase = existingPr.base;
    reArmedPastDeadPr = true;
  }

  // The remote branch can retain old commits after a merged session returns to base.
  try {
    if (reArmedPastDeadPr) {
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
  dropPendingAutoPush();

  let baseBranch = options.base?.trim() || reArmBase;
  if (!baseBranch) {
    baseBranch = await resolvePrBaseBranch(git, await git.listRemoteBranches());
  }

  const title = options.title?.trim() || options.sessionTitle || head;
  if (!title) throw new ServiceError(400, "PR title is required");
  if (title.length > 256) throw new ServiceError(400, "PR title too long (max 256 characters)");

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
    owner: resolved.owner,
    repo: resolved.repo,
    labelWarning,
  };
}

/** Label removals win when a label appears in both lists, matching gh. */
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
    url = resolved.pr?.url ?? `https://github.com/${resolved.owner}/${resolved.repo}/pull/${prNumber}`;
    number = prNumber;
  }

  const warnings: string[] = [];
  const addWarning = await applyPrLabels(githubAuthManager, resolved.owner, resolved.repo, prNumber, addLabels);
  if (addWarning) warnings.push(addWarning);
  const removeWarning = await removePrLabels(githubAuthManager, resolved.owner, resolved.repo, prNumber, removeLabels);
  if (removeWarning) warnings.push(removeWarning);

  return { number, url, labelWarning: warnings.length > 0 ? warnings.join("\n") : undefined };
}

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

export async function addIssueComment(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  body: string,
  options: { remoteUrl?: string } = {},
): Promise<{ number: number; commentUrl: string }> {
  return commentOnPullRequest(git, githubAuthManager, body, { remoteUrl: options.remoteUrl });
}

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

export type PullRequestView =
  & PullRequestDetail
  & Partial<PrConversation>
  & { conversationError?: string };

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
    const pr = await findBranchPr(githubAuthManager, remote.owner, remote.repo, head);
    if (!pr) return null;
    prNumber = pr.number;
  }
  // Keep lookup failures distinct from an absent PR.
  const read = await githubAuthManager.viewPullRequestResult(remote.owner, remote.repo, prNumber);
  if (!read.ok) throw new ServiceError(502, `Failed to read PR #${prNumber}: ${read.error}`);
  const pr = read.pr;
  if (!pr || options.comments !== true) return pr;

  // A failed conversation fetch must not look like an empty conversation.
  const conversation = await githubAuthManager.viewPullRequestConversation(
    remote.owner, remote.repo, prNumber,
  );
  if (!conversation.ok) return { ...pr, conversationError: conversation.error };
  return { ...pr, ...conversation.conversation };
}

export async function listPullRequests(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { state?: PrListState; limit?: number; remoteUrl?: string } = {},
): Promise<ListedPullRequest[]> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);
  const read = await githubAuthManager.listPullRequests(
    remote.owner, remote.repo, options.state ?? "open", options.limit,
  );
  if (!read.ok) throw new ServiceError(502, `Failed to list pull requests: ${read.error}`);
  return read.prs;
}

const RUN_LOG_TAIL_LINES = 200;
const RUN_LOG_MAX_CHARS = 50_000;

const FAILED_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);

function isDirectWorkflowRef(ref: string): boolean {
  return /^\d+$/.test(ref) || /\.ya?ml$/i.test(ref);
}

function lastLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

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

// Exclude manually dispatched and scheduled runs; retry only CI that pushes can trigger.
const RERUNNABLE_RUN_EVENTS = new Set(["push", "pull_request"]);

/** Require matching branch, commit, and event; each check excludes a different out-of-scope run. */
export async function rerunWorkflowRun(
  git: GitManager,
  githubAuthManager: GitHubAuthManager,
  options: { runId?: number; onlyFailed?: boolean; remoteUrl?: string } = {},
): Promise<{ run: WorkflowRunSummary; onlyFailed: boolean }> {
  if (!githubAuthManager.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");
  const remote = await resolveGitHubRemote(git, options.remoteUrl);
  if ("error" in remote) throw new ServiceError(400, remote.error);

  // Require an actual branch, with no fallback for detached HEAD.
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

/** A 403 has several possible causes; preserve GitHub's message without asserting one. */
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

  const file = await resolveWorkflowFile(githubAuthManager, remote.owner, remote.repo, ref);
  const workflow = await githubAuthManager.getWorkflow(remote.owner, remote.repo, file);
  if (!workflow) return null;
  const runs = await githubAuthManager.listWorkflowRuns(remote.owner, remote.repo, {
    workflowFile: String(workflow.id),
    limit: 10,
  });
  return { workflow, runs };
}

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
    if (generated.trim()) return generated;
    console.warn("[pr] Description generation returned nothing; using the generic fallback");
    return await basicPrDescription(git);
  } catch (err) {
    console.warn("[pr] Failed to generate description:", err);
    return await basicPrDescription(git);
  }
}

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

// Do not restore arming after an awaited call outlives the PR.
// Match the number: the poller can still hold an older, terminal PR.
function prWentTerminalDuringCall(
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  prNumber: number,
): boolean {
  const current = prStatusPoller.getStatus(sessionId);
  if (current?.prNumber !== prNumber) return false;
  return current.prState === "merged" || current.prState === "closed";
}

function branchIsUnsynced(prStatusPoller: PrStatusPoller, sessionId: string): boolean {
  const state = prStatusPoller.getStatus(sessionId)?.branchSync?.state;
  return state === "ahead" || state === "diverged";
}

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

  // Only the managed loop can wait for work that GitHub cannot see.
  if (prStatusPoller.hasLiveRunner(sessionId)) {
    prStatusPoller.setAutoMergeManaged(sessionId, true, { managedReason: "session-live" });
    return;
  }

  if (branchIsUnsynced(prStatusPoller, sessionId)) {
    prStatusPoller.setAutoMergeManaged(sessionId, true, { managedReason: "branch-unsynced" });
    return;
  }

  const graphqlMethod = GRAPHQL_MERGE_METHOD[autoMergeState.mergeMethod];
  const result = await githubAuth.enableAutoMerge(resolved.owner, resolved.repo, prNumber, graphqlMethod);

  if (prWentTerminalDuringCall(prStatusPoller, sessionId, prNumber)) return;

  if (!result.success) {
    const branchSettingsUrl = `https://github.com/${resolved.owner}/${resolved.repo}/settings/branches`;
    prStatusPoller.setAutoMergeManaged(sessionId, true, { settingsUrl: branchSettingsUrl });
    return;
  }

  prStatusPoller.setAutoMergeEnabled(sessionId, true);
  prStatusPoller.setAutoMergeManaged(sessionId, false);
}

export async function toggleAutoMerge(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  enabled: boolean,
): Promise<{
  enabled: boolean;
  mergeMethod: "squash" | "merge" | "rebase";
  managed?: boolean;
  managedReason?: AutoMergeManagedReason;
  reason?: string;
} | { error: PrAutoMergeError }> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const prStatus = prStatusPoller.getStatus(sessionId);
  if (!prStatus) {
    const state = prStatusPoller.setAutoMergeEnabled(sessionId, enabled);
    return {
      enabled: state.enabled,
      mergeMethod: state.mergeMethod,
      managed: state.managed,
      managedReason: state.managedReason,
    };
  }

  const resolved = parseRepoFromPrUrl(prStatus.prUrl);
  if (!resolved) throw new ServiceError(400, "Cannot parse repository from PR URL");
  const { owner, repo } = resolved;

  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  const mergeMethod = autoMergeState?.mergeMethod ?? "squash";

  if (enabled) {
    if (prStatusPoller.hasLiveRunner(sessionId)) {
      prStatusPoller.setAutoMergeEnabled(sessionId, true);
      prStatusPoller.setAutoMergeManaged(sessionId, true, { managedReason: "session-live" });
      return { enabled: true, mergeMethod, managed: true, managedReason: "session-live" };
    }

    // Hold the merge until the remote branch includes this session's work.
    if (branchIsUnsynced(prStatusPoller, sessionId)) {
      prStatusPoller.setAutoMergeEnabled(sessionId, true);
      prStatusPoller.setAutoMergeManaged(sessionId, true, { managedReason: "branch-unsynced" });
      return { enabled: true, mergeMethod, managed: true, managedReason: "branch-unsynced" };
    }

    const graphqlMethod = GRAPHQL_MERGE_METHOD[mergeMethod];
    const result = await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);

    if (prWentTerminalDuringCall(prStatusPoller, sessionId, prStatus.prNumber)) {
      return { enabled: false, mergeMethod };
    }

    if (!result.success) {
      const settingsUrl = `https://github.com/${owner}/${repo}/settings`;

      prStatusPoller.setAutoMergeEnabled(sessionId, true);
      prStatusPoller.setAutoMergeManaged(sessionId, true, { settingsUrl, reason: result.message });
      return {
        enabled: true,
        mergeMethod,
        managed: true,
        managedReason: "native-unavailable",
        reason: result.message,
      };
    }

    prStatusPoller.setAutoMergeEnabled(sessionId, true);
    return { enabled: true, mergeMethod };
  } else {
    const currentState = prStatusPoller.getAutoMergeState(sessionId);
    if (!currentState?.managed) {
      await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
    }
    if (!prWentTerminalDuringCall(prStatusPoller, sessionId, prStatus.prNumber)) {
      prStatusPoller.setAutoMergeEnabled(sessionId, false);
    }
    return { enabled: false, mergeMethod };
  }
}

export async function updateMergeMethod(
  githubAuth: GitHubAuthManager,
  prStatusPoller: PrStatusPoller,
  sessionId: string,
  method: "squash" | "merge" | "rebase",
): Promise<{ mergeMethod: "squash" | "merge" | "rebase" }> {
  const autoMergeState = prStatusPoller.getAutoMergeState(sessionId);
  prStatusPoller.setMergeMethod(sessionId, method);

  // The managed loop reads this state at merge time; do not arm a second executor.
  if (autoMergeState?.enabled && autoMergeState.managed) return { mergeMethod: method };

  if (autoMergeState?.enabled) {
    const prStatus = prStatusPoller.getStatus(sessionId);
    if (prStatus) {
      const urlMatch = /github\.com\/([^/]+)\/([^/]+)/.exec(prStatus.prUrl);
      if (urlMatch) {
        const [, owner, repo] = urlMatch;
        // A session that became live must move from native to managed merging.
        if (prStatusPoller.hasLiveRunner(sessionId)) {
          await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
          prStatusPoller.setAutoMergeManaged(sessionId, true, { managedReason: "session-live" });
          return { mergeMethod: method };
        }
        await githubAuth.disableAutoMerge(owner, repo, prStatus.prNumber);
        const graphqlMethod = method === "merge" ? "MERGE" as const : method === "squash" ? "SQUASH" as const : "REBASE" as const;
        await githubAuth.enableAutoMerge(owner, repo, prStatus.prNumber, graphqlMethod);
      }
    }
  }

  return { mergeMethod: method };
}

/** Existing workspaces need a credential helper when authentication arrives after creation. */
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

export function gitHubLogout(
  githubAuthManager: GitHubAuthManager,
): { status: GitHubStatus } {
  githubAuthManager.clearCredentials();
  return { status: githubAuthManager.getStatus() };
}
