import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { MAX_MERGED_SESSIONS_PER_REPO, SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";
import type { SessionListRow } from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  recordSse,
  type SseEvent,
  waitFor,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { CredentialStore } from "../credential-store.js";

describe("docs/316-done-sessions-return-memory req 11: a session the sidebar cap hid is listed while its agent works", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as never;
  let credentialStore: CredentialStore;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-working-listed-"));
    sessionManager = new SessionManager(dbManager);
    credentialStore = createTestCredentialStore(tmpDir);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
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
    } catch { /* ignore cleanup errors */ }
  });

  function resolve(id: string, at: string): void {
    dbManager.db.prepare("UPDATE sessions SET merged_at = ?, last_used_at = ? WHERE id = ?").run(at, at, id);
  }

  function hideBehindCap(sessionId: string): void {
    const remoteUrl = sessionManager.get(sessionId)?.remoteUrl ?? "";
    resolve(sessionId, "2024-01-01 09:00:00");
    for (let i = 0; i < MAX_MERGED_SESSIONS_PER_REPO; i++) {
      const id = `newer-${i}`;
      sessionManager.track(id, id);
      sessionManager.setRemoteUrl(id, remoteUrl);
      resolve(id, `2024-01-0${i + 2} 09:00:00`);
    }
    expect(sessionManager.list().map((s) => s.id)).not.toContain(sessionId);
  }

  function listedSince(events: SseEvent[], from: number, sessionId: string): boolean {
    return events.slice(from).some((e) => e.event === "session_list"
      && (e.data as { sessions: SessionListRow[] }).sessions.some((s) => s.id === sessionId));
  }

  const lastStart = (events: SseEvent[]): number => events.map((e) => e.event).lastIndexOf("session_agent_started");
  const finishes = (events: SseEvent[]): number => events.filter((e) => e.event === "session_agent_finished").length;

  it("sends a list with the session when its turn starts, before the turn ends", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;
    hideBehindCap(sessionId);

    const sse = await recordSse(port);
    try {
      client.send({ type: "send_message", text: "Continue in the old session" });
      const claude = await waitForClaude(() => lastClaude);
      claude.initSession("working-listed");
      await waitFor(() => lastStart(sse.events) >= 0, "agent started");
      await waitFor(() => listedSince(sse.events, lastStart(sse.events), sessionId), "a list with the session");
      expect(finishes(sse.events)).toBe(0);
      claude.emit("event", { type: "result", subtype: "success", session_id: "working-listed" });
    } finally {
      sse.close();
      client.close();
    }
  });

  it("sends a list with the session when the CLI starts a turn of its own", async () => {
    credentialStore.setLiveSteering(true);
    const client = await TestClient.connect(port);
    await client.receive();
    const sessionId = client.sessionId;
    const sse = await recordSse(port);
    try {
      client.send({ type: "send_message", text: "Run the consult in the background" });
      const claude = await waitForClaude(() => lastClaude);
      claude.initSession("working-listed-wake");
      claude.emit("event", { type: "result", subtype: "success", session_id: "working-listed-wake" });
      await waitFor(() => finishes(sse.events) === 1, "first turn finished");

      hideBehindCap(sessionId);
      const before = sse.events.length;
      claude.emit("event", { type: "agent_self_wake", taskId: "bg-1", status: "completed" });
      await waitFor(() => lastStart(sse.events) >= before, "self-woken turn started");
      await waitFor(() => listedSince(sse.events, lastStart(sse.events), sessionId), "a list with the session");
      expect(finishes(sse.events)).toBe(1);
      claude.emit("event", { type: "result", subtype: "success", session_id: "working-listed-wake" });
    } finally {
      sse.close();
      client.close();
    }
  });
});
