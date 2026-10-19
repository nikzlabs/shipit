// docs/333-idle-compaction — end to end: an ordinary turn leaves a large context and a 1-hour
// cache, its deadline fires, and a silent compaction turn runs in the transcript.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import { MISSED_COMPACTION_NOTICE } from "../compact-before-turn.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const SESSION_ID = "idle-compaction-session";

describe("Integration: an idle compaction (docs/333-idle-compaction)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let spawns: FakeClaudeProcess[] = [];
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    spawns = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-idle-compact-"));
    const sessionDir = path.join(tmpDir, "sessions", SESSION_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const git = (args: string[]): void => { execFileSync("git", args, { cwd: sessionDir, stdio: "pipe" }); };
    git(["init", "-b", "shipit/features"]);
    fs.writeFileSync(path.join(sessionDir, ".git", "info", "exclude"), "logs/\n");
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(sessionDir, "a.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);

    sessionManager = new SessionManager(dbManager);
    sessionManager.track(SESSION_ID, "Long work", sessionDir);
    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setDeclaredSetting("advanced.idleCompaction", true);
    // One process per turn: a compaction then resumes the conversation as every turn does.
    credentialStore.setDeclaredSetting("advanced.liveSteering", false);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const p = new FakeClaudeProcess();
        spawns.push(p);
        return p as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup is best-effort */ }
  });

  const history = async () =>
    ((await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/history` })).json() as {
      messages: { role?: string; text?: string; compaction?: unknown }[];
    }).messages;

  const idle = async (): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const runner = app.runnerRegistry.get(SESSION_ID);
      if (runner && !runner.running && !runner.postTurnWorkInFlight) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the session did not go idle");
  };

  /** A turn of the user's that leaves a 250K context in a 1-hour cache. */
  async function largeTurn(client: TestClient): Promise<FakeClaudeProcess> {
    client.send({ type: "send_message", text: "build feature A" });
    const turn = await waitForClaude(() => spawns.at(-1) ?? (null as never));
    turn.initSession("agent-a");
    turn.emit("event", {
      type: "agent_result",
      status: "success",
      sessionId: "agent-a",
      tokens: { input: 10, output: 500, cacheRead: 240_000, cacheWrite: 10_000 },
      contextTokens: 250_010,
      cacheTtl: "1h",
    });
    turn.emit("done", 0);
    await idle();
    expect(app.idleCompaction.isWaiting(SESSION_ID)).toBe(true);
    return turn;
  }

  async function fireCompaction(after: FakeClaudeProcess): Promise<FakeClaudeProcess> {
    void app.idleCompaction.fire(SESSION_ID);
    const compaction = await waitForClaude(() => spawns.at(-1) ?? (null as never), after);
    expect(compaction.lastCompact).toBe(true);
    expect(compaction.lastPrompt.trim()).toBe("/compact");
    return compaction;
  }

  it("records the ordinary compaction card, adds no user row, and leaves the session's place in the list", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();
    const turn = await largeTurn(client);
    const usedBefore = sessionManager.get(SESSION_ID)?.lastUsedAt;

    const compaction = await fireCompaction(turn);
    compaction.emit("event", { type: "agent_compacted", trigger: "manual", preTokens: 250_010, postTokens: 9_000 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);
    await idle();

    const messages = await history();
    expect(messages.filter((m) => m.compaction !== undefined)).toHaveLength(1);
    expect(messages.some((m) => m.role === "user" && m.text?.startsWith("/compact"))).toBe(false);
    expect(messages.some((m) => m.text === MISSED_COMPACTION_NOTICE)).toBe(false);
    expect(sessionManager.get(SESSION_ID)?.lastUsedAt).toBe(usedBefore);
    // Just compacted is small: no second deadline.
    expect(app.idleCompaction.isWaiting(SESSION_ID)).toBe(false);
    client.close();
  });

  it("says in the transcript that the context was not compacted when no card came (req 4)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();
    const turn = await largeTurn(client);

    const compaction = await fireCompaction(turn);
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);
    await idle();

    const messages = await history();
    expect(messages.filter((m) => m.text === MISSED_COMPACTION_NOTICE)).toHaveLength(1);
    expect(messages.filter((m) => m.compaction !== undefined)).toHaveLength(0);
    client.close();
  });

  it("runs a message the user sends during the compaction afterwards (req 4)", async () => {
    const client = await TestClient.connect(port, SESSION_ID);
    await client.receive();
    const turn = await largeTurn(client);

    const compaction = await fireCompaction(turn);
    client.send({ type: "send_message", text: "now build feature B" });
    await new Promise((r) => setTimeout(r, 100));
    expect(spawns.at(-1)).toBe(compaction);

    compaction.emit("event", { type: "agent_compacted", trigger: "manual", preTokens: 250_010, postTokens: 9_000 });
    compaction.emit("event", { type: "agent_result", status: "success", sessionId: "agent-a" });
    compaction.emit("done", 0);

    const next = await waitForClaude(() => spawns.at(-1) ?? (null as never), compaction);
    expect(next.lastCompact).toBeFalsy();
    expect(next.lastPrompt).toContain("now build feature B");
    next.finish("agent-a");
    client.close();
  });
});
