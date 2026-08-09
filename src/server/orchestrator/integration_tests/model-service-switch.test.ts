/**
 * docs/252 phase 4 (req 4) — **switching model mid-session, across services.**
 *
 * The case that only exists once a model id stops identifying a service:
 * `anthropic/claude-opus-5` is offered by BOTH OpenRouter and Vercel AI
 * Gateway, on the same harness, at different endpoints and on different keys.
 * A switch between them changes everything about where the turn goes and
 * nothing about the model id — so every mechanism that keys on the id alone is
 * silently a no-op, and the failure is not a broken turn but a turn billed to
 * the service the user just moved away from (req 11).
 *
 * Phase 3 built the mechanism (the resident process's spawn identity is the
 * whole tuple, and the pinned credential route is invalidated on a
 * `(service, mode)` move). This suite is the end-to-end proof that the picker
 * acting on a LIVE session drives it.
 */
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

/** The two catalogue rows that share a model id. */
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
    // Two gateway keys, so both services are eligible on the Claude Code
    // harness (req 8). Delivered through the environment rather than the
    // credential store because `listConfiguredCredentials` reads both and the
    // env path needs no fixture.
    for (const name of ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"]) {
      savedEnv[name] = process.env[name];
      process.env[name] = `test-${name}`;
    }
    // Anthropic's METERED key is deliberately absent: the stub auth manager
    // makes `anthropic:sub` eligible, so the two modes of one service differ in
    // exactly the way the refusal test below needs.
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    dbManager = createTestDatabaseManager();
    lastClaude = null as any;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-switch-"));
    credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

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
    await client.receive(); // preview_status

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

    // The switch: same model id, different service. Under the pre-phase-3
    // identity (two model strings) this looked like no change at all — no kill,
    // and turn two would have been steered into the resident process still
    // pointed at OpenRouter.
    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    client.send({ type: "send_message", text: "Turn two" });

    const claude2 = await waitForClaude(() => lastClaude, claude1);
    expect(claude2.lastModel).toBe(MODEL);
    expect(claude2.lastServiceRouting?.serviceId).toBe("vercel");
    expect(claude2.lastServiceRouting?.baseUrl).toBe(VERCEL_BASE);
    // The credential goes with the endpoint: the previous service's key must
    // not authenticate a turn at the new one.
    expect(claude2.lastServiceRouting?.billingMode).toBe("key");
    expect(claude1.killed).toBe(true);
    expect(claude1.stdinData.some((d) => d.includes("Turn two"))).toBe(false);

    client.close();
  });

  it("re-pins the credential route to the new service rather than reusing the old one", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("route-repin-session");
    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "route-repin-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    const sessionId = sessionManager.list()[0]!.id;
    const pinnedFirst = sessionManager.get(sessionId);
    expect(pinnedFirst?.providerRouteServiceId).toBe("openrouter");

    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    // Wait for the confirmation, which is sent after the write.
    await drainUntil(client, (m) => m.type === "model_selection_changed");

    const afterSwitch = sessionManager.get(sessionId);
    expect(afterSwitch?.serviceId).toBe("vercel");
    // A route belongs to a `(service, billing mode)`. Environment preparation
    // reuses a pinned route unconditionally, so leaving OpenRouter's in place
    // would authenticate the next turn — at Vercel's endpoint — with
    // OpenRouter's key.
    expect(afterSwitch?.providerRouteId).toBeUndefined();

    client.close();
  });

  it("confirms the authoritative selection so the picker cannot sit on the old service", async () => {
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    const confirmation = await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(confirmation.selection).toEqual({
      serviceId: "vercel",
      billingMode: "key",
      modelId: MODEL,
    });
    // The user asked for this one, so there is nothing to report.
    expect(confirmation.notice).toBeUndefined();

    client.close();
  });

  it("REFUSES a mode with no credential instead of silently re-resolving the id", async () => {
    // Anthropic's API key is not configured here while its subscription is, so
    // `(anthropic, key, claude-opus-5)` is a real catalogue row this install
    // cannot run. The pre-phase-4 fallback dropped the triple and re-resolved
    // the bare id biased toward the harness's own vendor — landing the session
    // on `(anthropic, sub, ...)`: a silent move ONTO a subscription the user did
    // not choose, which is the same cross-mode shift req 12 refuses on failover.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    const sessionId = sessionManager.list()[0]!.id;

    client.send({
      type: "set_model",
      model: "claude-opus-5",
      serviceId: "anthropic",
      billingMode: "key",
    });
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err.message).toContain("anthropic");

    // Unchanged — not moved to the subscription, and not to any other service
    // that happens to offer the id.
    const after = sessionManager.get(sessionId);
    expect(after?.serviceId).toBe("openrouter");
    expect(after?.billingMode).toBe("key");
    expect(after?.model).toBe(MODEL);

    client.close();
  });
});
