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

const SHARED_MODEL = "deepseek-flash";
const CLAUDE_ONLY_MODEL = "claude-opus-5";
const OPENAI_STYLE_MODEL = "gpt-5.5";

describe("Integration: WS connect honours an explicit harness pick (planning#389)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let sessions: SessionManager;
  let dbManager: DatabaseManager;
  const savedEnv: Record<string, string | undefined> = {};

  // Rebuild the registry after changing its install report, retaining session rows.
  async function restartAppWith(harnesses: string[]): Promise<void> {
    await app.close();
    const reportPath = path.join(tmpDir, "installed.json");
    fs.writeFileSync(reportPath, JSON.stringify({ harnesses }));
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
  }

  beforeEach(async () => {
    // Supply credentials so model eligibility depends on harness support.
    for (const name of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      savedEnv[name] = process.env[name];
      process.env[name] = `test-${name}`;
    }
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-connect-harness-"));

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
    const client = await TestClient.connect(port, undefined, {
      agent: "opencode",
      model: SHARED_MODEL,
    });
    await client.receive();

    const row = sessions.get(client.sessionId!);
    expect(row?.agentId).toBe("opencode");
    expect(row?.model).toBe(SHARED_MODEL);
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("keeps the session's OWN harness on a reconnect that carries no agent param", async () => {
    sessions.track("s-opencode");
    sessions.setAgentId("s-opencode", "opencode");
    sessions.setModel("s-opencode", SHARED_MODEL, "deepseek");

    const client = await TestClient.connect(port, "s-opencode");
    await client.receive();

    const row = sessions.get("s-opencode");
    expect(row?.agentId).toBe("opencode");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("falls to the picked harness when the session's own row cannot run the model", async () => {
    sessions.track("s-moved");
    sessions.setAgentId("s-moved", "claude");

    const client = await TestClient.connect(port, "s-moved", {
      agent: "opencode",
      model: OPENAI_STYLE_MODEL,
    });
    await client.receive();

    const row = sessions.get("s-moved");
    expect(row?.agentId).toBe("opencode");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("still refuses to pin a stale agent param that cannot run the model (docs/142 C)", async () => {
    const client = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: CLAUDE_ONLY_MODEL,
    });
    await client.receive();

    const row = sessions.get(client.sessionId!);
    expect(row?.agentId).toBe("claude");

    client.close();
  });

  it("tells the user when it reroutes off the harness they asked for (planning#389)", async () => {
    const client = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: CLAUDE_ONLY_MODEL,
    });
    await client.receive();

    const notice = sessions.get(client.sessionId!)?.pendingAgentNotice;
    expect(notice).toBeDefined();
    expect(notice).toContain("Codex");
    expect(notice).toContain("Claude Code");

    client.close();
  });

  it("does not announce a reroute that lands on the harness that was asked for", async () => {
    sessions.track("s-followed");
    sessions.setAgentId("s-followed", "codex");

    const client = await TestClient.connect(port, "s-followed", {
      agent: "claude",
      model: CLAUDE_ONLY_MODEL,
    });
    await client.receive();

    const row = sessions.get("s-followed");
    expect(row?.agentId).toBe("claude");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });

  it("does not honour a picked harness this deployment did not install", async () => {
    await restartAppWith(["claude", "codex"]);

    const client = await TestClient.connect(port, undefined, {
      agent: "opencode",
      model: SHARED_MODEL,
    });
    await client.receive();

    const row = sessions.get(client.sessionId!);
    expect(row?.agentId).not.toBe("opencode");
    expect(row?.agentId).toBe("claude");

    client.close();
  });

  it("records the reroute notice once, not once per reconnect", async () => {
    const first = await TestClient.connect(port, undefined, {
      agent: "codex",
      model: CLAUDE_ONLY_MODEL,
    });
    await first.receive();
    const sessionId = first.sessionId!;
    const afterFirst = sessions.get(sessionId)?.pendingAgentNotice;
    expect(afterFirst).toBeDefined();
    first.close();

    const second = await TestClient.connect(port, sessionId, {
      agent: "codex",
      model: CLAUDE_ONLY_MODEL,
    });
    await second.receive();

    expect(sessions.get(sessionId)?.pendingAgentNotice).toBe(afterFirst);
    second.close();
  });

  it("never re-derives the harness of a session running a role (docs/272 reqs 8, 13)", async () => {
    sessions.track("s-role");
    sessions.setAgentId("s-role", "codex");
    sessions.setRoleName("s-role", "triage");
    sessions.setModel("s-role", CLAUDE_ONLY_MODEL, "anthropic");

    const client = await TestClient.connect(port, "s-role");
    await client.receive();

    const row = sessions.get("s-role");
    expect(row?.agentId).toBe("codex");
    expect(row?.pendingAgentNotice).toBeUndefined();

    client.close();
  });
});
