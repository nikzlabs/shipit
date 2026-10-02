import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  TestClient,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { PrStatusSummary } from "../../shared/types.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

class SseTestClient {
  private req: http.ClientRequest;
  private buffer = "";
  private frames: SseFrame[] = [];
  private returned = new Set<number>();

  private constructor(req: http.ClientRequest) {
    this.req = req;
  }

  static connect(port: number): Promise<SseTestClient> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/events`,
        { headers: { Accept: "text/event-stream" } },
        (res) => {
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => client.ingest(chunk));
        },
      );
      const client = new SseTestClient(req);
      req.on("error", reject);
      req.on("response", () => setTimeout(() => resolve(client), 20));
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let sep: number;
    while ((sep = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        this.frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
      } catch {
        // Non-JSON keepalive / comment — ignore.
      }
    }
  }

  async waitFor(event: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < this.frames.length; i++) {
        if (this.returned.has(i)) continue;
        if (this.frames[i].event === event) {
          this.returned.add(i);
          return this.frames[i].data;
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`SSE waitFor("${event}") timed out after ${timeoutMs}ms`);
  }

  close(): void {
    this.req.destroy();
  }
}

function prSummary(sessionId: string, prState: PrStatusSummary["prState"]): PrStatusSummary {
  return {
    sessionId,
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
    prTitle: "Work",
    prBody: "A long body",
    prState,
    baseBranch: "main",
    headBranch: `shipit/${sessionId}`,
    insertions: 1,
    deletions: 0,
    checks: { state: "success", total: 1, passed: 1, failed: 0, pending: 0 },
    mergeable: "unknown",
    reviewDecision: "none",
    autoMergeEnabled: false,
  };
}

describe("Integration: /api/events initial snapshot is authoritative", () => {
  let app: FastifyInstance | null = null;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionManager: SessionManager;
  let sse: SseTestClient | null = null;
  let ws: TestClient | null = null;
  let port: number;

  beforeEach(() => {
    dbManager = createTestDatabaseManager();
    sessionManager = new SessionManager(dbManager);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sse-snapshot-"));
    initGlobalGitConfig(tmpDir);
  });

  // The poller reads persisted PR statuses at startup, so seed before this.
  async function start(): Promise<void> {
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore: new CredentialStore(tmpDir),
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  }

  function seedSidebarAndArchivedPrs(): void {
    sessionManager.track("visible-1", "In the sidebar");
    sessionManager.setPrStatus("visible-1", prSummary("visible-1", "open"));
    sessionManager.track("archived-1", "Archived");
    sessionManager.setPrStatus("archived-1", prSummary("archived-1", "merged"));
    sessionManager.archive("archived-1");
  }

  afterEach(async () => {
    sse?.close();
    sse = null;
    ws?.close();
    ws = null;
    await app?.close();
    app = null;
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("always sends active_runners on connect, even with no active runners", async () => {
    await start();
    sse = await SseTestClient.connect(port);
    const data = await sse.waitFor("active_runners");
    expect(data.sessionIds).toEqual([]);
  });

  it("always sends pr_status as an authoritative snapshot on connect", async () => {
    await start();
    sse = await SseTestClient.connect(port);
    const data = await sse.waitFor("pr_status");
    expect(data.isSnapshot).toBe(true);
    expect(data.updates).toEqual([]);
  });

  // Every PR a session ever had used to ride this snapshot: ~10 MB on a busy install.
  it("snapshots only the sidebar's PR statuses, and names that scope", async () => {
    seedSidebarAndArchivedPrs();
    await start();
    sse = await SseTestClient.connect(port);
    const data = await sse.waitFor("pr_status");
    const updates = data.updates as PrStatusSummary[];
    expect(updates.map((u) => u.sessionId)).toEqual(["visible-1"]);
    expect(data.scope).toEqual(["visible-1"]);
  });

  describe("the status card and the goal", () => {
    const goal = { objective: "Ship it", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 1 };
    const card = { status: "Routes done.", actions: [], fresh: true, writeSeq: 1, turnSeq: 0 };

    function seedHeavySession(): void {
      sessionManager.track("open-1", "Open");
      sessionManager.setSessionStatus("open-1", card);
      sessionManager.setAgentGoal("open-1", goal);
      sessionManager.setConversationReplay("open-1", "User: the whole transcript");
      sessionManager.track("other-1", "Other");
    }

    it("stay off the session list every tab receives", async () => {
      seedHeavySession();
      await start();
      sse = await SseTestClient.connect(port);
      const data = await sse.waitFor("session_list");
      const row = (data.sessions as Record<string, unknown>[]).find((s) => s.id === "open-1");
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("sessionStatus");
      expect(row).not.toHaveProperty("agentGoal");
      expect(row).not.toHaveProperty("conversationReplay");
    });

    it("reach the open session's socket when it attaches and on each change, and only its own", async () => {
      seedHeavySession();
      await start();
      ws = await TestClient.connect(port, "open-1");
      expect(await ws.receiveType("session_details")).toEqual({
        type: "session_details",
        sessionId: "open-1",
        sessionStatus: card,
        agentGoal: goal,
      });

      sessionManager.setSessionStatus("other-1", { ...card, status: "Not this one." });
      sessionManager.setSessionStatus("open-1", { ...card, status: "Moved on." });
      expect(await ws.receiveType("session_details")).toMatchObject({
        sessionId: "open-1",
        sessionStatus: { status: "Moved on." },
        agentGoal: goal,
      });

      sessionManager.setAgentGoal("open-1", null);
      expect(await ws.receiveType("session_details")).toMatchObject({ sessionId: "open-1", agentGoal: null });
    });

    // Neither path attaches a runner; the card needs no workspace.
    it("reach a session whose workspace restore fails, and an archived one", async () => {
      sessionManager.track("evicted-1", "Evicted", path.join(tmpDir, "gone", "workspace"));
      sessionManager.setRemoteUrl("evicted-1", "https://github.com/o/does-not-exist");
      sessionManager.setDiskTier("evicted-1", "evicted");
      sessionManager.setSessionStatus("evicted-1", card);
      sessionManager.track("archived-2", "Archived");
      sessionManager.setSessionStatus("archived-2", card);
      sessionManager.archive("archived-2");
      await start();

      ws = await TestClient.connect(port, "evicted-1");
      expect(await ws.receiveType("session_details")).toMatchObject({ sessionId: "evicted-1", sessionStatus: card });
      ws.close();

      ws = await TestClient.connect(port, "archived-2");
      expect(await ws.receiveType("session_details")).toMatchObject({ sessionId: "archived-2", sessionStatus: card });
    });
  });

  it("gives a session outside the sidebar its PR status on its own socket", async () => {
    seedSidebarAndArchivedPrs();
    await start();
    ws = await TestClient.connect(port, "archived-1");
    const msg = await ws.receiveType("session_pr_status");
    expect(msg).toMatchObject({
      type: "session_pr_status",
      sessionId: "archived-1",
      status: { sessionId: "archived-1", prState: "merged", prBody: "A long body" },
    });
  });
});
