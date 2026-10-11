import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { CredentialStore } from "../credential-store.js";
import type { SessionRunnerInterface } from "../session-runner.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { testDispatch } from "./dispatch-test-helpers.js";
import type * as Validation from "../validation.js";

// The steer branch reads attachments before it writes to the agent; the test holds that read open.
const attachments = vi.hoisted(() => ({ gate: null as Promise<void> | null, reads: 0 }));

vi.mock("../validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Validation>();
  return {
    ...actual,
    resolveFileAttachments: async (...args: Parameters<typeof Validation.resolveFileAttachments>) => {
      attachments.reads += 1;
      if (attachments.gate) await attachments.gate;
      return actual.resolveFileAttachments(...args);
    },
  };
});

describe("Integration: a steer whose turn ended while its attachments were read", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let lastClaude: FakeClaudeProcess = null as never;
  let dbManager: DatabaseManager;
  let commitGate: Promise<void> | null = null;
  let commitsStarted = 0;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    lastClaude = null as never;
    commitGate = null;
    commitsStarted = 0;
    attachments.gate = null;
    attachments.reads = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-late-steer-"));
    credentialStore = createTestCredentialStore(tmpDir);
    credentialStore.setLiveSteering(true);

    app = await buildApp({
      credentialStore,
      createGitManager: (dir: string) => {
        const git = new GitManager(dir);
        const autoCommit = git.autoCommit.bind(git);
        git.autoCommit = async (...args) => {
          commitsStarted += 1;
          if (commitGate) await commitGate;
          return autoCommit(...args);
        };
        return git;
      },
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
    await new Promise((r) => setTimeout(r, 50));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* ignore cleanup errors */ }
  });

  async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`waitUntil("${label}") timed out`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("dispatches the message behind the finished turn's commit instead of writing it to the idle agent", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Refactor the parser" });
    const resident = await waitForClaude(() => lastClaude);
    resident.initSession("agent-a");
    const runner = (app as unknown as { runnerRegistry: { get(id: string): SessionRunnerInterface } })
      .runnerRegistry.get(client.sessionId);
    await waitUntil(() => runner.running && runner.isStreamingActive, "the turn runs and streams");
    fs.writeFileSync(path.join(runner.sessionDir, "note.txt"), "a note\n");

    let openAttachments = (): void => {};
    attachments.gate = new Promise<void>((resolve) => { openAttachments = resolve; });
    const readsBefore = attachments.reads;
    client.send({ type: "send_message", text: "and read this note", files: [{ path: "note.txt" }] });
    await waitUntil(() => attachments.reads === readsBefore + 1, "the steer is reading its attachment");

    let landCommit = (): void => {};
    commitGate = new Promise<void>((resolve) => { landCommit = resolve; });
    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    await waitUntil(() => commitsStarted === 1, "the turn's commit started");
    expect([runner.running, runner.turnCommitPending]).toEqual([false, true]);

    attachments.gate = null;
    openAttachments();
    await waitUntil(() => runner.queueLength === 1, "the message queued behind the commit");
    expect(resident.stdinData.some((d) => d.includes("and read this note"))).toBe(false);

    commitGate = null;
    landCommit();
    await waitUntil(
      () => resident.stdinData.some((d) => d.includes("and read this note")),
      "the message reached the agent after the commit",
    );
    expect(runner.turnCommitPending).toBe(false);
    expect(runner.queueLength).toBe(0);

    client.close();
  });

  // `running` is true again by then, so only the turn's identity says the steer lost its turn.
  it("does not steer into the turn that replaced its own during the attachment read", async () => {
    const client = await TestClient.connect(port);
    await client.receive();

    client.send({ type: "send_message", text: "Refactor the parser" });
    const resident = await waitForClaude(() => lastClaude);
    resident.initSession("agent-a");
    const runner = (app as unknown as { runnerRegistry: { get(id: string): SessionRunnerInterface } })
      .runnerRegistry.get(client.sessionId);
    await waitUntil(() => runner.running && runner.isStreamingActive, "the turn runs and streams");
    fs.writeFileSync(path.join(runner.sessionDir, "note.txt"), "a note\n");
    runner.dispatch(testDispatch({ text: "Child PR #42 merged", systemTurn: true }));
    expect(runner.queueLength).toBe(1);

    let openAttachments = (): void => {};
    attachments.gate = new Promise<void>((resolve) => { openAttachments = resolve; });
    const readsBefore = attachments.reads;
    client.send({ type: "send_message", text: "and read this note", files: [{ path: "note.txt" }] });
    await waitUntil(() => attachments.reads === readsBefore + 1, "the steer is reading its attachment");

    resident.emit("event", { type: "result", subtype: "success", session_id: "agent-a" });
    const systemTurn = await waitForClaude(() => lastClaude, resident);
    await waitUntil(() => runner.running && runner.systemTurnInProgress, "the queued system turn runs");

    attachments.gate = null;
    openAttachments();
    await waitUntil(() => runner.queueLength === 1, "the message queued behind the system turn");
    for (const agent of [resident, systemTurn]) {
      expect(agent.stdinData.some((d) => d.includes("and read this note"))).toBe(false);
    }

    systemTurn.finish("system-session");
    const typedTurn = await waitForClaude(() => lastClaude, systemTurn);
    expect(typedTurn.lastPrompt).toContain("and read this note");
    typedTurn.finish("typed-session");
    await waitUntil(() => !runner.running && !runner.postTurnWorkInFlight, "all turns finished");

    client.close();
  });
});
