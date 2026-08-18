/**
 * planning#389 — **the harness the user picked survives the WS connect.**
 *
 * The connect handler reconciles a warm session's `(agent, model)` pair, and it
 * was the third copy of the docs/142 "derive the harness from the model" rule —
 * the one that never got the docs/252 correction its two siblings did
 * (`newSessionAgentId` client-side, `explicitAgentRunsModel` in
 * `createHeadlessSession`). Deriving a single "owner" for a model that three
 * harnesses can run answers with whichever the registry lists first, so an
 * explicitly picked harness was discarded, persisted, and pinned write-once on
 * the first turn while the composer went on displaying the pick.
 *
 * The row is what these assert on rather than which fake process ran: the row is
 * what the first turn pins, what a reload reads, and what the incident was
 * measured from.
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
import { DatabaseManager } from "../../shared/database.js";

/**
 * Three API styles (`services.ts`), so every shipped harness lists it and
 * `agentIdForModel` answers "claude" for all of them. This is the exact model
 * the incident was reproduced on.
 */
const SHARED_MODEL = "deepseek-v4-flash";
/** Anthropic-messages only, so Codex genuinely cannot run it — docs/142 Problem C. */
const CLAUDE_ONLY_MODEL = "claude-opus-5";
/** OpenAI styles only: Codex and OpenCode list it, Claude Code cannot run it. */
const OPENAI_STYLE_MODEL = "gpt-5.5";

describe("Integration: WS connect honours an explicit harness pick (planning#389)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessions: SessionManager;
  let dbManager: DatabaseManager;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    // A key per service so the model ids below are ELIGIBLE on every harness that
    // speaks their style — with a credential store wired, `capabilities.models`
    // is the eligible set, not the whole catalogue.
    for (const name of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      savedEnv[name] = process.env[name];
      process.env[name] = `test-${name}`;
    }
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-connect-harness-"));

    // Pin the declared harnesses rather than probing `$PATH`: whether a CI runner
    // has the CLIs installed is not something this test should depend on, and the
    // guard under test asks whether the picked harness is installed.
    savedEnv.SHIPIT_AGENTS_INSTALL_REPORT = process.env.SHIPIT_AGENTS_INSTALL_REPORT;
    const reportPath = path.join(tmpDir, "installed.json");
    fs.writeFileSync(reportPath, JSON.stringify({ harnesses: ["claude", "codex", "opencode"] }));
    process.env.SHIPIT_AGENTS_INSTALL_REPORT = reportPath;

    sessions = new SessionManager(dbManager);
    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: sessions,
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

  it("keeps an unpinned session on the picked harness when it can run the model", async () => {
    // The incident, exactly: OpenCode picked, a model all three harnesses list.
    // Before the fix the row came back `claude` — registry order — and the first
    // turn pinned it there for good.
    const client = await TestClient.connect(port, undefined, {
      agent: "opencode",
      model: SHARED_MODEL,
    });
    await client.receive(); // preview_status

    const row = sessions.get(client.sessionId!);
    expect(row?.agentId).toBe("opencode");
    expect(row?.model).toBe(SHARED_MODEL);
    // Nothing was rerouted, so there is nothing to announce.
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("keeps the session's OWN harness on a reconnect that carries no agent param", async () => {
    // The same bug without a query param to blame: a session already on OpenCode
    // (headless creation writes the row before the first turn pins it) reconnects,
    // and the derivation moved it to Claude Code on registry order alone.
    sessions.track("s-opencode");
    sessions.setAgentId("s-opencode", "opencode");
    sessions.setModel("s-opencode", SHARED_MODEL, "deepseek");

    const client = await TestClient.connect(port, "s-opencode");
    await client.receive(); // preview_status

    const row = sessions.get("s-opencode");
    expect(row?.agentId).toBe("opencode");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("falls to the picked harness when the session's own row cannot run the model", async () => {
    // The row and the query param disagree exactly when the user has just moved
    // the model. Here the row still says Claude Code, which cannot speak an
    // OpenAI-style model at all, while the browser asks for OpenCode, which can.
    // Deriving an owner instead would answer `codex` on registry order — a third
    // harness nobody named.
    sessions.track("s-moved");
    sessions.setAgentId("s-moved", "claude");

    const client = await TestClient.connect(port, "s-moved", {
      agent: "opencode",
      model: OPENAI_STYLE_MODEL,
    });
    await client.receive(); // preview_status

    const row = sessions.get("s-moved");
    expect(row?.agentId).toBe("opencode");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("still refuses to pin a stale agent param that cannot run the model (docs/142 C)", async () => {
    // The case the derivation is genuinely right for, and the one the fix must not
    // regress: Codex and an Anthropic-messages-only model share no API style, so
    // the model wins and the session lands on Claude Code.
    const client = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: CLAUDE_ONLY_MODEL,
    });
    await client.receive(); // preview_status

    const row = sessions.get(client.sessionId!);
    expect(row?.agentId).toBe("claude");

    client.close();
  });

  it("tells the user when it reroutes off the harness they asked for (planning#389)", async () => {
    // A WS upgrade cannot answer a 400 the way `createHeadlessSession` does, so
    // this path keeps the reroute — and pays for it with a notice, because the
    // silent version is what planning#389 measured at $0.14 on the headless path.
    const client = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: CLAUDE_ONLY_MODEL,
    });
    await client.receive(); // preview_status

    const notice = sessions.get(client.sessionId!)?.pendingAgentNotice;
    expect(notice).toBeDefined();
    expect(notice).toContain("Codex");
    expect(notice).toContain("Claude Code");

    client.close();
  });

  it("does not announce a reroute that lands on the harness that was asked for", async () => {
    // The ordinary "user changed the model, so the harness followed" path: the
    // session row still names the old harness, the browser already applied the
    // client-side rule and asked for the new one, and they agree. Nothing to tell.
    sessions.track("s-followed");
    sessions.setAgentId("s-followed", "codex");

    const client = await TestClient.connect(port, "s-followed", {
      agent: "claude",
      model: CLAUDE_ONLY_MODEL,
    });
    await client.receive(); // preview_status

    const row = sessions.get("s-followed");
    expect(row?.agentId).toBe("claude");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("never re-derives the harness of a session running a role (docs/272 reqs 8, 13)", async () => {
    // docs/272's guard predates this fix and must survive it: all three of a
    // role's fields were written together from one tuple the user chose, so there
    // is nothing to reconcile — not even when the harness cannot run the model.
    sessions.track("s-role");
    sessions.setAgentId("s-role", "codex");
    sessions.setRoleName("s-role", "triage");
    sessions.setModel("s-role", CLAUDE_ONLY_MODEL, "anthropic");

    const client = await TestClient.connect(port, "s-role");
    await client.receive(); // preview_status

    const row = sessions.get("s-role");
    expect(row?.agentId).toBe("codex");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });
});
