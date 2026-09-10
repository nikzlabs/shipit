import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";

import type { FastifyInstance } from "fastify";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";

type AnyMsg = any;

const ROLE_MODEL = "anthropic/claude-opus-5";

describe("Integration: user-selectable roles (docs/272)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let dbManager: DatabaseManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    // Both services must be eligible for the model-switch test.
    for (const name of ["OPENROUTER_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]) {
      savedEnv[name] = process.env[name];
      process.env[name] = `test-${name}`;
    }
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-roles-"));
    credentialStore = createTestCredentialStore(tmpDir);
    // Make harness availability independent of the host's installed CLIs.
    savedEnv.SHIPIT_AGENTS_INSTALL_REPORT = process.env.SHIPIT_AGENTS_INSTALL_REPORT;
    const reportPath = path.join(tmpDir, "installed.json");
    fs.writeFileSync(reportPath, JSON.stringify({ harnesses: ["claude", "codex"] }));
    process.env.SHIPIT_AGENTS_INSTALL_REPORT = reportPath;

    credentialStore.setRole("deep dive", {
      name: "deep dive",
      description: "Long-form investigation",
      prompt: "Read the whole subsystem before proposing anything.",
      params: {
        kind: "pinned",
        harnessId: "claude",
        serviceId: "openrouter",
        billingMode: "key",
        modelId: ROLE_MODEL,
        reasoningEffort: "high",
      },
    });

    sessionManager = new SessionManager(dbManager);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => new FakeClaudeProcess() as any,
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const match = /:(\d+)$/.exec(address);
    port = match ? Number(match[1]) : 0;
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- this suite's own literal key set.
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  async function createOpsSession(): Promise<{ id: string; kind?: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/new/template",
      payload: { templateId: "ops" },
    });
    const body = res.json() as { session?: { id: string; kind?: string } };
    if (!body.session) throw new Error(`ops session creation failed: ${res.body}`);
    return body.session;
  }

  async function drainUntil(
    client: TestClient,
    predicate: (m: AnyMsg) => boolean,
    maxMsgs = 30,
    timeoutMs = 2000,
  ): Promise<AnyMsg> {
    for (let i = 0; i < maxMsgs; i++) {
      const msg: AnyMsg = await client.receive(timeoutMs);
      if (predicate(msg)) return msg;
    }
    return null;
  }

  it("seeds the session from the role and names it back (reqs 1, 5)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_role", roleName: "deep dive" });
    const echo = await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(echo).not.toBeNull();
    expect(echo.roleName).toBe("deep dive");
    expect(echo.agentId).toBe("claude");
    expect(echo.selection).toMatchObject({ serviceId: "openrouter", billingMode: "key" });
    expect(echo.reasoningEffort).toBe("high");

    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBe("deep dive");
    expect(row?.agentId).toBe("claude");
    expect(row?.model).toBe(ROLE_MODEL);
    expect(row?.serviceId).toBe("openrouter");
    expect(row?.reasoningEffort).toBe("high");
    expect(row?.originRoleName).toBeUndefined();

    client.close();
  });

  it("leaves the role when the reasoning level moves, and only then (reqs 13, 15)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");

    client.send({ type: "set_reasoning", effort: "high" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(sessionManager.get(client.sessionId!)?.roleName).toBe("deep dive");

    client.send({ type: "set_reasoning", effort: "low" });
    const after = await drainUntil(
      client,
      (m) => m.type === "model_selection_changed" && m.reasoningEffort === "low",
    );
    expect(after.roleName).toBeNull();
    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBeUndefined();
    expect(row?.reasoningEffort).toBe("low");
    expect(row?.model).toBe(ROLE_MODEL);

    client.close();
  });

  it("leaves the role when the model moves (req 15)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    client.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");

    client.send({
      type: "set_model",
      model: ROLE_MODEL,
      serviceId: "vercel",
      billingMode: "key",
    });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();

    client.close();
  });

  it("clears the role and leaves the parameters where the role put them (req 18)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    client.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");

    client.send({ type: "set_role", roleName: null });
    const echo = await drainUntil(
      client,
      (m) => m.type === "model_selection_changed" && m.roleName === null,
    );
    expect(echo).not.toBeNull();

    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBeUndefined();
    expect(row?.agentId).toBe("claude");
    expect(row?.model).toBe(ROLE_MODEL);
    expect(row?.serviceId).toBe("openrouter");
    expect(row?.billingMode).toBe("key");
    expect(row?.reasoningEffort).toBe("high");

    client.close();
  });

  it("refuses to clear the role once the session has taken its first turn (reqs 4, 18)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    client.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    sessionManager.setAgentPinned(client.sessionId!);

    client.send({ type: "set_role", roleName: null });
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err.message).toMatch(/before the session's first message/);
    expect(sessionManager.get(client.sessionId!)?.roleName).toBe("deep dive");

    client.close();
  });

  it("refuses the reviewer without touching the session (req 10)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_role", roleName: "reviewer" });
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err.message).toMatch(/furthest from whatever produced the work/);
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();

    client.close();
  });

  it("refuses an unknown role and names the ones that exist", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_role", roleName: "deap dive" });
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err.message).toContain("deep dive");
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();

    client.close();
  });

  it("refuses a role once the session has taken its first turn (req 4)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();
    sessionManager.setAgentPinned(client.sessionId!);

    client.send({ type: "set_role", roleName: "deep dive" });
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err.message).toMatch(/before the session's first message/);
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();

    client.close();
  });

  it("starts the next new session on the remembered role, over the other seeds (req 12)", async () => {
    const client = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: "gpt-5-codex",
      reasoning: "low",
      role: "deep dive",
    });
    await client.receive();

    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBe("deep dive");
    expect(row?.agentId).toBe("claude");
    expect(row?.model).toBe(ROLE_MODEL);
    expect(row?.reasoningEffort).toBe("high");

    client.close();
  });

  it("tells the connecting viewer about the role it just seeded (reqs 12, 13)", async () => {
    const client = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: "gpt-5-codex",
      reasoning: "low",
      role: "deep dive",
    });
    const answer: AnyMsg = await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(answer).toBeTruthy();
    expect(answer.sessionId).toBe(client.sessionId);
    expect(answer.roleName).toBe("deep dive");
    expect(answer.agentId).toBe("claude");
    expect(answer.modelId).toBe(ROLE_MODEL);
    expect(answer.reasoningEffort).toBe("high");
    expect(answer.selection?.serviceId).toBe("openrouter");
    expect(answer.selection?.billingMode).toBe("key");

    client.close();
  });

  it("tells the viewer about the role it seeded onto an OPS session (docs/128)", async () => {
    const created = await createOpsSession();
    expect(created.kind).toBe("ops");

    const client = await TestClient.connect(port, created.id, { role: "deep dive" });
    const answer: AnyMsg = await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(answer).toBeTruthy();
    expect(answer.roleName).toBe("deep dive");
    expect(sessionManager.get(created.id)?.roleName).toBe("deep dive");
    expect(sessionManager.get(created.id)?.kind).toBe("ops");

    client.close();
  });

  it("says nothing about the selection on a connect that seeds no role", async () => {
    const first = await TestClient.connect(port, undefined, { role: "deep dive" });
    await drainUntil(first, (m) => m.type === "model_selection_changed");
    const sessionId = first.sessionId!;
    first.close();

    const again = await TestClient.connect(port, sessionId, { role: "deep dive" });
    const seen: AnyMsg[] = [];
    for (let i = 0; i < 12; i++) {
      try {
        seen.push(await again.receive(400));
      } catch {
        break;
      }
    }
    expect(seen.map((m) => m.type)).not.toContain("model_selection_changed");
    again.close();
  });

  it("keeps a cleared role cleared across a reconnect that still seeds it (reqs 12, 18)", async () => {
    const first = await TestClient.connect(port, undefined, { role: "deep dive" });
    await first.receive();
    const sessionId = first.sessionId!;
    expect(sessionManager.get(sessionId)?.roleName).toBe("deep dive");
    first.send({ type: "set_role", roleName: null });
    await drainUntil(first, (m) => m.type === "model_selection_changed" && m.roleName === null);
    first.close();

    const again = await TestClient.connect(port, sessionId, { role: "deep dive" });
    await again.receive();
    expect(sessionManager.get(sessionId)?.roleName).toBeUndefined();
    again.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(again, (m) => m.type === "model_selection_changed" && m.roleName === "deep dive");
    expect(sessionManager.get(sessionId)?.roleName).toBe("deep dive");
    again.close();
  });

  it("keeps the role's harness across a RECONNECT rather than re-deriving it (reqs 8, 13)", async () => {
    const first = await TestClient.connect(port);
    await first.receive();
    first.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(first, (m) => m.type === "model_selection_changed");
    first.close();
    const sessionId = first.sessionId!;

    const again = await TestClient.connect(port, sessionId, { agent: "codex" });
    await again.receive();
    const row = sessionManager.get(sessionId);
    expect(row?.roleName).toBe("deep dive");
    expect(row?.agentId).toBe("claude");
    expect(row?.model).toBe(ROLE_MODEL);
    again.close();
  });

  it("ignores a seeded role that no longer resolves, rather than refusing the page (req 8)", async () => {
    const client = await TestClient.connect(port, undefined, {
      agent: "claude",
      role: "a role that was deleted",
    });
    await client.receive();
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();
    client.close();
  });
});
