// planning#636 — a finished turn commits after `runner.running` clears. A rewind in that
// window used to reset the tree before the turn's edits were in git.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../index.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import { GitManager } from "../../shared/git.js";
import { DatabaseManager } from "../../shared/database.js";
import type { WsServerMessage } from "../../shared/types.js";
import {
  TestClient,
  StubAuthManager,
  FakeClaudeProcess,
  waitForClaude,
  createTestCredentialStore,
  createTestDatabaseManager,
} from "./test-helpers.js";

const TURN_EDIT = "v2, the turn's edit\n";
const STILL_SAVING = { type: "error", message: expect.stringContaining("still being saved") };

describe("Integration: rewind while the finished turn is not committed yet", () => {
  let app: FastifyInstance;
  let port: number;
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let chatHistoryManager: ChatHistoryManager;
  let lastClaude: FakeClaudeProcess | null;
  let holdCommit: boolean;
  let commitReached: Promise<void>;
  let releaseCommit: () => void;

  beforeEach(async () => {
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-rewind-post-turn-"));
    chatHistoryManager = new ChatHistoryManager(dbManager);
    lastClaude = null;
    holdCommit = false;
    let markReached = (): void => {};
    commitReached = new Promise((resolve) => { markReached = resolve; });
    const released = new Promise<void>((resolve) => { releaseCommit = resolve; });

    class HeldCommitGitManager extends GitManager {
      override async autoCommit(...args: Parameters<GitManager["autoCommit"]>): ReturnType<GitManager["autoCommit"]> {
        if (holdCommit) {
          markReached();
          await released;
        }
        return super.autoCommit(...args);
      }
    }

    app = await buildApp({
      credentialStore: createTestCredentialStore(tmpDir),
      createGitManager: (dir: string) => new HeldCommitGitManager(dir),
      sessionManager: new SessionManager(dbManager),
      chatHistoryManager,
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
    releaseCommit();
    await app.close();
    dbManager.close();
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function receiveOneOf(client: TestClient, types: string[]): Promise<WsServerMessage> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const msg = await client.receive(deadline - Date.now());
      if (types.includes(msg.type)) return msg;
    }
    throw new Error(`none of ${types.join(", ")} arrived`);
  }

  async function sessionWithOneCommittedTurn(): Promise<{ sessionId: string; workspaceDir: string; git: GitManager }> {
    const res = await app.inject({ method: "POST", url: "/api/_test/sessions", payload: { title: "Rewind" } });
    const { sessionId, workspaceDir } = res.json() as { sessionId: string; workspaceDir: string };
    const git = new GitManager(workspaceDir);
    const initial = await git.getHeadHash();
    fs.writeFileSync(path.join(workspaceDir, "tracked.txt"), "v1\n");
    const { commitHash } = await git.autoCommit("turn 1");
    chatHistoryManager.append(sessionId, { role: "user", text: "first" });
    chatHistoryManager.append(sessionId, {
      role: "assistant",
      text: "added tracked.txt",
      commitHash: commitHash ?? undefined,
      parentCommitHash: initial ?? undefined,
    });
    return { sessionId, workspaceDir, git };
  }

  // Ends with the turn finished (`running` false) and its commit held open.
  async function finishTurnThatEditsTrackedFile(client: TestClient, sessionId: string, workspaceDir: string): Promise<void> {
    holdCommit = true;
    client.send({ type: "send_message", text: "edit it", sessionId });
    const claude = await waitForClaude(() => lastClaude);
    claude.emit("event", { type: "system", subtype: "init", session_id: "agent-sid" });
    fs.writeFileSync(path.join(workspaceDir, "tracked.txt"), TURN_EDIT);
    claude.emit("event", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Edited tracked.txt" }] },
      session_id: "agent-sid",
    });
    claude.emit("event", { type: "result", subtype: "success", session_id: "agent-sid" });
    claude.emit("done", 0);
    await commitReached;
    expect(app.runnerRegistry.get(sessionId)?.running).toBe(false);
  }

  async function letTheCommitLand(sessionId: string, workspaceDir: string, git: GitManager): Promise<void> {
    holdCommit = false;
    releaseCommit();
    await expect.poll(async () => (await git.inspectWorkingTree()).clean, { timeout: 5000 }).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, "tracked.txt"), "utf-8")).toBe(TURN_EDIT);
    await expect.poll(() => app.runnerRegistry.get(sessionId)?.turnCommitPending, { timeout: 5000 }).toBe(false);
  }

  it("refuses a rewind until the finished turn is committed, then rewinds recoverably", async () => {
    const { sessionId, workspaceDir, git } = await sessionWithOneCommittedTurn();
    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    await finishTurnThatEditsTrackedFile(client, sessionId, workspaceDir);

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "both" });
    expect(await receiveOneOf(client, ["rewind_complete", "error"])).toMatchObject(STILL_SAVING);
    await letTheCommitLand(sessionId, workspaceDir, git);

    // The lease outlives the commit: a deferred push can hold it past the snapshot's five minutes.
    const runner = app.runnerRegistry.get(sessionId);
    runner?.beginPostTurnWork();
    expect(runner?.postTurnWorkInFlight).toBe(true);
    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "both" });
    expect((await receiveOneOf(client, ["rewind_complete", "error"])).type).toBe("rewind_complete");
    expect(fs.readFileSync(path.join(workspaceDir, "tracked.txt"), "utf-8")).toBe("v1\n");

    client.send({ type: "rewind_restore_request", sessionId });
    expect((await receiveOneOf(client, ["rewind_restored", "error"])).type).toBe("rewind_restored");
    expect(fs.readFileSync(path.join(workspaceDir, "tracked.txt"), "utf-8")).toBe(TURN_EDIT);
    runner?.endPostTurnWork();
    client.close();
  });

  it("refuses Recover rewind until the finished turn is committed", async () => {
    const { sessionId, workspaceDir, git } = await sessionWithOneCommittedTurn();
    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    chatHistoryManager.createRewindSnapshot(sessionId, {
      action: "code",
      headHash: (await git.getHeadHash()) ?? "",
      flippedMessageIds: [],
    });
    await finishTurnThatEditsTrackedFile(client, sessionId, workspaceDir);

    client.send({ type: "rewind_restore_request", sessionId });
    expect(await receiveOneOf(client, ["rewind_restored", "error"])).toMatchObject(STILL_SAVING);

    await letTheCommitLand(sessionId, workspaceDir, git);
    // The refusal left the snapshot in place, so the retry works.
    client.send({ type: "rewind_restore_request", sessionId });
    expect((await receiveOneOf(client, ["rewind_restored", "error"])).type).toBe("rewind_restored");
    client.close();
  });

  it("still forks while the finished turn is being committed", async () => {
    const { sessionId, workspaceDir } = await sessionWithOneCommittedTurn();
    const client = await TestClient.connect(port, sessionId);
    await client.receiveType("preview_status");
    await finishTurnThatEditsTrackedFile(client, sessionId, workspaceDir);

    client.send({ type: "rewind_at_gap", gapPosition: 2, action: "fork", sessionName: "Fork" });
    expect((await receiveOneOf(client, ["session_forked", "error"])).type).toBe("session_forked");
    client.close();
  });
});
