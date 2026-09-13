/**
 * docs/298-broken-workspace-visibility — opening a session is the moment the marker
 * is most useful and was the moment nothing set it: the disk janitor never evaluates
 * a session with an attached viewer, and the per-repo sidebar cap can hide a resolved
 * session that only a `/session/<id>` URL reaches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { buildApp } from "../index.js";

vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FastifyInstance } from "fastify";
import type { SessionInfo } from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";

/** Reads `session_list` frames off the global SSE stream the sidebar listens on. */
class SseTestClient {
  private req: http.ClientRequest;
  private buffer = "";
  readonly sessionLists: SessionInfo[][] = [];

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
          res.on("data", (chunk: string) => { client.ingest(chunk); });
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
      if (event !== "session_list" || dataLines.length === 0) continue;
      try {
        this.sessionLists.push(
          (JSON.parse(dataLines.join("\n")) as { sessions: SessionInfo[] }).sessions,
        );
      } catch { /* keepalive / comment */ }
    }
  }

  /** The marker the last published list carries for this session. */
  latestBlock(sessionId: string): string | undefined {
    for (let i = this.sessionLists.length - 1; i >= 0; i--) {
      const row = this.sessionLists[i].find((s) => s.id === sessionId);
      if (row) return row.workspaceBlock;
    }
    return undefined;
  }

  async waitForBlock(sessionId: string, expected: string | undefined): Promise<string | undefined> {
    for (let i = 0; i < 100; i++) {
      const seen = this.sessionLists.some((l) => l.some((s) => s.id === sessionId));
      if (seen && this.latestBlock(sessionId) === expected) return expected;
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.latestBlock(sessionId);
  }

  close(): void {
    this.req.destroy();
  }
}

describe("Integration: activation evaluates the workspace (docs/298)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;
  let sse: SseTestClient | null = null;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-ws-block-"));
    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      workspaceDir: tmpDir,
      serveStatic: false,
    });

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    sse?.close();
    sse = null;
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  async function createSession(): Promise<{ sessionId: string; workspaceDir: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Broken checkout" },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { sessionId: string; workspaceDir: string };
  }

  async function waitForBlock(
    sessionId: string,
    expected: string | undefined,
  ): Promise<string | undefined> {
    for (let i = 0; i < 100; i++) {
      const current = sessionManager.get(sessionId)?.workspaceBlock;
      if (current === expected) return current;
      await new Promise((r) => setTimeout(r, 20));
    }
    return sessionManager.get(sessionId)?.workspaceBlock;
  }

  it("marks a checkout stuck mid-rebase and publishes it to the sidebar", async () => {
    const { sessionId, workspaceDir } = await createSession();
    // The incident's shape: git stopped part-way through a rebase and stayed there.
    fs.mkdirSync(path.join(workspaceDir, ".git", "rebase-merge"), { recursive: true });
    sse = await SseTestClient.connect(port);

    const client = await TestClient.connect(port, sessionId);
    try {
      expect(await waitForBlock(sessionId, "conflict")).toBe("conflict");
      // Without the broadcast the sidebar would not learn of it until something
      // unrelated pushed a list.
      expect(await sse.waitForBlock(sessionId, "conflict")).toBe("conflict");
    } finally {
      client.close();
    }
  });

  it("withdraws the marker when the repaired session is opened again", async () => {
    const { sessionId, workspaceDir } = await createSession();
    fs.mkdirSync(path.join(workspaceDir, ".git", "rebase-merge"), { recursive: true });

    const first = await TestClient.connect(port, sessionId);
    expect(await waitForBlock(sessionId, "conflict")).toBe("conflict");
    first.close();

    fs.rmSync(path.join(workspaceDir, ".git", "rebase-merge"), { recursive: true, force: true });
    sse = await SseTestClient.connect(port);

    const second = await TestClient.connect(port, sessionId);
    try {
      expect(await waitForBlock(sessionId, undefined)).toBeUndefined();
      expect(await sse.waitForBlock(sessionId, undefined)).toBeUndefined();
    } finally {
      second.close();
    }
  });
});
