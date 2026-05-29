/**
 * Integration tests for the marketplace HTTP routes (docs/149).
 *
 * Goes end-to-end through `buildApp`, but pre-populates the
 * `marketplace-cache/` directory with a fake catalog clone so the test
 * doesn't reach GitHub. The pre-clone task inside `buildApp` is gated on
 * `!isTestMode` so it never runs here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import { DatabaseManager } from "../../shared/database.js";
import {
  StubAuthManager,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const CATALOG_ID = "claude-plugins-official"; // seeded by buildApp

function writeFakeCatalog(stateDir: string): void {
  const cacheDir = path.join(stateDir, "marketplace-cache", CATALOG_ID);
  fs.mkdirSync(path.join(cacheDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: CATALOG_ID,
      plugins: [
        {
          name: "demo-plugin",
          description: "A demo plugin with one skill",
          source: "./plugins/demo-plugin",
          author: { name: "Anthropic" },
        },
      ],
    }),
  );
  const pluginRoot = path.join(cacheDir, "plugins", "demo-plugin", "skills", "hello");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "SKILL.md"),
    "---\nname: hello\ndescription: say hi\n---\n\nSay hi to the user.\n",
  );
}

describe("Integration: marketplace HTTP routes (docs/149)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let sessionId: string;
  let workspaceDir: string;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "marketplace-int-"));
    writeFakeCatalog(tmpDir);

    const registry = new AgentRegistry({
      checkBinary: async (binary) => binary === "claude",
      checkClaudeAuth: () => true,
    });
    await registry.detect();

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentRegistry: registry,
      workspaceDir: tmpDir,
      stateDir: tmpDir,
      serveStatic: false,
    });

    await app.listen({ port: 0, host: "127.0.0.1" });

    // Create a session via the test-only endpoint so the install flow has a
    // real workspaceDir + initialized git repo to target.
    const sess = await app.inject({
      method: "POST",
      url: "/api/_test/sessions",
      payload: { title: "Marketplace test" },
    });
    expect(sess.statusCode).toBe(200);
    const sessJson = sess.json() as { sessionId: string; workspaceDir: string };
    sessionId = sessJson.sessionId;
    workspaceDir = sessJson.workspaceDir;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("seeds the official Claude catalog at startup and lists it via GET /api/marketplaces", async () => {
    const res = await app.inject({ method: "GET", url: "/api/marketplaces?agent=claude" });
    expect(res.statusCode).toBe(200);
    const data = res.json() as { marketplaces: { id: string; agentId: string }[] };
    const seeded = data.marketplaces.find((m) => m.id === CATALOG_ID);
    expect(seeded).toBeDefined();
    expect(seeded?.agentId).toBe("claude");
  });

  it("lists installable plugins from the pre-populated catalog cache", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/marketplaces/${CATALOG_ID}/plugins`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json() as { plugins: { name: string; skills: { name: string }[] }[] };
    expect(data.plugins).toHaveLength(1);
    expect(data.plugins[0].name).toBe("demo-plugin");
    expect(data.plugins[0].skills.map((s) => s.name)).toEqual(["hello"]);
  });

  it("install + list + uninstall round-trip on a session", async () => {
    // Install
    const install = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugins/install`,
      payload: { marketplaceId: CATALOG_ID, pluginName: "demo-plugin" },
    });
    expect(install.statusCode).toBe(200);
    const installJson = install.json() as { invocationTokens: string[]; commitHash: string };
    expect(installJson.invocationTokens).toEqual(["/demo-plugin:hello"]);
    expect(installJson.commitHash).toBeTruthy();

    // Disk has the flat-dir layout
    const installedFile = path.join(
      workspaceDir,
      ".claude",
      "skills",
      "demo-plugin__hello",
      "SKILL.md",
    );
    expect(fs.existsSync(installedFile)).toBe(true);
    const body = fs.readFileSync(installedFile, "utf-8");
    expect(body).toMatch(/^name: demo-plugin:hello$/m);

    // List shows the install
    const list = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/plugins`,
    });
    expect(list.statusCode).toBe(200);
    const listJson = list.json() as { plugins: { pluginName: string; skillName: string }[] };
    expect(listJson.plugins).toHaveLength(1);
    expect(listJson.plugins[0]).toMatchObject({
      pluginName: "demo-plugin",
      skillName: "hello",
    });

    // Second install on the same target is a 409 (already installed)
    const dup = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugins/install`,
      payload: { marketplaceId: CATALOG_ID, pluginName: "demo-plugin" },
    });
    expect(dup.statusCode).toBe(409);

    // Uninstall
    const uninstall = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/plugins/${CATALOG_ID}/demo-plugin`,
    });
    expect(uninstall.statusCode).toBe(200);
    expect(fs.existsSync(installedFile)).toBe(false);

    // Empty list afterwards
    const list2 = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/plugins`,
    });
    expect((list2.json() as { plugins: unknown[] }).plugins).toHaveLength(0);
  });

  it("rejects install with missing fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/plugins/install`,
      payload: { marketplaceId: CATALOG_ID },
    });
    expect(res.statusCode).toBe(400);
  });
});
