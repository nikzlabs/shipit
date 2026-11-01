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
  let chatHistoryManager: ChatHistoryManager;
  let attachedRunners: SessionRunner[];
  let setupGate: { reached: boolean; open: Promise<void> } | null;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-idle-resident-"));
    spawned = [];
    resident = new FakeClaudeProcess();
    attachedRunners = [];
    setupGate = null;
    // What the container runner restores from the worker's report.
    const attach: Attach = async function () {
      attachedRunners.push(this);
      if (setupGate) {
        setupGate.reached = true;
        await setupGate.open;
      }
      if (this.getAgent()) return false;
      this.setAgent(resident as never);
      this.isStreamingActive = true;
      this.appliedSpawnIdentity = residentIdentity();
      return true;
    };
    (SessionRunner.prototype as unknown as { attachIdleResident: Attach }).attachIdleResident = attach;
    Object.defineProperty(SessionRunner.prototype, "residentToAttach", {
      configurable: true,
      get(this: SessionRunner) { return this.getAgent() === null || setupGate !== null; },
    });

    const credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);
    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => new GitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager: (chatHistoryManager = new ChatHistoryManager(dbManager)),
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

  it("lets a turn the CLI starts during a message's setup keep the process, and steers the message in (planning#703)", async () => {
    residentIdentity = () => undefined;
    const client = await TestClient.connect(port);
    client.send({ type: "send_message", text: "First task" });
    await waitFor(() => resident.stdinData.length === 1, "the first message reached the process");
    resident.emit("event", { type: "result", subtype: "success", session_id: "cli-1" });
    const runner = attachedRunners[0]!;
    await waitFor(() => !runner.running, "the first turn ended");
    const history = () => chatHistoryManager.load(runner.sessionId).map((m) => m.text ?? "").join("\n");

    let open!: () => void;
    setupGate = { reached: false, open: new Promise<void>((r) => { open = r; }) };
    client.send({ type: "send_message", text: "Do more" });
    await waitFor(() => setupGate!.reached, "the message is in its setup");

    resident.emit("event", { type: "agent_self_wake", taskId: "task-1", status: "completed" });
    resident.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "WAKE_TEXT" }, { type: "tool_use", id: "w1", name: "Bash", input: { command: "ls" } }] },
    });
    resident.emit("event", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] } });
    await waitFor(() => history().includes("WAKE_TEXT"), "the CLI's own turn saved its first rows");
    open();

    // At once: the CLI's turn sends no further event while a long tool call runs.
    await waitFor(() => resident.stdinData.length === 2, "the message was steered into the CLI's own turn");
    expect(resident.stdinData[1]).toContain("Do more");
    expect(runner.queueLength).toBe(0);
    resident.emit("event", { type: "user", isReplay: true, message: { content: [{ type: "text", text: resident.stdinData[1] }] } });
    resident.emit("event", { type: "assistant", message: { content: [{ type: "text", text: "WAKE_MORE" }] } });
    resident.emit("event", { type: "result", subtype: "success", session_id: "cli-1" });
    await waitFor(() => !runner.running, "the CLI's own turn ended");

    expect(history()).toContain("WAKE_TEXT");
    expect(history()).toContain("Do more");
    expect(history()).toContain("WAKE_MORE");
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
