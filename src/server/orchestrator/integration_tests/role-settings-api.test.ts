import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

// Stub generatePackageLock to avoid spawning npm in integration tests.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});

import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { DatabaseManager } from "../../shared/database.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import type { RoleView } from "../../shared/types/agent-types.js";

describe("Integration: role settings over HTTP (docs/264 phase 2)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-role-api-"));
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      credentialsDir: tmpDir,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      workspaceDir: tmpDir,
      serveStatic: false,
    });
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

  async function addCredential(serviceId: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId, billingMode: "key", secret: `sk-${serviceId}-test`, label: "test" },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function bootstrapRoles(): Promise<RoleView[]> {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    return res.json().settings.roles as RoleView[];
  }

  function put(roles: Record<string, unknown>) {
    return app.inject({ method: "PUT", url: "/api/settings", payload: { roles } });
  }

  const PINNED = {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "deepseek",
    billingMode: "key",
    modelId: "deepseek-flash",
    reasoningEffort: "high",
  };

  it("has the reviewer on a completely empty install (req 2)", async () => {
    const roles = await bootstrapRoles();
    expect(roles.map((r) => r.name)).toEqual(["reviewer"]);
    expect(roles[0].reserved).toBe(true);
    expect(roles[0].params.kind).toBe("auto");
  });

  it("round-trips a role through the route, the store and the response", async () => {
    await addCredential("deepseek");

    const res = await put({
      "deep dive": { description: "The thorough one", prompt: "Read the plan", params: PINNED },
    });
    expect(res.statusCode, res.body).toBe(200);

    const answered = res.json().roles as RoleView[];
    const created = answered.find((r) => r.name === "deep dive");
    expect(created?.resolved).toMatchObject({
      harnessId: "claude",
      serviceId: "deepseek",
      modelId: "deepseek-flash",
      reasoningEffort: "high",
    });
    expect(created?.description).toBe("The thorough one");

    expect(credentialStore.getRole("deep dive")).toMatchObject({ params: PINNED });
    expect(await bootstrapRoles()).toEqual(answered);
  });

  it("renames in one write, leaving nothing behind (req 18)", async () => {
    await addCredential("deepseek");
    await put({ "deep dive": { params: PINNED } });

    const res = await put({ "deeper dive": { previousName: "deep dive", params: PINNED } });
    expect(res.statusCode, res.body).toBe(200);
    expect(credentialStore.getRole("deep dive")).toBeUndefined();
    expect(credentialStore.getRole("deeper dive")).toBeTruthy();
  });

  it("refuses a duplicate name rather than overwriting the role that holds it", async () => {
    await addCredential("deepseek");
    await put({ "deep dive": { description: "mine", params: PINNED } });

    const res = await put({ "deep dive": { description: "yours", params: PINNED } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("already exists");
    expect(credentialStore.getRole("deep dive")?.description).toBe("mine");
  });

  it("refuses a level the named harness does not declare, naming the parameter", async () => {
    await addCredential("deepseek");
    const res = await put({
      "deep dive": { params: { ...PINNED, reasoningEffort: "minimal" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("minimal");
    expect(credentialStore.getRole("deep dive")).toBeUndefined();
  });

  it("accepts the same model under the other harness (req 6's whole point)", async () => {
    await addCredential("deepseek");
    const res = await put({
      "on codex": { params: { ...PINNED, harnessId: "codex" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(credentialStore.getRole("on codex")?.params).toMatchObject({ harnessId: "codex" });
  });

  it("deletes with null", async () => {
    await addCredential("deepseek");
    await put({ "deep dive": { params: PINNED } });
    const res = await put({ "deep dive": null });
    expect(res.statusCode, res.body).toBe(200);
    expect(credentialStore.getRole("deep dive")).toBeUndefined();
    expect((res.json().roles as RoleView[]).map((r) => r.name)).toEqual(["reviewer"]);
  });

  it("refuses to delete or rename the reviewer (req 2)", async () => {
    const deleted = await put({ reviewer: null });
    expect(deleted.statusCode).toBe(400);
    const renamed = await put({ "my reviewer": { previousName: "reviewer", params: PINNED } });
    expect(renamed.statusCode).toBe(400);
    expect(credentialStore.getRole("reviewer")).toBeTruthy();
  });

  it("edits the reviewer's description and standing instructions", async () => {
    const res = await put({
      reviewer: {
        previousName: "reviewer",
        description: "Second opinion",
        prompt: "Review only; do not edit",
        params: { kind: "auto" },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const reviewer = (res.json().roles as RoleView[]).find((r) => r.name === "reviewer");
    expect(reviewer).toMatchObject({
      description: "Second opinion",
      prompt: "Review only; do not edit",
      params: { kind: "auto" },
      reserved: true,
    });
    expect(credentialStore.getRole("reviewer")?.params).toEqual({ kind: "auto" });
  });

  it("saves a tuple this install has no credential for, and reports it disconnected", async () => {
    const res = await put({ "deep dive": { params: PINNED } });
    expect(res.statusCode, res.body).toBe(200);
    const created = (res.json().roles as RoleView[]).find((r) => r.name === "deep dive");
    expect(created?.unavailableReason).toBe("disconnected");
    expect(created?.invalidField).toBeUndefined();
    expect(credentialStore.getRole("deep dive")).toMatchObject({ params: PINNED });
  });

  it("lets a disconnected role's description be edited (req 5)", async () => {
    await put({ "deep dive": { description: "old", params: PINNED } });
    const res = await put({
      "deep dive": { previousName: "deep dive", description: "new", params: PINNED },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(credentialStore.getRole("deep dive")?.description).toBe("new");
  });

  it("still refuses a tuple fault while no credential exists", async () => {
    const res = await put({
      "deep dive": { params: { ...PINNED, reasoningEffort: "minimal" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("minimal");
  });
});
