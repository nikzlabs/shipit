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
 * **What each test here is actually guarding, stated because it is not obvious
 * from the names.** The respawn and the per-turn route resolution are the
 * spawn-shaping mechanism (phase 3, reshaped by docs/260 — selection is
 * per-turn and threads a turn-route VALUE; the session row pins nothing);
 * these two cases would pass with phase 4's handler changes reverted, and they
 * are here as the end-to-end proof that the picker acting on a LIVE session
 * reaches that mechanism at all — which nothing else asserted. The refusal and
 * atomicity cases are phase 4's own and fail without it. The rules themselves
 * are unit-tested in `model-switch.test.ts`.
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
    for (const name of ["OPENROUTER_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]) {
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
    // docs/252 phase 9 — declare BOTH harnesses for this suite rather than
    // letting the registry probe `$PATH`. The atomicity case below needs the
    // cross-harness self-heal to be *reachable*, which needs Codex installed —
    // and whether a CI runner has the CLIs on its `$PATH` is not something a
    // test about billing should depend on. It failed in CI for exactly that
    // reason and passed here. `SHIPIT_AGENTS_INSTALL_REPORT` is the seam the
    // installer and the reader already share, so this pins the *declared* set
    // the way a real image build does rather than stubbing the registry and
    // re-deriving its eligibility wiring.
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

  it("resolves each turn's credential against the CURRENT service, with no session-row pin (docs/260-turn-level-account-routing reqs 1-2)", async () => {
    // docs/260 — selection happens per turn and produces a turn-route VALUE
    // threaded to spawn shaping; `sessions.provider_route_*` has no routing
    // reads or writes left. The docs/252 hazard this test used to pin at the
    // session row ("the old service's key must not authenticate a turn at the
    // new endpoint") is now held per-turn: there is no pinned route to go
    // stale, so the observable is the spawn itself — which service, which
    // endpoint, which credential variable each turn was actually shaped with.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("route-repin-session");
    // Turn one's spawn was shaped by that turn's own selection: OpenRouter's
    // endpoint, authenticated by OpenRouter's key.
    expect(claude1.lastServiceRouting?.serviceId).toBe("openrouter");
    expect(claude1.lastServiceRouting?.baseUrl).toBe(OPENROUTER_BASE);
    /**
     * docs/252 req 20 — **its own variable, not the mode's group name.** This
     * asserted `OPENROUTER_API_KEY` while a deployment variable produced no
     * stored row and the group name was the only name it had. Adoption gives it
     * a row at boot, `collectServiceCredentialEnv` writes a per-route variable
     * for every stored string credential, and spawn shaping sources the pinned
     * route's own — which is what stops a turn authenticating with a different
     * credential than the one it is attributed to once a second is added. The
     * changed expectation IS the requirement.
     */
    expect((claude1.lastServiceRouting as AnyMsg)?.credentialSourceEnv)
      .toBe("SHIPIT_CREDENTIAL_ENV_OPENROUTER_API_KEY");
    claude1.emit("event", {
      type: "result",
      subtype: "success",
      session_id: "route-repin-session",
      duration_ms: 100,
    });
    await drainUntil(client, (m) => m.type === "session_status" && (m as AnyMsg).running === false);

    // req 2 — nothing pinned the session to the credential the turn used: the
    // route columns stay empty even after a completed turn.
    const sessionId = sessionManager.list()[0]!.id;
    const afterTurnOne = sessionManager.get(sessionId);
    expect(afterTurnOne?.providerRouteId).toBeUndefined();
    expect(afterTurnOne?.providerRouteServiceId).toBeUndefined();

    client.send({ type: "set_model", model: MODEL, serviceId: "vercel", billingMode: "key" });
    // Wait for the confirmation, which is sent after the selection write.
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(sessionManager.get(sessionId)?.serviceId).toBe("vercel");

    // req 1 — the next turn re-runs selection against the NEW service: the
    // fresh spawn goes to Vercel's endpoint on Vercel's key. With no pinned
    // route there is nothing stale for env-prep to reuse, so the old
    // service's key structurally cannot authenticate this turn.
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
    // Reported as a notice on the authoritative selection, not as an `error`:
    // the picker has to be told to drop its optimistic pick, and an `error`
    // renders an assistant bubble nothing persists.
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

    // Unchanged — not moved to the subscription, and not to any other service
    // that happens to offer the id.
    const after = sessionManager.get(sessionId);
    expect(after?.serviceId).toBe("openrouter");
    expect(after?.billingMode).toBe("key");
    expect(after?.model).toBe(MODEL);

    client.close();
  });

  it("refuses ATOMICALLY — a rejected pick does not leave the harness switched", async () => {
    // `set_model` self-heals a cross-harness pick by switching the harness
    // first. Verifying the triple after that made "refused" a request that had
    // still moved the session to the other harness and reset its reasoning —
    // two changes the user did not ask for, on a request that reported failure.
    // Found by cross-backend review; the fix is to decide before mutating.
    const client = await TestClient.connect(port);
    await client.receive(); // preview_status

    client.send({ type: "set_model", model: MODEL, serviceId: "openrouter", billingMode: "key" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    const sessionId = sessionManager.list()[0]!.id;
    expect(sessionManager.get(sessionId)?.agentId).toBe("claude");

    // A model Codex DOES own here (Vercel's `openai/gpt-5.6-sol`), named with a
    // service that does not carry that id — so the self-heal would switch the
    // harness to Codex and the triple is then refused.
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
