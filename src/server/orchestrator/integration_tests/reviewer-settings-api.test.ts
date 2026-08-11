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

/**
 * docs/261 phase 3 (reqs 1, 5, 8) — the reviewer settings **over HTTP**.
 *
 * The unit tests exercise the projection and the validation directly, and the
 * component tests mock `fetch`, so between them **both suites pass if the route
 * forgets to forward or persist `reviewers` at all**. Cross-backend review
 * found that hole. This closes it end to end: real app, real route, real store,
 * one assertion per hop the value has to cross.
 */
describe("Integration: reviewer settings over HTTP (docs/261 phase 3)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;
  let savedOpenAIKey: string | undefined;
  let savedAnthropicKey: string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    // Both cleared so the install starts with NO credential — the reviewers are
    // then whatever this test seeds, not whatever the host happens to export.
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

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
    if (savedOpenAIKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
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

  async function bootstrapReviewers(): Promise<ReviewerSlotView[]> {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(res.statusCode).toBe(200);
    return res.json().settings.reviewers as ReviewerSlotView[];
  }

  /**
   * The whole hop chain in one test: the route accepts a pin, the STORE holds
   * it, and the RESPONSE carries the re-resolved pair. Any one of those being
   * dropped fails here — which is exactly what the mocked-`fetch` component
   * tests cannot see.
   */
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

    // The response carries the resolution — the tab renders straight off this.
    const answered = res.json().reviewers as ReviewerSlotView[];
    expect(answered[0].source).toBe("pinned");
    expect(answered[0].resolved?.modelId).toBe("claude-sonnet-5");
    expect(answered[0].resolved?.reasoningEffort).toBe("low");

    // The STORE holds a complete pin (req 8's atomicity, at the only layer that
    // can prove it), and a fresh bootstrap agrees with the response.
    expect(credentialStore.getReviewerPin("first")).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: "claude-sonnet-5",
      reasoningEffort: "low",
    });
    expect(await bootstrapReviewers()).toEqual(answered);
  });

  /**
   * Req 8's "pinning is atomic" at the API edge: the wire may omit the level —
   * the model-changed case — and the STORED pin is complete regardless, with
   * the level derived from the harness the server itself derived.
   */
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
    // Not merely present — a real level, and the same one the response reports.
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

  /**
   * **The partial-mutation bug, pinned.** Validating and writing in one loop
   * persisted `first` and then answered 400 for `second` — the caller told the
   * write failed while half of it landed. Found by cross-backend review; every
   * slot is now validated before any slot is written.
   */
  it("writes nothing when any slot in the request is invalid", async () => {
    await addCredential("anthropic");
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        reviewers: {
          first: { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" },
          // No credential for OpenAI on this install, so this slot is refused.
          second: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol" },
        },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(credentialStore.getReviewerPin("first")).toBeUndefined();
    expect(credentialStore.getReviewerPin("second")).toBeUndefined();
  });

  it.each([
    ["an unknown slot", { third: null }],
    ["a malformed pin", { first: { serviceId: "anthropic", billingMode: "key" } }],
    ["a level the derived harness does not offer", {
      first: {
        serviceId: "anthropic",
        billingMode: "key",
        modelId: "claude-opus-5",
        reasoningEffort: "minimal",
      },
    }],
  ])("refuses %s with a 400", async (_label, reviewers) => {
    await addCredential("anthropic");
    const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { reviewers } });
    expect(res.statusCode).toBe(400);
    expect(credentialStore.getReviewerPin("first")).toBeUndefined();
  });

  /**
   * The container itself. `null` is an object to `typeof` and reached
   * `Object.entries` as a 500; a scalar iterated to nothing and was accepted as
   * a silent no-op — a write the caller believes succeeded and that changed
   * nothing. Both are caller bugs and both now say so.
   */
  it.each([
    ["null", null],
    ["a scalar", 42],
    ["an array", []],
  ])("refuses a reviewers container that is %s", async (_label, reviewers) => {
    const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { reviewers } });
    expect(res.statusCode).toBe(400);
  });

  /**
   * Req 8's re-derivation, over the real stack: the same untouched
   * configuration answers differently once the install gains a service, with no
   * write and no migration.
   */
  it("re-derives an untouched slot when the install gains a service", async () => {
    await addCredential("anthropic");
    const oneService = await bootstrapReviewers();
    expect(oneService[1].resolved?.serviceId).toBe("anthropic");

    await addCredential("deepseek");
    const twoServices = await bootstrapReviewers();
    // A different family now exists, so slot 2 moves onto it — untouched, and
    // still reported as auto-configured.
    expect(twoServices[1].resolved?.serviceId).toBe("deepseek");
    expect(twoServices.map((r) => r.source)).toEqual(["auto", "auto"]);
    expect(credentialStore.getReviewerPin("second")).toBeUndefined();
  });

  /**
   * The re-broadcast carrier. `plan.md` claims the reviewer resolution rides
   * the `agent_list` payload so an open tab follows a credential change — this
   * is the assertion that the payload actually carries it, which neither the
   * projection tests nor the store-mutating component test can make.
   */
  it("carries the resolution on the agent_list payload, not only on bootstrap", async () => {
    await addCredential("anthropic");
    const { buildAgentListPayload } = await import("../services/settings.js");
    const { AgentRegistry } = await import("../../shared/agent-registry.js");
    const payload = buildAgentListPayload(new AgentRegistry(), credentialStore, undefined);

    expect(payload.reviewers.map((r) => r.slot)).toEqual(["first", "second"]);
    expect(payload.reviewers).toEqual(await bootstrapReviewers());
  });
});
