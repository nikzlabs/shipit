import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { CredentialStore } from "./credential-store.js";
import { getErrorMessage } from "../shared/utils.js";
import { setGitIdentity, setGlobalCredentialHelper, clearGlobalCredentialHelper, CONTAINER_CREDENTIAL_HELPER } from "./git-config.js";
import { GitHubAppTokenMinter, type AppTokenMintResult } from "./github-app-token.js";
import { createRepo as createRepoImpl, listUserRepos as listUserReposImpl, searchRepos as searchReposImpl, checkRepoWriteAccess as checkRepoWriteAccessImpl, listOrgs as listOrgsImpl } from "./github-auth-repos.js";
import { createPullRequest as createPullRequestImpl, findPullRequest as findPullRequestImpl, findPullRequestAnyState as findPullRequestAnyStateImpl, mergePullRequest as mergePullRequestImpl, mergePullRequestAttempt as mergePullRequestAttemptImpl, findPullRequestByNumber as findPullRequestByNumberImpl, enableAutoMerge as enableAutoMergeImpl, disableAutoMerge as disableAutoMergeImpl, updatePullRequest as updatePullRequestImpl, addPullRequestComment as addPullRequestCommentImpl, addLabelsToPullRequest as addLabelsToPullRequestImpl, removeLabelFromPullRequest as removeLabelFromPullRequestImpl, markPullRequestReady as markPullRequestReadyImpl, listPullRequests as listPullRequestsImpl, viewPullRequest as viewPullRequestImpl, viewPullRequestResult as viewPullRequestResultImpl, viewPullRequestConversation as viewPullRequestConversationImpl, getPullRequestNodeId as getPullRequestNodeIdImpl } from "./github-auth-prs.js";
import type { PullRequestDetail, PrConversation, PrListState, ListPullRequestsResult, MergeAttempt, TerminalPrFacts } from "./github-auth-prs.js";
import { getCheckStatus as getCheckStatusImpl, getCheckRunAnnotations as getCheckRunAnnotationsImpl, getJobLogs as getJobLogsImpl } from "./github-auth-checks.js";
import {
  listWorkflowRuns as listWorkflowRunsImpl,
  getWorkflowRun as getWorkflowRunImpl,
  listWorkflowRunJobs as listWorkflowRunJobsImpl,
  listWorkflows as listWorkflowsImpl,
  getWorkflow as getWorkflowImpl,
  rerunWorkflowRun as rerunWorkflowRunImpl,
} from "./github-auth-actions.js";
import type { WorkflowRunSummary, WorkflowJobSummary, WorkflowSummary, RerunWorkflowRunResult } from "./github-auth-actions.js";
import { getReleaseByTag as getReleaseByTagImpl, type ReleaseByTag } from "./github-auth-releases.js";
import { createIssue as createIssueImpl } from "./github-auth-issues.js";
import type { CreateIssueResult } from "./github-auth-issues.js";
import { addReviewThreadReply as addReviewThreadReplyImpl, resolveReviewThread as resolveReviewThreadImpl, unresolveReviewThread as unresolveReviewThreadImpl, submitPullRequestReview as submitPullRequestReviewImpl } from "./github-auth-review-threads.js";
import type { PullRequestReviewThreadDraft } from "./github-auth-review-threads.js";
import { gitArgsWithHooksDisabled } from "../shared/git-hooks-guard.js";
import { gitSpawnOverridesForTree } from "../shared/git-tree-uid.js";

export interface GitHubAuthStatus {
  authenticated: boolean;
  username?: string;
  avatarUrl?: string;
}

export interface GitHubRateLimitState {
  limited: boolean;
  /** Epoch ms when the limit is expected to clear, or `null` if unknown. */
  resetAt: number | null;
  /** Remaining points in the current window, or `null` if unknown. */
  remaining: number | null;
}

export interface GitHubRepoResult {
  success: boolean;
  name?: string;
  fullName?: string;
  url?: string;
  cloneUrl?: string;
  message?: string;
}

export interface GitHubUserInfo {
  username: string;
  avatarUrl: string;
  id: number;
  displayName: string | null;
}

export type GitHubTokenCheck =
  | { status: "valid"; user: GitHubUserInfo }
  | { status: "invalid" }
  | { status: "indeterminate"; detail: string };

export async function checkGitHubToken(token: string): Promise<GitHubTokenCheck> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    });
  } catch (err) {
    return { status: "indeterminate", detail: `network error: ${getErrorMessage(err)}` };
  }
  if (res.ok) {
    const data = (await res.json()) as { login: string; avatar_url: string; id: number; name: string | null };
    return {
      status: "valid",
      user: { username: data.login, avatarUrl: data.avatar_url, id: data.id, displayName: data.name },
    };
  }
  // Only a 401 from /user justifies clearing the token.
  if (res.status === 401) return { status: "invalid" };
  return { status: "indeterminate", detail: `HTTP ${res.status}` };
}

// Use checkGitHubToken before clearing a token; null here includes network errors.
export async function validateGitHubToken(token: string): Promise<GitHubUserInfo | null> {
  const result = await checkGitHubToken(token);
  return result.status === "valid" ? result.user : null;
}

export class GitHubAuthManager extends EventEmitter {
  private _token: string | null = null;
  private _username: string | null = null;
  private _avatarUrl: string | null = null;
  private credentialStore: CredentialStore;
  private workspaceDir: string;
  private appTokenMinter: GitHubAppTokenMinter;
  private _rateLimit: GitHubRateLimitState = {
    limited: false,
    resetAt: null,
    remaining: null,
  };

  constructor(
    workspaceDir: string,
    credentialStore: CredentialStore,
    appTokenMinter: GitHubAppTokenMinter = new GitHubAppTokenMinter(),
  ) {
    super();
    this.workspaceDir = workspaceDir;
    this.credentialStore = credentialStore;
    this.appTokenMinter = appTokenMinter;
  }

  get authenticated(): boolean {
    return this._token !== null;
  }

  // Do not persist the environment fallback: a disk copy would mask token rotation.
  checkCredentials(): boolean {
    const diskToken = this.credentialStore.getGithubToken();
    if (diskToken) {
      this._token = diskToken;
      try { setGlobalCredentialHelper(diskToken); } catch (err) {
        console.error("[github-auth] Failed to install global credential helper on boot:", err);
      }
      return true;
    }
    const envToken = process.env.GITHUB_TOKEN?.trim();
    if (envToken) {
      this._token = envToken;
      try { setGlobalCredentialHelper(envToken); } catch (err) {
        console.error("[github-auth] Failed to install global credential helper on boot (env token):", err);
      }
      return true;
    }
    this._token = null;
    try { clearGlobalCredentialHelper(); } catch { /* nothing to clear */ }
    return false;
  }

  async setToken(token: string): Promise<boolean> {
    const trimmed = token.trim();
    if (!trimmed) {
      this.emit("auth_failed", "Token cannot be empty");
      return false;
    }

    const check = await checkGitHubToken(trimmed);
    if (check.status !== "valid") {
      const message =
        check.status === "invalid"
          ? "Invalid GitHub token"
          : `Couldn't reach GitHub to verify the token (${check.detail}) — check your connection and try again`;
      this.emit("auth_failed", message);
      return false;
    }

    this._token = trimmed;
    this._username = check.user.username;
    this._avatarUrl = check.user.avatarUrl;

    this.credentialStore.setGithubToken(trimmed);

    try { setGlobalCredentialHelper(trimmed); } catch (err) {
      console.error("[github-auth] Failed to install global credential helper:", err);
    }

    this.setGitIdentityFromGitHub(check.user);

    this.emit("auth_complete");
    return true;
  }

  private setGitIdentityFromGitHub(info: { username: string; displayName: string | null; id: number }): void {
    const gitName = info.displayName ?? info.username;
    const gitEmail = `${info.id}+${info.username}@users.noreply.github.com`;
    setGitIdentity(gitName, gitEmail);
  }

  getStatus(): GitHubAuthStatus {
    return {
      authenticated: this._token !== null,
      username: this._username ?? undefined,
      avatarUrl: this._avatarUrl ?? undefined,
    };
  }

  getToken(): string | null {
    return this._token;
  }

  appTokensEnabled(): boolean {
    return this.appTokenMinter.isConfigured();
  }

  async mintRepoScopedToken(owner: string, repo: string): Promise<string | null> {
    return this.appTokenMinter.getRepoToken(owner, repo);
  }

  async mintReadOnlyRepoToken(owner: string, repo: string): Promise<AppTokenMintResult> {
    return this.appTokenMinter.getRepoTokenResult(owner, repo, "read");
  }

  configureGitCredentials(targetDir?: string): void {
    if (!this._token) return;

    const cwd = targetDir ?? this.workspaceDir;
    // Session metadata can outlive a reclaimed checkout.
    if (!existsSync(cwd)) return;
    try {
      execFileSync(
        "git",
        gitArgsWithHooksDisabled(["config", "--replace-all", "credential.helper", CONTAINER_CREDENTIAL_HELPER]),
        { cwd, stdio: "pipe", ...gitSpawnOverridesForTree(cwd) },
      );
    } catch (err) {
      console.error("[github-auth] Failed to configure git credentials:", err);
    }
  }

  clearCredentials(): void {
    this._token = null;
    this._username = null;
    this._avatarUrl = null;
    this.credentialStore.clearGithubToken();
    try { clearGlobalCredentialHelper(); } catch (err) {
      console.error("[github-auth] Failed to clear global credential helper:", err);
    }
  }

  async markTokenInvalid(reason: string): Promise<boolean> {
    const token = this._token;
    if (!token) return false;
    const check = await checkGitHubToken(token);
    if (check.status === "valid") {
      console.warn(
        `[github-auth] Git auth error (${reason}) — but token is still valid for ${check.user.username}; ` +
          `treating as repo-specific (e.g. fine-grained PAT scope), not clearing credentials`,
      );
      return false;
    }
    if (check.status === "indeterminate") {
      console.warn(
        `[github-auth] Git auth error (${reason}) — could not verify token against GitHub ` +
          `(${check.detail}); preserving credentials (likely a transient GitHub outage)`,
      );
      return false;
    }
    console.warn(`[github-auth] GitHub token invalidated (${reason}) — clearing credentials and notifying clients`);
    this.clearCredentials();
    this.emit("token_invalid", { reason });
    return true;
  }

  async createRepo(
    name: string,
    options: { description?: string; isPrivate?: boolean; owner?: string } = {},
  ): Promise<GitHubRepoResult> {
    if (!this._token) {
      return { success: false, message: "Not authenticated with GitHub" };
    }
    return createRepoImpl(this._token, name, options);
  }

  async listOrgs(): Promise<{ login: string; avatarUrl: string }[]> {
    if (!this._token) return [];
    return listOrgsImpl(this._token);
  }

  async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
    if (!this._token) {
      return { success: false, message: "Not authenticated with GitHub" };
    }
    return createPullRequestImpl(this._token, options);
  }

  async createIssue(options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  }): Promise<CreateIssueResult> {
    if (!this._token) {
      return { success: false, message: "Not authenticated with GitHub" };
    }
    return createIssueImpl(this._token, options);
  }

  async listUserRepos(): Promise<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }[]> {
    if (!this._token) return [];
    return listUserReposImpl(this._token);
  }

  async searchRepos(query: string): Promise<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }[]> {
    if (!this._token) return [];
    return searchReposImpl(this._token, query);
  }

  async checkRepoWriteAccess(owner: string, repo: string): Promise<{ canWrite: boolean; reason?: string }> {
    if (!this._token) {
      return { canWrite: false, reason: "GitHub is not connected — cannot verify write access." };
    }
    return checkRepoWriteAccessImpl(this._token, owner, repo);
  }

  async findPullRequest(
    owner: string,
    repo: string,
    head: string,
  ): Promise<{ url: string; number: number; base: string; title: string; body: string } | null> {
    if (!this._token) return null;
    return findPullRequestImpl(this._token, owner, repo, head);
  }

  async findPullRequestAnyState(
    owner: string,
    repo: string,
    head: string,
  ): Promise<{
    url: string; number: number; base: string; title: string; body: string;
    state: "open" | "closed"; merged_at: string | null; merge_commit_sha: string | null;
    head_sha: string | null; additions: number; deletions: number;
  } | null> {
    if (!this._token) return null;
    return findPullRequestAnyStateImpl(this._token, owner, repo, head);
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
    expectedSha?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    const pr = await viewPullRequestImpl(this._token, owner, repo, pullNumber);
    return mergePullRequestImpl(
      this._token,
      owner,
      repo,
      pullNumber,
      method,
      pr?.title,
      pr?.body,
      expectedSha,
    );
  }

  // Recheck authorization after the preparatory GET, immediately before the merge.
  async mergePullRequestAttempt(
    owner: string,
    repo: string,
    pullNumber: number,
    method: "merge" | "squash" | "rebase" = "merge",
    expectedSha?: string,
    beforeSend?: () => string | null,
  ): Promise<MergeAttempt> {
    if (!this._token) return { outcome: "refused", message: "Not authenticated" };
    const pr = await viewPullRequestImpl(this._token, owner, repo, pullNumber);
    const refusal = beforeSend?.();
    if (refusal) return { outcome: "refused", message: refusal };
    return mergePullRequestAttemptImpl(
      this._token, owner, repo, pullNumber, method, pr?.title, pr?.body, expectedSha,
    );
  }

  async findPullRequestByNumber(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<TerminalPrFacts | null> {
    if (!this._token) return null;
    return findPullRequestByNumberImpl(this._token, owner, repo, pullNumber);
  }

  async enableAutoMerge(
    owner: string,
    repo: string,
    pullNumber: number,
    method: "MERGE" | "SQUASH" | "REBASE" = "MERGE",
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return enableAutoMergeImpl(this._token, owner, repo, pullNumber, method);
  }

  async disableAutoMerge(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return disableAutoMergeImpl(this._token, owner, repo, pullNumber);
  }

  async updatePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options: { title?: string; body?: string; state?: "open" | "closed" },
  ): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return updatePullRequestImpl(this._token, owner, repo, pullNumber, options);
  }

  async addPullRequestComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<{ success: boolean; url?: string; message?: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return addPullRequestCommentImpl(this._token, owner, repo, pullNumber, body);
  }

  async addLabelsToPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    labels: string[],
  ): Promise<{ success: boolean; message?: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return addLabelsToPullRequestImpl(this._token, owner, repo, pullNumber, labels);
  }

  async removeLabelFromPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    label: string,
  ): Promise<{ success: boolean; message?: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return removeLabelFromPullRequestImpl(this._token, owner, repo, pullNumber, label);
  }

  async markPullRequestReady(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated" };
    return markPullRequestReadyImpl(this._token, owner, repo, pullNumber);
  }

  async listPullRequests(
    owner: string,
    repo: string,
    state: PrListState = "open",
    limit?: number,
  ): Promise<ListPullRequestsResult> {
    if (!this._token) return { ok: false, error: "Not authenticated with GitHub" };
    return listPullRequestsImpl(this._token, owner, repo, state, limit);
  }

  async viewPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestDetail | null> {
    if (!this._token) return null;
    return viewPullRequestImpl(this._token, owner, repo, pullNumber);
  }

  async viewPullRequestResult(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ ok: true; pr: PullRequestDetail | null } | { ok: false; error: string }> {
    if (!this._token) return { ok: false, error: "Not authenticated with GitHub" };
    return viewPullRequestResultImpl(this._token, owner, repo, pullNumber);
  }

  async viewPullRequestConversation(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ ok: true; conversation: PrConversation } | { ok: false; error: string }> {
    if (!this._token) return { ok: false, error: "Not authenticated with GitHub" };
    return viewPullRequestConversationImpl(this._token, owner, repo, pullNumber);
  }

  async getPullRequestNodeId(owner: string, repo: string, pullNumber: number): Promise<string | null> {
    if (!this._token) return null;
    return getPullRequestNodeIdImpl(this._token, owner, repo, pullNumber);
  }

  async getCheckStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number }> {
    if (!this._token) return { state: "none", total: 0, passed: 0, failed: 0, pending: 0 };
    return getCheckStatusImpl(this._token, owner, repo, ref);
  }

  async getReleaseByTag(owner: string, repo: string, tag: string): Promise<ReleaseByTag | null> {
    if (!this._token) return null;
    return getReleaseByTagImpl(this._token, owner, repo, tag);
  }

  async getCheckRunAnnotations(
    owner: string,
    repo: string,
    checkRunId: number,
  ): Promise<{
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }[]> {
    if (!this._token) return [];
    return getCheckRunAnnotationsImpl(this._token, owner, repo, checkRunId);
  }

  async getJobLogs(
    owner: string,
    repo: string,
    jobId: number,
  ): Promise<string> {
    if (!this._token) return "";
    return getJobLogsImpl(this._token, owner, repo, jobId);
  }

  async listWorkflowRuns(
    owner: string,
    repo: string,
    opts: { workflowFile?: string; branch?: string; status?: string; limit?: number } = {},
  ): Promise<WorkflowRunSummary[]> {
    if (!this._token) return [];
    return listWorkflowRunsImpl(this._token, owner, repo, opts);
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunSummary | null> {
    if (!this._token) return null;
    return getWorkflowRunImpl(this._token, owner, repo, runId);
  }

  async listWorkflowRunJobs(owner: string, repo: string, runId: number): Promise<WorkflowJobSummary[]> {
    if (!this._token) return [];
    return listWorkflowRunJobsImpl(this._token, owner, repo, runId);
  }

  async listWorkflows(owner: string, repo: string): Promise<WorkflowSummary[]> {
    if (!this._token) return [];
    return listWorkflowsImpl(this._token, owner, repo);
  }

  async getWorkflow(owner: string, repo: string, idOrFile: string): Promise<WorkflowSummary | null> {
    if (!this._token) return null;
    return getWorkflowImpl(this._token, owner, repo, idOrFile);
  }

  async rerunWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
    opts: { onlyFailed?: boolean } = {},
  ): Promise<RerunWorkflowRunResult> {
    if (!this._token) return { ok: false, status: 401, message: "Not authenticated with GitHub" };
    return rerunWorkflowRunImpl(this._token, owner, repo, runId, opts);
  }

  async addReviewThreadReply(
    threadId: string,
    body: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return addReviewThreadReplyImpl(this._token, threadId, body);
  }

  async resolveReviewThread(threadId: string): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return resolveReviewThreadImpl(this._token, threadId);
  }

  async unresolveReviewThread(threadId: string): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return unresolveReviewThreadImpl(this._token, threadId);
  }

  async submitPullRequestReview(
    pullRequestId: string,
    comments: PullRequestReviewThreadDraft[],
    body?: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this._token) return { success: false, message: "Not authenticated with GitHub" };
    return submitPullRequestReviewImpl(this._token, pullRequestId, comments, body);
  }

  getRateLimitState(): GitHubRateLimitState {
    return { ...this._rateLimit };
  }

  async graphqlQuery<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
    if (!this._token) return null;

    let res: Response;
    try {
      res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._token}`,
          "Content-Type": "application/json",
          "User-Agent": "ShipIt",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      console.warn("[github-auth] graphqlQuery network error:", err instanceof Error ? err.message : err);
      return null;
    }

    const requestId = res.headers.get("x-github-request-id") ?? undefined;
    const remainingHeader = res.headers.get("x-ratelimit-remaining");
    const resetHeader = res.headers.get("x-ratelimit-reset");
    const retryAfterHeader = res.headers.get("retry-after");

    const remaining = remainingHeader !== null ? Number.parseInt(remainingHeader, 10) : null;
    const resetFromHeader = resetHeader !== null ? Number.parseInt(resetHeader, 10) * 1000 : null;
    const retryAfterMs = retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
      ? Number.parseInt(retryAfterHeader, 10) * 1000
      : null;

    const updatePrev = this._rateLimit;
    const updateState = (next: GitHubRateLimitState): void => {
      this._rateLimit = next;
      if (next.limited !== updatePrev.limited || next.resetAt !== updatePrev.resetAt) {
        this.emit("rate_limit_changed", { ...next });
      }
    };

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      console.warn(
        `[github-auth] graphqlQuery non-2xx: status=${res.status} remaining=${remaining ?? "?"} ` +
        `reset=${resetFromHeader ?? "?"} retryAfter=${retryAfterMs ?? "?"} requestId=${requestId ?? "?"} body=${truncated}`,
      );
      if (res.status === 403 || res.status === 429) {
        const resetAt = retryAfterMs !== null ? Date.now() + retryAfterMs : resetFromHeader;
        updateState({ limited: true, resetAt, remaining });
      } else {
        if (remaining !== null || resetFromHeader !== null) {
          updateState({ limited: this._rateLimit.limited, resetAt: this._rateLimit.resetAt, remaining });
        }
      }
      return null;
    }

    const body = await res.json().catch(() => null) as { data?: unknown; errors?: { type?: string; code?: string; message?: string }[] } | null;
    if (!body) {
      console.warn("[github-auth] graphqlQuery: 2xx with unparseable JSON");
      return null;
    }

    const errors = body.errors ?? [];
    const rateLimited = errors.some((e) =>
      e.type === "RATE_LIMIT" ||
      e.type === "RATE_LIMITED" ||
      e.type === "SECONDARY_RATE_LIMITED" ||
      e.code === "graphql_rate_limit",
    );
    if (rateLimited) {
      console.warn(
        `[github-auth] graphqlQuery RATE_LIMITED: remaining=${remaining ?? "?"} reset=${resetFromHeader ?? "?"} ` +
        `requestId=${requestId ?? "?"} errors=${JSON.stringify(errors)}`,
      );
      updateState({ limited: true, resetAt: resetFromHeader, remaining: remaining ?? 0 });
      return null;
    }

    if (errors.length > 0) {
      console.warn(
        `[github-auth] graphqlQuery 200 with errors: requestId=${requestId ?? "?"} errors=${JSON.stringify(errors)}`,
      );
    }

    updateState({ limited: false, resetAt: null, remaining });
    return body as T;
  }

  async loadUserInfo(): Promise<void> {
    if (!this._token) return;
    const check = await checkGitHubToken(this._token);
    if (check.status === "valid") {
      this._username = check.user.username;
      this._avatarUrl = check.user.avatarUrl;
      this.setGitIdentityFromGitHub(check.user);
    } else if (check.status === "invalid") {
      this.clearCredentials();
    } else {
      console.warn(
        `[github-auth] Could not verify stored GitHub token on load (${check.detail}); ` +
          `keeping credentials (likely a transient GitHub outage)`,
      );
    }
  }
}
