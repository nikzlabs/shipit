import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { SessionRunner } from "../session-runner.js";
import type { AuthManager } from "../agents/claude/auth-manager.js";
import type { DatabaseManager } from "../../shared/database.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitFor,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

type Attach = (this: SessionRunner) => Promise<boolean>;

describe("Integration: a composer message after a restart takes over the idle process (planning#700)", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let spawned: FakeClaudeProcess[];
  let resident: FakeClaudeProcess;
  let residentIdentity: () => string | undefined;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-idle-resident-"));
    spawned = [];
    resident = new FakeClaudeProcess();
    // What the container runner restores from the worker's report.
    const attach: Attach = async function () {
      if (this.getAgent()) return false;
      this.setAgent(resident as never);
      this.isStreamingActive = true;
      this.appliedSpawnIdentity = residentIdentity();
      return true;
    };
    (SessionRunner.prototype as unknown as { attachIdleResident: Attach }).attachIdleResident = attach;
    Object.defineProperty(SessionRunner.prototype, "residentToAttach", {
      configurable: true,
      get(this: SessionRunner) { return this.getAgent() === null; },
    });

    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: new ChatHistoryManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      agentFactory: () => {
        const agent = new FakeClaudeProcess();
        spawned.push(agent);
        return agent as never;
      },
      workspaceDir: tmpDir,
      serveStatic: false,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(/:(\d+)$/.exec(address)?.[1] ?? 0);
  });

  afterEach(async () => {
    Reflect.deleteProperty(SessionRunner.prototype, "attachIdleResident");
    Reflect.deleteProperty(SessionRunner.prototype, "residentToAttach");
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* cleanup only */ }
  });

  it("sends the message into the process it took over (req 1)", async () => {
    residentIdentity = () => undefined;
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Do the work" });

    await waitFor(() => resident.stdinData.length === 1, "the message reached the process");
    expect(resident.stdinData[0]).toContain("Do the work");
    expect(spawned).toEqual([]);
  });

  it("lets the spawn guards retire it when it was started as something else (req 3)", async () => {
    residentIdentity = () => "claude|anthropic|sub|claude-old-model|-|-";
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "Do the work" });

    await waitFor(() => spawned[0]?.runCalled ?? false, "a new process started");
    expect(resident.killed).toBe(true);
    expect(resident.stdinData).toEqual([]);
  });
});
