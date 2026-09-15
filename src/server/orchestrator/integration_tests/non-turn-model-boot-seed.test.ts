import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

// Avoid spawning npm.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import type { FastifyInstance } from "fastify";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { createStringCredential } from "../services/credential-routes.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";

/**
 * Boot is one of the two moments a background-work pin is written — the other is
 * a credential or account change (planning#578). It matters on its own because
 * an install can reach a running orchestrator with credentials and no pin
 * without anyone touching Settings: they came from the environment, or they
 * predate the setting. Before this, the first *read* of the settings payload
 * covered that case, which is what made a read write.
 */

let app: FastifyInstance | undefined;
let dbManager: DatabaseManager | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  dbManager?.close();
  dbManager = undefined;
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

async function bootWith(
  prepare: (store: CredentialStore) => void,
  agentRegistry?: AgentRegistry,
): Promise<CredentialStore> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-boot-seed-"));
  dirs.push(tmpDir);
  initGlobalGitConfig(tmpDir);
  setGitIdentity("Test User", "test@test.com");
  const credentialStore = new CredentialStore(tmpDir);
  prepare(credentialStore);

  dbManager = createTestDatabaseManager();
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
    ...(agentRegistry ? { agentRegistry } : {}),
  });
  return credentialStore;
}

describe("the background-work pin is seeded at boot", () => {
  it("pins the first eligible model for credentials that were already there", async () => {
    const store = await bootWith((s) => {
      createStringCredential(s, {
        serviceId: "deepseek",
        billingMode: "key",
        secret: "sk-test-deepseek",
      });
      expect(s.getNonTurnModel()).toBeUndefined();
    });

    // Asserted with no request made: the pin is the boot's work, not a read's.
    expect(store.getNonTurnModel()).toMatchObject({ serviceId: "deepseek", billingMode: "key" });
  });

  it("writes nothing when the install has no credential to run background work on", async () => {
    const store = await bootWith(() => {});

    expect(store.getNonTurnModel()).toBeUndefined();
  });

  /*
    The other seeding moment, over a real route. Boot leaves this install
    unseeded because it has nothing eligible, so the pin here can only come from
    the credential write — which is what docs/252-custom-models req 9 asks for:
    the first service configured fills the setting in, without waiting for a
    restart or for anyone to read the settings.
  */
  it("pins on the credential write that first makes something eligible", async () => {
    const store = await bootWith(() => {});
    expect(store.getNonTurnModel()).toBeUndefined();

    const res = await app!.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId: "deepseek", billingMode: "key", secret: "sk-test-deepseek" },
    });

    expect(res.statusCode).toBe(200);
    expect(store.getNonTurnModel()).toMatchObject({ serviceId: "deepseek", billingMode: "key" });
  });

  /*
    The ordering the boot seed depends on, with an observable that can fail on
    it. The tests above cannot: DeepSeek's key is directly callable, so it seeds
    with no harness at all and would still seed if the call moved ahead of
    `agentRegistry.detect()`. GLM's coding plan has no `directCall` and is
    carried by Claude Code, so seeding it requires a registry that has already
    been probed — before `detect()` the registry lists nothing, every harness
    reads as absent, and req 9's fill-in silently does not happen for every
    subscription-only install.
  */
  it("seeds a harness-carried credential, so detection has already run", async () => {
    const store = await bootWith(
      (s) => {
        createStringCredential(s, {
          serviceId: "zai",
          billingMode: "sub",
          secret: "zai-coding-plan-key",
        });
      },
      new AgentRegistry({ declaredHarnesses: () => ["claude"] }),
    );

    expect(store.getNonTurnModel()).toMatchObject({ serviceId: "zai", billingMode: "sub" });
  });

  it("writes nothing when the only credential needs a harness this install lacks", async () => {
    const store = await bootWith(
      (s) => {
        createStringCredential(s, {
          serviceId: "zai",
          billingMode: "sub",
          secret: "zai-coding-plan-key",
        });
      },
      new AgentRegistry({ declaredHarnesses: () => [] }),
    );

    expect(store.getNonTurnModel()).toBeUndefined();
  });

  it("leaves a pin the user already chose", async () => {
    const chosen = { serviceId: "zai", billingMode: "key" as const, modelId: "glm-5.2" };
    const store = await bootWith((s) => {
      createStringCredential(s, {
        serviceId: "deepseek",
        billingMode: "key",
        secret: "sk-test-deepseek",
      });
      s.setNonTurnModel(chosen);
    });

    expect(store.getNonTurnModel()).toEqual(chosen);
  });
});
