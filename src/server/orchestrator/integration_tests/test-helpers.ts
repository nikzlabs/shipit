/**
 * Shared test helpers for integration tests.
 *
 * Provides TestClient (message-buffering WebSocket wrapper), stub/fake
 * implementations of external dependencies, and the waitForClaude() poll
 * helper used across all integration test files.
 */

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { WsServerMessage, WsClientMessage } from "../../shared/types.js";
import type { SessionManager } from "../sessions.js";
import { GitManager } from "../../shared/git.js";
import { DatabaseManager } from "../../shared/database.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";

// ---------------------------------------------------------------------------
// TestClient
// ---------------------------------------------------------------------------

/**
 * WebSocket test client that buffers all incoming messages from the moment
 * the connection opens. This avoids the race condition where the server sends
 * a message (e.g. preview_status) before the test sets up a listener.
 *
 * Usage:
 *   const client = await TestClient.connect(port);       // auto-creates session
 *   const client = await TestClient.connect(port, sid);  // connect to existing session
 *   const msg = await client.receive();   // first buffered or next message
 *   client.send({ type: "send_message", text: "hello" });
 *   const resp = await client.receive();
 *   client.close();
 */
export class TestClient {
  private ws: WebSocket;
  private queue: WsServerMessage[] = [];
  private waiters: ((msg: WsServerMessage) => void)[] = [];
  /** The session ID this client is connected to. */
  public readonly sessionId: string;

  private constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    ws.on("message", (data: WebSocket.Data) => {
      const msg = JSON.parse((data as Buffer).toString()) as WsServerMessage;
      // Auto-skip informational messages that tests don't care about.
      //
      // `clear_logs` is sent by the server at the start of every WS connect so
      // reconnecting viewers replace their local terminal state with the
      // server log buffer (otherwise the buffer replay duplicates entries on
      // top of the entries the client already has). Tests don't need to see
      // it — auto-skip so existing receive-order assertions still hold.
      if (msg.type === "compose_not_configured") return;
      if (msg.type === "clear_logs") return;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  /**
   * Connect to a per-session WebSocket.
   * If sessionId is provided, connects to /ws/sessions/:id directly.
   * If not, creates a new session via the test-only POST /api/_test/sessions endpoint.
   */
  static async connect(port: number, sessionId?: string): Promise<TestClient> {
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
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`);
      // Create client before open so message listener is attached early
      const client = new TestClient(ws, sessionId);
      ws.on("open", () => resolve(client));
      ws.on("error", reject);
    });
  }

  /** Get the next message — returns from buffer or waits for one. */
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
        // Remove the stale waiter so it doesn't consume future messages
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`TestClient.receive() timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Collect exactly N messages. */
  async receiveN(count: number): Promise<WsServerMessage[]> {
    const msgs: WsServerMessage[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push(await this.receive());
    }
    return msgs;
  }

  /** Get the next message that is NOT a log_entry or agent_event — useful for tests that predate the terminal and multi-agent features. */
  async receiveSkipLogs(timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("receiveSkipLogs() timed out");
      const msg = await this.receive(remaining);
      if (msg.type !== "log_entry" && msg.type !== "agent_event") return msg;
    }
  }

  /** Keep receiving until a message of the given type arrives (skips intermediate messages). */
  async receiveType(type: string, timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`receiveType("${type}") timed out`);
      const msg = await this.receive(remaining);
      if (msg.type === type) return msg;
    }
  }

  /** Send a typed client message. */
  send(msg: WsClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Send raw string data (for invalid-JSON tests). */
  sendRaw(data: string): void {
    this.ws.send(data);
  }

  /** Close the connection. */
  close(): void {
    this.ws.close();
  }

  get readyState(): number {
    return this.ws.readyState;
  }
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Stub AuthManager that never spawns a process.
 * checkCredentials() always returns false.
 */
export class StubAuthManager extends EventEmitter {
  authenticated = true; // Tests assume auth is already done
  checkCredentials() { return true; }
  startOAuthFlow() { /* no-op */ }
  sendCode(_code: string) { /* no-op */ }
  kill() { /* no-op */ }
}

/**
 * Stub GitHubAuthManager for testing GitHub auth flow.
 * Does not make real API calls or touch the filesystem.
 */
export class StubGitHubAuthManager extends EventEmitter {
  private _authenticated = false;
  private _username: string | null = null;
  checkCredentials() { return this._authenticated; }
  get authenticated() { return this._authenticated; }
  getStatus() {
    return {
      authenticated: this._authenticated,
      username: this._username ?? undefined,
      avatarUrl: undefined,
    };
  }
  async setToken(token: string) {
    if (!token.trim()) {
      this.emit("auth_failed", "Token cannot be empty");
      return false;
    }
    // Accept any non-empty token in tests
    this._authenticated = true;
    this._username = "test-user";
    this.emit("auth_complete");
    return true;
  }
  clearCredentials() {
    this._authenticated = false;
    this._username = null;
  }
  /**
   * Mirrors `GitHubAuthManager.markTokenInvalid` — called by the
   * orchestrator when a git push/fetch surfaces "Authentication failed".
   * No-op when no token is configured (matches the real implementation's
   * guard so tests running without auth don't trip an unexpected emit).
   *
   * Async to match the real signature — the production version verifies
   * the token against `GET /user` before clearing, so callers must await.
   * The stub has no network call and resolves synchronously.
   */
  async markTokenInvalid(reason: string): Promise<boolean> {
    if (!this._authenticated) return false;
    this.clearCredentials();
    this.emit("token_invalid", { reason });
    return true;
  }
  configureGitCredentials() { /* no-op */ }
  getAuthenticatedCloneUrl(url: string) { return url; }
  async loadUserInfo() { /* no-op */ }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createRepo(name: string, options: { description?: string; isPrivate?: boolean } = {}) {
    return {
      success: true,
      name,
      fullName: `test-user/${name}`,
      url: `https://github.com/test-user/${name}`,
      cloneUrl: `https://github.com/test-user/${name}.git`,
    };
  }

  /** Calls to `createPullRequest`, in order. Inspect from tests. */
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

  async mergePullRequest(_owner: string, _repo: string, _pullNumber: number, _method = "merge") {
    return this._mergeResult ?? { success: true, message: "Pull request merged" };
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

  // ---- Test control methods ----

  private _prData: { url: string; number: number; base: string; title: string; body: string } | null = null;
  private _mergeResult: { success: boolean; message: string } | null = null;
  private _checkStatus: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number } | null = null;

  /** Set what findPullRequest returns for tests. `body` defaults to "". */
  setPrData(data: { url: string; number: number; base: string; title: string; body?: string } | null) {
    this._prData = data === null ? null : { ...data, body: data.body ?? "" };
  }

  /** Set what mergePullRequest returns for tests. */
  setMergeResult(result: { success: boolean; message: string } | null) {
    this._mergeResult = result;
  }

  /** Set what getCheckStatus returns for tests. */
  setCheckStatus(status: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number } | null) {
    this._checkStatus = status;
  }

  async graphqlQuery<T>(_query: string, _variables: Record<string, unknown>): Promise<T> {
    return this._graphqlResult as T;
  }

  private _graphqlResult: unknown = null;

  /** Set what graphqlQuery returns for tests. */
  setGraphqlResult(result: unknown) {
    this._graphqlResult = result;
  }

  // ---- Rate-limit state (mirrors the real GitHubAuthManager surface) ----

  private _rateLimit: { limited: boolean; resetAt: number | null; remaining: number | null } = {
    limited: false,
    resetAt: null,
    remaining: null,
  };
  getRateLimitState() {
    return { ...this._rateLimit };
  }
  /** Set the rate-limit state returned by `getRateLimitState`. */
  setRateLimitState(state: { limited: boolean; resetAt: number | null; remaining: number | null }) {
    this._rateLimit = state;
  }

  // ---- REST verify probe ----

  private _findPrAnyStateResult: {
    url: string; number: number; base: string; title: string;
    state: "open" | "closed"; merged_at: string | null;
    additions: number; deletions: number;
  } | null = null;
  async findPullRequestAnyState(_owner: string, _repo: string, _head: string) {
    return this._findPrAnyStateResult;
  }
  /** Set what `findPullRequestAnyState` returns for the poller's REST verify. */
  setFindPrAnyStateResult(result: typeof this._findPrAnyStateResult) {
    this._findPrAnyStateResult = result;
  }
}

/**
 * Fake AgentProcess for testing the send_message flow.
 * The test controls this object: call emit("event", ...) or emit("done", ...)
 * to simulate the real CLI producing output.
 *
 * Tests emit events in raw Claude CLI format (type: "system", "assistant",
 * "result", etc.) for convenience. The emit() override automatically
 * translates them to AgentEvent format (agent_init, agent_assistant,
 * agent_result) — the same translation that ClaudeAdapter performs in
 * production. Events already in AgentEvent format pass through unchanged.
 */
export class FakeClaudeProcess extends EventEmitter {
  public readonly agentId = "claude";
  public readonly capabilities = {
    supportsResume: true,
    supportsImages: true,
    supportsSystemPrompt: true,
    supportsPermissionModes: true,
    supportedPermissionModes: ["auto" as const, "plan" as const, "normal" as const],
    toolNames: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    models: ["claude-sonnet-4-20250514"],
    supportsReview: true,
  };

  public runCalled = false;
  public lastPrompt = "";
  public lastSessionId: string | undefined;
  public lastSystemPrompt: string | undefined;
  public lastImages: { data: string; mediaType: string; filename?: string }[] | undefined;
  public lastCwd: string | undefined;
  public lastPermissionMode: string | undefined;
  public killed = false;
  public interrupted = false;
  public stdinData: string[] = [];

  /** Override emit to auto-translate raw Claude events → AgentEvent. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(eventName: string | symbol, ...args: any[]): boolean {
    if (eventName === "event" && args[0] && typeof args[0] === "object") {
      const raw = args[0] as RawClaudeEvent;
      const mapped = mapClaudeEvent(raw);
      if (mapped) {
        return super.emit("event", mapped);
      }
      // Already an AgentEvent or unrecognized — pass through
      return super.emit("event", raw);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return super.emit(eventName, ...args);
  }

  run(params: { prompt: string; sessionId?: string; systemPrompt?: string; images?: { data: string; mediaType: string; filename?: string }[]; cwd?: string; permissionMode?: string }) {
    this.runCalled = true;
    this.lastPrompt = params.prompt;
    this.lastSessionId = params.sessionId;
    this.lastSystemPrompt = params.systemPrompt;
    this.lastImages = params.images;
    this.lastCwd = params.cwd;
    this.lastPermissionMode = params.permissionMode;
  }

  kill() {
    this.killed = true;
  }

  interrupt() {
    this.interrupted = true;
    // Simulate the process exiting after interrupt (non-zero exit code)
    setTimeout(() => super.emit("done", 1), 10);
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }

  /**
   * Simulate the real Claude CLI emitting a `system/init` event as soon
   * as the process is up — the first event of every turn, before any
   * user-visible output. The orchestrator maps this through
   * `mapClaudeEvent` to an `agent_init` AgentEvent, which triggers the
   * "Agent process started" log entry in agent-listeners.ts. Tests that
   * assert on that log (or rely on `session_started` being broadcast)
   * should call this right after `waitForClaude(...)` returns.
   */
  initSession(sessionId = "test-session") {
    this.emit("event", { type: "system", subtype: "init", session_id: sessionId });
  }

  /**
   * Simulate a normal Claude turn completion: emit a result event then done.
   * This matches the real Claude CLI behavior where a `result` event always
   * precedes process exit on success.
   */
  finish(sessionId = "test-session", code = 0) {
    this.emit("event", { type: "result", subtype: "success", session_id: sessionId });
    super.emit("done", code);
  }
}

/** Shape of raw Claude CLI events used in tests. */
interface RawClaudeEvent {
  type: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  message?: { content?: unknown[] };
  subtype?: string;
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
}

/**
 * Translate raw Claude CLI events to AgentEvent format.
 * Same mapping as ClaudeAdapter.mapEvent() — kept here so tests can emit
 * events in the familiar Claude format without depending on session code.
 * Returns null for events already in AgentEvent format.
 */
function mapClaudeEvent(raw: RawClaudeEvent): Record<string, unknown> | null {
  switch (raw.type) {
    case "system":
      return {
        type: "agent_init",
        agentId: "claude",
        sessionId: raw.session_id,
        model: raw.model,
        tools: raw.tools,
      };
    case "assistant":
      return {
        type: "agent_assistant",
        content: raw.message?.content ?? [],
        parentToolUseId: raw.parent_tool_use_id,
      };
    case "user":
      return {
        type: "agent_tool_result",
        content: raw.message?.content ?? [],
        parentToolUseId: raw.parent_tool_use_id,
      };
    case "result": {
      const u = raw.usage;
      // Mirror ClaudeAdapter: extract real per-turn context from the last
      // iteration's input + cache, and the authoritative context window from
      // `modelUsage[<model>].contextWindow`.
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
      return {
        type: "agent_result",
        status: raw.subtype,
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
        error: raw.subtype === "error" ? raw.result : undefined,
      };
    }
    default:
      // Already an AgentEvent or unrecognized — pass through
      return null;
  }
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a test session with a git-initialized workspace directory.
 * Used by integration tests now that `POST /api/sessions` is removed.
 * @param workspaceDir — the app's workspaceDir (sessions are placed in workspaceDir/sessions/UUID)
 */
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

/**
 * Poll until the most recent FakeClaudeProcess has been started.
 * Replaces fixed `setTimeout(50)` waits which are flaky because
 * `createSessionDir()` adds async I/O overhead (mkdir).
 *
 * @param notInstance — if provided, waits for a DIFFERENT instance
 *   (useful when a previous Claude from another test still has runCalled=true)
 */
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

/**
 * Create a CredentialStore for tests and configure global git identity.
 * Sets GIT_CONFIG_GLOBAL to a temp-dir-scoped file so tests don't
 * interfere with each other or with real config.
 */
export function createTestCredentialStore(tmpDir: string): CredentialStore {
  const credDir = path.join(tmpDir, "credentials");
  initGlobalGitConfig(credDir);
  setGitIdentity("Test User", "test@test.com");
  return new CredentialStore(credDir);
}

/** Create an in-memory DatabaseManager for tests. */
export function createTestDatabaseManager(): DatabaseManager {
  return new DatabaseManager(":memory:");
}
