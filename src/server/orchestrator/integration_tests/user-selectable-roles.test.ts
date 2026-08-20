/**
 * docs/272-user-selectable-roles — **a role the user starts, end to end.**
 *
 * The unit tests own the rules (`services/session-role.test.ts`). What only an
 * integration test can show is that the three things a role has to do actually
 * happen to a live session through the WS the composer speaks:
 *
 *  - selecting one **seeds the session** — harness, model selection, level —
 *    and records the name the composer shows (reqs 1, 5);
 *  - moving any one of those three **leaves the role** (req 15), which is the
 *    only way a role is left and the thing that keeps the name honest (req 13);
 *  - the seed on the connect URL **starts the next new session on it** (req 12),
 *    overriding the harness/model/reasoning seeds that ride beside it.
 *
 * Plus the two refusals that must leave the session untouched: the reviewer
 * (req 10) and a session that has already taken its first turn (req 4).
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
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import type { CredentialStore } from "../credential-store.js";
import { DatabaseManager } from "../../shared/database.js";

type AnyMsg = any;

/** Reachable on the Claude Code harness with the gateway key configured below. */
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
    // Both gateway keys: the model-switch case below moves the session to the
    // OTHER service, and a switch the server would refuse anyway proves nothing
    // about leaving a role — a refusal correctly leaves it exactly where it was.
    for (const name of ["OPENROUTER_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]) {
      savedEnv[name] = process.env[name];
      process.env[name] = `test-${name}`;
    }
    savedEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-roles-"));
    credentialStore = createTestCredentialStore(tmpDir);
    // Pin the declared harnesses rather than probing `$PATH`, for the reason
    // `model-service-switch.test.ts` states: whether a CI runner has the CLIs
    // installed is not something a test about role selection should depend on.
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
    await client.receive(); // preview_status

    client.send({ type: "set_role", roleName: "deep dive" });
    const echo = await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(echo).not.toBeNull();
    expect(echo.roleName).toBe("deep dive");
    expect(echo.agentId).toBe("claude");
    expect(echo.selection).toMatchObject({ serviceId: "openrouter", billingMode: "key" });
    expect(echo.reasoningEffort).toBe("high");

    // …and the row, which is what a reload and a session switch read.
    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBe("deep dive");
    expect(row?.agentId).toBe("claude");
    expect(row?.model).toBe(ROLE_MODEL);
    expect(row?.serviceId).toBe("openrouter");
    expect(row?.reasoningEffort).toBe("high");
    // The PROVENANCE is not written yet: it records what the session STARTED
    // as, and this session has not started (req 6, req 4).
    expect(row?.originRoleName).toBeUndefined();

    client.close();
  });

  it("leaves the role when the reasoning level moves, and only then (reqs 13, 15)", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");

    // Re-picking the level the role already set changes nothing, so it is not a
    // change: "Adjust parameters…" opens these very controls holding the role's
    // own values, and re-selecting one must not un-name the role.
    client.send({ type: "set_reasoning", effort: "high" });
    await drainUntil(client, (m) => m.type === "model_selection_changed");
    expect(sessionManager.get(client.sessionId!)?.roleName).toBe("deep dive");

    // Actually moving it is the whole of leaving the role.
    client.send({ type: "set_reasoning", effort: "low" });
    const after = await drainUntil(
      client,
      (m) => m.type === "model_selection_changed" && m.reasoningEffort === "low",
    );
    expect(after.roleName).toBeNull();
    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBeUndefined();
    // Nothing was put back: the session goes on running what the user chose.
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

    // The name is gone — and with it the standing instructions the first turn
    // would have carried, which is the whole point of the act: no parameter
    // carries them, so no parameter change can express this.
    const row = sessionManager.get(client.sessionId!);
    expect(row?.roleName).toBeUndefined();
    // …and NOTHING else moved. The role's values are the last thing the user
    // chose, so putting ShipIt's defaults back would undo a choice they did not
    // ask to undo.
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
    // Clearing is a choice of role, so it locks when the choice does: by now the
    // standing instructions have been delivered, and un-naming them afterwards
    // states nothing the transcript does not already show.
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
    // `agentPinned` IS "the first turn has started" — the same fact that makes
    // the harness irreversible.
    sessionManager.setAgentPinned(client.sessionId!);

    client.send({ type: "set_role", roleName: "deep dive" });
    const err = await drainUntil(client, (m) => m.type === "error");
    expect(err.message).toMatch(/before the session's first message/);
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();

    client.close();
  });

  it("starts the next new session on the remembered role, over the other seeds (req 12)", async () => {
    // The browser sends all four; the role is applied LAST and overrides the
    // three it replaced — they describe controls the user handed over to it.
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

  it("keeps a cleared role cleared across a reconnect that still seeds it (reqs 12, 18)", async () => {
    // The browser's seed lives inside a per-session memoized WebSocket URL, so a
    // socket that reconnects after the clear still carries the role's name. The
    // role is perfectly runnable — nothing downstream would refuse it — so
    // without the row remembering that the user chose NONE, the clear would
    // silently undo itself between here and the first message, standing
    // instructions and all.
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
    // …and picking the role again still works: "none" is a choice, not a ban.
    again.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(again, (m) => m.type === "model_selection_changed" && m.roleName === "deep dive");
    expect(sessionManager.get(sessionId)?.roleName).toBe("deep dive");
    again.close();
  });

  it("keeps the role's harness across a RECONNECT rather than re-deriving it (reqs 8, 13)", async () => {
    // The connect handler derives "which harness owns this model" and persists
    // it, which docs/252 made ambiguous: a model both harnesses list resolves to
    // whichever the registry names first. Left alone, a reconnect would move a
    // role-seeded session onto that harness and keep showing the role's name —
    // the session running something other than what the role says, with nothing
    // on screen to tell. A role in force means the row was written from ONE
    // tuple, so there is nothing to reconcile.
    const first = await TestClient.connect(port);
    await first.receive();
    first.send({ type: "set_role", roleName: "deep dive" });
    await drainUntil(first, (m) => m.type === "model_selection_changed");
    first.close();
    const sessionId = first.sessionId!;

    // Reconnect with a stale harness seed, exactly as a browser would.
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
    // Silently skipped: this is a page load, not an action. The user is told by
    // the composer showing the ordinary controls instead of a name that lies.
    expect(sessionManager.get(client.sessionId!)?.roleName).toBeUndefined();
    client.close();
  });
});
