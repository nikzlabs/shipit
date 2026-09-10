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
import type { ReviewerSlotView } from "../../shared/types/agent-types.js";

describe("Integration: reviewer settings over HTTP (docs/261 phase 3)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    // server-test-setup.ts isolates provider credentials between tests.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-reviewer-api-"));
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

  async function bootstrapReviewers(): Promise<ReviewerSlotView[]> {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    return res.json().settings.reviewers as ReviewerSlotView[];
  }

  it("round-trips a pin through the route, the store and the response", async () => {
    await addCredential("anthropic");

    const before = await bootstrapReviewers();
    expect(before.map((r) => r.source)).toEqual(["auto", "auto"]);
    const target = before[0].resolved;
    expect(target, "an install with a credential must resolve a reviewer").toBeTruthy();

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        reviewers: {
          first: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-sonnet-5",
            reasoningEffort: "low",
          },
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const answered = res.json().reviewers as ReviewerSlotView[];
    expect(answered[0].source).toBe("pinned");
    expect(answered[0].resolved?.modelId).toBe("claude-sonnet-5");
    expect(answered[0].resolved?.reasoningEffort).toBe("low");

    expect(credentialStore.getReviewerPin("first")).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-sonnet-5",
      reasoningEffort: "low",
    });
    expect(await bootstrapReviewers()).toEqual(answered);
  });

  it("stores a complete pin when the level is omitted", async () => {
    await addCredential("anthropic");
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        reviewers: {
          first: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const stored = credentialStore.getReviewerPin("first");
    expect(stored?.modelId).toBe("claude-opus-5");
    expect(stored?.reasoningEffort).toBeTruthy();
    expect((res.json().reviewers as ReviewerSlotView[])[0].resolved?.reasoningEffort).toBe(
      stored?.reasoningEffort,
    );
  });

  it("returns a slot to auto-configuration with null", async () => {
    await addCredential("anthropic");
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        reviewers: {
          first: { serviceId: "anthropic", billingMode: "key", modelId: "claude-sonnet-5" },
        },
      },
    });
    expect(credentialStore.getReviewerPin("first")).toBeTruthy();

    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { reviewers: { first: null } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(credentialStore.getReviewerPin("first")).toBeUndefined();
    expect((res.json().reviewers as ReviewerSlotView[])[0].source).toBe("auto");
  });

  it("writes nothing when any slot in the request is invalid", async () => {
    await addCredential("anthropic");
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        reviewers: {
          first: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
          second: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol" },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(credentialStore.getReviewerPin("first")).toBeUndefined();
    expect(credentialStore.getReviewerPin("second")).toBeUndefined();
  });

  it("re-derives a level the derived selection does not offer, and says what it stored", async () => {
    await addCredential("anthropic");
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        reviewers: {
          first: {
            serviceId: "anthropic",
            billingMode: "key",
            modelId: "claude-opus-5",
            reasoningEffort: "minimal",
          },
        },
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const stored = credentialStore.getReviewerPin("first");
    expect(stored?.modelId).toBe("claude-opus-5");
    expect(stored?.reasoningEffort).toBeTruthy();
    expect(stored?.reasoningEffort).not.toBe("minimal");
    expect((res.json().reviewers as ReviewerSlotView[])[0].resolved?.reasoningEffort).toBe(
      stored?.reasoningEffort,
    );
  });

  it.each([
    ["an unknown slot", { third: null }],
    ["a malformed pin", { first: { serviceId: "anthropic", billingMode: "key" } }],
  ])("refuses %s with a 400", async (_label, reviewers) => {
    await addCredential("anthropic");
    const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { reviewers } });
    expect(res.statusCode).toBe(400);
    expect(credentialStore.getReviewerPin("first")).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["a scalar", 42],
    ["an array", []],
  ])("refuses a reviewers container that is %s", async (_label, reviewers) => {
    const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { reviewers } });
    expect(res.statusCode).toBe(400);
  });

  it("re-derives an untouched slot when the install gains a service", async () => {
    await addCredential("anthropic");
    const oneService = await bootstrapReviewers();
    expect(oneService[1].resolved?.serviceId).toBe("anthropic");

    await addCredential("deepseek");
    const twoServices = await bootstrapReviewers();
    expect(twoServices[1].resolved?.serviceId).toBe("deepseek");
    expect(twoServices.map((r) => r.source)).toEqual(["auto", "auto"]);
    expect(credentialStore.getReviewerPin("second")).toBeUndefined();
  });

  it("carries the resolution on the agent_list payload, not only on bootstrap", async () => {
    await addCredential("anthropic");
    const { buildAgentListPayload } = await import("../services/settings.js");
    const { AgentRegistry } = await import("../../shared/agent-registry.js");
    const payload = buildAgentListPayload(new AgentRegistry(), credentialStore, undefined);

    expect(payload.reviewers.map((r) => r.slot)).toEqual(["first", "second"]);
    expect(payload.reviewers).toEqual(await bootstrapReviewers());
  });
});
