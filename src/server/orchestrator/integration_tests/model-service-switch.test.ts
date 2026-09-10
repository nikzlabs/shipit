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
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";

type AnyMsg = any;

const MODEL = "anthropic/claude-opus-5";
const OPENROUTER_BASE = "https://openrouter.ai/api";
const VERCEL_BASE = "https://ai-gateway.vercel.sh";

describe("Integration: mid-session model switching across services (docs/252 phase 4)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let sessionManager: SessionManager;
  let lastClaude: FakeClaudeProcess = null as any;
  let dbManager: DatabaseManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const name of ["OPENROUTER_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]) {
      savedEnv[name] = process.env[name];
      process.env[name] = `test-${name}`;
    }
    // Keep only the stub subscription eligible for Anthropic.
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-switch-"));
    credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);
    // Enable both harnesses without depending on the host's installed CLIs.
    savedEnv.SHIPIT_AGENTS_INSTALL_REPORT = process.env.SHIPIT_AGENTS_INSTALL_REPORT;
    const reportPath = path.join(tmpDir, "installed.json");
    fs.writeFileSync(reportPath, JSON.stringify({ harnesses: ["claude", "codex"] }));
    process.env.SHIPIT_AGENTS_INSTALL_REPORT = reportPath;

    sessionManager = new SessionManager(dbManager);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as any;
      },
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
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key set is this suite's own literal list.
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

  it("respawns on the newly picked SERVICE even though the model id is unchanged", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("cross-service-session");
    expect(claude1.lastModel).toBe(MODEL);
    expect(claude1.lastServiceRouting?.serviceId).toBe("openrouter");
    expect(claude1.lastServiceRouting?.baseUrl).toBe(OPENROUTER_BASE);

    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "cross-service-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);
    expect(claude1.killed).toBe(false);

    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    client.send({ type: "send_message", text: "Turn two" });

    const claude2 = await waitForClaude(() => lastClaude, claude1);
    expect(claude2.lastModel).toBe(MODEL);
    expect(claude2.lastServiceRouting?.serviceId).toBe("vercel");
    expect(claude2.lastServiceRouting?.baseUrl).toBe(VERCEL_BASE);
    expect(claude2.lastServiceRouting?.billingMode).toBe("key");
    expect(claude1.killed).toBe(true);
    expect(claude1.stdinData.some((d) => d.includes("Turn two"))).toBe(false);

    client.close();
  });

  it("resolves each turn's credential against the CURRENT service, with no session-row pin (docs/260-turn-level-account-routing reqs 1-2)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("route-repin-session");
    expect(claude1.lastServiceRouting?.serviceId).toBe("openrouter");
    expect(claude1.lastServiceRouting?.baseUrl).toBe(OPENROUTER_BASE);
    expect((claude1.lastServiceRouting as AnyMsg)?.credentialSourceEnv)
      .toBe("SHIPIT_CREDENTIAL_ENV_OPENROUTER_API_KEY");
    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "route-repin-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    const sessionId = sessionManager.list()[0]!.id;
    const afterTurnOne = sessionManager.get(sessionId);
    expect(afterTurnOne?.providerRouteId).toBeUndefined();
    expect(afterTurnOne?.providerRouteServiceId).toBeUndefined();

    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(sessionManager.get(sessionId)?.serviceId).toBe("vercel");

    client.send({ type: "send_message", text: "Turn two" });
    const claude2 = await waitForClaude(() => lastClaude, claude1);
    expect(claude2.lastServiceRouting?.serviceId).toBe("vercel");
    expect(claude2.lastServiceRouting?.baseUrl).toBe(VERCEL_BASE);
    expect((claude2.lastServiceRouting as AnyMsg)?.credentialSourceEnv).toBe("SHIPIT_CREDENTIAL_ENV_VERCEL_AI_GATEWAY_API_KEY");
    expect(sessionManager.get(sessionId)?.providerRouteId).toBeUndefined();

    client.close();
  });

  it("confirms the authoritative selection so the picker cannot sit on the old service", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    const confirmation = await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(confirmation.selection).toEqual({
      serviceId: "vercel",
      billingMode: "key",
      modelId: MODEL,
    });
    expect(confirmation.notice).toBeUndefined();

    client.close();
  });

  it("REFUSES a mode with no credential instead of silently re-resolving the id", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    const sessionId = sessionManager.list()[0]!.id;

    client.send({
      type: "set_model",
      model: "claude-opus-5",
      serviceId: "anthropic",
      billingMode: "key",
    });
    const refusal = await drainUntil(
      client,
      (m) => m.type === "model_selection_changed" && !!(m as AnyMsg).notice,
    );
    expect(refusal.notice).toContain("anthropic");
    expect(refusal.selection).toEqual({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: MODEL,
    });

    const after = sessionManager.get(sessionId);
    expect(after?.serviceId).toBe("openrouter");
    expect(after?.billingMode).toBe("key");
    expect(after?.model).toBe(MODEL);

    client.close();
  });

  it("refuses ATOMICALLY — a rejected pick does not leave the harness switched", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    const sessionId = sessionManager.list()[0]!.id;
    expect(sessionManager.get(sessionId)?.agentId).toBe("claude");

    client.send({
      type: "set_model",
      model: "openai/gpt-5.6-sol",
      serviceId: "openai",
      billingMode: "key",
    });
    await drainUntil(
      client,
      (m) => m.type === "model_selection_changed" && !!(m as AnyMsg).notice,
    );

    const after = sessionManager.get(sessionId);
    expect(after?.agentId).toBe("claude");
    expect(after?.serviceId).toBe("openrouter");
    expect(after?.model).toBe(MODEL);

    client.close();
  });
});
