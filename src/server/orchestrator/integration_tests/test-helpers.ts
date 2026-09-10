import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { WsServerMessage, WsClientMessage } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { GitManager } from "../../shared/git.js";
import { RepoGit } from "../repo-git.js";
import { DatabaseManager } from "../../shared/database.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { repoUrlToHash } from "../git-utils.js";

export class TestClient {
  private ws: WebSocket;
  private queue: WsServerMessage[] = [];
  private waiters: ((msg: WsServerMessage) => void)[] = [];
  public readonly sessionId: string;

  private constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    ws.on("message", (data: WebSocket.Data) => {
      const msg = JSON.parse((data as Buffer).toString()) as WsServerMessage;
      if (msg.type === "compose_not_configured") return;
      if (msg.type === "log_snapshot" && msg.records.length === 0) return;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  static async connect(port: number, sessionId?: string, query?: Record<string, string>): Promise<TestClient> {
    if (!sessionId) {
      const http = await import("node:http");
      const body = JSON.stringify({ title: "Test session" });
      const data = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/_test/sessions`,
          { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (res) => {
            let buf = "";
            res.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
            res.on("end", () => resolve(buf));
          },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      const parsed = JSON.parse(data) as { sessionId: string };
      sessionId = parsed.sessionId;
    }
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}${qs}`);
      // Attach before open to capture messages sent immediately on connection.
      const client = new TestClient(ws, sessionId);
      ws.on("open", () => resolve(client));
      ws.on("error", reject);
    });
  }

  receive(timeoutMs = 3000): Promise<WsServerMessage> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = (msg: WsServerMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`TestClient.receive() timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async receiveN(count: number): Promise<WsServerMessage[]> {
    const msgs: WsServerMessage[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push(await this.receive());
    }
    return msgs;
  }

  async receiveSkipLogs(timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("receiveSkipLogs() timed out");
      const msg = await this.receive(remaining);
      if (msg.type !== "log_append" && msg.type !== "log_snapshot" && msg.type !== "agent_event") return msg;
    }
  }

  async receiveType(type: string, timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`receiveType("${type}") timed out`);
      const msg = await this.receive(remaining);
      if (msg.type === type) return msg;
    }
  }

  async drain(opts: { quietMs?: number; maxMs?: number } = {}): Promise<WsServerMessage[]> {
    const { quietMs = 250, maxMs = 3000 } = opts;
    const messages: WsServerMessage[] = [];
    const hardDeadline = Date.now() + maxMs;
    while (Date.now() < hardDeadline) {
      const wait = Math.min(quietMs, hardDeadline - Date.now());
      try {
        messages.push(await this.receive(wait));
      } catch {
        break;
      }
    }
    return messages;
  }

  /** Wait for the anchor before draining; drain alone can end before slow work emits it. */
  async collectUntil(
    predicate: (msg: WsServerMessage) => boolean,
    opts: { timeoutMs?: number; quietMs?: number } = {},
  ): Promise<WsServerMessage[]> {
    const { timeoutMs = 10_000, quietMs = 250 } = opts;
    const messages: WsServerMessage[] = [];
    const deadline = Date.now() + timeoutMs;
    let matched = false;
    while (!matched && Date.now() < deadline) {
      let msg: WsServerMessage;
      try {
        msg = await this.receive(deadline - Date.now());
      } catch {
        break;
      }
      messages.push(msg);
      if (predicate(msg)) matched = true;
    }
    messages.push(...(await this.drain({ quietMs })));
    return messages;
  }

  send(msg: WsClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}

export class StubAuthManager extends EventEmitter {
  readonly loginId = "anthropic-oauth" as const;
  authenticated = true;
  checkCredentials() { return this.authenticated; }
  startOAuthFlow() { /* no-op */ }
  sendCode(_code: string) { /* no-op */ }
  signOut() { this.authenticated = false; }
  kill() { /* no-op */ }
  start(opts?: { accountId?: string }) {
    this.startOAuthFlow();
    this.activeAccountId = opts?.accountId ?? null;
  }
  cancel() { this.kill(); this.activeAccountId = null; }
  submitCode(_code: string) { /* no-op */ }
  isConfigured() { return this.checkCredentials(); }
  getPendingPayload() { return null; }
  private activeAccountId: string | null = null;
  getActiveAccountId(): string | null { return this.activeAccountId; }
}

export class StubGitHubAuthManager extends EventEmitter {
  private _authenticated = false;
  private _username: string | null = null;
  private _token: string | null = null;
  checkCredentials() { return this._authenticated; }
  get authenticated() { return this._authenticated; }
  getToken(): string | null { return this._token; }
  getStatus() {
    return {
      authenticated: this._authenticated,
      username: this._username ?? undefined,
      avatarUrl: undefined,
    };
  }
  listPullRequestsCalls: { owner: string; repo: string; state: string; limit: number | undefined }[] = [];
  private _listPrFailure: string | null = null;
  setListPrFailure(error: string | null): void { this._listPrFailure = error; }
  async listPullRequests(owner: string, repo: string, state = "open", limit?: number) {
    this.listPullRequestsCalls.push({ owner, repo, state, limit });
    if (this._listPrFailure) return { ok: false as const, error: this._listPrFailure };
    return { ok: true as const, prs: [] };
  }
  async setToken(token: string) {
    if (!token.trim()) {
      this.emit("auth_failed", "Token cannot be empty");
      return false;
    }
    this._authenticated = true;
    this._username = "test-user";
    this._token = token;
    this.emit("auth_complete");
    return true;
  }
  clearCredentials() {
    this._authenticated = false;
    this._username = null;
    this._token = null;
  }
  async markTokenInvalid(reason: string): Promise<boolean> {
    if (!this._authenticated) return false;
    this.clearCredentials();
    this.emit("token_invalid", { reason });
    return true;
  }
  configureGitCredentials() { /* no-op */ }
  async loadUserInfo() { /* no-op */ }

  appTokensEnabled(): boolean { return false; }

  private _canWriteRepo = true;
  setRepoWriteAccess(canWrite: boolean) { this._canWriteRepo = canWrite; }
  async checkRepoWriteAccess(_owner: string, _repo: string): Promise<{ canWrite: boolean; reason?: string }> {
    return this._canWriteRepo
      ? { canWrite: true }
      : { canWrite: false, reason: "the connected account has read-only access" };
  }
  public createRepoCalls: { name: string; options: { description?: string; isPrivate?: boolean; owner?: string } }[] = [];

  async createRepo(name: string, options: { description?: string; isPrivate?: boolean; owner?: string } = {}) {
    this.createRepoCalls.push({ name, options: { ...options } });
    const owner = options.owner ?? "test-user";
    return {
      success: true,
      name,
      fullName: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}`,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
    };
  }

  private _orgs: { login: string; avatarUrl: string }[] = [];
  setOrgs(orgs: { login: string; avatarUrl: string }[]) {
    this._orgs = orgs;
  }
  async listOrgs() {
    if (!this._authenticated) return [];
    return this._orgs;
  }

  public createPullRequestCalls: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }[] = [];

  async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }) {
    this.createPullRequestCalls.push({ ...options });
    if (!this._authenticated) {
      return { success: false, message: "Not authenticated with GitHub" };
    }
    return {
      success: true,
      url: `https://github.com/${options.owner}/${options.repo}/pull/1`,
      number: 1,
    };
  }

  public createIssueCalls: { owner: string; repo: string; title: string; body: string; labels?: string[] }[] = [];
  private _createIssueResult:
    | { success: boolean; url?: string; number?: number; message?: string; scopeError?: boolean }
    | null = null;
  setCreateIssueResult(
    result: { success: boolean; url?: string; number?: number; message?: string; scopeError?: boolean } | null,
  ) {
    this._createIssueResult = result;
  }
  async createIssue(options: { owner: string; repo: string; title: string; body: string; labels?: string[] }) {
    this.createIssueCalls.push({ ...options });
    if (this._createIssueResult) return this._createIssueResult;
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return {
      success: true,
      url: `https://github.com/${options.owner}/${options.repo}/issues/1234`,
      number: 1234,
    };
  }

  async searchRepos(_query: string) {
    return [
      {
        fullName: "test-user/test-repo",
        description: "A test repository",
        private: false,
        defaultBranch: "main",
        cloneUrl: "https://github.com/test-user/test-repo.git",
      },
    ];
  }

  async listUserRepos() {
    if (!this._authenticated) return [];
    return [
      {
        fullName: "test-user/my-project",
        description: "My project",
        private: false,
        defaultBranch: "main",
        cloneUrl: "https://github.com/test-user/my-project.git",
      },
    ];
  }

  async findPullRequest(_owner: string, _repo: string, _head: string) {
    return this._prData;
  }

  private _viewPrResult: {
    url: string; number: number; base: string; head: string; title: string; body: string;
    state: "open" | "closed"; isDraft: boolean; merged: boolean; additions: number; deletions: number;
  } | null = null;
  setViewPrResult(result: typeof this._viewPrResult) {
    this._viewPrResult = result;
  }
  async viewPullRequest(_owner: string, _repo: string, _pullNumber: number) {
    return this._viewPrResult;
  }

  private _viewPrError: string | null = null;
  setViewPrError(error: string | null) {
    this._viewPrError = error;
  }
  async viewPullRequestResult(_owner: string, _repo: string, _pullNumber: number) {
    if (this._viewPrError) return { ok: false as const, error: this._viewPrError };
    return { ok: true as const, pr: this._viewPrResult };
  }

  private _conversationResult: { ok: true; conversation: unknown } | { ok: false; error: string } = {
    ok: true,
    conversation: { comments: [], reviews: [], reviewThreads: [], reviewDecision: null },
  };
  setConversationResult(result: typeof this._conversationResult) {
    this._conversationResult = result;
  }
  async viewPullRequestConversation(_owner: string, _repo: string, _pullNumber: number) {
    return this._conversationResult;
  }

  public addLabelsCalls: { owner: string; repo: string; pullNumber: number; labels: string[] }[] = [];
  private _addLabelsResult: { success: boolean; message?: string } | null = null;
  setAddLabelsResult(result: { success: boolean; message?: string } | null) {
    this._addLabelsResult = result;
  }
  async addLabelsToPullRequest(owner: string, repo: string, pullNumber: number, labels: string[]) {
    this.addLabelsCalls.push({ owner, repo, pullNumber, labels });
    if (this._addLabelsResult) return this._addLabelsResult;
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return { success: true };
  }

  public removeLabelCalls: { owner: string; repo: string; pullNumber: number; label: string }[] = [];
  private _removeLabelResult: { success: boolean; message?: string } | null = null;
  setRemoveLabelResult(result: { success: boolean; message?: string } | null) {
    this._removeLabelResult = result;
  }
  async removeLabelFromPullRequest(owner: string, repo: string, pullNumber: number, label: string) {
    this.removeLabelCalls.push({ owner, repo, pullNumber, label });
    if (this._removeLabelResult) return this._removeLabelResult;
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return { success: true };
  }

  lastIssueComment: { pullNumber: number; body: string } | null = null;
  async addPullRequestComment(_owner: string, _repo: string, pullNumber: number, body: string) {
    this.lastIssueComment = { pullNumber, body };
    return {
      success: true,
      url: `https://github.com/owner/repo/pull/${pullNumber}#issuecomment-1`,
    };
  }

  mergePullRequestCalls: {
    owner: string; repo: string; pullNumber: number; method: string; expectedSha?: string;
  }[] = [];

  async mergePullRequest(
    owner: string, repo: string, pullNumber: number, method = "merge", expectedSha?: string,
  ) {
    this.mergePullRequestCalls.push({
      owner, repo, pullNumber, method, ...(expectedSha ? { expectedSha } : {}),
    });
    return this._mergeResult ?? { success: true, message: "Pull request merged" };
  }

  async mergePullRequestAttempt(
    owner: string, repo: string, pullNumber: number, method = "merge", expectedSha?: string,
  ) {
    this.mergePullRequestCalls.push({
      owner, repo, pullNumber, method, ...(expectedSha ? { expectedSha } : {}),
    });
    if (this._mergeAttempt) return this._mergeAttempt;
    const legacy = this._mergeResult;
    if (legacy && !legacy.success) return { outcome: "refused" as const, message: legacy.message };
    return { outcome: "merged" as const, message: "Pull request merged", mergeCommitSha: "merge-sha" };
  }

  private _mergeAttempt:
    | { outcome: "merged"; message: string; mergeCommitSha: string | null }
    | { outcome: "refused"; message: string }
    | { outcome: "indeterminate"; message: string }
    | null = null;

  setMergeAttempt(attempt: typeof this._mergeAttempt) {
    this._mergeAttempt = attempt;
  }

  private _prByNumber: Record<number, unknown> = {};
  setPullRequestByNumber(number: number, facts: unknown) {
    this._prByNumber[number] = facts;
  }
  async findPullRequestByNumber(_owner: string, _repo: string, pullNumber: number) {
    return (this._prByNumber[pullNumber] ?? null) as never;
  }

  async enableAutoMerge(_owner: string, _repo: string, _pullNumber: number, _method = "MERGE") {
    return { success: true, message: "Auto-merge enabled — PR will merge when checks pass" };
  }

  async disableAutoMerge(_owner: string, _repo: string, _pullNumber: number) {
    return { success: true, message: "Auto-merge disabled" };
  }

  async getCheckStatus(_owner: string, _repo: string, _ref: string) {
    return this._checkStatus ?? { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 };
  }

  private _releaseByTag: {
    name: string; body: string; htmlUrl: string; prerelease: boolean; publishedAt: string | null; tagName: string;
  } | null = null;
  setReleaseByTag(release: {
    name: string; body: string; htmlUrl: string; prerelease: boolean; publishedAt: string | null; tagName: string;
  } | null) {
    this._releaseByTag = release;
  }
  async getReleaseByTag(_owner: string, _repo: string, _tag: string) {
    return this._releaseByTag;
  }

  private _prData: { url: string; number: number; base: string; title: string; body: string } | null = null;
  private _mergeResult: { success: boolean; message: string } | null = null;
  private _checkStatus: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number } | null = null;

  setPrData(data: { url: string; number: number; base: string; title: string; body?: string } | null) {
    this._prData = data === null ? null : { ...data, body: data.body ?? "" };
  }

  setMergeResult(result: { success: boolean; message: string } | null) {
    this._mergeResult = result;
  }

  setCheckStatus(status: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number } | null) {
    this._checkStatus = status;
  }

  async graphqlQuery<T>(query: string, _variables: Record<string, unknown>): Promise<T> {
    if (query.includes("MergeGate")) {
      await this._onMergeGateRead?.();
      return this._mergeGateResult as T;
    }
    return this._graphqlResult as T;
  }

  private _onMergeGateRead: (() => void | Promise<void>) | null = null;
  setOnMergeGateRead(fn: (() => void | Promise<void>) | null) {
    this._onMergeGateRead = fn;
  }

  private _graphqlResult: unknown = null;
  private _mergeGateResult: unknown = null;

  setGraphqlResult(result: unknown) {
    this._graphqlResult = result;
  }

  setMergeGateResult(pr: {
    state?: string;
    isDraft?: boolean;
    reviewDecision?: string | null;
    headRefOid?: string;
    rollupState?: string | null;
    rollupCommitOid?: string;
  } | null, errors?: unknown[]) {
    if (pr === null) {
      this._mergeGateResult = errors ? { errors } : null;
      return;
    }
    const headRefOid = pr.headRefOid ?? "sha-head";
    const rollupState = pr.rollupState === undefined ? "SUCCESS" : pr.rollupState;
    this._mergeGateResult = {
      ...(errors ? { errors } : {}),
      data: {
        repository: {
          pullRequest: {
            state: pr.state ?? "OPEN",
            isDraft: pr.isDraft ?? false,
            reviewDecision: pr.reviewDecision ?? null,
            headRefOid,
            commits: {
              nodes: [{
                commit: {
                  oid: pr.rollupCommitOid ?? headRefOid,
                  statusCheckRollup: rollupState === null ? null : { state: rollupState },
                },
              }],
            },
          },
        },
      },
    };
  }

  private _rateLimit: { limited: boolean; resetAt: number | null; remaining: number | null } = {
    limited: false,
    resetAt: null,
    remaining: null,
  };
  getRateLimitState() {
    return { ...this._rateLimit };
  }
  setRateLimitState(state: { limited: boolean; resetAt: number | null; remaining: number | null }) {
    this._rateLimit = state;
  }

  private _findPrAnyStateResult: {
    url: string; number: number; base: string; title: string; body: string;
    state: "open" | "closed"; merged_at: string | null;
    additions: number; deletions: number;
  } | null = null;
  async findPullRequestAnyState(_owner: string, _repo: string, _head: string) {
    return this._findPrAnyStateResult;
  }
  setFindPrAnyStateResult(result: typeof this._findPrAnyStateResult) {
    this._findPrAnyStateResult = result;
  }

  public reviewThreadReplyCalls: { threadId: string; body: string }[] = [];
  public reviewThreadResolveCalls: { threadId: string }[] = [];
  public reviewThreadUnresolveCalls: { threadId: string }[] = [];
  public submitPullRequestReviewCalls: {
    pullRequestId: string;
    comments: { path: string; line: number; body: string; side?: "LEFT" | "RIGHT" }[];
    body?: string;
  }[] = [];

  private _reviewThreadResult: { success: boolean; message: string } = {
    success: true,
    message: "ok",
  };
  private _pullRequestNodeId: string | null = "PR_node_1";

  setReviewThreadResult(result: { success: boolean; message: string }) {
    this._reviewThreadResult = result;
  }

  setPullRequestNodeId(nodeId: string | null) {
    this._pullRequestNodeId = nodeId;
  }

  async addReviewThreadReply(threadId: string, body: string) {
    this.reviewThreadReplyCalls.push({ threadId, body });
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return this._reviewThreadResult;
  }

  async resolveReviewThread(threadId: string) {
    this.reviewThreadResolveCalls.push({ threadId });
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return this._reviewThreadResult;
  }

  async unresolveReviewThread(threadId: string) {
    this.reviewThreadUnresolveCalls.push({ threadId });
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return this._reviewThreadResult;
  }

  async getPullRequestNodeId(_owner: string, _repo: string, _pullNumber: number) {
    if (!this._authenticated) return null;
    return this._pullRequestNodeId;
  }

  async submitPullRequestReview(
    pullRequestId: string,
    comments: { path: string; line: number; body: string; side?: "LEFT" | "RIGHT" }[],
    body?: string,
  ) {
    this.submitPullRequestReviewCalls.push({ pullRequestId, comments, body });
    if (!this._authenticated) return { success: false, message: "Not authenticated with GitHub" };
    return this._reviewThreadResult;
  }
}

export class FakeClaudeProcess extends EventEmitter {
  public readonly agentId = "claude";
  public readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: ["auto" as const, "plan" as const, "guarded" as const],
    toolNames: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    models: ["claude-sonnet-4-20250514"],
    supportsReview: true,
    supportsSteering: false,
    supportsCompaction: false,
    skillsDirName: ".claude",
    skillInvocationPrefix: "/",
  };

  public runCalled = false;
  public lastPrompt = "";
  public lastSessionId: string | undefined;
  public lastSystemPrompt: string | undefined;
  public lastImages: { data: string; mediaType: string; filename?: string }[] | undefined;
  public lastCwd: string | undefined;
  public lastPermissionMode: string | undefined;
  public lastUseStreaming = false;
  public lastSettingsPath: string | undefined;
  public lastModel: string | undefined;
  public lastReasoningEffort: string | undefined;
  public lastMcpServers: unknown[] | undefined;
  public lastAutoCreatePr: boolean | undefined;
  public lastServiceRouting: { serviceId: string; billingMode: string; baseUrl: string } | undefined;
  public killed = false;
  public interrupted = false;
  public stdinData: string[] = [];
  public lastCompact: boolean | undefined;
  public compactCalled = false;
  public lastCompactInstructions: string | undefined;
  public readonly isStreaming = false;
  /** Suppress done on interrupt; the test must emit the streaming result. */
  public streamingInterrupt = false;
  public permissionModeCalls: (string | undefined)[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === "event" && args[0] && typeof args[0] === "object") {
      const raw = args[0] as RawClaudeEvent;
      const mapped = mapClaudeEvent(raw);
      if (mapped) {
        return super.emit("event", mapped);
      }
      return super.emit("event", raw);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return super.emit(eventName, ...args);
  }

  run(params: {
    prompt: string;
    sessionId?: string;
    systemPrompt?: string;
    images?: { data: string; mediaType: string; filename?: string }[];
    cwd?: string;
    permissionMode?: string;
    useStreaming?: boolean;
    settingsPath?: string;
    model?: string;
    reasoningEffort?: string;
    mcpServers?: unknown[];
    autoCreatePr?: boolean;
    compact?: boolean;
    serviceRouting?: { serviceId: string; billingMode: string; baseUrl: string };
  }) {
    this.runCalled = true;
    this.lastCompact = params.compact;
    this.lastPrompt = params.prompt;
    this.lastSessionId = params.sessionId;
    this.lastSystemPrompt = params.systemPrompt;
    this.lastImages = params.images;
    this.lastCwd = params.cwd;
    this.lastPermissionMode = params.permissionMode;
    this.lastUseStreaming = params.useStreaming === true;
    this.lastSettingsPath = params.settingsPath;
    this.lastModel = params.model;
    this.lastReasoningEffort = params.reasoningEffort;
    this.lastMcpServers = params.mcpServers;
    this.lastAutoCreatePr = params.autoCreatePr;
    this.lastServiceRouting = params.serviceRouting;
  }

  kill() {
    this.killed = true;
  }

  interrupt() {
    this.interrupted = true;
    if (this.streamingInterrupt) return;
    setTimeout(() => super.emit("done", 1), 10);
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }

  sendUserMessage(text: string) {
    this.writeStdin(text);
  }

  compact(instructions?: string) {
    this.compactCalled = true;
    this.lastCompactInstructions = instructions;
  }

  setPermissionMode(mode: string | undefined) {
    this.permissionModeCalls.push(mode);
  }

  initSession(sessionId = "test-session") {
    this.emit("event", { type: "system", subtype: "init", session_id: sessionId });
  }

  finish(sessionId = "test-session", code = 0) {
    this.emit("event", { type: "result", subtype: "success", session_id: sessionId });
    super.emit("done", code);
  }
}

interface RawClaudeEvent {
  type: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  message?: { content?: unknown[] };
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    iterations?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    }[];
  };
  modelUsage?: Record<string, { contextWindow?: number }>;
  duration_ms?: number;
  result?: string;
  parent_tool_use_id?: string;
  isReplay?: boolean;
  permissionMode?: string;
  permission_denials?: { tool_name: string; tool_use_id?: string; tool_input?: unknown }[];
}

function mapClaudeEvent(raw: RawClaudeEvent): Record<string, unknown> | null {
  switch (raw.type) {
    case "system":
      return {
        type: "agent_init",
        agentId: "claude",
        sessionId: raw.session_id,
        model: raw.model,
        tools: raw.tools,
        permissionMode: raw.permissionMode,
      };
    case "assistant":
      return {
        type: "agent_assistant",
        content: raw.message?.content ?? [],
        parentToolUseId: raw.parent_tool_use_id,
      };
    case "user":
      if (raw.isReplay) {
        const content = raw.message?.content ?? [];
        const text = Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: "text"; text: string } =>
                  typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string",
              )
              .map((b) => b.text)
              .join("")
          : "";
        return { type: "agent_user_replay", text };
      }
      return {
        type: "agent_tool_result",
        content: raw.message?.content ?? [],
        parentToolUseId: raw.parent_tool_use_id,
      };
    case "result": {
      const u = raw.usage;
      // This stateless fake lacks the adapter's latest-assistant fallback for context tokens.
      let contextTokens: number | undefined;
      const lastIter = u?.iterations?.length ? u.iterations[u.iterations.length - 1] : undefined;
      if (lastIter) {
        contextTokens =
          (lastIter.input_tokens ?? 0) +
          (lastIter.cache_read_input_tokens ?? 0) +
          (lastIter.cache_creation_input_tokens ?? 0);
      }
      let contextWindow: number | undefined;
      if (raw.modelUsage) {
        for (const m of Object.values(raw.modelUsage)) {
          if (m?.contextWindow && (!contextWindow || m.contextWindow > contextWindow)) {
            contextWindow = m.contextWindow;
          }
        }
      }
      const errored = raw.is_error === true || (raw.subtype !== undefined && raw.subtype !== "success");
      return {
        type: "agent_result",
        status: errored ? "error" : "success",
        sessionId: raw.session_id,
        cost: raw.total_cost_usd !== null && raw.total_cost_usd !== undefined ? { totalUsd: raw.total_cost_usd } : undefined,
        tokens: u && (u.input_tokens !== undefined || u.output_tokens !== undefined)
          ? {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens,
              cacheWrite: u.cache_creation_input_tokens,
            }
          : undefined,
        contextTokens,
        contextWindow,
        durationMs: raw.duration_ms,
        error: errored ? raw.result : undefined,
        permissionDenials: raw.permission_denials?.length
          ? raw.permission_denials.map((d) => ({
              toolName: d.tool_name,
              toolUseId: d.tool_use_id,
              toolInput: d.tool_input,
            }))
          : undefined,
      };
    }
    default:
      return null;
  }
}


export async function createTestSession(
  sessionManager: SessionManager,
  workspaceDir: string,
  title = "Test session",
): Promise<{ sessionId: string; sessionDir: string }> {
  const sessionId = crypto.randomUUID();
  const sessionsRoot = path.join(workspaceDir, "sessions");
  const sessionDir = path.join(sessionsRoot, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const git = new GitManager(sessionDir);
  await git.init();
  sessionManager.track(sessionId, title, sessionDir);
  return { sessionId, sessionDir };
}

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  label = "condition",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok: boolean;
    try {
      ok = await fn();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForClaude(
  getClaude: () => FakeClaudeProcess | null,
  notInstance?: FakeClaudeProcess | null,
  timeoutMs = 5000,
): Promise<FakeClaudeProcess> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const c = getClaude();
    if (c?.runCalled && c !== notInstance) return c;
    if (Date.now() > deadline) throw new Error("Timed out waiting for ClaudeProcess.run()");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Yield after buildApp and before marking fixture sessions warm, to let startup pruning run.
export async function flushStartupTasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function createTestCredentialStore(tmpDir: string): CredentialStore {
  const credDir = path.join(tmpDir, "credentials");
  initGlobalGitConfig(credDir);
  setGitIdentity("Test User", "test@test.com");
  const store = new CredentialStore(credDir);
  // Default fixtures exercise one-shot completion; streaming tests opt in.
  store.setLiveSteering(false);
  return store;
}

export function createTestDatabaseManager(): DatabaseManager {
  return new DatabaseManager(":memory:");
}

export function getRepoCacheDir(tmpDir: string, repoUrl: string): string {
  return path.join(tmpDir, "repo-cache", repoUrlToHash(repoUrl));
}

// Call after createTestCredentialStore; redirect the logical remote to this local fixture.
export function seedRepoCacheWithLocalBare(opts: {
  tmpDir: string;
  repoUrl: string;
  seedFiles?: Record<string, string>;
}): void {
  const { tmpDir, repoUrl, seedFiles } = opts;
  const repoDir = getRepoCacheDir(tmpDir, repoUrl);
  fs.mkdirSync(repoDir, { recursive: true });
  execSync("git init -b main", { cwd: repoDir, stdio: "ignore" });

  const files: Record<string, string> = { "README.md": "# test\n", ...(seedFiles ?? {}) };
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(repoDir, name), body);
  }
  execSync(
    'git add . && git -c user.email=t@t.com -c user.name=Test commit -m init --no-gpg-sign',
    { cwd: repoDir, stdio: "ignore" },
  );
  execSync(`git remote add origin ${repoUrl}`, { cwd: repoDir, stdio: "ignore" });
  execSync("git update-ref refs/remotes/origin/main HEAD", { cwd: repoDir, stdio: "ignore" });

  const gitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  if (!gitConfigGlobal) {
    throw new Error("GIT_CONFIG_GLOBAL not set — call createTestCredentialStore() first");
  }
  execSync(
    `git config --file "${gitConfigGlobal}" "url.file://${repoDir}/.insteadOf" "${repoUrl}"`,
    { stdio: "ignore" },
  );
}

export function pinGitToLocalTransports(): () => void {
  const origAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
  const origTerminalPrompt = process.env.GIT_TERMINAL_PROMPT;
  process.env.GIT_ALLOW_PROTOCOL = "file";
  process.env.GIT_TERMINAL_PROMPT = "0";
  return () => {
    if (origAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = origAllowProtocol;
    if (origTerminalPrompt === undefined) delete process.env.GIT_TERMINAL_PROMPT;
    else process.env.GIT_TERMINAL_PROMPT = origTerminalPrompt;
  };
}

function isTemplateScaffoldDir(dir: string): boolean {
  return path.basename(dir).startsWith("shipit-template-");
}

let cachedBareFixtureDir: string | null = null;
function templateBareFixture(): string {
  if (cachedBareFixtureDir && fs.existsSync(cachedBareFixtureDir)) return cachedBareFixtureDir;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-bare-fixture-"));
  const workDir = path.join(root, "work");
  const bareDir = path.join(root, "cache.git");
  fs.mkdirSync(workDir);
  execSync("git init -q -b main", { cwd: workDir, stdio: "ignore" });
  fs.writeFileSync(path.join(workDir, "index.html"), "<!doctype html>\n");
  execSync(
    'git add -A && git -c user.email=t@t.com -c user.name=Test commit -q -m "Initial setup" --no-gpg-sign',
    { cwd: workDir, stdio: "ignore" },
  );
  execSync(`git clone -q --bare "${workDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync('git config remote.origin.fetch "+refs/heads/*:refs/heads/*"', { cwd: bareDir, stdio: "ignore" });
  fs.rmSync(workDir, { recursive: true, force: true });
  cachedBareFixtureDir = bareDir;
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  return bareDir;
}

// The copied cache contains fixture files, not the requested template's output.
export function createTemplateRepoGitFactories(): {
  createGitManager: (dir: string) => GitManager;
  createRepoGit: (dir: string) => RepoGit;
} {
  return {
    createGitManager: (dir: string) => {
      const gm = new GitManager(dir);
      gm.push = async () => "pushed (stub)";
      if (isTemplateScaffoldDir(dir)) {
        gm.init = async () => {};
        gm.addRemote = async () => {};
        gm.autoCommit = async () => ({
          commitHash: null,
          conflictedFiles: [],
          rebaseInProgress: false,
          secretFindings: [], unreadable: null,
        });
      }
      return gm;
    },
    createRepoGit: (dir: string) => {
      const rg = new RepoGit(dir);
      rg.fetchCache = async () => {};
      rg.cloneBare = async () => {
        fs.cpSync(templateBareFixture(), dir, { recursive: true });
      };
      return rg;
    },
  };
}
