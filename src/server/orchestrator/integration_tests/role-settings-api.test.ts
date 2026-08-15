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

/**
 * docs/264 phase 2 (reqs 1, 2, 5, 6, 17, 18) — role CRUD **over HTTP**.
 *
 * The unit tests exercise the write planner directly and the component tests
 * mock `fetch`, so between them both suites pass if the route forgets to forward
 * or persist `roles` at all — the hole cross-backend review found on docs/261's
 * equivalent. This closes it end to end: real app, real route, real store, one
 * assertion per hop the value has to cross.
 */
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

  /** Store an API-key credential through the real route, as the UI does. */
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

  /**
   * A tuple this install really can run. `deepseek-v4-flash` is the shipped
   * dual-harness model, so it is also what makes "the role names its harness"
   * (req 6) mean something here rather than being derivable.
   */
  const PINNED = {
    kind: "pinned",
    harnessId: "claude",
    serviceId: "deepseek",
    billingMode: "key",
    modelId: "deepseek-v4-flash",
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

    // The response carries the RESOLUTION — the tab renders straight off this.
    const answered = res.json().roles as RoleView[];
    const created = answered.find((r) => r.name === "deep dive");
    expect(created?.resolved).toMatchObject({
      harnessId: "claude",
      serviceId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    expect(created?.description).toBe("The thorough one");

    // The STORE holds it, and a fresh bootstrap agrees with the response.
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

  /**
   * Req 6 at the API edge — and the reason the harness is stored rather than
   * derived. `max` is a level Claude Code declares and Codex does not, and
   * `deepseek-v4-flash` runs on both, so only a role that NAMES its harness can
   * be checked against the right level set.
   */
  it("refuses a level the named harness does not declare, naming the parameter", async () => {
    await addCredential("deepseek");
    const res = await put({
      "deep dive": { params: { ...PINNED, harnessId: "codex", reasoningEffort: "max" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("max");
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
    // Still synthesized, still automatic — the metadata is the only stored half.
    expect(credentialStore.getRole("reviewer")?.params).toEqual({ kind: "auto" });
  });

  /**
   * The save's boundary, stated as a test: it checks the harness is installed,
   * can carry the model, and that this install holds a credential for the
   * `(service, billing mode)` — and stops there. Whether that credential can be
   * ROUTED right now is a run-time fact that changes without anyone editing a
   * role (a subscription's quota resets), so requiring a live route at save
   * would refuse a perfectly good role during an outage.
   */
  it("refuses a tuple this install has no credential for", async () => {
    const res = await put({ "deep dive": { params: PINNED } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("DeepSeek");
  });
});
