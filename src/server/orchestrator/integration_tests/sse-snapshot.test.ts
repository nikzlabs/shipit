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
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig } from "../git-config.js";

// Minimal SSE reader: connects to /api/events and buffers parsed frames.
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

// The mobile-foreground reconnect (useServerEvents forces a fresh EventSource
// when the tab returns) relies on the /api/events initial snapshot being
// AUTHORITATIVE: it must always send active_runners and pr_status so the
// client can clear stale state that accumulated while the socket was dead.
describe("Integration: /api/events initial snapshot is authoritative", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sse: SseTestClient | null = null;
  let port: number;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sse-snapshot-"));
    initGlobalGitConfig(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      credentialStore: new CredentialStore(tmpDir),
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
    } catch {
      // Ignore cleanup errors
    }
  });

  it("always sends active_runners on connect, even with no active runners", async () => {
    sse = await SseTestClient.connect(port);
    // Without the unconditional send, this event would be suppressed (empty)
    // and a reconnecting client could never clear a stale "running" flag.
    const data = await sse.waitFor("active_runners");
    expect(data.sessionIds).toEqual([]);
  });

  it("always sends pr_status as an authoritative snapshot on connect", async () => {
    sse = await SseTestClient.connect(port);
    const data = await sse.waitFor("pr_status");
    expect(data.isSnapshot).toBe(true);
    expect(data.updates).toEqual([]);
  });
});
