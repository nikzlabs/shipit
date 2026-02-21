/**
 * Shared test helpers for integration tests.
 *
 * Provides TestClient (message-buffering WebSocket wrapper), stub/fake
 * implementations of external dependencies, and the waitForClaude() poll
 * helper used across all integration test files.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import WebSocket from "ws";
import type { WsServerMessage, WsClientMessage } from "../types.js";
import { CredentialStore } from "../credential-store.js";

// ---------------------------------------------------------------------------
// TestClient
// ---------------------------------------------------------------------------

/**
 * WebSocket test client that buffers all incoming messages from the moment
 * the connection opens. This avoids the race condition where the server sends
 * a message (e.g. preview_status) before the test sets up a listener.
 *
 * Usage:
 *   const client = await TestClient.connect(port);
 *   const msg = await client.receive();   // first buffered or next message
 *   client.send({ type: "list_sessions" });
 *   const resp = await client.receive();
 *   client.close();
 */
export class TestClient {
  private ws: WebSocket;
  private queue: WsServerMessage[] = [];
  private waiters: Array<(msg: WsServerMessage) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: WebSocket.Data) => {
      const msg: WsServerMessage = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  /** Connect to the server and start buffering messages immediately. */
  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      // Create client before open so message listener is attached early
      const client = new TestClient(ws);
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

  /** Get the next message that is NOT a log_entry, agent_event, or session runner status — useful for tests that predate the terminal, multi-agent, and persistent runner features. */
  async receiveSkipLogs(timeoutMs = 3000): Promise<WsServerMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("receiveSkipLogs() timed out");
      const msg = await this.receive(remaining);
      if (msg.type !== "log_entry" && msg.type !== "agent_event"
        && msg.type !== "session_status" && msg.type !== "session_agent_started"
        && msg.type !== "session_agent_finished") return msg;
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
 * Stub ViteManager that never spawns a process.
 * Reports as not running with port 5173 (matching production defaults).
 * @deprecated Use StubPreviewManager instead.
 */
export class StubViteManager extends EventEmitter {
  private _running = false;
  private _port = 5173;
  get running() { return this._running; }
  get port() { return this._port; }
  start() { /* no-op */ }
  stop() { /* no-op */ }
  restart() { /* no-op */ }
}

/**
 * Stub PreviewManager that never spawns a process.
 * Reports as not running with no ports (matching production defaults).
 */
export class StubPreviewManager extends EventEmitter {
  private _running = false;
  private _ports: number[] = [];
  private _config: null = null;
  get running() { return this._running; }
  get port() { return this._ports.length > 0 ? this._ports[0] : null; }
  get ports() { return this._ports; }
  get config() { return this._config; }
  async start() { /* no-op */ }
  stop() { /* no-op */ }
  async restart() { /* no-op */ }
}

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

  async createPullRequest(options: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  }) {
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

  async mergePullRequest(_owner: string, _repo: string, _pullNumber: number, _method: string = "merge") {
    return this._mergeResult ?? { success: true, message: "Pull request merged" };
  }

  async enableAutoMerge(_owner: string, _repo: string, _pullNumber: number, _method: string = "MERGE") {
    return { success: true, message: "Auto-merge enabled — PR will merge when checks pass" };
  }

  async getCheckStatus(_owner: string, _repo: string, _ref: string) {
    return this._checkStatus ?? { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 };
  }

  // ---- Test control methods ----

  private _prData: { url: string; number: number; base: string; title: string } | null = null;
  private _mergeResult: { success: boolean; message: string } | null = null;
  private _checkStatus: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number } | null = null;

  /** Set what findPullRequest returns for tests. */
  setPrData(data: { url: string; number: number; base: string; title: string } | null) {
    this._prData = data;
  }

  /** Set what mergePullRequest returns for tests. */
  setMergeResult(result: { success: boolean; message: string } | null) {
    this._mergeResult = result;
  }

  /** Set what getCheckStatus returns for tests. */
  setCheckStatus(status: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number } | null) {
    this._checkStatus = status;
  }
}

/**
 * Fake ClaudeProcess for testing the send_message flow.
 * The test controls this object: call emit("event", ...) or emit("done", ...)
 * to simulate the real CLI producing output.
 */
export class FakeClaudeProcess extends EventEmitter {
  public runCalled = false;
  public lastPrompt = "";
  public lastSessionId: string | undefined;
  public lastSystemPrompt: string | undefined;
  public lastImages: Array<{ data: string; mediaType: string; filename?: string }> | undefined;
  public lastCwd: string | undefined;
  public lastPermissionMode: string | undefined;
  public killed = false;
  public interrupted = false;
  public stdinData: string[] = [];

  run(prompt: string, sessionId?: string, systemPrompt?: string, images?: Array<{ data: string; mediaType: string; filename?: string }>, cwd?: string, permissionMode?: string) {
    this.runCalled = true;
    this.lastPrompt = prompt;
    this.lastSessionId = sessionId;
    this.lastSystemPrompt = systemPrompt;
    this.lastImages = images;
    this.lastCwd = cwd;
    this.lastPermissionMode = permissionMode;
  }

  kill() {
    this.killed = true;
  }

  interrupt() {
    this.interrupted = true;
    // Simulate the process exiting after interrupt (non-zero exit code)
    setTimeout(() => this.emit("done", 1), 10);
  }

  writeStdin(data: string) {
    this.stdinData.push(data);
  }

  /**
   * Simulate a normal Claude turn completion: emit a result event then done.
   * This matches the real Claude CLI behavior where a `result` event always
   * precedes process exit on success.
   */
  finish(sessionId = "test-session", code = 0) {
    this.emit("event", { type: "result", subtype: "success", session_id: sessionId });
    this.emit("done", code);
  }
}

/**
 * Stub FileWatcher that doesn't actually watch the filesystem.
 * Tests can call simulateChanges() to trigger "changes" events manually.
 */
export class StubFileWatcher extends EventEmitter {
  start() { /* no-op */ }
  stop() { /* no-op */ }
  simulateChanges(paths: string[]) {
    this.emit("changes", paths);
  }
}

/**
 * Fake DeployTarget for testing deployment flows.
 * Tests control the outcome via simulateSuccess() / simulateFailure().
 */
export class FakeDeployTarget {
  public deployCalled = false;
  public prepareCalled = false;
  public lastCtx: Record<string, unknown> | null = null;

  readonly info = {
    id: "fake-target",
    name: "Fake Deploy",
    description: "Fake target for testing",
    configFields: [
      {
        key: "token",
        label: "Token",
        required: true,
        sensitive: true,
        placeholder: "test-token",
      },
    ],
    supportsPreview: true,
  };

  async prepare(ctx: Record<string, unknown>) {
    this.prepareCalled = true;
    this.lastCtx = ctx;
  }

  async deploy(ctx: Record<string, unknown>): Promise<{ url: string; environment: string; durationMs: number }> {
    this.deployCalled = true;
    this.lastCtx = ctx;
    return { url: "https://test.example.com", environment: "production", durationMs: 100 };
  }
}

/**
 * Stub DeploymentManager for integration tests.
 * Does not spawn real processes. Emits events when asked to deploy.
 */
export class StubDeploymentManager extends EventEmitter {
  private _deploying = false;
  private _targets: Array<{ info: { id: string; name: string; description: string; configFields: Array<{ key: string; label: string; required: boolean; sensitive: boolean }>; supportsPreview: boolean } }> = [];

  get deploying() { return this._deploying; }

  register(target: { info: { id: string; name: string; description: string; configFields: Array<{ key: string; label: string; required: boolean; sensitive: boolean }>; supportsPreview: boolean } }) {
    this._targets.push(target);
  }

  getTargets() {
    return this._targets.map((t) => t.info);
  }

  getTarget(targetId: string) {
    return this._targets.find((t) => t.info.id === targetId);
  }

  async detectFramework() {
    return { name: "static", buildCommand: "", outputDirectory: "." };
  }

  async build() {
    return true;
  }

  async deploy(targetId: string, ctx: Record<string, unknown>) {
    this._deploying = true;
    this.emit("status", { phase: "deploying" });
    const result = { url: "https://deployed.example.com", environment: ctx.environment || "production", durationMs: 50, targetId };
    this.emit("complete", result);
    this._deploying = false;
    return result;
  }

  cancel() { /* no-op */ }
}

/**
 * Stub DeploymentStore for integration tests.
 * In-memory storage, no filesystem access.
 */
export class StubDeploymentStore {
  private configs = new Map<string, Map<string, { targetId: string; credentials: Record<string, string>; projectName?: string }>>();
  private history = new Map<string, Array<Record<string, unknown>>>();

  saveConfig(sessionId: string, config: { targetId: string; credentials: Record<string, string>; projectName?: string }) {
    if (!this.configs.has(sessionId)) this.configs.set(sessionId, new Map());
    this.configs.get(sessionId)!.set(config.targetId, config);
  }

  loadConfig(sessionId: string, targetId: string) {
    return this.configs.get(sessionId)?.get(targetId) ?? null;
  }

  deleteConfig(sessionId: string, targetId: string) {
    this.configs.get(sessionId)?.delete(targetId);
  }

  listConfiguredTargets(sessionId: string) {
    return Array.from(this.configs.get(sessionId)?.keys() ?? []);
  }

  recordDeployment(sessionId: string, record: Record<string, unknown>) {
    if (!this.history.has(sessionId)) this.history.set(sessionId, []);
    this.history.get(sessionId)!.push(record);
  }

  getHistory(sessionId: string) {
    return this.history.get(sessionId) ?? [];
  }

  deleteSession(sessionId: string) {
    this.configs.delete(sessionId);
    this.history.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll until the most recent FakeClaudeProcess has been started.
 * Replaces fixed `setTimeout(50)` waits which are flaky because
 * `createSessionDir()` adds async I/O overhead (mkdir + git init).
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
 * Create a CredentialStore pre-populated with a test git identity.
 * Use in integration tests so session creation doesn't fail due to
 * missing identity.
 */
export function createTestCredentialStore(tmpDir: string): CredentialStore {
  const store = new CredentialStore(path.join(tmpDir, "credentials"));
  store.setGitIdentity("Test User", "test@test.com");
  return store;
}
