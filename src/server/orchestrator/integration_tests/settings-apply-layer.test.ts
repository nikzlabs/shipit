import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { buildApp } from "../index.js";

// Avoid spawning npm.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import type { FastifyInstance } from "fastify";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import { RepoStore } from "../repo-store.js";
import { initGlobalGitConfig } from "../git-config.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";

/**
 * Every settings write goes through the shared layer, and the layer raises one
 * broadcast for all of them (docs/299-agent-settings-access, plan.md → Apply
 * goes through a shared layer).
 *
 * The broadcast is NEW work rather than something the routes already did:
 * `saveGlobalSettings` broadcast nothing at all, and the dialog only got away
 * with it because each toggle writes its own browser store before the PUT. So a
 * write no viewer hears about is the defect these assert against, which is why
 * they are keyed on the SSE event and not on any one route's response body.
 *
 * The egress case is the layer's other reason to exist: the route did three
 * things the store's `addHost` does not, and a second caller that reached for
 * the store inherited none of them.
 */

interface SseFrame { event: string; data: Record<string, unknown> }

class SseTestClient {
  private req: http.ClientRequest;
  private buffer = "";
  readonly frames: SseFrame[] = [];

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
        this.frames.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
      } catch {
        // Non-JSON keepalive / comment — ignore.
      }
    }
  }

  /** Every setting key named by a `settings_changed` frame so far. */
  async changedKeys(): Promise<string[]> {
    await new Promise((r) => setTimeout(r, 60));
    return this.frames
      .filter((f) => f.event === "settings_changed")
      .flatMap((f) => (f.data.keys as string[] | undefined) ?? []);
  }

  close(): void {
    this.req.destroy();
  }
}

describe("the shared settings apply layer", () => {
  let app: FastifyInstance;
  let dbManager: DatabaseManager;
  let credentialStore: CredentialStore;
  let egressAllowlistStore: EgressAllowlistStore;
  let repoStore: RepoStore;
  let tmpDir: string;
  let sse: SseTestClient;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-apply-layer-"));
    initGlobalGitConfig(tmpDir);
    dbManager = createTestDatabaseManager();
    credentialStore = new CredentialStore(tmpDir);
    repoStore = new RepoStore(dbManager);
    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager: new SessionManager(dbManager),
      repoStore,
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      credentialsDir: tmpDir,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    // The same rows the orchestrator's own store reads, for asserting the write.
    egressAllowlistStore = new EgressAllowlistStore(dbManager);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
    sse = await SseTestClient.connect(port);
  });

  afterEach(async () => {
    sse.close();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("raises a settings broadcast for a saved global setting, which the route never did", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { enableSubAgents: false },
    });

    expect(res.statusCode).toBe(200);
    expect(credentialStore.getDeclaredSetting("advanced.enableSubAgents")).toBe(false);
    expect(await sse.changedKeys()).toContain("enableSubAgents");
  });

  it("raises it for a git identity too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/git-identity",
      payload: { name: "Ada", email: "ada@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(await sse.changedKeys()).toContain("git.identity");
  });

  it("does the egress route's WHOLE act for a built-in default: unsuppress, not a duplicate row", async () => {
    // The row-level `addHost` the store exposes would add a second entry and
    // leave the default suppressed — the exact gap that made the route's
    // behaviour uninheritable by a second caller.
    egressAllowlistStore.suppressDefault("openrouter.ai");
    expect(egressAllowlistStore.listSuppressedDefaults()).toContain("openrouter.ai");

    const res = await app.inject({
      method: "POST",
      url: "/api/egress/hosts",
      payload: { host: "openrouter.ai" },
    });

    expect(res.statusCode).toBe(200);
    expect(egressAllowlistStore.listSuppressedDefaults()).not.toContain("openrouter.ai");
    expect(egressAllowlistStore.listHosts(EGRESS_GLOBAL_SCOPE)).not.toContain("openrouter.ai");
    expect(await sse.changedKeys()).toContain("network.egress.hosts");
  });

  it("raises it for the global containment toggle", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/egress/settings",
      payload: { globalEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(egressAllowlistStore.getGlobalEnabled()).toBe(false);
    expect(await sse.changedKeys()).toContain("network.egressContained");
  });

  it("raises it for an MCP server write", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mcp-servers",
      payload: { config: { name: "notion", type: "http", url: "https://mcp.example.com/v1", enabled: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(credentialStore.getMcpServer("notion")).toBeDefined();
    expect(await sse.changedKeys()).toContain("mcp.servers");
  });

  it("raises it for a repository setting, and still broadcasts the repository list", async () => {
    repoStore.add("https://github.com/acme/widgets.git");

    const res = await app.inject({
      method: "PATCH",
      url: `/api/repos/${encodeURIComponent("https://github.com/acme/widgets.git")}`,
      payload: { allowAgentMerge: true },
    });

    expect(res.statusCode).toBe(200);
    expect(repoStore.get("https://github.com/acme/widgets.git")?.allowAgentMerge).toBe(true);
    expect(await sse.changedKeys()).toContain("project.allowAgentMerge");
    expect(sse.frames.map((f) => f.event)).toContain("repo_list");
  });

  it("answers 500 rather than 200 when a write did not land", async () => {
    // The shipped routes got this for free — a store error threw and Fastify
    // answered 500. The layer turns that throw into an outcome, so a route that
    // ignored it would answer 200 for a write that never happened.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { enableSubAgents: false },
    });
    failing.mockRestore();
    vi.restoreAllMocks();

    expect(res.statusCode).toBe(500);
    expect((res.json() as { outcome: { status: string } }).outcome.status).toBe("failed");
    // Rolled back, so the value the client re-reads is the one a restart gives.
    expect(credentialStore.getDeclaredSetting("advanced.enableSubAgents")).toBe(true);
  });

  it("does not lose a role when a rename's create is rolled back", async () => {
    await app.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId: "deepseek", billingMode: "key", secret: "sk-test", label: "test" },
    });
    const pinned = {
      kind: "pinned", harnessId: "claude", serviceId: "deepseek",
      billingMode: "key", modelId: "deepseek-flash",
    };
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { roles: { writer: { description: "drafts", params: pinned } } },
    });
    expect(credentialStore.getRole("writer")).toBeDefined();

    // The create is rolled back and the delete of the old name would otherwise
    // still run — leaving neither copy of the role.
    vi.spyOn(console, "error").mockImplementation(() => {});
    let writes = 0;
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(((...args: unknown[]) => {
      writes += 1;
      if (writes === 1) throw new Error("EROFS: read-only file system");
      return (realRename as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.renameSync);

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { roles: { author: { previousName: "writer", description: "drafts", params: pinned } } },
    });
    spy.mockRestore();
    vi.restoreAllMocks();

    expect(res.statusCode).toBe(500);
    expect(credentialStore.getRole("writer")).toBeDefined();
  });

  it("still answers 4xx for a refused write rather than reporting a failed one", async () => {
    // Validation changed nothing on purpose, so it is not an outcome: turning it
    // into one would answer 500 for a request the caller can fix.
    const unknownRepo = await app.inject({
      method: "PATCH",
      url: `/api/repos/${encodeURIComponent("https://github.com/never/added.git")}`,
      payload: { hidden: true },
    });
    expect(unknownRepo.statusCode).toBe(404);

    const badChannel = await app.inject({
      method: "POST",
      url: "/api/updates/channel",
      payload: { channel: "nightly" },
    });
    expect(badChannel.statusCode).toBe(400);
  });
});
