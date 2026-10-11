import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { DatabaseManager } from "../../shared/database.js";
import type { ServiceMcpServer } from "../../shared/types.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

interface AnyMsg { type: string; running?: boolean }

/** docs/327 — a resident agent holds the MCP servers it was spawned with. */
describe("Integration: declared MCP servers and the resident agent (docs/327)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let lastClaude: FakeClaudeProcess = null as unknown as FakeClaudeProcess;
  let declared: ServiceMcpServer[] = [];

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-mcp-resident-"));
    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);
    declared = [];
    lastClaude = null as unknown as FakeClaudeProcess;

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        lastClaude = new FakeClaudeProcess();
        return lastClaude as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    await app.close();
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(port);
    await client.receive();
    const runner = (app as unknown as { runnerRegistry: { get(id: string): SessionRunnerInterface | undefined } })
      .runnerRegistry.get(client.sessionId);
    if (!runner) throw new Error("no runner for the session");
    // The local runner has no Compose stack; stand in for what the container runner resolves.
    runner.serviceMcpServers = () => declared;
    return client;
  }

  async function finishTurn(client: TestClient, claude: FakeClaudeProcess, agentSession: string): Promise<void> {
    claude.emit("event", { type: "result", subtype: "success", session_id: agentSession, duration_ms: 1 });
    for (let i = 0; i < 30; i++) {
      const msg = (await client.receive(2000)) as AnyMsg;
      if (msg.type === "session_status" && msg.running === false) return;
    }
    throw new Error("the turn never finished");
  }

  it("respawns the resident with the new set when a server appears after the first spawn", async () => {
    const client = await connect();

    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("mcp-session");
    expect(claude1.lastServiceMcpServers).toBeUndefined();
    await finishTurn(client, claude1, "mcp-session");

    // The plugin's version went live after the first spawn.
    declared = [{ name: "verseshot", url: "http://verseshot:4300/mcp" }];
    client.send({ type: "send_message", text: "Turn two" });

    const claude2 = await waitForClaude(() => lastClaude, claude1);
    expect(claude1.killed).toBe(true);
    expect(claude2.lastServiceMcpServers).toEqual(declared);
    expect(claude2.lastPrompt).toContain("Turn two");
    await finishTurn(client, claude2, "mcp-session");

    client.close();
  });

  it("keeps the resident while the set is unchanged", async () => {
    declared = [{ name: "verseshot", url: "http://verseshot:4300/mcp" }];
    const client = await connect();

    client.send({ type: "send_message", text: "Turn one" });
    const claude1 = await waitForClaude(() => lastClaude);
    claude1.initSession("mcp-same-session");
    expect(claude1.lastServiceMcpServers).toEqual(declared);
    await finishTurn(client, claude1, "mcp-same-session");

    client.send({ type: "send_message", text: "Turn two" });
    const start = Date.now();
    while (!claude1.stdinData.some((d) => d.includes("Turn two"))) {
      if (Date.now() - start > 2000) throw new Error("Turn two never reached the resident");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(lastClaude).toBe(claude1);
    expect(claude1.killed).toBe(false);
    await finishTurn(client, claude1, "mcp-same-session");

    client.close();
  });
});
